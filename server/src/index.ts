import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { novelsRouter } from "./routes/novels.js";
import { chaptersRouter } from "./routes/chapters.js";
import { charactersRouter, worldRouter, timelineRouter, memoryRouter } from "./routes/entities.js";
import { preferencesRouter, backupRouter, dashboardRouter } from "./routes/misc.js";
import { exportRouter } from "./export/manuscript.js";
import { ollamaRouter } from "./routes/ollama.js";
import { aiRouter } from "./routes/ai.js";
import { db } from "./db/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.LORELOOM_PORT) || 4747;

app.use(express.json({ limit: "12mb" }));

app.use("/api/novels", novelsRouter);
app.use("/api", chaptersRouter);
app.use("/api", charactersRouter);
app.use("/api", worldRouter);
app.use("/api", timelineRouter);
app.use("/api", memoryRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/preferences", preferencesRouter);
app.use("/api/backups", backupRouter);
app.use("/api", exportRouter);
app.use("/api/ollama", ollamaRouter);
app.use("/api/ai", aiRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "loreloom" }));

// Error handler: friendly JSON errors for the client.
app.use((err: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status && Number(err.status) >= 400 && Number(err.status) < 600 ? err.status : 500;
  if (status === 500) console.error("[loreloom] unhandled error:", err);
  res.status(status).json({ error: err.message || "Internal error", code: err.code ?? null });
});

// In production, serve the built client as a single local app.
const clientDist = path.join(__dirname, "..", "..", "client-dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`[loreloom] server listening on http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown. SIGINT/SIGTERM stop accepting new requests, let in-flight
// ones finish, then checkpoint the WAL into the main database file and close
// it cleanly — so killing the server (or shutting the laptop) can never leave
// a multi-megabyte -wal file or a torn write behind.
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[loreloom] ${signal} received — closing server, checkpointing database…`);

  const force = setTimeout(() => {
    console.error("[loreloom] graceful shutdown timed out; exiting forcefully.");
    process.exit(1);
  }, 4000);
  force.unref();

  server.close(() => {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
      console.log("[loreloom] database checkpointed and closed. Goodbye.");
      process.exit(0);
    } catch (err) {
      console.error("[loreloom] database close failed:", err);
      process.exit(1);
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
