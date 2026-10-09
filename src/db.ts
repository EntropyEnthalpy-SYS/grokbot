import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  return openDbAt(join(dataDir, "grokbot.db"));
}

export function openDbAt(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS credentials (
      provider_id TEXT PRIMARY KEY,
      json        TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      chat_key    TEXT PRIMARY KEY,
      messages    TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Groups the owner enabled with /enable, and their link-summary mode.
    CREATE TABLE IF NOT EXISTS groups (
      chat_id    INTEGER PRIMARY KEY,
      title      TEXT,
      link_mode  TEXT NOT NULL DEFAULT 'auto',
      enabled_at INTEGER NOT NULL
    );
    -- Every message seen in enabled groups, including the bot's own replies.
    -- Used as conversation context when someone talks to the bot.
    CREATE TABLE IF NOT EXISTS group_log (
      chat_id    INTEGER NOT NULL,
      thread_id  INTEGER NOT NULL DEFAULT 0,
      message_id INTEGER NOT NULL,
      user_id    INTEGER,
      name       TEXT NOT NULL,
      text       TEXT NOT NULL,
      is_bot     INTEGER NOT NULL DEFAULT 0,
      at         INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS group_log_thread ON group_log (chat_id, thread_id, at);
    -- /remind: one-off or repeating reminders, deleted once delivered (or with /forget, /disable).
    CREATE TABLE IF NOT EXISTS reminders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    INTEGER NOT NULL,
      thread_id  INTEGER NOT NULL DEFAULT 0,
      message_id INTEGER,
      user_id    INTEGER,
      user_name  TEXT NOT NULL,
      text       TEXT NOT NULL,
      due_at     INTEGER NOT NULL,
      repeat     TEXT NOT NULL DEFAULT 'none',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reminders_due ON reminders (due_at);
    -- Daily usage counters per member (counts only, no content) and per AI provider (tokens).
    CREATE TABLE IF NOT EXISTS usage (
      day       TEXT NOT NULL,
      chat_id   INTEGER NOT NULL,
      user_id   INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      kind      TEXT NOT NULL,
      amount    REAL NOT NULL,
      PRIMARY KEY (day, chat_id, user_id, kind)
    );
    -- /admin → Permissions: who may chat privately, use approved-only groups, skip limits, or is ignored.
    CREATE TABLE IF NOT EXISTS permissions (
      user_id    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT '',
      username   TEXT,
      private    INTEGER NOT NULL DEFAULT 0,
      approved   INTEGER NOT NULL DEFAULT 0,
      trusted    INTEGER NOT NULL DEFAULT 0,
      blocked    INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    -- /lm: notes a chat asked the bot to always know.
    CREATE TABLE IF NOT EXISTS group_memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    INTEGER NOT NULL,
      text       TEXT NOT NULL,
      user_id    INTEGER,
      user_name  TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS group_memory_chat ON group_memory (chat_id);
    -- Extracted page text and generated summaries, keyed by normalized URL.
    CREATE TABLE IF NOT EXISTS link_cache (
      url        TEXT PRIMARY KEY,
      content    TEXT,
      source     TEXT,
      summary    TEXT,
      fetched_at INTEGER NOT NULL
    );
  `);
  addColumnIfMissing(db, "groups", "lang", "TEXT NOT NULL DEFAULT 'zh-tw'");
  addColumnIfMissing(db, "groups", "voice_mode", "TEXT NOT NULL DEFAULT 'auto'");
  addColumnIfMissing(db, "groups", "disabled_platforms", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "groups", "delete_link", "INTEGER NOT NULL DEFAULT 0");
  // Groups enabled before privacy modes existed keep the old behaviour; new groups start strict (see GroupStore.enable).
  addColumnIfMissing(db, "groups", "privacy", "TEXT NOT NULL DEFAULT 'normal'");
  // Auto-delete the bot's housekeeping replies (settings, usage hints) after a minute.
  addColumnIfMissing(db, "groups", "tidy", "INTEGER NOT NULL DEFAULT 1");
  // The owner's style instructions for the bot in this group ("casual, short, Traditional Chinese").
  addColumnIfMissing(db, "groups", "persona", "TEXT NOT NULL DEFAULT ''");
  // Answer questions asked by voice with a voice note too.
  addColumnIfMissing(db, "groups", "voice_reply", "INTEGER NOT NULL DEFAULT 1");
  // /schedule: the bot writes the post itself (weather, news…) instead of repeating a fixed reminder text.
  addColumnIfMissing(db, "reminders", "ai", "INTEGER NOT NULL DEFAULT 0");
  // Who may use the bot in a group: everyone (default) or approved members only.
  addColumnIfMissing(db, "groups", "access", "TEXT NOT NULL DEFAULT 'everyone'");
  // /tz: the group's time zone ("" = the bot's TIMEZONE).
  addColumnIfMissing(db, "groups", "timezone", "TEXT NOT NULL DEFAULT ''");
  // Notes and polls suggested by the AI wait for the asker's ✅ before they take effect.
  addColumnIfMissing(db, "groups", "confirm_actions", "INTEGER NOT NULL DEFAULT 1");
  // Reminder lifecycle: paused, delivered one-offs kept a day for 💤 snooze, delivery history and retries.
  addColumnIfMissing(db, "reminders", "paused", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "reminders", "done_at", "INTEGER");
  addColumnIfMissing(db, "reminders", "sent_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "reminders", "last_sent_at", "INTEGER");
  addColumnIfMissing(db, "reminders", "retry_at", "INTEGER");
  addColumnIfMissing(db, "reminders", "attempts", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "reminders", "last_error", "TEXT");
  // 🔞 Skip link cards for adult sites.
  addColumnIfMissing(db, "groups", "hide_adult", "INTEGER NOT NULL DEFAULT 1");
  // Message ids of the bot's automatic posts (cards, transcripts): replies to them aren't questions. Ids only.
  db.exec("CREATE TABLE IF NOT EXISTS auto_posts (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (chat_id, message_id))");
  migrateTrusted(db);
  return db;
}

/** Trusted members used to be a JSON list in settings; they are now a permission flag. */
function migrateTrusted(db: Db): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'trusted'").get() as { value: string } | undefined;
  if (!row) return;
  let ids: unknown = [];
  try {
    ids = JSON.parse(row.value);
  } catch {
    // unreadable: nothing to carry over
  }
  for (const id of Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : []) {
    db.prepare("INSERT INTO permissions (user_id, trusted, updated_at) VALUES (?, 1, ?) ON CONFLICT(user_id) DO UPDATE SET trusted = 1").run(id, Date.now());
  }
  db.prepare("DELETE FROM settings WHERE key = 'trusted'").run();
}

/** SQLite has no ADD COLUMN IF NOT EXISTS; check the table first so upgrades of existing databases work. */
function addColumnIfMissing(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
