import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.gpugate import DockerClient, GpuGate, from_env


class FakeDocker:
    """Minimal Docker Engine API: GET /containers/<n>/json, POST /containers/<n>/stop|start."""

    def __init__(self, containers: dict[str, bool]):
        self.containers = dict(containers)
        self.calls: list[tuple[str, str]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _reply(self, status, body=None):
                data = json.dumps(body).encode() if body is not None else b""
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _route(self, method):
                path = self.path.split("?")[0]
                parts = path.strip("/").split("/")
                fake.calls.append((method, path))
                if len(parts) != 3 or parts[0] != "containers" or parts[1] not in fake.containers:
                    return self._reply(404, {"message": "No such container"})
                name, op = parts[1], parts[2]
                running = fake.containers[name]
                if method == "GET" and op == "json":
                    return self._reply(200, {"Name": "/" + name, "State": {"Running": running}})
                if method == "POST" and op in ("stop", "start"):
                    want = op == "start"
                    if running == want:
                        return self._reply(304)
                    fake.containers[name] = want
                    return self._reply(204)
                return self._reply(405)

            def do_GET(self):
                self._route("GET")

            def do_POST(self):
                self._route("POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"tcp://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def posts(self):
        return [c for c in self.calls if c[0] == "POST"]

    def close(self):
        self.server.shutdown()


@pytest.fixture()
def docker():
    d = FakeDocker({"immich_ml": True, "idle_one": False, "other": True})
    yield d
    d.close()


def wait_for(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def make_gate(docker, tmp_path, idle=0.1, names=("immich_ml", "idle_one", "missing")):
    released = []
    gate = GpuGate(DockerClient(docker.url), list(names), tmp_path / "gate.json", idle, lambda: released.append(1))
    return gate, released


def test_pauses_only_running_and_persists_state(docker, tmp_path):
    gate, released = make_gate(docker, tmp_path, idle=60)
    with gate.job():
        assert docker.containers == {"immich_ml": False, "idle_one": False, "other": True}
        assert docker.posts() == [("POST", "/containers/immich_ml/stop")]
        assert json.loads((tmp_path / "gate.json").read_text())["stopped"] == ["immich_ml"]
        assert gate.paused == ["immich_ml"]
    with gate.job():  # still paused: no second stop
        pass
    assert len(docker.posts()) == 1 and released == []
    gate.shutdown()
    assert docker.containers["immich_ml"] is True and not (tmp_path / "gate.json").exists()


def test_resumes_and_releases_after_idle(docker, tmp_path):
    gate, released = make_gate(docker, tmp_path, idle=0.1)
    with gate.job():
        pass
    assert docker.containers["immich_ml"] is False
    assert wait_for(lambda: docker.containers["immich_ml"])
    assert wait_for(lambda: released == [1])
    assert wait_for(lambda: not (tmp_path / "gate.json").exists() and gate.paused == [])
    assert docker.containers["idle_one"] is False  # was not running before: not started


def test_new_job_cancels_pending_resume(docker, tmp_path):
    gate, released = make_gate(docker, tmp_path, idle=0.15)
    with gate.job():
        pass
    time.sleep(0.05)
    with gate.job():  # starts before the idle timer fires
        time.sleep(0.3)
        assert released == [] and docker.containers["immich_ml"] is False
    assert wait_for(lambda: released == [1] and docker.containers["immich_ml"])
    assert [c for c in docker.posts() if c[1].endswith("/start")] == [("POST", "/containers/immich_ml/start")]


def test_concurrent_jobs_keep_gpu_until_last_ends(docker, tmp_path):
    gate, released = make_gate(docker, tmp_path, idle=0.05)
    started, finish = threading.Event(), threading.Event()

    def long_job():
        with gate.job():
            started.set()
            finish.wait(2)

    t = threading.Thread(target=long_job)
    t.start()
    started.wait(2)
    with gate.job():
        pass
    time.sleep(0.2)
    assert released == [] and docker.containers["immich_ml"] is False
    finish.set()
    t.join()
    assert wait_for(lambda: released == [1] and docker.containers["immich_ml"])


def test_watchdog_restarts_containers_left_stopped(docker, tmp_path):
    docker.containers["immich_ml"] = False
    (tmp_path / "gate.json").write_text(json.dumps({"stopped": ["immich_ml"]}))
    gate, _ = make_gate(docker, tmp_path)
    t = gate.startup(backoff_s=0.01)
    assert t is not None
    t.join(3)
    assert docker.containers["immich_ml"] is True and not (tmp_path / "gate.json").exists()


def test_watchdog_noop_without_state(docker, tmp_path):
    gate, _ = make_gate(docker, tmp_path)
    assert gate.startup() is None and docker.calls == []


def test_docker_unreachable_never_fails_the_job(tmp_path):
    released = []
    gate = GpuGate(DockerClient("tcp://127.0.0.1:9", timeout=0.5), ["immich_ml"], tmp_path / "g.json", 0.05, lambda: released.append(1))
    with gate.job():
        ran = True
    assert ran
    assert wait_for(lambda: released == [1])


def test_without_docker_only_releases(tmp_path):
    released = []
    gate = GpuGate(None, [], tmp_path / "g.json", 0.05, lambda: released.append(1))
    with gate.job():
        pass
    assert wait_for(lambda: released == [1])


def test_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("UPSCALE_PAUSE_CONTAINERS", " immich_machine_learning , ")
    monkeypatch.setenv("DOCKER_HOST", "tcp://docker-proxy:2375")
    monkeypatch.setenv("UPSCALE_GPU_IDLE_S", "")
    g = from_env(str(tmp_path), lambda: None)
    assert g.containers == ["immich_machine_learning"] and g.idle_s == 150 and g.docker.base == "http://docker-proxy:2375"
    monkeypatch.delenv("DOCKER_HOST")
    g = from_env(str(tmp_path), lambda: None)
    assert g.docker is None and g.containers == []
