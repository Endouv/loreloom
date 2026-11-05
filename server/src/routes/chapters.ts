import { Router } from "express";
import { db } from "../db/database.js";
import { asyncHandler, badRequest, countWords, notFound, touchNovel } from "../util.js";
import { autoAnalyzeChapter } from "../agents/characters.js";

export const chaptersRouter = Router();

interface ChapterRow {
  id: number;
  novel_id: number;
  title: string;
  body: string;
  status: string;
  position: number;
  notes: string;
  word_count: number;
  summary: string;
  created_at: string;
  updated_at: string;
}

function getChapter(id: unknown): ChapterRow {
  const row = db.prepare("SELECT * FROM chapters WHERE id = ?").get(id as number) as ChapterRow | undefined;
  if (!row) notFound("Chapter not found");
  return row;
}

function shapeChapter(row: ChapterRow, withBody: boolean) {
  const base = {
    id: row.id,
    novelId: row.novel_id,
    title: row.title,
    status: row.status,
    position: row.position,
    notes: row.notes,
    wordCount: row.word_count,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return withBody ? { ...base, body: row.body } : base;
}

/** Snapshot policy: during rapid autosaves, history keeps at most one snapshot per interval, plus a guaranteed snapshot before any manual edit or restore. */
const VERSION_MIN_INTERVAL_MS = 5 * 60 * 1000;
const LAST_VERSION_STMT = db.prepare(
  `SELECT id, created_at FROM chapter_versions WHERE chapter_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
);
const INSERT_VERSION = db.prepare(
  `INSERT INTO chapter_versions (chapter_id, body, title, source) VALUES (?, ?, ?, ?)`
);

function snapshot(chapter: ChapterRow, source: "autosave" | "pre-edit"): void {
  INSERT_VERSION.run(chapter.id, chapter.body, chapter.title, source);
}

chaptersRouter.get(
  "/novels/:novelId/chapters",
  asyncHandler((req, res) => {
    const rows = db
      .prepare(`SELECT * FROM chapters WHERE novel_id = ? ORDER BY position, id`)
      .all(req.params.novelId) as ChapterRow[];
    res.json(rows.map((r) => shapeChapter(r, false)));
  })
);

chaptersRouter.post(
  "/novels/:novelId/chapters",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    const novel = db.prepare("SELECT id, title FROM novels WHERE id = ?").get(novelId) as { id: number; title: string } | undefined;
    if (!novel) notFound("Novel not found");
    const title = (req.body?.title || req.body?.name || "").toString().trim() || `New Chapter`;
    const maxPos = db
      .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM chapters WHERE novel_id = ?")
      .get(novelId) as { p: number };
    const info = db
      .prepare(`INSERT INTO chapters (novel_id, title, position) VALUES (?, ?, ?)`)
      .run(novelId, title, maxPos.p + 1);
    const row = getChapter(info.lastInsertRowid);
    touchNovel(novelId);
    res.status(201).json(shapeChapter(row, true));
    // Background read for the character engine; never blocks or fails the request.
    autoAnalyzeChapter(row.id);
  })
);

chaptersRouter.get(
  "/chapters/:id",
  asyncHandler((req, res) => {
    res.json(shapeChapter(getChapter(req.params.id), true));
  })
);

chaptersRouter.put(
  "/chapters/:id",
  asyncHandler((req, res) => {
    const chapter = getChapter(req.params.id);
    const { title, body, status, notes, position, summary } = req.body ?? {};
    if (title === undefined && body === undefined && status === undefined && notes === undefined && position === undefined && summary === undefined) {
      return res.json(shapeChapter(chapter, true));
    }
    const source = req.query.source === "manual" ? "manual" : "autosave";
    const fields: string[] = [];
    const values: unknown[] = [];
    let bodyChanged = false;
    if (title !== undefined) { fields.push("title = ?"); values.push(String(title)); }
    if (body !== undefined && body !== chapter.body) { fields.push("body = ?"); values.push(String(body)); bodyChanged = true; }
    if (status !== undefined) {
      if (!["draft", "revision", "completed"].includes(status)) badRequest("status must be draft, revision or completed");
      fields.push("status = ?"); values.push(status);
    }
    if (notes !== undefined) { fields.push("notes = ?"); values.push(String(notes)); }
    if (position !== undefined) { fields.push("position = ?"); values.push(Number(position)); }
    if (summary !== undefined) { fields.push("summary = ?"); values.push(String(summary)); }
    if (body !== undefined) {
      fields.push("word_count = ?");
      values.push(countWords(String(body)));
    }
    if (!fields.length) return res.json(shapeChapter(chapter, true));

    // Protect prior content: one snapshot per interval during autosave, always before manual edits.
    if (bodyChanged) {
      const last = LAST_VERSION_STMT.get(chapter.id) as { id: number; created_at: string } | undefined;
      const lastMs = last ? Date.parse(last.created_at.replace(" ", "T") + "Z") : 0;
      if (source === "manual") {
        snapshot(chapter, "pre-edit");
      } else if (!last || Date.now() - lastMs > VERSION_MIN_INTERVAL_MS) {
        snapshot(chapter, "autosave");
      }
    }

    fields.push("updated_at = datetime('now')");
    values.push(chapter.id);
    db.prepare(`UPDATE chapters SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    touchNovel(chapter.novel_id);
    res.json(shapeChapter(getChapter(req.params.id), true));
    // A revised body is re-read by the character engine (manual edits only, so
    // mid-typing autosaves don't trigger constant re-analysis while authoring).
    if (bodyChanged && source === "manual") autoAnalyzeChapter(chapter.id);
  })
);

chaptersRouter.delete(
  "/chapters/:id",
  asyncHandler((req, res) => {
    const chapter = getChapter(req.params.id);
    db.prepare("DELETE FROM chapters WHERE id = ?").run(chapter.id);
    touchNovel(chapter.novel_id);
    res.json({ ok: true });
  })
);

chaptersRouter.put(
  "/novels/:novelId/chapters/reorder",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    const ids: number[] = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) badRequest("ids array required");
    const owned = db.prepare("SELECT id, novel_id FROM chapters WHERE novel_id = ?").all(novelId) as { id: number }[];
    const ownedSet = new Set(owned.map((o) => o.id));
    const update = db.prepare("UPDATE chapters SET position = ? WHERE id = ?");
    const tx = db.transaction(() => {
      ids.forEach((id, index) => {
        if (ownedSet.has(Number(id))) update.run(index, Number(id));
      });
    });
    tx();
    touchNovel(novelId);
    const rows = db.prepare(`SELECT * FROM chapters WHERE novel_id = ? ORDER BY position, id`).all(novelId) as ChapterRow[];
    res.json(rows.map((r) => shapeChapter(r, false)));
  })
);

// ---- Versions -------------------------------------------------------------

chaptersRouter.get(
  "/chapters/:id/versions",
  asyncHandler((req, res) => {
    getChapter(req.params.id);
    const rows = db
      .prepare(`SELECT id, chapter_id, title, source, created_at FROM chapter_versions WHERE chapter_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`)
      .all(req.params.id) as { id: number; chapter_id: number; title: string; source: string; created_at: string }[];
    res.json(rows.map((r) => ({ id: r.id, chapterId: r.chapter_id, title: r.title, source: r.source, createdAt: r.created_at })));
  })
);

chaptersRouter.get(
  "/chapters/:id/versions/:versionId",
  asyncHandler((req, res) => {
    const row = db
      .prepare("SELECT * FROM chapter_versions WHERE chapter_id = ? AND id = ?")
      .get(req.params.id, req.params.versionId) as { id: number; body: string; created_at: string; source: string; title: string } | undefined;
    if (!row) notFound("Version not found");
    res.json({ id: row.id, chapterId: Number(req.params.id), body: row.body, title: row.title, source: row.source, createdAt: row.created_at });
  })
);

chaptersRouter.post(
  "/chapters/:id/versions/:versionId/restore",
  asyncHandler((req, res) => {
    const chapter = getChapter(req.params.id);
    const version = db
      .prepare("SELECT id, body FROM chapter_versions WHERE chapter_id = ? AND id = ?")
      .get(chapter.id, req.params.versionId) as { id: number; body: string } | undefined;
    if (!version) notFound("Version not found");
    // Snapshot current state before restoring, so a restore is itself reversible.
    snapshot(chapter, "pre-edit");
    db.prepare(`UPDATE chapters SET body = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?`).run(
      version.body,
      countWords(version.body),
      chapter.id
    );
    touchNovel(chapter.novel_id);
    res.json(shapeChapter(getChapter(chapter.id), true));
    autoAnalyzeChapter(chapter.id);
  })
);

// ---- Manuscript-wide search ----------------------------------------------

chaptersRouter.get(
  "/novels/:novelId/search",
  asyncHandler((req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ results: [] });
    const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    const rows = db
      .prepare(
        `SELECT id, title, position, notes FROM chapters WHERE novel_id = ?
         AND (body LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
         ORDER BY position, id`
      )
      .all(req.params.novelId, like, like, like) as { id: number; title: string; position: number; notes: string }[];
    const results = rows.map((r) => {
      const full = db.prepare("SELECT body, notes FROM chapters WHERE id = ?").get(r.id) as { body: string; notes: string };
      const haystack = full.body + "\n" + full.notes;
      const idx = haystack.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 60);
      const excerpt = idx >= 0 ? haystack.slice(start, idx + 120).replace(/\s+/g, " ") : "";
      return { chapterId: r.id, chapterTitle: r.title, position: r.position, excerpt, };
    });
    res.json({ results });
  })
);
