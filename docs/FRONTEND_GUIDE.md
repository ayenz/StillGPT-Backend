# Frontend Integration Guide — StillGPT

For: the frontend team (PWA now, Flutter later).
Backend version: 0.1 · November 2026 · The full API reference is in the appendix (Part B).

---

## 1. Overview

StillGPT is our "personal LLM" backend. The frontend app only needs to talk to **one** server:

| App feature | Main endpoint |
|---|---|
| Login, profile, credit quota | `/auth/*`, `/me`, `/usage` |
| Chat (text) with streamed answers | `/conversations`, `/conversations/:id/messages` (SSE) |
| Send photos / documents (PDF, DOCX, XLSX, CSV, …) to a chat | `/files`, then reference the `file_id` in the message |
| **✨ Enhance** button for image/video prompts | `/prompts/enhance` |
| Generate images | `/images` |
| Generate videos | `/videos` + `/jobs/:id` |
| Model list / model picker | `/models` |

- **Production base URL:** `https://qrouter.ayenz.my.id/api/v1`
- **Local base URL:** `http://localhost:8790/api/v1`
- All JSON uses **snake_case**. Times are ISO-8601 UTC.
- Every response has an `X-Request-Id` header — include it when reporting bugs.

> The backend stores conversation context itself. The frontend **only sends the new message** and never resends the history.

---

## 2. Login and tokens

There is no public sign-up: accounts are created by an admin (`POST /admin/users`). The app only needs a login screen.

```
POST /auth/login     {email, password}          → {user, access_token, expires_in: 900, refresh_token}
POST /auth/refresh   {refresh_token}            → {access_token, expires_in, refresh_token}   (refresh token ROTATES)
POST /auth/logout    {refresh_token}            → 204
```

Mandatory rules:
1. Keep the **access token in memory only**. Store the refresh token in IndexedDB/`localStorage` (PWA) or `flutter_secure_storage` (Flutter).
2. When the app opens → call `/auth/refresh`.
3. If any request gets a `401` → refresh **once** and retry the request. If the refresh also fails → go to the login screen.
4. **Only one refresh may run at a time** (use a single shared promise). The refresh token rotates every time it is used,
   so two parallel refreshes will invalidate each other.

```ts
let refreshing: Promise<string> | null = null;
async function getFreshToken(): Promise<string> {
  refreshing ??= fetch(`${API}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: await store.getRefresh() }),
  }).then(async (r) => {
    if (!r.ok) throw new Error('logged_out');
    const t = await r.json();
    await store.setRefresh(t.refresh_token);   // store the NEW one
    memory.accessToken = t.access_token;
    return t.access_token;
  }).finally(() => (refreshing = null));
  return refreshing;
}
```

---

## 3. Streaming chat

### 3.1 Flow
1. Create a conversation: `POST /conversations {model?: "default", profile?: "assistant"}` → `conv_…`
2. Send a message with streaming:
   `POST /conversations/:id/messages` + header `Accept: text/event-stream`, body `{text, attachments?: [file_id]}`
3. Read SSE events until `turn.completed`.

The browser's built-in `EventSource` **cannot** POST and cannot send an `Authorization` header — use `fetch`
and read `response.body` (e.g. the `eventsource-parser` or `@microsoft/fetch-event-source` package).

### 3.2 Events to handle

| Event | What the UI does |
|---|---|
| `turn.started` | create an empty answer bubble; store `message_id` |
| `thinking` | show a "thinking…" indicator |
| `text.delta` | **append** `text` to the bubble (render Markdown) |
| `tool.started` / `tool.completed` | optional: status chip, e.g. "🔎 Searching the web…", "🖼️ Generating image…" |
| `artifact` | show the image/video/file (`artifact.url` can be used directly in `<img>`/`<video>`) |
| `model.fallback` | optional: small notice "model X unavailable, using Y" |
| `error` | show the error message in the bubble (a `turn.completed` event still follows) |
| `conversation.title` | auto-generated title for a new chat (like ChatGPT): update the title in the sidebar/header, ideally with a short typing animation |
| `turn.completed` | final: replace the bubble content with the full `text`, re-enable the send button |

```ts
import { createParser } from 'eventsource-parser';

async function sendMessage(convId: string, text: string, attachments: string[], ui: ChatUI) {
  const res = await authFetch(`${API}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text, attachments }),
  });
  if (res.status === 409) return ui.toast('Still answering the previous message');
  const parser = createParser({
    onEvent(ev) {
      ui.lastEventId = ev.id;                       // for reconnecting
      const data = JSON.parse(ev.data);
      switch (ev.event) {
        case 'turn.started': ui.startAssistant(data.message_id); break;
        case 'thinking': ui.setThinking(true); break;
        case 'text.delta': ui.appendText(data.text); break;
        case 'artifact': ui.addArtifact(data.artifact); break;
        case 'conversation.title': sidebar.rename(data.conversation_id, data.title); break;
        case 'error': ui.showError(data.message); break;
        case 'turn.completed': ui.finish(data.text, data.artifacts, data.stop_reason); break;
      }
    },
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(value);
  }
}
```

### 3.3 Dropped connections & reopening the app
- **Closing the tab / losing signal does not cancel the answer.** The answer is still generated and saved on the server.
- When the connection drops: `GET /conversations/:id/stream` with the header `Last-Event-ID: <last id>` (backoff 1 s → 2 s → 5 s).
  - `200` → keep appending events.
  - `204` → the answer is already finished: reload `GET /conversations/:id/messages`.
- When the app is reopened: `GET …/messages` returns `running_turn` ≠ `null` if a turn is still running → connect to `/stream` without `Last-Event-ID` (the event history is replayed from the start).

### 3.4 Miscellaneous
- **Stop** button: `POST /conversations/:id/interrupt`.
- A conversation can only process one message at a time → `409 conversation_busy`. Disable the send button while streaming.
- Conversation list: `GET /conversations?limit=20&before=<next_cursor>` (newest first). The title is filled in automatically from the first message.
- Change the model or system prompt mid-conversation: `PATCH /conversations/:id` — the context is preserved.

---

## 4. Photos & documents

1. Upload first: `POST /files` (multipart, field `file`, max 20 MB) → `{id, filename, mime_type, size, url}`
2. Reference it in the message: `{text: "Summarize this document", attachments: ["file_…"]}`

| Type | Behavior | Limit |
|---|---|---|
| Photos (png, jpg, webp, gif) | seen directly by the model | 20 MB upload; > 7 MB is sent as a file |
| Documents (pdf, docx, xlsx, csv, txt, md, …) | read by the agent in a sandbox | **5 MB** per document (`413 attachment_too_large` on send) |

Show attachment previews using the `url` from the upload response. Document analysis takes 8–20 seconds — show an indicator based on the `tool.started` event.

---

## 5. Images, videos, and the ✨ Enhance button

### 5.1 ✨ Enhance button (improve the prompt)
In the image/video generation form, place a **✨ Enhance** button next to the text area.

```
POST /prompts/enhance  {prompt, kind: "image" | "video", purpose?: "poster", style?, model?}
→ {prompt, original, aspect_ratio, size?, ratio?, seconds?, enhanced, model, credits}
```

Required UI behavior:
1. Click → button shows loading (2–10 seconds).
2. **Replace the text area content** with `prompt` from the response.
3. Auto-select the size: image → `size`; video → `ratio` and `seconds` (the user can still change them).
4. Keep `original` so there is a **↩ Revert** button.
5. If `enhanced: false`, the prompt is unchanged — show a notice "prompt used as is".

Prompts may be in Indonesian; the enhanced result is always in English. For promotional content (e.g. plus-size clothing),
fill in `purpose` (`"poster"`, `"fashion catalog"`) — the enhancer will use fashion-industry terminology so the image
generator refuses less often. The `model` field is optional: leave it empty for the server default (currently Kimi-K3.1-Pro).

### 5.2 Generate images
```
POST /images {prompt, size?: "1024x1024", provider?: "auto" | "qoder" | "folax", input_file_ids?: [..], enhance?: false}
→ 200 job {id, status: "completed" | "failed", outputs: [{url, mime_type, …}], error}
```
- Waits until finished (Folax ~10 seconds, Qoder ~20–30 seconds). To avoid waiting: `async: true` → `202`, then follow the job (5.4).
- `provider: "auto"` (default): uses **Folax** (fast, 2 images per request); on failure it automatically falls back to **Qoder**.
- **Photo edit/merge** (`input_file_ids`, max 3) always uses Qoder.
- Qoder sizes: `1024x1024, 1536x1024, 1024x1536, 768x1024, 1024x768, 1024x1280, 1280x1024, 1024x1792, 1792x1024, 2560x1080`.
  Folax only supports 1:1, 4:3, 3:4, 16:9, 9:16 (other sizes are rounded to the nearest ratio).
- A `failed` status is still HTTP 200 — always check `status` and `error.message`.

### 5.3 Generate videos
```
POST /videos {prompt, seconds?: 5, resolution?: "1080P", ratio?: "16:9", audio?: true,
              first_frame_file_id?, last_frame_file_id?, reference_file_ids?: [..], enhance?}
→ 202 job {id: "vid_…", status: "queued"}
```
- Automatic mode: text only → *text-to-video*; with `first_frame_file_id` → animate a photo (optionally + `last_frame_file_id`); with `reference_file_ids` (1–10) → consistent character/product.
- Duration 2–30 seconds, resolution 480P/720P/1080P, ratio 21:9, 16:9, 4:3, 1:1, 3:4, 9:16.
- **Slow: usually 3–8 minutes, up to 30 minutes.** Cannot be cancelled. The server processes one video at a time;
  if the Qoder queue is full, the server retries automatically (the job stays `in_progress`).

### 5.4 Following a job (async images & videos)
- `GET /jobs/:id/events` (SSE): `progress {status, progress}` events, then `completed` / `failed` containing the full job.
- Or poll `GET /jobs/:id` every 5–10 seconds.
- `progress` (0–100) is a **time estimate**, not real progress; it holds at ≤ 95 until finished.
- History: `GET /jobs?kind=video&limit=20`.

Suggested UI: a job card in the gallery with a progress bar, a notification on `completed`, and jobs remain viewable
after the app is closed (refetch from `/jobs`).

---

## 6. Files & media URLs

- Every image/video/file `url` is a **signed URL** (`/media/file_…?exp=…&sig=…`): it can be used directly in `<img>`, `<video>`, or a download link **without** an Authorization header.
- URLs expire (default 7 days) → refetch from `GET …/messages` or `GET /jobs/:id` when needed. Do not store URLs permanently.
- HTTP Range is supported, so `<video>` can seek (important for Safari/iOS).
- Append `&download=1` to make the browser download instead of display.

---

## 7. Errors

Format: `{"error": {"code": "...", "message": "..."}}`. Codes the UI needs to handle:

| HTTP | code | UI action |
|---|---|---|
| 401 | `unauthorized` | refresh the token once, then go to login |
| 403 | `account_disabled`, `forbidden` | show the message, log out |
| 409 | `conversation_busy` | "Still answering…", do not resend |
| 413 | `file_too_large`, `attachment_too_large` | show the size limit |
| 429 | `credit_limit_exceeded` | "This month's quota is used up" |
| 400 | `validation_error` | show `message` next to the relevant field |
| 502/503 | `upstream_*` | "The AI service is having problems, please try again" + retry button |

Errors mid-stream arrive as an `error` event (still followed by `turn.completed` with `stop_reason: "error"`).

---

## 8. PWA notes

- **Service worker:** do not cache API responses, especially SSE (`/messages`, `/stream`, `/jobs/*/events`) and signed `/media/*`. Only cache the app's static assets.
- **Proxies & timeouts:** long answers can take > 1 minute; the server sends a `: ping` heartbeat every 15 seconds — ignore it.
- **iOS Safari:** use `fetch` streaming (supported since iOS 15). Use `<video playsinline controls>` for video results.
- **Video-finished notifications:** if the tab was closed, still show them from `/jobs` when the app is reopened.
- **CORS:** the server already allows the app's origin (ask for it to be added to `CORS_ORIGINS` if the domain changes).

## 9. Flutter notes (later)

- Tokens: `flutter_secure_storage`. HTTP: `dio` or `http`.
- SSE: send the request with `Accept: text/event-stream`, read `response.stream` through `utf8.decoder` + `LineSplitter`,
  split frames on blank lines; the `id:`, `event:`, `data:` fields are exactly the same as on the web.
- Video: `video_player` supports signed URLs + Range.

## 10. Contacts & environments

- Test accounts: ask an admin (created via `/admin/users`). Do not use an admin account for UI testing.
- API keys (`sg_…`) are for servers/n8n only — **do not** embed them in the frontend app.
- Full specification of every endpoint: Part B (API reference) in this document.
