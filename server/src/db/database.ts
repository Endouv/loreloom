import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Data location: <repo>/server/data by default. Env override exists mainly for
// tests, which run against a throwaway database in a temp directory.
export const DATA_DIR = process.env.LORELOOM_DATA_DIR
  ? path.resolve(process.env.LORELOOM_DATA_DIR)
  : path.join(__dirname, "..", "..", "data");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const DB_PATH = path.join(DATA_DIR, "loreloom.db");

export const db = (() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.pragma("synchronous = NORMAL");
  migrate(d);
  backupOnStart(d);
  return d;
})();

function migrate(d: Database.Database) {
  const version: number = (d.pragma("user_version", { simple: true }) as number) ?? 0;
  if (version < 1) {

  d.exec(`
    CREATE TABLE IF NOT EXISTS novels (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      genre TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      target_words INTEGER DEFAULT 0,
      synopsis TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      position INTEGER NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      word_count INTEGER DEFAULT 0,
      summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chapters_novel ON chapters(novel_id, position);

    CREATE TABLE IF NOT EXISTS chapter_versions (
      id INTEGER PRIMARY KEY,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      title TEXT DEFAULT '',
      source TEXT DEFAULT 'autosave',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapter_id, created_at);

    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      personality TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      background TEXT DEFAULT '',
      motivations TEXT DEFAULT '',
      strengths TEXT DEFAULT '',
      weaknesses TEXT DEFAULT '',
      story_status TEXT DEFAULT '',
      dev_notes TEXT DEFAULT '',
      free_notes TEXT DEFAULT '',
      first_appearance_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS character_links (
      id INTEGER PRIMARY KEY,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      from_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      to_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      kind TEXT DEFAULT '',
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS character_events (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS world_entries (
      id INTEGER PRIMARY KEY,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      fields TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS timeline_events (
      id INTEGER PRIMARY KEY,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      story_date_label TEXT DEFAULT '',
      story_date_order REAL NOT NULL DEFAULT 0,
      kind TEXT DEFAULT 'event',
      character_ids TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      bucket TEXT NOT NULL DEFAULT 'provisional',
      source TEXT NOT NULL DEFAULT 'author',
      chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      category TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS embeddings_chunks (
      id INTEGER PRIMARY KEY,
      novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      item_id INTEGER,
      chapter_id INTEGER,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding BLOB,
      model TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_novel ON embeddings_chunks(novel_id, kind);

    CREATE TABLE IF NOT EXISTS preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT OR IGNORE INTO preferences (id, json) VALUES (1, '{}');

    CREATE TABLE IF NOT EXISTS agent_activity (
      id INTEGER PRIMARY KEY,
      novel_id INTEGER,
      task TEXT NOT NULL,
      model TEXT,
      tier TEXT,
      latency_ms INTEGER,
      ok INTEGER NOT NULL DEFAULT 1,
      detail TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  d.pragma("user_version = 1");
  }

  // ---- v2: automatic character detection (appearances, knowledge, review queue) ----
  if (version < 2) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS chapter_analysis (
        chapter_id INTEGER PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
        novel_id INTEGER NOT NULL,
        body_hash TEXT NOT NULL,
        analyzed_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS character_appearances (
        id INTEGER PRIMARY KEY,
        novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'mentioned',
        UNIQUE (character_id, chapter_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_appearances_novel ON character_appearances(novel_id);
      CREATE INDEX IF NOT EXISTS idx_appearances_char ON character_appearances(character_id);

      CREATE TABLE IF NOT EXISTS character_knowledge (
        id INTEGER PRIMARY KEY,
        novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'discovered',
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'ai',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE (character_id, kind, text)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_novel ON character_knowledge(novel_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_char ON character_knowledge(character_id);

      CREATE TABLE IF NOT EXISTS character_suggestions (
        id INTEGER PRIMARY KEY,
        novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
        chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now')),
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_suggestions_novel ON character_suggestions(novel_id, status);

      ALTER TABLE character_links ADD COLUMN chapter_id INTEGER;
      ALTER TABLE character_links ADD COLUMN certainty TEXT NOT NULL DEFAULT 'confirmed';
      ALTER TABLE character_events ADD COLUMN source TEXT DEFAULT 'author';
    `);
    d.pragma("user_version = 2");
  }

  // ---- v3: AI output draft protection ----
  if (version < 3) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS ai_drafts (
        id INTEGER PRIMARY KEY,
        novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
        chapter_id INTEGER REFERENCES chapters(id) ON DELETE CASCADE,
        task TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_novel ON ai_drafts(novel_id, chapter_id);
    `);
    d.pragma("user_version = 3");
  }
}

function backupOnStart(live: Database.Database) {
  try {
    const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort() : [];
    while (files.length >= 10) {
      const oldest = files.shift();
      if (oldest) fs.rmSync(path.join(BACKUP_DIR, oldest));
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // The sqlite backup API yields a consistent snapshot, even with WAL active.
    // It resolves asynchronously; a rejection would otherwise escape this
    // try/catch and become an unhandled rejection.
    void live
      .backup(path.join(BACKUP_DIR, `loreloom-${stamp}.db`))
      .catch((err) => console.error("[loreloom] startup backup failed:", err));
  } catch (err) {
    // Backups must never block startup.
    console.error("[loreloom] startup backup failed:", err);
  }
}

/** Restore a backup file over the live database (server must be restarted after). */
export function restoreFromBackup(filename: string) {
  const src = path.join(BACKUP_DIR, path.basename(filename));
  if (!fs.existsSync(src)) throw new Error("Backup not found: " + filename);
  for (const suffix of ["", "-wal", "-shm"]) {
    const live = DB_PATH + suffix;
    if (fs.existsSync(live)) fs.rmSync(live);
  }
  fs.copyFileSync(src, DB_PATH);
}
