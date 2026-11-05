# Troubleshooting

## "Ollama is not reachable" / no models listed

1. Check the daemon: `curl http://localhost:11434/api/version`. If that fails,
   start Ollama (`ollama serve`, or the desktop app).
2. Pull at least one instruct model: `ollama pull llama3.2:3b`.
3. In **Settings → Ollama engine**, click *Reconnect*, then **Test generation**.
4. If Ollama runs on another port or machine, set `LORELOOM_OLLAMA_URL` before
   starting the server. A remote URL means your manuscript text leaves your
   machine — see `SECURITY.md`.

The server never fails silently when no model is available: AI routes return
HTTP 409 with `"code": "no_model"` and streams emit an `error` event.

## AI requests take forever or the app seems stuck

- CPU-only machines can take minutes for a full chapter. Loreloom queues heavy
  generation one at a time; check the queue indicator in Settings.
- Chats time out after 10 minutes with a clear message. If you hit that, use a
  smaller model or a shorter selection.
- Close other model-heavy apps. Ollama unloads a model after idle; the first
  request after a switch is slower.
- For *Fix & polish*, select a passage instead of sending a whole long chapter.
  One pass accepts up to 16,000 characters; larger inputs are refused rather
  than truncated.

## "The model replied without usable edit data"

The editing endpoint expects structured JSON (`revised` + `changes`). Small or
chatty models sometimes answer in prose. Nothing is applied in that case — that
is deliberate. Retry, or assign a more instruction-following model in
**Model routing** (for example `llama3.2:3b` or `qwen2.5:3b-instruct`).

## qwen3 models print their reasoning into the prose

Some Ollama builds emit `Thinking…` text in the normal output. Assign a
non-reasoning instruct model to both tiers, or upgrade Ollama.

## Port already in use

`EADDRINUSE` on 4747 means another Loreloom (or an unrelated process) is
running. Stop it, or start with `LORELOOM_PORT=4757 npm run dev` — the Vite dev
proxy reads the same variable.

## Database is locked / app won't start

- Only one server process may write the database. Check for a stale
  `tsx watch server/src/index.ts` or built server and stop it.
- On SIGINT/SIGTERM the server checkpoints the WAL and closes cleanly. If the
  process was killed hard, the WAL is replayed automatically on next start.
- Last resort: copy `server/data/loreloom.db*` somewhere safe, then restore a
  snapshot from `server/data/backups/` via **Settings → Backups** (or replace the
  DB file while the app is stopped) and restart.

Never delete `server/data/` unless you have a backup — it contains the
manuscript.

## "Embedding model missing" / semantic search looks like keyword search

Semantic retrieval needs an embedding model. Pull one (`ollama pull
nomic-embed-text`) and assign it to the **Embeddings** slot. Without it the app
degrades to keyword matching: functionality still works, results are coarser.

## Character extraction finds nothing or invents people

- Extraction is an AI pass over chapter text; it needs a finished draft, not an
  empty chapter.
- Results are suggestions until you accept them. Check **Characters → Pending**.
- If duplicates appear, use **Merge** on the profile; the engine also
  normalises aliases, but ambiguous names are flagged rather than guessed.
- You can re-run analysis for a single chapter or the whole novel from the
  Characters view.

## Changes disappeared

Autosave writes after ~1.2 s of idle typing; the header shows *Saving…* /
*All changes saved*. If a save failed, *Unsaved edits* stays visible. Open
**History** — snapshots are created on manual saves, AI applies, restores and
periodically during autosave. Every restore is itself reversible.

If the tab crashed during AI generation, open **Recent drafts** in the editor:
streamed output is persisted while it runs.

## `npm install` fails building better-sqlite3

You need a C++ toolchain for the prebuilt fallback: on Debian/Ubuntu install
`build-essential python3`; on macOS install Xcode command-line tools. Node 20+
is required (Node 22 recommended).

## Tests fail on my machine

`npm test` uses an isolated temporary data directory and points at a dead Ollama
URL (`http://127.0.0.1:9`), so AI tests expect deterministic failures and never
touch your real database. If a test fails, run `npm run typecheck` first; report
the failing test name in an issue (without manuscript text).

## Reset the app without losing writing

Back up first (**Settings → Backups**). To start clean but keep the backup:
stop the app, move `server/data/` aside, restart. A fresh database is created on
boot. Restoring the old snapshots is then possible from the Backups view.
