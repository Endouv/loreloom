import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end smoke tests. They run against a production-style build (the server
 * serving `client-dist`) on their own port and a throwaway data directory, so
 * the author's real manuscript is never opened and no Ollama daemon is needed.
 */
const PORT = Number(process.env.LORELOOM_E2E_PORT ?? 4780);
const DATA_DIR = process.env.LORELOOM_E2E_DATA_DIR ?? path.join(os.tmpdir(), "loreloom-e2e-data");
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Start from a clean database on every run. Playwright evaluates this config
// once in the runner process; the TEST_WORKER_INDEX guard makes sure a worker
// can never wipe data out from under a running suite.
if (!process.env.TEST_WORKER_INDEX) {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Build first so `npm run test:e2e` is self-contained.
    command: "npm run build && node server/dist/index.js",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      LORELOOM_PORT: String(PORT),
      LORELOOM_DATA_DIR: DATA_DIR,
      // A dead endpoint: AI features must degrade cleanly, never reach out.
      LORELOOM_OLLAMA_URL: "http://127.0.0.1:9",
    },
  },
});
