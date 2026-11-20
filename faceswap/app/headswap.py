"""Head composite (engine `head_swap`): a regenerated whole image (Qoder) is aligned back onto the original, its face
gets the identity from the swapper (eyes kept from the regenerated image), and only the head region is blended into
the original, so the background stays the original's pixels. Ported from the prototype that won the blind test
(align.py, composite.py, eyekeep_round.py, select_best.py); the constants are the validated ones."""

from __future__ import annotations

import cv2
import numpy as np

from .engine import Face

# Faces are picked at a low threshold (prototype fsa.main_face): the largest one, or the one nearest to a given face.
FACE_THRESH = 0.3
# Aspect ratios within 1% count as equal: Qoder kept the framing, a uniform resize maps it exactly.
SAME_ASPECT_TOL = 0.01
MIN_INLIERS = 30
COLOR_STRENGTH = 0.6


def faces_sorted(detector, img: np.ndarray, thresh: float = FACE_THRESH) -> list[Face]:
    return sorted(detector.detect(img, thresh), key=lambda f: -f.area)


def main_face(detector, img: np.ndarray, near: Face | None = None, thresh: float = FACE_THRESH) -> Face | None:
    fs = faces_sorted(detector, img, thresh)
    if not fs:
        return None
    if near is None:
        return fs[0]
    c = (near.box[:2] + near.box[2:4]) / 2
    return min(fs, key=lambda f: float(np.linalg.norm((f.box[:2] + f.box[2:4]) / 2 - c)))


# ---------------------------------------------------------------- alignment


def _face_out_mask(shape: tuple[int, ...], box) -> np.ndarray:
    """255 everywhere except a generous rectangle around the face (it changed on purpose, its keypoints mislead)."""
    mask = np.full(shape[:2], 255, np.uint8)
    if box is not None:
        x1, y1, x2, y2 = (float(v) for v in box[:4])
        w, h = x2 - x1, y2 - y1
        cv2.rectangle(mask, (int(x1 - 0.8 * w), int(y1 - 1.0 * h)), (int(x2 + 0.8 * w), int(y2 + 0.6 * h)), 0, -1)
    return mask


def estimate_similarity(orig: np.ndarray, gen: np.ndarray, face_box=None) -> tuple[np.ndarray | None, int, float | None, float | None]:
    """SIFT + RANSAC similarity transform mapping gen -> orig on background keypoints.
    Returns (M 2x3 | None, inliers, scale, shift_px). The face rectangle is masked out in both images (in the
    generated one at the face box scaled by the size ratio)."""
    g1 = cv2.cvtColor(orig, cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(gen, cv2.COLOR_BGR2GRAY)
    m1 = _face_out_mask(g1.shape, face_box)
    if face_box is not None:
        sx, sy = gen.shape[1] / orig.shape[1], gen.shape[0] / orig.shape[0]
        m2 = _face_out_mask(g2.shape, np.asarray(face_box[:4], np.float32) * np.array([sx, sy, sx, sy], np.float32))
    else:
        m2 = _face_out_mask(g2.shape, None)
    sift = cv2.SIFT_create(4000)
    k1, d1 = sift.detectAndCompute(g1, m1)
    k2, d2 = sift.detectAndCompute(g2, m2)
    if d1 is None or d2 is None or len(k1) < 8 or len(k2) < 8:
        return None, 0, None, None
    matches = cv2.BFMatcher().knnMatch(d2, d1, k=2)
    good = [a for a, b in (x for x in matches if len(x) == 2) if a.distance < 0.75 * b.distance]
    if len(good) < 8:
        return None, len(good), None, None
    src = np.float32([k2[a.queryIdx].pt for a in good])
    dst = np.float32([k1[a.trainIdx].pt for a in good])
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0, maxIters=5000)
    if M is None:
        return None, 0, None, None
    s = float(np.hypot(M[0, 0], M[0, 1]))
    return M.astype(np.float32), int(inl.sum()), s, float(np.hypot(M[0, 2], M[1, 2]))


def transform(orig: np.ndarray, gen: np.ndarray, orig_face: Face) -> tuple[np.ndarray, dict]:
    """2x3 transform generated -> original plus info {method: uniform|sift|fallback, aligned, fallback, inliers, scale}."""
    ro, rg = orig.shape[1] / orig.shape[0], gen.shape[1] / gen.shape[0]
    if abs(ro / rg - 1) < SAME_ASPECT_TOL:
        k = orig.shape[1] / gen.shape[1]
        return np.float32([[k, 0, 0], [0, k, 0]]), {"method": "uniform", "aligned": True, "fallback": False, "inliers": 0, "scale": k}
    M, inl, s, _ = estimate_similarity(orig, gen, orig_face.box)
    if M is not None and inl >= MIN_INLIERS:
        return M, {"method": "sift", "aligned": True, "fallback": False, "inliers": inl, "scale": s}
    # textureless background: uniform scale, centred (what Qoder does when it has to change the aspect ratio)
    k = max(orig.shape[1] / gen.shape[1], orig.shape[0] / gen.shape[0])
    M = np.float32([[k, 0, (orig.shape[1] - gen.shape[1] * k) / 2], [0, k, (orig.shape[0] - gen.shape[0] * k) / 2]])
    return M, {"method": "fallback", "aligned": False, "fallback": True, "inliers": inl, "scale": k}


# ---------------------------------------------------------------- masks and colour


def head_mask(shape, boxes, up=0.75, side=0.45, down=0.18, feather=0.12) -> np.ndarray:
    """Soft ellipse per face box, raised for hair (up) and widened (side); union of all boxes, Gaussian-feathered."""
    H, W = shape[:2]
    m = np.zeros((H, W), np.float32)
    for x1, y1, x2, y2 in (b[:4] for b in boxes):
        w, h = x2 - x1, y2 - y1
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2 - (up - down) * h / 2
        ax, ay = w * (0.5 + side), h * (0.5 + (up + down) / 2)
        cv2.ellipse(m, (int(cx), int(cy)), (int(ax), int(ay)), 0, 0, 360, 1.0, -1)
    s = max(3, feather * max(b[2] - b[0] for b in boxes))
    return cv2.GaussianBlur(m, (0, 0), float(s))


def _stats(x: np.ndarray, w: np.ndarray) -> tuple[float, float]:
    m = np.average(x, weights=w)
    return m, float(np.sqrt(np.average((x - m) ** 2, weights=w)))


def color_match(src: np.ndarray, ref: np.ndarray, w: np.ndarray, strength: float = COLOR_STRENGTH) -> np.ndarray:
    """LAB mean/std transfer of src towards ref, statistics weighted by w (the ring around the head mask)."""
    a = cv2.cvtColor(src, cv2.COLOR_BGR2LAB).astype(np.float32)
    b = cv2.cvtColor(ref, cv2.COLOR_BGR2LAB).astype(np.float32)
    w = w + 1e-6
    out = a.copy()
    for c in range(3):
        ms, ss = _stats(a[..., c], w)
        mr, sr = _stats(b[..., c], w)
        full = (a[..., c] - ms) * (sr / (ss + 1e-6)) + mr
        out[..., c] = a[..., c] * (1 - strength) + full * strength
    return cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


def eye_mask(shape, face: Face, rx=0.42, ry=0.26, feather=0.18) -> np.ndarray:
    """Two feathered ellipses (lids + iris) around the eye landmarks, sized by the inter-ocular distance."""
    le, re = face.kps[0], face.kps[1]
    iod = float(np.linalg.norm(re - le))
    m = np.zeros(shape[:2], np.float32)
    for c in (le, re):
        cv2.ellipse(m, (int(c[0]), int(c[1])), (int(rx * iod), int(ry * iod)), 0, 0, 360, 1.0, -1)
    return cv2.GaussianBlur(m, (0, 0), max(2.0, feather * iod))


def keep_eyes(swapped: np.ndarray, gen: np.ndarray, gen_face: Face) -> np.ndarray:
    """The swapper's eyes are often crossed/dull: take both eye regions back from the regenerated image."""
    em = eye_mask(gen.shape, gen_face)[..., None]
    return (swapped * (1 - em) + gen * em).astype(np.uint8)


def composite(detector, orig: np.ndarray, gen: np.ndarray, orig_face: Face, M: np.ndarray, color: bool = True, **mk) -> tuple[np.ndarray, Face | None]:
    """Warps gen onto orig with M and blends the head region (mask on the union of both face boxes)."""
    warped = cv2.warpAffine(gen, M, (orig.shape[1], orig.shape[0]), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)
    gf = main_face(detector, warped, orig_face)
    boxes = [orig_face.box] + ([gf.box] if gf is not None else [])
    m = head_mask(orig.shape, boxes, **mk)
    if color:
        ring = np.clip(cv2.GaussianBlur(m, (0, 0), 25) - m, 0, 1)
        warped = color_match(warped, orig, ring)
    out = (warped.astype(np.float32) * m[..., None] + orig.astype(np.float32) * (1 - m[..., None])).astype(np.uint8)
    return out, gf


# ---------------------------------------------------------------- selection features (select_best.py)


def hair_lab(img: np.ndarray, face: Face) -> np.ndarray | None:
    """Median LAB of three regions: above the face and beside it (left / right)."""
    x1, y1, x2, y2 = (float(v) for v in face.box[:4])
    w, h = x2 - x1, y2 - y1
    H, W = img.shape[:2]
    regs = [
        (x1 + 0.1 * w, y1 - 0.45 * h, x2 - 0.1 * w, y1 - 0.08 * h),
        (x1 - 0.35 * w, y1 + 0.1 * h, x1 - 0.05 * w, y2),
        (x2 + 0.05 * w, y1 + 0.1 * h, x2 + 0.35 * w, y2),
    ]
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    px = []
    for a, b, c, d in regs:
        a, b, c, d = int(max(0, a)), int(max(0, b)), int(min(W, c)), int(min(H, d))
        if c > a and d > b:
            px.append(lab[b:d, a:c].reshape(-1, 3))
    return np.median(np.concatenate(px), 0) if px else None


def smile(face: Face) -> tuple[float, float]:
    """(mouth width, mouth-to-eye-line height), both / inter-ocular distance."""
    le, re, _nose, lm, rm = face.kps
    iod = float(np.linalg.norm(re - le)) + 1e-6
    return float(np.linalg.norm(rm - lm)) / iod, float((lm[1] + rm[1]) / 2 - (le[1] + re[1]) / 2) / iod


HAIR_DE_MISSING = 99.0


def expression_features(detector, orig: np.ndarray, orig_face: Face, gen: np.ndarray, M: np.ndarray) -> dict:
    """hair_dE (LAB distance of the hair medians) and d_expr (smile geometry change), measured on the raw generated
    image warped onto the original, exactly like the prototype's selection."""
    warped = cv2.warpAffine(gen, M, (orig.shape[1], orig.shape[0]))
    gf = main_face(detector, warped, orig_face)
    if gf is None:
        return {"hair_dE": HAIR_DE_MISSING, "d_expr": 1.0, "face_found": False}
    oh, gh = hair_lab(orig, orig_face), hair_lab(warped, gf)
    dE = float(np.linalg.norm(gh - oh)) if gh is not None and oh is not None else HAIR_DE_MISSING
    osm, omy = smile(orig_face)
    gsm, gmy = smile(gf)
    return {"hair_dE": dE, "d_expr": abs(gsm - osm) + 0.5 * abs(gmy - omy), "face_found": True}
