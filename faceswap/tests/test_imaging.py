import base64
import io

import numpy as np
import pytest
from PIL import Image

from app import imaging
from app.engine import Face, arcface_template, estimate_alignment, frontalness, nms, pick_face, umeyama


def _png_b64(arr: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_square_box_centred_and_expanded():
    box = imaging.square_box([100, 200, 150, 260], 2.0)  # w=50, h=60 -> side 120, centre (125, 230)
    assert box == [65, 170, 120, 120]


def test_square_box_min_side():
    assert imaging.square_box([10, 10, 12, 12], 2.2)[2] == 16


def test_crop_padded_inside_is_exact():
    img = np.arange(20 * 30 * 3, dtype=np.uint8).reshape(20, 30, 3)
    out = imaging.crop_padded(img, [5, 4, 10, 8])
    assert np.array_equal(out, img[4:12, 5:15])


def test_crop_padded_reflects_outside():
    img = np.zeros((10, 10, 3), np.uint8)
    img[:, :, 0] = np.arange(10)[None, :]  # column index in channel 0
    out = imaging.crop_padded(img, [-3, 0, 6, 4])
    assert out.shape == (4, 6, 3)
    # reflect_101: columns -3,-2,-1 -> 3,2,1
    assert list(out[0, :, 0]) == [3, 2, 1, 0, 1, 2]


def test_crop_padded_pad_larger_than_image():
    img = np.random.default_rng(0).integers(0, 255, (5, 7, 3), dtype=np.uint8)
    out = imaging.crop_padded(img, [-20, -15, 50, 40])
    assert out.shape == (40, 50, 3)
    assert np.array_equal(out[15:20, 20:27], img)


def test_crop_padded_outside_raises():
    with pytest.raises(ValueError):
        imaging.crop_padded(np.zeros((5, 5, 3), np.uint8), [10, 10, 4, 4])


def test_clip_box():
    assert imaging.clip_box([-5, 10, 20, 20], 100, 25) == (0, 10, 15, 25, 5, 0)


def test_color_match_identity_and_shift():
    rng = np.random.default_rng(1)
    a = rng.integers(60, 200, (64, 64, 3), dtype=np.uint8)
    m = np.ones((64, 64), np.float32)
    same = imaging.color_match_lab(a, a, m)
    assert np.abs(same.astype(int) - a.astype(int)).max() <= 2
    brighter = np.clip(a.astype(int) + 30, 0, 255).astype(np.uint8)
    matched = imaging.color_match_lab(a, brighter, m)
    assert abs(matched.mean() - brighter.mean()) < 3


def test_face_hull_points_include_forehead_and_landmarks():
    kps = np.array([[45, 60], [75, 60], [60, 75], [48, 90], [72, 90]], np.float32)
    pts = imaging.face_hull_points(np.array([40, 50, 80, 100]), kps)
    assert pts.shape == (48 + 5, 2)
    assert pts[:, 1].min() < 50 - 0.15 * 50  # raised above the detector box
    assert pts[:, 1].max() <= 100 + 0.05 * 60 and abs(pts[:48, 0].mean() - 60) < 0.5


def test_hull_mask_opaque_inside_soft_outside():
    pts = imaging.face_hull_points(np.array([70, 70, 130, 140]), None)
    m = imaging.hull_mask(200, 200, pts, 4, 8)
    assert m.dtype == np.float32 and m.shape == (200, 200)
    assert m[105, 100] > 0.99
    assert m[2, 2] < 0.01 and m[197, 100] < 0.01
    row = m[105, 100:]
    assert np.all(np.diff(row) <= 1e-6)  # monotonic fade to the outside


def test_harmonize_edges_takes_base_low_freq_on_the_edge_only():
    rng = np.random.default_rng(2)
    detail = rng.integers(-10, 10, (100, 100, 1))
    patch = np.clip(150 + detail, 0, 255).astype(np.uint8).repeat(3, 2)
    ref = np.full((100, 100, 3), 100, np.uint8)
    mask = np.zeros((100, 100), np.float32)
    mask[30:70, 30:70] = 1.0
    out = imaging.harmonize_edges(patch, ref, mask, 3.0).astype(int)
    assert abs(out[5:15, 5:15].mean() - 100) < 3  # band: base colour, patch detail kept
    assert out[5:15, 5:15].std() > 3
    assert np.array_equal(out[45:55, 45:55], patch[45:55, 45:55])  # opaque core untouched


def test_blend_extremes():
    a = np.full((4, 4, 3), 10, np.uint8)
    b = np.full((4, 4, 3), 200, np.uint8)
    assert (imaging.blend(a, b, np.zeros((4, 4), np.float32)) == 10).all()
    assert (imaging.blend(a, b, np.ones((4, 4), np.float32)) == 200).all()


def test_decode_exif_orientation():
    im = Image.new("RGB", (40, 20), (255, 0, 0))
    exif = Image.Exif()
    exif[274] = 6  # rotate 90 CW on display
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif)
    d = imaging.decode_image(base64.b64encode(buf.getvalue()).decode())
    assert d.bgr.shape[:2] == (40, 20)


def test_decode_bad_and_too_large(monkeypatch):
    with pytest.raises(imaging.ImageError) as e:
        imaging.decode_image(base64.b64encode(b"not an image").decode())
    assert e.value.code == "BAD_IMAGE"
    with pytest.raises(imaging.ImageError) as e:
        imaging.decode_image("!!!@@@")
    assert e.value.code == "BAD_IMAGE"
    monkeypatch.setattr(imaging, "MAX_PIXELS", 100)
    with pytest.raises(imaging.ImageError) as e:
        imaging.decode_image(_png_b64(np.zeros((20, 20, 3), np.uint8)))
    assert e.value.code == "TOO_LARGE" and e.value.status == 413
    monkeypatch.setattr(imaging, "MAX_DECODED_BYTES", 10)
    with pytest.raises(imaging.ImageError) as e:
        imaging.decode_image(_png_b64(np.zeros((9, 9, 3), np.uint8)))
    assert e.value.code == "TOO_LARGE"


def test_decode_keeps_alpha_and_encode_roundtrip():
    rgba = np.zeros((16, 16, 4), np.uint8)
    rgba[..., 2] = 255
    rgba[..., 3] = 128
    d = imaging.decode_image(_png_b64(rgba))
    assert d.alpha is not None and d.bgr[0, 0, 0] == 255  # blue in BGR
    b64, mime = imaging.encode_image(d.bgr, "png", alpha=d.alpha)
    assert mime == "image/png"
    back = np.asarray(Image.open(io.BytesIO(base64.b64decode(b64))))
    assert back.shape == (16, 16, 4) and back[0, 0, 3] == 128
    _, mime = imaging.encode_image(d.bgr, "jpeg", 80)
    assert mime == "image/jpeg"


def test_umeyama_recovers_similarity():
    src = arcface_template(112)
    ang, s, t = np.deg2rad(20), 1.7, np.array([13.0, -4.0])
    R = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]]) * s
    dst = src @ R.T + t
    M = umeyama(src, dst)
    assert np.allclose(M[:, :2], R, atol=1e-4) and np.allclose(M[:, 2], t, atol=1e-3)


def test_arcface_template_128_shift():
    t = arcface_template(128)
    assert np.allclose(t[0], [38.2946 + 8, 51.6963])


def test_frontalness():
    frontal = np.array([[40, 50], [70, 50], [55, 66], [43, 80], [67, 80]], np.float32)
    profile = np.array([[40, 50], [70, 50], [68, 66], [50, 80], [70, 80]], np.float32)
    assert frontalness(frontal) > 0.95
    assert frontalness(profile) < 0.2


def test_nms():
    dets = np.array([[0, 0, 10, 10, 0.9], [1, 1, 10, 10, 0.8], [50, 50, 60, 60, 0.7]], np.float32)
    assert nms(dets, 0.4) == [0, 2]


def test_estimate_alignment_reports_deviation():
    kps = np.array([[400, 450], [620, 450], [510, 560], [420, 680], [600, 680]], np.float32)
    al = estimate_alignment(kps, kps, 1024)
    assert al.scale == pytest.approx(1.0) and al.rotation_deg == pytest.approx(0.0, abs=1e-4)
    assert al.shift == pytest.approx(0.0) and al.residual < 1e-4
    # patch face drawn at 0.7x around (512, 430): the transform patch -> base must scale it back up by 1/0.7
    small = (kps - [512, 430]) * 0.7 + [512, 430]
    al = estimate_alignment(small, kps, 1024)
    assert al.scale == pytest.approx(1 / 0.7, rel=1e-3)
    assert al.shift == pytest.approx(np.linalg.norm(small.mean(0) - kps.mean(0)) / 1024, rel=1e-4)
    a = np.deg2rad(10)
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    al = estimate_alignment(kps, kps @ R.T, 1024)
    assert al.rotation_deg == pytest.approx(10.0, abs=1e-3)
    assert set(al.as_dict()) == {"scale", "rotation_deg", "shift", "residual"}


def test_pick_face_prefers_large_and_central():
    k = np.zeros((5, 2), np.float32)
    corner = Face(box=np.array([0, 0, 40, 40], np.float32), score=0.9, kps=k)
    centre = Face(box=np.array([80, 80, 120, 120], np.float32), score=0.9, kps=k)
    assert pick_face([corner, centre], 200, 200) is centre
    big = Face(box=np.array([20, 20, 180, 180], np.float32), score=0.9, kps=k)
    assert pick_face([centre, big], 200, 200) is big
    assert pick_face([], 200, 200) is None
