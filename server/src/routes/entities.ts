import { Router } from "express";
import { db } from "../db/database.js";
import { asyncHandler, badRequest, notFound, parseJson, stringifyJson, touchNovel } from "../util.js";
import { applySuggestion, mergeCharacters } from "../agents/characters.js";

// Generic helpers shared by characters / world / timeline routes.

type Row = Record<string, any>;

function list(novelId: unknown, table: string, where = "", params: unknown[] = []): Row[] {
  return db.prepare(`SELECT * FROM ${table} WHERE novel_id = ? ${where} ORDER BY id`).all(novelId, ...params) as Row[];
}

function camel(row: Row, textFields: string[], jsonFields: string[] = [], para?: Partial<Record<string, (v: string) => any>>): Row {
  const out: Row = { ...row };
  // snake_case -> camelCase for all keys
  for (const key of Object.keys(out)) {
    if (key.includes("_")) {
      const camelKey = key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
      out[camelKey] = out[key];
      delete out[key];
    }
  }
  const nullable = ["firstAppearanceChapterId", "chapterId"];
  for (const key of Object.keys(out)) {
    if (jsonFields.includes(key)) {
      out[key] = parseJson(out[key], []);
    } else if (para && para[key]) {
      out[key] = para[key](out[key]);
    } else if ((textFields.includes(key) || out[key] == null) && nullable.includes(key)) {
      out[key] = null;
    }
  }
  if (out.novelId != null) out.novelId = Number(out.novelId);
  return out;
}

function validateNovel(novelId: unknown) {
  const novel = db.prepare("SELECT id FROM novels WHERE id = ?").get(Number(novelId)) as { id: number } | undefined;
  if (!novel) notFound("Novel not found");
  return novel;
}

// ------------------------------- Characters --------------------------------

export const charactersRouter = Router();

const CHARACTER_TEXTS = ["personality", "appearance", "background", "motivations", "strengths", "weaknesses", "storyStatus", "devNotes", "freeNotes"];

charactersRouter.get(
  "/novels/:novelId/characters",
  asyncHandler((req, res) => {
    const rows = db
      .prepare("SELECT * FROM characters WHERE novel_id = ? ORDER BY name COLLATE NOCASE")
      .all(req.params.novelId) as Row[];
    res.json(rows.map((r) => camel(r, CHARACTER_TEXTS, ["aliases"])));
  })
);

// --- Automatic character engine (must be registered before /:id routes) ---

charactersRouter.get(
  "/novels/:novelId/characters/pending",
  asyncHandler((req, res) => {
    validateNovel(Number(req.params.novelId));
    const rows = db
      .prepare(
        `SELECT s.*, c.title AS chapter_title FROM character_suggestions s
         LEFT JOIN chapters c ON c.id = s.chapter_id
         WHERE s.novel_id = ? AND s.status = 'pending' ORDER BY s.id DESC`
      )
      .all(req.params.novelId) as Row[];
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        novelId: Number(r.novel_id),
        chapterId: r.chapter_id == null ? null : Number(r.chapter_id),
        chapterTitle: r.chapter_title ?? null,
        kind: r.kind,
        payload: parseJson(r.payload, {}),
        reason: r.reason ?? "",
        status: r.status,
        createdAt: r.created_at,
      }))
    );
  })
);

charactersRouter.post(
  "/novels/:novelId/characters/pending/:suggestionId/decision",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    const decision = (req.body?.decision ?? "").toString();
    if (!["approve", "reject"].includes(decision)) badRequest("decision must be approve or reject");
    const row = db
      .prepare("SELECT * FROM character_suggestions WHERE id = ? AND novel_id = ? AND status = 'pending'")
      .get(req.params.suggestionId, novelId) as
      | { id: number; novel_id: number; chapter_id: number | null; kind: string; payload: string }
      | undefined;
    if (!row) notFound("Suggestion not found");
    if (decision === "reject") {
      db.prepare("UPDATE character_suggestions SET status = 'rejected', decided_at = datetime('now') WHERE id = ?").run(row.id);
      touchNovel(novelId);
      return res.json({ ok: true, decision });
    }
    const result = applySuggestion(row);
    touchNovel(novelId);
    res.json({ ok: true, decision, result });
  })
);

charactersRouter.get(
  "/novels/:novelId/characters/graph",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    validateNovel(novelId);
    const nodes = db
      .prepare("SELECT id, name, story_status FROM characters WHERE novel_id = ? ORDER BY name COLLATE NOCASE")
      .all(novelId) as Row[];
    const links = db
      .prepare(
        `SELECT l.id, l.from_character_id AS fromCharacterId, l.to_character_id AS toCharacterId,
                l.kind, l.notes, l.certainty, l.chapter_id AS chapterId,
                c1.name AS fromName, c2.name AS toName
         FROM character_links l
         JOIN characters c1 ON c1.id = l.from_character_id
         JOIN characters c2 ON c2.id = l.to_character_id
         WHERE l.novel_id = ? ORDER BY l.id`
      )
      .all(novelId) as Row[];
    res.json({ nodes, links });
  })
);

charactersRouter.post(
  "/novels/:novelId/characters/:id/merge",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    const otherId = Number(req.body?.otherId);
    if (!otherId) badRequest("otherId required");
    validateNovel(novelId);
    mergeCharacters(Number(req.params.id), otherId);
    res.json({ ok: true, mergedInto: Number(req.params.id) });
  })
);

charactersRouter.get(
  "/novels/:novelId/characters/:id",
  asyncHandler((req, res) => {
    const row = db
      .prepare("SELECT * FROM characters WHERE id = ? AND novel_id = ?")
      .get(req.params.id, req.params.novelId) as Row | undefined;
    if (!row) notFound("Character not found");
    const shaped = camel(row, CHARACTER_TEXTS, ["aliases"]);
    shaped.events = db
      .prepare("SELECT id, description, chapter_id AS chapterId FROM character_events WHERE character_id = ? ORDER BY id")
      .all(row.id);
    shaped.links = db
      .prepare(
        `SELECT l.id, l.kind, l.notes, l.certainty, l.chapter_id AS chapterId, l.from_character_id AS fromCharacterId, l.to_character_id AS toCharacterId,
                c1.name AS fromName, c2.name AS toName
         FROM character_links l
         JOIN characters c1 ON c1.id = l.from_character_id
         JOIN characters c2 ON c2.id = l.to_character_id
         WHERE l.from_character_id = ? OR l.to_character_id = ?`
      )
      .all(row.id, row.id);
    shaped.appearances = db
      .prepare(
        `SELECT a.id, a.kind, a.chapter_id AS chapterId, c.title AS chapterTitle, c.position
         FROM character_appearances a JOIN chapters c ON c.id = a.chapter_id
         WHERE a.character_id = ? ORDER BY c.position, c.id`
      )
      .all(row.id);
    shaped.knowledge = db
      .prepare(
        `SELECT k.id, k.kind, k.text, k.source, k.chapter_id AS chapterId, c.title AS chapterTitle
         FROM character_knowledge k LEFT JOIN chapters c ON c.id = k.chapter_id
         WHERE k.character_id = ? ORDER BY c.position, k.id`
      )
      .all(row.id);
    res.json(shaped);
  })
);

charactersRouter.post(
  "/novels/:novelId/characters",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    validateNovel(novelId);
    const b = req.body ?? {};
    if (!b.name?.toString().trim()) badRequest("Character name is required");
    const info = db
      .prepare(
        `INSERT INTO characters (novel_id, name, aliases, personality, appearance, background, motivations, strengths, weaknesses, story_status, dev_notes, free_notes, first_appearance_chapter_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        novelId,
        String(b.name).trim(),
        stringifyJson(b.aliases ?? []),
        b.personality ?? "",
        b.appearance ?? "",
        b.background ?? "",
        b.motivations ?? "",
        b.strengths ?? "",
        b.weaknesses ?? "",
        b.storyStatus ?? "",
        b.devNotes ?? "",
        b.freeNotes ?? "",
        b.firstAppearanceChapterId ?? null
      );
    touchNovel(novelId);
    const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(info.lastInsertRowid) as Row;
    res.status(201).json(camel(row, CHARACTER_TEXTS, ["aliases"]));
  })
);

charactersRouter.put(
  "/novels/:novelId/characters/:id",
  asyncHandler((req, res) => {
    const row = db.prepare("SELECT * FROM characters WHERE id = ? AND novel_id = ?").get(req.params.id, req.params.novelId) as Row | undefined;
    if (!row) notFound("Character not found");
    const b = req.body ?? {};
    const cols: Record<string, unknown> = {
      name: b.name,
      aliases: b.aliases === undefined ? undefined : stringifyJson(b.aliases),
      personality: b.personality,
      appearance: b.appearance,
      background: b.background,
      motivations: b.motivations,
      strengths: b.strengths,
      weaknesses: b.weaknesses,
      story_status: b.storyStatus,
      dev_notes: b.devNotes,
      free_notes: b.freeNotes,
      first_appearance_chapter_id: b.firstAppearanceChapterId,
    };
    const sets = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (sets.length === 0 && b.events === undefined && b.links === undefined) return res.json(camel(row, CHARACTER_TEXTS, ["aliases"]));
    const tx = db.transaction(() => {
      if (sets.length) {
        db.prepare(`UPDATE characters SET ${sets.map(([c]) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(
          ...sets.map(([, v]) => v),
          row.id
        );
      }
      if (b.events !== undefined) {
        db.prepare("DELETE FROM character_events WHERE character_id = ?").run(row.id);
        const ins = db.prepare("INSERT INTO character_events (character_id, description, chapter_id) VALUES (?, ?, ?)");
        for (const ev of b.events ?? []) ins.run(row.id, ev.description ?? "", ev.chapterId ?? null);
      }
      if (b.links !== undefined) {
        db.prepare("DELETE FROM character_links WHERE from_character_id = ? OR to_character_id = ?").run(row.id, row.id);
        const ins = db.prepare("INSERT INTO character_links (novel_id, from_character_id, to_character_id, kind, notes) VALUES (?, ?, ?, ?, ?)");
        for (const l of b.links ?? []) {
          if (!l.toCharacterId || Number(l.toCharacterId) === row.id) continue;
          ins.run(row.novel_id, row.id, l.toCharacterId, l.kind ?? "", l.notes ?? "");
        }
      }
    });
    tx();
    touchNovel(row.novel_id);
    const updated = db.prepare("SELECT * FROM characters WHERE id = ?").get(row.id) as Row;
    res.json(camel(updated, CHARACTER_TEXTS, ["aliases"]));
  })
);

charactersRouter.delete(
  "/novels/:novelId/characters/:id",
  asyncHandler((req, res) => {
    const info = db.prepare("DELETE FROM characters WHERE id = ? AND novel_id = ?").run(req.params.id, req.params.novelId);
    if (!info.changes) notFound("Character not found");
    res.json({ ok: true });
  })
);

// World entries

export const worldRouter = Router();

worldRouter.get(
  "/novels/:novelId/world",
  asyncHandler((req, res) => {
    const rows = db
      .prepare("SELECT * FROM world_entries WHERE novel_id = ? ORDER BY category, title COLLATE NOCASE")
      .all(req.params.novelId) as Row[];
    res.json(rows.map((r) => camel(r, ["title", "body"], ["fields"])));
  })
);

worldRouter.post(
  "/novels/:novelId/world",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    validateNovel(novelId);
    const b = req.body ?? {};
    if (!b.title?.toString().trim() || !b.category?.toString().trim()) badRequest("Category and title are required");
    const info = db
      .prepare("INSERT INTO world_entries (novel_id, category, title, body, fields) VALUES (?, ?, ?, ?, ?)")
      .run(novelId, String(b.category), String(b.title).trim(), b.body ?? "", stringifyJson(b.fields ?? []));
    touchNovel(novelId);
    const row = db.prepare("SELECT * FROM world_entries WHERE id = ?").get(info.lastInsertRowid) as Row;
    res.status(201).json(camel(row, ["title", "body"], ["fields"]));
  })
);

worldRouter.put(
  "/novels/:novelId/world/:id",
  asyncHandler((req, res) => {
    const row = db.prepare("SELECT * FROM world_entries WHERE id = ? AND novel_id = ?").get(req.params.id, req.params.novelId) as Row | undefined;
    if (!row) notFound("World entry not found");
    const b = req.body ?? {};
    db.prepare(
      `UPDATE world_entries SET category = ?, title = ?, body = ?, fields = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      b.category ?? row.category,
      (b.title ?? row.title).trim(),
      b.body ?? row.body,
      b.fields === undefined ? row.fields : stringifyJson(b.fields),
      row.id
    );
    touchNovel(row.novel_id);
    const updated = db.prepare("SELECT * FROM world_entries WHERE id = ?").get(row.id) as Row;
    res.json(camel(updated, ["title", "body"], ["fields"]));
  })
);

worldRouter.delete(
  "/novels/:novelId/world/:id",
  asyncHandler((req, res) => {
    const info = db.prepare("DELETE FROM world_entries WHERE id = ? AND novel_id = ?").run(req.params.id, req.params.novelId);
    if (!info.changes) notFound("World entry not found");
    res.json({ ok: true });
  })
);

// Timeline

export const timelineRouter = Router();

timelineRouter.get(
  "/novels/:novelId/timeline",
  asyncHandler((req, res) => {
    const rows = db.prepare("SELECT * FROM timeline_events WHERE novel_id = ? ORDER BY story_date_order, id").all(req.params.novelId) as Row[];
    res.json(rows.map((r) => camel(r, ["title", "description", "storyDateLabel"], ["characterIds"])));
  })
);

timelineRouter.post(
  "/novels/:novelId/timeline",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    validateNovel(novelId);
    const b = req.body ?? {};
    if (!b.title?.toString().trim()) badRequest("Event title is required");
    const info = db
      .prepare(
        `INSERT INTO timeline_events (novel_id, chapter_id, title, description, story_date_label, story_date_order, kind, character_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(novelId, b.chapterId ?? null, String(b.title).trim(), b.description ?? "", b.storyDateLabel ?? "", Number(b.storyDateOrder) || 0, b.kind ?? "event", stringifyJson(b.characterIds ?? []));
    touchNovel(novelId);
    const row = db.prepare("SELECT * FROM timeline_events WHERE id = ?").get(info.lastInsertRowid) as Row;
    res.status(201).json(camel(row, ["title", "description", "storyDateLabel"], ["characterIds"]));
  })
);

timelineRouter.put(
  "/novels/:novelId/timeline/reorder",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    const orders: { id: number; storyDateOrder: number }[] = req.body?.orders ?? [];
    if (!Array.isArray(orders)) badRequest("orders array required");
    const tx = db.transaction(() => {
      for (const o of orders) {
        db.prepare("UPDATE timeline_events SET story_date_order = ?, updated_at = datetime('now') WHERE id = ? AND novel_id = ?").run(
          Number(o.storyDateOrder) || 0,
          o.id,
          novelId
        );
      }
    });
    tx();
    touchNovel(novelId);
    res.json({ ok: true });
  })
);

timelineRouter.put(
  "/novels/:novelId/timeline/:id",
  asyncHandler((req, res) => {
    const row = db.prepare("SELECT * FROM timeline_events WHERE id = ? AND novel_id = ?").get(req.params.id, req.params.novelId) as Row | undefined;
    if (!row) notFound("Timeline event not found");
    const b = req.body ?? {};
    db.prepare(
      `UPDATE timeline_events SET chapter_id = ?, title = ?, description = ?, story_date_label = ?, story_date_order = ?, kind = ?, character_ids = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      b.chapterId === undefined ? row.chapter_id : b.chapterId,
      (b.title ?? row.title).trim(),
      b.description ?? row.description,
      b.storyDateLabel === undefined ? row.story_date_label : b.storyDateLabel,
      b.storyDateOrder === undefined ? row.story_date_order : Number(b.storyDateOrder),
      b.kind === undefined ? row.kind : b.kind,
      b.characterIds === undefined ? row.character_ids : stringifyJson(b.characterIds),
      row.id
    );
    touchNovel(row.novel_id);
    const updated = db.prepare("SELECT * FROM timeline_events WHERE id = ?").get(row.id) as Row;
    res.json(camel(updated, ["title", "description", "storyDateLabel"], ["characterIds"]));
  })
);

timelineRouter.delete(
  "/novels/:novelId/timeline/:id",
  asyncHandler((req, res) => {
    const info = db.prepare("DELETE FROM timeline_events WHERE id = ? AND novel_id = ?").run(req.params.id, req.params.novelId);
    if (!info.changes) notFound("Timeline event not found");
    res.json({ ok: true });
  })
);

// Memory

export const memoryRouter = Router();

const MEMORY_BUCKETS = ["canon", "provisional", "ai_suggestion", "question", "rejected"];

memoryRouter.get(
  "/novels/:novelId/memory",
  asyncHandler((req, res) => {
    const rows = db
      .prepare("SELECT * FROM memory_items WHERE novel_id = ? ORDER BY created_at DESC, id DESC")
      .all(req.params.novelId) as Row[];
    res.json(rows.map((r) => camel(r, ["text", "category", "source", "bucket"])));
  })
);

memoryRouter.post(
  "/novels/:novelId/memory",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    validateNovel(novelId);
    const b = req.body ?? {};
    if (!b.text?.toString().trim()) badRequest("Memory text is required");
    const bucket = b.bucket ?? "provisional";
    if (!MEMORY_BUCKETS.includes(bucket)) badRequest("Unknown memory bucket");
    const info = db
      .prepare(`INSERT INTO memory_items (novel_id, text, bucket, source, chapter_id, category) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(novelId, String(b.text).trim(), bucket, b.source ?? "author", b.chapterId ?? null, b.category ?? "");
    touchNovel(novelId);
    const row = db.prepare("SELECT * FROM memory_items WHERE id = ?").get(info.lastInsertRowid) as Row;
    res.status(201).json(camel(row, ["text", "category", "source", "bucket"]));
  })
);

memoryRouter.put(
  "/novels/:novelId/memory/:id",
  asyncHandler((req, res) => {
    const row = db.prepare("SELECT * FROM memory_items WHERE id = ? AND novel_id = ?").get(req.params.id, req.params.novelId) as Row | undefined;
    if (!row) notFound("Memory item not found");
    const b = req.body ?? {};
    if (b.bucket !== undefined && !MEMORY_BUCKETS.includes(b.bucket)) badRequest("Unknown memory bucket");
    db.prepare(`UPDATE memory_items SET text = ?, bucket = ?, category = ?, decided_at = ? WHERE id = ?`).run(
      b.text === undefined ? row.text : String(b.text).trim(),
      b.bucket === undefined ? row.bucket : b.bucket,
      b.category === undefined ? row.category : b.category,
      b.bucket !== undefined && b.bucket !== row.bucket ? new Date().toISOString() : row.decided_at,
      row.id
    );
    touchNovel(row.novel_id);
    const updated = db.prepare("SELECT * FROM memory_items WHERE id = ?").get(row.id) as Row;
    res.json(camel(updated, ["text", "category", "source", "bucket"]));
  })
);

memoryRouter.delete(
  "/novels/:novelId/memory/:id",
  asyncHandler((req, res) => {
    const info = db.prepare("DELETE FROM memory_items WHERE id = ? AND novel_id = ?").run(req.params.id, req.params.novelId);
    if (!info.changes) notFound("Memory item not found");
    res.json({ ok: true });
  })
);

memoryRouter.post(
  "/novels/:novelId/memory/bulk",
  asyncHandler((req, res) => {
    const novelId = Number(req.params.novelId);
    const { ids, action } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) badRequest("ids array required");
    const placeholders = ids.map(() => "?").join(", ");
    const args = [...ids.map(Number), novelId];
    if (action === "reject") {
      db.prepare(
        `UPDATE memory_items SET bucket = 'rejected', decided_at = CASE bucket WHEN 'ai_suggestion' THEN datetime('now') ELSE decided_at END WHERE id IN (${placeholders}) AND novel_id = ?`
      ).run(...args);
      return res.json({ ok: true, action });
    }
    if (action === "approve") {
      db.prepare(
        `UPDATE memory_items SET bucket = 'canon', decided_at = datetime('now') WHERE id IN (${placeholders}) AND novel_id = ?`
      ).run(...args);
      return res.json({ ok: true, action });
    }
    if (action === "delete") {
      db.prepare(`DELETE FROM memory_items WHERE id IN (${placeholders}) AND novel_id = ?`).run(...args);
      return res.json({ ok: true, action });
    }
    badRequest("action must be approve, reject or delete");
  })
);
