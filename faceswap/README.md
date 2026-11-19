# faceswap sidecar

Internal HTTP service for StillGPT's face swap (engine `swapper`, plus `face-crop`/`face-paste` for `qoder_crop`)
and image upscaling (`/v1/upscale`, x2/x4, see [Upscale](#upscale)).
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
| upscale_clear (x4, SPAN) | clear_reality_x4.onnx (1.7 MB) | bbce9d5a653281cfae07788d620bd4ec45712709bdf6349a06a893159efd97ce |
| upscale_span (x4, SPAN) | span_kendata_x4.onnx (1.7 MB) | 7478c40953a5902efd785ef1fe8e07a8bb7e7ee9b1977273550813ceefae6348 |
| upscale_nomos (x4, ESRGAN) | nomos8k_sc_x4.onnx (67 MB) | 7747a7dd0b115761cf9c34bbf67bb1e98218ff5b459492a13215c8deb046a9d0 |

The face-swap models and the upscalers are loaded independently: if the upscalers fail to download/load, face swap
still works (and vice versa); `/health/ready` reports the upscaler in its `upscale` block. In upscale-only mode
(`FACESWAP_UPSCALE_ONLY=1`) only the detector + the 3 upscalers (≈ 86 MB) are downloaded.

Source: `https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/<file>`.

**Licences:** `inswapper_128` (InsightFace) is released for **non-commercial research use only**; the buffalo_l
models are likewise non-commercial. CodeFormer is under the S-Lab License 1.0 (non-commercial). GFPGAN is Apache-2.0.
Check this before offering the swapper engine commercially. The upscaler models also come from facefusion-assets
(community models: ClearReality / SPAN Kendata / 4xNomos8kSC); their licences have **not** been checked yet — do that
before commercial use.

## Environment

| var | default | |
|---|---|---|
| `FACESWAP_API_KEY` | empty | required `X-API-Key` header value; empty disables auth |
| `FACESWAP_WORKERS` | 2 | parallel inference jobs (thread pool); further requests queue |
| `FACESWAP_ORT_THREADS` | cpu_count / workers | onnxruntime intra-op threads per session run |
| `FACESWAP_ORT_ARENA` | 0 | 1 = keep onnxruntime's CPU memory arena (≈ +2.4 GB RSS, no measurable speed gain) |
| `FACESWAP_MODEL_DIR` | `/models` | |
| `PORT` / `HOST` | 8080 / 0.0.0.0 | |
| `FACESWAP_UPSCALE_ONLY` | 0 | 1 = only detector + upscalers; `/v1/swap`, `/v1/face-crop`, `/v1/face-paste` answer 503 `UPSCALE_ONLY` |
| `UPSCALE_DEVICE` | cpu | `cpu`, `cuda` (onnxruntime-gpu, `Dockerfile.gpu`) or `off` (503 `UPSCALE_DISABLED`, no upscaler download) |
| `UPSCALE_WORKERS` | 1 | parallel upscale jobs, in their own thread pool (never takes the face-swap workers) |
| `UPSCALE_MAX_PIXELS` | 4200000 | input limit (413 `TOO_LARGE`) |
| `UPSCALE_BIG_FACE_MP` | 0.15 | CPU only: faces whose box + context exceed this many input megapixels keep the base (no nomos pass) |
| `UPSCALE_JPEG_QUALITY` | 97 | default output quality (request `jpeg_quality` overrides) |
| `UPSCALE_GPU_IDLE_S` | 150 | CUDA only: idle seconds before the GPU sessions are released and paused containers are started again |
| `UPSCALE_PAUSE_CONTAINERS` | empty | CUDA only: comma list of containers to stop (if running) during GPU work |
| `DOCKER_HOST` | empty | Docker Engine API for the pause controller, `tcp://host:port` (a docker-socket-proxy) |

Upscale uses `FACESWAP_ORT_THREADS` too. On the CPU host one 4x upscale keeps 1 core set busy for ~0.5–2 min, so
`UPSCALE_WORKERS` stays at 1.

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
- `POST /v1/face-paste` `{base, patch, box, feather? (0.15), color_match? (true), mask? ("face"|"box", default "face"),
  max_scale_dev? (0.18), max_rotation_deg? (12), max_shift? (0.12), output_format?, jpeg_quality?}` →
  `{image, mime_type, width, height, alignment: {scale, rotation_deg, shift, residual}}`. Landmark-aligned:
  `base` is re-cropped at `box` (edge-reflect padding) at a working size of max(box side, 256) px (≤ patch size);
  the main face + 5 landmarks are detected in that crop (det 0.5, fallback 0.2) and in the full patch (det 0.5).
  A similarity transform patch → crop is estimated (umeyama); `scale` > 1 means the patch face is smaller,
  `shift` = distance of the two face centres / crop side, `residual` = landmark RMS error / face size (info only).
  It is rejected with 422 `{detail: "PATCH_MISALIGNED", reason: "no_face_in_patch"|"scale"|"rotation"|"shift",
  alignment: {...}|null}` when scale ∉ [1/(1+max_scale_dev), 1+max_scale_dev], |rotation| > max_rotation_deg or
  shift > max_shift. Otherwise the patch is warped onto the original face, LAB-colour-matched inside the face, its
  low frequencies are replaced by the base's in the mask's transition band (no light/dark ring), and it is blended
  with a feathered convex hull of both faces (landmarks + detector box raised for the forehead; `mask: "box"` = the
  whole box, softly). Everything outside the mask stays from `base`. No face in the base crop → 422 `NO_FACE_IN_TARGET`.

- `POST /v1/upscale` — see [Upscale](#upscale).

Error codes: 401 `AUTH_INVALID`, 413 `TOO_LARGE`, 422 `BAD_IMAGE` / `NO_FACE_IN_TARGET` / `NO_FACE_IN_SOURCE` /
`BAD_BOX` / `PATCH_MISALIGNED` / `INVALID_REQUEST` (schema, with `errors`), 503 `MODELS_LOADING` / `MODELS_FAILED` /
`UPSCALE_DISABLED` / `UPSCALE_ONLY`.

## Upscale

`POST /v1/upscale` `{image, scale?: 2|4 (4), mode?: "natural"|"sharp" ("natural"), jpeg_quality?: 50–100 (env, 97)}` →
`{image (base64 JPEG, 4:4:4), mime_type, width, height, scale, mode, pipeline, device, faces, faces_enhanced,
timings_ms: {decode, base, faces?, resize?, gpu_wait?, grain, encode, total}}`.
Input ≤ `UPSCALE_MAX_PIXELS` (4.2 MP) and ≤ 25 MB, else 413 `TOO_LARGE`. EXIF orientation applied, alpha dropped.
503 `MODELS_LOADING` / `MODELS_FAILED` while the upscaler is not loaded, `UPSCALE_DISABLED` with `UPSCALE_DEVICE=off`.
`GET /health/ready` contains `upscale: {ready, device, pipelines: {natural: "P4"|"P5", sharp: "P1"}}`
(not ready: `{ready: false, device, disabled, loading, error}`); in upscale-only mode the status code follows the
upscaler instead of the face-swap engine.

Pipelines (CR = clear_reality, SP = span_kendata, NO = nomos8k_sc, all x4, outputs clipped to 0..1 per model):

| pipeline | when | result |
|---|---|---|
| P1 | `sharp` | 0.7·CR + 0.3·SP |
| P4 | `natural` on CPU | P1 base; every detected face (SCRFD 0.5, ≥ 24×24 px): square box 1.7× the face, NO on box + 16 px context, face patch 0.6·NO + 0.4·CR pasted with an ellipse (0.40 w / 0.44 h) feathered by σ = 0.06·side. Faces whose box + context is > `UPSCALE_BIG_FACE_MP` keep the base (`faces_enhanced` counts replaced faces) |
| P5 | `natural` on CUDA | 0.6·NO + 0.4·CR on the whole image (`faces` = 0, no face step) |

Then grain: monochrome gaussian noise blurred with σ 0.7, std 2.5, weighted by clip(4L(1−L), 0.15, 1)·1.25
(L = luma/255), seeded from the input bytes (same input → same output). `scale: 2` = the 4x result without grain,
`INTER_AREA` to exactly 2× the input, then grain. `faces`/`faces_enhanced` are only counted by P4.

Tiling: CPU 256 px tiles (16 px real/reflect context), CUDA 512 px; regions ≤ 640 px (CPU) / 512 px (CUDA) run in
one pass padded to a multiple of 16. All models of a pipeline run on the same tile and are accumulated into one
uint8 buffer; grain runs in 256-row bands; the JPEG is encoded by OpenCV straight from that buffer (no Huffman
optimisation, which would buffer every DCT coefficient).

Measured (Apple M-series CPU, 4 threads, local): 4.2 MP → 67 MP `sharp` 96 s, process peak RSS 0.81 GB. One nomos
face pass (0.15 MP region, the CPU maximum) adds ≈ 1.6 GB RSS for ~35 s, so a 4.2 MP `natural` job peaks at
≈ 2.4 GB on top of nothing else; on the shared prod sidecar add the face-swap working set (~1.8 GB).
Oracle (4 threads): ~11 s/MP per SPAN model, nomos ~320 s/MP. GTX 1060: SPAN ~0.8 s/photo, nomos ~16 s/MP.

### GPU deployment (stillmen.dell)

`Dockerfile.gpu` (linux/amd64 only) = the same app with `onnxruntime-gpu==1.22.0` and the CUDA 12.2 / cuDNN 9.1 pip
wheels (`requirements-gpu.txt`; driver 535 fails with newer libs: `CUDNN_STATUS_EXECUTION_FAILED`). The host needs
only the NVIDIA driver + nvidia-container-toolkit. At start it downloads the 4 models, runs a 32×32 self-test on the
GPU (verifies cuDNN works) and releases the sessions again; sessions are created when a job arrives (CUDA provider,
`cudnn_conv_algo_search=HEURISTIC`).

```sh
cd faceswap/deploy/gpu && cp .env.example .env   # set FACESWAP_API_KEY
docker compose up -d --build
curl -s http://10.121.21.101:8090/health/ready
```

The GPU is shared with Immich ML (`immich_machine_learning`, which pins its VRAM). Pause controller: before GPU
work the sidecar stops the containers in `UPSCALE_PAUSE_CONTAINERS` that are running (Docker Engine API via
`docker-proxy` = tecnativa/docker-socket-proxy with CONTAINERS/POST/ALLOW_START/ALLOW_STOP, not published) and
records them in `/models/upscale-gpu-gate.json`. After `UPSCALE_GPU_IDLE_S` without upscale work it releases its GPU
sessions (the CUDA context itself, a few hundred MB, stays) and starts those containers again; on shutdown it starts
them right away, and on startup it starts any the previous run left stopped. Docker errors are logged and never
fail a request. Port `10.121.21.101:8090` binds the ZeroTier address only (ZeroTier must be up before Docker starts
the container).

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
