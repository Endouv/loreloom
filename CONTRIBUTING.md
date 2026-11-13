# Contributing to Loreloom

Thank you for wanting to contribute! Please read the following guidelines before opening a pull request.

## Development Setup

1. **Fork the repository** and clone your fork.
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Start Ollama** on your machine: `ollama serve`
4. **Pull recommended models:**
   ```bash
   ollama pull llama3.2:3b
   ollama pull nomic-embed-text
   ```
5. **Start the development server:**
   ```bash
   npm run dev
   ```
   This starts the API server on `:4747` and the Vite client on `:5173`.

6. **Open http://localhost:5173** to begin development.

## Project Structure

```
loreloom/
├─ server/          # Node/Express/TypeScript API
├─ client/          # Vite/React/Tailwind frontend
├─ data/            # Runtime data (DB, backups) — gitignored
├─ client-dist/     # Built client — served in production
└─ docs/            # Architecture and roadmap documents
```

## Code Conventions

- **TypeScript** strict mode for both server and client
- Use `npm run typecheck` to verify (`npx tsc -p server`, `npx tsc -p client --noEmit` and
  `npx tsc -p e2e` for the Playwright specs)
- Use `npm run lint` to check ESLint (flat config in `eslint.config.js`; errors fail CI,
  `any` is only a warning because SQLite rows and model output are genuinely untyped)
- Use `npm run format` to apply Prettier (`.prettierrc.json`: double quotes, 2 spaces,
  140 columns, trailing commas). The code is normalised, so `npm run format:check`
  fails CI on unformatted code — run `npm run format` before opening a PR.
  Markdown is intentionally excluded (Prettier would reflow prose line by line)
- Use `npm run build` to build the client (`vite build`)
- Follow the existing code style (see `src/util.ts` for shared helpers)
- Never commit `server/data/`, `.env`, or model weights

## Adding New Features

1. **Backend** (`server/src/`): Add routes, services, and database operations.
2. **Frontend** (`client/src/`): Add UI components and API calls.
3. **Update docs** (`docs/`): Update `ARCHITECTURE.md`, `ROADMAP.md`, and `FEATURES.md` as needed.
4. **Test manually** to verify the full flow works.

## Pull Request Process

1. Create a new branch from `main`.
2. Make your changes, ensuring `npm run lint` and `npm run typecheck` pass.
3. Run `npm run build` to verify the client builds.
4. Test the feature end-to-end: create a novel, add a chapter, try AI writing, etc.
5. Submit the pull request with a clear description of what was changed and how to test it.

## Reporting Bugs

If you find a bug, please open an issue with:
- A clear title
- Steps to reproduce
- Expected vs. actual behavior
- Your environment (OS, Node version, Ollama model versions)

## Good First Issues

- UI improvements and polish
- Additional model routing options
- Export format enhancements
- Documentation clarifications