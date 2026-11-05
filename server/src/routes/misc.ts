import { Router } from "express";
import { db } from "../db/database.js";
import { asyncHandler, parseJson } from "../util.js";

export const preferencesRouter = Router();

/** Sane defaults; anything the author saves overrides these. */
export const PREFERENCE_DEFAULTS = {
  ui: {
    theme: "dark",
    fontSize: 19,
    lineHeight: 1.9,
    editorWidth: 720,
    focusMode: false,
  },
  writing: {
    language: "English",
    style: "clear literary prose, natural dialogue",
    temperature: 0.8,
    creativeFreedom: "balanced", // strict | balanced | adventurous
  },
  memory: {
    autoSuggestFromChapters: true,
    autoDetectCharacters: true, // read chapters for cast, relationships and knowledge in the background
    retrievalChunks: 8, // how many semantic chunks to retrieve per request
    contextBudgetChars: 6000,
  },
  autosaveIntervalMs: 1200,
  export: {
    format: "docx",
    includeNotes: false,
  },
  models: {
    main: "",
    light: "",
    embedding: "",
  },
  performance: {
    maxHeavyTasks: 1,
    maxLightTasks: 2,
    modelContextTokens: 8192, // context window given to the assistant/analysis (raise if your model supports more)
  },
};

export function readPrefs(): Record<string, any> {
  const row = db.prepare("SELECT json FROM preferences WHERE id = 1").get() as { json: string };
  return parseJson(row.json, {});
}

function mergeDefaults(prefs: Record<string, any>): Record<string, any> {
  const merged = structuredClone(PREFERENCE_DEFAULTS) as Record<string, any>;
  for (const [section, value] of Object.entries(prefs)) {
    if (value && typeof value === "object" && !Array.isArray(value) && merged[section] && typeof merged[section] === "object") {
      Object.assign(merged[section], value);
    } else {
      merged[section] = value;
    }
  }
  return merged;
}

preferencesRouter.get(
  "/",
  asyncHandler((_req, res) => {
    res.json(mergeDefaults(readPrefs()));
  })
);

preferencesRouter.put(
  "/",
  asyncHandler((req, res) => {
    const incoming = req.body ?? {};
    if (typeof incoming !== "object") return res.status(400).json({ error: "Body must be an object" });
    db.prepare("UPDATE preferences SET json = ? WHERE id = 1").run(JSON.stringify(mergeDefaults(incoming)));
    res.json(mergeDefaults(readPrefs()));
  })
);

// ------------------------------ Backup / restore ---------------------------

export const backupRouter = Router();

import fs from "node:fs";
import path from "node:path";
import { BACKUP_DIR, DB_PATH, restoreFromBackup } from "../db/database.js";

backupRouter.get(
  "/",
  asyncHandler((_req, res) => {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".db"))
      .sort()
      .reverse()
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, bytes: st.size, createdAt: st.mtime.toISOString() };
      });
    res.json({ files, dbPath: DB_PATH, bytes: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0 });
  })
);

backupRouter.post(
  "/",
  asyncHandler(async (_req, res) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // db.backup resolves asynchronously; awaiting it guarantees the file exists
    // when the response arrives and surfaces write failures to the author.
    await db.backup(path.join(BACKUP_DIR, `loreloom-${stamp}.db`));
    res.json({ ok: true, filename: `loreloom-${stamp}.db` });
  })
);

backupRouter.post(
  "/restore",
  asyncHandler((req, res) => {
    const { filename } = req.body ?? {};
    if (!filename) return res.status(400).json({ error: "filename required" });
    restoreFromBackup(String(filename));
    res.json({ ok: true, note: "Database restored. Restart Loreloom to reload it." });
  })
);

// ------------------------------ Dashboard ----------------------------------

export const dashboardRouter = Router();

dashboardRouter.get(
  "/",
  asyncHandler((_req, res) => {
    const novelRows = db
      .prepare(
        `SELECT n.*, COUNT(c.id) as chapters, COALESCE(SUM(c.word_count), 0) as words
         FROM novels n LEFT JOIN chapters c ON c.novel_id = n.id
         GROUP BY n.id ORDER BY n.updated_at DESC LIMIT 8`
      )
      .all() as Record<string, any>[];
    const novels = novelRows.map((n) => ({
      id: n.id,
      title: n.title,
      genre: n.genre,
      status: n.status,
      targetWords: n.target_words,
      synopsis: n.synopsis,
      tags: parseJson(n.tags, []),
      createdAt: n.created_at,
      updatedAt: n.updated_at,
      chapterCount: n.chapters,
      wordCount: n.words,
    }));
    const recentChapters = db
      .prepare(
        `SELECT c.id, c.title, c.updated_at, c.word_count, c.status, c.novel_id, n.title as novel_title
         FROM chapters c JOIN novels n ON n.id = c.novel_id ORDER BY c.updated_at DESC LIMIT 8`
      )
      .all();
    const totalWords = db
      .prepare("SELECT COALESCE(SUM(word_count), 0) as words, COUNT(*) as chapters FROM chapters")
      .get() as { words: number; chapters: number };
    const novelCount = (db.prepare("SELECT COUNT(*) as n FROM novels").get() as { n: number }).n;
    const characterCount = (db.prepare("SELECT COUNT(*) as n FROM characters").get() as { n: number }).n;
    const pendingSuggestions = (
      db.prepare("SELECT COUNT(*) as n FROM memory_items WHERE bucket = 'ai_suggestion'").get() as { n: number }
    ).n;
    const openQuestions = (db.prepare("SELECT COUNT(*) as n FROM memory_items WHERE bucket = 'question'").get() as { n: number }).n;
    const recentNotes = db
      .prepare(
        `SELECT c.id, c.title, c.notes, c.updated_at, n.title as novel_title
         FROM chapters c JOIN novels n ON n.id = c.novel_id
         WHERE c.notes != '' ORDER BY c.updated_at DESC LIMIT 6`
      )
      .all();
    const recentActivity = db
      .prepare("SELECT task, model, ok, created_at, detail FROM agent_activity ORDER BY id DESC LIMIT 8")
      .all();
    res.json({
      novels,
      recentChapters,
      stats: { totalWords: totalWords.words, totalChapters: totalWords.chapters, novelCount, characterCount, pendingSuggestions, openQuestions },
      recentNotes,
      recentActivity,
    });
  })
);
