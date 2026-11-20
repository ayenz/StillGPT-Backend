"""Face swap on CUDA: lazy GPU sessions in the Engine and the swap <-> upscale hand-over of the GPU in main."""

import base64
import io
import os

os.environ["FACESWAP_SKIP_MODELS"] = "1"

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import engine as E
from app import imaging, main
from app.engine import Face

FACE = Face(box=np.array([8, 8, 40, 40], np.float32), score=0.9, kps=np.array([[16, 18], [32, 18], [24, 26], [18, 33], [30, 33]], np.float32))


# ---------------------------------------------------------------- Engine sessions


@pytest.fixture()
def fake_models(monkeypatch):
    """Engine with fake model classes; returns the log of created sessions."""
    made: list[tuple[str, str]] = []

    class Det:
        def __init__(self, path, threads):
            pass

        def detect(self, img, thresh=0.5, nms_thresh=0.4):
            return [FACE]

    class Rec:
        def __init__(self, path, threads, device="cpu"):
            made.append(("recognizer", device))

        def embed(self, img, face):
            return np.ones(512, np.float32) / np.sqrt(512)

    class Swp:
        def __init__(self, path, emap, threads, device="cpu"):
            made.append(("swapper", device))

        def latent(self, emb):
            return emb[None]

        def swap(self, img, face, latent):
            return img

    class Res:
        def __init__(self, name, path, threads, device="cpu"):
            made.append((name, device))

        def restore(self, img, face, blend, fidelity):
            return img

    monkeypatch.setattr(E, "Detector", Det)
    monkeypatch.setattr(E, "Recognizer", Rec)
    monkeypatch.setattr(E, "Swapper", Swp)
    monkeypatch.setattr(E, "Restorer", Res)
    monkeypatch.setattr(E, "load_emap", lambda p: np.eye(512, dtype=np.float32))
    return made


PATHS = {k: f"/m/{k}.onnx" for k in ("detector", "recognizer", "swapper", "codeformer", "gfpgan")}


def test_cpu_engine_keeps_every_session(fake_models):
    eng = E.Engine(PATHS, 2)
    assert eng.device == "cpu" and eng.loaded
    assert sorted(fake_models) == sorted([("recognizer", "cpu"), ("swapper", "cpu"), ("codeformer", "cpu"), ("gfpgan", "cpu")])
    eng.release()
    assert eng.loaded  # nothing to free on the CPU
    eng.ensure(["recognizer", "swapper", "codeformer"])
    assert len(fake_models) == 4  # no re-creation


def test_cuda_engine_is_lazy_and_releasable(fake_models):
    eng = E.Engine(PATHS, 2, "cuda")
    # warmup verified each model once, one at a time, and dropped it again
    assert [d for _, d in fake_models] == ["cuda"] * 4 and not eng.loaded
    fake_models.clear()
    eng.ensure(["recognizer", "swapper", "codeformer"])  # only the restorer the job asks for
    assert [k for k, _ in fake_models] == ["recognizer", "swapper", "codeformer"] and eng.loaded
    eng.ensure(["recognizer", "swapper", "codeformer"])
    assert len(fake_models) == 3  # cached while loaded
    eng.release()
    assert not eng.loaded
    eng.swapper  # noqa: B018 - re-created on next use
    assert fake_models[-1] == ("swapper", "cuda")


# ---------------------------------------------------------------- GPU hand-over


class Holder:
    def __init__(self, device="cuda"):
        self.device = device
        self.released = 0

    def release(self, keys=None):
        self.released += 1


@pytest.fixture()
def gpu_state():
    eng, up = Holder(), Holder()
    main.state.engine, main.state.upscaler, main.state.gate = eng, up, None
    yield eng, up
    main.state.engine = main.state.upscaler = None


def test_swap_job_releases_the_upscaler_and_vice_versa(gpu_state):
    eng, up = gpu_state
    t: dict[str, int] = {}
    with main.gpu_job("swap", t):
        pass
    assert (eng.released, up.released) == (0, 1) and "gpu_wait" in t
    with main.gpu_job("upscale", {}):
        pass
    assert (eng.released, up.released) == (1, 1)


def test_gpu_failure_drops_own_sessions_but_image_errors_do_not(gpu_state):
    eng, up = gpu_state
    with pytest.raises(RuntimeError):
        with main.gpu_job("swap", {}):
            raise RuntimeError("CUDA out of memory")
    assert eng.released == 1
    with pytest.raises(imaging.ImageError):
        with main.gpu_job("swap", {}):
            raise imaging.ImageError("NO_FACE_IN_TARGET")
    assert eng.released == 1


def test_cpu_holders_are_never_released(gpu_state):
    eng, up = gpu_state
    up.device = "cpu"
    with main.gpu_job("swap", {}):
        pass
    main._release_gpu()
    assert up.released == 0 and eng.released == 1


# ---------------------------------------------------------------- /v1/swap on CUDA


def b64img(w=64, h=48) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 90, 60)).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_swap_api_on_cuda_reports_device_and_load(fake_models, monkeypatch):
    monkeypatch.setenv("FACESWAP_API_KEY", "secret")
    with TestClient(main.app) as c:
        eng = E.Engine(PATHS, 2, "cuda")
        up = Holder()
        main.state.engine, main.state.upscaler = eng, up
        try:
            r = c.post("/v1/swap", json={"target": b64img(), "sources": [b64img()]}, headers={"X-API-Key": "secret"})
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["device"] == "cuda" and body["target_faces"] == 1
            assert {"gpu_wait", "load", "identity", "swap", "restore"} <= set(body["timings_ms"])
            assert up.released == 1 and eng.loaded  # the upscaler made room; swap sessions stay for the next job
            main.state.upscaler = None
            assert c.get("/health/ready").json()["models"]["device"] == "cuda"
        finally:
            main.state.engine = main.state.upscaler = None
