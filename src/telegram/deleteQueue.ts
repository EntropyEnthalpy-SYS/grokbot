import type { Db } from "../db.ts";

export interface MessageDeleter {
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
}

/**
 * Messages to delete later (/tidy). Kept in SQLite so a restart doesn't leave
 * them behind: `resume()` on start deletes what became due while the bot was
 * down and re-arms the rest. A delete that fails (message already gone, no
 * rights) is dropped, not retried.
 */
export class DeleteQueue {
  readonly #db: Db;
  readonly #api: MessageDeleter;
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(db: Db, api: MessageDeleter) {
    this.#db = db;
    this.#api = api;
    db.exec(`CREATE TABLE IF NOT EXISTS pending_deletes (
      chat_id    INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      delete_at  INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    )`);
  }

  schedule(chatId: number, messageId: number, delayMs: number, now = Date.now()): void {
    if (!messageId) return; // ephemeral messages have id 0 and vanish by themselves
    this.#db
      .prepare("INSERT OR REPLACE INTO pending_deletes (chat_id, message_id, delete_at) VALUES (?, ?, ?)")
      .run(chatId, messageId, now + delayMs);
    this.#arm(chatId, messageId, delayMs);
  }

  /** On start: delete what is overdue, re-arm timers for the rest. */
  async resume(now = Date.now()): Promise<number> {
    const rows = this.#db.prepare("SELECT chat_id, message_id, delete_at FROM pending_deletes").all() as {
      chat_id: number;
      message_id: number;
      delete_at: number;
    }[];
    let overdue = 0;
    for (const row of rows) {
      const wait = Number(row.delete_at) - now;
      if (wait <= 0) {
        overdue++;
        await this.#delete(Number(row.chat_id), Number(row.message_id));
      } else {
        this.#arm(Number(row.chat_id), Number(row.message_id), wait);
      }
    }
    return overdue;
  }

  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #arm(chatId: number, messageId: number, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void this.#delete(chatId, messageId);
    }, delayMs);
    timer.unref?.();
    this.#timers.add(timer);
  }

  async #delete(chatId: number, messageId: number): Promise<void> {
    await this.#api.deleteMessage(chatId, messageId).catch(() => undefined);
    this.#db.prepare("DELETE FROM pending_deletes WHERE chat_id = ? AND message_id = ?").run(chatId, messageId);
  }
}
