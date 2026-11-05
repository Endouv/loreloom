# Changelog

All notable changes to Loreloom will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- Refactored model routing to prefer smallest installed instruct model
- Updated dependency versions (Node 22, React 18, Tailwind v4)
- Reorganized database schema into 12 tables with WAL mode
- Improved error handling and recovery in SSE streams
- Refined autosave interval and version snapshot policy

### Fixed
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