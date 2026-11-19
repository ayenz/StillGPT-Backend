"""FastAPI app: /health/ready, /v1/swap, /v1/face-crop, /v1/face-paste (see faceswap/README.md)."""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import imaging
from .engine import estimate_alignment, pick_face
from .logs import setup_logging

VERSION = "1.1.0"
log = logging.getLogger("faceswap")


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "") or default))
    except ValueError:
        return default


WORKERS = _int_env("FACESWAP_WORKERS", 2)
ORT_THREADS = _int_env("FACESWAP_ORT_THREADS", max(1, (os.cpu_count() or 4) // WORKERS))
MODEL_DIR = os.environ.get("FACESWAP_MODEL_DIR", "/models")


class State:
    engine = None  # type: ignore[assignment]
    error: str | None = None
    loading = False
    executor: ThreadPoolExecutor | None = None


state = State()


def _load_models() -> None:
    from .engine import Engine
    from .models import ensure_models

    state.loading = True
    try:
        paths = ensure_models(MODEL_DIR)
        state.engine = Engine(paths, ORT_THREADS)
        state.error = None
    except Exception as e:  # noqa: BLE001
        state.error = str(e)
        log.exception("model loading failed")
    finally:
        state.loading = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    state.executor = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="infer")
    if os.environ.get("FACESWAP_SKIP_MODELS") != "1":
        threading.Thread(target=_load_models, name="model-loader", daemon=True).start()
    log.info("starting", extra={"version": VERSION, "workers": WORKERS, "ort_threads": ORT_THREADS, "model_dir": MODEL_DIR})
    yield
    state.executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="stillgpt-faceswap", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None)


# ---------------------------------------------------------------- errors / auth


@app.exception_handler(imaging.ImageError)
async def _image_error(_: Request, exc: imaging.ImageError):
    return JSONResponse({"detail": exc.code}, status_code=exc.status)


class PatchMisaligned(Exception):
    """The edited patch does not line up with the face in the base crop (422 PATCH_MISALIGNED)."""

    def __init__(self, reason: str, alignment: dict | None = None):
        super().__init__(reason)
        self.reason = reason
        self.alignment = alignment


@app.exception_handler(PatchMisaligned)
async def _patch_misaligned(_: Request, exc: PatchMisaligned):
    return JSONResponse({"detail": "PATCH_MISALIGNED", "reason": exc.reason, "alignment": exc.alignment}, status_code=422)


@app.exception_handler(RequestValidationError)
async def _validation_error(_: Request, exc: RequestValidationError):
    errors = [{"loc": list(e.get("loc", [])), "msg": e.get("msg", "")} for e in exc.errors()]
    return JSONResponse({"detail": "INVALID_REQUEST", "errors": errors}, status_code=422)


def require_key(x_api_key: Annotated[str | None, Header()] = None) -> None:
    expected = os.environ.get("FACESWAP_API_KEY", "")
    if not expected:
        return
    if not x_api_key or not hmac.compare_digest(x_api_key.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="AUTH_INVALID")


def engine():
    if state.engine is None:
        raise HTTPException(status_code=503, detail="MODELS_LOADING" if state.error is None else "MODELS_FAILED")
    return state.engine


async def run_cpu(fn, *args):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(state.executor, fn, *args)


# ---------------------------------------------------------------- schemas


class SwapOptions(BaseModel):
    model_config = ConfigDict(extra="ignore")
    target_faces: Literal["largest", "all"] = "largest"
    identity_mode: Literal["average", "frontal"] = "average"
    det_thresh: float = Field(0.5, ge=0.1, le=0.95)
    restorer: Literal["codeformer", "gfpgan", "off"] = "codeformer"
    restore_blend: float = Field(0.8, ge=0.0, le=1.0)
    codeformer_fidelity: float = Field(0.7, ge=0.0, le=1.0)
    output_format: Literal["png", "jpeg"] = "jpeg"
    jpeg_quality: int = Field(95, ge=50, le=100)


class SwapRequest(BaseModel):
    target: str = Field(min_length=1)
    sources: list[str] = Field(min_length=1, max_length=9)
    options: SwapOptions = Field(default_factory=SwapOptions)


class CropRequest(BaseModel):
    image: str = Field(min_length=1)
    det_thresh: float = Field(0.5, ge=0.1, le=0.95)
    expand: float = Field(2.2, ge=1.0, le=6.0)
    size: int = Field(1024, ge=64, le=2048)


class PasteRequest(BaseModel):
    base: str = Field(min_length=1)
    patch: str = Field(min_length=1)
    box: list[int] = Field(min_length=4, max_length=4)
    feather: float = Field(0.15, ge=0.0, le=1.0)
    color_match: bool = True
    mask: Literal["face", "box"] = "face"
    max_scale_dev: float = Field(0.18, ge=0.0, le=1.0)
    max_rotation_deg: float = Field(12.0, ge=0.0, le=180.0)
    max_shift: float = Field(0.12, ge=0.0, le=1.0)
    output_format: Literal["png", "jpeg"] = "jpeg"
    jpeg_quality: int = Field(95, ge=50, le=100)


# ---------------------------------------------------------------- handlers (sync, run in the pool)


def _ms(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


def do_swap(eng, req: SwapRequest) -> dict:
    o = req.options
    timings: dict[str, int] = {}
    t_all = t = time.perf_counter()
    target = imaging.decode_image(req.target)
    sources = [imaging.decode_image(s) for s in req.sources]
    timings["decode"] = _ms(t)

    t = time.perf_counter()
    faces = eng.detector.detect(target.bgr, o.det_thresh)
    timings["detect"] = _ms(t)
    if not faces:
        raise imaging.ImageError("NO_FACE_IN_TARGET")
    if o.target_faces == "largest":
        faces = [max(faces, key=lambda f: f.area)]

    t = time.perf_counter()
    emb, used = eng.identity(sources, o.identity_mode, o.det_thresh)
    latent = eng.swapper.latent(emb)
    timings["identity"] = _ms(t)

    t = time.perf_counter()
    img = target.bgr
    for f in faces:
        img = eng.swapper.swap(img, f, latent)
    timings["swap"] = _ms(t)

    if o.restorer != "off" and o.restore_blend > 0:
        t = time.perf_counter()
        r = eng.restorers[o.restorer]
        for f in faces:
            img = r.restore(img, f, o.restore_blend, o.codeformer_fidelity)
        timings["restore"] = _ms(t)

    t = time.perf_counter()
    b64, mime = imaging.encode_image(img, o.output_format, o.jpeg_quality, target.alpha)
    timings["encode"] = _ms(t)
    timings["total"] = _ms(t_all)
    log.info("swap", extra={"faces": len(faces), "source_faces": used, "restorer": o.restorer, "timings_ms": timings})
    return {
        "image": b64,
        "mime_type": mime,
        "width": int(img.shape[1]),
        "height": int(img.shape[0]),
        "target_faces": len(faces),
        "source_faces": used,
        "timings_ms": timings,
    }


def do_crop(eng, req: CropRequest) -> dict:
    t0 = time.perf_counter()
    img = imaging.decode_image(req.image)
    faces = eng.detector.detect(img.bgr, req.det_thresh)
    if not faces:
        raise imaging.ImageError("NO_FACE_IN_TARGET")
    face = max(faces, key=lambda f: f.area)
    box = imaging.square_box(face.box, req.expand)
    crop = imaging.resize_to(imaging.crop_padded(img.bgr, box), req.size, req.size)
    b64, _ = imaging.encode_image(crop, "png")
    log.info("face-crop", extra={"faces": len(faces), "box": box, "ms": _ms(t0)})
    return {"crop": b64, "box": box, "faces": len(faces), "width": int(img.bgr.shape[1]), "height": int(img.bgr.shape[0])}


PASTE_DET_THRESH = 0.5


def _detect_main(eng, img: np.ndarray, fallback_thresh: float | None = None):
    h, w = img.shape[:2]
    face = pick_face(eng.detector.detect(img, PASTE_DET_THRESH), w, h)
    if face is None and fallback_thresh is not None:  # the base crop came from a detection: be lenient there
        face = pick_face(eng.detector.detect(img, fallback_thresh), w, h)
    return face


def do_paste(eng, req: PasteRequest) -> dict:
    """Landmark-aligned paste: the patch face is matched to the face in the base crop with a similarity transform
    (rejected when it is too far off), warped onto it and blended with a feathered face-hull mask."""
    t0 = time.perf_counter()
    base = imaging.decode_image(req.base)
    patch = imaging.decode_image(req.patch)
    x, y, w, h = req.box
    H, W = base.bgr.shape[:2]
    if w < 8 or h < 8 or w > 4 * max(W, H) or h > 4 * max(W, H):
        raise HTTPException(status_code=422, detail="BAD_BOX")
    ix1, iy1, ix2, iy2, ox, oy = imaging.clip_box(req.box, W, H)
    if ix2 <= ix1 or iy2 <= iy1:
        raise HTTPException(status_code=422, detail="BAD_BOX")

    # 1. the original crop and the patch at a working resolution (the output only needs box resolution);
    #    the patch face is detected on the full patch for precise landmarks
    P = patch.bgr
    ph, pw = P.shape[:2]
    f = min(1.0, max(256.0, float(max(w, h))) / float(max(pw, ph)))
    ww, wh = max(8, int(round(pw * f))), max(8, int(round(ph * f)))
    side = float(max(ww, wh))
    ref = imaging.resize_to(imaging.crop_padded(base.bgr, req.box), ww, wh)
    f_ref = _detect_main(eng, ref, 0.2)
    if f_ref is None:
        raise imaging.ImageError("NO_FACE_IN_TARGET")
    f_p = _detect_main(eng, P)
    if f_p is None:
        raise PatchMisaligned("no_face_in_patch")
    p_kps, p_box = f_p.kps * f, f_p.box[:4] * f

    # 2. similarity transform patch -> original crop, with limits
    al = estimate_alignment(p_kps, f_ref.kps, side)
    info = al.as_dict()
    lo, hi = 1.0 / (1.0 + req.max_scale_dev), 1.0 + req.max_scale_dev
    if not lo <= al.scale <= hi:
        reason = "scale"
    elif abs(al.rotation_deg) > req.max_rotation_deg:
        reason = "rotation"
    elif al.shift > req.max_shift:
        reason = "shift"
    else:
        reason = None
    if reason:
        log.info("face-paste misaligned", extra={"reason": reason, "alignment": info, "box": req.box})
        raise PatchMisaligned(reason, info)

    # 3. warp the patch onto the original face (downscale first, then a near-identity warp)
    warped = cv2.warpAffine(
        imaging.resize_to(P, ww, wh), al.M, (ww, wh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101
    )
    kps_t = p_kps @ al.M[:, :2].T + al.M[:, 2]
    bx1, by1, bx2, by2 = (float(v) for v in p_box)
    corners = np.array([[bx1, by1], [bx2, by1], [bx1, by2], [bx2, by2]], np.float32) @ al.M[:, :2].T + al.M[:, 2]
    box_t = np.array([corners[:, 0].min(), corners[:, 1].min(), corners[:, 0].max(), corners[:, 1].max()], np.float32)

    rx1, ry1, rx2, ry2 = (float(v) for v in f_ref.box[:4])
    face_size = max(rx2 - rx1, ry2 - ry1)
    sigma = max(1.0, req.feather * 0.66 * face_size)
    # faces of both images (they now overlap): the new features fully in, the old ones fully covered
    pts = np.vstack([imaging.face_hull_points(f_ref.box, f_ref.kps), imaging.face_hull_points(box_t, kps_t)])
    core = imaging.hull_mask(wh, ww, imaging.face_hull_points(f_ref.box, f_ref.kps, forehead=0.0), 0.0, 0.0)
    if req.mask == "face":
        mask = imaging.hull_mask(wh, ww, pts, 0.04 * face_size, sigma)
    else:
        mask = imaging.resize_to(imaging.box_mask(int(side), pad=0.06, blur=max(0.01, req.feather * 0.3)), ww, wh)

    if req.color_match:
        warped = imaging.color_match_lab(warped, ref, core)
    warped = imaging.harmonize_edges(warped, ref, mask, 0.5 * sigma)

    # 4. back to the box at base resolution; base pixels outside the mask stay untouched
    top = imaging.resize_to(warped, w, h)
    m = np.clip(cv2.resize(mask, (w, h), interpolation=cv2.INTER_AREA if w < ww else cv2.INTER_LINEAR), 0.0, 1.0)
    out = base.bgr.copy()
    sl = (slice(oy, oy + (iy2 - iy1)), slice(ox, ox + (ix2 - ix1)))
    out[iy1:iy2, ix1:ix2] = imaging.blend(out[iy1:iy2, ix1:ix2], top[sl], m[sl])
    b64, mime = imaging.encode_image(out, req.output_format, req.jpeg_quality, base.alpha)
    log.info("face-paste", extra={"alignment": info, "mask": req.mask, "box": req.box, "ms": _ms(t0)})
    return {"image": b64, "mime_type": mime, "width": W, "height": H, "alignment": info}


# ---------------------------------------------------------------- routes


@app.get("/health/ready")
async def ready():
    if state.engine is None:
        return JSONResponse(
            {"ready": False, "loading": state.loading, "error": state.error, "version": VERSION}, status_code=503
        )
    return {
        "ready": True,
        "models": {"detector": "scrfd_10g", "recognizer": "arcface_w600k_r50", "swapper": "inswapper_128", "restorers": ["codeformer", "gfpgan"]},
        "version": VERSION,
        "workers": WORKERS,
    }


@app.get("/health/live")
async def live():
    return {"ok": True}


@app.post("/v1/swap", dependencies=[Depends(require_key)])
async def swap(req: SwapRequest):
    return await run_cpu(do_swap, engine(), req)


@app.post("/v1/face-crop", dependencies=[Depends(require_key)])
async def face_crop(req: CropRequest):
    return await run_cpu(do_crop, engine(), req)


@app.post("/v1/face-paste", dependencies=[Depends(require_key)])
async def face_paste(req: PasteRequest):
    return await run_cpu(do_paste, engine(), req)


def _cv_threads() -> None:
    cv2.setNumThreads(max(1, ORT_THREADS))


_cv_threads()
