# Frontend agent brief — StillGPT PWA

You are building the **web app (PWA)** for StillGPT, our "personal LLM" backend. The backend is finished and deployed;
your job is the client only. Do not change the backend. If the API seems to be missing something, write it down in
`BACKEND_REQUESTS.md` in the frontend repo and work around it.

## Source of truth

Read these first, in this order (they are in the backend repo `docs/`):
1. `FRONTEND_GUIDE.md` — the flows and UI behaviour we want (Indonesian).
2. `API.md` — the exact request/response contract of every endpoint. **When this brief and API.md disagree, API.md wins.**

Environments:
- Production API: `https://qrouter.ayenz.my.id/api/v1`
- Local backend: `http://localhost:8790/api/v1` (run the backend repo with `npm run dev`; ask the owner for a test account)

Make the API base URL a build-time env var (`VITE_API_BASE_URL`). Never ship API keys (`qr_…`) in the client; the PWA
always uses email/password login → access + refresh tokens.

## Product scope (MVP)

The app should feel like a mainstream AI chat app. UI language: **Bahasa Indonesia**.

1. **Login** (no sign-up screen — accounts are created by an admin), logout, profile (display name, change password with
   current password), credit usage this month (`GET /me`).
2. **Chat**
   - Sidebar with conversations (newest first, infinite scroll via `next_cursor`), new chat, rename, delete.
     New chats are auto-titled (ChatGPT style): apply the `conversation.title` SSE event to the sidebar/header; if it
     did not arrive, refetch the list a few seconds after the first `turn.completed`. Manual rename = `PATCH title`.
   - Message view with Markdown rendering (code blocks with copy button, tables, links), streaming replies,
     a "thinking…" indicator, tool chips from `tool.started`/`tool.completed` (e.g. "Mencari di web…", "Membaca dokumen…",
     "Membuat gambar…"), and inline artifacts (images, videos, files) from `artifact` events.
   - Composer: textarea (Enter = send, Shift+Enter = newline), attach photos/documents (upload first via `POST /files`,
     show previews and upload progress), Stop button (`POST …/interrupt`), send disabled while a turn is running.
   - Model picker per conversation: show **aliases** from `GET /models` first (`default`, `smart`, `fast`, `cheap`),
     raw models under "Lainnya". Changing it calls `PATCH /conversations/:id`.
   - Error states for every code in API.md §11 (`409 conversation_busy`, `429 credit_limit_exceeded`, `413`, upstream errors with a retry button).
3. **Create image** page
   - Prompt textarea + **✨ Enhance** button (`POST /prompts/enhance`, `kind:"image"`): replaces the textarea content with
     `prompt`, preselects `size`, keeps `original` for a **↩ Undo** button; show a small note when `enhanced` is false.
     Optional "Tujuan" field sent as `purpose` (e.g. poster, katalog fashion, Instagram post).
   - Size/ratio picker (sizes from API.md §8), provider selector (`auto` default; hide `folax` when unavailable per `image_providers`).
   - Optional input images (max 3) for edits → forces provider `qoder`.
   - Result grid (Folax returns 2 images), download buttons, "use as video first frame" action.
4. **Create video** page
   - Prompt + ✨ Enhance (`kind:"video"`, preselect `ratio` and `seconds`), duration slider 2–30 s, resolution, ratio, audio toggle,
     optional first frame / last frame / reference images.
   - Submitting creates a job (`202`); show it as a card with an **estimated** progress bar (`GET /jobs/:id/events` SSE,
     fallback polling every 10 s). Make clear it can take several minutes and runs in the background.
5. **Gallery** — `GET /jobs` (images and videos), statuses, retry (= submit the same request again), open/download.

Out of scope for the MVP: admin screens, webhooks, API key management, sign-up, payments.

## Technical requirements

- Stack (recommended, keep unless there is a strong reason): **Vite + React + TypeScript**, TanStack Query for REST state,
  a small store (Zustand) for auth/session, `react-markdown` + `remark-gfm` + a code highlighter, `vite-plugin-pwa`.
- **Auth**: access token in memory only; refresh token in IndexedDB. On app start call `/auth/refresh`. On `401`, run
  **one shared** refresh (single in-flight promise — refresh tokens rotate) and retry the request once; on failure go to login.
- **Streaming**: `fetch` + `ReadableStream` + `eventsource-parser` (or `@microsoft/fetch-event-source`). `EventSource`
  cannot POST or send `Authorization`. Track the last SSE `id`.
- **Reconnect**: on network drop, `GET /conversations/:id/stream` with `Last-Event-ID` and backoff 1 s/2 s/5 s; on `204`
  reload messages. When opening a conversation whose `running_turn` is not null, attach to `/stream` and rebuild the reply.
  Leaving the page must never cancel generation (it doesn't server-side; don't call interrupt on unmount).
- **Media URLs** are signed and expire (7 days): render them directly in `<img>`/`<video playsinline controls>`, never
  persist them; refetch messages/jobs to get fresh ones.
- **Service worker**: precache the app shell only. Never cache `/api/*` or `/media/*` responses.
- Responsive: mobile first (the PWA will mostly be used on phones), dark mode, accessible (keyboard, focus, aria-live for streaming text).
- Keep API access in one typed client module (`src/api/`) with types mirroring API.md (snake_case on the wire).

## Definition of done

- Every flow above works against the **production API** with a test account, on Chrome desktop and iOS Safari (installed as PWA).
- Streaming visibly appends text; killing the network mid-reply and restoring it resumes the same reply without duplicates.
- Reloading the browser during a running chat turn shows the partial reply and continues streaming.
- ✨ Enhance replaces the textarea, preselects size/ratio/seconds, and Undo restores the original.
- A video job survives closing and reopening the app and shows its result when done.
- No API key or refresh token is ever logged; `npm run build` and lint/typecheck pass; README explains env vars and deployment.
- Unit tests for the SSE parser/reconnect logic and the auth refresh queue; a Playwright smoke test for login → chat → stream.

## Working agreement

- Work in small, reviewable commits per feature. Do not invent endpoints or fields — check API.md.
- Observed latencies to design loading states for: chat first token 2–7 s, documents 8–20 s, enhance 2–10 s,
  images 10–30 s, videos 3–8 min (up to 30).
- If something in the backend behaves differently from API.md, record it in `BACKEND_REQUESTS.md` with the
  `X-Request-Id` of the failing call.
