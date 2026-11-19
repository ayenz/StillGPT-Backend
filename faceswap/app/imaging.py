"""Pure image helpers: decoding/encoding, box math, padded crops, masks, colour matching.

Everything here works on numpy BGR uint8 images (OpenCV convention) and has no model dependency,
so it is unit-testable without the ONNX files.
"""

from __future__ import annotations

import base64
import binascii
import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_DECODED_BYTES = 25 * 1024 * 1024
MAX_PIXELS = 40_000_000

# PIL's own decompression-bomb guard would raise a warning/error at a different threshold; we enforce ours.
Image.MAX_IMAGE_PIXELS = None


class ImageError(Exception):
    """Raised with a contract error code (BAD_IMAGE / TOO_LARGE)."""

    def __init__(self, code: str, status: int = 422):
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass
class Decoded:
    bgr: np.ndarray  # H x W x 3 uint8, EXIF orientation applied
    alpha: np.ndarray | None  # H x W uint8 or None
    raw: bytes  # the decoded (pre-orientation) file bytes, used for cache keys
    format: str | None


def b64_to_bytes(data: str) -> bytes:
    if not isinstance(data, str) or not data:
        raise ImageError("BAD_IMAGE")
    s = data.strip()
    if s.startswith("data:"):  # tolerated although the contract says "no data: prefix"
        comma = s.find(",")
        s = s[comma + 1 :] if comma >= 0 else ""
    # Cheap size check before allocating: 4 base64 chars -> 3 bytes.
    if len(s) * 3 // 4 > MAX_DECODED_BYTES + 3:
        raise ImageError("TOO_LARGE", 413)
    try:
        raw = base64.b64decode(s, validate=False)
    except (binascii.Error, ValueError):
        raise ImageError("BAD_IMAGE") from None
    if not raw:
        raise ImageError("BAD_IMAGE")
    if len(raw) > MAX_DECODED_BYTES:
        raise ImageError("TOO_LARGE", 413)
    return raw


def decode_image(data: str) -> Decoded:
    raw = b64_to_bytes(data)
    try:
        im = Image.open(io.BytesIO(raw))
        w, h = im.size
        if w * h > MAX_PIXELS:
            raise ImageError("TOO_LARGE", 413)
        fmt = im.format
        im = ImageOps.exif_transpose(im)
        im.load()
    except ImageError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise ImageError("BAD_IMAGE") from None
    if im.width < 8 or im.height < 8:
        raise ImageError("BAD_IMAGE")
    alpha = None
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        a = np.asarray(im)[:, :, 3]
        if a.min() < 255:
            alpha = a.copy()
    rgb = np.asarray(im.convert("RGB"))
    bgr = np.ascontiguousarray(rgb[:, :, ::-1])
    return Decoded(bgr=bgr, alpha=alpha, raw=raw, format=fmt)


def encode_image(
    bgr: np.ndarray, fmt: str = "jpeg", quality: int = 95, alpha: np.ndarray | None = None
) -> tuple[str, str]:
    """Returns (base64, mime_type)."""
    rgb = bgr[:, :, ::-1]
    buf = io.BytesIO()
    if fmt == "png":
        if alpha is not None and alpha.shape[:2] == bgr.shape[:2]:
            Image.fromarray(np.dstack([rgb, alpha]), "RGBA").save(buf, "PNG", compress_level=6)
        else:
            Image.fromarray(np.ascontiguousarray(rgb), "RGB").save(buf, "PNG", compress_level=6)
        mime = "image/png"
    else:
        Image.fromarray(np.ascontiguousarray(rgb), "RGB").save(
            buf, "JPEG", quality=int(quality), subsampling=0 if quality >= 90 else 2, optimize=True
        )
        mime = "image/jpeg"
    return base64.b64encode(buf.getvalue()).decode("ascii"), mime


# ---------------------------------------------------------------- box math


def square_box(face_box: tuple[float, float, float, float] | np.ndarray, expand: float) -> list[int]:
    """[x1,y1,x2,y2] face box -> integer square [x, y, side, side] centred on the face, side = expand*max(w,h)."""
    x1, y1, x2, y2 = (float(v) for v in face_box[:4])
    w, h = max(1.0, x2 - x1), max(1.0, y2 - y1)
    side = max(16, int(round(expand * max(w, h))))
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    x = int(round(cx - side / 2.0))
    y = int(round(cy - side / 2.0))
    return [x, y, side, side]


def reflect_indices(start: int, length: int, n: int) -> np.ndarray:
    """Indices start..start+length-1 mapped into [0, n) by mirror reflection without repeating the edge pixel
    (OpenCV BORDER_REFLECT_101), for any distance outside the range."""
    idx = np.arange(start, start + length)
    if n == 1:
        return np.zeros_like(idx)
    period = 2 * (n - 1)
    idx = np.mod(idx, period)
    return np.where(idx >= n, period - idx, idx)


def crop_padded(img: np.ndarray, box: list[int] | tuple[int, int, int, int]) -> np.ndarray:
    """Crops [x, y, w, h] from img; parts outside the image are filled by edge reflection."""
    x, y, w, h = (int(v) for v in box[:4])
    H, W = img.shape[:2]
    if w <= 0 or h <= 0:
        raise ValueError("empty box")
    if x >= W or y >= H or x + w <= 0 or y + h <= 0:
        raise ValueError("box outside image")
    if x >= 0 and y >= 0 and x + w <= W and y + h <= H:
        return img[y : y + h, x : x + w].copy()
    ys = reflect_indices(y, h, H)
    xs = reflect_indices(x, w, W)
    return img[ys[:, None], xs[None, :]]


def resize_to(img: np.ndarray, w: int, h: int) -> np.ndarray:
    if img.shape[1] == w and img.shape[0] == h:
        return img
    shrink = w * h < img.shape[0] * img.shape[1]
    return cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA if shrink else cv2.INTER_CUBIC)


def clip_box(box: list[int], W: int, H: int) -> tuple[int, int, int, int, int, int]:
    """Intersection of box [x,y,w,h] with the image -> (ix1, iy1, ix2, iy2, offx, offy) where offx/offy are
    the offsets of the intersection inside the box."""
    x, y, w, h = (int(v) for v in box[:4])
    ix1, iy1 = max(0, x), max(0, y)
    ix2, iy2 = min(W, x + w), min(H, y + h)
    return ix1, iy1, ix2, iy2, ix1 - x, iy1 - y


# ---------------------------------------------------------------- masks


def feather(mask: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0.5:
        return mask
    k = int(sigma * 3) * 2 + 1
    return cv2.GaussianBlur(mask, (k, k), sigma)


def box_mask(size: int, pad: float = 0.1, blur: float = 0.08) -> np.ndarray:
    """Soft rectangular mask for an aligned square crop: 1 inside, fading to 0 at the borders."""
    m = np.zeros((size, size), np.float32)
    p = int(round(size * pad))
    m[p : size - p, p : size - p] = 1.0
    m = feather(m, size * blur)
    return np.clip(m, 0.0, 1.0)


def ellipse_mask(h: int, w: int, center: tuple[float, float], axes: tuple[float, float], sigma: float) -> np.ndarray:
    m = np.zeros((h, w), np.float32)
    cv2.ellipse(
        m,
        (int(round(center[0])), int(round(center[1]))),
        (max(1, int(round(axes[0]))), max(1, int(round(axes[1])))),
        0,
        0,
        360,
        1.0,
        -1,
        cv2.LINE_AA,
    )
    return np.clip(feather(m, sigma), 0.0, 1.0)


def face_region_mask(h: int, w: int, face_box: np.ndarray | None, feather_frac: float) -> np.ndarray:
    """Mask covering the face (forehead to chin) on a patch. face_box [x1,y1,x2,y2] from the detector, or None
    for a centred fallback ellipse. The ellipse is shrunk by the feather radius so the soft edge stays
    around the face, not outside it."""
    if face_box is not None:
        x1, y1, x2, y2 = (float(v) for v in face_box[:4])
        fw, fh = x2 - x1, y2 - y1
        cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0 - 0.04 * fh
        ax, ay = fw * 0.62, fh * 0.66
    else:
        cx, cy = w / 2.0, h / 2.0
        ax, ay = w * 0.28, h * 0.32
    sigma = max(1.0, feather_frac * max(ax, ay))
    # keep the 50% contour near the requested ellipse: dilate the hard ellipse by ~0.5 sigma
    return ellipse_mask(h, w, (cx, cy), (ax + 0.5 * sigma, ay + 0.5 * sigma), sigma)


# ---------------------------------------------------------------- colour


def color_match_lab(src: np.ndarray, ref: np.ndarray, mask: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Shifts src (BGR uint8) so that its LAB mean/std inside mask matches ref (same size). Std ratio is clamped
    to avoid blowing up flat regions."""
    sel = mask > 0.5
    if sel.sum() < 64:
        return src
    s = cv2.cvtColor(src.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)
    r = cv2.cvtColor(ref.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)
    out = s.copy()
    for c in range(3):
        sm, ss = s[..., c][sel].mean(), s[..., c][sel].std() + 1e-3
        rm, rs = r[..., c][sel].mean(), r[..., c][sel].std() + 1e-3
        ratio = float(np.clip(rs / ss, 0.75, 1.33))  # L in 0..100, a/b in about -127..127
        matched = (s[..., c] - sm) * ratio + rm
        out[..., c] = s[..., c] + strength * (matched - s[..., c])
    bgr = cv2.cvtColor(out, cv2.COLOR_LAB2BGR)
    return np.clip(bgr * 255.0 + 0.5, 0, 255).astype(np.uint8)


def blend(base: np.ndarray, top: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    a = alpha[..., None] if alpha.ndim == 2 else alpha
    return np.clip(base.astype(np.float32) * (1.0 - a) + top.astype(np.float32) * a + 0.5, 0, 255).astype(np.uint8)
