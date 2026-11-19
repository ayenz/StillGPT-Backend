import cv2
import numpy as np
import pytest

from app import upscale
from app.engine import Face


def nearest_x4(x: np.ndarray) -> np.ndarray:
    """Fake x4 'model': nearest-neighbour upsampling, NCHW."""
    return x.repeat(4, axis=2).repeat(4, axis=3)


def const_model(v: float):
    return lambda x: np.full((1, 3, x.shape[2] * 4, x.shape[3] * 4), v, np.float32)


def rand_rgb(h, w, seed=0):
    return np.random.default_rng(seed).random((h, w, 3), dtype=np.float32)


# ---------------------------------------------------------------- tiling


@pytest.mark.parametrize("h, w, tile_in, single_max", [(37, 50, 64, 0), (300, 211, 256, 0), (100, 90, 256, 640), (513, 700, 512, 512)])
def test_tiling_stitch_is_exact(h, w, tile_in, single_max):
    rgb = rand_rgb(h, w)
    out = upscale.run_region(nearest_x4, rgb, tile_in, single_max)
    expected = rgb.repeat(4, 0).repeat(4, 1)
    assert out.shape == (h * 4, w * 4, 3)
    assert np.array_equal(out, expected)


def test_tiles_cover_output_exactly_once():
    h, w = 450, 333
    seen = np.zeros((h * 4, w * 4), np.int32)
    for oy, ox, (o,) in upscale.iter_tiles([nearest_x4], rand_rgb(h, w), 256, 0):
        seen[oy : oy + o.shape[0], ox : ox + o.shape[1]] += 1
    assert (seen == 1).all()


def test_single_pass_pads_to_multiple_of_16():
    shapes = []

    def model(x):
        shapes.append(x.shape)
        return nearest_x4(x)

    rgb = rand_rgb(50, 37)
    out = upscale.run_region(model, rgb, 256, 640)
    assert shapes == [(1, 3, 64, 48)]
    assert np.array_equal(out, rgb.repeat(4, 0).repeat(4, 1))


def test_blend_tiled_weights_and_bgr():
    rgb = rand_rgb(40, 30)
    out = upscale.blend_tiled([(const_model(1.0), 0.7), (const_model(0.0), 0.3)], rgb, 64, 0)
    assert out.shape == (160, 120, 3) and out.dtype == np.uint8
    assert (out == int(0.7 * 255 + 0.5)).all()
    out = upscale.blend_tiled([(nearest_x4, 1.0)], rgb, 64, 0)
    assert np.array_equal(out, upscale.to_u8(rgb.repeat(4, 0).repeat(4, 1))[:, :, ::-1])


# ---------------------------------------------------------------- grain


def flat(v, h=300, w=200):
    return np.full((h, w, 3), v, np.uint8)


def test_grain_deterministic_shape_and_seed():
    a = upscale.grain_inplace(flat(128), 1)
    b = upscale.grain_inplace(flat(128), 1)
    c = upscale.grain_inplace(flat(128), 2)
    assert a.shape == (300, 200, 3) and a.dtype == np.uint8
    assert np.array_equal(a, b) and not np.array_equal(a, c)
    assert np.array_equal(a[:, :, 0], a[:, :, 1]) and np.array_equal(a[:, :, 0], a[:, :, 2])  # monochrome


def test_grain_strength_and_midtone_weighting():
    mid = upscale.grain_inplace(flat(128, 600, 600), 3).astype(np.float32) - 128
    dark = upscale.grain_inplace(flat(10, 600, 600), 3).astype(np.float32) - 10
    assert abs(mid.mean()) < 0.1
    assert mid.std() == pytest.approx(2.5 * 1.25, rel=0.05)  # L=0.5 -> weight 1.0 * 1.25
    # L=10/255 -> 4L(1-L)=0.151 -> weight ~0.15*1.25; integer rounding adds ~0.29 std
    assert dark.std() < 0.7 and dark.std() < mid.std() / 4


def test_grain_bands_match_full_image(monkeypatch):
    img = cv2.GaussianBlur(np.random.default_rng(5).integers(0, 255, (700, 90, 3), dtype=np.uint8), (0, 0), 3)
    full_band = upscale.grain_inplace(img.copy(), 9)  # 256-row bands
    monkeypatch.setattr(upscale, "GRAIN_BAND", 10_000)
    one_band = upscale.grain_inplace(img.copy(), 9)
    monkeypatch.setattr(upscale, "GRAIN_BAND", 37)
    small = upscale.grain_inplace(img.copy(), 9)
    assert np.array_equal(full_band, one_band) and np.array_equal(small, one_band)


def test_blurred_noise_std_matches_empirical():
    n = np.random.default_rng(0).standard_normal((1500, 1500), dtype=np.float32)
    assert upscale.blurred_noise_std() == pytest.approx(float(cv2.GaussianBlur(n, (0, 0), 0.7).std()), rel=0.01)


# ---------------------------------------------------------------- faces


def face(x1, y1, x2, y2):
    return Face(box=np.array([x1, y1, x2, y2], np.float32), score=0.9, kps=np.zeros((5, 2), np.float32))


def test_plan_faces_box_context_and_min_size():
    plans = upscale.plan_faces([face(100, 100, 140, 150), face(10, 10, 30, 30)], 400, 300, None)
    assert len(plans) == 1  # 20x20 < 24x24 ignored
    p = plans[0]
    # centre (120, 125), side 1.7*50 = 85
    assert p.box == (77, 82, 162, 167) and p.region == (61, 66, 178, 183) and p.enhance


def test_plan_faces_clipped_at_edges():
    (p,) = upscale.plan_faces([face(0, 0, 40, 40)], 100, 80, None)
    assert p.box[:2] == (0, 0) and p.region[:2] == (0, 0)


def test_big_face_rule():
    small, big = face(100, 100, 140, 150), face(300, 50, 600, 400)
    plans = upscale.plan_faces([small, big], 1000, 800, 0.15e6)
    assert [p.enhance for p in plans] == [True, False]
    assert plans[1].region_area > 0.15e6
    assert all(p.enhance for p in upscale.plan_faces([small, big], 1000, 800, None))  # CUDA: no limit


def test_face_mask_feathering():
    m = upscale.face_mask(200, 160)[:, :, 0]
    assert m.shape == (200, 160)
    assert m[100, 80] == pytest.approx(1.0, abs=1e-3)  # centre opaque
    assert m[0, 0] < 1e-3 and m[199, 159] < 1e-3  # corners untouched
    edge = m[100, 80 - int(160 * 0.40)]  # on the ellipse: about half
    assert 0.3 < edge < 0.7
    row = m[100, :80]
    assert np.all(np.diff(row) >= -1e-6)  # monotonic fade-in towards the centre


# ---------------------------------------------------------------- pipelines


class FakeDetector:
    def __init__(self, faces):
        self.faces = faces

    def detect(self, img, thresh=0.5, nms_thresh=0.4):
        return list(self.faces)


def fake_upscaler(device="cpu", faces=(), big_face_mp=0.15, values=None):
    values = values or {"clear": 0.8, "span": 0.2, "nomos": 0.4}
    return upscale.Upscaler(lambda: {k: const_model(v) for k, v in values.items()}, FakeDetector(list(faces)), device, big_face_mp)


def test_pipelines_by_device():
    assert fake_upscaler("cpu").pipelines == {"natural": "P4", "sharp": "P1"}
    assert fake_upscaler("cuda").pipelines == {"natural": "P5", "sharp": "P1"}
    assert fake_upscaler("cpu").tile_in == 256 and fake_upscaler("cuda").tile_in == 512


@pytest.mark.parametrize("scale", [2, 4])
def test_output_size(scale):
    img = np.full((37, 51, 3), 100, np.uint8)
    out, info = fake_upscaler().upscale(img, scale, "sharp", 1)
    assert out.shape == (37 * scale, 51 * scale, 3)
    assert info["pipeline"] == "P1" and info["faces"] == 0


def test_p1_and_p5_blend_values(monkeypatch):
    monkeypatch.setattr(upscale, "grain_inplace", lambda img, seed: img)
    img = np.full((20, 20, 3), 100, np.uint8)
    out, _ = fake_upscaler().upscale(img, 4, "sharp", 1)
    assert (out == round((0.7 * 0.8 + 0.3 * 0.2) * 255)).all()
    out, info = fake_upscaler("cuda").upscale(img, 4, "natural", 1)
    assert info["pipeline"] == "P5" and (out == round((0.6 * 0.4 + 0.4 * 0.8) * 255)).all()


def test_p4_replaces_faces_and_honours_big_face_rule(monkeypatch):
    monkeypatch.setattr(upscale, "grain_inplace", lambda img, seed: img)
    img = np.full((300, 400, 3), 100, np.uint8)
    faces = [face(100, 100, 140, 150), face(250, 20, 390, 290)]  # second: region > 0.05 MP
    out, info = fake_upscaler(faces=faces, big_face_mp=0.05).upscale(img, 4, "natural", 1)
    assert info["pipeline"] == "P4" and info["faces"] == 2 and info["faces_enhanced"] == 1
    base = round((0.7 * 0.8 + 0.3 * 0.2) * 255)
    patch = 0.6 * 0.4 * 255 + 0.4 * round(0.8 * 255)
    cx, cy = 120 * 4, 125 * 4
    assert abs(int(out[cy, cx, 0]) - patch) <= 1  # face centre = face patch
    assert out[0, 0, 0] == base and out[1100, 1500, 0] == base  # background and the big face keep the base


def test_p4_face_patch_uses_clear_reality_of_the_region(monkeypatch):
    """The clear_reality part of the face patch comes from the full-image tiles (captured per tile)."""
    monkeypatch.setattr(upscale, "grain_inplace", lambda img, seed: img)
    rgb_img = cv2.GaussianBlur(np.random.default_rng(2).integers(0, 255, (300, 300, 3), dtype=np.uint8), (0, 0), 2)
    up = upscale.Upscaler(
        lambda: {"clear": nearest_x4, "span": nearest_x4, "nomos": nearest_x4}, FakeDetector([face(110, 110, 190, 190)]), "cpu"
    )
    up.tile_in, up.single_max = 64, 0  # many tiles across the face box
    out, info = up.upscale(rgb_img, 4, "natural", 1)
    assert info["faces_enhanced"] == 1
    expected = rgb_img.repeat(4, 0).repeat(4, 1)
    assert np.abs(out.astype(int) - expected.astype(int)).max() <= 1


def test_release_and_lazy_recreate():
    calls = []

    def factory():
        calls.append(1)
        return {"clear": const_model(0.5), "span": const_model(0.5), "nomos": const_model(0.5)}

    up = upscale.Upscaler(factory, FakeDetector([]), "cuda", eager=False)
    assert not up.loaded and calls == []
    up.upscale(np.zeros((16, 16, 3), np.uint8), 4, "sharp", 1)
    assert up.loaded and len(calls) == 1
    up.release()
    assert not up.loaded
    up.upscale(np.zeros((16, 16, 3), np.uint8), 4, "sharp", 1)
    assert len(calls) == 2


def test_encode_jpeg_444():
    import io

    from PIL import Image, JpegImagePlugin

    data = upscale.encode_jpeg(np.full((32, 48, 3), 90, np.uint8), 97)
    im = Image.open(io.BytesIO(data))
    assert im.format == "JPEG" and im.size == (48, 32)
    assert JpegImagePlugin.get_sampling(im) == 0  # 4:4:4
