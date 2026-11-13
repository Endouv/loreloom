/**
 * Context assembly: every AI request gets a *retrieved*, budgeted prompt —
 * never the whole manuscript. Sources: approved/provisional story memory,
 * characters, world entries and the timeline, ranked by local semantic search.
 */
import { db } from "../db/database.js";
import { parseJson } from "../util.js";
import { readPrefs } from "../routes/misc.js";
import { semanticSearch, ensureIndex } from "../ollama/embeddings.js";
import type { ChatMessage } from "../ollama/client.js";

// Row shapes for the columns these queries actually read. All of them are
// nullable at the SQLite level, so the readers handle empty values.
interface ContextHitRow {
  id: number;
  text?: string | null;
  bucket?: string | null;
  name?: string | null;
  personality?: string | null;
  story_status?: string | null;
  background?: string | null;
  title?: string | null;
  category?: string | null;
  body?: string | null;
}

interface OverviewNovelRow {
  title: string;
  genre: string | null;
  status: string;
  target_words: number | null;
  synopsis: string | null;
  tags: string | null;
}

interface OverviewCharacterRow {
  id: number;
  name: string;
  aliases: string | null;
  personality: string | null;
  appearance: string | null;
  background: string | null;
  motivations: string | null;
  strengths: string | null;
  weaknesses: string | null;
  story_status: string | null;
  dev_notes: string | null;
}

interface OverviewChapterRow {
  title: string;
  status: string;
  word_count: number;
  summary: string | null;
  body: string | null;
}

interface OverviewWorldRow {
  title: string;
  category: string;
  body: string | null;
}

interface OverviewTimelineRow {
  title: string;
  description: string | null;
  story_date_label: string | null;
}

interface OverviewLinkRow {
  kind: string;
  certainty: string;
  from_character_id: number;
  to_character_id: number;
}

export interface AssembledContext {
  canon: string[];
  provisional: string[];
  characters: string[];
  world: string[];
  timeline: string[];
  style: string;
  indexed: boolean;
}

export function readStyle(): { language: string; style: string; creativeFreedom: string } {
  const writing = readPrefs().writing;
  return {
    language: typeof writing.language === "string" ? writing.language : "English",
    style: typeof writing.style === "string" && writing.style.trim() ? writing.style : "clear literary prose, natural dialogue",
    creativeFreedom: ["strict", "balanced", "adventurous"].includes(writing.creativeFreedom) ? writing.creativeFreedom : "balanced",
  };
}

export async function assembleContext(novelId: number, query: string, opts?: { rebuildIndex?: boolean }): Promise<AssembledContext> {
  const prefs = readPrefs();
  const budget = Number(prefs.memory.contextBudgetChars) || 6000;
  const k = Number(prefs.memory.retrievalChunks) || 8;

  if (opts?.rebuildIndex || prefs.memory.autoSuggestFromChapters !== false) {
    try {
      await ensureIndex(novelId);
    } catch (err) {
      console.error("[loreloom] index refresh failed:", err);
    }
  }

  const hits = await semanticSearch(novelId, ["memory", "character", "world"], query || "story so far", Math.max(k * 2, 12));

  const ctx: AssembledContext = {
    canon: [],
    provisional: [],
    characters: [],
    world: [],
    timeline: [],
    style: "",
    indexed: false,
  };
  const style = readStyle();
  ctx.style = `Write in ${style.language}. Style: ${style.style}. Creative freedom granted to the AI: ${style.creativeFreedom}. The author's stated decisions are canon and must not be contradicted.`;

  const idsInGroup: Record<string, number[]> = { memory: [], character: [], world: [] };
  let used = 0;
  for (const hit of hits) {
    if (!hit.itemId || used >= budget) continue;
    const table = hit.kind === "memory" ? "memory_items" : hit.kind === "character" ? "characters" : "world_entries";
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND novel_id = ?`).get(hit.itemId, novelId) as ContextHitRow | undefined;
    if (!row) continue;
    const line =
      hit.kind === "memory"
        ? (row.text ?? "")
        : hit.kind === "character"
          ? `Character ${row.name ?? "?"}: personality ${row.personality || "unspecified"}, appears as ${row.story_status || "active"}. ${row.background || ""}`.slice(
              0,
              700,
            )
          : `World — ${row.title ?? ""} (${row.category ?? ""}): ${row.body ?? ""}`.slice(0, 700);
    const remains = budget - used;
    if (line.length > remains) continue;
    used += line.length;
    idsInGroup[hit.kind].push(row.id);
    if (hit.kind === "memory") {
      (row.bucket === "canon" ? ctx.canon : ctx.provisional).push(line);
    } else if (hit.kind === "character") {
      ctx.characters.push(line);
    } else {
      ctx.world.push(line);
    }
  }

  // Always include the freshest timeline events for narrative grounding.
  const events = db
    .prepare("SELECT title, description, story_date_label FROM timeline_events WHERE novel_id = ? ORDER BY story_date_order DESC LIMIT 6")
    .all(novelId) as { title: string; description: string; story_date_label: string }[];
  ctx.timeline = events.map((e) =>
    `— ${e.story_date_label || "date unknown"}: ${e.title}${e.description ? `. ${e.description}` : ""}`.slice(0, 250),
  );
  ctx.indexed = ctx.canon.length + ctx.characters.length + ctx.world.length > 0 || hits.length > 0;
  return ctx;
}

/** Merge the assembled context + task framing into a chat message list. */
export function withSystem(ctx: AssembledContext, systemPrompt: string, novelTitle: string): ChatMessage[] {
  const parts = [systemPrompt, ctx.style];
  if (ctx.canon.length) parts.push(`CONFIRMED STORY CANON (author-approved facts):\n${ctx.canon.map((c) => `- ${c}`).join("\n")}`);
  if (ctx.provisional.length) parts.push(`PROVISIONAL NOTES (lower confidence):\n${ctx.provisional.map((c) => `- ${c}`).join("\n")}`);
  if (ctx.characters.length) parts.push(`RELEVANT CHARACTERS:\n${ctx.characters.map((c) => `- ${c}`).join("\n")}`);
  if (ctx.world.length) parts.push(`RELEVANT WORLD DETAILS:\n${ctx.world.map((c) => `- ${c}`).join("\n")}`);
  if (ctx.timeline.length) parts.push(`RECENT TIMELINE:\n${ctx.timeline.join("\n")}`);
  parts.push(`Novel: "${novelTitle}". AI assists the author's intent; never contradict approved canon hard-won above.`);
  return [{ role: "system", content: parts.join("\n\n") }];
}

export function novelTitle(novelId: number): string {
  const row = db.prepare("SELECT title FROM novels WHERE id = ?").get(novelId) as { title: string } | undefined;
  return row?.title ?? "Untitled";
}

// ---------------------------------------------------------------------------
// Full project overview: the assistant's complete view of the novel, assembled
// from the database (story, cast, knowledge, world, timeline, memory).
// Budget scales with the configured model context window.
// ---------------------------------------------------------------------------

import { numCtxTokens } from "../ollama/routing.js";

export interface ProjectOverview {
  text: string;
  stats: { novels: number; chapters: number; characters: number; world: number; memories: number; chars: number };
}

const clean = (s: unknown, max = 1000): string =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

export function assembleOverview(novelId: number): ProjectOverview {
  const tokens = numCtxTokens() ?? 8192;
  // ~3 chars/token; leave room for the conversation history and the reply.
  let budget = Math.max(4000, Math.min(32000, Math.round(tokens * 2.5)));
  const novel = db.prepare("SELECT * FROM novels WHERE id = ?").get(novelId) as OverviewNovelRow | undefined;
  if (!novel) throw Object.assign(new Error("Novel not found"), { status: 404 });

  const parts: string[] = [];
  const stats = { novels: 1, chapters: 0, characters: 0, world: 0, memories: 0, chars: 0 };
  const push = (content: string) => {
    if (budget <= 0) return false;
    const take = content.slice(0, budget);
    parts.push(take);
    budget -= take.length;
    return true;
  };

  const tags = parseJson(novel.tags, []) as string[];
  push(
    [
      `PROJECT: "${novel.title}" (genre: ${novel.genre || "unset"}, status: ${novel.status}, target: ${novel.target_words || "unspecified"} words)`,
      novel.synopsis ? `Author synopsis: ${clean(novel.synopsis, 3000)}` : "Author synopsis: (none written yet)",
      tags.length ? `Tags: ${tags.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  // Story memory first: this is the author's own binding record.
  const memory = db
    .prepare(
      "SELECT text, bucket FROM memory_items WHERE novel_id = ? AND bucket IN ('canon','provisional','question') ORDER BY bucket, id",
    )
    .all(novelId) as { text: string; bucket: string }[];
  stats.memories = memory.length;
  const canon = memory.filter((m) => m.bucket === "canon");
  const provisional = memory.filter((m) => m.bucket === "provisional");
  const questions = memory.filter((m) => m.bucket === "question");
  const memoryBlock = [
    canon.length ? `CONFIRMED CANON:\n${canon.map((m) => `- ${clean(m.text, 500)}`).join("\n")}` : "",
    provisional.length ? `AUTHOR NOTES (non-binding):\n${provisional.map((m) => `- ${clean(m.text, 300)}`).join("\n")}` : "",
    questions.length ? `OPEN QUESTIONS:\n${questions.map((m) => `- ${clean(m.text, 300)}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (memoryBlock) push(memoryBlock);

  // Full cast, complete profiles + what each one knows.
  const chars = db
    .prepare("SELECT * FROM characters WHERE novel_id = ? ORDER BY name COLLATE NOCASE")
    .all(novelId) as OverviewCharacterRow[];
  stats.characters = chars.length;
  if (chars.length) {
    const charBlocks = chars.map((c) => {
      const aliases = parseJson(c.aliases, []) as string[];
      const fields = [
        aliases.length ? `aliases: ${aliases.join(", ")}` : "",
        c.personality ? `personality: ${clean(c.personality, 500)}` : "",
        c.appearance ? `appearance: ${clean(c.appearance, 500)}` : "",
        c.background ? `background: ${clean(c.background, 800)}` : "",
        c.motivations ? `motivations: ${clean(c.motivations, 500)}` : "",
        c.strengths ? `strengths: ${clean(c.strengths, 300)}` : "",
        c.weaknesses ? `weaknesses: ${clean(c.weaknesses, 300)}` : "",
        c.story_status ? `story status: ${clean(c.story_status, 200)}` : "",
        c.dev_notes ? `development: ${clean(c.dev_notes, 600)}` : "",
      ].filter(Boolean);
      const knowledge = db
        .prepare(`SELECT kind, text FROM character_knowledge WHERE character_id = ? ORDER BY kind, id LIMIT 12`)
        .all(c.id) as { kind: string; text: string }[];
      const links = db
        .prepare(
          `SELECT kind, certainty, from_character_id, to_character_id FROM character_links WHERE from_character_id = ? OR to_character_id = ?`,
        )
        .all(c.id, c.id) as OverviewLinkRow[];
      const known = knowledge.length ? `\n  knows: ${knowledge.map((k) => `(${k.kind}) ${clean(k.text, 200)}`).join("; ")}` : "";
      const rels = links.length
        ? `\n  relationships: ${links
            .map((l) => {
              const other = l.from_character_id === c.id ? l.to_character_id : l.from_character_id;
              const otherName =
                (db.prepare("SELECT name FROM characters WHERE id = ?").get(other) as { name: string } | undefined)?.name ?? "?";
              return `${l.kind}${l.certainty === "confirmed" ? "" : "?"} ${otherName}`;
            })
            .join(", ")}`
        : "";
      return `- ${c.name}${fields.length ? ` — ${fields.join("; ")}` : ""}${known}${rels}`;
    });
    push(`FULL CAST:\n${charBlocks.join("\n")}`);
  }

  // The story itself: every chapter with its summary (or opening text).
  const chapters = db
    .prepare("SELECT title, status, word_count, summary, body FROM chapters WHERE novel_id = ? ORDER BY position, id")
    .all(novelId) as OverviewChapterRow[];
  stats.chapters = chapters.length;
  if (chapters.length) {
    const story = chapters.map((c, i) => {
      const gist = c.summary ? clean(c.summary, 1200) : clean(c.body, 300);
      return `${i + 1}. "${c.title}" (${c.status}, ${c.word_count} words)${gist ? ` — ${gist}` : " (empty placeholder)"}`;
    });
    push(`STORY SO FAR (${chapters.length} chapters in order):\n${story.join("\n")}`);
  }

  const world = db
    .prepare("SELECT category, title, body FROM world_entries WHERE novel_id = ? ORDER BY category, title COLLATE NOCASE")
    .all(novelId) as OverviewWorldRow[];
  stats.world = world.length;
  if (world.length) {
    push(`WORLDBUILDING:\n${world.map((w) => `- ${w.title} (${w.category}): ${clean(w.body, 800) || "(no details yet)"}`).join("\n")}`);
  }

  const timeline = db
    .prepare("SELECT title, description, story_date_label FROM timeline_events WHERE novel_id = ? ORDER BY story_date_order, id")
    .all(novelId) as OverviewTimelineRow[];
  if (timeline.length) {
    push(
      `TIMELINE:\n${timeline
        .map(
          (e) =>
            `- ${e.story_date_label || "date unknown"}: ${clean(e.title, 200)}${e.description ? ` — ${clean(e.description, 400)}` : ""}`,
        )
        .join("\n")}`,
    );
  }

  if (budget > 0) {
    parts.push(
      "This is your complete view of the author's project, read live from their database. The author's approved canon and records are binding; open questions are for reference, not invention.",
    );
  }

  const text = parts.join("\n\n");
  return { text, stats: { ...stats, chars: text.length } };
}
