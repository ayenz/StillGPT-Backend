import base64
import io
import os
import types

os.environ["FACESWAP_SKIP_MODELS"] = "1"

import cv2
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


# ---------------------------------------------------------------- face-paste (landmark aligned)

# a face in a 256x256 crop (the working size of the paste for boxes <= 256 px)
REF_KPS = np.array([[105, 120], [151, 120], [128, 146], [110, 172], [146, 172]], np.float32)
REF_BOX = np.array([88, 92, 168, 196], np.float32)


def _face(box, kps, score=0.9):
    return Face(box=np.asarray(box, np.float32), score=score, kps=np.asarray(kps, np.float32))


def _similar(pts, scale=1.0, deg=0.0, shift=(0.0, 0.0), center=(128.0, 128.0)):
    a = np.deg2rad(deg)
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]) * scale
    c = np.asarray(center)
    return ((np.asarray(pts, np.float64) - c) @ R.T + c + np.asarray(shift)).astype(np.float32)


def _box_of(kps_like_box):
    b = np.asarray(kps_like_box, np.float32).reshape(-1, 2)
    return [b[:, 0].min(), b[:, 1].min(), b[:, 0].max(), b[:, 1].max()]


class SizeDetector:
    """Returns faces by image width: the base crop is detected at 256 px, the patch at its own (512 px) size."""

    def __init__(self, by_width):
        self.by_width = by_width

    def detect(self, img, thresh=0.5, nms_thresh=0.4):
        return list(self.by_width.get(img.shape[1], []))


def _scene(seed=0):
    """Smooth random 'photo' (blurred noise), 300x240, and a 120 px box inside it."""
    rng = np.random.default_rng(seed)
    arr = rng.integers(0, 255, (240, 300, 3), dtype=np.uint8)
    arr = cv2.GaussianBlur(arr, (0, 0), 4)
    arr = cv2.normalize(arr, None, 30, 220, cv2.NORM_MINMAX)
    return arr, [90, 60, 120, 120]


def _png(arr):
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _patch_faces(scale=1.0, deg=0.0, shift=(0.0, 0.0)):
    """Patch (512 px) face = reference face transformed in 256-px coordinates, then x2."""
    kps = _similar(REF_KPS, scale, deg, shift) * 2
    corners = np.array([[REF_BOX[0], REF_BOX[1]], [REF_BOX[2], REF_BOX[1]], [REF_BOX[0], REF_BOX[3]], [REF_BOX[2], REF_BOX[3]]])
    box = np.array(_box_of(_similar(corners, scale, deg, shift))) * 2
    return [_face(box, kps)]


def _paste(client, base, box, patch, patch_faces, **extra):
    main.state.engine = types.SimpleNamespace(
        detector=SizeDetector({256: [_face(REF_BOX, REF_KPS)], 512: patch_faces})
    )
    body = {"base": _png(base), "patch": _png(patch), "box": box, "output_format": "png", **extra}
    return client.post("/v1/face-paste", json=body, headers=H)


def _decode(body):
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(body["image"]))))


def test_face_paste_aligned_roundtrip_is_seamless(client):
    base, box = _scene()
    x, y, s, _ = box
    patch = cv2.resize(base[y : y + s, x : x + s], (512, 512), interpolation=cv2.INTER_CUBIC)
    r = _paste(client, base, box, patch, _patch_faces())
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["width"], body["height"]) == (300, 240) and body["mime_type"] == "image/png"
    assert body["alignment"]["scale"] == pytest.approx(1.0, abs=1e-3)
    assert body["alignment"]["shift"] == pytest.approx(0.0, abs=1e-3)
    out = _decode(body)
    assert np.array_equal(out[:, :x], base[:, :x]) and np.array_equal(out[: y], base[: y])  # untouched outside
    assert np.abs(out.astype(int) - base.astype(int)).mean() < 1.0


def test_face_paste_replaces_face_only(client):
    base, box = _scene()
    patch = np.full((512, 512, 3), 200, np.uint8)
    r = _paste(client, base, box, patch, _patch_faces(), color_match=False)
    assert r.status_code == 200, r.text
    out = _decode(r.json())
    x, y = box[:2]
    cx, cy = x + 64, y + 72  # face centre (256-px crop coords / 256 * 120)
    assert np.abs(out[cy, cx].astype(int) - 200).max() <= 3  # face got the patch
    # box corners (hair / background) stay from the base
    assert np.abs(out[y + 2, x + 2].astype(int) - base[y + 2, x + 2].astype(int)).max() <= 2
    assert np.abs(out[y + 117, x + 117].astype(int) - base[y + 117, x + 117].astype(int)).max() <= 2


def test_face_paste_mask_box_covers_more(client):
    base, box = _scene()
    patch = np.full((512, 512, 3), 200, np.uint8)
    r = _paste(client, base, box, patch, _patch_faces(), color_match=False, mask="box")
    assert r.status_code == 200, r.text
    out = _decode(r.json())
    x, y = box[:2]
    assert np.abs(out[y + 20, x + 20].astype(int) - 200).max() <= 3


def test_face_paste_warps_mildly_off_patch(client):
    """Patch content scaled by 0.95 and shifted by 3%: the warp puts it back onto the base."""
    base, box = _scene(3)
    x, y, s, _ = box
    crop = cv2.resize(base[y : y + s, x : x + s], (512, 512), interpolation=cv2.INTER_CUBIC)
    scale, shift = 0.95, (0.03 * 256, 0.0)
    M = np.array([[scale, 0, (1 - scale) * 256 + shift[0] * 2], [0, scale, (1 - scale) * 256]], np.float32)
    patch = cv2.warpAffine(crop, M, (512, 512), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101)
    r = _paste(client, base, box, patch, _patch_faces(scale, 0.0, shift), color_match=False)
    assert r.status_code == 200, r.text
    al = r.json()["alignment"]
    assert al["scale"] == pytest.approx(1 / 0.95, abs=0.01) and al["shift"] == pytest.approx(0.03, abs=0.01)
    out = _decode(r.json()).astype(int)
    face = (slice(y + 40, y + 90), slice(x + 40, x + 80))
    corrected = np.abs(out[face] - base[face].astype(int)).mean()
    # without the warp the face area would differ by a lot more
    naive = cv2.resize(patch, (s, s), interpolation=cv2.INTER_AREA).astype(int)
    unwarped = np.abs(naive[40:90, 40:80] - base[face].astype(int)).mean()
    assert corrected < 2.0 and unwarped > 3 * corrected


@pytest.mark.parametrize(
    "transform, reason",
    [
        ({"scale": 0.7}, "scale"),  # Qoder drew the face smaller (the "face inside a face" bug)
        ({"scale": 1.3}, "scale"),
        ({"deg": 20.0}, "rotation"),
        ({"shift": (40.0, 0.0)}, "shift"),  # 15.6 % of the crop side
    ],
)
def test_face_paste_rejects_misaligned_patch(client, transform, reason):
    base, box = _scene()
    r = _paste(client, base, box, np.full((512, 512, 3), 200, np.uint8), _patch_faces(**transform))
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["detail"] == "PATCH_MISALIGNED" and body["reason"] == reason
    assert set(body["alignment"]) == {"scale", "rotation_deg", "shift", "residual"}


def test_face_paste_thresholds_are_configurable(client):
    base, box = _scene()
    patch = np.full((512, 512, 3), 200, np.uint8)
    r = _paste(client, base, box, patch, _patch_faces(scale=0.8))
    assert r.status_code == 422
    r = _paste(client, base, box, patch, _patch_faces(scale=0.8), max_scale_dev=0.3)
    assert r.status_code == 200, r.text
    assert r.json()["alignment"]["scale"] == pytest.approx(1.25, abs=0.01)
    r = _paste(client, base, box, patch, _patch_faces(deg=8.0), max_rotation_deg=5)
    assert r.status_code == 422 and r.json()["reason"] == "rotation"


def test_face_paste_no_face_in_patch(client):
    base, box = _scene()
    r = _paste(client, base, box, np.full((512, 512, 3), 200, np.uint8), [])
    assert r.status_code == 422
    assert r.json() == {"detail": "PATCH_MISALIGNED", "reason": "no_face_in_patch", "alignment": None}


def test_face_paste_no_face_in_base(client):
    main.state.engine = FakeEngine([])
    base, box = _scene()
    r = client.post("/v1/face-paste", json={"base": _png(base), "patch": b64img(128, 128), "box": box}, headers=H)
    assert r.status_code == 422 and r.json()["detail"] == "NO_FACE_IN_TARGET"


def test_face_paste_box_past_the_edge(client):
    base, _ = _scene()
    box = [230, -30, 120, 120]  # leaves the image on the right and top
    patch = np.full((512, 512, 3), 200, np.uint8)
    r = _paste(client, base, box, patch, _patch_faces(), color_match=False)
    assert r.status_code == 200, r.text
    out = _decode(r.json())
    assert out.shape == base.shape and np.array_equal(out[:, :200], base[:, :200])


def test_face_paste_bad_box(client):
    main.state.engine = FakeEngine([])
    r = client.post("/v1/face-paste", json={"base": b64img(), "patch": b64img(), "box": [500, 500, 40, 40]}, headers=H)
    assert r.status_code == 422 and r.json()["detail"] == "BAD_BOX"
