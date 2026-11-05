import { Router } from "express";
import { db } from "../db/database.js";
import { asyncHandler, badRequest, notFound } from "../util.js";
import {
  buildWritingPrompt,
  streamTask,
  resolveTierModel,
  runEditorTask,
  EDIT_MODES,
  summarizeChapter,
  extractMemorySuggestions,
  runContinuityCheck,
  type EditMode,
  logActivity,
} from "../agents/tasks.js";
import { queueStats } from "../ollama/queue.js";
import { numCtxTokens } from "../ollama/routing.js";
import { ensureIndex, semanticSearch } from "../ollama/embeddings.js";
import { analyzeChapterCharacters } from "../agents/characters.js";
import { assembleContext, assembleOverview, novelTitle, withSystem } from "../agents/context.js";
import type { ChatMessage } from "../ollama/client.js";

export const aiRouter = Router();

const started = Date.now();

aiRouter.get("/status", (_req, res) => {
  res.json({ status: "ok", uptimeSeconds: Math.round((Date.now() - started) / 1000), queue: queueStats() });
});

// ------------------------------ Writing (SSE) -------------------------------

type WritingMode = "draft" | "expand" | "rewrite" | "transition" | "dialogue" | "describe";

aiRouter.post(
  "/write",
  asyncHandler(async (req, res) => {
    const { novelId, chapterId, mode, input, instructions } = req.body ?? {};
    if (!Number(novelId)) badRequest("novelId required");
    if (!input || typeof input !== "string") badRequest("input text required");
    const writingMode: WritingMode = (["draft", "expand", "rewrite", "transition", "dialogue", "describe"] as const).includes(mode)
      ? mode
      : "draft";
    await streamTask(req, res, `writing:${writingMode}`, "main", async () => {
      const env = { novelId: Number(novelId), chapterId: chapterId ? Number(chapterId) : null, query: `${input} ${instructions ?? ""}` };
      const messages = await buildWritingPrompt(env, writingMode, input, instructions ?? "");
      const { model } = await resolveTierModel("main");
      return { model, messages, novelId: env.novelId, chapterId: env.chapterId };
    });
  })
);

aiRouter.post(
  "/assistant/chat",
  asyncHandler(async (req, res) => {
    const { novelId, messages, chapterText } = req.body ?? {};
    if (!Number(novelId)) badRequest("novelId required");
    const history: { role: "user" | "assistant"; content: string }[] = Array.isArray(messages)
      ? messages
          .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.length < 12000)
          .slice(-12)
      : [];
    await streamTask(req, res, "assistant", "main", async () => {
      const novelIdNum = Number(novelId);
      // Full project view: the assistant sees the whole novel exactly as it is
      // recorded in the database — story, complete cast, knowledge, world,
      // timeline and the author's own canon — not a small retrieved fragment.
      const overview = assembleOverview(novelIdNum);
      const system = `You are Loreloom, the author's co-writer and story assistant. You are given the author's ENTIRE project below: every chapter summary, the complete cast with their profiles and knowledge, worldbuilding, timeline, and the author's confirmed canon. Answer grounded in exactly this material; if something is not in the project yet, say so plainly rather than inventing. The author's decisions are binding; your ideas are suggestions until the author approves them in Story Memory.\n\n=== FULL PROJECT VIEW (read live from the author's database) ===\n${overview.text}`;
      const msgs: ChatMessage[] = [{ role: "system", content: system }, ...history];
      const { model } = await resolveTierModel("main");
      return { model, messages: msgs, novelId: novelIdNum, numCtx: numCtxTokens() ?? undefined };
    });
  })
);

aiRouter.post(
  "/brainstorm",
  asyncHandler(async (req, res) => {
    const { novelId, category, topic, depth } = req.body ?? {};
    if (!Number(novelId)) badRequest("novelId required");
    const cats = ["plot", "character", "scene", "dialogue", "conflict", "mystery", "alternatives", "chapterplan"];
    const c = cats.includes(category) ? category : "plot";
    await streamTask(req, res, `brainstorm:${c}`, "main", async () => {
      const novelIdNum = Number(novelId);
      const system = `You are Loreloom's brainstorming agent. Brainstorm ${c} ideas for the author's novel. Give numbered, concrete, distinct options${depth === "deep" ? " (6-8, each with 2-3 sentences)" : " (5)"}. They are SUGGESTIONS for the author to adopt or discard - frame them lightly, never as facts of the story.`;
      const ctx = await assembleContext(novelIdNum, String(topic ?? ""));
      const msgs: ChatMessage[] = [
        ...withSystem(ctx, system, novelTitle(novelIdNum)),
        { role: "user", content: `Topic / prompt from author: ${topic || "(surprise me)"}` },
      ];
      const { model } = await resolveTierModel("main");
      return { model, messages: msgs, novelId: novelIdNum, temperature: 0.95 };
    });
  })
);

// ------------------------------ AI editor (JSON) ----------------------------

aiRouter.post(
  "/editor",
  asyncHandler(async (req, res) => {
    const { novelId, text, modes } = req.body ?? {};
    if (!Number(novelId)) badRequest("novelId required");
    if (!text || typeof text !== "string") badRequest("text required");
    // Silently truncating here used to be possible; an applied result would
    // then only cover part of the passage and could drop the rest. Refuse
    // instead, so the author can select a smaller range deliberately.
    if (text.length > 16000) {
      badRequest(
        `That passage is ${text.length.toLocaleString()} characters. One editing pass handles up to 16,000 — select a smaller range and try again.`
      );
    }
    const editModes: EditMode[] = Array.isArray(modes) ? modes.filter((m: string) => (EDIT_MODES as readonly string[]).includes(m)) : [];
    if (!editModes.length) badRequest("At least one editing mode is required");
    const started = Date.now();
    try {
      const result = await runEditorTask(Number(novelId), text, editModes);
      logActivity(Number(novelId), "editor", result.model, "main", Date.now() - started, true, `${result.changes.length} changes`);
      res.json(result);
    } catch (err) {
      logActivity(Number(novelId), "editor", null, "main", Date.now() - started, false, (err as Error).message);
      throw err;
    }
  })
);

// ------------------------------ Analysis -----------------------------------

aiRouter.post(
  "/analyze-chapter",
  asyncHandler(async (req, res) => {
    const { chapterId } = req.body ?? {};
    const chapter = db.prepare("SELECT id, novel_id, body FROM chapters WHERE id = ?").get(Number(chapterId)) as
      | { id: number; novel_id: number; body: string }
      | undefined;
    if (!chapter) notFound("Chapter not found");
    const started = Date.now();
    const summary = await summarizeChapter(chapter.id);
    const suggestions = chapter.body.trim() ? await extractMemorySuggestions(chapter.novel_id, chapter.body) : [];
    let inserted: number[] = [];
    if (suggestions.length) {
      const ins = db.prepare(
        "INSERT INTO memory_items (novel_id, text, bucket, source, chapter_id, category) VALUES (?, ?, 'ai_suggestion', 'ai', ?, 'chapter_fact')"
      );
      inserted = suggestions.map((s) => Number(ins.run(chapter.novel_id, s, chapter.id).lastInsertRowid));
    }
    logActivity(chapter.novel_id, "analyze-chapter", null, "light", Date.now() - started, true, `${inserted.length} suggestions`);
    await ensureIndex(chapter.novel_id, ["chapter", "memory"]);
    res.json({ summary, suggestions: inserted.map((id) => ({ id, text: suggestions[inserted.indexOf(id)] })) });
  })
);

aiRouter.post(
  "/continuity",
  asyncHandler(async (req, res) => {
    const { novelId, chapterId } = req.body ?? {};
    if (!Number(novelId)) badRequest("novelId required");
    const started = Date.now();
    try {
      const result = await runContinuityCheck(Number(novelId), chapterId ? Number(chapterId) : null);
      logActivity(Number(novelId), "continuity", result.model, "main", Date.now() - started, true, `${result.issues.length} issues`);
      res.json(result);
    } catch (err) {
      logActivity(Number(novelId), "continuity", null, "main", Date.now() - started, false, (err as Error).message);
      throw err;
    }
  })
);

// ------------------------------ Memory search -------------------------------

aiRouter.post(
  "/memory-search",
  asyncHandler(async (req, res) => {
    const { novelId, query, kinds } = req.body ?? {};
    if (!Number(novelId) || !query) badRequest("novelId and query required");
    await ensureIndex(Number(novelId));
    const results = await semanticSearch(Number(novelId), Array.isArray(kinds) && kinds.length ? kinds : ["memory", "character", "world"], String(query), 12);
    res.json({ results });
  })
);

aiRouter.post(
  "/reindex",
  asyncHandler(async (req, res) => {
    const { novelId } = req.body ?? {};
    if (!Number(novelId)) badRequest("novelId required");
    const counts = await ensureIndex(Number(novelId));
    res.json({ ok: true, counts });
  })
);

aiRouter.post(
  "/project-overview",
  asyncHandler(async (req, res) => {
    const { novelId } = req.body ?? {};
    if (!Number(novelId)) badRequest("novelId required");
    const overview = assembleOverview(Number(novelId));
    res.json(overview);
  })
);

// ------------------------------ Generated output drafts ---------------------

aiRouter.get(
  "/drafts",
  asyncHandler((req, res) => {
    const novelId = Number(req.query.novelId);
    if (!novelId) badRequest("novelId required");
    const chapterId = req.query.chapterId ? Number(req.query.chapterId) : null;
    const rows = db
      .prepare(
        chapterId
          ? "SELECT id, novel_id AS novelId, chapter_id AS chapterId, task, text, created_at AS createdAt, updated_at AS updatedAt FROM ai_drafts WHERE novel_id = ? AND chapter_id = ? ORDER BY id DESC LIMIT 20"
          : "SELECT id, novel_id AS novelId, chapter_id AS chapterId, task, text, created_at AS createdAt, updated_at AS updatedAt FROM ai_drafts WHERE novel_id = ? ORDER BY id DESC LIMIT 20"
      )
      .all(novelId, ...(chapterId ? [chapterId] : []));
    res.json(rows);
  })
);

aiRouter.delete(
  "/drafts/:novelId/:id",
  asyncHandler((req, res) => {
    const info = db.prepare("DELETE FROM ai_drafts WHERE id = ? AND novel_id = ?").run(Number(req.params.id), Number(req.params.novelId));
    if (!info.changes) notFound("Draft not found");
    res.json({ ok: true });
  })
);

// ------------------------------ Character reading ---------------------------

aiRouter.post(
  "/analyze-characters",
  asyncHandler(async (req, res) => {
    const { chapterId, force } = req.body ?? {};
    if (!Number(chapterId)) badRequest("chapterId required");
    const started = Date.now();
    try {
      const out = await analyzeChapterCharacters(Number(chapterId), force === true);
      logActivity(Number(chapterId), "characters:manual-scan", out.model ?? null, "light", Date.now() - started, !out.skipped, out.reason ?? "");
      res.json(out);
    } catch (err) {
      logActivity(null, "characters:manual-scan", null, "light", Date.now() - started, false, (err as Error).message);
      throw err;
    }
  })
);

aiRouter.post(
  "/analyze-novel-characters",
  asyncHandler(async (req, res) => {
    const { novelId, force } = req.body ?? {};
    if (!Number(novelId)) badRequest("novelId required");
    const chapters = db.prepare("SELECT id FROM chapters WHERE novel_id = ? ORDER BY position").all(Number(novelId)) as { id: number }[];
    const analyzed: number[] = [];
    const skipped: number[] = [];
    for (const ch of chapters) {
      try {
        const out = await analyzeChapterCharacters(ch.id, force === true);
        (out.skipped ? skipped : analyzed).push(ch.id);
      } catch {
        skipped.push(ch.id);
      }
    }
    res.json({ ok: true, analyzed, skipped });
  })
);
