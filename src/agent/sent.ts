import type { Db } from "../db.ts";

/** How long the bot's own messages are kept: as long as conversations (see CONVERSATION_RETENTION_MS). */
export const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SentMessage {
  /** The conversation that wrote it (answers), or undefined for cards, transcripts and notices. */
  chatKey?: string;
  text: string;
  at: number;
}

/**
 * The bot's own messages, kept on the server in every privacy mode. Telegram gives a reply only the
 * replied message's first part (and nothing of a long answer split in two), so the full text and the
 * conversation behind it come from here.
 */
export class SentStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Record a posted message; every part of a split answer points to the whole text. */
  record(chatId: number, messageIds: readonly number[], text: string, chatKey?: string, at = Date.now()): void {
    const insert = this.#db.prepare(
      "INSERT INTO sent_messages (chat_id, message_id, chat_key, text, at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(chat_id, message_id) DO UPDATE SET chat_key = excluded.chat_key, text = excluded.text, at = excluded.at",
    );
    for (const id of messageIds) insert.run(chatId, id, chatKey ?? null, text, at);
  }

  get(chatId: number, messageId: number): SentMessage | undefined {
    const row = this.#db.prepare("SELECT chat_key, text, at FROM sent_messages WHERE chat_id = ? AND message_id = ?").get(chatId, messageId) as
      | { chat_key: string | null; text: string; at: number }
      | undefined;
    return row ? { chatKey: row.chat_key ?? undefined, text: row.text, at: row.at } : undefined;
  }

  /** Forget a chat's messages (/forget, /disable). */
  forget(chatId: number): void {
    this.#db.prepare("DELETE FROM sent_messages WHERE chat_id = ?").run(chatId);
  }

  prune(now = Date.now()): void {
    this.#db.prepare("DELETE FROM sent_messages WHERE at < ?").run(now - SENT_RETENTION_MS);
  }
}
