"""GPU sharing with other containers (Immich ML on the GPU box).

Before GPU work the containers in UPSCALE_PAUSE_CONTAINERS that are running are stopped through the Docker Engine
HTTP API (DOCKER_HOST=tcp://host:port, e.g. a docker-socket-proxy); which ones we stopped is persisted in a state
file. After UPSCALE_GPU_IDLE_S without upscale work the GPU sessions are released and those containers are started
again. On startup, containers a previous run left stopped are started (watchdog). Docker errors are only logged.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

log = logging.getLogger("faceswap.gpugate")


class DockerError(Exception):
    pass


class DockerClient:
    """The 3 calls we need from the Docker Engine API, over plain HTTP (tcp://host:port)."""

    def __init__(self, host: str, timeout: float = 30.0):
        u = urllib.parse.urlparse(host)
        if u.scheme not in ("tcp", "http") or not u.netloc:
            raise ValueError(f"unsupported DOCKER_HOST {host!r} (use tcp://host:port)")
        self.base = f"http://{u.netloc}"
        self.timeout = timeout

    def _call(self, method: str, path: str) -> tuple[int, bytes]:
        req = urllib.request.Request(self.base + path, method=method, data=b"" if method == "POST" else None)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read() or b""
        except (urllib.error.URLError, OSError) as e:
            raise DockerError(f"{method} {path}: {e}") from None

    def is_running(self, name: str) -> bool | None:
        """True/False, None when the container does not exist."""
        status, body = self._call("GET", f"/containers/{urllib.parse.quote(name)}/json")
        if status == 404:
            return None
        if status != 200:
            raise DockerError(f"inspect {name}: HTTP {status}")
        return bool(json.loads(body).get("State", {}).get("Running"))

    def stop(self, name: str, wait_s: int = 20) -> None:
        status, _ = self._call("POST", f"/containers/{urllib.parse.quote(name)}/stop?t={wait_s}")
        if status not in (204, 304):  # 304 = already stopped
            raise DockerError(f"stop {name}: HTTP {status}")

    def start(self, name: str) -> None:
        status, _ = self._call("POST", f"/containers/{urllib.parse.quote(name)}/start")
        if status not in (204, 304):  # 304 = already running
            raise DockerError(f"start {name}: HTTP {status}")


class GpuGate:
    """Counts running GPU jobs. First job: pause the containers. Last job + idle_s: release(), resume containers.
    All state changes happen under one lock, so a job starting while the idle timer fires is safe: the timer only
    acts when its generation is still current and no job is active."""

    def __init__(
        self,
        docker: DockerClient | None,
        containers: list[str],
        state_file: Path,
        idle_s: float,
        release: Callable[[], None],
    ):
        self.docker = docker if containers else None
        self.containers = containers
        self.state_file = state_file
        self.idle_s = idle_s
        self.release = release
        self._lock = threading.Lock()
        self._active = 0
        self._gen = 0
        self._timer: threading.Timer | None = None
        self._stopped: list[str] = self._load_state()

    # ---- state file

    def _load_state(self) -> list[str]:
        try:
            names = json.loads(self.state_file.read_text()).get("stopped", [])
            return [n for n in names if isinstance(n, str)]
        except FileNotFoundError:
            return []
        except (OSError, ValueError) as e:
            log.warning("gpu gate state unreadable", extra={"path": str(self.state_file), "error": str(e)})
            return []

    def _save_state(self) -> None:
        try:
            if not self._stopped:
                self.state_file.unlink(missing_ok=True)
                return
            tmp = self.state_file.with_name(f".{self.state_file.name}.tmp")
            tmp.write_text(json.dumps({"stopped": self._stopped, "ts": int(time.time())}))
            os.replace(tmp, self.state_file)
        except OSError as e:
            log.warning("gpu gate state not saved", extra={"path": str(self.state_file), "error": str(e)})

    # ---- docker (called with the lock held)

    def _pause(self) -> None:
        if self.docker is None:
            return
        for name in self.containers:
            if name in self._stopped:
                continue
            try:
                if self.docker.is_running(name):
                    t0 = time.monotonic()
                    self._stopped.append(name)
                    self._save_state()  # before stopping: a crash mid-stop must still resume it
                    self.docker.stop(name)
                    log.info("paused container for gpu work", extra={"container": name, "ms": int((time.monotonic() - t0) * 1000)})
            except DockerError as e:
                log.warning("could not pause container", extra={"container": name, "error": str(e)})

    def _resume(self) -> bool:
        """Starts every container we stopped; returns True when none is left stopped."""
        if self.docker is None:
            self._stopped = []
            self._save_state()
            return True
        for name in list(self._stopped):
            try:
                self.docker.start(name)
                self._stopped.remove(name)
                log.info("resumed container", extra={"container": name})
            except DockerError as e:
                log.warning("could not resume container", extra={"container": name, "error": str(e)})
        self._save_state()
        return not self._stopped

    # ---- jobs

    @contextmanager
    def job(self) -> Iterator[None]:
        with self._lock:
            self._active += 1
            self._gen += 1
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            try:
                self._pause()
            except Exception:  # noqa: BLE001 - never fail the request because of docker
                log.exception("gpu gate pause failed")
        try:
            yield
        finally:
            with self._lock:
                self._active -= 1
                if self._active == 0:
                    self._timer = threading.Timer(self.idle_s, self._on_idle, args=(self._gen,))
                    self._timer.daemon = True
                    self._timer.start()

    def _on_idle(self, gen: int) -> None:
        with self._lock:
            if gen != self._gen or self._active:
                return
            self._timer = None
            try:
                self.release()
            except Exception:  # noqa: BLE001
                log.exception("releasing gpu sessions failed")
            self._resume()

    # ---- lifecycle

    def startup(self, attempts: int = 6, backoff_s: float = 5.0) -> threading.Thread | None:
        """Watchdog: start containers a previous run left stopped (in the background, with retries)."""
        if not self._stopped:
            return None
        log.info("restarting containers left paused", extra={"containers": self._stopped})

        def run() -> None:
            for attempt in range(attempts):
                with self._lock:
                    if self._active or not self._stopped or self._resume():
                        return
                time.sleep(backoff_s * (attempt + 1))

        t = threading.Thread(target=run, name="gpu-watchdog", daemon=True)
        t.start()
        return t

    def shutdown(self) -> None:
        """Process exit: resume the containers right away (the state file + watchdog cover a failure here)."""
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._gen += 1
            if self._stopped and not self._active:
                self._resume()

    @property
    def paused(self) -> list[str]:
        return list(self._stopped)


def from_env(model_dir: str, release: Callable[[], None]) -> GpuGate:
    containers = [c.strip() for c in os.environ.get("UPSCALE_PAUSE_CONTAINERS", "").split(",") if c.strip()]
    host = os.environ.get("DOCKER_HOST", "").strip()
    docker = None
    if containers and host:
        try:
            docker = DockerClient(host)
        except ValueError as e:
            log.error("gpu gate: docker disabled", extra={"error": str(e)})
    elif containers:
        log.warning("UPSCALE_PAUSE_CONTAINERS set without DOCKER_HOST: containers are not paused")
    try:
        idle = float(os.environ.get("UPSCALE_GPU_IDLE_S", "") or 150)
    except ValueError:
        idle = 150.0
    return GpuGate(docker, containers if docker else [], Path(model_dir) / "upscale-gpu-gate.json", max(1.0, idle), release)
