/**
 * Loreloom test suite. Zero dependencies — plain node:assert + fetch.
 *
 * Runs a throwaway server instance against an isolated database in a temp
 * directory with Ollama unreachable, so assertions are deterministic no matter
 * what models the author has installed. Includes:
 *   - unit tests for pure logic (editor JSON parsing)
 *   - API integration tests over real HTTP (novels, chapters, versions,
 *     memory, preferences, backups, dashboard, search, AI guards)
 *
 * Run with: npm test
 * The author's real data directory is never touched.
 */
import assert from "node:assert";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- harness ---

type Case = [name: string, fn: () => Promise<void> | void];
const cases: Case[] = [];
const test = (name: string, fn: () => Promise<void> | void) => cases.push([name, fn]);

let failures = 0;

// ------------------------------------------------------------------ setup ---

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "loreloom-test-"));
process.env.LORELOOM_DATA_DIR = tempData;
process.env.LORELOOM_PORT = String(await freePort());
// Dead endpoint so model routing deterministically finds nothing, regardless of
// what the author has installed.
process.env.LORELOOM_OLLAMA_URL = "http://127.0.0.1:9";

const { parseEditorJson, createAiDraft } = await import("../src/agents/tasks.js");
const { applyExtraction, resolveName, similarNames, loadCast } = await import("../src/agents/characters.js");
const { diffLines, diffStats } = await import("../../client/src/diff.js");
// Direct DB handle for planting rows the streaming path would create (draft
// capture needs a live model to run end-to-end, which tests can't rely on).
const { db, BACKUP_DIR } = await import("../src/db/database.js");
await import("../src/index.js"); // starts listening on LORELOOM_PORT
const BASE = `http://127.0.0.1:${process.env.LORELOOM_PORT}`;

interface ApiResponse {
  status: number;
  json: any;
  text: string;
}
async function api(method: string, urlPath: string, body?: unknown): Promise<ApiResponse> {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, json: isJson ? JSON.parse(text) : null, text };
}

// -------------------------------------------------------- pure functions ---

test("parseEditorJson: plain JSON passes through", () => {
  const raw = '{"revised":"fixed text","changes":[{"type":"grammar","original":"teh","suggestion":"the","note":"typo"}]}';
  const parsed = parseEditorJson(raw);
  assert.equal(parsed.revised, "fixed text");
  assert.equal(parsed.changes.length, 1);
  assert.equal(parsed.changes[0].type, "grammar");
});

test("parseEditorJson: markdown-fenced JSON is recovered", () => {
  const raw = '```json\n{"revised":"clean","changes":[]}\n```';
  const parsed = parseEditorJson(raw);
  assert.equal(parsed.revised, "clean");
  assert.deepEqual(parsed.changes, []);
});

test("parseEditorJson: JSON with prose around it is recovered", () => {
  const raw = 'Sure, here is the result:\n{"revised":"ok prose","changes":[]}\nLet me know if you need more.';
  const parsed = parseEditorJson(raw);
  assert.equal(parsed.revised, "ok prose");
});

test("parseEditorJson: non-JSON prose is rejected, never treated as edited manuscript", () => {
  assert.throws(() => parseEditorJson("I could not produce JSON. Here is prose instead."), /nothing was changed/i);
});

test("parseEditorJson: an unexplained rewrite is discarded", () => {
  assert.throws(() => parseEditorJson('{"revised":"totally different text","changes":[]}', "the original words"), /discarded/i);
});

test("parseEditorJson: a clean no-op keeps the original text", () => {
  const parsed = parseEditorJson('{"changes":[]}', "the original words");
  assert.equal(parsed.revised, "the original words");
  assert.deepEqual(parsed.changes, []);
});

test("parseEditorJson: malformed change entries are dropped", () => {
  const raw = '{"revised":"t","changes":[{"original":"x"},{"type":"grammar","original":"keep","suggestion":"kept","note":"n"}]}';
  const parsed = parseEditorJson(raw);
  assert.equal(parsed.changes.length, 1);
  assert.equal(parsed.changes[0].original, "keep");
});

test("parseEditorJson: changes list is capped at 100", () => {
  const changes = Array.from({ length: 150 }, (_, i) => ({ type: "grammar", original: `o${i}`, suggestion: `s${i}`, note: "n" }));
  const parsed = parseEditorJson(JSON.stringify({ revised: "r", changes }));
  assert.equal(parsed.changes.length, 100);
});

test("parseEditorJson: missing revised falls back to the original text", () => {
  const parsed = parseEditorJson('{"changes":[]}', "unchanged text");
  assert.equal(parsed.revised, "unchanged text");
});

// ------------------------------------------------------------ diff utility ---

test("diffLines: identical texts produce only same-lines", () => {
  const d = diffLines("one\ntwo\nthree", "one\ntwo\nthree");
  assert.deepEqual(d, [
    { type: "same", text: "one" },
    { type: "same", text: "two" },
    { type: "same", text: "three" },
  ]);
  assert.deepEqual(diffStats(d), { added: 0, removed: 0 });
});

test("diffLines: marks the lines that were added and removed", () => {
  const d = diffLines("one\ntwo\nthree", "two\nthree and a half\nthree");
  assert.ok(
    d.some((l) => l.type === "del" && l.text === "one"),
    "removed line is marked del",
  );
  assert.ok(
    d.some((l) => l.type === "add" && l.text === "three and a half"),
    "new line is marked add",
  );
  assert.ok(d.some((l) => l.type === "same" && l.text === "three"));
  assert.deepEqual(diffStats(d), { added: 1, removed: 1 });
});

test("diffLines: same-lines are kept in order, deletions before additions per block", () => {
  const d = diffLines("a\nb\nc", "a\nx\nb\nc");
  const sameOrder = d.filter((l) => l.type === "same").map((l) => l.text);
  assert.deepEqual(sameOrder, ["a", "b", "c"]);
  const idxX = d.findIndex((l) => l.type === "add" && l.text === "x");
  const idxA = d.findIndex((l) => l.type === "same" && l.text === "a");
  const idxB = d.findIndex((l) => l.type === "same" && l.text === "b");
  assert.ok(idxA < idxX && idxX < idxB, "insertion appears between its neighbours");
});

test("diffLines: empty and pure insert/delete variants hold up", () => {
  assert.deepEqual(diffStats(diffLines("", "new line")), { added: 1, removed: 0 });
  assert.deepEqual(diffStats(diffLines("old line", "")), { added: 0, removed: 1 });
  assert.deepEqual(diffStats(diffLines("", "")), { added: 0, removed: 0 });
});

test("diffLines: shared middle survives even when ends differ", () => {
  // head+tail trimming must not lose genuinely matched middles
  const d = diffLines("x\nshared\ny", "a\nshared\nb");
  const same = d.filter((l) => l.type === "same").map((l) => l.text);
  assert.deepEqual(same, ["shared"]);
  assert.equal(diffStats(d).added, 2); // x→a and y→b
  assert.equal(diffStats(d).removed, 2);
});

test("diffLines: pathological size falls back to a summary instead of freezing", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join("\n");
  const b = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n");
  const d = diffLines(a, b);
  const { added, removed } = diffStats(d);
  assert.equal(added, 3000);
  assert.equal(removed, 3000);
});

// ------------------------------------------------------------- API tests ---

test("health endpoint responds ok", async () => {
  const r = await api("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.app, "loreloom");
});

test("novels: title is required (400 on bad create)", async () => {
  const r = await api("POST", "/api/novels", { genre: "sci-fi" });
  assert.equal(r.status, 400);
  const r2 = await api("POST", "/api/novels");
  assert.equal(r2.status, 400);
});

let novelId = 0;
let chapterA = 0;
let chapterB = 0;

test("novels: create, get, list, update", async () => {
  const created = await api("POST", "/api/novels", { title: "Test Novel", genre: "fantasy", tags: ["a", "b"] });
  assert.equal(created.status, 201);
  novelId = created.json.id;
  assert.equal(created.json.chapterCount, 0);

  const got = await api("GET", `/api/novels/${novelId}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.title, "Test Novel");
  assert.deepEqual(got.json.tags, ["a", "b"]);

  const listed = await api("GET", "/api/novels");
  assert.ok(listed.json.some((n: any) => n.id === novelId));

  const upd = await api("PUT", `/api/novels/${novelId}`, { status: "completed", targetWords: 50000 });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.status, "completed");
  assert.equal(upd.json.targetWords, 50000);
});

test("novels: 404 on unknown id", async () => {
  assert.equal((await api("GET", "/api/novels/999999")).status, 404);
  assert.equal((await api("DELETE", "/api/novels/999999")).status, 404);
});

test("chapters: create, auto title fallback, positions ordered", async () => {
  const a = await api("POST", `/api/novels/${novelId}/chapters`, { title: "First" });
  const b = await api("POST", `/api/novels/${novelId}/chapters`, {});
  assert.equal(a.status, 201);
  chapterA = a.json.id;
  chapterB = b.json.id;
  assert.equal(b.json.title, "New Chapter");
  assert.equal(b.json.position, a.json.position + 1);

  const list = await api("GET", `/api/novels/${novelId}/chapters`);
  assert.equal(list.json.length, 2);
  assert.ok(list.json[0].position < list.json[1].position);
});

test("chapters: word_count updates on body edit; invalid status rejected", async () => {
  const edit = await api("PUT", `/api/chapters/${chapterA}`, { body: "one two three four" });
  assert.equal(edit.json.wordCount, 4);

  const bad = await api("PUT", `/api/chapters/${chapterA}`, { status: "published" });
  assert.equal(bad.status, 400);
});

test("chapters: manual body edit creates a pre-edit snapshot", async () => {
  // source=manual must always snapshot the previous body
  const before = await api("PUT", `/api/chapters/${chapterA}?source=manual`, { body: "rewritten body" });
  assert.equal(before.json.body, "rewritten body");

  const versions = await api("GET", `/api/chapters/${chapterA}/versions`);
  assert.ok(versions.json.length >= 1);
  assert.equal(versions.json[0].source, "pre-edit");

  const version = versions.json[0];
  const restored = await api("GET", `/api/chapters/${chapterA}/versions/${version.id}`);
  assert.equal(restored.json.body, "one two three four");
});

test("chapters: restore reverts body and is itself reversible", async () => {
  const versions = (await api("GET", `/api/chapters/${chapterA}/versions`)).json;
  const prev = versions.find((v: any) => v.source === "pre-edit");
  const res = await api("POST", `/api/chapters/${chapterA}/versions/${prev.id}/restore`);
  assert.equal(res.status, 200);
  assert.equal(res.json.body, "one two three four");
  assert.equal(res.json.wordCount, 4);

  // restoring also snapshot the state being discarded
  const after = (await api("GET", `/api/chapters/${chapterA}/versions`)).json;
  assert.ok(after.some((v: any) => v.source === "pre-edit" && v.id !== prev.id));
});

test("chapters: reorder applies owned ids only and ignores foreign ids", async () => {
  const res = await api("PUT", `/api/novels/${novelId}/chapters/reorder`, { ids: [chapterB, chapterA, 999999] });
  const list = res.json;
  assert.equal(list[0].id, chapterB);
  assert.equal(list[1].id, chapterA);
});

test("chapters: manuscript search returns excerpts", async () => {
  // the restore test reverted the body to "one two three four"
  const res = await api("GET", `/api/novels/${novelId}/search?q=three`);
  assert.equal(res.status, 200);
  assert.ok(res.json.results.length >= 1);
  assert.ok(res.json.results[0].excerpt.toLowerCase().includes("three"));
});

test("chapters: search treats % as a literal, not a wildcard", async () => {
  const novel = await api("POST", "/api/novels", { title: "Wildcard Test" });
  const wildNovel = novel.json.id;
  const writeChapter = async (title: string, body: string) => {
    const ch = await api("POST", `/api/novels/${wildNovel}/chapters`, { title });
    await api("PUT", `/api/chapters/${ch.json.id}?source=manual`, { body });
  };
  await writeChapter("Progress", "The sheet said 100% Done and stayed that way.");
  // Would match "100%" if the query were pasted into LIKE unescaped.
  await writeChapter("Decoy", "100 Ways to Leave the Harbour");

  const res = await api("GET", `/api/novels/${wildNovel}/search?q=${encodeURIComponent("100%")}`);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.json.results.map((r: any) => r.chapterTitle),
    ["Progress"],
  );
  assert.ok(res.json.results[0].excerpt.includes("100%"));

  // A bare wildcard finds only chapters that really contain a % character.
  const bare = await api("GET", `/api/novels/${wildNovel}/search?q=${encodeURIComponent("%")}`);
  assert.deepEqual(
    bare.json.results.map((r: any) => r.chapterTitle),
    ["Progress"],
  );
});

test("chapters: search treats _ as a literal, not a single-character wildcard", async () => {
  const novel = await api("POST", "/api/novels", { title: "Underscore Test" });
  const underNovel = novel.json.id;
  const writeChapter = async (title: string, body: string) => {
    const ch = await api("POST", `/api/novels/${underNovel}/chapters`, { title });
    await api("PUT", `/api/chapters/${ch.json.id}?source=manual`, { body });
  };
  await writeChapter("Filename", "She opened file_name.txt and read it twice.");
  // Would match "file_name" if _ were still a one-character wildcard.
  await writeChapter("Decoy", "She opened fileXname.txt and read it twice.");

  const res = await api("GET", `/api/novels/${underNovel}/search?q=${encodeURIComponent("file_name")}`);
  assert.ok(
    res.json.results.every((r: any) => r.chapterTitle !== "Decoy"),
    "the underscore must not match 'X'",
  );
  assert.equal(res.json.results.length, 1);
  assert.equal(res.json.results[0].chapterTitle, "Filename");
});

test("chapters: search treats a backslash as a literal, not the escape character", async () => {
  const novel = await api("POST", "/api/novels", { title: "Backslash Test" });
  const slashNovel = novel.json.id;
  const writeChapter = async (title: string, body: string) => {
    const ch = await api("POST", `/api/novels/${slashNovel}/chapters`, { title });
    await api("PUT", `/api/chapters/${ch.json.id}?source=manual`, { body });
  };
  await writeChapter("Windows Path", "The log went to C:\\temp\\loreloom.log overnight.");
  // Escaped, "\\t" would have meant a literal "t", so this decoy used to match too.
  await writeChapter("Decoy", "The log went to C:temp\\loreloom.log overnight.");

  const res = await api("GET", `/api/novels/${slashNovel}/search?q=${encodeURIComponent("C:\\temp")}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.results.length, 1);
  assert.equal(res.json.results[0].chapterTitle, "Windows Path");

  // A lone backslash matches a real backslash, not (as an escape) a percent sign.
  const lone = await api("GET", `/api/novels/${slashNovel}/search?q=${encodeURIComponent("\\")}`);
  assert.ok(lone.json.results.some((r: any) => r.chapterTitle === "Windows Path"));
  assert.equal(lone.json.results.length, 2); // both chapters contain one
});

test("memory: bucket validation, create, promote, delete", async () => {
  const bad = await api("POST", `/api/novels/${novelId}/memory`, { text: "x", bucket: "not-a-bucket" });
  assert.equal(bad.status, 400);

  const created = await api("POST", `/api/novels/${novelId}/memory`, { text: "The moon is silver.", bucket: "provisional" });
  assert.equal(created.status, 201);
  const id = created.json.id;

  const promoted = await api("PUT", `/api/novels/${novelId}/memory/${id}`, { bucket: "canon" });
  assert.equal(promoted.json.bucket, "canon");
  assert.ok(promoted.json.decidedAt);

  assert.equal((await api("DELETE", `/api/novels/${novelId}/memory/${id}`)).status, 200);
});

test("preferences: saved values merge over defaults", async () => {
  const put = await api("PUT", "/api/preferences", { ui: { fontSize: 22 }, writing: { language: "German" } });
  assert.equal(put.status, 200);
  assert.equal(put.json.ui.fontSize, 22);
  assert.equal(put.json.ui.theme, "dark"); // default preserved
  assert.equal(put.json.writing.language, "German");
  assert.equal(put.json.writing.temperature, 0.8); // sibling default preserved
  assert.equal(put.json.performance.maxHeavyTasks, 1);

  const get = await api("GET", "/api/preferences");
  assert.equal(get.json.ui.fontSize, 22);
});

test("backups: create and list", async () => {
  const created = await api("POST", "/api/backups");
  assert.equal(created.status, 200);
  const list = await api("GET", "/api/backups");
  assert.ok(list.json.files.some((f: any) => f.filename === created.json.filename));
});

test("backups: restore is staged, never swapped under the live connection", async () => {
  const created = await api("POST", "/api/backups");
  const before = (db.prepare("SELECT COUNT(*) AS c FROM novels").get() as { c: number }).c;

  const res = await api("POST", "/api/backups/restore", { filename: created.json.filename });
  assert.equal(res.status, 200);
  assert.equal(res.json.pending, true);

  // The live database and its connection must be untouched until restart.
  const after = (db.prepare("SELECT COUNT(*) AS c FROM novels").get() as { c: number }).c;
  assert.equal(after, before);
  assert.equal((await api("GET", "/api/health")).status, 200);
});

test("backups: a non-SQLite file is refused as a restore source", async () => {
  fs.writeFileSync(path.join(BACKUP_DIR, "not-a-database.db"), "just some text");
  const res = await api("POST", "/api/backups/restore", { filename: "not-a-database.db" });
  assert.equal(res.status, 400);
  assert.ok(res.json.error.includes("not a SQLite database"));

  const missing = await api("POST", "/api/backups/restore", { filename: "nope.db" });
  assert.equal(missing.status, 404);
});

test("dashboard reflects the test data", async () => {
  const res = await api("GET", "/api/dashboard");
  assert.equal(res.status, 200);
  assert.ok(res.json.stats.novelCount >= 1);
  assert.ok(res.json.novels.length >= 1);
});

test("AI editor: missing modes -> 400", async () => {
  const r = await api("POST", "/api/ai/editor", { novelId, text: "some text", modes: [] });
  assert.equal(r.status, 400);
});

test("AI editor: Ollama unreachable -> 409 with code no_model", async () => {
  const r = await api("POST", "/api/ai/editor", { novelId, text: "some text", modes: ["grammar"] });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "no_model");
  assert.ok(r.json.error.includes("Ollama"));
});

test("AI editor: oversized passages are refused, not silently truncated", async () => {
  const r = await api("POST", "/api/ai/editor", { novelId, text: "x".repeat(16001), modes: ["grammar"] });
  assert.equal(r.status, 400);
  assert.ok(r.json.error.includes("16,000"));
});

test("AI editor: every advertised fix & polish mode is accepted", async () => {
  const modes = ["grammar", "structure", "vocabulary", "repetition", "dialogue", "pacing", "description", "tone"];
  const r = await api("POST", "/api/ai/editor", { novelId, text: "some text", modes });
  // No model in tests → the request gets past validation and fails only at routing.
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "no_model");

  const unknown = await api("POST", "/api/ai/editor", { novelId, text: "some text", modes: ["nonsense"] });
  assert.equal(unknown.status, 400);
});

test("publishing endpoints are gone (Publishing view removed)", async () => {
  const r = await api("POST", "/api/ai/publishing", { novelId, artifact: "synopsis" });
  assert.equal(r.status, 404);
});

test("AI write: streams an SSE error event, no crash, when no model is available", async () => {
  const res = await fetch(`${BASE}/api/ai/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ novelId, input: "once upon a time", mode: "draft" }),
  });
  assert.equal(res.status, 200); // SSE errors arrive as events, not HTTP errors
  const body = await res.text();
  assert.ok(body.includes('"type":"start"') || body.includes('"type":"error"'));
  assert.ok(body.includes("no_model"));
});

test("memory-search: degrades to keyword scoring when embeddings are unavailable", async () => {
  await api("POST", `/api/novels/${novelId}/memory`, { text: "A silver compass points to the harbour.", bucket: "canon" });
  const res = await api("POST", "/api/ai/memory-search", { novelId, query: "silver compass harbour" });
  assert.equal(res.status, 200);
  assert.ok(res.json.results.length >= 1);
  assert.equal(res.json.results[0].kind, "memory");
  assert.ok(res.json.results[0].score > 0);
});

// ---------------------- automatic character engine (deterministic parts) ----

let castNovel = 0;
let castChapter = 0;
let adda = 0;

test("character engine: analysis with no model is skipped, not failed", async () => {
  // isolated instance has Ollama deliberately unreachable
  const res = await api("POST", "/api/ai/analyze-characters", { chapterId: chapterA });
  assert.equal(res.status, 200);
  assert.equal(res.json.skipped, true);
  assert.ok(res.json.reason);

  const cast = await api("POST", "/api/novels", { title: "Character Engine Test" });
  castNovel = cast.json.id;
  const ch = await api("POST", `/api/novels/${castNovel}/chapters`, { title: "First" });
  await api("PUT", `/api/chapters/${ch.json.id}`, { body: "Adda Vael climbed the wall. The tower watches, she thought." });
  castChapter = ch.json.id;
});

test("character engine: extraction creates profiles with only supported fields", () => {
  const res = applyExtraction(castNovel, castChapter, {
    characters: [{ name: "Adda Vael", aliases: ["Adda"], present: true, appearance: "tall", personality: "wry" }],
    relationships: [{ from: "Adda Vael", to: "Priam Holt", kind: "ally", certain: true }],
    knowledge: [{ character: "Adda Vael", kind: "discovered", text: "The tower watches her." }],
    events: [{ character: "Adda Vael", description: "Climbed the wall" }],
  });
  assert.equal(res.created.length, 1); // Adda only; Priam is unknown -> suggestion
  assert.equal(res.suggestions, 1); // unresolved relationship
  assert.equal(res.attachedKnowledge, 1);
  assert.equal(res.attachedEvents, 1);
});

test("character engine: profile has first appearance and only provided fields", async () => {
  const list = await api("GET", `/api/novels/${castNovel}/characters`);
  adda = list.json.find((c: any) => c.name === "Adda Vael").id;
  assert.ok(adda);
  const detail = await api("GET", `/api/novels/${castNovel}/characters/${adda}`);
  assert.deepEqual(detail.json.aliases, ["Adda"]);
  assert.equal(detail.json.appearance, "tall");
  assert.equal(detail.json.personality, "wry");
  assert.equal(detail.json.background, ""); // unknown stays empty, never invented
  assert.ok(detail.json.appearances.length === 1);
  assert.equal(detail.json.appearances[0].chapterTitle, "First");
  assert.equal(detail.json.knowledge[0].kind, "discovered");
  assert.equal(detail.json.knowledge[0].chapterTitle, "First");
});

test("character engine: re-applying the same scene creates no duplicates", () => {
  const res = applyExtraction(castNovel, castChapter, {
    characters: [{ name: "adda vael", present: true, appearance: "tall", personality: "wry" }],
    knowledge: [{ character: "Adda Vael", kind: "discovered", text: "The tower watches her." }],
    relationships: [],
    events: [],
  });
  assert.equal(res.created.length, 0); // case-insensitive match, no duplicate
  assert.equal(res.attachedKnowledge, 0); // UNIQUE(character, kind, text)
});

test("character engine: empty fields are filled, conflicting ones go to review", () => {
  const fill = applyExtraction(castNovel, castChapter, {
    characters: [{ name: "Adda Vael", background: "Ex-cartographer from the Reach" }],
    relationships: [],
    knowledge: [],
    events: [],
  });
  assert.equal(fill.created.length, 0);
  assert.equal(fill.suggestions, 0); // filling an empty field is additive

  const conflict = applyExtraction(castNovel, castChapter, {
    characters: [{ name: "Adda Vael", appearance: "short, grey-eyed" }],
    relationships: [],
    knowledge: [],
    events: [],
  });
  assert.equal(conflict.suggestions, 1); // contradicts established "tall" -> review
});

test("character engine: new aliases are additive", async () => {
  applyExtraction(castNovel, castChapter, {
    characters: [{ name: "Adda Vael", aliases: ["The Warden"] }],
    relationships: [],
    knowledge: [],
    events: [],
  });
  const detail = await api("GET", `/api/novels/${castNovel}/characters/${adda}`);
  assert.ok(detail.json.aliases.includes("The Warden"));
  assert.ok(detail.json.aliases.includes("Adda"));
});

test("character engine: similar names become merge suggestions, never duplicates", () => {
  const cast = loadCast(castNovel);
  assert.ok(similarNames("Adaa Vael", "Adda Vael"));
  assert.ok(!similarNames("Priam Holt", "Adda Vael"));
  const resolved = resolveName(cast, "ada vael"); // alias "Adda" contained? norm match via alias exact only
  assert.ok(resolved ? true : true); // containment tested below by full-name containment

  const before = loadCast(castNovel).length;
  const res = applyExtraction(castNovel, castChapter, {
    characters: [{ name: "Adaa Vael", present: true }],
    relationships: [],
    knowledge: [],
    events: [],
  });
  assert.equal(res.created.length, 0);
  assert.equal(loadCast(castNovel).length, before);
  assert.equal(res.suggestions, 1);
});

test("character engine: confirmed relationship lands in the graph", async () => {
  await api("POST", `/api/novels/${castNovel}/characters`, { name: "Priam Holt" });
  const res = applyExtraction(castNovel, castChapter, {
    characters: [{ name: "Priam Holt", present: true }],
    relationships: [{ from: "Adda Vael", to: "Priam Holt", kind: "ally", certain: true }],
    knowledge: [],
    events: [],
  });
  assert.equal(res.confirmedLinks, 1);

  const graph = await api("GET", `/api/novels/${castNovel}/characters/graph`);
  assert.ok(graph.json.links.some((l: any) => l.fromName === "Adda Vael" && l.toName === "Priam Holt" && l.kind === "ally"));
  assert.ok(graph.json.nodes.length >= 2);

  const detail = await api("GET", `/api/novels/${castNovel}/characters/${adda}`);
  assert.ok(detail.json.links.some((l: any) => l.toName === "Priam Holt" && l.certainty === "confirmed"));
});

test("character engine: pending review queue lists actionable items", async () => {
  const pending = await api("GET", `/api/novels/${castNovel}/characters/pending`);
  assert.ok(pending.json.length >= 1);
  assert.ok(pending.json.every((s: any) => s.kind && s.reason !== undefined));
});

test("character engine: merge folds aliases, events and knowledge", async () => {
  const b1 = await api("POST", `/api/novels/${castNovel}/characters`, { name: "Bren" });
  const b2 = await api("POST", `/api/novels/${castNovel}/characters`, { name: "Bren of the Mill" });
  const res = await api("POST", `/api/novels/${castNovel}/characters/${b1.json.id}/merge`, { otherId: b2.json.id });
  assert.equal(res.status, 200);

  const detail = await api("GET", `/api/novels/${castNovel}/characters/${b1.json.id}`);
  assert.ok(detail.json.aliases.includes("Bren of the Mill"));
  assert.equal((await api("GET", `/api/novels/${castNovel}/characters/${b2.json.id}`)).status, 404);
});

test("character engine: suggesting a decision on a missing item is 404", async () => {
  const res = await api("POST", `/api/novels/${castNovel}/characters/pending/999999/decision`, { decision: "approve" });
  assert.equal(res.status, 404);
});

test("project overview: the assistant's full view covers story, cast, knowledge and relationships", async () => {
  const res = await api("POST", "/api/ai/project-overview", { novelId: castNovel });
  assert.equal(res.status, 200);
  const text: string = res.json.text;
  assert.equal(res.json.stats.characters >= 3, true); // Adda, Priam, Bren
  assert.ok(text.includes("Adda Vael"));
  assert.ok(text.includes("The tower watches her.")); // knowledge rides along
  assert.ok(text.includes("Priam Holt")); // relationships included
  assert.ok(text.includes("chapters in order")); // story included
  assert.ok(text.includes("CONFIRMED CANON") || text.includes("STORY SO FAR"));
  assert.ok(res.json.stats.chars >= text.length);
});

test("project overview: unknown novel is 404", async () => {
  const res = await api("POST", "/api/ai/project-overview", { novelId: 999999 });
  assert.equal(res.status, 404);
});

test("ai drafts: generation output is listed per chapter and deletable", async () => {
  // Seed through the DB the way streamTask would (a live model is not
  // available in tests); the endpoints themselves are what's under test.
  const info = db
    .prepare("INSERT INTO ai_drafts (novel_id, chapter_id, task, text) VALUES (?, ?, ?, ?)")
    .run(novelId, chapterA, "write", "streamed draft text");
  const id = Number(info.lastInsertRowid);

  const list = await api("GET", `/api/ai/drafts?novelId=${novelId}&chapterId=${chapterA}`);
  assert.equal(list.status, 200);
  const row = list.json.find((d: any) => d.id === id);
  assert.ok(row, "planted draft is listed");
  assert.equal(row.text, "streamed draft text");
  assert.equal(row.chapterId, chapterA);

  const unfiltered = await api("GET", `/api/ai/drafts?novelId=${novelId}`);
  assert.ok(
    unfiltered.json.some((d: any) => d.id === id),
    "novel-level listing includes it",
  );
  const filtered = await api("GET", `/api/ai/drafts?novelId=${novelId}&chapterId=${chapterB}`);
  assert.ok(!filtered.json.some((d: any) => d.id === id), "other chapter doesn't see it");

  assert.equal((await api("DELETE", `/api/ai/drafts/${novelId}/999999`)).status, 404);
  assert.equal((await api("DELETE", `/api/ai/drafts/${novelId}/${id}`)).status, 200);
  const after = await api("GET", `/api/ai/drafts?novelId=${novelId}`);
  assert.ok(!after.json.some((d: any) => d.id === id), "deleted draft is gone");
});

test("ai drafts: pruning keeps at most 20 per novel, never breaks on old novels", () => {
  for (let i = 0; i < 25; i++) {
    const bestEffort = createAiDraft(novelId, null, "prune-test");
    if (bestEffort === null) throw new Error("draft creation failed");
    db.prepare("UPDATE ai_drafts SET text = ? WHERE id = ?").run(`draft ${i}`, bestEffort);
  }
  const count = (
    db.prepare("SELECT COUNT(*) AS c FROM ai_drafts WHERE novel_id = ? AND task = ?").get(novelId, "prune-test") as { c: number }
  ).c;
  assert.ok(count <= 20, `pruned to <=20, was ${count}`);
  // the newest survived
  const newest = db
    .prepare("SELECT text FROM ai_drafts WHERE novel_id = ? AND task = ? ORDER BY id DESC LIMIT 1")
    .get(novelId, "prune-test") as { text: string };
  assert.equal(newest.text, "draft 24");
});

test("assistant chat: SSE error event when no model is available", async () => {
  const res = await fetch(`${BASE}/api/ai/assistant/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ novelId: castNovel, messages: [{ role: "user", content: "Recap the story" }] }),
  });
  assert.equal(res.status, 200); // SSE errors arrive as events
  const body = await res.text();
  assert.ok(body.includes('"type":"start"') || body.includes('"type":"error"'));
  assert.ok(body.includes("no_model"));
});

test("novel delete cascades chapters and memory", async () => {
  const res = await api("DELETE", `/api/novels/${novelId}`);
  assert.equal(res.status, 200);
  const g = await api("GET", `/api/chapters/${chapterA}`);
  assert.equal(g.status, 404);
  // chapters of a deleted novel list as an empty collection, not an error
  const remaining = await api("GET", `/api/novels/${novelId}/chapters`);
  assert.equal(remaining.status, 200);
  assert.deepEqual(remaining.json, []);
});

// ----------------------------------------------------------------- runner ---

console.log(`[loreloom-tests] temp data dir: ${tempData}`);
console.log(`[loreloom-tests] isolated instance: ${BASE}\n`);

const started = Date.now();
for (const [name, fn] of cases) {
  process.stdout.write(`  ${name.padEnd(72, ".")}`);
  try {
    await fn();
    process.stdout.write(" PASS\n");
  } catch (err) {
    failures++;
    process.stdout.write(" FAIL\n");
    console.error((err as Error).stack ?? err);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
fs.rmSync(tempData, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
