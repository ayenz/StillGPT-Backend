# StillGPT — backend

A "personal LLM" backend on top of **Qoder Cloud Agents**: chat, photo/document analysis, web search, image and video
generation. It serves a native API for our own apps (PWA, later Flutter) **plus** **OpenAI-compatible** and
**Anthropic-compatible** endpoints, so n8n, SDKs and other tools can use it directly.

- Architecture and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Native API reference (for the frontend team): [docs/API.md](docs/API.md)
- Frontend integration guide: [docs/FRONTEND_GUIDE.md](docs/FRONTEND_GUIDE.md) (PDF: [docs/pdf/StillGPT-Frontend-Guide.pdf](docs/pdf/StillGPT-Frontend-Guide.pdf))
- Brief for an AI frontend agent: [docs/FRONTEND_AGENT.md](docs/FRONTEND_AGENT.md)
- Qoder API notes (observed directly): [docs/QODER_API_NOTES.md](docs/QODER_API_NOTES.md)

## Run locally

```bash
npm install
cp .env.example .env          # fill in QODER_PAT, JWT_SECRET, ADMIN_EMAIL/PASSWORD
npm run dev                   # http://localhost:8790  (DB: embedded PGlite in ./data)
```

## Tests

```bash
npm run typecheck
npm test                      # full e2e suite against a mock Qoder (no internet, no credits)
QODER_PAT=pt-… npm run test:live                     # smoke test against the real Qoder (free model)
QODER_PAT=pt-… QODER_LIVE_MEDIA=1 npm run test:live  # + 1 image
```

## Deploy (Docker Compose)

```bash
cp .env.example .env && $EDITOR .env      # PUBLIC_BASE_URL, CORS_ORIGINS, secrets, QODER_PAT/QODER_SA_KEY
docker compose up -d --build
curl -s localhost:8790/readyz
```
Put a reverse proxy or tunnel in front of `127.0.0.1:8790` and disable buffering for SSE
(nginx: `proxy_buffering off; proxy_read_timeout 3600s;`).

## Endpoints at a glance

| Path | Purpose |
|---|---|
| `/api/v1/*` | Native API (auth, conversations + SSE, files, image/video jobs, webhooks, usage) |
| `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/images/*`, `/v1/videos*` | OpenAI-compatible |
| `/v1/messages`, `/v1/messages/count_tokens` | Anthropic-compatible |
| `/media/:id?exp&sig` | Signed file downloads (usable directly in `<img>`/`<video>`) |
| `/healthz`, `/readyz` | Health checks |

## Models

Clients use aliases (`default`, `smart`, `fast`, `cheap`, `vision`) or Qoder model ids (`ultimate`, `qoder/kmodel`, …).
The catalogue is synced from Qoder every hour; retired models are transparently redirected to the `default` chain
without errors on the client side, and catalogue changes are sent as `model.added|retired|updated` webhooks.
