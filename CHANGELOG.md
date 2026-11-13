# Changelog

All notable changes to Loreloom will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Markdown manuscript export (`?format=markdown`, also `md`) and an Export control on
  each novel card that downloads Markdown, DOCX or PDF
- Playwright end-to-end smoke tests (editor autosave round-trip, AI-suggestion approval,
  backup restore across a real server restart, chapter history restore, manuscript
  downloads in every format, manuscript-wide search) running against the built app in CI
- ESLint (flat config) and Prettier with `npm run lint` / `npm run format`; both are
  gated in CI alongside typecheck, tests and build
- Continuity checker with evidence-backed reports
- Full character extraction engine with automatic profile population
- Character relationship map (graph visualization)
- Multi-tier model routing (main/light/embedding)
- Ollama pull/download manager with progress tracking
- Semantic memory search (cosine + keyword fallback)
- DOCX, PDF and TXT manuscript export
- Chapter versioning with snapshot restoration
- Autosave every 1.2s with version history
- 5 memory buckets (canon/provisional/ai_suggestion/question/rejected)
- AI suggestion approve/reject workflow
- AI Editor with 8 editing modes (grammar, sentences, vocabulary, repetition,
  dialogue, pacing, description, tone) surfaced as the editor's Fix & polish panel
- AI-output draft protection: streamed generations are persisted while they run and
  recoverable from the editor's Recent drafts list
- Version diff view (line-level, with add/remove stats)
- Graceful shutdown with WAL checkpoint
- CI workflow (typecheck, tests, build, server smoke boot)
- MIT LICENSE and CONTRIBUTING guide
- SECURITY policy
- Timeline manager with gap detection
- Brainstorming agent (8 categories)
- Backup and restore system (rolling 10 snapshots)
- Model health monitoring and status API

### Changed
- Normalised the whole codebase to the Prettier config (double quotes, 2 spaces, 140
  columns); Markdown and generated output are excluded
- Refactored model routing to prefer smallest installed instruct model
- Updated dependency versions (Node 22, React 18, Tailwind v4)
- Reorganized database schema into 12 tables with WAL mode
- Improved error handling and recovery in SSE streams
- Refined autosave interval and version snapshot policy

### Fixed
- Manuscript search now matches a literal backslash. The query was dropped into a
  LIKE pattern that uses `\` as its escape character without escaping the
  backslash itself, so `C:\temp` matched `C:temp` and never the real path
- Editor autosave could silently never start: the input listener attached while the
  CodeMirror view was still being created asynchronously, so typing stayed marked
  "Unsaved edits" forever. The effect now re-attaches once the view exists
- Startup now snapshots the database *before* schema migrations run, so a bad
  migration is always recoverable (the snapshot used to be taken after migrate)
- Restores are staged and applied at the next startup instead of replacing the
  database files under the live connection, which could silently discard every
  write made before the restart; the replaced database is backed up first, and
  non-SQLite files are refused as restore sources
- Fixed early SSE abort bug (req 'close' firing on body read)
- Fixed startup backup TDZ (temporal dead zone) bug
- Editor: non-JSON model replies are rejected instead of becoming replacement
  manuscript text; unexplained rewrites and oversized (over 16,000 character)
  passages are refused rather than silently truncated or applied
- Editor: polish results are cleared on chapter switch, Apply is pinned to the
  original selection range, and Apply is unavailable when no changes were listed
- Ollama calls now time out after 10 minutes with a readable message instead of
  hanging forever on a stuck daemon
- Startup backup rejection can no longer surface as an unhandled promise
- Fixed chapter restore not triggering re-analysis
- Fixed character suggestion conflict resolution flow

## [0.1.0] - 2026-11-02
### Added
- Initial public release
- All core features as described in v0.1.0 release