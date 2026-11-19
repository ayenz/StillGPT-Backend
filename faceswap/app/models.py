"""Model registry + first-start downloader (atomic, sha256-verified)."""

from __future__ import annotations

import hashlib
import logging
import os
import time
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("faceswap.models")

_BASE = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/"


@dataclass(frozen=True)
class ModelSpec:
    key: str
    filename: str
    url: str
    sha256: str
    size: int


# sha256 + size verified by downloading each file (2026-11-19).
MODELS: dict[str, ModelSpec] = {
    # SCRFD-10GF with 5 keypoints = insightface buffalo_l det_10g.onnx (facefusion renamed it).
    "detector": ModelSpec("detector", "retinaface_10g.onnx", _BASE + "retinaface_10g.onnx", "808399c3d0b40ed340634ed590ae564a7caa09e5659916923a95d4470b54ff5a", 16926877),
    # ArcFace R50 trained on WebFace600K = buffalo_l w600k_r50.onnx.
    "recognizer": ModelSpec("recognizer", "arcface_w600k_r50.onnx", _BASE + "arcface_w600k_r50.onnx", "f1f79dc3b0b79a69f94799af1fffebff09fbd78fd96a275fd8f0cbbea23270d1", 174388474),
    "swapper": ModelSpec("swapper", "inswapper_128.onnx", _BASE + "inswapper_128.onnx", "a290273ed497312095dac48cdef20feec9d5208298223dd01288ab202b54bea7", 555303150),
    "codeformer": ModelSpec("codeformer", "codeformer.onnx", _BASE + "codeformer.onnx", "21710e7ab61c82683576c428e9c1b6fe1ed419586b7b39e394c3449c294b550f", 376951650),
    "gfpgan": ModelSpec("gfpgan", "gfpgan_1.4.onnx", _BASE + "gfpgan_1.4.onnx", "accc4757b26bdb89b32b4d3500d4f79c9dff97c1dd7c7104bf9dcb95e3311385", 340299087),
    # x4 upscalers (facefusion frame_enhancer models): RGB float 0..1 NCHW in/out, dynamic H/W.
    "upscale_clear": ModelSpec("upscale_clear", "clear_reality_x4.onnx", _BASE + "clear_reality_x4.onnx", "bbce9d5a653281cfae07788d620bd4ec45712709bdf6349a06a893159efd97ce", 1718947),
    "upscale_span": ModelSpec("upscale_span", "span_kendata_x4.onnx", _BASE + "span_kendata_x4.onnx", "7478c40953a5902efd785ef1fe8e07a8bb7e7ee9b1977273550813ceefae6348", 1718947),
    "upscale_nomos": ModelSpec("upscale_nomos", "nomos8k_sc_x4.onnx", _BASE + "nomos8k_sc_x4.onnx", "7747a7dd0b115761cf9c34bbf67bb1e98218ff5b459492a13215c8deb046a9d0", 67002465),
}

FACE_KEYS = ("detector", "recognizer", "swapper", "codeformer", "gfpgan")
UPSCALE_KEYS = ("detector", "upscale_clear", "upscale_span", "upscale_nomos")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _marker(path: Path) -> Path:
    return path.with_name(path.name + ".verified")


def _is_verified(spec: ModelSpec, path: Path) -> bool:
    """A file counts as verified if a marker records the same sha256/size/mtime; otherwise we re-hash once."""
    if not path.is_file():
        return False
    st = path.stat()
    if spec.size and st.st_size != spec.size:
        return False
    stamp = f"{spec.sha256} {st.st_size} {int(st.st_mtime)}"
    m = _marker(path)
    if m.is_file() and m.read_text().strip() == stamp:
        return True
    if _sha256_file(path) != spec.sha256:
        return False
    m.write_text(stamp)
    return True


def _download(spec: ModelSpec, dest: Path, attempts: int = 4) -> None:
    tmp = dest.with_name(f".{dest.name}.part-{os.getpid()}")
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        t0 = time.monotonic()
        try:
            h = hashlib.sha256()
            n = 0
            req = urllib.request.Request(spec.url, headers={"User-Agent": "stillgpt-faceswap/1"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
                for chunk in iter(lambda: resp.read(1 << 20), b""):
                    out.write(chunk)
                    h.update(chunk)
                    n += len(chunk)
                out.flush()
                os.fsync(out.fileno())
            digest = h.hexdigest()
            if digest != spec.sha256 or (spec.size and n != spec.size):
                raise RuntimeError(f"checksum mismatch for {spec.filename}: got {digest} ({n} bytes)")
            os.replace(tmp, dest)
            st = dest.stat()
            _marker(dest).write_text(f"{spec.sha256} {st.st_size} {int(st.st_mtime)}")
            log.info(
                "model downloaded",
                extra={"model": spec.key, "bytes": n, "ms": int((time.monotonic() - t0) * 1000)},
            )
            return
        except Exception as e:  # noqa: BLE001 - retried, then re-raised
            last = e
            log.warning("model download failed", extra={"model": spec.key, "attempt": attempt, "error": str(e)})
            tmp.unlink(missing_ok=True)
            time.sleep(min(30, 2**attempt))
    raise RuntimeError(f"could not download {spec.filename}: {last}")


def ensure_models(model_dir: str | os.PathLike[str], keys: Iterable[str] | None = None) -> dict[str, Path]:
    """Makes sure the given models (default: all) are present + verified in model_dir; downloads missing/corrupt ones."""
    d = Path(model_dir)
    d.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for spec in (MODELS[k] for k in keys) if keys is not None else MODELS.values():
        p = d / spec.filename
        if not _is_verified(spec, p):
            if p.exists():
                log.warning("model failed verification, re-downloading", extra={"model": spec.key})
                p.unlink()
            log.info("downloading model", extra={"model": spec.key, "url": spec.url, "bytes": spec.size})
            _download(spec, p)
        paths[spec.key] = p
    return paths
