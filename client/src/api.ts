/** Typed API client for the local Loreloom server. All calls go to /api/* on localhost. */

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let message = `Request failed (${resp.status})`;
    try {
      const data = await resp.json();
      if (data?.error) message = data.error;
      if (data?.code) message += ` [${data.code}]`;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return resp.json() as Promise<T>;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch("/api" + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return json<T>(resp);
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export interface Novel {
  id: number;
  title: string;
  genre: string;
  status: string;
  targetWords: number;
  synopsis: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  chapterCount: number;
  wordCount: number;
}

export interface ChapterMeta {
  id: number;
  novelId: number;
  title: string;
  status: string;
  position: number;
  notes: string;
  wordCount: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface Chapter extends ChapterMeta {
  body: string;
}

export interface ChapterVersion {
  id: number;
  chapterId: number;
  title: string;
  source: string;
  createdAt: string;
}

export interface Character {
  id: number;
  novelId: number;
  name: string;
  aliases: string[];
  personality: string;
  appearance: string;
  background: string;
  motivations: string;
  strengths: string;
  weaknesses: string;
  storyStatus: string;
  devNotes: string;
  freeNotes: string;
  firstAppearanceChapterId: number | null;
  events?: { id: number; description: string; chapterId: number | null }[];
  links?: {
    id: number;
    kind: string;
    notes: string;
    certainty?: string;
    chapterId?: number | null;
    fromCharacterId: number;
    toCharacterId: number;
    fromName: string;
    toName: string;
  }[];
  appearances?: { id: number; kind: string; chapterId: number | null; chapterTitle: string; position: number }[];
  knowledge?: { id: number; kind: string; text: string; source: string; chapterId: number | null; chapterTitle: string | null }[];
}

/**
 * AI-extracted suggestion payloads are deliberately polymorphic: the engine
 * emits different fields for a new character, a profile update, a relationship
 * or a merge check. Every field is optional and consumers branch on `kind`.
 */
export interface CharacterSuggestionPayload {
  newName?: string;
  name?: string;
  characterId?: number;
  field?: string;
  existing?: string;
  proposed?: string;
  unresolvedCharacter?: string;
  item?: { kind?: string; data?: { text?: string; description?: string } };
  fromName?: string;
  toName?: string;
  existingKind?: string;
  rel?: { kind?: string; notes?: string };
  kind?: string;
  notes?: string;
}

export interface CharacterSuggestion {
  id: number;
  novelId: number;
  chapterId: number | null;
  chapterTitle: string | null;
  kind: string;
  payload: CharacterSuggestionPayload;
  reason: string;
  status: string;
  createdAt: string;
}

export interface CharacterGraph {
  nodes: { id: number; name: string; storyStatus: string }[];
  links: {
    id: number;
    fromCharacterId: number;
    toCharacterId: number;
    kind: string;
    certainty?: string;
    fromName: string;
    toName: string;
    notes?: string;
  }[];
}

export interface WorldEntry {
  id: number;
  novelId: number;
  category: string;
  title: string;
  body: string;
  fields: { label: string; value: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEvent {
  id: number;
  novelId: number;
  chapterId: number | null;
  title: string;
  description: string;
  storyDateLabel: string;
  storyDateOrder: number;
  kind: string;
  characterIds: number[];
}

export interface MemoryItem {
  id: number;
  novelId: number;
  text: string;
  bucket: "canon" | "provisional" | "ai_suggestion" | "question" | "rejected";
  source: "author" | "ai";
  chapterId: number | null;
  category: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface Preferences {
  ui: { theme: string; fontSize: number; lineHeight: number; editorWidth: number; focusMode: boolean };
  writing: { language: string; style: string; temperature: number; creativeFreedom: string };
  memory: { autoSuggestFromChapters: boolean; autoDetectCharacters?: boolean; retrievalChunks: number; contextBudgetChars: number };
  autosaveIntervalMs: number;
  export: { format: string; includeNotes: boolean };
  models: { main: string; light: string; embedding: string };
  performance: { maxHeavyTasks: number; maxLightTasks: number; modelContextTokens?: number };
}

export const BUCKETS: { key: MemoryItem["bucket"]; label: string; hint: string }[] = [
  { key: "canon", label: "Confirmed Canon", hint: "Established story facts the AI must respect" },
  { key: "provisional", label: "Temporary Notes", hint: "Working notes, not yet canon" },
  { key: "ai_suggestion", label: "AI Suggestions", hint: "Extracted by the AI, awaiting your review" },
  { key: "question", label: "Unresolved Questions", hint: "Open plot threads and mysteries" },
  { key: "rejected", label: "Rejected Ideas", hint: "Reviewed and declined" },
];

/** An event frame from one of the server's SSE streams. */
export interface SseEvent {
  type: string;
  /** model that served the stream (start/done) */
  model?: string;
  /** complete output so far (done/cancelled) */
  text?: string;
  /** human-readable error (error) */
  message?: string;
  /** machine code, e.g. "no_model" */
  code?: string | null;
  task?: string;
  reason?: string;
}

/** Normalise an unknown thrown value into a message the UI can display. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "Something went wrong.";
}

/** POST an SSE endpoint and stream parsed events. Abort via controller. */
export async function streamSse(
  path: string,
  body: unknown,
  handlers: {
    onDelta?: (text: string) => void;
    onStart?: (e: SseEvent) => void;
    onDone?: (e: SseEvent) => void;
    onEvent?: (type: string, e: SseEvent) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch("/api" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok || !resp.body) {
    let message = `Request failed (${resp.status})`;
    try {
      const data = await resp.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    handlers.onEvent?.("error", { type: "error", message });
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!frame.startsWith("data:")) continue;
      try {
        const evt = JSON.parse(frame.slice(5).trim()) as SseEvent;
        if (evt.type === "delta" && evt.text) handlers.onDelta?.(evt.text);
        else if (evt.type === "start") handlers.onStart?.(evt);
        else if (evt.type === "done") handlers.onDone?.(evt);
        else handlers.onEvent?.(evt.type, evt);
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}

export function countWords(text: string): number {
  const matches = text.trim().match(/[\p{L}\p{N}'’-]+/gu);
  return matches ? matches.length : 0;
}

/** The whole-project view the assistant is given. */
export interface ProjectOverview {
  text: string;
  stats: { novels: number; chapters: number; characters: number; world: number; memories: number; chars: number };
}

/** One semantic-retrieval hit from `/api/ai/memory-search`. */
export interface MemoryHit {
  kind: string;
  itemId: number | null;
  chapterId: number | null;
  text: string;
  score: number;
}

/** Which installed model serves a tier, per `/api/ollama/routing`. */
export interface RoutingDecision {
  model: string | null;
  requested: string | null;
  fallback: boolean;
  reason: string;
}

export interface RoutingStatus {
  main: RoutingDecision;
  light: RoutingDecision;
  embedding: RoutingDecision;
  queue: {
    activeHeavy: number;
    activeLight: number;
    waitingHeavy: number;
    waitingLight: number;
    limits: { heavy: number; light: number };
  };
}

/** Response of `/api/backups`. */
export interface BackupsResponse {
  files: { filename: string; bytes: number; createdAt: string }[];
  dbPath: string;
}

/** A row of the agent activity log. */
export interface AgentActivity {
  task: string;
  model: string | null;
  tier: string | null;
  ok: number;
  detail: string;
  created_at: string;
}

/** Response of `POST /api/ollama/test`. */
export interface OllamaTestResult {
  ok: boolean;
  model?: string;
  reply?: string;
  error?: string;
  ms?: number;
}
