import { expect, test, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Backup restore, end to end. This flow needs a *restart* to take effect, which
 * the shared webServer cannot provide, so the suite owns its own server: it
 * boots one on a private port with a throwaway data directory, stages a restore
 * through the Settings UI, then kills and restarts the process to prove the swap
 * happens at startup — and that the database it replaced was kept as a backup.
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.LORELOOM_E2E_RESTORE_PORT ?? 4791);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loreloom-e2e-restore-"));
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DB_PATH = path.join(DATA_DIR, "loreloom.db");
const PENDING_RESTORE = `${DB_PATH}.restore-pending`;

// One server, one database: keep steps in order.
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let server: ChildProcess | null = null;
let api: APIRequestContext;
let logs: string[] = [];

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server never answered /api/health\n--- server output ---\n${logs.join("")}`);
}

async function startServer() {
  if (!fs.existsSync(path.join(PROJECT_ROOT, "server/dist/index.js"))) {
    throw new Error("server/dist/index.js is missing — run the suite through `npm run test:e2e`, which builds first.");
  }
  logs = [];
  server = spawn(process.execPath, ["server/dist/index.js"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LORELOOM_PORT: String(PORT),
      LORELOOM_DATA_DIR: DATA_DIR,
      // A dead endpoint: no AI feature may reach out, and none is needed here.
      LORELOOM_OLLAMA_URL: "http://127.0.0.1:9",
    },
  });
  server.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr?.on("data", (chunk) => logs.push(String(chunk)));
  await waitForHealth();
}

/** SIGTERM so the server checkpoints and closes the WAL cleanly, like a real shutdown. */
async function stopServer() {
  const child = server;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    server = null;
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(forced);
  server = null;
}

const titles = async () => ((await (await api.get("/api/novels")).json()) as { title: string }[]).map((n) => n.title);
const backupFiles = async () =>
  ((await (await api.get("/api/backups")).json()) as { files: { filename: string }[] }).files.map((f) => f.filename);

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: BASE_URL });
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  await api?.dispose();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("restore: a backup is staged from Settings, then swapped in on the next start", async ({ page }) => {
  // The state that must survive: snapshotted into an explicit backup.
  expect((await api.post("/api/novels", { data: { title: "Kept Draft" } })).ok()).toBeTruthy();
  const backupResponse = await api.post("/api/backups");
  expect(backupResponse.ok(), "backup creation should succeed").toBeTruthy();
  const { filename } = (await backupResponse.json()) as { filename: string };
  expect(fs.existsSync(path.join(BACKUP_DIR, filename)), "the backup file should exist on disk").toBeTruthy();

  // Written *after* the snapshot, so applying the restore must erase it.
  expect((await api.post("/api/novels", { data: { title: "Doomed Draft" } })).ok()).toBeTruthy();
  expect(await titles()).toEqual(expect.arrayContaining(["Kept Draft", "Doomed Draft"]));

  // Stage the restore the way an author does: Settings → Backups → restore.
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept(); // confirm() then the "Restart Loreloom" alert()
  });
  await page.goto(`${BASE_URL}/settings`);

  // The row class combination, not just "has a border": the surrounding Card
  // and its header share the individual classes.
  const row = page.locator("div.justify-between.border-ink-800").filter({ hasText: filename });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "restore", exact: true }).click();

  await expect.poll(() => dialogs.some((m) => m.includes("Restart Loreloom")), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(PENDING_RESTORE), { timeout: 15_000 }).toBe(true);

  // Staged, not swapped: the running database is untouched until a restart.
  expect(await titles()).toEqual(expect.arrayContaining(["Kept Draft", "Doomed Draft"]));

  // Restart. Applying the restore is startup work, before the app opens the DB.
  await stopServer();
  expect(fs.existsSync(PENDING_RESTORE), "the staged file must survive the shutdown").toBe(true);
  await startServer();

  expect(fs.existsSync(PENDING_RESTORE), "the staged file is consumed at startup").toBe(false);
  const after = await titles();
  expect(after).toContain("Kept Draft");
  expect(after, "writes made after the backup are rolled back").not.toContain("Doomed Draft");

  // A restore is reversible: the replaced database was snapshotted first.
  expect(await backupFiles()).toEqual(expect.arrayContaining([expect.stringContaining("loreloom-pre-restore-")]));

  // And the author sees the restored library, not the rolled-back one.
  await page.goto(`${BASE_URL}/novels`);
  await expect(page.getByText("Kept Draft")).toBeVisible();
  await expect(page.getByText("Doomed Draft")).toHaveCount(0);
});
