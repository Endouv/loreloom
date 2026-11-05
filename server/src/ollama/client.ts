/**
 * Thin typed client for the local Ollama daemon (http://localhost:11434).
 * Everything stays on the author's machine; there are no external endpoints here.
 */
export const OLLAMA_BASE = process.env.LORELOOM_OLLAMA_URL ?? "http://localhost:11434";

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  family: string;
  quantization: string;
  modifiedAt: string;
  /** derived: parameter size parsed as billions, -1 when unknown */
  billions: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class OllamaUnavailableError extends Error {
  constructor(message = "Ollama is not reachable. Start it with `ollama serve` (or the desktop app).") {
    super(message);
    this.name = "OllamaUnavailableError";
  }
}

export class NoModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoModelError";
  }
}

/**
 * Chats can legitimately take minutes on CPU, but never forever. A stuck
 * daemon or model must fail with a clear message instead of hanging the UI.
 */
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

function chatSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isTimeout(err: unknown): boolean {
  return (err as Error)?.name === "TimeoutError";
}

async function fetchJson<T>(path: string, init?: RequestInit, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (init?.signal) {
    init.signal.addEventListener("abort", () => controller.abort());
  }
  try {
    const resp = await fetch(OLLAMA_BASE + path, { ...init, signal: controller.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Ollama ${path} failed (${resp.status}): ${text.slice(0, 300)}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function getVersion(): Promise<string | null> {
  try {
    const r = await fetchJson<{ version: string }>("/api/version", undefined, 2000);
    return r.version;
  } catch {
    return null;
  }
}

export async function listModels(): Promise<OllamaModel[]> {
  const data = await fetchJson<{ models: Array<{ name: string; size: number; details?: Record<string, string>; modified_at?: string }> }>(
    "/api/tags"
  );
  return data.models.map((m) => {
    const param = m.details?.["parameter_size"] ?? "";
    const billions = parseFloat(param) || -1;
    return {
      name: m.name.replace(":latest", ""),
      sizeBytes: m.size,
      parameterSize: param || "unknown",
      family: m.details?.family ?? "",
      quantization: m.details?.quantization_level ?? "",
      modifiedAt: m.modified_at ?? "",
      billions,
    };
  });
}

/** Parse a newline-delimited Ollama chat stream and yield text deltas. */
export async function* chatStream(
  opts: { model: string; messages: ChatMessage[]; temperature?: number; numCtx?: number; signal?: AbortSignal }
): AsyncGenerator<{ text?: string; done?: boolean }> {
  let resp: Response;
  try {
    resp = await fetch(OLLAMA_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        options: {
          temperature: opts.temperature ?? 0.8,
          ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
        },
      }),
      signal: chatSignal(opts.signal),
    });
  } catch (err) {
    if (isTimeout(err)) throw new Error(`Ollama did not respond within ${CHAT_TIMEOUT_MS / 60000} minutes. Try a smaller model or a shorter passage.`);
    throw err;
  }
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 404) throw new NoModelError(`Model "${opts.model}" is not installed in Ollama.`);
    throw new Error(`Ollama chat failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: { message?: { content?: string }; done?: boolean };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.message?.content) yield { text: parsed.message.content };
      if (parsed.done) {
        yield {
          done: true,
        };
        return;
      }
    }
  }
}

/** Non-streaming chat completion, used by structured/JSON tasks. */
export async function chatOnce(opts: { model: string; messages: ChatMessage[]; temperature?: number; numCtx?: number; signal?: AbortSignal }): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(OLLAMA_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.2,
          ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
        },
      }),
      signal: chatSignal(opts.signal),
    });
  } catch (err) {
    if (isTimeout(err)) throw new Error(`Ollama did not respond within ${CHAT_TIMEOUT_MS / 60000} minutes. Try a smaller model or a shorter passage.`);
    throw err;
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 404) throw new NoModelError(`Model "${opts.model}" is not installed in Ollama.`);
    throw new Error(`Ollama chat failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

export async function deleteModel(name: string): Promise<void> {
  const resp = await fetch(OLLAMA_BASE + "/api/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) throw new Error(`Could not delete model ${name} (${resp.status})`);
}
