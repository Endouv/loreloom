# Loreloom — Architecture Plan (Phase 1)

> Local-first AI novel-writing environment, powered by Ollama.
> **Author controls the story. Loreloom assists.**

Application name chosen: **Loreloom** — a loom that weaves lore: characters, world rules,
plot threads and prose woven into one manuscript. This document is the Phase 1 plan;
implementation follows the roadmap in `ROADMAP.md` after approval.

---

## 1. Detected environment (verified on this machine, 2026-11-02)

| Item | Value | Implication |
|---|---|---|
| OS | Ubuntu 26.04.1 LTS (Linux) | Native Ollama, Node app runs locally |
| CPU | 8 cores | 3B–4B quantized models ≈ 10–25 tok/s |
| RAM | 7 GB total, ~2.8 GB available + 4 GB swap | **Avoid 7B+ models; keep generative model residency minimal** |
| GPU | Intel Iris Xe (iGPU only) | Ollama runs **CPU-only** (no CUDA/ROCm); plan speed budgets accordingly |
| Disk | 158 GB free | Model library fits easily |
| Node | v22.22.1 + npm 9.2.0 | TypeScript monorepo with npm workspaces |
| Ollama | 0.40.13 installed **and running** on `localhost:11434` | No model files installed yet (`/api/tags` empty) |

**Constraint honored everywhere:** never hold two generative models in memory at once;
serialize heavy generation through a task queue; keep retrieval context small.

## 2. Technology stack (chosen)

- **Client:** Vite + React 18 + TypeScript + Tailwind CSS. Editor: **CodeMirror 6** (fast,
  comfortable for 100k-word manuscripts, easy word counts and inline decorations).
- **Server:** Node 22 + Express + TypeScript. Serves the built client in production and
  exposes a JSON API under `/api/*`. Runs on the author's machine only.
- **Database:** **SQLite via better-sqlite3** (synchronous, transactional, zero-config,
  single file — ideal for local-first). Strict WAL mode, foreign keys on.
- **Semantic search:** Ollama `nomic-embed-text` embeddings stored as BLOBs in SQLite +
  brute-force cosine ranking in-process. At manuscript scale (hundreds to low thousands
  of embedded chunks) this is microseconds-fast and needs no external service.
- **Export:** `docx` (DOCX), `pdfkit` (PDF), plain text writer (TXT).
- **Ollama client:** direct `fetch` against `http://localhost:11434` (OpenAI-compatible
  endpoint also exists; native `/api/*` used for tag listing, embeddings, and streaming
  `ndjson` generation).

No cloud services, no paid APIs, no telemetry in the core workflow.

## 3. Repository layout (npm workspaces monorepo)

```
loreloom/
  package.json            # workspaces: client, server; shared scripts
  docs/                   # this plan, roadmap, feature-status ledger
  server/
    src/
      db/                 # schema.ts, migrate.ts, connection
      ollama/             # client.ts, health.ts, models.ts, queue.ts, embeddings.ts
      agents/             # coordinator.ts + task modules (writers/editors/extractors)
      routes/             # express routers per resource + /api/ai
      export/             # docx/pdf/txt writers
      util/               # hardware detection, validation, error handling
    data/                 # loreloom.db (gitignored) + backups/
  client/
    src/
      app/                # router, shell, navigation
      views/              # Dashboard, Novels, Editor, Assistant, Characters,
                          # World, Memory, Timeline, Continuity, Settings
      components/         # reusable UI (cards, lists, modals, diff view, streaming text)
      api/                # typed fetch client with abort support
                          # + auth/data
```

## 4. Database schema (SQLite, v1)

Tables (all keyed by integer PKs, `novel_id` scoping everywhere):

- `novels` — title, genre, status, target_words, synopsis, tags, created/updated.
- `chapters` — novel_id, title, body, status (`draft|revision|completed`), position,
  notes, word_count, updated_at.
- `chapter_versions` — chapter_id, body snapshot, signed version number, source
  (`autosave|manual|pre-edit|restore`), created_at. Restore = insert restored snapshot as
  a new head version (never destructive).
- `characters`, `character_versions_tick` — name, aliases (JSON), personality, appearance,
  background, motivations, strengths, weaknesses, relationships (edge table
  `character_links`: from_id, to_id, kind, notes), first_appearance_chapter, story_status,
  events, dev_notes, free_notes.
- `world_entries` — novel_id, category (region/city/history/organization/culture/
  technology/magic/science/rule/mystery/record), title, body, fields JSON, links.
- `timeline_events` — novel_id, chapter_id?, title, description, story_date (ordered
  numeric + label), order_index, kind, character_ids JSON, manual order.
- `memory_items` — novel_id, text, bucket
  (`canon | provisional | ai_suggestion | question | rejected`), source
  (`author | ai`), chapter_ref, embedding BLOB, created/approved/rejected timestamps.
  **Only rows moved to `canon` by the author are treated as canon.** AI suggestions land
  in `ai_suggestion` and stay there.
- `embeddings_chunks` — novel_id, chapter_id?, text, embedding BLOB, model name, hash
  (dedup by hash; re-embed only when text changes).
- `preferences` — singleton JSON blob: theme, language, style, AI temperature/behaviour,
  model routing table, autosave interval, export defaults.
- `agent_activity` — task type, model used, latency, tokens, success/error, timestamp
  (transparent usage log, feeds the Settings → Activity view).

Backups: on every server start, wait-free copy of `loreloom.db` into `data/backups/`
(rolling last 10) + manual "Back up now" button; restore = stop server, replace file.

## 5. Ollama integration

### Detection & health
- Detect presence at `http://localhost:11434` (process check + `/api/tags` probe).
- UI shows: connected / not-installed / stopped, installed models with sizes, an
  "ohai"-style recommendation panel, and one-click `ollama pull <tag>` executed through a
  thin server-side wrapper (`/ollama/api/pull` progress streamed to the UI with
  cancellable progress). Downloading; **only with explicit user permission in chat**).

### Hardware-aware model recommendation
The server detects OS, CPU cores, total/available RAM, GPU (nvidia-smi/ROCm/lspci),
free disk, and maps that to a safe model budget:

- Light tier ≤ ~1.6 GB quantized file (fits shared RAM comfortably): `qwen3:1.7b` or
  `llama3.2:3b`.
- Main tier ≤ ~2.8 GB quantized file: `qwen3:4b` q4_K_M (best quality/speed for this
  CPU-only 7 GB machine).
- Embeddings: `nomic-embed-text` (0.27 GB).
- The UI explains each recommendation ("this won't be forced on you") and never
  hardcodes a single model: **every task slot is user-selectable**.

### Model routing (`preferred-model.json` in preferences)
| Task class | Default tier | Fallback |
|---|---|---|
| Prose generation (writing, expansion) | main (e.g. qwen3:4b) | light |
| Complex editing, continuity reasoning, brainstorming | main | light |
| Summarization, tagging, character/world extraction, blurbs | light (e.g. qwen3:1.7b / 3.2:3b) | main |
| Embeddings / semantic search | nomic-embed-text | — (search degrades to keyword when offline) |

The router consults `preferences.modelRouting`, verifies the chosen model is installed,
falls back to whatever compatible model exists, and records the assignment in
`agent_activity`. Users can rewire any slot in Settings → Models.

### Performance engineering
- **Task queue:** one heavy generative task runs at a time; light tasks may run
  concurrently (configurable max). Every queued task is cancellable (client
  AbortController → server request abort → frees the slot immediately).
- **Streaming:** generation streams as ndjson → server SSE → UI live text; cancellable
  mid-stream.
- **Context budget:** for every AI request the system assembles a *retrieved* prompt
  (semantic memory hits + the relevant chapter/character text + style rules), capped by a
  token budget setting — **never the whole manuscript**.
- **Model stickiness:** Ollama keeps the last model loaded; task ordering and
  `duration` keywords keep the small model resident between light jobs, and the queue
  batches same-tier tasks to avoid repeated swaps.
- **Embedding maintenance:** chapters are chunked (~600 tokens, 15% overlap) and
  re-embedded lazily only when their content hash changes.

## 6. Multi-agent design (lean, not decorative)

All agents share the same SQLite and Ollama client. They are **server task modules** with
distinct prompts, retrieval tools and validation — not chatting processes. The
**Coordinator** is the only router: it classifies an inbound request, picks the pipeline
and model tier, and calls one capability. There is no agent-to-agent chatter.

| Capability | Responsibilities | Notes |
|---|---|---|
| Writing | draft/expand/rewrite scenes from briefs + retrieved canon; honours style prefs | streams into editor |
| Editing | transform modes (grammar, vocabulary, dialogue, description, pacing, restructure); returns structured diff opinions the author accepts/rejects per change | never writes to manuscript without approval |
| Memory | extract propositions from chapters → `ai_suggestion` memory bucket for author review; summarize chapters for recaps | light tier |
| Continuity | compares draft text against retrieved canon + timeline; emits structured issue reports (problem, location, evidence, why, options) | main tier; read-only |
| Character / World | keep structured records in sync with scene text; propose updates for approval | light tier |
| Timeline | propose events from chapter summaries; manual ordering UI; detects impossible orderings (date validation) | light tier |
| Editor (fix & polish) | grammar, sentence restructure, vocabulary, repetition, dialogue, pacing, description and tone passes; returns explicit before → after changes for author approval | main tier; never auto-applies |
| Coordinator | classification + routing + prompt assembly + queue dispatch | no LLM needed for simple routes |

A literal external agent layer is not appropriate here: the app is a local product whose
AI backend must be the author's own Ollama. "Agent" therefore means these capability
modules, visible in the Settings → Activity log with model/latency per task.

## 7. UI architecture

- Left rail navigation: Dashboard · My Novels · Editor · Assistant · Characters ·
  World · Memory · Timeline · Continuity · Settings.
- **Dashboard:** projects, recent chapters, per-novel word counts and trend, quick
  actions (new chapter, ask AI, back up now), recent notes.
- **Editor** (the heart): centered 68–80ch column, serif body, adjustable line height &
  focus mode (dim everything but current paragraph), autosave (debounced 1.2 s, visible
  state chip "saved / saving / offline"), chapter tabs + drag-order, inline AI panel that
  slides over the right third (500–900 px, collapsible), version restore, per-chapter
  notes, find-across-manuscript.
- **Diff review:** side-by-side original/proposal with granular accept/reject per change
  (Editing capability output).
- **Memory view:** five buckets as filterable columns; each item has Approve / Reject /
  Edit / Delete; canon items show approval timestamps and source chapter.
- **Timeline view:** horizontal scrollable lanes (story-time) with draggable events;
  gaps flagged.
- Every AI surface states in plain language whenever a request goes to the local Ollama
  daemon only. No external network calls from the app itself; the only network endpoints
  hit are localhost:11434 and (for model downloads) the Ollama registry, gated behind the
  explicit model-download button.

## 8. Meaningful testing (Phase 7 plan)

- Unit: model router fallbacks, queue cancellation, semantic ranking, cosine/keyword
  fallback, DB migrations, version restore math.
- Integration (against real Ollama): tags listing, streaming generation with abort,
  embeddings + retrieval quality, chapter extraction pipeline, continuity checker on a
  seeded contradictory fixture.
- Manual E2E scripts: create/edit/autosave/restore chapter; export DOCX/PDF/TXT; memory
  lifecycle (suggest → reject/approve); backup/restore round-trip.
- Each verified item is ticked in `docs/FEATURES.md`; anything not implemented is labeled
  "not implemented" in the UI, never faked.
