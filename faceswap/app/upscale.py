"""Image upscaling (x4 ONNX models, facefusion frame_enhancer convention: RGB float 0..1 NCHW in/out).

Pipelines (benchmarked, see README):
  P1 (sharp)            grain(0.7*clear_reality + 0.3*span_kendata)
  P4 (natural, CPU)     P1 base with detected faces replaced by 0.6*nomos8k_sc + 0.4*clear_reality (elliptical feather)
  P5 (natural, CUDA)    grain(0.6*nomos8k_sc + 0.4*clear_reality) on the whole image
scale 2 = the 4x result (no grain) downscaled with INTER_AREA, then grain. Grain is always applied at the final size.

Memory: the 4x result is accumulated directly into one uint8 buffer tile by tile (all models of a pipeline run on the
same tile), grain is added in horizontal bands, so a 4.2 MP input (67 MP output) needs ~200 MB for the result plus
small per-tile / per-band temporaries instead of several 800 MB float32 copies.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

log = logging.getLogger("faceswap.upscale")

S = 4  # model scale
PAD = 16  # reflect / real-context padding around every tile (input px)
SINGLE_PASS_MULTIPLE = 16
CTX = 16  # real context around a face box for the face model (input px)
FACE_EXPAND = 1.7
FACE_MIN_AREA = 24 * 24
FACE_DET_THRESH = 0.5
GRAIN_SIGMA = 2.5
GRAIN_BLUR = 0.7
GRAIN_BAND = 256  # rows per band (output px)
GRAIN_MARGIN = 8  # >= gaussian kernel radius (3 for sigma 0.7)
NOISE_BLOCK = 256  # rows per independently seeded noise block

WEIGHTS = {
    "P1": (("clear", 0.7), ("span", 0.3)),
    "P4": (("clear", 0.7), ("span", 0.3)),
    "P5": (("nomos", 0.6), ("clear", 0.4)),
}
FACE_NOMOS_WEIGHT = 0.6  # face patch = 0.6*nomos + 0.4*clear_reality

Model = Callable[[np.ndarray], np.ndarray]  # NCHW float32 0..1 -> NCHW x4


# ---------------------------------------------------------------- tiling


def iter_tiles(
    models: list[Model], rgb: np.ndarray, tile_in: int, single_max: int, pad: int = PAD
) -> Iterator[tuple[int, int, list[np.ndarray]]]:
    """Runs every model on the same tiles of rgb (H x W x 3 float32 0..1) and yields (oy, ox, outs): the x4 outputs
    (h x w x 3 float32, padding already cropped) whose top-left corner is at (oy, ox) in output pixels.
    An input whose longer side is <= single_max runs in one pass, padded (reflect) to a multiple of 16."""
    h, w = rgb.shape[:2]
    if max(h, w) <= single_max:
        ph, pw = (-h) % SINGLE_PASS_MULTIPLE, (-w) % SINGLE_PASS_MULTIPLE
        x = np.pad(rgb, ((0, ph), (0, pw), (0, 0)), mode="reflect") if ph or pw else rgb
        blob = np.ascontiguousarray(x.transpose(2, 0, 1)[None], np.float32)
        yield 0, 0, [m(blob)[0].transpose(1, 2, 0)[: h * S, : w * S] for m in models]
        return
    step = tile_in - 2 * pad
    nh, nw = -(-h // step), -(-w // step)
    x = np.pad(rgb, ((pad, nh * step - h + pad), (pad, nw * step - w + pad), (0, 0)), mode="reflect")
    p = pad * S
    for i in range(nh):
        th = min(step, h - i * step) * S
        for j in range(nw):
            tw = min(step, w - j * step) * S
            t = x[i * step : i * step + tile_in, j * step : j * step + tile_in]
            blob = np.ascontiguousarray(t.transpose(2, 0, 1)[None], np.float32)
            yield i * step * S, j * step * S, [m(blob)[0].transpose(1, 2, 0)[p : p + th, p : p + tw] for m in models]


def to_u8(x: np.ndarray) -> np.ndarray:
    """float 0..1 -> uint8 (rounded, clipped)."""
    return np.clip(x * 255.0 + 0.5, 0, 255).astype(np.uint8)


def blend_tiled(
    models: list[tuple[Model, float]],
    rgb: np.ndarray,
    tile_in: int,
    single_max: int,
    on_tile: Callable[[int, int, list[np.ndarray]], None] | None = None,
) -> np.ndarray:
    """Weighted sum of the x4 outputs of several models (each clipped to 0..1 first, as benchmarked), accumulated
    tile by tile into one uint8 BGR image."""
    h, w = rgb.shape[:2]
    out = np.empty((h * S, w * S, 3), np.uint8)
    for oy, ox, outs in iter_tiles([m for m, _ in models], rgb, tile_in, single_max):
        acc = np.clip(outs[0], 0.0, 1.0) * models[0][1]
        for o, (_, wt) in zip(outs[1:], models[1:]):
            acc += np.clip(o, 0.0, 1.0) * wt
        th, tw = acc.shape[:2]
        out[oy : oy + th, ox : ox + tw] = to_u8(acc)[:, :, ::-1]
        if on_tile is not None:
            on_tile(oy, ox, outs)
    return out


def run_region(model: Model, rgb: np.ndarray, tile_in: int, single_max: int) -> np.ndarray:
    """x4 output of one model for a (small) region, float32 RGB 0..1."""
    h, w = rgb.shape[:2]
    out = np.empty((h * S, w * S, 3), np.float32)
    for oy, ox, (o,) in iter_tiles([model], rgb, tile_in, single_max):
        out[oy : oy + o.shape[0], ox : ox + o.shape[1]] = o
    return out


# ---------------------------------------------------------------- grain


_NOISE_STD: float | None = None


def blurred_noise_std() -> float:
    """Std of unit gaussian noise after GaussianBlur(sigma=GRAIN_BLUR) = L2 norm of the kernel. Used instead of the
    empirical std of the whole noise field so grain can be generated band by band (difference < 0.1 %)."""
    global _NOISE_STD
    if _NOISE_STD is None:
        d = np.zeros((31, 31), np.float32)
        d[15, 15] = 1.0
        k = cv2.GaussianBlur(d, (0, 0), GRAIN_BLUR)
        _NOISE_STD = float(np.sqrt((k.astype(np.float64) ** 2).sum()))
    return _NOISE_STD


class _Noise:
    """Deterministic N(0,1) rows of a (h x w) field, generated in independently seeded blocks of NOISE_BLOCK rows."""

    def __init__(self, seed: int, h: int, w: int):
        self.seed, self.h, self.w = seed, h, w
        self._cache: dict[int, np.ndarray] = {}

    def _block(self, i: int) -> np.ndarray:
        b = self._cache.get(i)
        if b is None:
            b = np.random.default_rng([self.seed, i]).standard_normal((NOISE_BLOCK, self.w), dtype=np.float32)
            self._cache[i] = b
        return b

    def rows(self, a: int, b: int) -> np.ndarray:
        first, last = a // NOISE_BLOCK, (b - 1) // NOISE_BLOCK
        for k in [k for k in self._cache if k < first]:  # bands only move down
            del self._cache[k]
        blocks = np.concatenate([self._block(i) for i in range(first, last + 1)], axis=0)
        off = first * NOISE_BLOCK
        return blocks[a - off : b - off]


def grain_inplace(img: np.ndarray, seed: int, sigma: float = GRAIN_SIGMA) -> np.ndarray:
    """Monochrome film grain on a uint8 BGR image (modified in place and returned): gaussian noise, blurred with
    sigma 0.7, scaled to std `sigma`, weighted per pixel by clip(4*L*(1-L), 0.15, 1)*1.25 (L = luma/255, less grain
    in deep shadows/highlights), added to all channels."""
    h, w = img.shape[:2]
    noise = _Noise(seed, h, w)
    factor = sigma / blurred_noise_std()
    for y0 in range(0, h, GRAIN_BAND):
        y1 = min(h, y0 + GRAIN_BAND)
        a, b = max(0, y0 - GRAIN_MARGIN), min(h, y1 + GRAIN_MARGIN)
        # band edges inside the image have GRAIN_MARGIN real rows of context -> identical to a full-image blur
        n = cv2.GaussianBlur(noise.rows(a, b), (0, 0), GRAIN_BLUR)[y0 - a : y1 - a]
        band = img[y0:y1]
        L = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY).astype(np.float32) * (1.0 / 255.0)
        n *= np.clip(4.0 * L * (1.0 - L), 0.15, 1.0) * (1.25 * factor)
        band[:] = np.clip(band.astype(np.float32) + n[:, :, None] + 0.5, 0, 255).astype(np.uint8)
    return img


# ---------------------------------------------------------------- faces


@dataclass(frozen=True)
class FacePlan:
    box: tuple[int, int, int, int]  # x1, y1, x2, y2 square box (clipped), input px
    region: tuple[int, int, int, int]  # box + CTX real context (clipped)
    enhance: bool  # False: too big for the face model on this device (big-face rule)

    @property
    def region_area(self) -> int:
        return (self.region[2] - self.region[0]) * (self.region[3] - self.region[1])


def plan_faces(faces: list, W: int, H: int, big_face_px: float | None) -> list[FacePlan]:
    """Square box centred on each face (side = 1.7 * max(w, h), clipped) + 16 px context. Faces smaller than 24x24
    are ignored. With big_face_px set (CPU), a face whose region area exceeds it is not enhanced."""
    plans = []
    for f in faces:
        if f.area < FACE_MIN_AREA:
            continue
        x1, y1, x2, y2 = (float(v) for v in f.box[:4])
        cx, cy, side = (x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1) * FACE_EXPAND
        bx, by = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
        bx2, by2 = int(min(W, cx + side / 2)), int(min(H, cy + side / 2))
        if bx2 - bx < 2 or by2 - by < 2:
            continue
        region = (max(0, bx - CTX), max(0, by - CTX), min(W, bx2 + CTX), min(H, by2 + CTX))
        p = FacePlan((bx, by, bx2, by2), region, True)
        if big_face_px is not None and p.region_area > big_face_px:
            p = FacePlan(p.box, region, False)
        plans.append(p)
    return plans


def face_mask(h: int, w: int) -> np.ndarray:
    """Elliptical paste mask for a face box at output size (semi-axes 0.40 w / 0.44 h), gaussian-feathered with
    sigma 0.06 * max(h, w). h x w x 1 float32."""
    m = np.zeros((h, w), np.float32)
    cv2.ellipse(m, (w // 2, h // 2), (int(w * 0.40), int(h * 0.44)), 0, 0, 360, 1.0, -1)
    return cv2.GaussianBlur(m, (0, 0), max(h, w) * 0.06)[:, :, None]


def paste_face(base: np.ndarray, patch: np.ndarray, box: tuple[int, int, int, int]) -> None:
    """Blends patch (float BGR 0..255, box size at x4) into the uint8 base in place."""
    X, Y, X2, Y2 = (v * S for v in box)
    m = face_mask(Y2 - Y, X2 - X)
    region = base[Y:Y2, X:X2].astype(np.float32)
    base[Y:Y2, X:X2] = np.clip(m * patch + (1.0 - m) * region + 0.5, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- upscaler


class Upscaler:
    """Holds the 3 upscaler models (created by `factory`, lazily re-created after `release()`) and runs a pipeline.
    `factory()` returns {"clear", "span", "nomos"} -> Model. On CUDA the natural mode is P5, on CPU P4."""

    def __init__(self, factory: Callable[[], dict[str, Model]], detector, device: str, big_face_mp: float = 0.15, eager: bool = True):
        self.factory = factory
        self.detector = detector
        self.device = device
        self.tile_in = 512 if device == "cuda" else 256
        self.single_max = 512 if device == "cuda" else 640
        self.big_face_px = None if device == "cuda" else big_face_mp * 1e6
        self._models: dict[str, Model] | None = None
        self._lock = threading.Lock()
        if eager:
            self.models()

    @property
    def pipelines(self) -> dict[str, str]:
        return {"natural": "P5" if self.device == "cuda" else "P4", "sharp": "P1"}

    def models(self) -> dict[str, Model]:
        with self._lock:
            if self._models is None:
                t0 = time.monotonic()
                self._models = self.factory()
                log.info("upscaler sessions created", extra={"device": self.device, "ms": int((time.monotonic() - t0) * 1000)})
            return self._models

    def release(self) -> None:
        """Drops the sessions (frees GPU memory); the next job re-creates them."""
        with self._lock:
            if self._models is not None:
                self._models = None
                log.info("upscaler sessions released", extra={"device": self.device})

    @property
    def loaded(self) -> bool:
        return self._models is not None

    def upscale(self, bgr: np.ndarray, scale: int, mode: str, seed: int) -> tuple[np.ndarray, dict]:
        """bgr uint8 -> (uint8 BGR at scale x, info {pipeline, faces, faces_enhanced, timings_ms})."""
        pipeline = self.pipelines[mode]
        timings: dict[str, int] = {}
        models = self.models()
        H, W = bgr.shape[:2]
        rgb = bgr[:, :, ::-1].astype(np.float32) * (1.0 / 255.0)
        weighted = [(models[k], wt) for k, wt in WEIGHTS[pipeline]]
        faces = enhanced = 0

        if pipeline == "P4":
            t = time.perf_counter()
            plans = plan_faces(self.detector.detect(bgr, FACE_DET_THRESH), W, H, self.big_face_px)
            faces = len(plans)
            todo = [p for p in plans if p.enhance]
            crops = {i: np.empty(((p.box[3] - p.box[1]) * S, (p.box[2] - p.box[0]) * S, 3), np.uint8) for i, p in enumerate(todo)}
            timings["faces"] = _ms(t)

            def capture(oy: int, ox: int, outs: list[np.ndarray]) -> None:  # clear_reality output of the face boxes
                cr = outs[0]
                th, tw = cr.shape[:2]
                for i, p in enumerate(todo):
                    X, Y, X2, Y2 = (v * S for v in p.box)
                    ix1, iy1, ix2, iy2 = max(X, ox), max(Y, oy), min(X2, ox + tw), min(Y2, oy + th)
                    if ix2 > ix1 and iy2 > iy1:
                        crops[i][iy1 - Y : iy2 - Y, ix1 - X : ix2 - X] = to_u8(cr[iy1 - oy : iy2 - oy, ix1 - ox : ix2 - ox])[:, :, ::-1]

            t = time.perf_counter()
            out = blend_tiled(weighted, rgb, self.tile_in, self.single_max, capture if todo else None)
            timings["base"] = _ms(t)

            t = time.perf_counter()
            for i, p in enumerate(todo):
                bx, by, bx2, by2 = p.box
                rx, ry, rx2, ry2 = p.region
                no = run_region(models["nomos"], rgb[ry:ry2, rx:rx2], self.tile_in, self.single_max)
                no = no[(by - ry) * S : (by2 - ry) * S, (bx - rx) * S : (bx2 - rx) * S, ::-1]
                patch = np.clip(no, 0, 1) * (255.0 * FACE_NOMOS_WEIGHT) + crops[i].astype(np.float32) * (1 - FACE_NOMOS_WEIGHT)
                paste_face(out, patch, p.box)
            enhanced = len(todo)
            timings["faces"] += _ms(t)
        else:
            t = time.perf_counter()
            out = blend_tiled(weighted, rgb, self.tile_in, self.single_max)
            timings["base"] = _ms(t)
        del rgb

        if scale == 2:
            t = time.perf_counter()
            out = cv2.resize(out, (W * 2, H * 2), interpolation=cv2.INTER_AREA)
            timings["resize"] = _ms(t)
        t = time.perf_counter()
        grain_inplace(out, seed)
        timings["grain"] = _ms(t)
        return out, {"pipeline": pipeline, "faces": faces, "faces_enhanced": enhanced, "timings_ms": timings}


def _ms(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


# ---------------------------------------------------------------- onnxruntime


class OrtModel:
    def __init__(self, path: Path, device: str, threads: int):
        from .engine import _session

        providers = (
            [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}), "CPUExecutionProvider"]
            if device == "cuda"
            else ["CPUExecutionProvider"]
        )
        self.sess = _session(path, threads, providers)
        if device == "cuda" and self.sess.get_providers()[0] != "CUDAExecutionProvider":
            raise RuntimeError(f"CUDA execution provider not active for {path.name}")
        self.input_name = self.sess.get_inputs()[0].name

    def __call__(self, x: np.ndarray) -> np.ndarray:
        return self.sess.run(None, {self.input_name: x})[0]


def ort_factory(paths: dict[str, Path], device: str, threads: int) -> Callable[[], dict[str, Model]]:
    def make() -> dict[str, Model]:
        return {
            "clear": OrtModel(paths["upscale_clear"], device, threads),
            "span": OrtModel(paths["upscale_span"], device, threads),
            "nomos": OrtModel(paths["upscale_nomos"], device, threads),
        }

    return make


def prepare_device(device: str) -> None:
    """For CUDA: load the CUDA/cuDNN libraries of the nvidia pip packages and check the provider exists."""
    if device != "cuda":
        return
    import onnxruntime as ort

    if hasattr(ort, "preload_dlls"):
        ort.preload_dlls()
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("UPSCALE_DEVICE=cuda but onnxruntime has no CUDAExecutionProvider (install onnxruntime-gpu)")


def self_test(up: Upscaler) -> None:
    """One tiny pass through every model (CPU: warm-up; CUDA: verifies cuDNN works on this driver)."""
    t0 = time.monotonic()
    x = np.full((1, 3, 32, 32), 0.5, np.float32)
    for name, m in up.models().items():
        y = m(x)
        if y.shape != (1, 3, 32 * S, 32 * S):
            raise RuntimeError(f"upscaler {name}: unexpected output shape {y.shape}")
    log.info("upscaler self-test done", extra={"device": up.device, "ms": int((time.monotonic() - t0) * 1000)})


def encode_jpeg(bgr: np.ndarray, quality: int) -> bytes:
    """JPEG with 4:4:4 chroma straight from the BGR buffer (no RGB / PIL copies of a 67 MP image). Huffman
    optimisation is off on purpose: libjpeg would buffer every DCT coefficient of the image (~400 MB at 67 MP)."""
    ok, buf = cv2.imencode(
        ".jpg",
        bgr,
        [cv2.IMWRITE_JPEG_QUALITY, int(quality), cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444],
    )
    if not ok:
        raise RuntimeError("jpeg encoding failed")
    return buf.tobytes()
