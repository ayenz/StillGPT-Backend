# StillGPT — Architecture

StillGPT is a backend that turns **Qoder Cloud Agents** (stateful, agentic, async) into:

1. a **native API** for our own "personal LLM" apps (PWA first, Flutter later), and
2. **OpenAI-compatible** and **Anthropic-compatible** endpoints (stateless) so existing tools — n8n, SDKs, 9router, LangChain — work unchanged.

Stack: Node 22+/TypeScript (ESM), Hono, Zod, Drizzle ORM (Postgres in prod, PGlite in tests/dev), jose (JWT), Vitest.
Deploy: Docker Compose on `oracle-server` (linux/arm64) behind host nginx.

---

## 1. Upstream facts (Qoder Cloud Agents API, verified 2026-11-14)

See `docs/QODER_API_NOTES.md` for payload shapes. Key facts that drive the design:

- Base `https://api.qoder.com/api/v1/cloud`, `Authorization: Bearer <PAT pt-… | SAT>`.
- Work happens in **Sessions** created from an **Agent** (model + system + tools) inside an **Environment**.
- A turn = `POST /sessions/{id}/events` with a `user.message` (text + image blocks), then read
  `GET /sessions/{id}/events/stream` (SSE) until `session.status_idle`.
  Token streaming: add `?event_deltas[]=agent.message` → `event_start` + `event_delta` frames, then the buffered `agent.message` (same id).
- The stream does **not** replay old events when opened without `Last-Event-ID`. We persist the last seen event id per session and
  **open the stream with `Last-Event-ID` before/around sending** so nothing is lost.
- A session can **switch model / system prompt mid-conversation**: `POST /sessions/{id}` `{agent:{model, system}}`
  with header `x-qoder-beta: session-agent-patch-2026-07-21`. Context is preserved.
- Sessions support `budget: {type:"limit", max_credit_cost:"1.00"}`.
- `GET /models` is the source of truth. Retired ids disappear and any use returns
  `400 invalid_request_error "Field 'model' must reference an available model."`. Ids may silently change underlying model
  (e.g. `qmodel_latest` Qwen3.7-Max → Qwen4-Max-Preview).
- Files: `POST /files` (multipart, ~5 MB) accepts PDF/DOCX/images in practice (docs claim text-only). Mount into a session with
  `POST /sessions/{id}/resources {type:"file", file_id, mount_path:"/data/…"}`. Sandbox has pdftotext, pandoc, libreoffice, tesseract, pypdf, python-docx, openpyxl.
- Generated files reach us via `agent.artifact_delivered {file_id, original_filename, size, content_type}` → `GET /files/{id}/content` → presigned `url`.
- Built-in tools we use: `Read Bash Glob Grep WebFetch WebSearch ImageSearch ImageGen VideoGen DeliverArtifacts`.
- ImageGen: 1 image/call, `size` enum (1024x1024 default, 1536x1024, 1024x1536, 768x1024, 1024x768, 1024x1280, 1280x1024, 1024x1792, 1792x1024, 2560x1080); edits via up to 3 input images (sandbox paths). Real output is ~1 MP (1792x1024 request → 1376x768).
- VideoGen: modes `text_to_video | first_frame_to_video (+last_frame) | reference_to_video (1–10 imgs)`, `duration_seconds` 2–30 (default 5) or -1, `resolution` 480P/720P/1080P (default), `ratio` adaptive/21:9/16:9/4:3/1:1/3:4/9:16, `audio` bool (default true). Blocking 3–8 min (max 30), not cancellable. Output H.264 1920x1080 30fps (+AAC).
- Latency observed (model `efficient`, price factor 0): chat 1.7–4 s, docs 8–20 s, image ~25–30 s, video ~3–4 min.

## 2. Concepts

| StillGPT | Qoder |
|---|---|
| **User** (our account, JWT or API key) | — (all traffic uses one Qoder identity: PAT or Service Account) |
| **Profile** (tool set) | one Qoder **Agent** per profile |
| **Conversation** | one Qoder **Session** |
| **Turn** (user message → assistant reply) | `user.message` + stream until idle |
| **Model alias** (`smart`, `fast`, `cheap`, …) | resolved to a live Qoder model id with fallback |
| **Media job** (image/video) | one-shot session with the `image`/`video` profile |

### Profiles (src/core/profiles.ts)
| profile | enabled_tools | used by |
|---|---|---|
| `chat` | none (pure LLM, fastest) | OpenAI/Anthropic compat default |
| `assistant` | Read Bash Glob Grep WebFetch WebSearch ImageSearch ImageGen VideoGen DeliverArtifacts | PWA default ("ChatGPT-like") |
| `image` | ImageGen DeliverArtifacts (+Read Glob for edits) | image endpoints |
| `video` | VideoGen DeliverArtifacts Read Glob | video endpoints |
| `research` | WebSearch WebFetch Bash Read Glob Grep DeliverArtifacts | deep research agents, report rendering |

Agents are created lazily by `AgentPool` (one per profile, default model `efficient`) and cached in table `qoder_agents`.
Per-conversation model/system differences are applied with a session patch, so we never need an agent per model.
If a conversation has document attachments and its profile lacks `Bash`/`Read`, the turn upgrades the session tools to `assistant`.

## 3. Module layout

```
src/
  index.ts                 start server + background jobs
  app.ts                   createApp(ctx): Hono app, mounts all routers
  context.ts               AppContext (config, db, qoder, services) — dependency injection, used by tests
  config.ts                env parsing (zod)
  errors.ts                AppError + mappers to native/OpenAI/Anthropic error envelopes
  log.ts                   tiny JSON logger
  db/schema.ts, db/client.ts, db/migrate.ts   Drizzle schema; pg or PGlite
  auth/                    passwords (scrypt), jwt (jose), apiKeys, passkeys (WebAuthn, @simplewebauthn/server), middleware (resolveUser)
  qoder/
    client.ts              QoderClient: typed REST + streamEvents() async iterator
    sse.ts                 SSE line parser
    tokens.ts              TokenProvider: PAT or Service-Account → SAT (auto refresh)
    types.ts               upstream payload types
  core/
    events.ts              normalized TurnEvent union (the internal lingua franca)
    profiles.ts            profile → tools
    agentPool.ts           ensure environment + agent per profile
    models.ts              ModelRegistry: sync GET /models, aliases, fallback, change detection
    turns.ts               TurnRunner: run one turn on a conversation, emit TurnEvents, persist
    conversations.ts       create/get/list conversations; stateless-thread matching for compat APIs
    attachments.ts         turn input blocks (images/docs) into Qoder content/resources
    storage.ts             local media store + HMAC signed URLs (expiry rounded to a day → stable, cacheable URLs)
    variants.ts            gallery renditions: WebP thumb (400) / preview (1280) via sharp, video stills via ffmpeg
    media.ts               image + video jobs (background worker, resumable; Qoder or Folax for images)
    enhancer.ts            prompt enhancer (idea → detailed prompt + aspect ratio)
    enhancerInstructions.ts admin-editable enhancer instructions (kv), cached in memory
    references.ts          vision description of user images (cached traits) for enhancer/variations
    variations.ts          "other variation": prompt → n variants that change outfit/colours/background, away from references
    webhooks.ts            outgoing webhooks (HMAC-signed), per-request callback_url
    push.ts                Web Push (VAPID) to the PWA when a media job finishes
    fcm.ts                 FCM HTTP v1 (service-account JWT → OAuth) to the Android app when a media job finishes
    usage.ts               credit accounting + per-user limits
    runs/                  durable multi-agent jobs (§7b): service.ts (RunService, RunContext, step memo), council.ts, json.ts, semaphore.ts
    bus.ts                 in-memory pub/sub for live turn/job events
  providers/
    folax.ts               FolaxClient: folax-adapter sidecar (fast external image generator)
    faceswap.ts            FaceSwapClient: faceswap sidecar (swap on the GPU box first, CPU fallback; face crop/paste on the CPU)
    upscale.ts             UpscaleClient: /v1/upscale on the GPU box (primary) with the CPU faceswap sidecar as fallback
  routes/
    health.ts
    native/                /api/v1/*  (PWA, Flutter, n8n)
    openai/                /v1/chat/completions, /v1/models, /v1/images/*, /v1/videos*
    anthropic/             /v1/messages, /v1/messages/count_tokens
    media.ts               GET /media/:id (signed URL, streamed, Range/ETag, ?variant=thumb|preview)
    serveFile.ts           streaming file responses (Range, If-None-Match → 304)
test/
  mock-qoder/              fake Qoder Cloud Agents server (deterministic, scripted)
  e2e/                     end-to-end tests against the mock (official openai + anthropic SDKs as clients)
  live/                    opt-in smoke tests against real Qoder (QODER_LIVE=1)
```

## 4. The turn pipeline (core/turns.ts)

```
runTurn({conversation, input blocks, options}) → AsyncIterable<TurnEvent>
 1. acquire per-conversation lock (in-process mutex + conversations.status='busy')
 2. resolve model (ModelRegistry.resolve) — may fall back; emit {type:'model', requested, resolved, fallback}
 3. ensure Qoder session (create from profile agent; patch model/system/tools if they differ from the snapshot)
 4. upload/mount attachments, build user.message content
 5. open stream with Last-Event-ID = conversation.lastEventId and event_deltas[]=agent.message; POST the user.message
 6. map upstream → TurnEvent until session.status_idle | terminated | error; persist lastEventId continuously
 7. persist assistant message + usage; release lock; publish to bus
 retry: upstream "model must reference an available model" → mark model retired, resync, re-resolve, patch session, resend once.
```
The turn keeps running even if the HTTP client disconnects (the iterator is drained by the runner; HTTP routes subscribe through `bus`).

### TurnEvent (core/events.ts) — every API renders from this
```ts
type TurnEvent =
  | { type: 'turn.started'; conversationId: string; messageId: string; model: string }
  | { type: 'model.fallback'; requested: string; resolved: string; reason: string }
  | { type: 'thinking' }
  | { type: 'text.delta'; text: string }             // incremental assistant text
  | { type: 'text.completed'; text: string }         // one finished agent.message block
  | { type: 'tool.started'; id: string; name: string; input: unknown }
  | { type: 'tool.completed'; id: string; isError: boolean; output: string }
  | { type: 'artifact'; artifact: Artifact }         // stored in our media store, has signed url
  | { type: 'usage'; credits: { model: number; sandbox: number; total: number } }
  | { type: 'turn.completed'; stopReason: 'end_turn' | 'interrupted' | 'budget_exceeded' | 'requires_action'; text: string }
  | { type: 'error'; code: string; message: string; retryable: boolean };
```
Delta rule: if an `agent.message` id produced `event_delta`s, its buffered event yields only `text.completed`; otherwise it yields one `text.delta` with the whole text followed by `text.completed`.
Multiple `agent.message` blocks in one turn are joined with `\n\n` for the final `text`.

## 5. Stateless compat APIs → stateful sessions (core/conversations.ts)

OpenAI/Anthropic clients resend the full history each call. Mapping:
- `threadKey(userId, profile, messages)` = sha256 of normalized messages (role + text + image digests).
- On request with messages `M`: look up `threadKey(M[0..-1])` (everything before the final user message) in `compat_threads`.
  - hit → reuse that conversation/session, send only the final user message.
  - miss → new conversation; if `M` has earlier turns, send them as one transcript preamble plus the final message.
- After the turn, store `threadKey(M + assistantReply)` → conversation, so the client's next call hits.
- `system`/developer messages → session `agent.system` patch.
- Explicit control for n8n etc.: header `X-StillGPT-Conversation: <conv_id>` (or `metadata.conversation_id`) forces a conversation;
  header `X-StillGPT-Profile: chat|assistant` selects profile.
- Response headers: `X-StillGPT-Conversation`, `X-StillGPT-Model` (resolved), `X-StillGPT-Credits`.
- Token counts are not exposed by Qoder: `usage` tokens are estimates (chars/4) and we add `stillgpt_credits`.
- Tool/function calling (`tools`): phase 2 — map to Qoder custom tools (`agent.custom_tool_use` ⇄ `user.custom_tool_result`). MVP returns 400 `tools_not_supported`.

## 6. Models (core/models.ts)

- Table `models` mirrors `GET /models` (+ `status active|retired`, `first_seen_at`, `last_seen_at`, `retired_at`, `display_name` history).
- Sync at startup + every `MODEL_SYNC_INTERVAL_MIN` (default 60). Changes emit webhook events `model.added | model.retired | model.updated`.
- Aliases (config `MODEL_ALIASES` JSON, defaults):
  `default: [auto, efficient]`, `smart: [ultimate, kmodel_latest, auto]`, `fast: [fast, qfmodel, efficient]`, `cheap: [efficient, qfmodel, dfmodel]`,
  `vision: [auto, efficient]`.
- `resolve(requested)`: alias → first active member; raw id (`ultimate`, `qoder/ultimate`) → itself if active, else the `default` chain + `model.fallback` event.
- Public ids: aliases and `qoder/<id>`; `/v1/models` lists both. Bare Qoder ids are also accepted.
- Image/video "models" are virtual: `qoder-image`, `qoder-video`, and `folax-image` when Folax is configured.

## 7. Media (core/media.ts)

- Images are synchronous for callers (~30 s): one-shot session on `image` profile with an instruction that pins `size` and the prompt verbatim; edits mount inputs under `/data/attachments/`.
- Image providers (`provider: auto|qoder|folax`, default `IMAGE_PROVIDER_DEFAULT`): **Folax** (`providers/folax.ts`, a Python sidecar
  `folax-adapter`) is a fast (~10 s), free generator that returns 2 images per prompt but only knows 5 ratios, ≤1500-char prompts, no edits
  and accepts parallel requests (`FolaxClient` caps calls in flight at `FOLAX_CONCURRENCY`, default 8, matching the adapter's
  `max_concurrency`; a batch of n Folax jobs makes n parallel calls). A Folax job runs no Qoder turn: the images are saved as
  artifacts of the job and usage is recorded with 0 credits (model `folax`). `auto` = Folax for text-to-image when configured, Qoder
  otherwise, and Qoder as transparent fallback when Folax fails; edits always use Qoder. `request.provider`, `provider_used` and
  `fallback_reason` record the decision. Folax `AUTH_INVALID` emits the admin webhook `provider.degraded` (throttled to 1/h).
- Prompt enhancer (`core/enhancer.ts`, `POST /api/v1/prompts/enhance`): one turn on a hidden `chat` conversation with the `enhancer` model
  alias that rewrites an idea into an English prompt + aspect ratio (image size, or video ratio/seconds). `enhance: true` on
  image/video jobs runs it at creation time; its size/ratio/seconds apply only where the request left them unset, and
  `request.original_prompt` keeps the input. The LLM text is `instructions + hints + contract + <idea>`: `instructions` (persona,
  style, length, how to pick a ratio) are admin-editable per kind in `kv.enhancer.instructions.{image,video}` (cached by
  `EnhancerInstructions`, `/admin/enhancer/*`); the contract (allowed ratios, JSON shape, safety rules) stays in code.
  When the Qoder turn fails, gives no usable JSON or takes over `ENHANCER_QODER_MS` (15 s; down, out of credits…), Folax writes
  it instead (`folax/gemini`, then `folax/chatgpt`; free, `model: "folax/…"`, `credits: 0`). Folax's upstream filter rejects any
  request containing words like "sexual"/"nudity"/"minors"/"busty", even in our own rules, so `folaxSafePrompt` drops those
  rule lines (the user's hints and idea are untouched). If Folax fails too, the original prompt comes back (`enhanced: false`).
- Image-aware prompts (`core/references.ts`): `ReferenceReader` describes an image once with the `vision` alias (traits cached
  in `files.traits`). The enhancer uses it for image edits (`mode: edit`, ratio from the input), video first/last frames
  (`first_frame`: motion only) and video references; variations use it to steer away from references or stay on an edited
  image / first frame. User and image-derived text is fenced (`<\/` escaped) inside tags.
- Large images: uploads go up to 50 MB; `attachments.shrinkImage` makes a same-format copy under ~4.5 MB for Qoder (its file
  limit) when a PNG/JPEG/WebP is uploaded upstream; the Qoder file id is cached so it happens once per file.
- Prompt variations (`core/variations.ts`, `POST /api/v1/prompts/variations`, `variations` on `POST /images`): each reference image
  is first described once by the `vision` alias (a hidden one-shot turn with the image attached) into traits (outfit, palette,
  background…), cached in `files.traits`. Then one `enhancer` turn writes `n` variants that change the `vary` axes away from those
  traits and from `avoid` (earlier variants), and keep the `keep` axes. Instructions are editable as kind `variation`
  (`kv.enhancer.instructions.variation`). On image jobs a variation failure falls back to the unvaried prompt.
- Videos are **jobs**: table `media_jobs` (status `queued|in_progress|completed|failed`, qoder session id, last event id, progress, result artifact, error, `callback_url`).
  A worker runs them with concurrency `VIDEO_CONCURRENCY` (default 1 — the Qoder account allows ~1 concurrent video; a full upstream queue is retried automatically) and **resumes** in-flight jobs after restart by reading session events.
- Upscale (`POST /images/:fileId/upscale`, `providers/upscale.ts`): an image job with `provider_used: upscale` and
  `request.upscale`, no Qoder turn, free, no credit-limit check, inputs ≤ 4.2 MP. The same sidecar code (`faceswap/`) runs on
  two machines: the **GPU** box (GTX 1060, reached over ZeroTier at `UPSCALE_GPU_URL`) is primary; the
  **CPU** faceswap sidecar (`FACESWAP_URL`) is the fallback when the GPU is unconfigured, not ready (`/health/ready` →
  `upscale.ready`, cached 30 s), unreachable, times out (`UPSCALE_GPU_TIMEOUT_MS`, 4 min) or answers non-image errors (5xx/401/404).
  Image rejections (413 `TOO_LARGE`, 422 `BAD_IMAGE`) do not fall back. One call in flight per backend. Restart recovery
  re-runs queued/in-progress upscale jobs (no session → back to `queued`).
- Face swap `/v1/swap` (engines `swapper`, `swapper_polish`) goes to the same GPU box first (`FACESWAP_GPU_URL`, sidecar with
  `FACESWAP_DEVICE=cuda`: ~0.4 s instead of ~18 s on the CPU sidecar) when its cached probe (`/health/ready` → `ready` and
  `models.device: "cuda"`, 30 s) says so; unreachable, timeout (`FACESWAP_GPU_TIMEOUT_MS`, 90 s, includes waiting behind an
  upscale there) or 5xx/401/404 fall back to `FACESWAP_URL`; input rejections (no face, bad image) do not. The GPU sidecar
  runs swaps and upscales in turn and hands the card over (their models do not fit 6 GB together). `face-crop`/`face-paste`
  always use the CPU sidecar.
- Artifacts are downloaded from Qoder and stored under `MEDIA_DIR`; served via `GET /media/:id?exp&sig` (HMAC signed, no auth header needed → works in `<img>`/`<video>`).
- Gallery renditions (`&variant=thumb|preview`, WebP) are rendered in the background on save and cached next to the original as `<file>.<variant>.v1.webp`; files saved before this existed are rendered on first request. Video stills need ffmpeg (`FFMPEG_PATH`, shipped in the Docker image); without it videos have `thumbnail_url: null`.

## 7b. Runs: multi-agent jobs (core/runs/)

Design: `docs/DESIGN_RUNS.md`. Implemented: the engine, the council, deep research and short films.

- Tables `runs` (kind, status `queued|running|awaiting_input|completed|failed|cancelled`, input, state, result, credits,
  optional `conversation_id`/`message_id`) and `run_steps` (unique `(run_id, key)`, output, hidden conversation, credits).
- A kind's `execute(rc)` is plain TypeScript. `rc.step(key, …)` runs once per key: a completed step returns its stored
  output, so re-entering `execute` resumes (restart: `RunService.start()` re-queues `queued`/`running` runs; input:
  `rc.awaitInput` pauses as `awaiting_input` until `POST /runs/:id/input`). Retryable failures are retried twice with
  backoff (`RUN_RETRY_BASE_MS`). `rc.optional(p)` turns a failure into `undefined` (one of many answers) but lets a cancel through.
- `rc.turn` / `rc.turnJson` = one hidden one-shot turn (`metadata.purpose: "run"`), through `RunService.turnSlots`
  (`RUN_TURN_CONCURRENCY`, separate from user chat). `turnJson` validates the reply with Zod; a reply that does not parse
  is a retryable failure and the retry is told what was wrong. Hidden turns may use Folax chat models (`allowFolax`).
- Events: an in-memory replayable `RunHandle` per executing run (+ bus topic `run:<id>`) → `GET /runs/:id/events`.
  Cancel aborts the run's signal: waiting turn slots reject, live hidden turns are interrupted.
- **Virtual chat models** (`council`, `council-debate`; `VIRTUAL_CHAT_MODELS` in models.ts): `TurnRunner` dispatches a turn
  on such a model to a handler registered by `RunService.registerVirtualModel`. It creates a priority run linked to the
  conversation (input = the message + a transcript of the last 40 messages), forwards run events as `run.event`,
  `run.text.delta` as `text.delta`, and returns `result.text`; the TurnRunner persists the reply as usual. Interrupt →
  cancel. If the process restarts mid-run, the resumed run posts the reply message itself (same `message_id`).
  The conversation's Qoder session is detached on a virtual turn (the next Qoder turn replays the history).
- **Council** (`council.ts`): members = every active Qoder model deduplicated by display name (+ Folax chat models when
  the message fits them) answer in parallel (`answer:<model>`) → optional debate rounds (`debate:<r>:<model>`) → judges
  (`COUNCIL_JUDGES`, Qoder only) get the answers shuffled per judge (deterministic seed) and labelled A, B, …, reply JSON
  (`judge:<i>:<model>`) → Borda count, ties by mean score → synthesizer (`COUNCIL_SYNTHESIZER`) merges the top 3
  (falls back to the winner) → `council_results` rows (`stats`) for `GET /admin/council/leaderboard`. Debate replies start
  with `VERDICT: kept|revised` (`parseDebate`, streamed as `debate.delta`); judge 0 runs on the `research` profile (sandbox
  checks); `judgeQuality` marks lazy judges (label-order ranking, flat scores) and `aggregate` weighs them ¼;
  `result.judges` / `result.agreement` expose every judge's scores and how much they agree.
- **Deep research** (`research.ts`, virtual models `research`/`research-deep`): `plan` (JSON: sub-questions + outline;
  optional `plan_review` input) → `research:<qid>` agents on the `research` profile (WebSearch/WebFetch sandbox) reply
  JSON findings with URLs → `gap:<round>` adds follow-up questions → (`deep`) `verify:<i>` re-checks medium/low claims →
  sources deduplicated and numbered in question order (stable on resume) → `section:<i>` writers in parallel (only the
  findings/sources they cover) → `edit` merges (streamed) + a code-built "Sources" list → `save_md` (MediaStore) →
  `render` (sandbox pandoc/LibreOffice → PDF/DOCX via DeliverArtifacts; `TurnStepOutput.files`). `result.files` become
  the chat reply's artifacts. `notify: true` → push/FCM when done.
- **Short film** (`film.ts`, `assembler.ts`; API only, no chat model — it can take longer than a turn's 45 min):
  `script` + `script_revise` (JSON, then `normalize`: 3–10 s scenes, ≤ 24, unknown character ids dropped) → `cast:<id>`
  image jobs (from a saved face when cast) → `frame:<n>` keyframes (image edits with the scene's cast sheets) checked by
  `check:frame:<n>` (vision JSON score; < 3 → `frame:<n>:fix`) → optional `storyboard_review:<round>` input (redo →
  `frame:<n>:redo<round>`) → `clip:<n>` VideoGen first-frame jobs (last frame = next keyframe for continuous shots) →
  `title_card` → `assemble` (local: `FfmpegAssembler` normalises every clip to the film size/30 fps/AAC stereo, adds
  silence where a clip has no audio, then one `joinArgs` graph joins them: `concat` for cuts, `xfade`/`acrossfade` for
  the scenes the writer marked `dissolve`, fade in/out only at the film's edges, loudnorm; captions go in as a mov_text
  track timed by `joinPlan`). Scene length follows `pacing` (`PACING`, clamped in `normalize`) → the film is stored and recorded as a completed gallery video job (`MediaService.recordVideo`).
  `rc.mediaJob` stores the job id on the step at once, so a resumed run waits for the same job (videos cannot be
  cancelled upstream); a failed job clears it and the retry starts a new one. Jobs with `request.run_id` are hidden from
  gallery lists and never notify devices; `result.open_path` is where the run's push notification opens.

## 8. Webhooks / n8n (core/webhooks.ts)

- Per-request `callback_url` on video/image jobs (works with n8n *Wait → On webhook call* using `$execution.resumeUrl`).
- Per-user webhook endpoints (`/api/v1/webhooks`) for `video.completed`, `video.failed`, `image.completed`, `image.failed`, `run.completed`, `run.failed`; admins also get `model.*` and `provider.degraded`.
- Delivery: POST JSON `{id, type, created_at, data}`, header `X-StillGPT-Signature: sha256=<hex HMAC(secret, raw body)>`, retries 1m/5m/30m.
- n8n can also simply use the OpenAI credential type pointing at `https://<host>/v1` (Chat Model / OpenAI nodes).

### Qoder housekeeping (core/housekeeping.ts)

- Qoder keeps every upload and agent-produced file (ImageGen intermediates included) until deleted, but we already hold local
  copies of everything we use. Settings `{enabled, retentionHours, intervalHours}` live in `kv` (`housekeeping.settings`), edited via
  `GET|PATCH /admin/housekeeping`; until an admin saves, the env defaults apply (`QODER_RETENTION_HOURS`, default 24;
  `QODER_HOUSEKEEPING_INTERVAL_HOURS`, default 24, `0` = disabled). The scheduler ticks 60 s after boot and then every 10 min, and runs
  a pass when enabled and `intervalHours` have passed since `kv.housekeeping.last_run` (so restarts don't reset the clock).
  `POST /admin/housekeeping/run` runs one now (`dry_run` = report only). A pass:
  1. archive our sessions (agent name `qr-*`) idle longer than the retention and not busy locally; their
     conversations drop `qoder_session_id`, so the next message opens a new session with the history preamble;
  2. `DELETE /files/{id}` for our files older than the window: session-scoped files of our sessions, plus unscoped uploads we know
     (`files.qoder_file_id`). Qoder answers **409** while a live session mounts a file, so in-use files are skipped. Deleted ids are
     cleared locally and re-uploaded on demand.
- Verified 2026-11-16: deleting a mounted file → 409 `File is referenced by an active session`; after `POST /sessions/{id}/archive`
  (status `terminated`) the same delete → 200 `file_deleted`. `ensureSession` treats an archived/terminated session as lost.
- Trade-off: after a session is archived, images from older turns are no longer in the sandbox; the user re-attaches one to edit it.

### Gallery trash and media housekeeping (core/trash.ts, core/mediaHousekeeping.ts)

- Deleting from the gallery is a soft delete: `media_jobs.deleted_at/deleted_by` hides the job; its output files get
  `files.deleted_at`, which makes `MediaStore.get` treat them as missing (user URLs 404 at once). Exception: an output a
  non-archived chat message shows is not hidden. `restore` clears both. Admin trash URLs are signed with a `trash` scope
  (`sig` over `id.exp.trash`, `&scope=trash`) and are the only way to serve a hidden file.
- Purge = delete the job row and its hidden `image`/`video` conversation, then remove each output from disk (original +
  cached variants) and DB **only if nothing else uses it**: any remaining job (output, `input_file_ids`,
  `reference_file_ids`, first/last frame; trashed jobs count, so a restore never finds holes) or a message in a visible,
  non-archived chat (`content`/`artifacts` jsonb containment). Kept files stay hidden and a later pass sweeps them.
- `MediaHousekeeper` mirrors the Qoder housekeeper (settings in `kv` `media_housekeeping.settings`, built-in defaults, ticks
  2 min after boot then every 10 min, `media_housekeeping.last_run`). A pass: trash old failed jobs (and, if
  `retentionDays` > 0, old finished jobs) as `system` → purge trash older than `trashGraceDays` → remove media of chats
  archived longer than `archivedChatMediaDays` → remove uploads older than `unusedUploadDays` that no job or chat
  (archived ones included) uses → sweep hidden files past the grace period. Each step handles ≤ 2000 rows.

### Qoder credential (core/qoderCredential.ts)

- `QoderCredentialService` is the `QoderClient`'s `TokenProvider`: `QODER_SA_KEY` → admin PAT (`kv.qoder.pat`) → `QODER_PAT`.
  Neither set is allowed at boot; Qoder calls then fail with 503 `qoder_not_configured` until an admin sets a PAT.
- `PUT /admin/qoder/credential` probes the PAT (`GET /environments`, no retries) before saving, refuses while conversations are `busy` or
  media jobs `in_progress` unless `force`, and on a fingerprint change runs `agents.syncAccount` (drop cached env/agents) + `models.sync`.
- The PAT is stored in plaintext in `kv` (like the web session cookie) and never returned by the API.

### Qoder credits (core/qoderCredits.ts)

- The account's remaining credits and per-request history are only on qoder.com's web dashboard API
  (`GET /api/v2/me/usages/big_model_credits`, `GET /api/v1/me/usages/big_model_credits/histories`). Verified 2026-11-16: they reject
  PAT (401), `api.qoder.com` / `openapi.qoder.sh` have no equivalent for PATs, and the browser cookie `qoder_session_cookie` alone
  works from the server (no anti-bot cookies, CSRF header or browser User-Agent needed).
- The cookie comes from `kv.qoder.web_session` (pasted by an admin via `PUT /admin/qoder/session`) or else `QODER_WEB_SESSION`.
  Its first base64url segment is the issue time in Unix seconds; the expiry is unknown, so a 401 becomes `status: "session_expired"`.
- `GET /admin/qoder/credits` caches for 5 min and keeps the last good reading (`stale: true`) when a fetch fails. History is not cached.

## 9. Auth & users

- Users: `email`, scrypt `password_hash`, `role admin|user`, `monthly_credit_limit` (null = unlimited). First admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
- PWA: `POST /api/v1/auth/login` → `{access_token (JWT, 15 min), refresh_token (opaque, 30 d, stored hashed)}`; `/auth/refresh`, `/auth/logout`.
- Passkeys (`auth/passkeys.ts`): usernameless WebAuthn sign-in (`/auth/passkey/options|verify`, discoverable credentials, user
  verification required) issuing the same token pair. Credentials in `passkeys` (public key, counter, AAGUID → provider name),
  one-time challenges in `webauthn_challenges` (5 min, deleted on use, so ceremonies survive restarts). RP ID = the frontend's
  domain (`PASSKEY_RP_ID`, default the first https `CORS_ORIGINS` host); `localhost` origins use RP ID `localhost`.
- API keys `qr_<random>` (sha256 stored, shown once) for n8n/SDKs. Accepted as `Authorization: Bearer` or `x-api-key`.
- Every route resolves `c.get('user')`; admin routes require `role=admin`.

## 10. Errors

Internal `AppError(status, code, message)`; renderers:
- native: `{error:{code, message}}`
- OpenAI: `{error:{message, type, code, param:null}}`
- Anthropic: `{type:"error", error:{type, message}}`
Upstream Qoder errors are mapped (401→`upstream_auth`, 429/503→`upstream_unavailable` retryable, model unavailable→handled by fallback).

## 11. Config (env)

`PORT`, `PUBLIC_BASE_URL`, `DATABASE_URL` (postgres://… or `pglite://<dir>` or `pglite://memory`), `QODER_BASE_URL`,
`QODER_PAT` **or** `QODER_SA_KEY` (+`QODER_OPENAPI_BASE_URL`; the PAT may also be left empty and set by an admin via `/admin/qoder/credential`), `QODER_ENVIRONMENT_ID` (optional; auto-created as `stillgpt`),
`JWT_SECRET`, `MEDIA_DIR`, `MEDIA_SIGNING_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DEFAULT_PROFILE_NATIVE=assistant`, `DEFAULT_PROFILE_COMPAT=chat`,
`MODEL_ALIASES`, `MODEL_SYNC_INTERVAL_MIN`, `VIDEO_CONCURRENCY`, `RUN_CONCURRENCY=4`, `RUN_TURN_CONCURRENCY=12`, `RUN_RETRY_BASE_MS=1000`,
`COUNCIL_JUDGES=smart,kmodel_latest,gmodel`, `COUNCIL_SYNTHESIZER=smart`, `RESEARCH_PLANNER=smart`, `RESEARCH_WORKER=default`, `RESEARCH_WRITER=smart`, `FILM_WRITER=smart`, `SESSION_BUDGET_CREDITS` (optional per-session cap), `QODER_RETENTION_HOURS` / `QODER_HOUSEKEEPING_INTERVAL_HOURS` (Qoder housekeeping defaults, 24 / 24; admins override them via `/admin/housekeeping`), `CORS_ORIGINS`,
`FOLAX_URL` + `FOLAX_API_KEY` (optional, both or neither; folax-adapter base URL and its `X-API-Key` — the Folax provider is disabled when unset),
`FACESWAP_URL` + `FACESWAP_API_KEY` (optional faceswap sidecar, `providers/faceswap.ts`; engines `swapper`/`swapper_polish`/`qoder_crop` are unavailable when unset; empty key = no auth),
`VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (+ `VAPID_SUBJECT`, default `PUBLIC_BASE_URL`; Web Push "creation ready" notifications, `core/push.ts`, off when unset),
`FCM_SERVICE_ACCOUNT_B64` (base64 Firebase service-account JSON; FCM "creation ready" notifications to the Android app, `core/fcm.ts`, off when unset),
`FACESWAP_CONCURRENCY=2`, `FACESWAP_TIMEOUT_MS=120000`, `HEAD_SWAP_TURN_CONCURRENCY=6` (head swap candidate Qoder turns in flight), `FACESWAP_GPU_URL` + `FACESWAP_GPU_API_KEY` (optional GPU box for `/v1/swap` and `/v1/head-composite`), `FACESWAP_GPU_TIMEOUT_MS=90000`,
`UPSCALE_GPU_URL` + `UPSCALE_GPU_API_KEY` (optional GPU upscaler; upscale is available when it or `FACESWAP_URL` is set),
`UPSCALE_GPU_TIMEOUT_MS=240000`, `UPSCALE_CPU_TIMEOUT_MS=600000`,
`IMAGE_PROVIDER_DEFAULT=auto` (`auto|qoder|folax`; `folax` requires the Folax variables),
`AUTO_TITLE=true` + `AUTO_TITLE_WAIT_MS=5000` (non-streaming replies only) + `AUTO_TITLE_QODER_MS=45000` (ChatGPT-style
chat titles, `core/titler.ts`, model alias `titler`; runs on a hidden conversation in parallel with the first native
turn and is announced mid-stream as soon as it exists; Folax `gemini` names it when Qoder fails or is slower than
`AUTO_TITLE_QODER_MS`; `metadata.title_source` = `auto` | `user`, a user rename pins it).

## 12. Testing

- `test/mock-qoder`: an in-process fake of the Cloud Agents API (models, environments, agents, sessions + patch, events send/list/stream with
  deltas and Last-Event-ID, files upload/content/resources, artifacts). Behaviour is scripted per user message (e.g. text containing `[[image]]` → ImageGen + artifact).
- `test/e2e`: boot `createApp` with PGlite in-memory + mock Qoder on random ports; drive it with the official `openai` and `@anthropic-ai/sdk` clients and plain fetch for the native API.
- `test/live`: `QODER_LIVE=1 QODER_PAT=… npm run test:live` — cheap smoke against real Qoder using model `efficient`.
