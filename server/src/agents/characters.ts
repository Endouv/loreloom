/**
 * Automatic character detection engine.
 *
 * Reads a chapter through the local model, extracts characters, relationships,
 * knowledge and actions, then applies them to the database with deterministic
 * (non-AI) rules so the author never has to do the bookkeeping by hand.
 *
 * Guarantees, per the author's rules:
 *  - never invents characters or facts: only manuscript-supported data is kept;
 *  - never creates duplicate or near-duplicate profiles: similar names become
 *    review suggestions instead of automatic inserts;
 *  - never overwrites established information silently: conflicts go to the
 *    review queue;
 *  - keeps the source chapter of every extracted row;
 *  - re-running on an unchanged chapter is skipped via a body hash.
 */
import { db } from "../db/database.js";
import { readPrefs } from "../routes/misc.js";
import { chatOnce } from "../ollama/client.js";
import { routeModel } from "../ollama/routing.js";
import { runQueued } from "../ollama/queue.js";
import { THINKING_HINT, stripFences, logActivity } from "./tasks.js";
import { stringifyJson, parseJson } from "../util.js";
import crypto from "node:crypto";

export interface ExtractedCharacter {
  name: string;
  aliases?: string[];
  present?: boolean; // on scene (vs only mentioned)
  appearance?: string;
  personality?: string;
  background?: string;
  motivations?: string;
  notes?: string;
}
export interface ExtractedRelationship {
  from: string;
  to: string;
  kind: string;
  notes?: string;
  certain?: boolean;
}
export interface ExtractedKnowledge {
  character: string;
  kind: string; // discovered | met | witnessed | secret | unaware
  text: string;
}
export interface ExtractedEvent {
  character: string;
  description: string;
}
export interface CharacterExtraction {
  characters: ExtractedCharacter[];
  relationships: ExtractedRelationship[];
  knowledge: ExtractedKnowledge[];
  events: ExtractedEvent[];
}

const KNOWLEDGE_KINDS = ["discovered", "met", "witnessed", "secret", "unaware"];

// ------------------------------------------------------------- name matching

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * True when two different spellings plausibly refer to the same person
 * (short forms like "Cor" for "Corwin", single-letter typos). Such names are
 * never silently merged or duplicated - they become review suggestions.
 */
export function similarNames(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb || na === nb) return false;
  if (na.length < 3 || nb.length < 3) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Levenshtein distance <= 1 for short names, <= 2 for longer ones.
  const maxDist = na.length <= 6 ? 1 : 2;
  return levenshtein(na, nb) <= maxDist;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export interface CastEntry {
  id: number;
  name: string;
  aliases: string[];
}

export function loadCast(novelId: number): CastEntry[] {
  const rows = db.prepare("SELECT id, name, aliases FROM characters WHERE novel_id = ?").all(novelId) as {
    id: number;
    name: string;
    aliases: string;
  }[];
  return rows.map((r) => ({ id: r.id, name: r.name, aliases: parseJson(r.aliases, []) as string[] }));
}

/** Resolve a text reference to an existing character id, or null. */
export function resolveName(cast: CastEntry[], name: string): CastEntry | undefined {
  const n = norm(name);
  if (!n) return undefined;
  for (const c of cast) {
    if (norm(c.name) === n) return c;
    if ((c.aliases ?? []).some((a) => norm(a) === n)) return c;
  }
  // exact containment of a full known name, e.g. "Lady Adda Vael" for "Adda Vael"
  for (const c of cast) {
    const cn = norm(c.name);
    if (cn.length >= 6 && (n.includes(cn) || cn.includes(n))) return c;
  }
  return undefined;
}

/** Is this a near-miss of an existing name (possible same-person conflict)? */
export function isNameConflict(cast: CastEntry[], name: string): CastEntry | undefined {
  return cast.find((c) => similarNames(name, c.name) || (c.aliases ?? []).some((a) => similarNames(name, a)));
}

// ------------------------------------------------------------- extraction IO

const EXTRACTION_SYSTEM = `You are Loreloom's character-reading agent. From the chapter text, extract the characters that appear, their relationships, what they come to know, and notable actions. Rules:
- Characters are people who act, speak or are clearly present in the scene. Locations, organisations, creatures-that-are-merely-threats, objects and passing background mentions are NOT characters.
- Use each character's canonical name: the form the text itself uses most.
- Only record information the text explicitly supports. Never invent background, traits or relationships. If something is unknown, omit the field entirely - empty fields stay empty.
- Only mark relationships and knowledge the scene actually shows or states.
Return ONLY valid JSON (no markdown fences, no commentary) shaped exactly as:
{"characters":[{"name":string,"aliases":[string],"present":boolean,"appearance":string,"personality":string,"background":string,"motivations":string,"notes":string}],
"relationships":[{"from":string,"to":string,"kind":string,"notes":string,"certain":boolean}],
"knowledge":[{"character":string,"kind":string,"text":string}],
"events":[{"character":string,"description":string}]}
Relationship kind is one of: friend, family, rival, ally, enemy, mentor, ally-turned-rival, acquaintance, unknown. Knowledge kind is one of: discovered, met, witnessed, secret, unaware. "certain" is false when the interpretation is plausible but not explicitly confirmed. ${THINKING_HINT}`;

function parseExtraction(raw: string): CharacterExtraction | null {
  try {
    const parsed = JSON.parse(stripFences(raw)) as Partial<CharacterExtraction>;
    const characters = (Array.isArray(parsed.characters) ? parsed.characters : [])
      .filter((c) => c && typeof c.name === "string" && norm(c.name).length > 0)
      // First-person / structural artefacts of prose are not characters, even
      // when the model names them.
      .filter((c) => !/^(none|narrator|unknown character|unnamed character|the narrator|reader)$/.test(norm(c.name)))
      .slice(0, 40)
      .map((c) => ({
        name: c.name.trim(),
        aliases: Array.isArray(c.aliases) ? c.aliases.filter((a) => typeof a === "string" && a.trim()).slice(0, 8) : [],
        present: c.present !== false,
        appearance: typeof c.appearance === "string" ? c.appearance.slice(0, 2000) : "",
        personality: typeof c.personality === "string" ? c.personality.slice(0, 2000) : "",
        background: typeof c.background === "string" ? c.background.slice(0, 4000) : "",
        motivations: typeof c.motivations === "string" ? c.motivations.slice(0, 2000) : "",
        notes: typeof c.notes === "string" ? c.notes.slice(0, 2000) : "",
      }));
    const relationships = (Array.isArray(parsed.relationships) ? parsed.relationships : [])
      .filter((r) => r && typeof r.from === "string" && typeof r.to === "string" && norm(r.from) !== norm(r.to))
      .slice(0, 40)
      .map((r) => ({
        from: r.from.trim(),
        to: r.to.trim(),
        kind: (r.kind ?? "unknown").toString().slice(0, 60),
        notes: typeof r.notes === "string" ? r.notes.slice(0, 1000) : "",
        certain: r.certain !== false,
      }));
    const knowledge = (Array.isArray(parsed.knowledge) ? parsed.knowledge : [])
      .filter((k) => k && typeof k.character === "string" && typeof k.text === "string" && k.text.trim().length > 2)
      .slice(0, 40)
      .map((k) => ({
        character: k.character.trim(),
        kind: KNOWLEDGE_KINDS.includes(k.kind) ? k.kind : "discovered",
        text: k.text.trim().slice(0, 600),
      }));
    const events = (Array.isArray(parsed.events) ? parsed.events : [])
      .filter((e) => e && typeof e.character === "string" && typeof e.description === "string" && e.description.trim().length > 2)
      .slice(0, 40)
      .map((e) => ({ character: e.character.trim(), description: e.description.trim().slice(0, 600) }));
    return { characters, relationships, knowledge, events };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- application

/** Fields of a character profile the extractor may populate. */
const PROFILE_FIELDS: Array<[keyof ExtractedCharacter, string]> = [
  ["appearance", "appearance"],
  ["personality", "personality"],
  ["background", "background"],
  ["motivations", "motivations"],
];

export interface ApplyResult {
  created: number[];
  attachedKnowledge: number;
  attachedEvents: number;
  confirmedLinks: number;
  suggestions: number;
}

/**
 * Apply an extraction deterministically. `chapterId` may be null when applying
 * items manually approved from the review queue.
 */
export function applyExtraction(novelId: number, chapterId: number | null, ext: CharacterExtraction): ApplyResult {
  const result: ApplyResult = { created: [], attachedKnowledge: 0, attachedEvents: 0, confirmedLinks: 0, suggestions: 0 };
  const cast = loadCast(novelId);

  // Phase 1: character profiles.
  for (const c of ext.characters) {
    const existing = resolveName(cast, c.name);
    if (existing) {
      // Additive updates only: fill empty fields, extend aliases, never overwrite.
      applyProfileUpdates(novelId, existing.id, c, chapterId, result);
      continue;
    }
    const conflict = isNameConflict(cast, c.name);
    if (conflict) {
      enqueueSuggestion(
        novelId,
        chapterId,
        "merge",
        { existingId: conflict.id, existingName: conflict.name, newName: c.name, aliases: c.aliases ?? [] },
        `A new name "${c.name}" closely resembles "${conflict.name}" — same person, typo or a different character?`,
      );
      result.suggestions++;
      continue;
    }
    const info = db
      .prepare(
        `INSERT INTO characters (novel_id, name, aliases, personality, appearance, background, motivations, first_appearance_chapter_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        novelId,
        c.name,
        stringifyJson(c.aliases ?? []),
        c.personality ?? "",
        c.appearance ?? "",
        c.background ?? "",
        c.motivations ?? "",
        chapterId,
      );
    const id = Number(info.lastInsertRowid);
    cast.push({
      id,
      name: c.name,
      aliases: c.aliases ?? [],
    });
    result.created.push(id);
    if (chapterId) recordAppearance(novelId, id, chapterId, c.present === false ? "mentioned" : "onscene");
  }

  // Second pass: references that may now resolve to just-created characters.
  castRefresh(cast, novelId);

  for (const k of ext.knowledge) {
    const who = resolveName(cast, k.character);
    if (!who) {
      enqueueSuggestion(
        novelId,
        chapterId,
        "update",
        { unresolvedCharacter: k.character, item: { kind: "knowledge", data: k } },
        `Knowledge mention references "${k.character}", who is not in the cast.`,
      );
      result.suggestions++;
      continue;
    }
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO character_knowledge (novel_id, character_id, chapter_id, kind, text, source) VALUES (?, ?, ?, ?, ?, 'ai')`,
      )
      .run(novelId, who.id, chapterId, k.kind, k.text);
    if (info.changes) result.attachedKnowledge++;
  }

  for (const e of ext.events) {
    const who = resolveName(cast, e.character);
    if (!who) {
      enqueueSuggestion(
        novelId,
        chapterId,
        "update",
        { unresolvedCharacter: e.character, item: { kind: "event", data: e } },
        `Action references "${e.character}", who is not in the cast.`,
      );
      result.suggestions++;
      continue;
    }
    db.prepare(`INSERT INTO character_events (character_id, description, chapter_id, source) VALUES (?, ?, ?, 'ai')`).run(
      who.id,
      e.description,
      chapterId,
    );
    result.attachedEvents++;
  }

  for (const r of ext.relationships) {
    const from = resolveName(cast, r.from);
    const to = resolveName(cast, r.to);
    if (!from || !to) {
      enqueueSuggestion(
        novelId,
        chapterId,
        "relationship",
        { rel: r },
        `Relationship references an unknown name (${!from ? r.from : r.to}).`,
      );
      result.suggestions++;
      continue;
    }
    applyRelationship(novelId, chapterId, from, to, r, result);
  }

  return result;
}

// keep the local cast list in sync after inserts made elsewhere (approvals, merges)
function castRefresh(cast: CastEntry[], novelId: number) {
  cast.length = 0;
  cast.push(...loadCast(novelId));
}

function recordAppearance(novelId: number, characterId: number, chapterId: number, kind: string) {
  db.prepare(`INSERT OR IGNORE INTO character_appearances (novel_id, character_id, chapter_id, kind) VALUES (?, ?, ?, ?)`).run(
    novelId,
    characterId,
    chapterId,
    kind,
  );
}

/** Fill empty profile fields and append unseen aliases; conflicts become suggestions. */
function applyProfileUpdates(novelId: number, characterId: number, c: ExtractedCharacter, chapterId: number | null, result: ApplyResult) {
  if (chapterId) recordAppearance(novelId, characterId, chapterId, c.present === false ? "mentioned" : "onscene");
  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(characterId) as
    { id: number; aliases: string; appearance: string; personality: string; background: string; motivations: string } | undefined;
  if (!row) return;

  for (const [extKey, column] of PROFILE_FIELDS) {
    const proposed = (c[extKey] as string | undefined) ?? "";
    const existing = (row as unknown as Record<string, string>)[column] ?? "";
    if (!proposed.trim() || existing.trim() === proposed.trim()) continue;
    if (!existing.trim()) {
      db.prepare(`UPDATE characters SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`).run(proposed.trim(), characterId);
    } else {
      enqueueSuggestion(
        novelId,
        chapterId,
        "update",
        { characterId, field: column, existing: existing.slice(0, 2000), proposed: proposed.slice(0, 2000) },
        `Extracted "${column}" differs from the established record for ${c.name}.`,
      );
      result.suggestions++;
    }
  }

  // Aliases are additive and safe.
  const aliases = parseJson(row.aliases, []) as string[];
  const currentLower = new Set(aliases.map(norm));
  if (c.name) currentLower.add(norm(c.name));
  const newOnes = (c.aliases ?? []).filter((a) => a && a.trim() && !currentLower.has(norm(a)));
  if (newOnes.length) {
    db.prepare("UPDATE characters SET aliases = ?, updated_at = datetime('now') WHERE id = ?").run(
      stringifyJson([...aliases, ...newOnes.map((a) => a.trim())]),
      characterId,
    );
  }
}

function applyRelationship(
  novelId: number,
  chapterId: number | null,
  from: CastEntry,
  to: CastEntry,
  r: ExtractedRelationship,
  result: ApplyResult,
) {
  const existing = db
    .prepare(
      `SELECT id, kind, certainty FROM character_links
       WHERE (from_character_id = ? AND to_character_id = ?) OR (from_character_id = ? AND to_character_id = ?)`,
    )
    .get(from.id, to.id, to.id, from.id) as { id: number; kind: string; certainty: string } | undefined;

  if (existing) {
    if (existing.kind && existing.kind !== r.kind) {
      enqueueSuggestion(
        novelId,
        chapterId,
        "relationship",
        {
          fromId: from.id,
          fromName: from.name,
          toId: to.id,
          toName: to.name,
          existingKind: existing.kind,
          kind: r.kind,
          notes: r.notes ?? "",
        },
        `Relationship between ${from.name} and ${to.name} was "${existing.kind}" but the chapter suggests "${r.kind}".`,
      );
      result.suggestions++;
    }
    return; // already recorded; nothing to change
  }

  if (r.certain === false) {
    enqueueSuggestion(
      novelId,
      chapterId,
      "relationship",
      { fromId: from.id, fromName: from.name, toId: to.id, toName: to.name, kind: r.kind, notes: r.notes ?? "" },
      `Interpreted as "${r.kind}" but not explicitly confirmed by the text.`,
    );
    result.suggestions++;
    return;
  }

  db.prepare(
    `INSERT INTO character_links (novel_id, from_character_id, to_character_id, kind, notes, chapter_id, certainty) VALUES (?, ?, ?, ?, ?, ?, 'confirmed')`,
  ).run(novelId, from.id, to.id, r.kind, r.notes ?? "", chapterId);
  result.confirmedLinks++;
}

// ------------------------------------------------------------- review queue

export function enqueueSuggestion(novelId: number, chapterId: number | null, kind: string, payload: unknown, reason = "") {
  db.prepare(`INSERT INTO character_suggestions (novel_id, chapter_id, kind, payload, reason) VALUES (?, ?, ?, ?, ?)`).run(
    novelId,
    chapterId,
    kind,
    stringifyJson(payload),
    reason,
  );
}

/** Payload shapes written by enqueueSuggestion() for each review-queue kind. */
interface SuggestionPayload {
  // new_character
  name?: string;
  aliases?: string[];
  personality?: string;
  appearance?: string;
  background?: string;
  motivations?: string;
  relationships?: ExtractedRelationship[];
  knowledge?: ExtractedKnowledge[];
  events?: ExtractedEvent[];
  // update — a profile field that conflicts with the established record
  characterId?: number;
  field?: string;
  existing?: string;
  proposed?: string;
  // update — a knowledge/event item whose character is not in the cast yet
  unresolvedCharacter?: string;
  item?: { kind?: "knowledge" | "event"; data?: unknown };
  // relationship
  rel?: ExtractedRelationship;
  // merge — a name that looks like an existing character
  existingId?: number;
  existingName?: string;
  newName?: string;
}

/** Apply an approved suggestion to the database. */
export function applySuggestion(row: {
  id: number;
  novel_id: number;
  chapter_id: number | null;
  kind: string;
  payload: string;
}): ApplyResult {
  const payload = parseJson<SuggestionPayload>(row.payload, {});
  const result: ApplyResult = { created: [], attachedKnowledge: 0, attachedEvents: 0, confirmedLinks: 0, suggestions: 0 };

  if (row.kind === "new_character") {
    const cast = loadCast(row.novel_id);
    const existing = resolveName(cast, payload.name ?? "");
    if (!existing) {
      const info = db
        .prepare(
          `INSERT INTO characters (novel_id, name, aliases, personality, appearance, background, motivations, first_appearance_chapter_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.novel_id,
          String(payload.name ?? "Unnamed").trim(),
          stringifyJson(payload.aliases ?? []),
          payload.personality ?? "",
          payload.appearance ?? "",
          payload.background ?? "",
          payload.motivations ?? "",
          row.chapter_id,
        );
      result.created.push(Number(info.lastInsertRowid));
      castRefresh(cast, row.novel_id);
    } else {
      castRefresh(cast, row.novel_id);
    }
    // Attach leftover facts that referenced this name.
    const leftover: CharacterExtraction = {
      characters: [],
      relationships: payload.relationships ?? [],
      knowledge: payload.knowledge ?? [],
      events: payload.events ?? [],
    };
    const applied = applyExtraction(row.novel_id, row.chapter_id, leftover);
    applyResultInto(result, applied);
  } else if (row.kind === "update") {
    const field = payload.field ?? "";
    // Column names cannot be bound as parameters, so the name is validated as
    // a plain identifier before it reaches the statement.
    if (payload.characterId && /^[a-z][a-z0-9_]*$/.test(field)) {
      // Author approved, so this overwrite is sanctioned.
      db.prepare(`UPDATE characters SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(
        payload.proposed ?? "",
        payload.characterId,
      );
    } else if (payload.item) {
      const applied = applyExtraction(row.novel_id, row.chapter_id, {
        characters: [],
        relationships: [],
        knowledge: payload.item.kind === "knowledge" && payload.item.data ? [payload.item.data as ExtractedKnowledge] : [],
        events: payload.item.kind === "event" && payload.item.data ? [payload.item.data as ExtractedEvent] : [],
      });
      applyResultInto(result, applied);
    }
  } else if (row.kind === "relationship") {
    const applied = applyExtraction(row.novel_id, row.chapter_id, {
      characters: [],
      relationships: payload.rel ? [payload.rel] : [],
      knowledge: [],
      events: [],
    });
    applyResultInto(result, applied);
  } else if (row.kind === "merge") {
    if (payload.newName) {
      const cast = loadCast(row.novel_id);
      const resolved = resolveName(cast, payload.newName);
      if (!resolved && payload.existingId) {
        // The author decided this is the same person: record the name as an alias.
        const target = db.prepare("SELECT aliases FROM characters WHERE id = ?").get(payload.existingId) as { aliases: string } | undefined;
        if (target) {
          const aliases = parseJson(target.aliases, []) as string[];
          if (!aliases.includes(payload.newName)) {
            db.prepare("UPDATE characters SET aliases = ? WHERE id = ?").run(
              stringifyJson([...aliases, payload.newName]),
              payload.existingId,
            );
          }
        }
      }
    }
  }

  db.prepare("UPDATE character_suggestions SET status = 'approved', decided_at = datetime('now') WHERE id = ?").run(row.id);
  return result;
}

function applyResultInto(into: ApplyResult, from: ApplyResult) {
  into.created.push(...from.created);
  into.attachedKnowledge += from.attachedKnowledge;
  into.attachedEvents += from.attachedEvents;
  into.confirmedLinks += from.confirmedLinks;
  into.suggestions += from.suggestions;
}

/** Merge two character profiles (author-directed correction). `keepId` survives. */
export function mergeCharacters(keepId: number, dropId: number): void {
  if (keepId === dropId) throw Object.assign(new Error("Cannot merge a character with itself"), { status: 400 });
  const keep = db.prepare("SELECT * FROM characters WHERE id = ?").get(keepId) as
    { id: number; novel_id: number; name: string; aliases: string; first_appearance_chapter_id: number | null } | undefined;
  const drop = db.prepare("SELECT * FROM characters WHERE id = ?").get(dropId) as
    { id: number; novel_id: number; name: string; aliases: string; first_appearance_chapter_id: number | null } | undefined;
  if (!keep || !drop || keep.novel_id !== drop.novel_id) throw Object.assign(new Error("Character not found"), { status: 404 });

  const tx = db.transaction(() => {
    // aliases fold together; the dropped profile's canonical name survives as an alias
    const keepAliases = parseJson(keep.aliases, []) as string[];
    const dropAliases = parseJson(drop.aliases, []) as string[];
    const folded = [...keepAliases];
    for (const a of dropAliases) if (!folded.includes(a)) folded.push(a);
    if (!folded.includes(drop.name)) folded.push(drop.name);
    db.prepare("UPDATE characters SET aliases = ? WHERE id = ?").run(stringifyJson(folded), keepId);

    db.prepare("UPDATE character_events SET character_id = ? WHERE character_id = ?").run(keepId, dropId);
    // knowledge has a UNIQUE(character, kind, text) constraint, so move via copy+drop
    db.prepare(
      `INSERT OR IGNORE INTO character_knowledge (novel_id, character_id, chapter_id, kind, text, source, created_at)
       SELECT novel_id, ?, chapter_id, kind, text, source, created_at FROM character_knowledge WHERE character_id = ?`,
    ).run(keepId, dropId);
    db.prepare(
      "INSERT OR IGNORE INTO character_appearances (novel_id, character_id, chapter_id, kind) SELECT novel_id, ?, chapter_id, kind FROM character_appearances WHERE character_id = ?",
    ).run(keepId, dropId);
    db.prepare("UPDATE character_links SET from_character_id = ? WHERE from_character_id = ?").run(keepId, dropId);
    db.prepare("UPDATE character_links SET to_character_id = ? WHERE to_character_id = ?").run(keepId, dropId);
    db.prepare("DELETE FROM character_links WHERE from_character_id = to_character_id").run();
    if (keep.first_appearance_chapter_id == null && drop.first_appearance_chapter_id != null) {
      db.prepare("UPDATE characters SET first_appearance_chapter_id = ? WHERE id = ?").run(drop.first_appearance_chapter_id, keepId);
    }
    db.prepare("DELETE FROM characters WHERE id = ?").run(dropId);
  });
  tx();
  // keep only the earliest appearance chapter as "first appearance" fallback
  const first = db
    .prepare(
      `SELECT a.chapter_id FROM character_appearances a
       JOIN chapters c ON c.id = a.chapter_id
       WHERE a.character_id = ? ORDER BY c.position, c.id LIMIT 1`,
    )
    .get(keepId) as { chapter_id: number } | undefined;
  if (first && keep.first_appearance_chapter_id == null) {
    db.prepare("UPDATE characters SET first_appearance_chapter_id = ? WHERE id = ?").run(first.chapter_id, keepId);
  }
  db.prepare("UPDATE novels SET updated_at = datetime('now') WHERE id = ?").run(keep.novel_id);
}

// ------------------------------------------------------------- pipeline

/**
 * Read a chapter and update the character database.
 * Returns { skipped: true } when the chapter body is unchanged since the last
 * run, or when no model is available (nothing else fails).
 */
export async function analyzeChapterCharacters(
  chapterId: number,
  force = false,
): Promise<{ skipped: boolean; reason?: string; result?: ApplyResult; model?: string }> {
  const chapter = db.prepare("SELECT id, novel_id, body FROM chapters WHERE id = ?").get(chapterId) as
    { id: number; novel_id: number; body: string } | undefined;
  if (!chapter) throw Object.assign(new Error("Chapter not found"), { status: 404 });
  const body = chapter.body.trim();
  if (!body) return { skipped: true, reason: "empty chapter" };

  const hash = sha1(body);
  const prior = db.prepare("SELECT body_hash FROM chapter_analysis WHERE chapter_id = ?").get(chapterId) as
    { body_hash: string } | undefined;
  if (prior && prior.body_hash === hash && !force) return { skipped: true, reason: "unchanged since last analysis" };

  // Re-analysis of an edited chapter: remove what the previous pass concluded
  // for THIS chapter so conclusions never go stale. Author-created rows have a
  // different source / NULL chapter and are never touched.
  if (prior || force) purgeChapterExtractions(chapterId);

  const decision = await routeModel("light");
  if (!decision.model) return { skipped: true, reason: "no model installed" };
  const model = decision.model;

  const cast = loadCast(chapter.novel_id);
  const roster = cast.map((c) => `- ${c.name}${c.aliases.length ? ` (also: ${c.aliases.join(", ")})` : ""}`).join("\n") || "(none yet)";

  const started = Date.now();
  let extraction: CharacterExtraction | null;
  try {
    extraction = await runQueued("light", async () => {
      const raw = await chatOnce({
        model,
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM },
          {
            role: "user",
            content: `CAST ALREADY KNOWN:\n${roster}\n\nCHAPTER TEXT:\n${body.slice(0, 12000)}`,
          },
        ],
        temperature: 0.2,
      });
      return parseExtraction(raw);
    });
  } catch (err) {
    logActivity(chapter.novel_id, "characters:analyze", null, "light", Date.now() - started, false, (err as Error).message);
    throw err;
  }

  if (!extraction) {
    // Unreadable model output: nothing is stored and the chapter will be
    // re-analysed on the next pass instead of being cached as "done".
    logActivity(chapter.novel_id, "characters:analyze", model, "light", Date.now() - started, false, "unreadable extraction");
    return { skipped: false, reason: "unreadable model output", model };
  }

  const result = applyExtraction(chapter.novel_id, chapterId, extraction);
  db.prepare(
    "INSERT OR REPLACE INTO chapter_analysis (chapter_id, novel_id, body_hash, analyzed_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(chapterId, chapter.novel_id, hash);
  logActivity(
    chapter.novel_id,
    "characters:analyze",
    model,
    "light",
    Date.now() - started,
    true,
    `${result.created.length} new, ${result.suggestions} review items`,
  );
  return { skipped: false, result, model };
}

/**
 * Remove rows the previous automated pass on this chapter concluded, so an
 * edited chapter is re-read from scratch. Author-created rows (source='author'
 * or created via PUT) carry a different source and are never touched.
 */
export function purgeChapterExtractions(chapterId: number): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM character_appearances WHERE chapter_id = ?").run(chapterId);
    db.prepare("DELETE FROM character_knowledge WHERE chapter_id = ? AND source = 'ai'").run(chapterId);
    db.prepare("DELETE FROM character_events WHERE chapter_id = ? AND source = 'ai'").run(chapterId);
    db.prepare("DELETE FROM character_links WHERE chapter_id = ?").run(chapterId);
    db.prepare("DELETE FROM character_suggestions WHERE chapter_id = ? AND status = 'pending'").run(chapterId);
    db.prepare("DELETE FROM chapter_analysis WHERE chapter_id = ?").run(chapterId);
  });
  tx();
}

/** Fire-and-forget auto analysis after chapter create/edit; never throws. */
export function autoAnalyzeChapter(chapterId: number): void {
  const prefs = readPrefs();
  const memory = (prefs.memory ?? {}) as Record<string, unknown>;
  if (memory.autoDetectCharacters === false) return;
  void analyzeChapterCharacters(chapterId).catch(() => {
    /* analysis is best-effort; the author is never interrupted by it */
  });
}

function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}
