import base64
import io
import os

os.environ["FACESWAP_SKIP_MODELS"] = "1"

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main, upscale

H = {"X-API-Key": "secret"}


def b64img(w=40, h=30, mode="RGB", color=(120, 90, 60), fmt="PNG") -> str:
    buf = io.BytesIO()
    Image.new(mode, (w, h), color).save(buf, fmt)
    return base64.b64encode(buf.getvalue()).decode()


class FakeDetector:
    def detect(self, img, thresh=0.5, nms_thresh=0.4):
        return []


def fake_upscaler(device="cpu"):
    def model(x):
        return x.repeat(4, axis=2).repeat(4, axis=3)

    return upscale.Upscaler(lambda: {"clear": model, "span": model, "nomos": model}, FakeDetector(), device)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("FACESWAP_API_KEY", "secret")
    with TestClient(main.app) as c:
        main.state.engine = None
        main.state.upscaler = None
        main.state.upscale_error = None
        yield c
    main.state.engine = None
    main.state.upscaler = None


def test_upscale_auth(client):
    assert client.post("/v1/upscale", json={"image": b64img()}).status_code == 401


def test_upscale_503_while_loading_and_failed(client):
    r = client.post("/v1/upscale", json={"image": b64img()}, headers=H)
    assert r.status_code == 503 and r.json()["detail"] == "MODELS_LOADING"
    main.state.upscale_error = "boom"
    r = client.post("/v1/upscale", json={"image": b64img()}, headers=H)
    assert r.status_code == 503 and r.json()["detail"] == "MODELS_FAILED"


def test_upscale_disabled(client, monkeypatch):
    monkeypatch.setattr(main, "UPSCALE_DEVICE", "off")
    r = client.post("/v1/upscale", json={"image": b64img()}, headers=H)
    assert r.status_code == 503 and r.json()["detail"] == "UPSCALE_DISABLED"


@pytest.mark.parametrize(
    "body",
    [
        {"image": b64img(), "scale": 3},
        {"image": b64img(), "scale": "4x"},
        {"image": b64img(), "mode": "ultra"},
        {"image": b64img(), "jpeg_quality": 20},
        {"image": b64img(), "jpeg_quality": 101},
        {"image": ""},
        {"scale": 4},
    ],
)
def test_upscale_validation(client, body):
    main.state.upscaler = fake_upscaler()
    r = client.post("/v1/upscale", json=body, headers=H)
    assert r.status_code == 422 and r.json()["detail"] == "INVALID_REQUEST"


def test_upscale_too_large_and_bad_image(client, monkeypatch):
    main.state.upscaler = fake_upscaler()
    monkeypatch.setattr(main, "UPSCALE_MAX_PIXELS", 40 * 30 - 1)
    r = client.post("/v1/upscale", json={"image": b64img(40, 30)}, headers=H)
    assert r.status_code == 413 and r.json()["detail"] == "TOO_LARGE"
    monkeypatch.setattr(main, "UPSCALE_MAX_PIXELS", 40 * 30)
    assert client.post("/v1/upscale", json={"image": b64img(40, 30)}, headers=H).status_code == 200
    r = client.post("/v1/upscale", json={"image": "aGVsbG8="}, headers=H)
    assert r.status_code == 422 and r.json()["detail"] == "BAD_IMAGE"


@pytest.mark.parametrize("scale, mode, pipeline", [(4, "natural", "P4"), (2, "sharp", "P1"), (4, "sharp", "P1")])
def test_upscale_ok(client, scale, mode, pipeline):
    main.state.upscaler = fake_upscaler()
    r = client.post(
        "/v1/upscale",
        json={"image": "data:image/png;base64," + b64img(40, 30, "RGBA", (10, 200, 30, 128)), "scale": scale, "mode": mode},
        headers=H,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["width"], body["height"]) == (40 * scale, 30 * scale)
    assert body["mime_type"] == "image/jpeg" and body["pipeline"] == pipeline and body["device"] == "cpu"
    assert body["scale"] == scale and body["mode"] == mode and body["faces"] == 0 and body["faces_enhanced"] == 0
    assert {"decode", "base", "grain", "encode", "total"} <= set(body["timings_ms"])
    im = Image.open(io.BytesIO(base64.b64decode(body["image"])))
    assert im.format == "JPEG" and im.mode == "RGB" and im.size == (40 * scale, 30 * scale)
    px = np.asarray(im).reshape(-1, 3).mean(0)
    assert np.abs(px - [10, 200, 30]).max() < 6  # alpha dropped, colour kept


def test_upscale_is_deterministic(client):
    main.state.upscaler = fake_upscaler()
    img = b64img(32, 32, color=(128, 128, 128))
    a = client.post("/v1/upscale", json={"image": img, "mode": "sharp"}, headers=H).json()["image"]
    b = client.post("/v1/upscale", json={"image": img, "mode": "sharp"}, headers=H).json()["image"]
    assert a == b


def test_ready_has_upscale_block(client):
    main.state.engine = object()  # face-swap engine loaded
    body = client.get("/health/ready").json()
    assert body["ready"] is True and body["upscale"]["ready"] is False
    main.state.upscaler = fake_upscaler()
    body = client.get("/health/ready").json()
    assert body["upscale"] == {"ready": True, "device": "cpu", "pipelines": {"natural": "P4", "sharp": "P1"}}


def test_upscale_only_mode(client, monkeypatch):
    monkeypatch.setattr(main, "UPSCALE_ONLY", True)
    r = client.get("/health/ready")
    assert r.status_code == 503 and r.json()["mode"] == "upscale_only"
    main.state.upscaler = fake_upscaler("cuda")
    r = client.get("/health/ready")
    assert r.status_code == 200
    assert r.json()["upscale"] == {"ready": True, "device": "cuda", "pipelines": {"natural": "P5", "sharp": "P1"}}
    for path in ("/v1/swap", "/v1/face-crop", "/v1/face-paste"):
        r = client.post(path, json={"target": "x", "sources": ["y"], "image": "x", "base": "x", "patch": "x", "box": [0, 0, 9, 9]}, headers=H)
        assert r.status_code == 503 and r.json()["detail"] == "UPSCALE_ONLY", path
    r = client.post("/v1/upscale", json={"image": b64img(), "mode": "natural"}, headers=H)
    assert r.status_code == 200 and r.json()["pipeline"] == "P5" and r.json()["device"] == "cuda"


def test_upscale_uses_gate(client, monkeypatch, tmp_path):
    from app.gpugate import GpuGate

    released = []
    gate = GpuGate(None, [], tmp_path / "g.json", 60, lambda: released.append(1))
    monkeypatch.setattr(main.state, "gate", gate)
    main.state.upscaler = fake_upscaler("cuda")
    r = client.post("/v1/upscale", json={"image": b64img()}, headers=H)
    assert r.status_code == 200 and "gpu_wait" in r.json()["timings_ms"]
    assert gate._timer is not None  # idle release scheduled
    gate.shutdown()
