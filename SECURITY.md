# Security

## Threat model

Loreloom runs entirely on your machine. The server binds to `127.0.0.1` only, has no
user accounts, no authentication layer and no telemetry. It is designed for a single
author working on their own computer. **Do not expose it to a network or the internet.**

## Your data

- Manuscripts, characters, worldbuilding, memory and settings live in a local SQLite
  database (`server/data/loreloom.db` by default, overridable via `LORELOOM_DATA_DIR`).
- That directory and its rolling backups are excluded by `.gitignore`. Never commit them.
- Backups are created on startup and via Settings; they are plain `.db` files in
  `server/data/backups/`, so treat that folder with the same care as the manuscript.
- AI prompts are sent only to the Ollama instance you configure (default
  `http://localhost:11434`). No text leaves your machine unless you point the app at a
  remote Ollama URL yourself.

## Reporting a vulnerability

Please open a private report via GitHub Security Advisories ("Report a vulnerability")
or, if that is unavailable, a minimal issue that describes the class of problem without
including manuscript text, personal data or exploit details. We aim to respond within a
week.

## Scope notes

- AI output is untrusted input: it is rendered as text, never as HTML, and is only ever
  written to the database after an explicit author action.
- Restores and imports validate paths (`path.basename`) before touching files.
- There is no sandboxing of local models; a malicious model is outside the app's threat
  model — install models from sources you trust.
