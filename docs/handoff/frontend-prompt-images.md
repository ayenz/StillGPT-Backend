# Frontend handoff: image-aware Enhance, "Other variation", 50 MB uploads

Backend commits: `706da55`, `06a6685`, `6a5b175` (deployed to prod and tested live on 2026-11-18). Full reference: `docs/API.md` in the backend repo.
All paths below are under `/api/v1`, authenticated as today (`Authorization: Bearer <access_token>`).
Errors keep the usual envelope: `{ "error": { "code": "...", "message": "..." } }`.

## What changed, in one paragraph each

1. **Enhance now sees the user's images.** `POST /prompts/enhance` takes the image ids the prompt goes with. Without them,
   "make this image moving" + a first frame produces a made-up scene that fights the frame. With them, the backend reads
   each image once with a vision model and writes a prompt that fits: a motion-only prompt for a video first frame, a
   precise "change X, keep everything else" instruction for an image edit, a "keep this product" prompt for video references.
2. **New "Other variation" button.** `POST /prompts/variations` rewrites a finished prompt into 1–6 versions where outfit,
   colours, background (or, for a video with a first frame, motion/camera/mood) change while the subject, style and quoted
   text stay. It steers away from the reference images and from variations the user already saw.
3. **Batch variations on generate.** `POST /images` with `n` + `variations: true` gives each image of the batch its own
   variation (e.g. 4 images, 4 different outfits) in one request.
4. **Uploads up to 50 MB** (was 20 MB). Large PNG/JPEG/WebP images now work everywhere (chat, edits, video frames); the
   backend shrinks the copy it sends upstream. GIF stays 7 MB in chat, documents (PDF etc.) stay 5 MB.
5. **New fields on jobs** so the UI can explain results: `request.enhanced`, `request.variations_failed`,
   `request.variation`, `request.base_prompt`, `request.fallback_reason: "prompt_too_long_for_folax"`.

---

## 1. Enhance with images — `POST /prompts/enhance`

### Request
| field | type | when | notes |
|---|---|---|---|
| `prompt` | string | always | user's idea, ≤ 4000 chars, any language |
| `kind` | `"image"` \| `"video"` | always | default `"image"` |
| `purpose`, `style`, `model` | string | optional | unchanged |
| `input_file_ids` | string[] ≤ 3 | **image edit** | the images being edited → `mode: "edit"` |
| `first_frame_file_id` | string | **video from image** | → `mode: "first_frame"` |
| `last_frame_file_id` | string | video | needs `first_frame_file_id` (else 400) |
| `reference_file_ids` | string[] ≤ 10 | **video with references** | → `mode: "reference"` |

**Rule for the frontend: whenever the composer has images attached, send their ids in the field that matches how they will
be used for generation.** Same ids, same roles as the later `POST /images` / `POST /videos` call.

### Response (200)
```json
{
  "prompt": "The woman in the red silk gown slowly turns toward the camera and smiles, fabric rippling as she shifts her weight; chandelier light flickers softly; slow dolly-in with subtle parallax, calm elegant pacing.",
  "original": "make this image moving",
  "kind": "video",
  "mode": "first_frame",
  "aspect_ratio": "adaptive",
  "ratio": "adaptive",
  "seconds": 5,
  "enhanced": true,
  "references": [
    { "file_id": "file_…", "cached": false,
      "traits": { "subject": "young woman in a red gown", "outfit": "red silk evening gown", "palette": "red, gold",
                  "background": "marble ballroom", "lighting": "warm chandelier light", "camera": "full body" } }
  ],
  "model": "qmodel_latest",
  "credits": 0.03
}
```
- `mode`: `"text"` | `"edit"` | `"first_frame"` | `"reference"`.
- `references`: one entry per image sent (first frame, last frame, then the others). `traits` is `null` when the image could
  not be read; the prompt is still usable (it just won't describe the image). `cached: true` = read before, so it was faster.
- Image (`kind: "image"`): `aspect_ratio` + `size`. In `edit` mode they match the **input image's shape** (unless the user typed
  a ratio like "16:9" in the idea).
- Video: `ratio` + `seconds`. With a first frame or references `ratio` is always `"adaptive"` (the image decides the shape).
- `enhanced: false` → the model failed; `prompt` is the original text. Keep the text area as is and show a soft toast.
- Latency (measured on prod): ~5 s for text only; **~16–18 s the first time an image is read**; ~5–6 s once the image is
  cached (`cached: true`).

### UI behaviour
- Enhance button: show a spinner, disable Generate while it runs.
- On success: replace the textarea with `prompt`.
  - image: preselect `size` (also in edit mode).
  - video: set `seconds`. If `ratio === "adaptive"`, select or lock the ratio control to "Auto (from image)".
- Do not overwrite settings the user set explicitly after the enhance call.
- Optional: show `references[i].traits` as small chips ("red silk evening gown · marble ballroom") under the thumbnail.
  This tells the user what the AI "saw".

### Flow A — "make this image moving" (video from a first frame)
```
user picks image ─► POST /files ─► file_id
user types "make this image moving", taps ✨
  POST /prompts/enhance { prompt, kind:"video", first_frame_file_id: file_id }
  ◄─ { prompt: motion-only text, ratio:"adaptive", seconds, mode:"first_frame" }
textarea = prompt; seconds = seconds; ratio = Auto
user taps Generate
  POST /videos { prompt, first_frame_file_id: file_id, seconds, ratio:"adaptive" }   (no enhance: already done)
  ◄─ 202 job → follow /jobs/:id/events as today
```
With an end frame: also send `last_frame_file_id` on both calls. The prompt then describes the transition.

### Flow B — image edit ("ganti background jadi pantai")
```
user attaches 1–3 images (input_file_ids), types the change, taps ✨
  POST /prompts/enhance { prompt, input_file_ids }
  ◄─ { prompt: "Change the background to … keep the same woman, gown, pose …", size (matches input), mode:"edit" }
Generate: POST /images { prompt, input_file_ids, size }
```

### Shortcut: `enhance: true` on generate
`POST /images { prompt, input_file_ids, enhance: true }` and `POST /videos { prompt, first_frame_file_id, enhance: true, seconds, audio }`
now pass the images (and for video the `seconds` and `audio:false`) to the enhancer automatically. The job's `request` has
`prompt` (enhanced), `original_prompt` and `enhanced` (true/false). Use this for a "one-tap" mode. The separate ✨ button is
better UX because the user sees and can edit the prompt first.

---

## 2. "Other variation" — `POST /prompts/variations`

### Request
| field | type | default | notes |
|---|---|---|---|
| `prompt` | string | required | the prompt to vary: usually the enhanced prompt, or the prompt of the image on screen |
| `kind` | `"image"` \| `"video"` | `"image"` | |
| `reference_file_ids` | string[] ≤ 3 | `[]` | images to move **away** from: the user's reference, the image just generated |
| `first_frame_file_id` | string | – | **video only**: the fixed first frame. Variations match it and vary motion/camera/mood |
| `vary` | axis[] | `["outfit","color","background"]` (with first frame: `["motion","camera","mood"]`) | what must change |
| `keep` | axis[] | `["subject","style","text"]` minus `vary` (with first frame: subject, outfit, color, background, style, text) | what must stay; an axis in both → 400 |
| `avoid` | string[] ≤ 12 | `[]` | prompts of variations already shown (newest last) |
| `n` | 1–6 | `1` | |

Axes: `subject`, `outfit`, `color`, `background`, `pose`, `lighting`, `camera`, `props`, `hair`, `style`, `text`, `mood`, `motion`.

### Response (200)
```json
{
  "original": "Fashion photo of a young woman in a red silk evening gown in a marble ballroom, …",
  "kind": "image",
  "variations": [
    { "prompt": "Fashion photo of the same young woman in an oversized denim jacket and white tee on a sunny rooftop, …",
      "changed": { "outfit": "oversized denim jacket, white tee", "color": "indigo, white", "background": "sunny rooftop" } }
  ],
  "vary": ["outfit", "color", "background"],
  "keep": ["subject", "style", "text"],
  "references": [ { "file_id": "file_…", "cached": true, "traits": { … } } ],
  "model": "qmodel_latest",
  "credits": 0.02
}
```
Errors: `502 variation_failed` (model gave nothing usable → "Couldn't make a variation, try again"), `404 file_not_found`,
`400 validation_error`, `429 credit_limit_exceeded`. Latency measured on prod: ~10 s (video, n=2) to ~25 s (image, n=2, with a reference).

### Frontend state
Keep one variation session per prompt "lineage":
```ts
type VariationSession = {
  basePrompt: string;          // the prompt the user enhanced or typed; vary from this, not from the last variation
  referenceIds: string[];      // user's reference images + the last generated image (max 3, newest wins)
  seen: string[];              // every variation prompt already shown, newest last; send the last 12 as `avoid`
  vary?: Axis[];               // from the optional axis chips
};
```
Reset the session when the user edits the prompt by hand or starts a new idea.

### Flow C — single "Other variation" (image)
```
after a generation the user taps "Other variation"
  POST /prompts/variations {
    prompt: session.basePrompt,
    reference_file_ids: [lastGeneratedImageId, ...userRefs].slice(0,3),
    avoid: session.seen.slice(-12),
    vary: session.vary            // omit for defaults
  }
  ◄─ { variations:[{prompt, changed}] }
session.seen.push(prompt)
show `changed` as chips ("Outfit: denim jacket · Background: rooftop")
either put the prompt in the textarea for the user to generate (recommended),
or auto-generate: POST /images { prompt, size: <same size as before> }
```
Sending the **last generated image** as a reference is what makes the next variation look clearly different from what is
on screen.

### Flow D — video "Other variation" with a first frame
```
POST /prompts/variations { prompt: currentVideoPrompt, kind:"video", first_frame_file_id, avoid }
  → variations differ in motion/camera/mood; the frame's subject/outfit/background stay
POST /videos { prompt: variation.prompt, first_frame_file_id, seconds, ratio:"adaptive" }
```
Do **not** pass the first frame in `reference_file_ids`. That would tell the model to move away from it.

### Flow E — "Generate N variations" in one tap (images) — updated
```
POST /images { prompt, n: 4, variations: true, size }       // or variations: { vary: [...] } from "What may change" chips
◄─ batch:
   jobs[0].request = { prompt: "<prompt as written>", base_prompt: "<same>", variation: { original: true }, batch_index: 0, … }
   jobs[i].request = { prompt: "<variation>", base_prompt: "<prompt>",
                       variation: { changed:{…}, vary:[…], keep:[…], repeated:false }, batch_index: i, … }   (i = 1..n-1)
```
- **Job 0 is always the original prompt** (`variation.original === true`): label it "Original".
- Jobs 1..n-1: show `variation.changed` as a caption. `repeated: true` → reuses a variation (model returned too few).
- Without `vary`, what the user typed themselves stays ("red dress on a beach" → other red dresses, other beaches). With
  `vary` from the "What may change" chips, those axes may change even where the user named them. Send `vary` only when
  the user actually picked chips.
- `variations_failed: true` on all jobs → every image used the original prompt. Show "Variations unavailable".
- `n: 1` + `variations` → just the original (no variation call).
- Edit batches (`input_file_ids`): job 0 is the edit exactly as asked; the others are other takes on that edit.
- Up to `n: 10` (original + 9 variations, one variation call). Adds ~10–25 s before the batch starts.
- `POST /prompts/variations` now takes `user_prompt` (the user's own words before enhancing) with the same "keep what they
  wrote" effect, and `n` up to 9.

### UI suggestions
- "Other variation" button on the result card, plus an optional ⋯ menu with axis chips (Outfit, Color, Background, Pose,
  Lighting, Hair, Props, Mood; for video: Motion, Camera, Mood). The selected chips go in `vary`.
- Batch selector next to Generate (up to 10) → Flow E.

---

## 3. Uploads up to 50 MB — `POST /files`

- Client-side max: **50 MB** per file (`413 file_too_large` above that). Update any 20 MB / 7 MB checks and copy.
- Images (PNG/JPEG/WebP) of any size up to 50 MB are now valid for chat attachments, image edits, video frames/references.
  The stored file and gallery stay full size.
- Still limited: **GIF** in chat 7 MB (`413 attachment_too_large`); **documents** (PDF, docx, …) 5 MB (`413 attachment_too_large`).
- First use of a large image can take 1–3 s longer (the backend makes an upstream copy once). No UI change needed beyond
  the normal spinner.
- Optional nicety: downscale > 4096 px images client-side before upload to save bandwidth. Not required.

---

## 4. New job fields (`GET /jobs/:id`, batch views, SSE `job.*` payloads)

| field (in `request`) | meaning | suggested UI |
|---|---|---|
| `enhanced` | only when `enhance:true` was sent; `false` = enhancer failed, original prompt used | small "not enhanced" badge |
| `original_prompt` | what the user typed (enhance:true) | "Show original" toggle |
| `base_prompt` | the prompt variations were made from | used for "Other variation" on this job |
| `variation` | `{changed, vary, keep, repeated}` | caption chips |
| `variations_failed` | `true` when variations were requested but failed | info toast/badge |
| `fallback_reason: "prompt_too_long_for_folax"` | provider `auto` sent a > 1500-char prompt to Qoder instead of Folax | nothing needed |

"Other variation" from an existing job: `prompt = job.request.base_prompt ?? job.request.prompt`,
`reference_file_ids = [job.outputs[0].id]`.

---

## 5. Checklist for the frontend

- [ ] Enhance sends `input_file_ids` / `first_frame_file_id` / `last_frame_file_id` / `reference_file_ids` matching the composer's attachments.
- [ ] After enhance: apply `size` (image) or `seconds` + `ratio` (video; `"adaptive"` → "Auto"); handle `enhanced:false`.
- [ ] Optional traits chips from `references[].traits` (handle `traits: null`).
- [ ] "Other variation" button with a `VariationSession` (`basePrompt`, `referenceIds` incl. last output, `seen` → `avoid`).
- [ ] Video variations with `first_frame_file_id` (never as a reference).
- [ ] Batch generate with `variations: true` and per-tile `changed` captions; handle `repeated` and `variations_failed`.
- [ ] Error handling: `502 variation_failed` (retry), `404 file_not_found`, `400 validation_error`, `429 credit_limit_exceeded`, `413`.
- [ ] Upload limit 50 MB; GIF 7 MB and documents 5 MB unchanged.
- [ ] Spinners: enhance 5–18 s, variations 10–25 s. Show progress text such as "Reading image…" / "Writing variations…".
