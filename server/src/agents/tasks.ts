/**
 * Agent task modules. Each task is a server-side capability with its own prompts
 * and model tier; they share SQLite, the context assembler and the task queue.
 * The coordinator classifies a request, picks the tier and calls one capability.
 */
import { db } from "../db/database.js";
import { asyncHandler } from "../util.js";
import { chatOnce, chatStream, type ChatMessage } from "../ollama/client.js";
import { routeModel, numCtxTokens } from "../ollama/routing.js";
import { runQueued } from "../ollama/queue.js";
import { assembleContext, novelTitle, withSystem, type AssembledContext } from "./context.js";
import type { Router, Request, Response } from "express";

export const THINKING_HINT = "Do not explain yourself; return only the requested content.";

export interface TaskEnv {
  novelId: number;
  chapterId?: number | null;
  query: string;
  ctx?: AssembledContext;
}

// ------------------------ AI output draft protection ------------------------
// Every streamed generation is persisted while it runs, so a browser crash,
// accidental navigation or timezone between Insert buttons can never cost
// more than the words still being generated. Rows are pruned to the newest
// 20 per novel; the author can discard any of them from the editor.

const MAX_DRAFT_LEN = 200_000;
const INSERT_DRAFT = db.prepare(`INSERT INTO ai_drafts (novel_id, chapter_id, task) VALUES (?, ?, ?)`);
const UPDATE_DRAFT = db.prepare(`UPDATE ai_drafts SET text = ?, updated_at = datetime('now') WHERE id = ?`);
const DRAFT_FLUSH_MS = 400;

export function createAiDraft(novelId: number, chapterId: number | null, task: string): number | null {
  try {
    const info = INSERT_DRAFT.run(novelId, chapterId, task.slice(0, 120));
    const id = Number(info.lastInsertRowid);
    // keep only the newest 20 drafts per novel
    db.prepare(
      `DELETE FROM ai_drafts WHERE novel_id = ? AND id NOT IN (SELECT id FROM ai_drafts WHERE novel_id = ? ORDER BY id DESC LIMIT 20)`
    ).run(novelId, novelId);
    return id;
  } catch {
    return null; // draft capture must never break the stream
  }
}

export function logActivity(novelId: number | null, task: string, model: string | null, tier: string | null, ms: number, ok: boolean, detail = "") {
  db.prepare("INSERT INTO agent_activity (novel_id, task, model, tier, latency_ms, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    novelId, task, model, tier, ms, ok ? 1 : 0, detail.slice(0, 400)
  );
}

/** Resolve the tier's model with a fallback chain, or throw an informative error. */
export async function resolveTierModel(tier: "main" | "light"): Promise<{ model: string; fallbackReason: string }> {
  const decision = await routeModel(tier);
  if (!decision.model) {
    throw Object.assign(new Error("No suitable model installed in Ollama for this task. Open Settings → Models to install one."), {
      status: 409,
      code: "no_model",
    });
  }
  return { model: decision.model, fallbackReason: decision.reason };
}

// ------------------------------ Modes --------------------------------------

const WRITING_MODES: Record<string, string> = {
  draft: "Turn the author's rough notes or brief into polished novel prose in the target language. Preserve their meaning, characters and striking details.",
  expand: "Expand the author's scene with richer prose and dialogue while keeping every existing fact and the scene's direction intact.",
  rewrite: "Rewrite the supplied prose so it reads more naturally while preserving its meaning, voice choices and meaning. Keep roughly the same length unless asked otherwise.",
  transition: "Write a short, smooth narrative transition between the surrounding material. Fall naturally into the next scene.",
  dialogue: "Improve or write natural, character-rooted dialogue. Keep speech unmistakably in each character's voice and reveal as much as the author's notes imply, nothing more.",
  describe: "Write tense-appropriate description of the setting from the notes: concrete sensory detail, no purple padding.",
};

export async function buildWritingPrompt(env: TaskEnv, mode: string, input: string, instructions: string): Promise<ChatMessage[]> {
  if (!env.ctx) env.ctx = await assembleContext(env.novelId, `${input.slice(0, 400)} ${instructions}`);
  const system = `You are Loreloom's writing agent inside the author's novel workspace. ${WRITING_MODES[mode] ?? WRITING_MODES.draft}\n${THINKING_HINT}`;
  let chapterContext = "";
  if (env.chapterId) {
    const ch = db.prepare("SELECT title, summary FROM chapters WHERE id = ?").get(env.chapterId) as { title: string; summary: string } | undefined;
    if (ch) chapterContext = `CURRENT CHAPTER: "${ch.title}"${ch.summary ? `. Summary so far: ${ch.summary}` : ""}\n`;
  }
  const user = `${chapterContext}Author's instructions: ${instructions || "(none)"}\n\nAuthor material:\n${input}\n\nReturn the prose only.`;
  return [...withSystem(env.ctx, system, novelTitle(env.novelId)), { role: "user", content: user }];
}

export async function streamTask(
  req: Request,
  res: Response,
  taskName: string,
  tier: "main" | "light",
  prompts: () => Promise<{ model: string; messages: ChatMessage[]; temperature?: number; numCtx?: number; novelId: number; chapterId?: number | null; preContext?: () => Promise<unknown> }>
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (type: string, data: unknown) => res.write(`data: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
  const controller = new AbortController();
  // NOTE: req 'close' fires when the request body has been read, so hang-up must be
  // detected on the response instead (before its normal end).
  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });
  const started = Date.now();
  let draftId: number | null = null; // AI-output draft protection
  let full = "";
  try {
    const { model, messages, temperature, numCtx, novelId, chapterId } = await prompts();
    send("start", { model, task: taskName });
    draftId = createAiDraft(novelId, chapterId ?? null, taskName);
    let flushAt = 0;
    await runQueued(tier === "main" ? "heavy" : "light", async () => {
      for await (const chunk of chatStream({ model, messages, temperature, numCtx, signal: controller.signal })) {
        if (chunk.text) {
          full += chunk.text;
          send("delta", { text: chunk.text });
          if (draftId && Date.now() - flushAt > DRAFT_FLUSH_MS) {
            flushAt = Date.now();
            if (full.length <= MAX_DRAFT_LEN) UPDATE_DRAFT.run(full, draftId);
          }
        }
      }
    });
    if (draftId) UPDATE_DRAFT.run(full.slice(0, MAX_DRAFT_LEN), draftId);
    if (controller.signal.aborted) {
      logActivity(novelId, taskName, model, tier, Date.now() - started, false, "cancelled by author");
      send("cancelled", { text: full });
    } else {
      logActivity(novelId, taskName, model, tier, Date.now() - started, true, `${full.length} chars`);
      send("done", { text: full, model });
    }
  } catch (err) {
    const e = err as Error & { code?: string; status?: number };
    if (e.name === "AbortError") {
      logActivity(null, taskName, null, tier, Date.now() - started, false, "aborted");
      send("cancelled", { reason: "aborted" });
    } else {
      logActivity(null, taskName, null, tier, Date.now() - started, false, e.message);
      send("error", { message: e.message, code: e.code ?? null });
      // Nothing was generated, so the draft row is just clutter — remove it.
      if (draftId && full.length === 0) {
        try {
          db.prepare("DELETE FROM ai_drafts WHERE id = ?").run(draftId);
        } catch {
          /* cleanup is best-effort */
        }
      }
    }
  } finally {
    res.end();
  }
}

// ------------------------------ Editor task --------------------------------

export const EDIT_MODES = [
  "grammar",
  "vocabulary",
  "dialogue",
  "pacing",
  "structure",
  "description",
  "repetition",
  "tone",
] as const;
export type EditMode = (typeof EDIT_MODES)[number];

const EDIT_PROMPTS: Record<EditMode, string> = {
  grammar: "Correct grammar, punctuation and tense slips. Report each fix.",
  vocabulary: "Improve word choice: replace weak or repeated words with stronger, natural ones. Keep the author's voice.",
  dialogue: "Sharpen dialogue: trim filler, make voices distinct, keep meaning and subtext.",
  pacing: "Flag and tighten slow, overwritten passages; suggest where to cut or split. Changes must stay in-voice.",
  structure: "Restructure awkward passages: reorder clauses, merge or split sentences, smooth transitions.",
  description: "Improve description: more concrete sensory detail, less abstraction, no padding.",
  repetition: "Detect repeated words, phrases and sentence patterns; propose varied alternatives.",
  tone: "Fix tone inconsistencies against the author's established style; make the passage cohesive.",
};

export interface EditorChange {
  type: string;
  original: string;
  suggestion: string;
  note: string;
}

export async function runEditorTask(novelId: number, text: string, modes: EditMode[]): Promise<{ revised: string; changes: EditorChange[]; model: string }> {
  const { model } = await resolveTierModel("main");
  const ctx = await assembleContext(novelId, text.slice(0, 500));
  const modeText = modes.map((m) => `- ${m}: ${EDIT_PROMPTS[m]}`).join("\n");
  const system = `You are Loreloom's editing agent for the author's novel. Edit modes requested:\n${modeText}\n\nRules:\n- Preserve the author's meaning and voice. Adjust only what the modes call for.\n- Return ONLY valid JSON (no markdown fences, no commentary) shaped exactly as:\n{"revised": string, "changes": [{"type": string (grammar|vocabulary|dialogue|pacing|structure|description|repetition|tone), "original": string (exact substring of the original text), "suggestion": string (replacement), "note": string (one short sentence why)}]}\n- "original" values must be copied verbatim from the input; suggest complete sentences/phrases, not single letters.\n- Return an empty "changes" array when nothing warrants change.`;
  const user = `Edit this manuscript passage:\n\n${text}`;
  const messages: ChatMessage[] = [...withSystem(ctx, system, novelTitle(novelId)), { role: "user", content: user }];
  return runQueued("heavy", async () => {
    const raw = await chatOnce({ model, messages, numCtx: numCtxTokens() ?? undefined });
    return { ...(parseEditorJson(raw, text)), model };
  });
}

export function stripFences(s: string): string {
  return s.replace(/^[^{]*{/, (m) => (m.includes("{") ? m.slice(m.indexOf("{")) : m)).replace(/}[^}]*$/, "}");
}

export function parseEditorJson(raw: string, original = ""): { revised: string; changes: EditorChange[] } {
  const json = stripFences(raw.trim());
  let parsed: { revised?: unknown; changes?: unknown };
  try {
    parsed = JSON.parse(json) as { revised?: unknown; changes?: unknown };
  } catch {
    // A prose reply (or commentary around no JSON) must never become the
    // "revised" text: applying it would overwrite the manuscript with the
    // model talking about the edit instead of performing it.
    throw Object.assign(
      new Error("The model replied without usable edit data, so nothing was changed. Try again, or switch to a model that follows instructions more reliably."),
      { status: 502 }
    );
  }

  const changes = (Array.isArray(parsed.changes) ? parsed.changes : [])
    .filter((c): c is EditorChange => !!c && typeof c === "object" && typeof (c as EditorChange).original === "string" && typeof (c as EditorChange).suggestion === "string")
    .slice(0, 100);
  let revised = typeof parsed.revised === "string" ? parsed.revised : "";

  // A clean no-op may omit "revised"; keep the original as the canonical text.
  if (!revised.trim() && !changes.length) revised = original;
  if (!revised.trim()) {
    throw Object.assign(
      new Error("The model returned no edited text, so nothing was changed. Try again, or switch models."),
      { status: 502 }
    );
  }

  // Never let an unexplained rewrite through: without change entries the UI
  // can't show the author what would be replaced.
  if (original && !changes.length && revised.trim() !== original.trim()) {
    throw Object.assign(
      new Error("The model rewrote the passage without listing any changes, so the result was discarded. Nothing was changed."),
      { status: 502 }
    );
  }

  return { revised, changes };
}

// ------------------------------ Analysis tasks -----------------------------

export async function summarizeChapter(chapterId: number): Promise<string> {
  const ch = db.prepare("SELECT novel_id, title, body FROM chapters WHERE id = ?").get(chapterId) as
    | { novel_id: number; title: string; body: string }
    | undefined;
  if (!ch) throw Object.assign(new Error("Chapter not found"), { status: 404 });
  const { model } = await resolveTierModel("light");
  const body = ch.body.trim().slice(0, 12000) || "(empty chapter)";
  const system = `Summarize this novel chapter for the author's notes in 3-6 sentences. Cover what happens, key character beats, and any worldbuilding rules revealed. ${THINKING_HINT}`;
  return runQueued("light", () => chatOnce({
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: `Chapter "${ch.title}":\n\n${body}` }],
    temperature: 0.3,
  })).then((summary) => {
    db.prepare("UPDATE chapters SET summary = ?, updated_at = datetime('now') WHERE id = ?").run(summary.trim(), chapterId);
    return summary.trim();
  });
}

export async function extractMemorySuggestions(novelId: number, text: string): Promise<string[]> {
  const { model } = await resolveTierModel("light");
  const ctx = await assembleContext(novelId, text.slice(0, 300));
  const system = `You are Loreloom's memory agent. From the text below, extract discrete story facts as short declarative lines (characters, relationships, world rules, promises, mysteries). 2-12 items.\nIMPORTANT: never treat a phrase as canon that the text doesn't actually establish. Return ONLY JSON: {"items": ["fact 1", "fact 2", ...]}. No markdown.`;
  const messages: ChatMessage[] = [...withSystem(ctx, system, novelTitle(novelId)), { role: "user", content: text.slice(0, 14000) }];
  return runQueued("light", async () => {
    const raw = await chatOnce({ model, messages, temperature: 0.2 });
    try {
      const parsed = JSON.parse(stripFences(raw)) as { items?: unknown };
      return Array.isArray(parsed.items) ? parsed.items.filter((i): i is string => typeof i === "string" && i.trim().length > 3).slice(0, 12) : [];
    } catch {
      return raw.split(/\n+/).map((l) => l.replace(/^[-*\d.\s]+/, "").trim()).filter((l) => l.length > 8 && l.length < 220).slice(0, 12);
    }
  });
}

export interface ContinuityIssue {
  type: string;
  location: string;
  evidence: string;
  why: string;
  options: string[];
}

export async function runContinuityCheck(novelId: number, chapterId: number | null): Promise<{ issues: ContinuityIssue[]; model: string }> {
  const { model } = await resolveTierModel("main");
  let targetText = "";
  let targetLabel = "";
  if (chapterId) {
    const ch = db.prepare("SELECT title, body, notes FROM chapters WHERE id = ?").get(chapterId) as { title: string; body: string; notes: string } | undefined;
    if (!ch) throw Object.assign(new Error("Chapter not found"), { status: 404 });
    targetText = `${ch.title}\n\n${ch.body}\n\nNotes:\n${ch.notes}`;
    targetLabel = `chapter "${ch.title}"`;
  } else {
    const chapters = db.prepare("SELECT title, body FROM chapters WHERE novel_id = ? ORDER BY position").all(novelId) as { title: string; body: string }[];
    targetText = chapters.map((c) => `### ${c.title}\n${c.body}`).join("\n\n").slice(0, 24000);
    targetLabel = "the full manuscript (abridged when too long)";
  }
  const ctx = await assembleContext(novelId, "continuity contradictions story facts");
  // Character knowledge tracking: who knows what (and what they cannot know yet)
  // so the checker can flag impossible knowledge, not just factual drift.
  const knowledge = db
    .prepare(
      `SELECT c.name AS name, k.kind, k.text FROM character_knowledge k
       JOIN characters c ON c.id = k.character_id
       WHERE k.novel_id = ? ORDER BY k.id DESC LIMIT 40`
    )
    .all(novelId) as { name: string; kind: string; text: string }[];
  const knowledgeRecap = knowledge.length
    ? `\n\nCHARACTER KNOWLEDGE (who knows what; "unaware" means they must NOT act on it yet):\n${knowledge
        .map((k) => `- ${k.name} (${k.kind}): ${k.text}`)
        .join("\n")}`
    : "";
  const system = `You are Loreloom's continuity checker for the author's novel. Compare the manuscript text against the canon provided. Report REAL inconsistencies only (contradictory character facts, timeline errors, impossible knowledge — a character knowing or acting on something listed as "unaware" or not yet discovered at that point, broken relationship states, world rule violations, terminology drift). Do not invent problems; if the text is consistent, return an empty list. Return ONLY JSON: {"issues":[{"type":string, "location":string (chapter + rough position), "evidence":string (the contradicting canon fact), "why":string, "options":[string (2-3 concrete fixes)]}]}. No markdown.`;
  const messages: ChatMessage[] = [
    ...withSystem(ctx, system, novelTitle(novelId)),
    { role: "user", content: `CANON RECAP:\n${[...ctx.canon, ...ctx.provisional, ...ctx.characters, ...ctx.world].join("\n")}${knowledgeRecap}\n\nMANUSCRIPT TEXT (${targetLabel}):\n${targetText}` },
  ];
  return runQueued("heavy", async () => {
    const raw = await chatOnce({ model, messages, temperature: 0.2, numCtx: numCtxTokens() ?? undefined });
    let issues: ContinuityIssue[] = [];
    try {
      const parsed = JSON.parse(stripFences(raw)) as { issues?: ContinuityIssue[] };
      issues = Array.isArray(parsed.issues) ? parsed.issues.slice(0, 25) : [];
    } catch {
      throw new Error("The continuity model returned an unreadable response. Try again or choose a stronger model in Settings → Models.");
    }
    return { issues: issues.filter((i) => i && i.type && i.why), model };
  });
}

// ------------------------------ Editor helpers ------------------------------
