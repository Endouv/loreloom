import { Router } from "express";
import { db } from "../db/database.js";
import { asyncHandler, badRequest, parseJson, stringifyJson, touchNovel } from "../util.js";

export const novelsRouter = Router();

interface NovelRow {
  id: number;
  title: string;
  genre: string;
  status: string;
  target_words: number;
  synopsis: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

function shapeNovel(row: NovelRow, stats?: { chapters: number; words: number }) {
  return {
    id: row.id,
    title: row.title,
    genre: row.genre,
    status: row.status,
    targetWords: row.target_words,
    synopsis: row.synopsis,
    tags: parseJson(row.tags, []) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(stats ? { chapterCount: stats.chapters, wordCount: stats.words } : {}),
  };
}

novelsRouter.get(
  "/",
  asyncHandler((_req, res) => {
    const rows = db
      .prepare(
        `SELECT n.*, COUNT(c.id) as chapters, COALESCE(SUM(c.word_count), 0) as words
         FROM novels n LEFT JOIN chapters c ON c.novel_id = n.id
         GROUP BY n.id ORDER BY n.updated_at DESC`
      )
      .all() as (NovelRow & { chapters: number; words: number })[];
    res.json(rows.map((r) => shapeNovel(r, { chapters: r.chapters, words: r.words })));
  })
);

novelsRouter.post(
  "/",
  asyncHandler((req, res) => {
    const { title, genre = "", status = "draft", targetWords = 0, synopsis = "", tags = [] } = req.body ?? {};
    if (!title || typeof title !== "string") badRequest("Novel title is required");
    const info = db
      .prepare(
        `INSERT INTO novels (title, genre, status, target_words, synopsis, tags) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(title.trim(), genre, status, Number(targetWords) || 0, synopsis, stringifyJson(tags));
    const row = db.prepare("SELECT * FROM novels WHERE id = ?").get(info.lastInsertRowid) as NovelRow;
    res.status(201).json(shapeNovel(row, { chapters: 0, words: 0 }));
  })
);

novelsRouter.get(
  "/:id",
  asyncHandler((req, res) => {
    const row = db.prepare("SELECT * FROM novels WHERE id = ?").get(req.params.id) as NovelRow | undefined;
    if (!row) return res.status(404).json({ error: "Novel not found" });
    const stats = db
      .prepare("SELECT COUNT(*) as chapters, COALESCE(SUM(word_count), 0) as words FROM chapters WHERE novel_id = ?")
      .get(row.id) as { chapters: number; words: number };
    res.json(shapeNovel(row, stats));
  })
);

novelsRouter.put(
  "/:id",
  asyncHandler((req, res) => {
    const existing = db.prepare("SELECT id FROM novels WHERE id = ?").get(req.params.id) as { id: number } | undefined;
    if (!existing) return res.status(404).json({ error: "Novel not found" });
    const { title, genre, status, targetWords, synopsis, tags } = req.body ?? {};
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (name: string, value: unknown, column: string, transform?: (v: unknown) => unknown) => {
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        values.push(transform ? transform(value) : value);
      }
    };
    set("title", title, "title", (v) => String(v).trim());
    set("genre", genre, "genre");
    set("status", status, "status");
    set("targetWords", targetWords, "target_words");
    set("synopsis", synopsis, "synopsis");
    set("tags", tags, "tags", stringifyJson);
    if (!fields.length) return res.json({ ok: true });
    fields.push("updated_at = datetime('now')");
    values.push(existing.id);
    db.prepare(`UPDATE novels SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    touchNovel(existing.id);
    const row = db.prepare("SELECT * FROM novels WHERE id = ?").get(existing.id) as NovelRow;
    const stats = db
      .prepare("SELECT COUNT(*) as chapters, COALESCE(SUM(word_count), 0) as words FROM chapters WHERE novel_id = ?")
      .get(row.id) as { chapters: number; words: number };
    res.json(shapeNovel(row, stats));
  })
);

novelsRouter.delete(
  "/:id",
  asyncHandler((req, res) => {
    const info = db.prepare("DELETE FROM novels WHERE id = ?").run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: "Novel not found" });
    res.json({ ok: true });
  })
);
