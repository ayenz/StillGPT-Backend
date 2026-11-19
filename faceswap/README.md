# faceswap sidecar

Internal HTTP service for StillGPT's face swap (engine `swapper`, plus `face-crop`/`face-paste` for `qoder_crop`).
Python 3.12 + FastAPI + onnxruntime (CPU). Own minimal implementation of the insightface pipeline (SCRFD detection,
ArcFace identity, inswapper_128 with the model's `emap` latent projection, arcface-template alignment and inverse-affine
paste with a soft mask), so the `insightface` package and its cython build are not needed. Restoration with CodeFormer
or GFPGAN 1.4 on a 512 FFHQ-aligned crop, blended by `restore_blend`.

## Models

Downloaded on first start into `/models` (compose volume `faceswap_models` → `stillgpt_faceswap_models`),
streamed to a temp file, sha256-checked, then atomically renamed. Total ≈ 1.46 GB. Verified files get a
`.verified` marker so restarts do not re-hash; the inswapper `emap` is cached as `inswapper_128.onnx.emap.npy`.

| key | file | sha256 |
|---|---|---|
| detector (SCRFD 10G = buffalo_l `det_10g`) | retinaface_10g.onnx (16.9 MB) | 808399c3d0b40ed340634ed590ae564a7caa09e5659916923a95d4470b54ff5a |
| recognizer (buffalo_l `w600k_r50`) | arcface_w600k_r50.onnx (174 MB) | f1f79dc3b0b79a69f94799af1fffebff09fbd78fd96a275fd8f0cbbea23270d1 |
| swapper | inswapper_128.onnx (555 MB) | a290273ed497312095dac48cdef20feec9d5208298223dd01288ab202b54bea7 |
| restorer | codeformer.onnx (377 MB) | 21710e7ab61c82683576c428e9c1b6fe1ed419586b7b39e394c3449c294b550f |
| restorer | gfpgan_1.4.onnx (340 MB) | accc4757b26bdb89b32b4d3500d4f79c9dff97c1dd7c7104bf9dcb95e3311385 |

Source: `https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/<file>`.

**Licences:** `inswapper_128` (InsightFace) is released for **non-commercial research use only**; the buffalo_l
models are likewise non-commercial. CodeFormer is under the S-Lab License 1.0 (non-commercial). GFPGAN is Apache-2.0.
Check this before offering the swapper engine commercially.

## Environment

| var | default | |
|---|---|---|
| `FACESWAP_API_KEY` | empty | required `X-API-Key` header value; empty disables auth |
| `FACESWAP_WORKERS` | 2 | parallel inference jobs (thread pool); further requests queue |
| `FACESWAP_ORT_THREADS` | cpu_count / workers | onnxruntime intra-op threads per session run |
| `FACESWAP_ORT_ARENA` | 0 | 1 = keep onnxruntime's CPU memory arena (≈ +2.4 GB RSS, no measurable speed gain) |
| `FACESWAP_MODEL_DIR` | `/models` | |
| `PORT` / `HOST` | 8080 / 0.0.0.0 | |

On the 4-core prod host use `FACESWAP_WORKERS=2`, `FACESWAP_ORT_THREADS=2` (compose defaults).

## Endpoints

All images are base64 (no `data:` prefix) in JSON; errors are `{"detail": "<CODE>"}`.
Limits: 25 MB decoded / 40 MP per image (413 `TOO_LARGE`). EXIF orientation is applied on input; output keeps the
target's (oriented) pixel size. PNG alpha of the target is preserved for PNG output.

- `GET /health/ready` → 200 `{ready, models: {detector, recognizer, swapper, restorers}, version, workers}`;
  503 `{ready:false, loading, error}` while downloading/loading. `GET /health/live` is always 200.
- `POST /v1/swap` `{target, sources[1..9], options?}` → `{image, mime_type, width, height, target_faces, source_faces, timings_ms}`.
  Options: `target_faces` largest|all, `identity_mode` average|frontal, `det_thresh` 0.1–0.95 (0.5),
  `restorer` codeformer|gfpgan|off, `restore_blend` 0–1 (0.8), `codeformer_fidelity` 0–1 (0.7),
  `output_format` jpeg|png, `jpeg_quality` 50–100 (95). Identity = weighted average (det score × frontalness) of
  normalized ArcFace embeddings of every face in every source (a 3×3 sheet yields 9), cached by source hash.
- `POST /v1/face-crop` `{image, det_thresh?, expand? (2.2), size? (1024)}` → `{crop (png), box: [x,y,side,side], faces, width, height}`.
  Box is centred on the largest face, may extend past the image (edge-reflect padding).
- `POST /v1/face-paste` `{base, patch, box, feather? (0.15), color_match? (true), output_format?, jpeg_quality?}` →
  `{image, mime_type, width, height}`. Patch is resized to the box, LAB mean/std colour-matched to the base inside the
  face mask (face detected on the patch, ellipse fallback), feathered and blended.

Error codes: 401 `AUTH_INVALID`, 413 `TOO_LARGE`, 422 `BAD_IMAGE` / `NO_FACE_IN_TARGET` / `NO_FACE_IN_SOURCE` /
`BAD_BOX` / `INVALID_REQUEST` (schema, with `errors`), 503 `MODELS_LOADING` / `MODELS_FAILED`.

## Run locally

```sh
cd faceswap
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest
FACESWAP_MODEL_DIR=./models FACESWAP_API_KEY=dev PORT=8791 .venv/bin/python -m app
.venv/bin/python scripts/smoke.py --url http://127.0.0.1:8791 --key dev \
  --source sheet.png --target target.jpg --out ./smoke-out
```

Resources (measured in Docker, amd64 i7-9750H, workers=2, ORT threads=2): RSS ≈ 1.8 GB after warm-up and
requests; first start downloads 1.46 GB (~3 min at ~8 MB/s), later starts load + warm up in ~13 s.
Per face: detect ~0.2 s, identity of a 3×3 sheet ~1.5 s (cached afterwards), swap ~1.7–2 s,
CodeFormer ~7–13 s, GFPGAN ~2.3–4 s. Image ≈ 700 MB on disk (arm64).

Docker: `docker compose up -d --build faceswap` (debug port `127.0.0.1:${FACESWAP_HOST_PORT:-8791}`).
Logs are JSON lines on stdout.

## Known limitations

- inswapper works at 128×128, so the swapped face is soft; the restorer recovers detail but adds its own "look".
- Hair strands or hands crossing the face are painted over (no occlusion/face-parsing mask).
- Strong profiles (> ~60° yaw) swap poorly.
