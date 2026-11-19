import base64
import io
import os

os.environ["FACESWAP_SKIP_MODELS"] = "1"

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.engine import Face


def b64img(w=64, h=48, color=(120, 90, 60), fmt="PNG") -> str:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, fmt)
    return base64.b64encode(buf.getvalue()).decode()


class FakeDetector:
    def __init__(self, faces):
        self.faces = faces

    def detect(self, img, thresh=0.5, nms_thresh=0.4):
        return list(self.faces)


class FakeEngine:
    def __init__(self, faces):
        self.detector = FakeDetector(faces)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("FACESWAP_API_KEY", "secret")
    with TestClient(main.app) as c:
        main.state.engine = None
        main.state.error = None
        yield c
    main.state.engine = None


H = {"X-API-Key": "secret"}


def test_ready_503_while_loading(client):
    r = client.get("/health/ready")
    assert r.status_code == 503 and r.json()["ready"] is False


def test_ready_200_when_loaded(client):
    main.state.engine = FakeEngine([])
    r = client.get("/health/ready")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is True and body["models"]["restorers"] == ["codeformer", "gfpgan"]


@pytest.mark.parametrize("path", ["/v1/swap", "/v1/face-crop", "/v1/face-paste"])
def test_auth_required(client, path):
    assert client.post(path, json={}).status_code == 401
    r = client.post(path, json={}, headers={"X-API-Key": "wrong"})
    assert r.status_code == 401 and r.json() == {"detail": "AUTH_INVALID"}


def test_auth_disabled_when_env_empty(client, monkeypatch):
    monkeypatch.setenv("FACESWAP_API_KEY", "")
    r = client.post("/v1/swap", json={"target": "x", "sources": ["y"]})
    assert r.status_code == 503  # past auth, models not loaded


def test_validation(client):
    main.state.engine = FakeEngine([])
    cases = [
        {"target": b64img(), "sources": []},
        {"target": b64img(), "sources": [b64img()] * 10},
        {"target": b64img(), "sources": [b64img()], "options": {"det_thresh": 0.05}},
        {"target": b64img(), "sources": [b64img()], "options": {"restorer": "nope"}},
        {"target": b64img(), "sources": [b64img()], "options": {"restore_blend": 1.5}},
        {"target": b64img(), "sources": [b64img()], "options": {"jpeg_quality": 20}},
        {"sources": [b64img()]},
    ]
    for body in cases:
        r = client.post("/v1/swap", json=body, headers=H)
        assert r.status_code == 422, body
        assert r.json()["detail"] == "INVALID_REQUEST"


def test_swap_503_when_not_ready(client):
    r = client.post("/v1/swap", json={"target": b64img(), "sources": [b64img()]}, headers=H)
    assert r.status_code == 503 and r.json()["detail"] == "MODELS_LOADING"


def test_swap_bad_image_and_no_face(client):
    main.state.engine = FakeEngine([])
    r = client.post("/v1/swap", json={"target": "aGVsbG8=", "sources": [b64img()]}, headers=H)
    assert r.status_code == 422 and r.json()["detail"] == "BAD_IMAGE"
    r = client.post("/v1/swap", json={"target": b64img(), "sources": [b64img()]}, headers=H)
    assert r.status_code == 422 and r.json()["detail"] == "NO_FACE_IN_TARGET"


def test_too_large(client, monkeypatch):
    main.state.engine = FakeEngine([])
    monkeypatch.setattr(main.imaging, "MAX_PIXELS", 1000)
    r = client.post("/v1/face-crop", json={"image": b64img(64, 48)}, headers=H)
    assert r.status_code == 413 and r.json()["detail"] == "TOO_LARGE"


def test_face_crop_box_and_padding(client):
    face = Face(box=np.array([0, 0, 20, 20], np.float32), score=0.9, kps=np.zeros((5, 2), np.float32))
    main.state.engine = FakeEngine([face])
    r = client.post("/v1/face-crop", json={"image": b64img(64, 48), "size": 128}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["box"] == [-12, -12, 44, 44] and body["faces"] == 1
    crop = Image.open(io.BytesIO(base64.b64decode(body["crop"])))
    assert crop.size == (128, 128) and crop.format == "PNG"


def test_face_paste_roundtrip_keeps_size(client):
    main.state.engine = FakeEngine([])  # no face on the patch -> fallback ellipse
    rng = np.random.default_rng(0)
    arr = rng.integers(0, 255, (60, 80, 3), dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    base = base64.b64encode(buf.getvalue()).decode()
    box = [50, -10, 40, 40]  # leaves the image on the right and top
    patch_arr = np.full((128, 128, 3), 200, np.uint8)
    pbuf = io.BytesIO()
    Image.fromarray(patch_arr).save(pbuf, "PNG")
    r = client.post(
        "/v1/face-paste",
        json={"base": base, "patch": base64.b64encode(pbuf.getvalue()).decode(), "box": box, "output_format": "png", "color_match": False},
        headers=H,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["width"], body["height"]) == (80, 60) and body["mime_type"] == "image/png"
    out = np.asarray(Image.open(io.BytesIO(base64.b64decode(body["image"]))))
    assert np.array_equal(out[:, :40], arr[:, :40])  # untouched outside the box
    assert out[10, 70].mean() > 150  # box centre got the patch


def test_face_paste_bad_box(client):
    main.state.engine = FakeEngine([])
    r = client.post("/v1/face-paste", json={"base": b64img(), "patch": b64img(), "box": [500, 500, 40, 40]}, headers=H)
    assert r.status_code == 422 and r.json()["detail"] == "BAD_BOX"
