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
  auth/                    passwords (scrypt), jwt (jose), apiKeys, middleware (resolveUser)
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
    storage.ts             local media store + HMAC signed URLs
    media.ts               image + video jobs (background worker, resumable; Qoder or Folax for images)
    enhancer.ts            prompt enhancer (idea → detailed prompt + aspect ratio)
    webhooks.ts            outgoing webhooks (HMAC-signed), per-request callback_url
    usage.ts               credit accounting + per-user limits
    bus.ts                 in-memory pub/sub for live turn/job events
  providers/
    folax.ts               FolaxClient: folax-adapter sidecar (fast external image generator)
  routes/
    health.ts
    native/                /api/v1/*  (PWA, Flutter, n8n)
    openai/                /v1/chat/completions, /v1/models, /v1/images/*, /v1/videos*
    anthropic/             /v1/messages, /v1/messages/count_tokens
    media.ts               GET /media/:id (signed URL)
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
- Token counts are not exposed by Qoder: `usage` tokens are estimates (chars/4) and we add `stillgpt.credits`.
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
  and one request at a time (calls are serialised in-process by `FolaxClient`). A Folax job runs no Qoder turn: the images are saved as
  artifacts of the job and usage is recorded with 0 credits (model `folax`). `auto` = Folax for text-to-image when configured, Qoder
  otherwise, and Qoder as transparent fallback when Folax fails; edits always use Qoder. `request.provider`, `provider_used` and
  `fallback_reason` record the decision. Folax `AUTH_INVALID` emits the admin webhook `provider.degraded` (throttled to 1/h).
- Prompt enhancer (`core/enhancer.ts`, `POST /api/v1/prompts/enhance`): one turn on a hidden `chat` conversation with the `enhancer` model
  alias that rewrites an idea into an English prompt + aspect ratio (image size, or video ratio/seconds). `enhance: true` on
  image/video jobs runs it at creation time; its size/ratio/seconds apply only where the request left them unset, and
  `request.original_prompt` keeps the input.
- Videos are **jobs**: table `media_jobs` (status `queued|in_progress|completed|failed`, qoder session id, last event id, progress, result artifact, error, `callback_url`).
  A worker runs them with concurrency `VIDEO_CONCURRENCY` (default 1 — the Qoder account allows ~1 concurrent video; a full upstream queue is retried automatically) and **resumes** in-flight jobs after restart by reading session events.
- Artifacts are downloaded from Qoder and stored under `MEDIA_DIR`; served via `GET /media/:id?exp&sig` (HMAC signed, no auth header needed → works in `<img>`/`<video>`).

## 8. Webhooks / n8n (core/webhooks.ts)

- Per-request `callback_url` on video/image jobs (works with n8n *Wait → On webhook call* using `$execution.resumeUrl`).
- Per-user webhook endpoints (`/api/v1/webhooks`) for `video.completed`, `video.failed`, `image.completed`, `image.failed`; admins also get `model.*` and `provider.degraded`.
- Delivery: POST JSON `{id, type, created_at, data}`, header `X-StillGPT-Signature: sha256=<hex HMAC(secret, raw body)>`, retries 1m/5m/30m.
- n8n can also simply use the OpenAI credential type pointing at `https://<host>/v1` (Chat Model / OpenAI nodes).

## 9. Auth & users

- Users: `email`, scrypt `password_hash`, `role admin|user`, `monthly_credit_limit` (null = unlimited). First admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
- PWA: `POST /api/v1/auth/login` → `{access_token (JWT, 15 min), refresh_token (opaque, 30 d, stored hashed)}`; `/auth/refresh`, `/auth/logout`.
- API keys `sg_<random>` (legacy `qr_` keys stay valid) (sha256 stored, shown once) for n8n/SDKs. Accepted as `Authorization: Bearer` or `x-api-key`.
- Every route resolves `c.get('user')`; admin routes require `role=admin`.

## 10. Errors

Internal `AppError(status, code, message)`; renderers:
- native: `{error:{code, message}}`
- OpenAI: `{error:{message, type, code, param:null}}`
- Anthropic: `{type:"error", error:{type, message}}`
Upstream Qoder errors are mapped (401→`upstream_auth`, 429/503→`upstream_unavailable` retryable, model unavailable→handled by fallback).

## 11. Config (env)

`PORT`, `PUBLIC_BASE_URL`, `DATABASE_URL` (postgres://… or `pglite://<dir>` or `pglite://memory`), `QODER_BASE_URL`,
`QODER_PAT` **or** `QODER_SA_KEY` (+`QODER_OPENAPI_BASE_URL`), `QODER_ENVIRONMENT_ID` (optional; auto-created as `stillgpt`),
`JWT_SECRET`, `MEDIA_DIR`, `MEDIA_SIGNING_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DEFAULT_PROFILE_NATIVE=assistant`, `DEFAULT_PROFILE_COMPAT=chat`,
`MODEL_ALIASES`, `MODEL_SYNC_INTERVAL_MIN`, `VIDEO_CONCURRENCY`, `SESSION_BUDGET_CREDITS` (optional per-session cap), `CORS_ORIGINS`,
`FOLAX_URL` + `FOLAX_API_KEY` (optional, both or neither; folax-adapter base URL and its `X-API-Key` — the Folax provider is disabled when unset),
`IMAGE_PROVIDER_DEFAULT=auto` (`auto|qoder|folax`; `folax` requires the Folax variables),
`AUTO_TITLE=true` + `AUTO_TITLE_WAIT_MS=5000` (ChatGPT-style chat titles, `core/titler.ts`, model alias `titler`;
runs on a hidden conversation in parallel with the first native turn; `metadata.title_source` = `auto` | `user`, a user rename pins it).

## 12. Testing

- `test/mock-qoder`: an in-process fake of the Cloud Agents API (models, environments, agents, sessions + patch, events send/list/stream with
  deltas and Last-Event-ID, files upload/content/resources, artifacts). Behaviour is scripted per user message (e.g. text containing `[[image]]` → ImageGen + artifact).
- `test/e2e`: boot `createApp` with PGlite in-memory + mock Qoder on random ports; drive it with the official `openai` and `@anthropic-ai/sdk` clients and plain fetch for the native API.
- `test/live`: `QODER_LIVE=1 QODER_PAT=… npm run test:live` — cheap smoke against real Qoder using model `efficient`.
