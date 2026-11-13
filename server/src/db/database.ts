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
/** Restore requested from the UI is staged here and swapped in at next startup. */
const PENDING_RESTORE_PATH = DB_PATH + ".restore-pending";
const MAX_BACKUPS = 10;
/** Keep in step with the last `d.pragma("user_version = N")` in migrate(). */
const LATEST_SCHEMA_VERSION = 3;
const SQLITE_MAGIC = "SQLite format 3\u0000";

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function badRequest(message: string): Error {
  // The DB layer must not import util.ts (which imports this module), so the
  // HTTP status is attached here rather than through util.badRequest.
  return Object.assign(new Error(message), { status: 400 });
}

export const db = (() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // Applies a restore staged by an earlier session, before anything opens the
  // database — so the swap never happens underneath a live connection.
  applyPendingRestore();
  // Snapshot the pre-migration database *before* any schema change runs. This
  // used to happen after migrate(), which meant a bad migration had no way
  // back to the state it replaced.
  backupBeforeMigration();
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

function backupFiles(): string[] {
  return fs.existsSync(BACKUP_DIR)
    ? fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith(".db"))
        .sort()
    : [];
}

/** Keep the rolling window at MAX_BACKUPS files, including the one about to be written. */
function pruneBackups(): void {
  const files = backupFiles();
  while (files.length >= MAX_BACKUPS) {
    const oldest = files.shift();
    if (oldest) fs.rmSync(path.join(BACKUP_DIR, oldest));
  }
}

function backupOnStart(live: Database.Database) {
  try {
    pruneBackups();
    // The sqlite backup API yields a consistent snapshot, even with WAL active.
    // It resolves asynchronously; a rejection would otherwise escape this
    // try/catch and become an unhandled rejection.
    void live
      .backup(path.join(BACKUP_DIR, `loreloom-${timestamp()}.db`))
      .catch((err) => console.error("[loreloom] startup backup failed:", err));
  } catch (err) {
    // Backups must never block startup.
    console.error("[loreloom] startup backup failed:", err);
  }
}

/**
 * Copy the database aside before a schema migration runs. Uses a short-lived
 * connection to fold the WAL into the main file first, so a plain file copy is
 * a complete snapshot; nothing else is writing at this point in startup.
 */
function backupBeforeMigration(): string | null {
  if (!fs.existsSync(DB_PATH)) return null; // brand-new install: nothing to protect
  let needsMigration = false;
  try {
    const probe = new Database(DB_PATH);
    try {
      const version = (probe.pragma("user_version", { simple: true }) as number) ?? 0;
      needsMigration = version > 0 && version < LATEST_SCHEMA_VERSION;
      if (needsMigration) probe.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      probe.close();
    }
  } catch (err) {
    console.error("[loreloom] could not inspect schema version before migration:", err);
    return null;
  }
  if (!needsMigration) return null;
  try {
    pruneBackups();
    const dest = path.join(BACKUP_DIR, `loreloom-pre-migration-${timestamp()}.db`);
    fs.copyFileSync(DB_PATH, dest);
    console.log(`[loreloom] pre-migration backup written: ${path.basename(dest)}`);
    return dest;
  } catch (err) {
    // Never block startup on a backup, but say so loudly.
    console.error("[loreloom] pre-migration backup failed:", err);
    return null;
  }
}

function assertSqliteFile(file: string): void {
  const head = Buffer.alloc(SQLITE_MAGIC.length);
  const fd = fs.openSync(file, "r");
  try {
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read !== head.length || head.toString("latin1") !== SQLITE_MAGIC) {
      throw badRequest(`${path.basename(file)} is not a SQLite database, so it cannot be restored.`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Restore a backup file: validate it, then stage it next to the live database.
 * It is swapped in by applyPendingRestore() at the next startup. Replacing the
 * live file now would unlink the open connection's inode and silently discard
 * every write made before the author restarts.
 */
export function stageRestoreFromBackup(filename: string): { staged: boolean; pendingFile: string } {
  const src = path.join(BACKUP_DIR, path.basename(filename));
  if (!fs.existsSync(src)) {
    throw Object.assign(new Error("Backup not found: " + filename), { status: 404 });
  }
  assertSqliteFile(src);
  const partial = PENDING_RESTORE_PATH + ".partial";
  fs.copyFileSync(src, partial);
  // Rename so a half-written staging file can never be picked up at startup.
  fs.renameSync(partial, PENDING_RESTORE_PATH);
  return { staged: true, pendingFile: path.basename(PENDING_RESTORE_PATH) };
}

/**
 * Apply a staged restore. Runs before the app opens the database, so no
 * connection is holding the live files. The database being replaced is
 * snapshotted first, which makes even a restore reversible.
 */
function applyPendingRestore(): void {
  if (!fs.existsSync(PENDING_RESTORE_PATH)) return;
  try {
    if (fs.existsSync(DB_PATH)) {
      const live = new Database(DB_PATH);
      try {
        // Fold the WAL in so the snapshot is complete, not just the main file.
        live.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        live.close();
      }
      pruneBackups();
      fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `loreloom-pre-restore-${timestamp()}.db`));
    }
  } catch (err) {
    // The author asked for this restore explicitly; a failed safety copy is
    // loud but must not cancel the restore.
    console.error("[loreloom] could not back up the database being replaced:", err);
  }
  for (const suffix of ["-wal", "-shm"]) {
    const stale = DB_PATH + suffix;
    if (fs.existsSync(stale)) fs.rmSync(stale);
  }
  fs.renameSync(PENDING_RESTORE_PATH, DB_PATH);
  console.log("[loreloom] staged restore applied; the replaced database was backed up first.");
}
