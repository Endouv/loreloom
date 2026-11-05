# Loreloom — Development Roadmap

Status ledger lives in `docs/FEATURES.md` (created during Phase 2 and updated after
every verified milestone). ✅ = built AND verified; 🟡 = built, needs verification; ⛔ =
explicitly not done; ❌ future/deferred.

## Phase 1 — Research & Architecture ✅ (this document)
- Verified machine capabilities (RAM-bound CPU inference, no dGPU).
- Chosen name, stack, DB schema, agent model, Ollama integration plan.
- Decision: local Node app (not a hosted Cloudflare site) because the AI backend must
  reach the author's own Ollama daemon on localhost:11434.
- **Gate: author approves plan (+ model download consent) before Phase 2.**

## Phase 2 — Core application
1. Scaffold monorepo (workspaces: server, client), Tailwind theme, shell + nav.
2. SQLite schema + migrations + connection/wal/backup-on-start.
3. Novel CRUD, chapter CRUD + drag ordering + autosave + word count + statuses.
4. Chapter versions (autosave snapshots + manual snapshot + restore).
5. Chapter notes, full-text search across manuscripts.
6. CodeMirror editor: comfortable typography, focus mode, saved/saving chip.
7. Export DOCX / PDF / TXT; backup/restore UI (manual).
8. Dashboard (projects, recents, counts, quick actions).

## Phase 3 — Ollama integration
1. Health/detect client (installed / stopped / no-models states), `/api/tags` discovery.
2. Server-summarized hardware profile → model recommendations UI.
3. Settings: model slots (light/main/embedding) with install-status badges + selectors.
4. download-manager (progress, cancel, install/uninstall listing).
5. Streaming generation pipeline (ndjson → SSE → UI) + AbortController cancellation,
   task queue with max-concurrency, same-tier batching.
6. Failure surfaces: clear Ollama-off/no-model/error states everywhere; manuscript data
   never depends on AI success (writes persist before any AI call).

## Phase 4 — AI writing capabilities
1. Coordinator router: classify → pipeline → tier → queue.
2. Writing agent: scene draft/expand/rewrite/transition, style prefs, real streaming.
3. AI editor: transform modes + structured-change diff reviewer UI (accept/reject per
   change, side-by-side).
4. Brainstorming workspace (plot/character/scene/dialogue/conflict/mystery/alternatives;
   outputs land as draft artifacts the author can promote).
5. Chapter summarize + character/world/timeline extractor (proposes memory + records;
   travels to `ai_suggestion`/draft state, never auto-canon).

## Phase 5 — Memory & Continuity
1. Memory buckets (canon/provisional/AI suggestion/questions/rejected) + review UI +
   approve/reject/edit/delete controls.
2. Embedding pipeline (chapter chunks; lazy re-embed by hash) + nomic-embed-text search
   with keyword fallback.
3. Retrieval-augmented prompt assembler with token budget for every AI request.
4. Timeline manager (events, manual drag ordering, lanes, gaps).
5. Continuity checker (structured issue report UI: problem/location/evidence/why/
   options; never auto-rewrites).

## Phase 6 — Advanced features
1. Fix & polish editing pass (grammar, sentences, vocabulary, dialogue, pacing,
   description, repetition, tone) with accept/reject per change.
2. Writing analytics (session streaks, progress charts, repeatability checks).
3. Agent activity log views.
4. DOCX/PDF polish, EPUB if time allows (else marked ❌).

## Phase 7 — Testing & hardening
1. The test plan in ARCHITECTURE.md §8 against the real Ollama daemon + real DB.
2. Performance pass on this machine (measurements, not claims).
3. README: install/run/model-downloading instructions, privacy statement.
4. Final walkthrough of the manuscript lifecycle; mark ledger.
