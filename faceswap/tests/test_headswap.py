"""/v1/head-composite: alignment (uniform / SIFT / fallback), eye keep, head blend, features and errors."""

import base64
import io
import os
import threading
from collections import OrderedDict

os.environ["FACESWAP_SKIP_MODELS"] = "1"

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import headswap, main
from app.engine import Engine, Face

H = {"X-API-Key": "secret"}


def texture(h: int, w: int, seed: int = 0) -> np.ndarray:
    """A background with plenty of SIFT keypoints: blurred noise plus random rectangles and circles."""
    rng = np.random.default_rng(seed)
    img = cv2.GaussianBlur((rng.random((h, w, 3)) * 255).astype(np.uint8), (0, 0), 2)
    for _ in range(80):
        c = tuple(int(v) for v in rng.integers(0, 255, 3))
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        if rng.random() < 0.5:
            cv2.rectangle(img, (x, y), (x + int(rng.integers(8, 60)), y + int(rng.integers(8, 60))), c, -1)
        else:
            cv2.circle(img, (x, y), int(rng.integers(4, 30)), c, -1)
    return img


def face_at(cx: float, cy: float, s: float) -> Face:
    """A face box of side s centred at (cx, cy) with plausible 5 landmarks."""
    kps = np.array([[-0.18, -0.08], [0.18, -0.08], [0.0, 0.08], [-0.14, 0.24], [0.14, 0.24]], np.float32) * s + (cx, cy)
    return Face(box=np.array([cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2], np.float32), score=0.9, kps=kps)


def apply(M: np.ndarray, pts) -> np.ndarray:
    pts = np.asarray(pts, np.float32)
    return pts @ M[:, :2].T + M[:, 2]


# ---------------------------------------------------------------- transform


def test_same_aspect_is_a_uniform_scale():
    orig = np.zeros((300, 400, 3), np.uint8)
    gen = np.zeros((600, 800, 3), np.uint8)
    M, info = headswap.transform(orig, gen, face_at(200, 150, 80))
    assert info["method"] == "uniform" and info["aligned"] and not info["fallback"]
    np.testing.assert_allclose(M, [[0.5, 0, 0], [0, 0.5, 0]], atol=1e-6)
    # within 1% still counts as the same aspect ratio
    M, info = headswap.transform(orig, np.zeros((600, 805, 3), np.uint8), face_at(200, 150, 80))
    assert info["method"] == "uniform" and M[0, 0] == pytest.approx(400 / 805)


def test_mismatched_aspect_is_aligned_with_sift():
    orig = texture(480, 640)
    # the "regenerated" image: the same scene, scaled 1.2 and shifted, on a canvas with another aspect ratio
    A = np.float32([[1.2, 0, -30], [0, 1.2, 20]])
    gen = cv2.warpAffine(orig, A, (720, 640), borderMode=cv2.BORDER_REFLECT)
    face = face_at(320, 220, 70)
    # the face area changed on purpose: it must not disturb the estimate
    x1, y1, x2, y2 = (int(v) for v in apply(A, [face.box[:2], face.box[2:]]).reshape(-1))
    gen[y1:y2, x1:x2] = 255 - gen[y1:y2, x1:x2]
    M, info = headswap.transform(orig, gen, face)
    assert info["method"] == "sift" and info["aligned"] and not info["fallback"]
    assert info["inliers"] >= headswap.MIN_INLIERS
    pts = np.float32([[50, 60], [600, 40], [320, 450], [10, 470]])
    np.testing.assert_allclose(apply(M, apply(A, pts)), pts, atol=1.5)
    assert info["scale"] == pytest.approx(1 / 1.2, abs=0.01)


def test_plain_background_falls_back_to_centred_uniform_scale():
    orig = np.full((480, 640, 3), 128, np.uint8)
    gen = np.full((512, 512, 3), 128, np.uint8)
    M, info = headswap.transform(orig, gen, face_at(320, 240, 100))
    assert info["method"] == "fallback" and info["fallback"] and not info["aligned"]
    k = 1.25  # max(640/512, 480/512): gen covers the original
    np.testing.assert_allclose(M, [[k, 0, (640 - 512 * k) / 2], [0, k, (480 - 512 * k) / 2]], atol=1e-4)
    # the centre maps to the centre
    np.testing.assert_allclose(apply(M, [[256, 256]]), [[320, 240]], atol=1e-3)


# ---------------------------------------------------------------- masks


def test_eye_mask_covers_the_eyes_only():
    face = face_at(200, 200, 160)
    m = headswap.eye_mask((400, 400), face)
    le, re, nose, lm, rm = face.kps.astype(int)
    # the prototype's feather (0.18 x inter-ocular distance) keeps the peak at ~0.77: a soft blend, no hard edge
    assert m[le[1], le[0]] > 0.7 and m[re[1], re[0]] > 0.7
    for p in (nose, lm, rm, (200, 60), (20, 200)):
        assert m[p[1], p[0]] < 0.05


def test_keep_eyes_takes_the_eyes_from_the_generated_image():
    face = face_at(200, 200, 160)
    gen = np.full((400, 400, 3), 200, np.uint8)
    swapped = np.full((400, 400, 3), 50, np.uint8)
    out = headswap.keep_eyes(swapped, gen, face)
    le, mouth = face.kps[0].astype(int), face.kps[3].astype(int)
    assert int(out[le[1], le[0], 0]) > 150  # mostly the generated eye
    assert abs(int(out[mouth[1], mouth[0], 0]) - 50) <= 1  # the rest stays from the swapper


def test_head_mask_is_raised_for_hair_and_feathered():
    box = np.array([150, 150, 250, 250], np.float32)
    m = headswap.head_mask((400, 400), [box])
    assert m[200, 200] > 0.99  # face centre
    assert m[110, 200] > 0.9  # forehead / hair above the box
    assert m[290, 200] < m[110, 200]  # less below the chin than above the forehead
    assert m[5, 5] < 1e-3 and m[395, 395] < 1e-3


def test_smile_and_hair_features():
    face = face_at(200, 200, 100)
    w, hgt = headswap.smile(face)
    assert w == pytest.approx(0.28 / 0.36, rel=1e-3) and hgt == pytest.approx(0.32 / 0.36, rel=1e-3)
    img = np.full((400, 400, 3), 30, np.uint8)
    lab = headswap.hair_lab(img, face)
    assert lab.shape == (3,)


# ---------------------------------------------------------------- endpoint with fake models


def png(arr: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(arr[:, :, ::-1]).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


BLANK = 3  # images this dark have no face


class FakeDetector:
    def detect(self, img, thresh=0.5, nms_thresh=0.4):
        if img.mean() < BLANK + 1:
            return []
        h, w = img.shape[:2]
        return [face_at(w * 0.5, h * 0.45, min(w, h) * 0.3)]


class FakeRecognizer:
    def embed(self, img, face):
        return np.ones(512, np.float32) / np.sqrt(512)


class FakeSwapper:
    def latent(self, emb):
        return emb[None]

    def swap(self, img, face, latent):
        out = img.copy()
        x1, y1, x2, y2 = (int(v) for v in face.box)
        out[y1:y2, x1:x2] = (0, 0, 255)  # a red "swapped" face
        return out


class FakeRestorer:
    def restore(self, img, face, blend, fidelity):
        return img


class FakeEngine:
    device = "cpu"
    identity = Engine.identity

    def __init__(self):
        self.detector = FakeDetector()
        self.recognizer = FakeRecognizer()
        self.swapper = FakeSwapper()
        self._id_cache, self._id_lock = OrderedDict(), threading.Lock()

    def restorer(self, name):
        return FakeRestorer()


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("FACESWAP_API_KEY", "secret")
    with TestClient(main.app) as c:
        main.state.engine = FakeEngine()
        yield c
    main.state.engine = None


def body(orig=None, gen=None, sources=None, **options):
    orig = texture(240, 320, 1) if orig is None else orig
    gen = texture(480, 640, 2) if gen is None else gen
    return {"original": png(orig), "generated": png(gen), "sources": [png(s) for s in (sources or [texture(64, 64, 3)])],
            "options": {"output_format": "png", **options}}


def decode(r) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(base64.b64decode(r.json()["image"]), np.uint8), cv2.IMREAD_COLOR)


def test_head_composite_response_and_features(client):
    orig = texture(240, 320, 1)
    r = client.post("/v1/head-composite", json=body(orig), headers=H)
    assert r.status_code == 200, r.text
    b = r.json()
    assert (b["width"], b["height"], b["mime_type"], b["device"]) == (320, 240, "image/png", "cpu")
    f = b["features"]
    assert set(f) == {"hair_dE", "d_expr", "identity", "aligned", "fallback", "inliers", "method", "scale", "face_found"}
    assert isinstance(f["hair_dE"], float) and isinstance(f["d_expr"], float) and isinstance(f["inliers"], int)
    assert f["method"] == "uniform" and f["aligned"] is True and f["fallback"] is False and f["face_found"] is True
    assert f["identity"] == pytest.approx(1.0) and f["d_expr"] == pytest.approx(0.0, abs=1e-4)
    assert {"decode", "detect", "align", "features", "identity", "swap", "restore", "composite", "score", "encode", "total"} <= set(b["timings_ms"])
    out = decode(r)
    # the swapped (red) face is in, the background far from the head is the original's pixels
    fx, fy = 160, 108
    assert out[fy, fx, 2] > 150 and out[fy, fx, 0] < 120
    assert np.array_equal(out[:, :20], orig[:, :20]) and np.array_equal(out[-15:], orig[-15:])


def test_head_composite_keeps_the_eyes_unless_disabled(client):
    gen = texture(480, 640, 2)
    face = FakeDetector().detect(gen)[0]
    le = (face.kps[0] / 2).astype(int)  # in original coordinates (uniform 0.5)
    out = decode(client.post("/v1/head-composite", json=body(gen=gen, color_match=False), headers=H))
    assert out[le[1], le[0], 0] > 40 or out[le[1], le[0], 1] > 40  # not the flat red of the swapper
    out = decode(client.post("/v1/head-composite", json=body(gen=gen, color_match=False, eye_keep=False), headers=H))
    assert np.abs(out[le[1], le[0]].astype(int) - (0, 0, 255)).max() <= 2


def test_head_composite_no_face_errors(client):
    blank = np.zeros((240, 320, 3), np.uint8)
    for kw, code in (({"orig": blank}, "NO_FACE_IN_TARGET"), ({"gen": blank}, "NO_FACE_IN_GENERATED"),
                     ({"sources": [np.zeros((64, 64, 3), np.uint8)]}, "NO_FACE_IN_SOURCE")):
        r = client.post("/v1/head-composite", json=body(**kw), headers=H)
        assert r.status_code == 422 and r.json() == {"detail": code}, (code, r.text)


def test_head_composite_validation(client):
    ok = body()
    cases = [
        {**ok, "sources": []},
        {**ok, "sources": ok["sources"] * 10},
        {k: v for k, v in ok.items() if k != "generated"},
        {**ok, "options": {"swapper": {"restorer": "nope"}}},
        {**ok, "options": {"head_mask": {"feather": 0}}},
        {**ok, "options": {"jpeg_quality": 10}},
    ]
    for b in cases:
        r = client.post("/v1/head-composite", json=b, headers=H)
        assert r.status_code == 422 and r.json()["detail"] == "INVALID_REQUEST", b
    r = client.post("/v1/head-composite", json={**ok, "original": "aGVsbG8="}, headers=H)
    assert r.status_code == 422 and r.json()["detail"] == "BAD_IMAGE"
    assert client.post("/v1/head-composite", json=ok).status_code == 401


def test_head_composite_defaults_to_gfpgan(client, monkeypatch):
    used = []
    monkeypatch.setattr(FakeEngine, "restorer", lambda self, name: used.append(name) or FakeRestorer())
    assert client.post("/v1/head-composite", json=body(), headers=H).status_code == 200
    assert client.post("/v1/head-composite", json=body(swapper={"restorer": "off"}), headers=H).status_code == 200
    assert used == ["gfpgan"]


def test_head_composite_on_cuda_hands_over_the_gpu(client):
    class Up:
        device = "cuda"
        released = 0

        def release(self, keys=None):
            Up.released += 1

    eng = main.state.engine
    eng.device = "cuda"
    eng.ensure = lambda keys: None
    eng.release = lambda keys=None: None
    main.state.upscaler = Up()
    try:
        r = client.post("/v1/head-composite", json=body(), headers=H)
        assert r.status_code == 200, r.text
        assert r.json()["device"] == "cuda" and {"gpu_wait", "load"} <= set(r.json()["timings_ms"])
        assert Up.released == 1
    finally:
        main.state.upscaler = None
