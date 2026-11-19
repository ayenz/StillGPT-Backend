"""Face detection (SCRFD), identity (ArcFace), swapping (inswapper_128) and restoration (CodeFormer / GFPGAN)
on onnxruntime CPU. Own minimal implementation of the insightface reference algorithms, so we do not need the
insightface package (and its cython build) on arm64."""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

from . import imaging

log = logging.getLogger("faceswap.engine")

# 5-point ArcFace template for a 112x112 crop (left eye, right eye, nose, left mouth, right mouth).
ARCFACE_112 = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
    dtype=np.float32,
)
# FFHQ alignment template used by GFPGAN / CodeFormer for a 512x512 crop.
FFHQ_512 = np.array(
    [[192.98138, 239.94708], [318.90277, 240.1936], [256.63416, 314.01935], [201.26117, 371.41043], [313.08905, 371.15118]],
    dtype=np.float32,
)


def arcface_template(size: int) -> np.ndarray:
    """insightface face_align.estimate_norm: 112-multiples scale; others (128) scale by size/128 with an 8px x-shift."""
    if size % 112 == 0:
        ratio, dx = size / 112.0, 0.0
    else:
        ratio, dx = size / 128.0, 8.0 * size / 128.0
    t = ARCFACE_112 * ratio
    t[:, 0] += dx
    return t


def umeyama(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Similarity transform (rotation + uniform scale + translation) mapping src -> dst, 2x3."""
    src = src.astype(np.float64)
    dst = dst.astype(np.float64)
    n = src.shape[0]
    mu_s, mu_d = src.mean(0), dst.mean(0)
    sc, dc = src - mu_s, dst - mu_d
    cov = dc.T @ sc / n
    U, S, Vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(cov) < 0:
        d[1] = -1
    R = U @ np.diag(d) @ Vt
    var_s = (sc**2).sum() / n
    scale = (S * d).sum() / var_s
    t = mu_d - scale * R @ mu_s
    M = np.zeros((2, 3), np.float64)
    M[:, :2] = scale * R
    M[:, 2] = t
    return M.astype(np.float32)


@dataclass
class Alignment:
    """Similarity transform patch -> reference crop estimated from the 5 landmarks."""

    M: np.ndarray  # 2x3
    scale: float  # > 1: the patch face is smaller than the reference face
    rotation_deg: float
    shift: float  # distance between the two face centres / crop side
    residual: float  # RMS landmark error after the transform / face size

    def as_dict(self) -> dict:
        return {
            "scale": round(self.scale, 4),
            "rotation_deg": round(self.rotation_deg, 2),
            "shift": round(self.shift, 4),
            "residual": round(self.residual, 4),
        }


def estimate_alignment(src_kps: np.ndarray, dst_kps: np.ndarray, side: float) -> Alignment:
    """umeyama src -> dst plus the human-readable deviation from the identity transform."""
    M = umeyama(src_kps, dst_kps)
    a, b = float(M[0, 0]), float(M[1, 0])
    scale = float(np.hypot(a, b))
    rotation = float(np.degrees(np.arctan2(b, a)))
    shift = float(np.linalg.norm(src_kps.mean(0) - dst_kps.mean(0)) / max(1.0, side))
    mapped = src_kps @ M[:, :2].T + M[:, 2]
    rms = float(np.sqrt(((mapped - dst_kps) ** 2).sum(1).mean()))
    face_size = float(np.linalg.norm(dst_kps[0] - dst_kps[1]) + np.linalg.norm(dst_kps[:2].mean(0) - dst_kps[3:].mean(0)))
    return Alignment(M=M, scale=scale, rotation_deg=rotation, shift=shift, residual=rms / max(1.0, face_size))


def pick_face(faces: list["Face"], w: int, h: int) -> "Face | None":
    """The main face of a close-up: large and near the centre."""
    if not faces:
        return None
    cx, cy = w / 2.0, h / 2.0

    def key(f: "Face") -> float:
        fx, fy = (f.box[0] + f.box[2]) / 2.0, (f.box[1] + f.box[3]) / 2.0
        return f.area / (1.0 + np.hypot(fx - cx, fy - cy) / max(w, h))

    return max(faces, key=key)


def nms(dets: np.ndarray, thresh: float) -> list[int]:
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        ovr = w * h / (areas[i] + areas[order[1:]] - w * h)
        order = order[np.where(ovr <= thresh)[0] + 1]
    return keep


def frontalness(kps: np.ndarray) -> float:
    """1.0 = looking straight at the camera, -> 0 for profiles. Uses yaw symmetry (nose between the eyes) and
    a mild pitch term (nose between eyes and mouth)."""
    le, re, nose, lm, rm = kps
    dl = nose[0] - le[0]
    dr = re[0] - nose[0]
    if dl <= 0 or dr <= 0:
        return 0.0
    yaw = min(dl, dr) / max(dl, dr)
    eye_y = (le[1] + re[1]) / 2.0
    mouth_y = (lm[1] + rm[1]) / 2.0
    span = mouth_y - eye_y
    if span <= 0:
        return 0.0
    # in frontal faces the nose tip sits ~55% of the way from the eye line to the mouth line
    pitch = 1.0 - min(1.0, abs((nose[1] - eye_y) / span - 0.55) / 0.45)
    return float(max(0.0, yaw) * (0.75 + 0.25 * pitch))


@dataclass
class Face:
    box: np.ndarray  # x1, y1, x2, y2
    score: float
    kps: np.ndarray  # 5 x 2

    @property
    def area(self) -> float:
        return float(max(0.0, self.box[2] - self.box[0]) * max(0.0, self.box[3] - self.box[1]))


def _session(path: Path, threads: int) -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.log_severity_level = 3
    # The BFC arena keeps the peak activation memory of every session (CodeFormer/GFPGAN: several hundred MB each)
    # resident forever; without it RSS stays much lower at a negligible speed cost. FACESWAP_ORT_ARENA=1 re-enables.
    so.enable_cpu_mem_arena = os.environ.get("FACESWAP_ORT_ARENA") == "1"
    return ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])


class Detector:
    def __init__(self, path: Path, threads: int, input_size: int = 640):
        self.sess = _session(path, threads)
        self.input_name = self.sess.get_inputs()[0].name
        self.output_names = [o.name for o in self.sess.get_outputs()]
        self.input_size = input_size
        self.strides = (8, 16, 32)
        self.num_anchors = 2
        self._centers: dict[tuple[int, int, int], np.ndarray] = {}

    def _anchor_centers(self, h: int, w: int, stride: int) -> np.ndarray:
        key = (h, w, stride)
        c = self._centers.get(key)
        if c is None:
            c = np.stack(np.mgrid[:h, :w][::-1], axis=-1).astype(np.float32)
            c = (c * stride).reshape((-1, 2))
            c = np.stack([c] * self.num_anchors, axis=1).reshape((-1, 2))
            self._centers[key] = c
        return c

    def detect(self, img: np.ndarray, thresh: float = 0.5, nms_thresh: float = 0.4) -> list[Face]:
        size = self.input_size
        h, w = img.shape[:2]
        scale = size / max(h, w)
        nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        det_img = np.zeros((size, size, 3), np.uint8)
        det_img[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        blob = cv2.dnn.blobFromImage(det_img, 1.0 / 128.0, (size, size), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.sess.run(self.output_names, {self.input_name: blob})
        fmc = len(self.strides)
        scores_l, boxes_l, kps_l = [], [], []
        for idx, stride in enumerate(self.strides):
            scores = outs[idx].reshape(-1)
            bbox = outs[idx + fmc].reshape(-1, 4) * stride
            kps = outs[idx + fmc * 2].reshape(-1, 10) * stride
            fh, fw = size // stride, size // stride
            centers = self._anchor_centers(fh, fw, stride)
            pos = np.where(scores >= thresh)[0]
            if pos.size == 0:
                continue
            c = centers[pos]
            b = bbox[pos]
            boxes_l.append(np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], -1))
            k = kps[pos].reshape(-1, 5, 2) + c[:, None, :]
            kps_l.append(k)
            scores_l.append(scores[pos])
        if not scores_l:
            return []
        scores = np.concatenate(scores_l)
        boxes = np.concatenate(boxes_l) / scale
        kpss = np.concatenate(kps_l) / scale
        dets = np.hstack([boxes, scores[:, None]]).astype(np.float32)
        keep = nms(dets, nms_thresh)
        faces = [Face(box=dets[i, :4], score=float(dets[i, 4]), kps=kpss[i].astype(np.float32)) for i in keep]
        # drop degenerate boxes
        return [f for f in faces if f.box[2] - f.box[0] >= 8 and f.box[3] - f.box[1] >= 8]


class Recognizer:
    def __init__(self, path: Path, threads: int):
        self.sess = _session(path, threads)
        self.input_name = self.sess.get_inputs()[0].name

    def embed(self, img: np.ndarray, face: Face) -> np.ndarray:
        M = umeyama(face.kps, arcface_template(112))
        crop = cv2.warpAffine(img, M, (112, 112), borderValue=0.0)
        blob = cv2.dnn.blobFromImage(crop, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        emb = self.sess.run(None, {self.input_name: blob})[0][0].astype(np.float32)
        return emb / (np.linalg.norm(emb) + 1e-8)


class Swapper:
    def __init__(self, path: Path, emap: np.ndarray, threads: int):
        self.sess = _session(path, threads)
        self.emap = emap
        self.size = 128

    def latent(self, normed_embedding: np.ndarray) -> np.ndarray:
        lat = normed_embedding.reshape(1, -1) @ self.emap
        return (lat / np.linalg.norm(lat)).astype(np.float32)

    def swap(self, img: np.ndarray, face: Face, latent: np.ndarray) -> np.ndarray:
        """Swaps one face in place on a copy of img and returns it."""
        M = umeyama(face.kps, arcface_template(self.size))
        crop = cv2.warpAffine(img, M, (self.size, self.size), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        blob = cv2.dnn.blobFromImage(crop, 1.0 / 255.0, (self.size, self.size), (0.0, 0.0, 0.0), swapRB=True)
        pred = self.sess.run(None, {"target": blob, "source": latent})[0][0]
        fake = np.clip(pred.transpose(1, 2, 0) * 255.0, 0, 255)[:, :, ::-1].astype(np.float32)
        return paste_aligned(img, fake, M, mask=swap_mask(self.size))


def swap_mask(size: int) -> np.ndarray:
    """Soft mask for the 128 swap crop: a rounded box that leaves out the crop border (where the swapper output
    is unreliable) and fades smoothly."""
    m = np.zeros((size, size), np.float32)
    # the arcface crop is tight: keep top a bit lower (forehead/fringe stay original), sides + chin generous
    x1, y1, x2, y2 = int(size * 0.07), int(size * 0.11), int(size * 0.93), int(size * 0.94)
    cv2.rectangle(m, (x1, y1), (x2, y2), 1.0, -1)
    return np.clip(imaging.feather(m, size * 0.055), 0, 1)


def paste_aligned(img: np.ndarray, crop: np.ndarray, M: np.ndarray, mask: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Warps an aligned crop (+ its mask) back into img with the inverse affine and alpha-blends it. Only the
    face's bounding region is touched (fast on large images)."""
    H, W = img.shape[:2]
    size_h, size_w = crop.shape[:2]
    IM = cv2.invertAffineTransform(M)
    corners = np.array([[0, 0, 1], [size_w, 0, 1], [0, size_h, 1], [size_w, size_h, 1]], np.float32) @ IM.T
    x1 = int(max(0, np.floor(corners[:, 0].min()) - 2))
    y1 = int(max(0, np.floor(corners[:, 1].min()) - 2))
    x2 = int(min(W, np.ceil(corners[:, 0].max()) + 2))
    y2 = int(min(H, np.ceil(corners[:, 1].max()) + 2))
    if x2 <= x1 or y2 <= y1:
        return img
    IMr = IM.copy()
    IMr[:, 2] -= (x1, y1)
    rw, rh = x2 - x1, y2 - y1
    # When the face is smaller in the image than the crop, INTER_AREA-like downscale is better: pre-blur.
    scale = float(np.sqrt(abs(np.linalg.det(IM[:, :2]))))
    src = crop
    if scale < 0.5:
        sigma = 0.5 / scale * 0.5
        src = cv2.GaussianBlur(crop, (0, 0), sigma)
    warped = cv2.warpAffine(src.astype(np.float32), IMr, (rw, rh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    wmask = cv2.warpAffine(mask.astype(np.float32), IMr, (rw, rh), flags=cv2.INTER_LINEAR, borderValue=0.0)
    out = img.copy()
    region = out[y1:y2, x1:x2]
    out[y1:y2, x1:x2] = imaging.blend(region, warped, np.clip(wmask * strength, 0, 1))
    return out


class Restorer:
    """GFPGAN 1.4 / CodeFormer on a 512 FFHQ-aligned crop; inputs/outputs in [-1, 1] RGB."""

    def __init__(self, name: str, path: Path, threads: int):
        self.name = name
        self.sess = _session(path, threads)
        self.inputs = {i.name for i in self.sess.get_inputs()}

    def restore(self, img: np.ndarray, face: Face, blend: float, fidelity: float) -> np.ndarray:
        M = umeyama(face.kps, FFHQ_512)
        crop = cv2.warpAffine(img, M, (512, 512), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101)
        x = crop[:, :, ::-1].astype(np.float32) / 255.0
        x = ((x - 0.5) / 0.5).transpose(2, 0, 1)[None]
        feeds: dict[str, np.ndarray] = {"input": np.ascontiguousarray(x)}
        if "weight" in self.inputs:
            feeds["weight"] = np.array(fidelity, dtype=np.float64)
        out = self.sess.run(None, feeds)[0][0]
        out = (np.clip(out, -1, 1) + 1) / 2
        restored = (out.transpose(1, 2, 0)[:, :, ::-1] * 255.0).astype(np.float32)
        return paste_aligned(img, restored, M, mask=restore_mask(), strength=blend)


_RESTORE_MASK: np.ndarray | None = None


def restore_mask() -> np.ndarray:
    global _RESTORE_MASK
    if _RESTORE_MASK is None:
        m = np.zeros((512, 512), np.float32)
        # FFHQ crop: face roughly x 130..380, y 150..450. Keep hair/background out, feather well.
        cv2.ellipse(m, (256, 290), (150, 190), 0, 0, 360, 1.0, -1, cv2.LINE_AA)
        _RESTORE_MASK = np.clip(imaging.feather(m, 22), 0, 1)
    return _RESTORE_MASK


def load_emap(swapper_path: Path) -> np.ndarray:
    """inswapper's latent projection matrix is the graph's last initializer. Extract it once (needs the onnx
    package) and cache it next to the model as .npy."""
    cache = swapper_path.with_name(swapper_path.name + ".emap.npy")
    if cache.is_file():
        try:
            e = np.load(cache)
            if e.shape == (512, 512):
                return e.astype(np.float32)
        except Exception:  # noqa: BLE001
            pass
    import onnx  # local import: only needed on first start
    from onnx import numpy_helper

    model = onnx.load(str(swapper_path))
    emap = numpy_helper.to_array(model.graph.initializer[-1]).astype(np.float32)
    del model
    if emap.shape != (512, 512):
        raise RuntimeError(f"unexpected inswapper emap shape {emap.shape}")
    tmp = cache.with_name(f".{cache.name}.tmp.npy")
    np.save(tmp, emap)
    os.replace(tmp, cache)
    return emap


class Engine:
    def __init__(self, paths: dict[str, Path], threads: int):
        t0 = time.monotonic()
        self.detector = Detector(paths["detector"], threads)
        self.recognizer = Recognizer(paths["recognizer"], threads)
        self.swapper = Swapper(paths["swapper"], load_emap(paths["swapper"]), threads)
        self.restorers = {
            "codeformer": Restorer("codeformer", paths["codeformer"], threads),
            "gfpgan": Restorer("gfpgan", paths["gfpgan"], threads),
        }
        self._id_cache: OrderedDict[str, tuple[np.ndarray, int]] = OrderedDict()
        self._id_lock = threading.Lock()
        log.info("models loaded", extra={"ms": int((time.monotonic() - t0) * 1000), "threads": threads})
        self.warmup()

    def warmup(self) -> None:
        """One dummy pass through every model so the first real request does not pay onnxruntime's first-run cost."""
        t0 = time.monotonic()
        img = np.full((256, 256, 3), 128, np.uint8)
        self.detector.detect(img, 0.5)
        face = Face(box=np.array([64, 64, 192, 192], np.float32), score=1.0, kps=arcface_template(112) + 72)
        emb = self.recognizer.embed(img, face)
        img = self.swapper.swap(img, face, self.swapper.latent(emb))
        for r in self.restorers.values():
            r.restore(img, face, 0.5, 0.7)
        log.info("warmup done", extra={"ms": int((time.monotonic() - t0) * 1000)})

    # ---- identity

    def identity(self, sources: list[imaging.Decoded], mode: str, det_thresh: float) -> tuple[np.ndarray, int]:
        h = hashlib.sha256()
        for s in sources:
            h.update(hashlib.sha256(s.raw).digest())
        key = f"{h.hexdigest()}:{mode}:{det_thresh:.3f}"
        with self._id_lock:
            hit = self._id_cache.get(key)
            if hit is not None:
                self._id_cache.move_to_end(key)
                return hit
        cands: list[tuple[np.ndarray, float, float]] = []  # embedding, score, frontalness
        for s in sources:
            for f in self.detector.detect(s.bgr, det_thresh):
                cands.append((self.recognizer.embed(s.bgr, f), f.score, frontalness(f.kps)))
        if not cands:
            raise imaging.ImageError("NO_FACE_IN_SOURCE")
        if mode == "frontal":
            best = max(cands, key=lambda c: (c[2], c[1]))
            emb, used = best[0], 1
        else:
            w = np.array([c[1] * max(0.05, c[2]) for c in cands], np.float32)
            embs = np.stack([c[0] for c in cands])
            emb = (embs * w[:, None]).sum(0)
            emb = emb / (np.linalg.norm(emb) + 1e-8)
            used = len(cands)
        result = (emb.astype(np.float32), used)
        with self._id_lock:
            self._id_cache[key] = result
            while len(self._id_cache) > 64:
                self._id_cache.popitem(last=False)
        return result
