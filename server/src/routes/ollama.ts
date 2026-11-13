import { Router, type Request, type Response, type NextFunction } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { getVersion, listModels, deleteModel, OLLAMA_BASE } from "../ollama/client.js";
import { detectHardware } from "../ollama/hardware.js";
import { routeModel } from "../ollama/routing.js";
import { queueStats } from "../ollama/queue.js";

export const ollamaRouter = Router();

// ------------------------- Status / discovery ------------------------------

async function statusPayload() {
  const version = await getVersion();
  let models: Awaited<ReturnType<typeof listModels>> | null = null;
  if (version) {
    try {
      models = await listModels();
    } catch {
      models = null;
    }
  }
  return {
    ollamaUrl: OLLAMA_BASE,
    running: Boolean(version),
    version,
    models:
      models?.map((m) => ({
        name: m.name,
        sizeBytes: m.sizeBytes,
        sizeGb: +(m.sizeBytes / 1024 ** 3).toFixed(2),
        parameterSize: m.parameterSize,
        quantization: m.quantization,
        family: m.family,
      })) ?? [],
  };
}

ollamaRouter.get("/status", async (_req, res) => {
  try {
    res.json(await statusPayload());
  } catch (err) {
    res.json({ running: false, models: [], error: (err as Error).message });
  }
});

ollamaRouter.get("/health", async (_req, res) => {
  const version = await getVersion();
  res.json({ running: Boolean(version), version });
});

ollamaRouter.get("/hardware", async (_req, res) => {
  res.json(await detectHardware());
});

ollamaRouter.get("/routing", async (_req, res) => {
  const [main, light, embedding] = await Promise.all([routeModel("main"), routeModel("light"), routeModel("embedding")]);
  res.json({ main, light, embedding, queue: queueStats() });
});

ollamaRouter.post("/test", async (_req, res) => {
  const started = Date.now();
  try {
    const decision = await routeModel("light");
    if (!decision.model) throw new Error("No model installed — pull one in Settings → Models.");
    const resp = await fetch(OLLAMA_BASE + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: decision.model,
        prompt: "Reply with the single word: ready",
        stream: false,
        options: { num_predict: 8 },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama generation failed (${resp.status})`);
    const data = (await resp.json()) as { response?: string };
    res.json({ ok: true, model: decision.model, reply: data.response?.trim() ?? "", ms: Date.now() - started });
  } catch (err) {
    res.json({ ok: false, error: (err as Error).message, ms: Date.now() - started });
  }
});

// ------------------------- Model downloads (registry) -----------------------

interface PullTask {
  id: number;
  name: string;
  child: ChildProcess | null;
  events: Array<Record<string, unknown>>;
  done: boolean;
  ok: boolean;
  startedAt: number;
}
const pulls = new Map<number, PullTask>();
let pullSeq = 1;

ollamaRouter.post(
  "/pull",
  asyncHandler((req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!/^[\w.:/-]{1,120}$/.test(name)) {
      return res.status(400).json({ error: "Model name looks invalid; expected e.g. qwen3:4b" });
    }
    const id = pullSeq++;
    const task: PullTask = { id, name, child: null, events: [], done: false, ok: false, startedAt: Date.now() };
    pulls.set(id, task);
    res.json({ ok: true, id, name });

    const child = spawn("ollama", ["pull", name]);
    task.child = child;
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { status?: string; digest?: string; total?: number; completed?: number; error?: string };
          const event: Record<string, unknown> = parsed.error
            ? { type: "error", message: parsed.error }
            : {
                type: "progress",
                status: parsed.status,
                total: parsed.total,
                completed: parsed.completed,
                percent: parsed.total && parsed.completed ? +((parsed.completed / parsed.total) * 100).toFixed(1) : undefined,
              };
          task.events.push(event);
        } catch {
          // Non-JSON progress line — ignore.
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString().slice(0, 300);
      task.events.push({ type: "error", message });
    });
    child.on("close", (code) => {
      task.done = true;
      task.ok = code === 0;
      task.events.push({
        type: code === 0 ? "done" : "error",
        message: code === 0 ? "Model installed." : `ollama pull exited with code ${code}`,
      });
    });
  }),
);

ollamaRouter.get(
  "/pull/:id",
  asyncHandler((req, res) => {
    const task = pulls.get(Number(req.params.id));
    if (!task) return res.status(404).json({ error: "Unknown pull task" });
    res.json({ id: task.id, name: task.name, done: task.done, ok: task.ok, events: task.events.slice(-30) });
  }),
);

ollamaRouter.delete(
  "/pull/:id",
  asyncHandler((req, res) => {
    const task = pulls.get(Number(req.params.id));
    if (!task) return res.status(404).json({ error: "Unknown pull task" });
    if (task.child) task.child.kill("SIGTERM");
    res.json({ ok: true });
  }),
);

ollamaRouter.delete(
  "/models/:name",
  asyncHandler((req, res) => {
    const name = req.params.name.replace(/^models\//, "");
    deleteModel(name);
    res.json({ ok: true });
  }),
);

function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown> | unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}
