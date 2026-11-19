# StillGPT API reference

This is the reference for the **native API**: the API our own apps use (the PWA now, Flutter later) and that n8n can call.
StillGPT also serves OpenAI- and Anthropic-compatible endpoints for existing tools; they are listed briefly in
[§13](#13-openai--and-anthropic-compatible-endpoints).

- [1. Basics](#1-basics)
- [2. Authentication](#2-authentication)
- [3. Account, API keys, usage](#3-account-api-keys-usage)
- [4. Models](#4-models)
- [5. Conversations](#5-conversations)
- [6. Messages and streaming](#6-messages-and-streaming)
- [7. Files and attachments](#7-files-and-attachments)
- [8. Media jobs (images and videos)](#8-media-jobs-images-and-videos)
- [9. Webhooks](#9-webhooks)
- [10. Admin](#10-admin)
- [11. Errors](#11-errors)
- [12. Limits and latencies](#12-limits-and-latencies)
- [13. OpenAI- and Anthropic-compatible endpoints](#13-openai--and-anthropic-compatible-endpoints)
- [14. n8n recipes](#14-n8n-recipes)

---

## 1. Basics

| | |
|---|---|
| Base URL | `https://<host>/api/v1` (local dev: `http://localhost:8790/api/v1`) |
| Format | JSON in and out, **snake_case** field names, timestamps are ISO-8601 UTC strings |
| Auth | `Authorization: Bearer <access_token or API key>` (the `x-api-key: <API key>` header also works) |
| Errors | `{"error": {"code": "…", "message": "…"}}`, see [§11](#11-errors) |
| CORS | Allowed origins are set by `CORS_ORIGINS` on the server. `Last-Event-ID` is an allowed request header. These response headers are exposed: `X-Request-Id`, `X-StillGPT-Conversation`, `X-StillGPT-Model`, `X-StillGPT-Credits` |
| Request id | Every response has an `X-Request-Id` header. Include it in bug reports |

IDs have a type prefix: `usr_…`, `conv_…`, `msg_…`, `file_…`, `img_…` / `vid_…` (jobs), `wh_…`, `key_…`.

**Credits.** Qoder bills in credits rather than tokens. Responses report `credits` as numbers, for example `0.01`.
An admin can give each user a monthly credit limit.

---

## 2. Authentication

There are two kinds of credentials:

| Credential | Use it for | Lifetime |
|---|---|---|
| **Access token** (JWT) from `/auth/login` or `/auth/passkey/verify` | Apps where a person signs in (PWA, Flutter) | 15 min (`expires_in` seconds), renewed with the refresh token |
| **API key** `qr_…` from `/api-keys` | Server-to-server calls: n8n, scripts, SDKs | Valid until revoked |

### POST /auth/login
```json
{ "email": "me@example.com", "password": "correct horse" }
```
→ `200`
```json
{
  "user": { "id": "usr_…", "email": "me@example.com", "display_name": "Me", "role": "user",
            "monthly_credit_limit": null, "disabled": false, "created_at": "2026-11-14T10:00:00.000Z" },
  "access_token": "eyJhbGciOiJIUzI1NiJ9…",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "rt_…"
}
```
A wrong email or password returns `401 unauthorized`. A disabled account gets the same response.

### POST /auth/refresh
```json
{ "refresh_token": "rt_…" }
```
→ `200 {access_token, token_type, expires_in, refresh_token}`. **Refresh tokens rotate:** the token you send is revoked
and the response contains a new one, so always store the new one. If you reuse an old refresh token, you get `401`.

### POST /auth/logout
```json
{ "refresh_token": "rt_…" }
```
→ `204`. This revokes the refresh token. The current access token stays valid until it expires (at most 15 min).

### Passkeys (sign in with fingerprint / Face ID)
A passkey replaces the password: the user taps "Sign in with passkey", confirms with fingerprint, face or device PIN, and is
signed in. No email is typed: the browser shows the passkeys it holds for this site and the chosen one identifies the user.
Passkeys are WebAuthn credentials bound to the **frontend's domain** (the RP ID, `stillgpt.ayenz.my.id` on prod;
`localhost` for `http://localhost:*` dev origins listed in `CORS_ORIGINS`). Use `@simplewebauthn/browser` on the client:
the `options` objects below go straight into it and its results go straight back.

**Sign in** (no auth header):
| Step | Call | Body | Response |
|---|---|---|---|
| 1 | `POST /auth/passkey/options` | – | `{challenge_id, options}` (`options` = `PublicKeyCredentialRequestOptionsJSON`, no `allowCredentials`) |
| 2 | browser | `startAuthentication({ optionsJSON: options })` | `response` |
| 3 | `POST /auth/passkey/verify` | `{challenge_id, response}` | same as `/auth/login`: `{user, access_token, token_type, expires_in, refresh_token}` |

**Add a passkey** (signed in, e.g. Settings → Security):
| Step | Call | Body | Response |
|---|---|---|---|
| 1 | `POST /me/passkeys/options` | – | `{challenge_id, options}` (`PublicKeyCredentialCreationOptionsJSON`) |
| 2 | browser | `startRegistration({ optionsJSON: options })` | `response` |
| 3 | `POST /me/passkeys` | `{challenge_id, response, name?}` | `201 passkey` |

**Manage:** `GET /me/passkeys` → `{data: [passkey]}` · `PATCH /me/passkeys/:id {name}` → `passkey` · `DELETE /me/passkeys/:id` → `204`.
`passkey` = `{id, name, provider, synced, backed_up, created_at, last_used_at}`. `name` defaults to the provider
(`"iCloud Keychain"`, `"Google Password Manager"`, `"Windows Hello"`, `"1Password"`, …, else `"Passkey"`); `provider` is
`null` when unknown; `synced` = available on the user's other devices through that provider.

Errors:
| status / code | when | UI |
|---|---|---|
| `400 invalid_challenge` | challenge expired (5 min), already used, or from another session | restart the flow |
| `400 passkey_invalid` | registration response did not verify (no user verification, wrong origin…) | "Couldn't add the passkey" |
| `401 passkey_not_found` | sign-in with a passkey we do not know (removed here, or for a deleted account) | "This passkey was removed. Sign in another way"; optionally `PublicKeyCredential.signalUnknownCredential` |
| `401 unauthorized` | signature/origin check failed, account disabled | generic sign-in error |
| `403 origin_not_allowed` | request `Origin` is not in `CORS_ORIGINS` / `PASSKEY_ORIGINS` | config problem |
| `409 passkey_exists` / `too_many_passkeys` (20) | | |
| `409 last_sign_in_method` | deleting the only passkey of an account without password | "Set a password or add another passkey first" |
| `503 passkeys_not_configured` | server has no https origin / `PASSKEY_RP_ID` | hide passkey UI (`/me` → `sign_in.passkeys_available`) |

- Challenges are single-use and expire after 5 minutes. User verification (biometric/PIN) is always required.
- Config: `PASSKEY_RP_ID` (default: host of the first https `CORS_ORIGINS` entry; **changing it orphans existing passkeys**),
  `PASSKEY_RP_NAME` (default `StillGPT`), `PASSKEY_ORIGINS` (default: `CORS_ORIGINS` minus `*`).
- Native apps (Flutter) use the same endpoints without an `Origin` header (RP ID = the configured domain). Configure
  `PASSKEY_ANDROID_PACKAGE` + `PASSKEY_ANDROID_CERT_SHA256` (each certificate becomes an allowed `android:apk-key-hash:…`
  origin) and `PASSKEY_IOS_APP_IDS` (`TEAMID.bundle.id`). The backend renders the matching association files at
  `GET /.well-known/assetlinks.json` and `GET /.well-known/apple-app-site-association` (404 until configured). They must be
  published unchanged on the RP domain (the web app). See `docs/handoff/flutter-passkeys.md`.
- Admin (lost device): `GET /admin/users/:id/passkeys`, `DELETE /admin/users/:id/passkeys/:passkeyId` (no last-method guard;
  set a password for the user with `PATCH /admin/users/:id` if needed).

### Client guidance
- **PWA:** keep the access token in memory only. Put the refresh token in IndexedDB or `localStorage`, and accept the XSS
  trade-off, or wrap it with a service worker. When the app loads, call `/auth/refresh`. When any call returns `401`,
  refresh **once** and retry. If the refresh also fails, send the user to the login screen.
  Run only one refresh at a time: refresh tokens rotate, so two parallel refreshes would invalidate each other.
- **Flutter:** keep the refresh token in `flutter_secure_storage` (Keychain or Keystore). Otherwise follow the same flow.
  `package:http` and `dio` both work. For SSE, read the streamed response body line by line (see §6).
- **n8n / servers:** create an API key once with `POST /api-keys` and send it as `Authorization: Bearer qr_…`.
  API keys skip the refresh flow.

---

## 3. Account, API keys, usage

### GET /me
```json
{
  "user": { "id": "usr_…", "email": "…", "display_name": "…", "role": "user", "monthly_credit_limit": 50,
            "disabled": false, "created_at": "…" },
  "usage": { "period_start": "2026-11-01T00:00:00.000Z", "credits_used": 1.23, "credits_limit": 50,
             "by_kind": { "chat": { "credits": 0.4, "requests": 31 }, "image": { "credits": 0.83, "requests": 12 } } },
  "sign_in": { "password": true, "passkeys": 1, "passkeys_available": true }
}
```
`sign_in`: which sign-in methods the account has (`passkeys` = count) and whether the server supports passkeys.

### PATCH /me
```json
{ "display_name": "New name", "password": "new-password", "current_password": "old-password" }
```
Every field is optional. Changing `password` also requires `current_password`: if it is missing you get
`400 validation_error`, and if it is wrong you get `401`. → `200 {user}`

### GET /usage
Returns the same usage object as `/me` (this calendar month, UTC).

### API keys
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api-keys` | – | `{data: [{id, name, prefix, created_at, last_used_at}]}` |
| POST | `/api-keys` | `{name}` | `201 {id, name, prefix, key, created_at}`. **`key` is returned only this once** |
| DELETE | `/api-keys/:id` | – | `204` (or `404`) |

`prefix` holds the first 10 characters of the key, so a UI can tell keys apart.

---

## 4. Models

### GET /models
```json
{
  "data": [
    { "id": "efficient", "display_name": "Efficient", "price_factor": 0, "vision": true,
      "efforts": ["low", "high"], "default_effort": "high", "context_window": 200000,
      "max_input_tokens": 200000, "is_new": false }
  ],
  "aliases": [
    { "alias": "default", "resolves_to": "auto", "chain": ["auto", "efficient"] },
    { "alias": "smart", "resolves_to": "ultimate", "chain": ["ultimate", "kmodel_latest", "auto"] },
    { "alias": "fast", "resolves_to": "fast", "chain": ["fast", "qfmodel", "efficient"] },
    { "alias": "cheap", "resolves_to": "efficient", "chain": ["efficient", "qfmodel", "dfmodel"] },
    { "alias": "vision", "resolves_to": "auto", "chain": ["auto", "efficient"] }
  ],
  "default_model": "default",
  "image_providers": [
    { "id": "qoder", "available": true, "edits": true, "images_per_call": 1, "max_n": 10, "sizes": ["1024x1024", "…"] },
    { "id": "folax", "available": true, "edits": false, "images_per_call": 2, "max_n": 10,
      "ratios": ["1:1", "4:3", "3:4", "16:9", "9:16"], "prompt_max": 1500 }
  ],
  "default_image_provider": "auto"
}
```
- In the UI, offer the **aliases** first. They keep working when Qoder retires or renames models.
- You can also use a raw model id (`ultimate`) or a namespaced one (`qoder/ultimate`). If that model has been
  retired, the turn falls back to the `default` chain and the stream sends a `model.fallback` event (see §6).
- `price_factor` is the relative credit cost. `0` means the model is free.
- `image_providers` lists the image generators (see §8). `folax` is `available: false` when the server has no Folax
  configured; a UI can then hide the provider switch.

---

## 5. Conversations

A conversation keeps its own server-side context. Each new message sends **only the new user message**, never the
history.

Conversation object:
```json
{
  "id": "conv_…", "title": "Trip to Bali", "model": "smart", "resolved_model": "ultimate",
  "profile": "assistant", "system_prompt": null, "status": "idle",
  "created_at": "…", "updated_at": "…"
}
```
- `profile`:
  - `assistant` (the default) can use tools: web search and fetch, reading attached files, image and video generation,
    and delivering files.
  - `chat` is a plain LLM, which makes it the fastest.
- `status` is `busy` while a reply is being generated.
- `resolved_model` is the actual Qoder model behind the alias. It is `null` until the first turn.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/conversations` | `?limit=20` (max 100) `&before=<next_cursor>` | `{data: [conversation], has_more, next_cursor}` (newest first) |
| POST | `/conversations` | `{title?, model? = "default", profile? = "assistant", system_prompt?}` | `201 conversation` |
| GET | `/conversations/:id` | – | conversation |
| PATCH | `/conversations/:id` | any of `{title, model, profile, system_prompt}` | conversation |
| DELETE | `/conversations/:id` | – | `204` (archived; it no longer appears) |

**Auto title (ChatGPT style).** When a conversation has no title, its first message is named by a fast model
(alias `titler`) in parallel with the reply, in the language of the message, e.g. "Resep Nasi Goreng Kampung".
The stream announces it with a `conversation.title` event right before `turn.completed`, and the non-streaming
response already contains it in `conversation.title`. Until then, and if naming fails or takes longer than ~5 s,
the title is the first 80 characters of the message; a late generated title is still saved, so refetch the list.
A title given at creation or set with `PATCH` (rename) is never overwritten. Only the first message is used.
`model` and `system_prompt` can be changed between turns, and the context is kept.
Media models (`qoder-image`, `qoder-video`) are rejected here with `400 model_not_supported`.

### GET /conversations/:id/messages
Query: `?limit=100` (max 500) `&before=<message id>` for older pages. Messages come oldest first within a page.
```json
{
  "data": [
    { "id": "msg_u1", "role": "user",
      "content": [
        { "type": "text", "text": "What is in this picture?" },
        { "type": "image", "file_id": "file_…", "mime_type": "image/png", "url": "https://<host>/media/file_…?exp=…&sig=…" },
        { "type": "file", "file_id": "file_…", "filename": "report.pdf", "mime_type": "application/pdf", "url": "…" }
      ],
      "artifacts": [], "model": null, "credits": null, "stop_reason": null, "error": null, "created_at": "…" },
    { "id": "msg_a1", "role": "assistant",
      "content": [{ "type": "text", "text": "A cat on a roof." }],
      "artifacts": [{ "id": "file_…", "name": "cat.png", "mime_type": "image/png", "size": 1546107, "kind": "image", "url": "…" }],
      "model": "auto", "credits": 0.06, "stop_reason": "end_turn", "error": null, "created_at": "…" }
  ],
  "has_more": false,
  "conversation": { "...": "conversation object" },
  "running_turn": null
}
```
- While a turn is running, `running_turn` is `{message_id, user_message_id, events}`. To show the live reply, attach
  to `GET /conversations/:id/stream` (§6). The running turn's assistant message is stored only once the turn completes.
- Each response comes with signed `url`s (plus `thumbnail_url` / `preview_url`, see §7), so re-fetch the list instead of caching URLs for weeks.
- `stop_reason` is one of `end_turn`, `interrupted`, `budget_exceeded`, `requires_action` or `error`.
  When it is `error`, the `error` field is `{code, message}`.

---

## 6. Messages and streaming

### POST /conversations/:id/messages
Body: either a list of content blocks…
```json
{ "content": [
    { "type": "text", "text": "Summarise this and describe the photo" },
    { "type": "file", "file_id": "file_pdf…" },
    { "type": "image", "file_id": "file_png…" }
] }
```
…or the shorthand:
```json
{ "text": "Summarise this", "attachments": ["file_pdf…", "file_png…"] }
```
In the shorthand, attachments in a vision format (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) become `image`
blocks, which the model sees directly. Anything else becomes a `file` block: the file is placed in the agent's sandbox
under `/data/attachments/<filename>`, and the agent reads it with tools (PDF, DOCX, XLSX, CSV, and so on).
`file` blocks need a tool-capable conversation. When a `chat` conversation receives one, the server upgrades it
automatically.

There are two response modes.

**A. JSON (default).** The request waits for the whole reply.
```json
{ "message": { "id": "msg_…", "role": "assistant", "content": [{ "type": "text", "text": "…" }], "artifacts": [],
               "model": "auto", "credits": 0.01, "stop_reason": "end_turn", "error": null, "created_at": "…" },
  "conversation": { "...": "conversation object" } }
```
The response headers include `X-StillGPT-Conversation`, `X-StillGPT-Model` and `X-StillGPT-Credits`.
A turn that fails upstream still returns `200`: the message has `stop_reason: "error"` and `error: {code, message}`.

**B. Server-Sent Events.** Send `Accept: text/event-stream`, or add `?stream=true`. Each frame looks like this:
```
id: 3
event: text.delta
data: {"type":"text.delta","text":"Hel"}
```
- `id` is a sequence number within the turn: 1, 2, 3, and so on.
- `event` is the event type. `data` is the same event as JSON.
- Every 15 s the server sends a comment line `: ping` as a heartbeat. Ignore it.
- The stream closes after `turn.completed`.

> **Disconnecting never cancels generation.** If the tab closes or the network drops, the turn keeps running and its
> result is saved. To stop a turn on purpose, use `/interrupt`.

#### Event catalogue
| event | data | notes |
|---|---|---|
| `turn.started` | `{conversation_id, message_id, model}` | always first. `message_id` is the future assistant message id. `model` is the resolved model |
| `model.fallback` | `{requested, resolved, reason}` | the requested model was unavailable and another one is used |
| `thinking` | `{}` | the model is reasoning. Show a spinner |
| `text.delta` | `{text}` | append to the visible reply |
| `text.completed` | `{text}` | one finished text block. A reply can contain several, joined with a blank line |
| `tool.started` | `{id, name, input}` | e.g. `WebSearch`, `Bash`, `ImageGen`, `VideoGen`, `DeliverArtifacts` |
| `tool.completed` | `{id, is_error, output}` | `id` matches `tool.started`. `output` is truncated to 4000 characters |
| `artifact` | `{artifact: {id, name, mime_type, size, kind, url, thumbnail_url, preview_url}}` | a file produced by the agent. `kind` is `image`, `video`, `audio` or `file` |
| `usage` | `{credits: {model, sandbox, total}}` | credits used by this turn |
| `error` | `{code, message, retryable}` | a turn-level error. `turn.completed` still follows |
| `conversation.title` | `{conversation_id, title}` | only on the first turn of an untitled conversation: the auto-generated title (update the sidebar) |
| `turn.completed` | `{message_id, stop_reason, text, artifacts, credits}` | always last. `text` is the full reply |

Example:
```
id: 1
event: turn.started
data: {"type":"turn.started","conversation_id":"conv_…","message_id":"msg_…","model":"auto"}

id: 2
event: thinking
data: {"type":"thinking"}

id: 3
event: text.delta
data: {"type":"text.delta","text":"Halo"}

id: 4
event: text.completed
data: {"type":"text.completed","text":"Halo! Ada yang bisa saya bantu?"}

id: 5
event: usage
data: {"type":"usage","credits":{"model":0.01,"sandbox":0,"total":0.01}}

id: 6
event: turn.completed
data: {"type":"turn.completed","message_id":"msg_…","stop_reason":"end_turn","text":"Halo! Ada yang bisa saya bantu?","artifacts":[],"credits":{"model":0.01,"sandbox":0,"total":0.01}}
```

**Consuming the stream.** Browser `EventSource` cannot send POST requests or an `Authorization` header. Use `fetch` and
read `response.body` instead, for example with the `eventsource-parser` package, or `@microsoft/fetch-event-source`
(which handles reconnects and `Last-Event-ID`). In Flutter, send the request, then read the response through
`utf8.decoder` and `LineSplitter`, splitting frames on blank lines.

### GET /conversations/:id/stream (reattach)
- If a turn is running, this returns the turn's event stream **replayed from the start**. Send `Last-Event-ID: <n>`
  (or `?last_event_id=n`) to get only the events after sequence `n`.
- If the conversation is idle, it returns `204 No Content`.

**Reconnect strategy:**
1. Remember the last `id` you received.
2. When the connection drops, call `GET /conversations/:id/stream` with `Last-Event-ID`. Use a backoff of 1 s, 2 s,
   then 5 s.
3. On `200`, keep appending events.
4. On `204`, the turn already finished: reload `GET /conversations/:id/messages` and render the saved assistant message.
5. After an app restart, `GET …/messages` shows `running_turn`. When it is not null, reattach without `Last-Event-ID`.
   The replay rebuilds the partial reply.

### POST /conversations/:id/interrupt
→ `{"interrupted": true}`, or `false` when nothing was running. The running turn ends with `stop_reason: "interrupted"`.

### Concurrency
A conversation runs one turn at a time. A second `POST …/messages` sent while a turn is running gets
`409 conversation_busy`.

---

## 7. Files and attachments

### POST /files
`multipart/form-data` with a field named `file`. Files can be up to **50 MB**. The stored file is kept at full size;
images bigger than Qoder accepts (~5 MB) are sent upstream as a scaled-down copy in the same format (see limits below).
```bash
curl -H "Authorization: Bearer $TOKEN" -F file=@report.pdf https://<host>/api/v1/files
```
→ `201`
```json
{ "id": "file_…", "filename": "report.pdf", "mime_type": "application/pdf", "size": 182044,
  "kind": "upload", "url": "https://<host>/media/file_…?exp=…&sig=…",
  "thumbnail_url": null, "preview_url": null, "created_at": "…" }
```
For images and videos `thumbnail_url` and `preview_url` are set (see "Thumbnails and previews" below).
If the client sends `application/octet-stream`, the server works out the type from the file extension.

### GET /files/:id
Returns the same object with a signed `url`. You can only see your own files.

### Attachment limits (enforced when the message is sent)
- **Images** (vision input, image edits, video frames/references): PNG, JPEG and WebP up to the 50 MB upload limit.
  Above ~4.5 MB the copy sent to Qoder is scaled down (same format, max 4096 px, usually 1–3 s once per file; later uses
  reuse it). GIFs (may be animated) are not resized: up to 7 MB. Other image formats are mounted as files.
- **Documents** (mounted in the sandbox): up to **5 MB** each, which is the upstream limit. Larger ones get
  `413 attachment_too_large`.
- To attach a file, upload it first, then reference its `file_id` in a message, an image edit, or a video frame.

### Signed media URLs
Every `url` (uploads, artifacts, job outputs) looks like `/media/<file_id>?exp=<unix>&sig=<hmac>`.
- It needs **no auth header**, so it works directly in `<img src>`, `<video src>`, `<a download>` and Flutter
  `Image.network` / `video_player`.
- It is valid for at least 7 days (`MEDIA_URL_TTL_SEC`). The expiry is rounded up to a day boundary, so the same file
  gets the **same URL for a whole day**: the browser cache hits on every reload. Re-fetch the owning object to get a
  fresh URL.
- Responses carry `Cache-Control: private, max-age=<seconds until exp>, immutable` and an `ETag`
  (`If-None-Match` → `304`). Stored files never change.
- Files are streamed from disk, with HTTP `Range` support (`206 Partial Content`), which video seeking on iOS and Safari needs.
- Add `&download=1` to make browsers download the file instead of showing it.
- An expired or tampered URL returns `403 invalid_signature`.

### Thumbnails and previews
Every object with a media `url` (files, message image/file blocks, artifacts, job `outputs`) also has:

| Field | What | Use for |
|---|---|---|
| `thumbnail_url` | WebP that fits 400×400 px | gallery grid tiles, chat bubbles |
| `preview_url` | WebP that fits 1280×1280 px | lightbox / detail view |

- They are the signed `url` plus `&variant=thumb` or `&variant=preview`. Small images are never upscaled.
- For **videos** both are a **still frame** (a poster image), not a video. Use `preview_url` as `<video poster>`.
- `null` for files without renditions: documents, audio, SVG, and videos when the server has no ffmpeg.
- Renditions are made in the background on upload/generation and cached on disk, so usually the first request is
  already fast. Older files are rendered on their first request.
- If an image can't be decoded, the variant URL returns the original image. A video whose frame can't be extracted
  returns `404 variant_unavailable`, so handle `onError` on the tile.
- Unknown `variant` → `400 validation_error`.

---

## 8. Media jobs (images and videos)

Images and videos are **jobs**. Every endpoint returns the same job object:
```json
{
  "id": "vid_…", "kind": "video", "status": "completed", "progress": 100,
  "request": { "prompt": "Waves at sunset", "mode": "text_to_video", "seconds": 5, "resolution": "1080P",
               "ratio": "16:9", "audio": true, "first_frame_file_id": null, "last_frame_file_id": null,
               "reference_file_ids": [] },
  "outputs": [{ "id": "file_…", "name": "waves.mp4", "mime_type": "video/mp4", "size": 10069783, "kind": "video",
                "url": "https://<host>/media/file_…?exp=…&sig=…",
                "thumbnail_url": "https://<host>/media/file_…?exp=…&sig=…&variant=thumb",
                "preview_url": "https://<host>/media/file_…?exp=…&sig=…&variant=preview" }],
  "error": null, "credits": 0.21, "batch_id": null, "created_at": "…", "completed_at": "…"
}
```
- `status` moves from `queued` to `in_progress`, then to `completed` or `failed`. A failed job has
  `error: {code, message}` and `outputs: []`.
- `progress` (0–100) is **estimated from elapsed time**, because Qoder does not report real progress. It stays at 95 or
  below until the job finishes.

### POST /prompts/enhance
The "✨ Enhance" button: turns a short idea (Indonesian or English) into a detailed English generation prompt and
suggests a shape for it. Takes 2–10 s and a few credits (one chat turn on the `enhancer` model alias).

| field | type | default | notes |
|---|---|---|---|
| `prompt` | string | required | the user's idea, up to 4000 characters |
| `kind` | `image` \| `video` | `image` | |
| `purpose` | string | – | optional hint, e.g. `"poster"`, `"instagram post"` |
| `style` | string | – | optional hint, e.g. `"flat illustration"` |
| `model` | string | `enhancer` | model alias or id for the rewrite; omit to use our default |
| `input_file_ids` | string[] | – | image: the images being edited (≤ 3). Switches to `mode: "edit"` |
| `first_frame_file_id` | string | – | video: the frame it starts from. Switches to `mode: "first_frame"` |
| `last_frame_file_id` | string | – | video: the frame it ends on (needs a first frame) |
| `reference_file_ids` | string[] | – | video: images of the subject/product to keep (≤ 10). Switches to `mode: "reference"` |

**Send the images the prompt goes with.** The enhancer cannot see images otherwise: "make this image moving" without
`first_frame_file_id` gets a made-up scene that fights the frame. With images, each one is read once by a vision model (cached on
the file, see `references` in the response) and the rewrite follows the mode:
- `edit`: a precise edit instruction ("change X, keep the same person, pose, background…"). `aspect_ratio`/`size` match the input
  image unless the user typed a ratio.
- `first_frame`: describes only motion (action, hair/fabric/particles, camera move, pacing) and keeps everything in the frame.
  With a last frame, a transition to it. `ratio` is `"adaptive"` (the frame decides).
- `reference`: keeps the referenced subject/product exactly; the scene follows the idea. `ratio` is `"adaptive"`.
- Text meant to appear in the image (headlines, prices) is kept verbatim in its original language.

`enhance: true` on `POST /images` / `POST /videos` passes the job's images (and a video's `seconds` / `audio: false`) automatically.

**Model picker (optional UI):** fill a dropdown from `GET /api/v1/models` (`aliases` + `models`) and send the chosen id as
`model`. Leave it unset by default — the `enhancer` alias is chosen server-side (currently Qwen4-Max-Preview, ~8 s, falling back to
GLM-5.3 / DeepSeek-V4-Pro) and can change without a frontend release. The response's `model` field tells which model actually ran.

```json
{ "prompt": "A vertical phone wallpaper of a neon Jakarta skyline at night, …", "original": "wallpaper hp jakarta malam",
  "kind": "image", "aspect_ratio": "9:16", "size": "1024x1792", "enhanced": true, "mode": "text", "references": [],
  "model": "qmodel_latest", "credits": 0.01 }
```
- Images get `size` (an allowed `POST /images` size); videos get `ratio` and `seconds` instead.
- If the model's reply cannot be used (or the model is unavailable), the response is still `200` with `enhanced: false` and the
  **original** prompt, so the UI never loses what the user typed. Jobs created with `enhance: true` record it as `request.enhanced`.
- `429 credit_limit_exceeded` when the monthly credit limit is used up.

PWA usage: the button replaces the textarea and preselects the size.
```js
async function onEnhanceClick() {
  const res = await api('/api/v1/prompts/enhance', { method: 'POST', body: JSON.stringify({ prompt: textarea.value, kind }) });
  if (!res.ok) return toast((await res.json()).error.message);
  const r = await res.json();
  textarea.value = r.prompt;                    // replace the user's text
  if (r.kind === 'image') sizeSelect.value = r.size;
  else { ratioSelect.value = r.ratio; secondsInput.value = r.seconds; }
  if (!r.enhanced) toast('Could not enhance this prompt, kept the original');
}
```
Alternatively send `enhance: true` on `POST /images` or `POST /videos` to do both steps in one request.

### POST /prompts/variations
The "Other variation" button: rewrites a finished (usually enhanced) prompt into `n` versions where the outfit, colours,
background… change while the subject, style and quoted text stay. With reference images, the variations are steered **away**
from what the references show on the changed axes (and matched to them on the kept axes). Takes 3–15 s and a few credits.

| field | type | default | notes |
|---|---|---|---|
| `prompt` | string | required | the prompt to vary, up to 4000 characters |
| `kind` | `image` \| `video` | `image` | |
| `reference_file_ids` | string[] | `[]` | up to 3 uploaded images (e.g. the reference the user attached, or the image just generated) |
| `first_frame_file_id` | string | – | video only: the fixed first frame. Variations match it; default `vary` becomes `["motion","camera","mood"]` |
| `vary` | axis[] | `["outfit","color","background"]` | what must change |
| `keep` | axis[] | `["subject","style","text"]` minus anything in `vary` | what must stay as in the prompt / references. An axis in both lists is `400` |
| `avoid` | string[] | `[]` | up to 12 earlier variation prompts the user already saw, so the next click does not repeat them |
| `n` | int 1–9 | `1` | how many variations |
| `user_prompt` | string | – | the user's own words before enhancing. Unless `vary` is sent, details they wrote themselves ("red dress", "beach") stay in every variation and only the details they left open change |
| `model` | string | `enhancer` | model alias or id for the rewrite |

Axes: `subject`, `outfit`, `color`, `background`, `pose`, `lighting`, `camera`, `props`, `hair`, `style`, `text`, `mood`, `motion`.

```json
{ "original": "Fashion photo of a woman in a red silk gown in a marble ballroom, …", "kind": "image",
  "variations": [ { "prompt": "Fashion photo of the same woman in an oversized denim jacket on a sunny rooftop, …",
                    "changed": { "outfit": "oversized denim jacket", "color": "indigo, white", "background": "sunny rooftop" } } ],
  "vary": ["outfit","color","background"], "keep": ["subject","style","text"],
  "references": [ { "file_id": "file_…", "cached": false,
                    "traits": { "subject": "…", "outfit": "red silk evening gown", "palette": "red, gold", "background": "marble ballroom", … } } ],
  "model": "qmodel_latest", "credits": 0.02 }
```
- Each reference is read once by a vision model (`vision` alias); its `traits` are cached on the file, so later clicks with the same
  reference are faster and cheaper (`cached: true`). If an image cannot be read, `traits` is `null` and the variations still come back.
- `502 variation_failed` when the model returned nothing usable (retry). `404 file_not_found` for an unknown reference.

PWA usage: keep the prompts already shown in a list and send them as `avoid`.
```js
const seen = [];
async function onOtherVariation() {
  const res = await api('/api/v1/prompts/variations', { method: 'POST', body: JSON.stringify({
    prompt: basePrompt, reference_file_ids: referenceIds, avoid: seen.slice(-12) }) });
  if (!res.ok) return toast((await res.json()).error.message);
  const { variations } = await res.json();
  seen.push(variations[0].prompt);
  textarea.value = variations[0].prompt;   // then generate as usual
}
```
For several different images at once, send `variations` on `POST /images` instead.

### POST /images
| field | type | default | notes |
|---|---|---|---|
| `prompt` | string | required | up to 4000 characters (Folax uses the first 1500). Used **verbatim** unless `enhance` is true |
| `size` | enum | `1024x1024` | `1024x1024`, `1536x1024`, `1024x1536`, `768x1024`, `1024x768`, `1024x1280`, `1280x1024`, `1024x1792`, `1792x1024`, `2560x1080` |
| `enhance` | bool | `false` | run the prompt enhancer first (as `POST /prompts/enhance`). Its prompt is used, and its size too when `size` was not given |
| `input_file_ids` | string[] | `[]` | up to 3 uploaded images to edit or combine (always Qoder) |
| `provider` | `auto` \| `qoder` \| `folax` | server default (`IMAGE_PROVIDER_DEFAULT`, `auto`) | image generator, see below |
| `n` | int 1–10 | – | how many images of this prompt to make in parallel. **When present, the response is a batch** (see below), not a job |
| `user_prompt` | string | – | with `variations`: what the user typed when `prompt` was already enhanced client-side (✨ then Generate). The variator keeps the details from this text. Default: `prompt`. Stored as `request.user_prompt` |
| `variations` | `true` \| `{vary?, keep?}` | – | with `n` > 1: image 0 uses the prompt as written, images 1..n-1 get their own variation (see below). With `n` 1 or no `n`: just the prompt as written |
| `async` | bool | `false` | `true` returns `202` straight away with a queued job (or batch) |
| `callback_url` | URL | – | POSTed when the job finishes (§9) |

- **Synchronous (default):** the request waits for the image (about 30 s on Qoder, about 10 s on Folax) and returns `200`
  with the finished job. Check `status`: a failed generation also returns `200`, with `status: "failed"`.
- **Async:** returns `202` with the job. Follow it with polling, SSE or a webhook.
- Qoder images come out at about 1 megapixel. For example, a `1792x1024` request gives an image of about 1376×768.
- With `enhance: true` the job's `request` holds `prompt` (the enhanced one) and `original_prompt` (what was sent).
  The enhancer runs before the response, so even `async` requests take a few seconds longer.

#### Several images at once (`n`)
`n` creates `n` jobs that run **in parallel** and share a `batch_id`. A batch takes about as long as one job
(Qoder ~30–40 s, Folax ~10–15 s). Rules:
- Every job follows the normal provider routing (`provider`, input images, prompt length), so under `auto` a text-to-image
  batch runs on **Folax**. A Qoder job makes **1** image, a Folax job **2**: a Folax batch of `n` gives **2n images**
  (`n: 4` → 8 images). Count images from `jobs[].outputs`, not from `n`.
- The prompt enhancer (`enhance: true`) runs **once**; every job gets the same enhanced prompt, unless `variations` is set.
- **`variations`** (`true` or `{vary?, keep?}`): one LLM call writes `n - 1` variations (at most 9).
  - **Job 0** (`batch_index: 0`) always uses the prompt as written (enhanced if `enhance: true`), so at least one image matches
    what the user asked for: `request.prompt` = that prompt, `request.base_prompt` = the same, **`request.variation: {"original": true}`**.
  - **Jobs 1..n-1**: `request.prompt` = the variation, `request.base_prompt` = the prompt it was made from,
    `request.variation: {changed, vary, keep, repeated}` (`repeated: true` when the model returned fewer variations than
    needed and this job reuses one).
  - Without an explicit `vary`, what the user wrote themselves is kept. "Their own text" is `user_prompt` if sent, else
    `original_prompt` of a server-side `enhance: true`, else `prompt`. **Send `user_prompt` when the prompt was enhanced
    with ✨ before Generate**, otherwise every enhanced detail counts as the user's and the variations come out too similar: "gaun merah
    di pantai" gives other red dresses on other beaches, not a blue suit in a studio. Sending `vary` (e.g. from "What may
    change" chips) means those axes may change even where the user named them.
  - `n: 1` (or no `n`) with `variations`: no variator call; the job uses the prompt as written with `variation: {"original": true}`.
  - If the variations fail, every job uses the prompt as written and has `variations_failed: true` (job 0 also keeps
    `variation: {"original": true}`; the others have no `variation`). No error.
- With `input_file_ids` (an edit), job 0 is the edit exactly as asked, and the variations stay edits of those images: other takes on the requested change, same
  person/product and composition (default `vary` `outfit, color, background, props, mood`, `keep` `subject, pose, camera, text`).
- Each job is an ordinary job (`GET /jobs/:id`, `/jobs/:id/events`, webhooks and `callback_url` fire per job). Its
  `request` additionally has `n` and `batch_index` (0-based position in the batch).
- Jobs fail independently: one refused image does not stop the others.
- Credits are charged per job (~0.06–0.16 per Qoder image).

Response (`200` when synchronous, `202` with `async: true`):
```json
{
  "id": "batch_…", "status": "in_progress", "progress": 33, "n": 4, "completed": 1, "failed": 0,
  "credits": 0.16, "created_at": "…", "completed_at": null,
  "jobs": [ { "id": "img_…", "status": "completed", "batch_id": "batch_…", "outputs": [ … ], "request": { "batch_index": 0, … } }, … ]
}
```
- `status`: `queued` → `in_progress` → `completed` (all jobs succeeded), `partial` (some failed) or `failed` (all failed).
- `progress`: average of the jobs' progress (finished jobs count as 100). `credits`: sum over the jobs.
- `jobs` is ordered by `batch_index`.

#### Image providers
| provider | speed | outputs per job | sizes | edits | credits |
|---|---|---|---|---|---|
| `qoder` | ~30 s | 1 | all 10 sizes | yes | ~0.06 |
| `folax` | ~10 s | 2 | mapped to the nearest of `1:1`, `4:3`, `3:4`, `16:9`, `9:16` (e.g. `1792x1024` → `16:9`, `1024x1280` → `3:4`) | no | 0 |

- `auto` uses Folax for text-to-image when the server has it configured, and Qoder otherwise. If Folax fails, the job
  continues on Qoder without the caller noticing.
- Requests with `input_file_ids` always go to Qoder. `provider: "folax"` together with input images is
  `400 validation_error`; `provider: "folax"` on a server without Folax is `400 provider_unavailable`.
- An explicit `provider: "folax"` never falls back: a Folax failure fails the job (`folax_failed`, `folax_timeout`,
  `folax_auth_invalid`, `folax_unavailable`).
- Folax runs up to 8 requests at once (server setting `FOLAX_CONCURRENCY`); further requests wait in line.
- The job's `request` records the choice: `provider` (what was asked or defaulted), `provider_used` (what generated
  the outputs) and, after a fallback, `fallback_reason` (e.g. `folax_auth_invalid`).

### POST /videos (always async, returns 202)
| field | type | default | notes |
|---|---|---|---|
| `prompt` | string | required | used verbatim unless `enhance` is true |
| `seconds` | int | `5` | 2–30, or `-1` to let the model choose |
| `resolution` | enum | `1080P` | `480P`, `720P`, `1080P` |
| `ratio` | enum | `16:9` (`adaptive` with frames or references) | `adaptive`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| `audio` | bool | `true` | generate a soundtrack |
| `first_frame_file_id` | string | – | image to start from (`first_frame_to_video` mode) |
| `last_frame_file_id` | string | – | needs `first_frame_file_id` |
| `reference_file_ids` | string[] | `[]` | 1–10 reference images (`reference_to_video` mode). Cannot be combined with frames |
| `enhance` | bool | `false` | run the prompt enhancer first. Its prompt is used, plus its `seconds` and (text-to-video only) `ratio` when not given. `request.original_prompt` keeps the input |
| `callback_url` | URL | – | POSTed when the job finishes |

Videos take **3–4 minutes**, and can take up to 30. They cannot be cancelled. Only a few run at once (`VIDEO_CONCURRENCY`,
default 2), and the rest wait as `queued`. The output is H.264 MP4, 1080p at 30 fps, with AAC audio when `audio` is on.
If the server restarts during a job, it picks the job up again and finishes it.

### Following a job
| Method | Path | Response |
|---|---|---|
| GET | `/jobs?kind=image\|video&status=…&batch_id=…&limit=20&cursor=…` | `{data: [job], next_cursor, has_more}`, newest first (the gallery) |
| GET | `/jobs/:id` | job. Polling every 5–10 s is fine |
| GET | `/jobs/:id/events` | SSE (see below) |

**Gallery paging (`GET /jobs`).** Infinite scroll through the whole gallery:
- `limit` 1–100 (default 20). `kind` = `image` or `video`. `status` = one or more of `queued,in_progress,completed,failed`
  (comma-separated; e.g. `status=completed` hides failed and running jobs). `batch_id` = only that batch.
- First request without `cursor`. While `has_more` is `true`, request again with `cursor=<next_cursor>` and the **same
  filters**. The last page has `has_more: false`, `next_cursor: null` (no extra empty page).
- The cursor is opaque. It points after the last item you got, so new jobs created while the user scrolls never shift,
  repeat or skip items in later pages; they appear when you reload from the top (or prepend them from SSE/webhooks).
  Batch jobs share a creation time; paging handles that.
- Trashed jobs are not listed. `400 invalid_cursor` for a malformed cursor → reload from the top.

`GET /jobs/:id/events` sends these events:
- `job`: the full job object, sent first as a snapshot.
- `progress`: `{id, status, progress}`, sent while the job runs.
- `completed` or `failed`: the full job object. The stream closes after it. If the job had already finished when you
  connected, the snapshot is the only event.
```
id: 1
event: job
data: {"id":"vid_…","kind":"video","status":"queued","progress":0,…}

id: 2
event: progress
data: {"id":"vid_…","status":"in_progress","progress":12}

id: 9
event: completed
data: {"id":"vid_…","status":"completed","progress":100,"outputs":[{…,"url":"…"}],…}
```
If this stream drops, call `GET /jobs/:id` once, then reconnect to `/events` if the job is still running.

### Following a batch
| Method | Path | Response |
|---|---|---|
| GET | `/images/batches/:id` | batch (same shape as the `POST /images` response) |
| GET | `/images/batches/:id/events` | SSE for the whole batch |

`GET /images/batches/:id/events` sends:
- `batch`: the full batch, sent first as a snapshot.
- `progress`: `{id, status, progress, batch_progress}` for one job (`id` is the job id).
- `job.completed` or `job.failed`: the full job object, once per image as it finishes.
- `batch.done`: the final batch (`status` `completed`, `partial` or `failed`). The stream closes after it. If the batch
  had already finished when you connected, you get only `batch` and `batch.done`.

If this stream drops, call `GET /images/batches/:id` and reconnect if `status` is still `queued` or `in_progress`.

### Deleting from the gallery
Deleting moves jobs to the **trash**. They disappear from `GET /jobs`, `GET /jobs/:id` and batches at once, and their media
URLs return `404` straight away (even though the signed URL has not expired). Housekeeping deletes them for good after the
grace period (default 7 days, set by an admin, see §10). Users cannot list the trash; only admins can (§10).

| Method | Path | Body | Response |
|---|---|---|---|
| DELETE | `/jobs/:id` | – | `204`. `404` unknown job, `409 job_running` while it still runs |
| POST | `/jobs/delete` | `{ids: [1–100 job ids]}` | `{trashed: [ids], skipped: [{id, reason}]}`, reason `not_found` or `job_running` |
| POST | `/jobs/clear-failed` | – | same shape: every failed job of the user |
| DELETE | `/images/batches/:id` | – | same shape. `409 job_running` (nothing deleted) while any image still runs |
| POST | `/jobs/:id/restore` | – | the restored job. `400 not_in_trash` when it is not (or no longer) in the trash |

- Use `restore` for an **Undo** right after deleting: the client still knows the id.
- Running jobs cannot be deleted (generation cannot be cancelled). Delete them once they finished.
- An image that a chat message shows (as an attachment) stays visible in that chat while its job is in the trash.
- `DELETE /v1/videos/:id` (OpenAI) does the same for a video and returns `{id, object: "video.deleted", deleted: true}`.

### Faces and face swap
A **face** is a saved identity: a name plus one of the user's images (a single portrait, or a 3x3 sheet of the same
person from different angles). A **face swap** puts a saved face onto a target image with one of three engines.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/faces` | – | `{data: [face]}`, newest first |
| POST | `/faces` | `{name, file_id}` | `201` face |
| PATCH | `/faces/:id` | `{name}` | face |
| DELETE | `/faces/:id` | – | `204`. The file and earlier face-swap results stay |
| GET | `/face-swap/config` | – | `{default_engine, engines, max_n}` (see below) |
| POST | `/images/:fileId/face-swap` | `{face_id, engine?, n?, callback_url?}` | **always `202`** with an image batch (async) |

Face:
```json
{ "id": "face_…", "name": "Budi", "file_id": "file_…",
  "file": { "id": "file_…", "filename": "budi.png", "mime_type": "image/png", "size": 123456, "kind": "upload",
            "url": "…", "thumbnail_url": "…", "preview_url": "…", "created_at": "…" },
  "created_at": "…" }
```
`file` has the same shape as `GET /files/:id`.

- `name`: 1–60 characters (trimmed). `file_id`: one of the user's files, PNG, JPEG or WebP (upload it with `POST /files`
  first, or use a gallery output). Other types are `400 validation_error`; an unknown or foreign file is `404 file_not_found`.
- At most **50 faces** per user: one more is `409 face_limit_reached`.
- An unknown face (or someone else's) is `404 face_not_found` on `PATCH`, `DELETE` and face swap.
- While a face uses a file, housekeeping does not delete it (even an old, otherwise unused upload), and trashing the job
  that produced it does not hide it.

**Engines**

| engine | how | results | credits | output size |
|---|---|---|---|---|
| `swapper` | faceswap sidecar: face detection + identity embedding + inswapper + face restoration | always 1 (deterministic) | 0 (free) | the target's original resolution |
| `qoder` | Qoder edit of the whole photo: image 1 = target, image 2 = face | `n` (1–4) | the Qoder edit's | the largest allowed size with the target's aspect ratio (3:4 → `1024x1280`) |
| `qoder_crop` | the sidecar cuts a square around the target's largest face → Qoder edits that close-up at `1024x1024` (image 1 = crop, image 2 = face) → the sidecar blends it back into the original photo | `n` (1–4) | the Qoder edit's | the target's original resolution |

`swapper` and `qoder_crop` need the faceswap sidecar (`FACESWAP_URL`) to be configured and ready.

**`GET /face-swap/config`** (any user):
```json
{ "default_engine": "swapper",
  "engines": { "swapper": { "available": true }, "qoder": { "available": true }, "qoder_crop": { "available": true } },
  "max_n": 4 }
```
`available` = the sidecar is configured and answered its readiness check (cached ~30 s). `qoder` is always available.

**`POST /images/:fileId/face-swap`**: `:fileId` is the target image (one of the user's images; `404 file_not_found`
otherwise, `400 validation_error` if it is not an image).

| field | type | default | notes |
|---|---|---|---|
| `face_id` | string | required | a saved face of the user's |
| `engine` | `swapper` \| `qoder` \| `qoder_crop` | admin setting `default_engine` | an explicitly requested engine that is not available is `400 engine_unavailable`; without `engine`, an unavailable default falls back to `qoder` |
| `n` | int 1–4 | `1` | how many takes to make in parallel; **always 1 for `swapper`** |
| `callback_url` | URL | – | POSTed when each job finishes (§9) |

- The response is the same batch as `POST /images` with `n` (follow it with `/images/batches/:id`, its `/events`, or the
  gallery). It never waits for the images. Jobs show progress, SSE events, webhooks and gallery entries like any image job.
- `qoder`/`qoder_crop` jobs are Qoder edits with the admin's prompt (`qoder_prompt` / `qoder_crop_prompt`; no enhancer,
  no variations). `swapper` jobs have `provider` and `provider_used` `"faceswap"` and are recorded as free usage
  (`model: "faceswap"`).
- The jobs' `request` has **`face_swap: {source_file_id, face_id, face_name, engine, face_file_id, …}`** so the gallery can
  show "Face swap: <name>" and link to the original. It stays when the face is later renamed or deleted (`face_name` is the
  name at the time). Jobs from before engines existed have no `engine` (they were `qoder`). Engine-specific extras:
  `options` (swapper options used; `swapper` and `qoder_crop`), `crop_expand`, `crop_file_id` + `crop_box` (`[x, y, side, side]`
  in target pixels) and `qoder_output_file_id` (the raw edited crop) for `qoder_crop`. A `qoder_crop` job's
  `input_file_ids` become `[crop, face file]` once the crop is made; its only output is the pasted full photo.
- Job errors from the sidecar: `no_face_in_target`, `no_face_in_source`, `faceswap_unavailable` (sidecar down or not
  configured), `faceswap_failed` (anything else, e.g. an unreadable or too large image).

---

## 9. Webhooks

### Endpoints
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/webhooks` | – | `{data: [{id, url, events, created_at}], available_events: […]}` |
| POST | `/webhooks` | `{url, events: [...]}` | `201 {id, url, events, created_at, secret}`. **`secret` is shown only once** |
| DELETE | `/webhooks/:id` | – | `204` |
| POST | `/webhooks/:id/test` | – | sends a `webhook.test` event straight away → `{delivered, status, error, delivery_id}` |

These events can be subscribed to:

| event | sent to |
|---|---|
| `image.completed`, `image.failed`, `video.completed`, `video.failed` | the job owner's endpoints |
| `model.added`, `model.retired`, `model.updated` | the endpoints of every admin user |
| `provider.degraded` | the endpoints of every admin user |

### Delivery
```
POST <your url>
Content-Type: application/json
X-StillGPT-Event: video.completed
X-StillGPT-Delivery: whd_…
X-StillGPT-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>

{"id":"evt_…","type":"video.completed","created_at":"2026-11-14T10:00:00.000Z","data":{"job":{ …job object… }}}
```
- Model events have `data: {model: {id, display_name}, previous?}`.
- `provider.degraded` has `data: {provider: "folax", code: "folax_auth_invalid", message}`. It is sent when Folax
  rejects its credentials (the sidecar's login needs renewing), at most once per hour. Image requests keep working
  through the Qoder fallback meanwhile.
- Reply with any `2xx` within **10 s**.
- Failed deliveries are retried after 1 min, 5 min and 30 min, then marked failed.
- Deliveries can arrive more than once, so de-duplicate on `X-StillGPT-Delivery`.
- Verify the signature over the **raw** body, before you parse the JSON:
  ```js
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-stillgpt-signature']));
  ```

### Per-request `callback_url`
`POST /images` and `POST /videos` (and `/v1/videos`) accept `callback_url`. When the job finishes, the server POSTs the
same payload there, using the same headers and retries, but **without** `X-StillGPT-Signature`. This is meant for
one-off resume URLs such as the n8n Wait node.

---

## 10. Admin

These endpoints need `role: "admin"`. Other users get `403 forbidden`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/admin/users` | – | `{data: [user + credits_used_this_month]}` |
| POST | `/admin/users` | `{email, password?, display_name?, role? = "user", monthly_credit_limit?}` | `201 {user}`, or `409 email_taken` |
| PATCH | `/admin/users/:id` | any of `{role, monthly_credit_limit (null = unlimited), disabled, password, display_name}` | `{user}` |
| POST | `/admin/models/sync` | – | `{changes: [{type: "model.added"\|"model.retired"\|"model.updated", model: {id, display_name}, previous?}], active_models}` |

An admin cannot demote or disable their own account (`400 cannot_modify_self`).
A disabled user cannot log in, and their tokens and keys return `403 account_disabled`.

### Qoder housekeeping

Every upload and generated file is kept on our server, so the copies on Qoder can be cleaned up. A housekeeping pass archives
Qoder sessions that have been idle longer than `retention_hours` and deletes our Qoder files older than that. Files that a live
session still uses are skipped. A conversation whose session was archived keeps working: the next message opens a new session
with the chat history, but images from earlier turns have to be attached again before the agent can edit them.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/admin/housekeeping` | – | `{settings, source, running, next_run_at, last_run}` |
| PATCH | `/admin/housekeeping` | any of `{enabled, retention_hours, interval_hours}` | same as GET |
| POST | `/admin/housekeeping/run` | optional `{dry_run = false, retention_hours?}` | `{report}` + same as GET |

- `settings`: `{enabled: boolean, retention_hours: 1–8760, interval_hours: 1–720}`. Examples: 168 = one week, 720 = 30 days.
- `source`: `"env"` until an admin saves settings (defaults from `QODER_RETENTION_HOURS` / `QODER_HOUSEKEEPING_INTERVAL_HOURS`), then `"admin"`.
- `next_run_at`: when the next automatic pass is due (`null` when disabled). The scheduler checks every 10 minutes.
- `last_run`: `null` or `{at, trigger: "schedule"|"manual", retention_hours, report, error}`. Dry runs are not recorded.
- `report`: `{dry_run, sessions_archived, files_deleted, files_in_use, bytes_freed, errors}`.
- `dry_run: true` changes nothing and returns what a pass would do. Add `retention_hours` to preview another window before saving it.

### Gallery trash and media housekeeping

The trash of **all users** (jobs deleted from galleries, old failed jobs, retention):

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/admin/trash` | `?user_id=&kind=image\|video&limit=50 (max 200)&before=<deleted_at>` | `{data: [item], next_before}`, newest deletion first |
| POST | `/admin/trash/restore` | `{ids: [1–100 job ids]}` | `{restored: [ids]}`: back in the owner's gallery |
| POST | `/admin/trash/purge` | `{ids: [1–100 job ids]}` | `{report}`: deleted for good now, without waiting for the grace period |

- `item`: `{job, user: {id, email}, deleted_at, deleted_by: "user"|"admin"|"system", purge_at, bytes}`. `purge_at` =
  `deleted_at` + the grace period (the earliest moment a housekeeping pass deletes it). `job.outputs[]` URLs carry
  `scope=trash` and keep working while the job is in the trash: show these as thumbnails. Never hand them to users.
- Page with `before = next_before` until `next_before` is `null`.

Local media housekeeping (separate from the Qoder housekeeping above, same scheduler pattern):

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/admin/media-housekeeping` | – | `{settings, source, running, next_run_at, last_run, storage}` |
| PATCH | `/admin/media-housekeeping` | any of the settings below | same as GET |
| POST | `/admin/media-housekeeping/run` | optional `{dry_run = false}` | `{report}` + same as GET |

| setting | default | range | meaning |
|---|---|---|---|
| `enabled` | `true` | | automatic passes on/off (manual runs always work) |
| `trash_grace_days` | 7 | 0–365 | days in the trash before deletion for good. `0` = at the next pass. Applies to what is already in the trash too |
| `hide_failed_after_days` | 7 | 0–3650 | failed jobs older than this move to the trash. `0` = off |
| `archived_chat_media_days` | 30 | 0–3650 | uploads and generated files of chats archived (deleted) longer than this are deleted. `0` = off |
| `unused_upload_days` | 30 | 0–3650 | uploads that no chat or job uses, older than this, are deleted. `0` = off |
| `retention_days` | 0 | 0–3650 | finished jobs older than this move to the trash. `0` = keep forever |
| `interval_hours` | 24 | 1–720 | time between automatic passes |

- A file is only deleted from disk when nothing still uses it: no other job (as output, edit input, video frame or
  reference) and no message in a chat that is not archived. Such files are kept and counted in `files_in_use`.
- `source`: `"default"` until an admin saves settings, then `"admin"`.
- `storage`: `{files, bytes, trash_jobs, trash_files, trash_bytes}` (`files`/`bytes` = media users can still see).
- `report`: `{dry_run, jobs_trashed, jobs_purged, files_deleted, files_in_use, bytes_freed, errors}`.
- `last_run`: `null` or `{at, trigger: "schedule"|"manual", report, error}`. Dry runs are not recorded.
- One pass handles at most 2000 items per step; a larger backlog is worked off over the next passes.

### Qoder credential (PAT)

The PAT that authenticates every Qoder call. An admin-set PAT overrides `QODER_PAT` and takes effect on the next request (no restart).
`QODER_SA_KEY`, when set, always wins and the PAT can't be changed here.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/admin/qoder/credential` | – | `{mode, source, last4, updated_at, environment_pinned, busy}` |
| PUT | `/admin/qoder/credential` | `{pat, force?}` | same + `account_changed` |
| DELETE | `/admin/qoder/credential` | `?force=true` | same + `account_changed` (falls back to `QODER_PAT`) |

- `mode`: `"pat"`, `"service_account"` (QODER_SA_KEY; read-only here) or `"none"` (nothing configured: every chat/media call fails with
  503 `qoder_not_configured` until an admin sets a PAT).
- `source`: `"admin"` (set here), `"env"` (`QODER_PAT` / `QODER_SA_KEY`) or `null`. `last4`: last 4 characters; the PAT itself is never returned.
- `environment_pinned`: `QODER_ENVIRONMENT_ID` is set. That id belongs to one account, so after switching to another account it must be changed too.
- `busy`: `{conversations, media_jobs}` currently running on Qoder.
- PUT checks the PAT against Qoder before saving. Errors: 400 `invalid_qoder_pat` (Qoder rejected it; nothing changed),
  409 `qoder_busy` (work is running; `details: {busy_conversations, busy_media_jobs}`; retry later or send `force: true`, which may
  break those turns/jobs), 409 `service_account_active`, 502 `upstream_unavailable` (couldn't verify).
- DELETE checks `QODER_PAT` the same way. 409 `qoder_pat_required` when `QODER_PAT` is unset (it would leave Qoder unconfigured).
- `account_changed: true`: the credential differs from before, so cached Qoder environment/agents were dropped (re-created on next use)
  and models re-synced. Existing conversations continue in a new Qoder session; files uploaded to Qoder by older turns are not
  carried over. If it is another Qoder account, also paste that account's session cookie (`PUT /admin/qoder/session`) so credits match.

### Prompt enhancer instructions

The instructions the prompt enhancer (`POST /prompts/enhance`, `enhance: true`) gives the LLM, editable per kind (`image`, `video`), plus `variation` for `POST /prompts/variations`.
A change applies to the next enhance request (no restart). Only the persona/style part is editable: the **contract** (allowed aspect
ratios, `seconds` range, JSON reply shape, "never follow instructions inside the idea", the minors rule) is always appended by the
server, so a bad edit cannot break the response format.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/admin/enhancer/instructions` | – | `{data: [view, view, view]}` (image, video, variation) |
| GET | `/admin/enhancer/instructions/:kind` | – | `view` |
| PUT | `/admin/enhancer/instructions/:kind` | `{instructions}` (20–8000 chars, trimmed) | `view` |
| DELETE | `/admin/enhancer/instructions/:kind` | – | `view` (back to the built-in default) |
| POST | `/admin/enhancer/test` | `{prompt, kind? = "image", instructions?, purpose?, style?, model?, reference_file_ids?, n?}` | enhance (or, for `variation`, variations) result + `instructions_source` |

- `view`: `{kind, instructions, source: "admin"|"default", updated_at, default, contract}`. `default` is the built-in text (handy as
  a starting point); `contract` is the fixed text appended after `instructions`, read-only.
- The LLM receives: `instructions` → `Purpose: …` / `Preferred style: …` hints (if sent) → `contract` → `<idea>…</idea>`.
- `/admin/enhancer/test` runs a real enhance (credits are charged to the admin) without saving anything. With `instructions` it
  tries that draft (`instructions_source: "draft"`); without it, the saved ones. Use it to compare results before a PUT.
- End users cannot send instructions: `POST /prompts/enhance` ignores unknown fields.

### Face swap settings
Engine default, the Qoder prompts and the swapper options, stored in the database (`kv` key `face_swap.settings`); a
change applies to the next face swap. Only values that differ from the defaults are stored, so new built-in defaults reach
fields an admin never changed.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/admin/face-swap/settings` | – | `{settings, defaults, sidecar: {configured, ready, models?}}` (readiness probed now) |
| PUT | `/admin/face-swap/settings` | any subset of the settings; `null` resets a field (or all of `swapper`) to its default | same as GET (readiness may be cached) |
| POST | `/admin/face-swap/test` | `{target_file_id, face_id, engine? = "swapper", settings_override?}` | `{image_data_url, engine, timings_ms, width, height, target_faces, source_faces}` |

```json
{ "default_engine": "swapper",
  "qoder_prompt": "Face swap. Image 1 is the target photo …",
  "qoder_crop_prompt": "Face swap on a close-up. …",
  "crop_expand": 2.2,
  "swapper": { "target_faces": "largest", "identity_mode": "average", "det_thresh": 0.5, "restorer": "codeformer",
               "restore_blend": 0.8, "codeformer_fidelity": 0.7 } }
```

| setting | range | meaning |
|---|---|---|
| `default_engine` | `swapper` \| `qoder` \| `qoder_crop` | engine of a face swap without `engine` |
| `qoder_prompt`, `qoder_crop_prompt` | 20–4000 chars (trimmed) | prompts of the `qoder` / `qoder_crop` engines |
| `crop_expand` | 1.2–4 | `qoder_crop`: crop side = `crop_expand` × the face's larger side |
| `swapper.target_faces` | `largest` \| `all` | which faces in the target get swapped |
| `swapper.identity_mode` | `average` \| `frontal` | average all faces in the face image (e.g. a 3x3 sheet) or use the most frontal one |
| `swapper.det_thresh` | 0.1–0.95 | face detection threshold (also used by `qoder_crop`) |
| `swapper.restorer` | `codeformer` \| `gfpgan` \| `off` | face restoration after the swap |
| `swapper.restore_blend` | 0–1 | how much of the restored face is blended in |
| `swapper.codeformer_fidelity` | 0–1 | CodeFormer: higher = closer to the swapped face, lower = stronger restoration |

- Unknown fields or out-of-range values are `400 validation_error` (with `issues`).
- Engine settings are copied into each job when it is created (`request.face_swap.options`, `crop_expand`, the prompt), so
  a change does not affect jobs already queued.
- **Test** runs the swapper synchronously on one of the admin's own images and faces with the current settings merged with
  `settings_override` (same shape as `PUT`), without creating a job or gallery item. `qoder`/`qoder_crop` are
  `400 test_engine_unsupported`; sidecar errors are `400 no_face_in_target`/`no_face_in_source`/`faceswap_failed` or
  `503 faceswap_unavailable`.

### Qoder credits

Remaining credits and per-request credit history of the Qoder account. Qoder exposes these only on its web dashboard API, which
accepts the browser login cookie `qoder_session_cookie` and rejects PAT / service-account tokens. The cookie comes from
`QODER_WEB_SESSION` or is pasted by an admin. When it expires, `status` turns `"session_expired"` and an admin pastes a new one.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/admin/qoder/credits` | `?refresh=true` skips the 5-minute cache | `{status, credits, stale, fetched_at, error, session}` |
| GET | `/admin/qoder/credits/history` | `?page=1&page_size=50&start=&end=&order=desc` | `{status, error, items, page_summary, page}` |
| PUT | `/admin/qoder/session` | `{cookie}` | same as GET credits (fetched right away) |
| DELETE | `/admin/qoder/session` | – | same as GET credits (falls back to `QODER_WEB_SESSION`) |

All of them return HTTP 200; branch on `status`:

| `status` | meaning | admin page |
|---|---|---|
| `ok` | fresh data | show it |
| `not_configured` | no cookie at all | ask an admin to paste one |
| `session_expired` | Qoder rejected the cookie | ask for a new cookie; `credits` may still hold the last reading (`stale: true`) |
| `error` | Qoder unreachable or answered unexpectedly; `error` says why | retry later; `credits` may be stale |

- `credits`: `null` or `{used, limit, remaining, usage_percentage, unit, plan, resource_package, dedicated_resource_package, last_reset_at, next_reset_at}`.
  The top-level numbers are the total over all sources. `plan` and both packages are `{used, limit, remaining, usage_percentage}`.
- `fetched_at`: when `credits` was read from Qoder.
- `session`: `{configured, source: "env"|"admin"|null, issued_at, updated_at}`. `issued_at` is when Qoder issued the cookie
  (read from the cookie itself, `null` if unreadable). `updated_at` is when an admin last pasted it. The cookie value is never returned.
- `cookie` (PUT): the `qoder_session_cookie` value from a logged-in qoder.com browser (DevTools → Application → Cookies).
  `qoder_session_cookie=…` or a whole `Cookie:` header also works.
- History query: `page` ≥ 1, `page_size` 1–100 (default 50), `start` / `end` as ISO 8601 or epoch milliseconds (both optional),
  `order` = `desc` (newest first, default) or `asc`. Not cached.
- History `items[]`: `{begin_at, finish_at, session_id, business_id, source, operation, kind, model, credits, original_credits,
  cost, original_cost, discount_factor}`. `source` is where credits were spent (`"Cloud Agents"` = this backend, `"IDE"`, `"Qoder"`, …);
  `operation` e.g. `"Agent"`, `"Video"`; `kind` = `"Charged"` / `"Not Charged"`; `cost` is in USD.
- `page_summary`: totals of **this page only** (Qoder returns no totals for the whole range). `page`: `{current, page_size, last_page, total_items}`.

---

## 11. Errors

```json
{ "error": { "code": "validation_error", "message": "seconds: seconds must be between 2 and 30, or -1",
             "details": { "issues": [{ "path": "seconds", "message": "seconds must be between 2 and 30, or -1" }] } } }
```
Branch on `code`, not on `message`. `details` appears only on some errors.

| HTTP | code | meaning |
|---|---|---|
| 400 | `invalid_json` | the body is not valid JSON |
| 400 | `validation_error` | a field is missing or invalid. `details.issues` lists each problem |
| 400 | `invalid_request`, `empty_message`, `invalid_multipart` | malformed request |
| 400 | `model_not_supported` / `no_models_available` | a media model was used for chat / no Qoder model is available at all |
| 401 | `unauthorized` | the credential is missing, invalid or expired. Refresh the token, or log in again |
| 403 | `forbidden` / `account_disabled` / `invalid_signature` | not an admin / account disabled / the media URL expired or was tampered with |
| 404 | `not_found`, `file_not_found`, `face_not_found` | the resource does not exist or belongs to someone else |
| 409 | `conversation_busy` | a turn is already running. Wait, or call `/interrupt` |
| 409 | `email_taken`, `job_not_completed`, `face_limit_reached` | |
| 413 | `file_too_large`, `attachment_too_large` | see the limits in §12 |
| 429 | `credit_limit_exceeded` | the monthly credit limit has been reached |
| 502 / 503 | `upstream_unavailable`, `upstream_auth`, `upstream_*` | a Qoder problem. Retry later |
| 504 | `turn_timeout` | the turn took more than 45 min |
| 500 | `internal_error` | a bug. Report it with the `X-Request-Id` |

Treat any `429` or `5xx` as retryable.

---

## 12. Limits and latencies

| | limit |
|---|---|
| Upload (`POST /files`) | 50 MB per file |
| Image attachment / edit input / video frame | 50 MB for PNG, JPEG, WebP (scaled down for Qoder above ~4.5 MB); 7 MB for GIF |
| Document attachment (sandbox) | 5 MB (Qoder limit) |
| Content blocks per message | 50 |
| Image prompt | 4000 characters (Folax: 1500; under `auto` a longer prompt goes to Qoder with `fallback_reason: "prompt_too_long_for_folax"`). 1 image per job on Qoder, 2 on Folax |
| Jobs per request (`n`) | 1–10, in parallel (Qoder: 1 image per job, Folax: 2) |
| Image inputs (edit) | 3 |
| Saved faces | 50 per user. Face swap `n`: 1–4 |
| Video `seconds` | 2–30 or -1. Resolution `480P`, `720P` or `1080P`. 7 ratios (§8) |
| Video references | 1–10, or first frame (+ last frame) |
| Turn timeout | 45 min |
| Access token / refresh token | 15 min / 30 days |
| Signed media URL | 7 days (default) |

Latencies observed (model `efficient`):

| workload | time |
|---|---|
| chat reply | 2–4 s |
| reply about attached documents | 8–20 s |
| image (Qoder) | about 30 s |
| image batch, `n` up to 6 (Qoder) | about 30–40 s (parallel) |
| image (Folax) | about 10–15 s per job, also for a batch (jobs run in parallel, up to 8 at once) |
| prompt enhancer | 2–10 s |
| video | 3–4 min (up to 30) |

---

## 13. OpenAI- and Anthropic-compatible endpoints

These endpoints are for existing tools and SDKs. Point a client's base URL at `https://<host>/v1` and use a StillGPT
API key. They are stateless: the client sends the whole history each time, and StillGPT maps it onto a server-side
conversation. Errors use each provider's own envelope.

| Endpoint | Notes |
|---|---|
| `GET /v1/models`, `GET /v1/models/:id` | aliases and `qoder/<id>` models, plus `qoder-image`, `qoder-video` and (when configured) `folax-image` |
| `POST /v1/chat/completions` | OpenAI Chat Completions, streaming and non-streaming |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages`, `POST /v1/messages/count_tokens` | Anthropic Messages API (`x-api-key` header) |
| `POST /v1/images/generations` | `{prompt, model?, n? (1–10), size?, response_format?: "url"\|"b64_json"}` → `{created, data: [{url}\|{b64_json}]}`. `model`: `qoder-image` → Qoder, `folax-image` → Folax, absent or `dall-e-*`/`gpt-image-*` → the server's default provider (§8). Sizes that are not supported map to the closest allowed aspect ratio (e.g. `1920x1080` → `1792x1024`, `512x512` → `1024x1024`). On Qoder the `n` images are generated in parallel (~30–40 s for all). One Folax call yields 2 images, so StillGPT makes ceil(n/2) Folax calls in parallel (~10–15 s for all). If some images fail, the ones that succeeded are returned (fewer than `n`); it is an error only when none succeeded |
| `POST /v1/images/edits` | multipart: `image` or `image[]` (up to 3), `prompt`, `size`, `n`, `response_format`. Always Qoder (`folax-image` → `400`) |
| `POST /v1/videos` | OpenAI Videos API. JSON or multipart: `prompt`, `model: "qoder-video"`, `seconds` (string or number), `size` (`1280x720`, `720x1280`, `1920x1080`, `1024x1024`, …, mapped to ratio and resolution), optional `input_reference` image (becomes the first frame). StillGPT extras: `resolution`, `ratio`, `audio`, `callback_url` |
| `GET /v1/videos`, `GET /v1/videos/:id` | video object `{id, object: "video", model, status, progress, created_at, completed_at, seconds, size, error}` (unix seconds) |
| `GET /v1/videos/:id/content` | the MP4 bytes, with `Range` support. Returns `409 job_not_completed` until the video is ready |
| `DELETE /v1/videos/:id` | `501 not_supported` |

The video ids from `/v1/videos` are the same job ids used by `/api/v1/jobs/:id`.

Response headers on compat calls: `X-StillGPT-Conversation`, `X-StillGPT-Model` and `X-StillGPT-Credits`.
To pin a stateless client to one conversation, send `X-StillGPT-Conversation: conv_…`. To choose the tool set, send
`X-StillGPT-Profile: chat|assistant`. The OpenAI/Anthropic documentation covers the full details.

---

## 14. n8n recipes

### Chat, using the built-in OpenAI nodes
1. Create a StillGPT API key: `POST /api/v1/api-keys {"name":"n8n"}`.
2. In n8n, add an **OpenAI** credential. Set API Key to `qr_…` and Base URL to `https://<host>/v1`.
3. Use the *OpenAI Chat Model* node (AI Agent / LLM chains) or the *OpenAI → Message a model* node. For the model, pick
   `smart`, `fast`, `cheap`, `default` or any `qoder/<id>`.
4. Images: *OpenAI → Generate an image*, with the model set to `qoder-image`.

### Video, using HTTP Request and the Wait node (no polling)
1. **HTTP Request** node: `POST https://<host>/api/v1/videos`. Header: `Authorization: Bearer qr_…`. JSON body:
   ```json
   { "prompt": "{{ $json.prompt }}", "seconds": 5, "ratio": "9:16", "callback_url": "{{ $execution.resumeUrl }}" }
   ```
2. **Wait** node, set to *Resume: On Webhook Call*, with HTTP method `POST`. Give it a timeout of 40 min or more.
3. When the video is done, StillGPT POSTs `{type: "video.completed", data: {job}}` to the resume URL. The next node
   reads `{{ $json.body.data.job.outputs[0].url }}`. That signed URL needs no auth, so an *HTTP Request* node set to
   *Response Format: File* can download it.
4. Check `{{ $json.body.type }}`: it is `video.failed` when generation failed (see `data.job.error`).

Polling also works: loop over `GET /api/v1/jobs/{{id}}` with a Wait of 15 s until `status` is `completed` or `failed`.

### Long-lived events
For events that are not tied to a single workflow run (all `video.completed` events, or the `model.*` changes for
admins), register a *Webhook* trigger URL with `POST /api/v1/webhooks`. Verify `X-StillGPT-Signature` in a Code node
if the URL is public.
