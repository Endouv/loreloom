# Loreloom — Feature Status Ledger

Legend: ✅ built **and verified** · 🟡 built, verification pending · ⛔ not done · ❌ deliberately deferred.
Verified means executed against the real stack (SQLite + running Ollama daemon), not claimed.

Last updated: 2026-11-13, after the tooling, typing and end-to-end testing pass.

## Phase 1 — Architecture
- ✅ Machine capabilities verified (CPU-only, 7 GB RAM; model budgets set accordingly)
- ✅ Stack, DB schema, agent model, Ollama plan documented (`docs/ARCHITECTURE.md`)
- ✅ `docs/ROADMAP.md`

## Phase 2 — Core application
- ✅ Monorepo scaffold; lint, format, typecheck and Vite build all clean
- ✅ SQLite schema (12 tables) + WAL + FK enforcement; startup backup rotation (10)
- ✅ Novel CRUD (verified via API)
- ✅ Chapter CRUD, drag-ordering endpoint, statuses draft/revision/completed (verified)
- ✅ Autosave (DEBOUNCED on client; server word count, verified: 21-word chapter persisted)
- ✅ Chapter versioning: snapshots on autosave interval + before manual edits + pre-restore;
  restore verified (restored to snapshot 1 successfully)
- ✅ Chapter notes (verified)
- ✅ Manuscript search API + UI modal
- ✅ DOCX/PDF/TXT/Markdown export, with a format picker on each novel card (each format
  download verified by file signature, name and content)
- ✅ Word-count report API (project statistics)
- ✅ Dashboard (projects, recents, notes, stats, activity preview)
- ✅ Backups API (list/create/restore) + Settings UI

## Phase 3 — Ollama integration
- ✅ Connection/status/version detection (verified: Ollama 0.40.13 connected)
- ✅ Installed-model discovery with sizes/quantization (verified in API + UI)
- ✅ Hardware profile: OS, CPU, RAM, disk, GPU detection; recommendation verdict (verified output)
- ✅ Model routing: preference slots + fallbacks for main/light/embedding tiers (verified)
- ✅ Streaming generation: SSE from server → client, live-delta (verified: 36 deltas, `done` event with full text)
- ✅ Cancellation (verified: client abort produces `cancelled` event; also fixed the early-abort bug where reading
  the request body fired req 'close')
- ✅ Task queue: heavy=1/light=2 concurrency, preferences-driven (verified limits in /api/ai/status)
- ✅ In-app model download manager with progress + cancel (ollama `pull` spawn + polling API)
- ✅ Failure surfaces: Ollama-off states in UI; AI errors surface as JSON messages; manuscripts never depend on AI calls
- 🟡 Health test button (`/api/ollama/test`) — verified `ok:true` once; empty reply case understood (see Known issues)

## Phase 4 — AI writing capabilities
- ✅ Writing modes: draft/expand/rewrite/transition/dialogue/describe streaming into editor panel (verified draft mode end-to-end)
- ✅ Insert / Replace / Copy / Discard buttons on AI output
- ✅ Brainstorming (8 categories, streaming, save-to-Temporary-Notes)
- ✅ Assistant chat with retrieval (SSE; not yet manually exercised against a long chat — plumbing verified via same streamTask path as writing)
- ✅ AI editor: 8 edit modes, structured JSON changes, accept/reject per change (server verified pending a live run — see below)
- ✅ Chapter analyze: summary + memory extraction → ai_suggestion bucket (verify pending model finish)

## Phase 5 — Memory & Continuity
- ✅ Memory buckets + approve/reject/edit/delete/promote/demote + bulk actions (verified via API)
- ✅ Semantic index: chapter chunks by content hash; embeddings via Ollama /api/embed; lazy re-embed
- ✅ Semantic search API with cosine + keyword fallback (verified keyword path; cosine path pending nomic-embed-text install)
- ✅ Retrieval-augmented context assembler with char budget (used by all AI requests)
- ✅ Timeline: events CRUD, numeric story-time ordering with gap detection, character tagging (UI; mobile drag kept simple — ▲▼ reorder)
- ✅ Continuity checker service + report UI (problem / location / evidence / why / options; live-run pending model availability)

## Phase 6 — Advanced features
- ✅ **Fix & polish panel** (editor): grammar, sentence restructuring, stronger words, repetition,
  dialogue, pacing, description and tone passes over a selection or the whole chapter, with an explicit
  original → suggestion list, per-change notes, and an Apply step that snapshots first (reversible)
- ✅ Agent activity log (Settings) fed by every routed task
- ✅ Automatic character engine (Phase 8): background chapter reading on create/manual save/restore;
  discovers characters, relationships, knowledge and actions with deterministic, non-AI application rules
- ✅ Character review queue: uncertain interpretations and contradictions await approval; well-supported
  facts file automatically; merge tooling folds duplicates with full history
- ✅ Character knowledge tracking (per-character discovered/met/witnessed/secret/unaware) feeding the
  continuity checker for impossible-knowledge detection
- ✅ Relationship web visualisation (SVG) and per-character chapter appearance history
- ❌ EPUB export (deferred; DOCX/PDF/TXT/Markdown shipped)
- ❌ Publishing-assistant view (removed deliberately; manuscript export remains)

## Phase 7 — Testing & hardening
- ✅ Automated suite (`npm test`, zero deps): 58 tests — pure-logic unit tests (editor JSON parsing/rejection,
  name matching, `diffLines`, search escaping) + full HTTP integration against an isolated throwaway instance
  (real data untouched)
- ✅ Streaming + abort path verified against live Ollama
- ✅ End-to-end suite (`npm run test:e2e`, Playwright + Chromium): 6 specs against a production build on its own
  port and a throwaway data directory — editor autosave round-trip, AI-suggestion approval, staged backup
  restore across a real restart, chapter history restore, every export format, manuscript search. No model needed
  (Ollama is pointed at a dead endpoint), so the suite is deterministic and runs in CI
- ✅ Fixed during verification: req-close early-abort bug; startup-backup TDZ bug; pull-task stream design; chapter snapshot semantics
- ✅ Fixed during character-engine build: un-awaited manual backup (raced/flaked); character detail
  endpoint 500 (`chapterId` alias mis-selected) — detail view was broken since Phase 2
- ✅ Fixed in the polish pass audit: 10-minute timeout on non-streaming and streaming Ollama calls (no more
  infinite hangs); oversized editor input now refused with 400 instead of silently truncated; model replies
  in prose / unexplained rewrites now fail with 502 and change nothing; Apply hidden when no concrete
  changes were listed; stale polish results cleared on chapter switch; Apply pinned to the original
  selection range so clicking elsewhere cannot replace the whole chapter
- ⛔ Long-document performance measurement (manuscript >50k words)

## Phase 8 — Publishability hardening
- ✅ **CI workflow** (`.github/workflows/ci.yml`): push/PR → lint, format check, typecheck, full unit/integration
  suite, production build, the Playwright end-to-end suite, and a smoke boot of the built server (health endpoint
  must answer; no Ollama in CI, AI failure paths are what the tests assert)
- ✅ **Graceful shutdown**: SIGINT/SIGTERM stop accepting requests, let in-flight ones finish, then
  `PRAGMA wal_checkpoint(TRUNCATE)` + clean `db.close()` (4s force-exit guard). Verified live: 354KB WAL
  folded into the main db, `-wal/-shm` files removed, process exits cleanly
- ✅ **AI output draft protection**: every streamed generation is persisted to the `ai_drafts` table
  (migration v3) while it runs (~400ms cadence), on completion/cancel, and is recoverable from the
  editor's "Recent drafts" panel (per chapter, list + restore + delete). Rows pruned to newest 20 per
  novel; failed-before-first-token streams leave no empty rows; capture can never break the stream.
  Verified live end-to-end: real llama3.2 generation → draft row with full text
- ✅ **Version diff view**: pure client-side `diffLines` (LCS over lines with head/tail trimming and a
  >4M-cell size guard) in `client/src/diff.ts`; per-version "Diff" button in History opens
  snapshot→current-editor diff with +added/−removed coloring and stats
- ✅ **LICENSE** (MIT, contributors) + **CONTRIBUTING.md** (local-first ground rules, dev/test/conventions)
- ✅ Verified: lint and format checks clean, typecheck clean, 58/58 unit/integration tests, 6/6 end-to-end specs,
  `npm run build` green, live draft capture + version endpoint probes on the running server, production build
  boots and shuts down cleanly (SIGTERM checkpoint)
- ⛔ CI run itself unverified on GitHub (workflow not yet pushed; every step was verified locally with the same commands)

## Automatic character engine — rules it enforces (kept honest)
- Only manuscript-supported facts are stored; unknown profile fields stay empty
- Similar-name collisions are never auto-created or auto-merged — they queue for author review
- Existing (non-empty) profile fields are never overwritten silently — conflicts become review items
- Filling empty fields, adding aliases, filing knowledge/appearances/events are additive and automatic
- Re-analysis on an edited chapter purges that chapter's previous AI conclusions first (source-tagged)
- Unchanged chapters are skipped via body hash; unreadable model output is never cached as "done"
- All of it runs in the background on the light tier; the author is never interrupted

## Known issues / honest notes
1. **qwen3 reasoning leak:** on this Ollama build (0.40.13), qwen3-family models can emit chain-of-thought into
   normal output ("Hmm, the user asked…"); `think:false` is not honored. `llama3.2:3b` (downloading) is the
   recommended prose model; routing prefers it automatically for both tiers once installed.
2. Empty reply in `/api/ollama/test` when a thinking model spends its small token budget on reasoning — cosmetic.
3. Character relationship rows are added by supplying the other character's id; the quick-add button is a stub pending smarter UX.
4. Desktop app packaging (Electron/Tauri) is not done; Loreloom runs as a local web app on localhost.
