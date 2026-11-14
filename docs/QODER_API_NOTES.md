# Qoder Cloud Agents API — payload notes (observed live, 2026-11-14)

Base: `https://api.qoder.com/api/v1/cloud`. Auth: `Authorization: Bearer <token>`. JSON in/out.
Error envelope (all non-2xx):
```json
{"type":"error","request_id":"uuid","error":{"type":"invalid_request_error","message":"Field 'model' must reference an available model.","code":"optional","param":"optional"}}
```
Types: 400 invalid_request_error, 401 authentication_error, 403 permission_error, 404 not_found_error, 409 conflict_error, 429 rate_limit (gateway), 500 api_error, 503 api_error|feature_not_available.

List envelope: `{"data":[…], "first_id":…, "last_id":…, "has_more":false, "next_page":null}`; query `limit`, cursors `after_id`/`before_id`.

## Models
`GET /models` →
```json
{"data":[{"id":"efficient","type":"model","display_name":"Efficient","source":"system","is_enabled":true,"is_new":false,
  "price_factor":0,"is_vl":true,"support_disable_reasoning":false,"max_input_tokens":200000,"default_context_window":200000,
  "efforts":["low","high"],"default_effort":"high","available_context_windows":[200000]}],"has_more":false}
```
Ids seen: auto, ultimate, fast, efficient, smodel, cmodel, qmodel_latest, qmodel_38max, qfmodel, kmodel_latest, kmodel, gmodel, gfmodel, dmodel, dfmodel, mmodel.

## Environments
`GET /environments`, `POST /environments {"name":"stillgpt"}` → `{"id":"env_…","type":"environment","name":…,"config":{"type":"cloud",…}}`

## Agents
`POST /agents`
```json
{"name":"qr-chat","model":"efficient" | {"id":"qfmodel","effort":"low"},"system":"…",
 "tools":[{"type":"agent_toolset_20260401","enabled_tools":["ImageGen","DeliverArtifacts"]}]}
```
→ `{"id":"agent_…","type":"agent","name":…,"model":…,"system":…,"tools":[…],"version":1,…}`. `tools: []` = no tools.
Unknown model → 400 "Field 'model' must reference an available model." `GET /agents?limit=50`, `POST /agents/{id}/archive`.

## Sessions
`POST /sessions {"agent":"agent_…","environment_id":"env_…","title"?,"metadata"?,"budget"?:{"type":"limit","max_credit_cost":"1.00"},"resources"?:[…]}`
→ `{"id":"sess_…","type":"session","status":"idle","agent":{"id","name","model":{"id":"efficient","effective_context_window":200000},"system","tools","version"},"environment_id",…,"stats":{"active_seconds":0,"duration_seconds":0}}`

`POST /sessions/{id}` (update) header `x-qoder-beta: session-agent-patch-2026-07-21`
```json
{"agent":{"model":"qfmodel","system":"…","tools":[…]},"title"?,"metadata"?,"budget"?}
```
→ updated session. Invalid model → 400 as above. (Observed: also works without the beta header for `model`.)

`GET /sessions?limit=`, `GET /sessions/{id}`, `POST /sessions/{id}/archive`, `DELETE /sessions/{id}`.

## Events
`POST /sessions/{id}/events`
```json
{"events":[{"type":"user.message","content":[
  {"type":"text","text":"hi"},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<b64>"}},
  {"type":"image","source":{"type":"url","url":"https://…"}},
  {"type":"image","source":{"type":"file","file_id":"file_…"}}]}]}
```
Also `{"type":"user.interrupt"}`. Returns 200 `{}`-ish; processing is async.
Base64 image ≤ 10 MiB, ≤ 8000 px per side, ≤ 100 images per message. Body ≤ 4 MB.

`GET /sessions/{id}/events?limit=100` → list envelope of buffered events (ascending).

`GET /sessions/{id}/events/stream[?event_deltas[]=agent.message]` — SSE. Header `Last-Event-ID` resumes after that id.
Without Last-Event-ID on an idle session, nothing is replayed. Heartbeat every ~15 s: `event: heartbeat` / `data: {}` (no id).
Frame format:
```
id: evt_x
event: agent.message
data: {"id":"evt_x","type":"agent.message","processed_at":"…","content":[{"type":"text","text":"Hello"}]}
```
Delta frames (only with event_deltas):
```
id: evt_m
event: event_start
data: {"event":{"id":"evt_m","type":"agent.message"},"type":"event_start"}

id: evt_m
event: event_delta
data: {"delta":{"content":{"text":"Hel","type":"text"},"index":0,"type":"content_delta"},"event_id":"evt_m","type":"event_delta"}
```
then the buffered `agent.message` with the same id. `agent.thinking` may get an `event_start` only.

Typical turn order (buffered events):
```
user.message
session.status_running
session.thread_status_running
agent.thinking                              {}
agent.tool_use        {"name":"ImageGen","input":{…},"evaluated_permission":"allow"}
span.model_request_end {"is_error":false,"model_usage":{"credits":0.07}}
agent.tool_result     {"tool_use_id":"evt_…","is_error":false,"content":[{"type":"text","text":"Image generated successfully! The absolute path of the image is: /data/vibe_images/x.png …"}]}
agent.artifact_delivered {"file_id":"file_…","original_filename":"x.png","size":1546107,"content_type":"image/png"}
agent.message         {"content":[{"type":"text","text":"Delivered …"}]}
session.thread_status_idle {"stop_reason":{"type":"end_turn"}}
session.usage         {"model_credits":0.11,"sandbox_runtime_credits":0,"total_credits":0.11}
session.status_idle   {"stop_reason":{"type":"end_turn"}}
```
Other: `session.error {"error":{"type","message"}}`, `session.status_terminated`, `span.model_request_start`, stop_reason types `end_turn|requires_action|interrupted|budget_exceeded`(assumed).

## Files
`POST /files` multipart field `file` (+ optional `name`), ~5 MB max →
`{"id":"file_…","type":"file","filename":"a.pdf","size_bytes":925,"mime_type":"application/pdf","downloadable":false,"scope":null,"created_at":…}`
`GET /files/{id}` → same object (+`metadata`, `scope` for artifacts: `{"id":"sess_…","type":"session"}`, `downloadable:true`).
`GET /files/{id}/content` → `{"url":"https://…presigned…","expires_at":"…"}` (403 if not downloadable).
`POST /sessions/{id}/resources {"type":"file","file_id":"file_…","mount_path":"/data/x.pdf"}` → `{"id":"sesr_…",…}`.

## ImageGen / VideoGen tool inputs (as the agent calls them)
ImageGen `{"name":"orange-cat","prompt":"…","size":"1792x1024","images"?:["/data/in.png"]}`
VideoGen `{"name":"…","prompt":"…","mode":"text_to_video|first_frame_to_video|reference_to_video","duration_seconds":5,
  "resolution":"1080P","ratio":"16:9","audio":true,"media":{"first_frame":{"type":"image","source":"/data/cat.png"},"last_frame"?:…,"references"?:[…]}}`
Tool results: `"Video generated successfully! The absolute path of the video is: /data/vibe_videos/x.mp4\nVideo ID: …\nduration: 5s, resolution: 1080P, ratio: 16:9, bytes: 10069783"`.
