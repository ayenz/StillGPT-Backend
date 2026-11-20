# StillGPT — Multi-agent runs: Deep Research, Council, Short Film (design)

Status (2026-11-20): **engine + Council implemented** (see ARCHITECTURE §7b, API §15); Deep Research and Short Film
are still design. Assumes Qoder usage is free, so the designs favour quality
(more agents, more models, re-rolls) over cost. The real limits are upstream concurrency (429/draining, ~1 concurrent
VideoGen) and our own chat latency, so those get explicit caps.

Three features share one engine:

| feature | what the user gets | Qoder work per request |
|---|---|---|
| **Deep Research** | a cited report (Markdown in chat + PDF/DOCX) | 30–80 turns with WebSearch/WebFetch |
| **Council** | the best answer from every model, judged and merged | N models (~16) + debate rounds + judges + synthesis |
| **Short Film** | a 30–180 s film with a consistent cast, assembled from scenes | ~10 LLM turns, 20–40 ImageGen, 6–20 VideoGen |

---

## 0. Shared engine: Runs (`core/runs/`)

A **run** is a long job made of named **steps**. Orchestration is deterministic TypeScript (not an LLM deciding
what to call next): a stage function asks for step outputs by key; a step that already completed is read from the DB
instead of executed. Re-running the stage function after a restart therefore resumes where it stopped (same idea as
durable workflow engines, just without a framework).

### Tables

```ts
runs {
  id, userId, kind: 'research' | 'council' | 'film',
  status: 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled',
  input jsonb,            // validated request
  state jsonb,            // plan, script, current stage… (what the UI shows)
  result jsonb,           // final output: text, file ids
  conversationId?,        // chat this run answers in (result is posted as an assistant message)
  messageId?,             // that assistant message (placeholder while running)
  progress int, credits double, error jsonb,
  createdAt, startedAt, completedAt, deletedAt
}
run_steps {
  id, runId, key,         // unique (runId, key), e.g. 'plan', 'research:r1:q3', 'scene:4:video'
  kind: 'turn' | 'image' | 'video' | 'local',
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped',
  attempt int, input jsonb, output jsonb,
  conversationId?,        // hidden one-shot conversation of a turn step
  jobId?,                 // media_jobs row of an image/video step
  model?, credits, error, startedAt, completedAt
}
```

### RunService

```ts
step<T>(run, key, kind, exec: () => Promise<T>): Promise<T>   // memoized by (runId, key)
turn(run, key, { profile, model, text, attachments?, json?: ZodSchema }) // hidden one-shot turn (like enhancer)
image(run, key, ImageRequest) / video(run, key, VideoRequest)  // via MediaService (queue, draining retry, resume)
emit(run, RunEvent)                                            // bus topic `run:<id>`
waitForInput(run, kind)                                        // status awaiting_input; resumed by POST /approve
```

- **JSON turns**: `turn({ json: schema })` strips code fences, parses, validates with Zod; on failure it re-asks once in
  the same session ("Your reply was not valid JSON: <zod error>. Reply with only the JSON.") before failing the step.
- **Retries**: a failed step is retried up to 2× with backoff for retryable errors (429, 503, draining, stream drop).
  Stage code decides whether a failed step is fatal (plan) or skippable (one of 12 research workers).
- **Concurrency**: a global semaphore `RUN_TURN_CONCURRENCY` (default 12) for run turns, separate from user chat turns,
  so a 16-model council never starves normal chat. Images go through MediaService as they do now; videos keep
  `VIDEO_CONCURRENCY`.
- **Resume**: on boot, `running` runs are re-entered. A step left `running` with a hidden conversation whose turn finished
  reads its result from `messages`; otherwise it is re-run (hidden one-shot turns are idempotent enough).
- **Cancel**: `POST /runs/:id/cancel` → interrupts live turns (`user.interrupt`), marks queued steps `skipped`.
  Video jobs that already started upstream cannot be cancelled (Qoder limitation); their result is discarded.
- **Notifications**: finished/failed runs reuse Web Push + FCM (`push.ts`, `fcm.ts`) and user webhooks
  (`run.completed`, `run.failed`).

### API (native)

```
POST   /api/v1/runs                     {kind, input, conversation_id?}  → run
GET    /api/v1/runs?kind=&cursor=       list
GET    /api/v1/runs/:id                 run + steps (UI state)
GET    /api/v1/runs/:id/events          SSE: run.* / step.* / *.delta (replays from start, like turns)
POST   /api/v1/runs/:id/cancel
POST   /api/v1/runs/:id/approve         {edits?}  resume an awaiting_input run (edited plan / storyboard)
POST   /api/v1/runs/:id/steps/:key/redo {input?}  re-roll one step (a research question, a storyboard panel, a scene)
DELETE /api/v1/runs/:id                 soft delete (files follow the media trash rules)
```

Chat integration: `POST /conversations/:id/messages` accepts `mode: 'research' | 'council'`. It creates the run linked
to the conversation, inserts an assistant placeholder message, streams run events on the turn SSE, and replaces the
message with the final text + artifacts. History preamble = the conversation's last turns.

### RunEvent

```ts
| { type: 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled'; runId }
| { type: 'run.stage'; stage: string; label: string; progress: number }      // "Researching (round 2/3)"
| { type: 'run.awaiting_input'; what: 'plan' | 'storyboard' }
| { type: 'step.started' | 'step.completed' | 'step.failed'; key; summary? }
| { type: 'step.delta'; key; text }                                          // live text of a worker (council panels)
| { type: 'run.text.delta'; text }                                           // final answer streaming
| { type: 'run.artifact'; artifact }
```

### New profiles

| profile | tools | used by |
|---|---|---|
| `research` | WebSearch WebFetch Bash Read Glob Grep DeliverArtifacts | research workers, fact-checkers, report rendering |

Council and planning/writing steps use `chat` (no tools, fastest). Film uses `chat`, `image` and `video`.

---

## 1. Deep Research (`kind: 'research'`)

### Input
```ts
{ question: string, depth: 'quick' | 'standard' | 'deep',   // fan-out 4 / 8 / 14, rounds 1 / 2 / 3
  language?: string,                                        // default: language of the question
  formats?: ('md' | 'pdf' | 'docx')[],                      // md always
  review_plan?: boolean,                                    // pause for plan approval (default false)
  attachment_file_ids?: string[] }                          // user docs mounted for every worker
```

### Stages
1. **Plan** (`smart`, chat): JSON `{title, objective, sub_questions:[{id, question, why, search_hints[]}], outline:[{section, covers:[ids]}]}`.
   If `review_plan`, the run waits; the UI lets the user edit/delete/add questions, then `/approve`.
2. **Research round r** — one `research` turn per open sub-question, in parallel. Instruction: search broadly,
   open ≥ 4 primary sources, prefer recent and official ones, then reply JSON
   `{summary, findings:[{claim, evidence_quote, url, title, published?, confidence: 'high'|'medium'|'low'}], open_questions[]}`.
   A worker that fails twice is skipped (the report notes the gap).
3. **Gap analysis** (`smart`): all findings so far → `{done: bool, follow_ups:[sub_question]}` (≤ fan-out/2).
   Loops to stage 2 until `done` or the round limit.
4. **Fact-check** (`deep` only): the 10 most load-bearing or contradictory claims go to verifier `research` turns that
   re-open the cited URL and answer `{supported: 'yes'|'partly'|'no', note, better_url?}`. Unsupported claims are dropped
   or flagged.
5. **Write** — sources are deduplicated in code and numbered. One writer turn per outline section, in parallel
   (each gets only its findings + the source table, cites as `[n]`), then an **editor** turn merges them: executive
   summary, consistent voice, conflicts called out, "limitations" section. Streams to the chat as `run.text.delta`.
6. **Render**: report.md saved as a file. PDF/DOCX: one `research` turn with report.md mounted runs pandoc in the
   sandbox and delivers `report.pdf` / `report.docx` (sandbox has pandoc + libreoffice).
7. **Deliver**: assistant message = report Markdown + artifacts; sources list in `result.sources`.

Rough volume (`deep`): 1 plan + 14×3 workers + 3 gap + 10 checks + ~7 writers + editor + render ≈ **65 turns**,
15–25 min wall clock at concurrency 12.

---

## 2. Council (`kind: 'council'`)

### Input
```ts
{ prompt: string, attachment_file_ids?: string[],
  models?: 'all' | string[],                 // 'all' = every active Qoder model + Folax chat models, deduped by display name
  mode: 'best' | 'synthesize' | 'debate',    // default 'synthesize'
  debate_rounds?: 1 | 2,                     // mode 'debate'
  judges?: string[] }                        // default ['smart', 'kmodel_latest', 'gmodel'] (first 3 active)
```

### Stages
1. **Answer**: one hidden one-shot turn per model, all in parallel (`chat` profile; `assistant` if attachments are documents).
   Chat history is passed as preamble. Each answer streams as `step.delta {key: 'answer:<model>'}` → the UI shows a
   live grid of panels.
2. **Debate** (mode `debate`): each model sees the other answers anonymised (A, B, C…) and revises its own:
   "keep what you are sure of, fix what others showed you got wrong". Repeated `debate_rounds` times.
3. **Judge**: each judge sees all answers shuffled and anonymised and returns
   `{category: 'coding'|'math'|'writing'|'factual'|'advice'|'other', scores:[{id, correctness, completeness, clarity, total}], ranking:[ids], best_parts:[{id, why}]}`.
   Rankings are combined with Borda count; ties go to the higher mean `total`.
4. **Final**:
   - `best` → winning answer as is (+ a footer naming the model);
   - `synthesize`/`debate` → `smart` writes the final answer from the top 3 + `best_parts`, streamed as `run.text.delta`.
5. **Stats**: table `council_results {runId, model, category, rank, score, won, latencyMs, failed}`.
   `GET /admin/council/leaderboard?category=` shows win rate and mean score per model/category.
   Phase 2: a job proposes `MODEL_ALIASES` changes (e.g. `smart` → the model that wins most `coding`/`factual`) as an
   admin webhook; nothing changes automatically.

Exposed as a model too: `model: "council"` (and `council-debate`) in `/v1/chat/completions`, `/v1/messages` and the
chat model picker → the compat layer runs a council and streams the final answer, so n8n and SDKs get it for free.

Volume per message (16 models, debate ×2, 3 judges): 16 + 32 + 3 + 1 = **52 turns**, ~1–2 min.

---

## 3. Short Film (`kind: 'film'`)

### Input
```ts
{ idea: string, duration_s: 30..180 (default 60), ratio: '16:9' | '9:16' | '1:1',
  style?: string,                        // "Ghibli watercolor", "gritty 35mm noir"…
  language?: string,                     // dialogue/caption language
  cast_face_ids?: string[],              // saved faces (faces table) to star in it
  captions?: boolean,                    // burn in dialogue (default true)
  review?: 'none' | 'script' | 'storyboard',  // where to pause for approval (default 'storyboard')
  video_provider?: 'qoder' | 'folax' }   // folax = parallel image-to-video when configured
```

### Stages
1. **Script** (`smart`): JSON
   `{title, logline, style_bible:{look, palette, lighting, lens, era}, characters:[{id, name, appearance, wardrobe}],
     scenes:[{n, seconds 3–10, location, action, camera, dialogue?:[{character, line}], sfx, mood}]}`;
   scene seconds sum to `duration_s` ± 10%. A second `smart` turn critiques pacing/continuity and returns a revised script
   (free → always do it).
2. **Cast sheets**: per character an ImageGen portrait (neutral background, full body + face, the style bible). With
   `cast_face_ids` the portrait is face-swapped with the saved face (existing swapper pipeline).
3. **Storyboard**: per scene an ImageGen keyframe with up to 3 inputs (cast sheets of the characters in the scene) +
   style bible + scene text, at the film ratio. All scenes in parallel.
   **Quality gate**: a `vision` turn scores each keyframe against scene text and cast sheets
   `{matches_scene, character_consistency 1–5, artifacts[]}`; below threshold → re-roll (max 2).
   Optional pause (`review: 'storyboard'`): the UI shows the panels; the user can redo a panel (with a note) or approve.
4. **Animate**: per scene a VideoGen `first_frame_to_video` from its keyframe (`last_frame` = next keyframe when the
   script marks a continuous cut), `duration_seconds` = scene seconds, 1080P, `audio: true`, prompt = action + camera +
   dialogue + sfx. Runs through MediaService video jobs (queue, draining retry, restart resume). Qoder allows ~1 video at
   a time → scenes run back to back (~4 min each); with `video_provider: 'folax'` they run in parallel.
   **Quality gate**: ffmpeg grabs 3 stills per clip → `vision` turn checks consistency/glitches → re-roll once.
5. **Assemble** (local ffmpeg — clips are ~10 MB each, too big for Qoder uploads, and ffmpeg is already in our image):
   normalise every clip (scale+pad to the film resolution, 30 fps, add silent audio where missing),
   title card (ImageGen title art → 3 s still with fade), `xfade`/`acrossfade` transitions, captions from the dialogue
   (`subtitles` filter from a generated SRT, also kept as a sidecar `.srt`), end card, `loudnorm`.
6. **Deliver**: final MP4 saved as a file and as a `media_jobs` video row (`request.film_run_id`), so it shows in the
   gallery with a thumbnail; scenes and storyboard stay attached to the run. Push + FCM.

Volume (60 s, 8 scenes): ~4 LLM turns, ~2 cast + 8 keyframes + re-rolls ≈ 15–20 images, 8–12 videos, ~20 vision checks.
Wall clock ~40–60 min with Qoder video, ~10–15 min with Folax.

Not possible with current tools: separate narration/TTS and music tracks (VideoGen's own audio only). A free TTS
sidecar could be added later to the assemble step.

---

## 4. Clients

- **PWA / Flutter**: a "Research" and "Council" toggle in the composer (chat integration); a Council grid view with
  live panels and the judge scoreboard; a "Film studio" page: idea form → script view → storyboard grid
  (redo/approve) → progress per scene → player. Run list under the gallery.
- Everything is driven by `GET /runs/:id` + the SSE, so a reopened app resumes the view.

## 5. Implementation order

1. Run engine: tables + migration, RunService (step memo, JSON turns, semaphore, resume, cancel), routes, SSE,
   push/webhook, mock-qoder scripting for JSON replies. Tests: resume after restart, step retry, cancel.
2. Council (smallest; proves fan-out + streaming), incl. `model: "council"` in compat APIs + leaderboard.
3. Deep Research (+ `research` profile, pandoc render).
4. Short Film (+ local ffmpeg assembly, quality gates, storyboard approval).
5. PWA, then Flutter UI.

Each step ships with e2e tests against the mock and one opt-in live smoke test (`test/live`).
