# HTTP API

Loreloom's server is a small JSON API on `http://localhost:4747`. It is meant for
the bundled client and for local scripts; there is no authentication because it
binds to loopback and assumes a single author (see [`SECURITY.md`](../SECURITY.md)).

All request and response bodies are JSON unless noted. Errors use
`{ "error": "message", "code": "machine_code_or_null" }` with an appropriate HTTP
status (400 validation, 404 missing, 409 no AI model, 500 unexpected, 502 unusable
model response).

## Novels

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/novels` | list with word/chapter counts |
| `POST` | `/api/novels` | `{ title, genre?, synopsis? }` |
| `GET` | `/api/novels/:id` | one novel |
| `PUT` | `/api/novels/:id` | update metadata |
| `DELETE` | `/api/novels/:id` | cascades chapters, characters, world, timeline, memory, versions |

## Chapters and versions

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/novels/:novelId/chapters` | metadata only (no bodies) |
| `POST` | `/api/novels/:novelId/chapters` | `{ title? }`; appends at the end |
| `GET` | `/api/chapters/:id` | full body + notes |
| `PUT` | `/api/chapters/:id` | `{ title?, body?, notes?, status? }`; `?source=manual` forces a version snapshot |
| `DELETE` | `/api/chapters/:id` | |
| `PUT` | `/api/novels/:novelId/chapters/reorder` | `{ order: number[] }` |
| `GET` | `/api/chapters/:id/versions` | revision history metadata |
| `GET` | `/api/chapters/:id/versions/:versionId` | snapshot with body |
| `POST` | `/api/chapters/:id/versions/:versionId/restore` | restores, itself snapshotting current text |
| `GET` | `/api/novels/:novelId/search?q=` | full-text-ish chapter search |

Autosave uses `PUT /api/chapters/:id`; snapshots are created at most once per
short interval, plus always for `?source=manual` (used by AI edits and restores).

## Characters

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/novels/:novelId/characters` | |
| `GET` | `/api/novels/:novelId/characters/pending` | AI-suggested profiles awaiting review |
| `POST` | `/api/novels/:novelId/characters/pending/:suggestionId/decision` | `{ decision: "accept" \| "reject" }` |
| `GET` | `/api/novels/:novelId/characters/graph` | nodes + edges for the relationship map |
| `POST` | `/api/novels/:novelId/characters/:id/merge` | `{ intoId }` duplicate merge |
| `GET` | `/api/novels/:novelId/characters/:id` | profile + appearances |
| `POST` / `PUT` / `DELETE` | `/api/novels/:novelId/characters[/:id]` | manual CRUD |

## World, timeline, memory

| Method | Path |
|---|---|
| `GET/POST` | `/api/novels/:novelId/world` |
| `PUT/DELETE` | `/api/novels/:novelId/world/:id` |
| `GET/POST` | `/api/novels/:novelId/timeline` |
| `PUT` | `/api/novels/:novelId/timeline/reorder` |
| `PUT/DELETE` | `/api/novels/:novelId/timeline/:id` |
| `GET/POST` | `/api/novels/:novelId/memory` |
| `PUT/DELETE` | `/api/novels/:novelId/memory/:id` |
| `POST` | `/api/novels/:novelId/memory/bulk` (approve/reject/delete in bulk) |

Memory buckets: `canon`, `provisional`, `ai_suggestion`, `question`, `rejected`.

## AI (`/api/ai`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/ai/status` | queue + availability summary |
| `POST` | `/api/ai/write` | **SSE stream**; `{ novelId, input, mode, chapterId?, selection? }` |
| `POST` | `/api/ai/assistant/chat` | **SSE stream**; `{ novelId, messages }` |
| `POST` | `/api/ai/brainstorm` | `{ novelId, category, prompt? }` |
| `POST` | `/api/ai/editor` | `{ novelId, text (≤16,000 chars), modes: [] }` → `{ revised, changes[], model }` |
| `POST` | `/api/ai/analyze-chapter` | `{ chapterId }` → summary + memory suggestions |
| `POST` | `/api/ai/continuity` | `{ chapterId? , novelId? }` → evidence-backed issues |
| `POST` | `/api/ai/memory-search` | `{ novelId, query }` semantic retrieval |
| `POST` | `/api/ai/reindex` | rebuild embeddings for a novel |
| `POST` | `/api/ai/project-overview` | whole-manuscript overview |
| `GET` | `/api/ai/drafts?novelId=` | recoverable streamed drafts |
| `DELETE` | `/api/ai/drafts/:novelId/:id` | |
| `POST` | `/api/ai/analyze-characters` | `{ chapterId }` extract from one chapter |
| `POST` | `/api/ai/analyze-novel-characters` | `{ novelId }` sweep the manuscript |

Editing modes accepted by `/api/ai/editor`: `grammar`, `structure`, `vocabulary`,
`repetition`, `dialogue`, `pacing`, `description`, `tone`.

The editor endpoint never writes to the manuscript. It returns a proposed
`revised` text plus explicit `changes`, and the client applies it only after the
author clicks Apply (which snapshots first). If the model replies in prose or
rewrites without listing changes, the request fails with 502 and nothing changes.

## Export and reports

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/novels/:novelId/export?format=docx\|pdf\|txt&statuses=` | downloads a manuscript |
| `GET` | `/api/novels/:novelId/report` | word-count / chapter report JSON |

## Ollama and hardware

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/ollama/status` | installed models, reachability |
| `GET` | `/api/ollama/health` | version ping |
| `GET` | `/api/ollama/hardware` | CPU/RAM/GPU detection |
| `GET` | `/api/ollama/routing` | which model is chosen per tier |
| `POST` | `/api/ollama/test` | one-token generation test |
| `POST` | `/api/ollama/pull` | `{ name }` starts a download; returns task id |
| `GET` | `/api/ollama/pull/:id` | progress |
| `DELETE` | `/api/ollama/pull/:id` | cancel |
| `DELETE` | `/api/ollama/models/:name` | remove a model |

## Preferences, backups, dashboard

| Method | Path | Notes |
|---|---|---|
| `GET/PUT` | `/api/preferences` | model tiers, queue limits, UI prefs |
| `GET` | `/api/backups` | snapshots + current DB size |
| `POST` | `/api/backups` | create a snapshot now |
| `POST` | `/api/backups/restore` | `{ filename }`; restart afterwards |
| `GET` | `/api/dashboard` | totals for the dashboard |
| `GET` | `/api/health` | `{ ok: true, app: "loreloom" }` |

## Streaming format

`/api/ai/write` and `/api/ai/assistant/chat` answer with
`text/event-stream`, one JSON object per `data:` line:

```json
{"type":"start","model":"llama3.2:3b"}
{"type":"token","text":"The rain "}
{"type":"done"}
```

Errors arrive as `{"type":"error","message":"...","code":"no_model"}` on an HTTP
200 stream, because headers are already sent. Aborting the request cancels the
Ollama call.
