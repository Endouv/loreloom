/**
 * Local embeddings for long-term story memory.
 *
 * Chapters, memory items, characters and world entries are chunked, hashed and
 * embedded with the Ollama embedding model. Hashes make re-indexing lazy: only
 * changed text is re-embedded. If no embedding model is installed, search
 * degrades to keyword matching rather than failing.
 */
import crypto from "node:crypto";
import { db } from "../db/database.js";
import { routeModel } from "./routing.js";
import { OLLAMA_BASE } from "./client.js";

const CHUNK_TARGET_CHARS = 2600;
const CHUNK_OVERLAP_CHARS = 260;
const EMBED_BATCH = 8;

function chunkText(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_TARGET_CHARS, clean.length);
    if (end < clean.length) {
      const breakIdx = clean.indexOf("\n\n", end - CHUNK_OVERLAP_CHARS);
      if (breakIdx > start + CHUNK_TARGET_CHARS / 2) end = breakIdx + 2;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - CHUNK_OVERLAP_CHARS;
  }
  return chunks.filter((c) => c.length > 0);
}

export const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

interface EmbedRow {
  id: number;
  text: string;
  hash: string;
}

export async function getEmbeddingModel(): Promise<string | null> {
  const decision = await routeModel("embedding");
  return decision.model;
}

export async function embedTexts(model: string, texts: string[]): Promise<number[][]> {
  const resp = await fetch(OLLAMA_BASE + "/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Embedding failed (${resp.status}): ${t.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { embeddings?: number[][] };
  return data.embeddings ?? [];
}

/** Index chapters (chunked), memory items, characters and world entries. Returns per-kind counts. */
export async function ensureIndex(
  novelId: number,
  kinds: string[] = ["chapter", "memory", "character", "world"],
): Promise<Record<string, number>> {
  const model = await getEmbeddingModel();
  const result: Record<string, number> = {};
  for (const kind of kinds) {
    let pending: EmbedRow[] = [];
    if (kind === "chapter") {
      const chapters = db.prepare("SELECT id, body FROM chapters WHERE novel_id = ?").all(novelId) as { id: number; body: string }[];
      for (const ch of chapters) {
        const chunks = chunkText(ch.body);
        const tx = db.transaction(() => {
          const existing = db.prepare("SELECT id, hash FROM embeddings_chunks WHERE kind = 'chapter' AND chapter_id = ?").all(ch.id) as {
            id: number;
            hash: string;
          }[];
          const liveHashes = new Set(chunks.map(sha1));
          for (const row of existing) if (!liveHashes.has(row.hash)) db.prepare("DELETE FROM embeddings_chunks WHERE id = ?").run(row.id);
          const have = new Set(existing.map((e) => e.hash));
          const ins = db.prepare("INSERT INTO embeddings_chunks (novel_id, kind, chapter_id, text, hash) VALUES (?, 'chapter', ?, ?, ?)");
          chunks.forEach((text) => {
            const h = sha1(text);
            if (!have.has(h)) ins.run(novelId, ch.id, text, h);
          });
        });
        tx();
      }
      pending = db
        .prepare("SELECT id, text, hash FROM embeddings_chunks WHERE novel_id = ? AND kind = 'chapter' AND embedding IS NULL")
        .all(novelId) as EmbedRow[];
    } else {
      const items: { id: number; text: string }[] =
        kind === "memory"
          ? (db
              .prepare("SELECT id, text FROM memory_items WHERE novel_id = ? AND bucket IN ('canon','provisional','question')")
              .all(novelId) as { id: number; text: string }[])
          : kind === "character"
            ? (db
                .prepare(
                  "SELECT id, text FROM (SELECT id, name || ' ' || personality || ' ' || background || ' ' || motivations || ' ' || story_status AS text FROM characters WHERE novel_id = ?)",
                )
                .all(novelId) as { id: number; text: string }[])
            : (db
                .prepare("SELECT id, category || ': ' || title || '. ' || body AS text FROM world_entries WHERE novel_id = ?")
                .all(novelId) as { id: number; text: string }[]);
      const tx = db.transaction(() => {
        const del = db.prepare(`DELETE FROM embeddings_chunks WHERE novel_id = ? AND kind = '${kind}'`);
        del.run(novelId);
        const ins = db.prepare(`INSERT INTO embeddings_chunks (novel_id, kind, item_id, text, hash) VALUES (?, '${kind}', ?, ?, ?)`);
        for (const item of items) {
          if (item.text.trim()) ins.run(novelId, item.id, item.text.trim(), sha1(item.text.trim()));
        }
      });
      tx();
      pending = db
        .prepare(`SELECT id, text, hash FROM embeddings_chunks WHERE novel_id = ? AND kind = '${kind}' AND embedding IS NULL`)
        .all(novelId) as EmbedRow[];
    }

    // Embed in small batches; a failure leaves rows with NULL embedding for a later retry.
    let embedded = 0;
    if (model) {
      for (let i = 0; i < pending.length; i += EMBED_BATCH) {
        const batch = pending.slice(i, i + EMBED_BATCH);
        try {
          const vectors = await embedTexts(
            model,
            batch.map((b) => b.text),
          );
          const upd = db.prepare("UPDATE embeddings_chunks SET embedding = ?, model = ? WHERE id = ?");
          batch.forEach((row, j) => {
            upd.run(Buffer.from(Float32Array.from(vectors[j] ?? []).buffer), model, row.id);
          });
          embedded += batch.length;
        } catch (err) {
          console.error("[loreloom] embedding batch failed:", err);
          break;
        }
      }
    }
    result[kind] = pending.length - embedded; // remaining un-embedded
  }
  return result;
}

export interface ScoredChunk {
  kind: string;
  itemId: number | null;
  chapterId: number | null;
  text: string;
  score: number;
}

const keywordScore = (needle: string, haystack: string): number => {
  const lower = haystack.toLowerCase();
  const words = needle
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (!words.length) return 0;
  let hits = 0;
  for (const w of words) if (lower.includes(w)) hits++;
  return hits / words.length;
};

export async function semanticSearch(novelId: number, kinds: string[], query: string, k = 10): Promise<ScoredChunk[]> {
  const rows = db
    .prepare(
      `SELECT id, kind, item_id, chapter_id, text, hash, embedding FROM embeddings_chunks WHERE novel_id = ? AND kind IN (${kinds.map(() => "?").join(", ")})`,
    )
    .all(novelId, ...kinds) as {
    id: number;
    kind: string;
    item_id: number | null;
    chapter_id: number | null;
    text: string;
    hash: string;
    embedding: Buffer | null;
  }[];

  if (rows.length === 0) return [];

  const model = await getEmbeddingModel();
  let queryVec: number[] | null = null;
  if (model) {
    try {
      [queryVec] = await embedTexts(model, [query.trim()]);
    } catch {
      queryVec = null;
    }
  }

  const cosine = (a: Float32Array, b: number[]): number => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };

  return rows
    .map((r) => {
      let score = 0;
      if (queryVec && r.embedding) {
        score = cosine(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4), queryVec);
      } else {
        score = keywordScore(query, r.text);
      }
      return { kind: r.kind, itemId: r.item_id, chapterId: r.chapter_id, text: r.text, score };
    })
    .filter((s) => s.score > (queryVec ? 0.18 : 0.2))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function memoryIndexStatus(novelId: number) {
  const row = db
    .prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as embedded FROM embeddings_chunks WHERE novel_id = ? AND kind = 'chapter'",
    )
    .get(novelId) as { total: number; embedded: number | null };
  return { total: row.total ?? 0, embedded: row.embedded ?? 0 };
}
