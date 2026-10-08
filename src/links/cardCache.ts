import type { Db } from "../db.ts";
import type { XCard } from "./xcard.ts";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedCard {
  platform: string;
  card: XCard;
}

/**
 * Cards already posted, with media pointing at Telegram's stored files
 * (file_id). Re-posting the same link sends them again instantly, without
 * parsing, downloading or uploading.
 */
export class CardCache {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec("CREATE TABLE IF NOT EXISTS card_cache (key TEXT PRIMARY KEY, platform TEXT NOT NULL, card TEXT NOT NULL, at INTEGER NOT NULL)");
  }

  get(url: string, lang: string, now = Date.now()): CachedCard | undefined {
    const row = this.#db.prepare("SELECT platform, card, at FROM card_cache WHERE key = ?").get(key(url, lang)) as
      | { platform: string; card: string; at: number }
      | undefined;
    if (!row || now - row.at > TTL_MS) return undefined;
    return { platform: row.platform, card: JSON.parse(row.card) as XCard };
  }

  put(url: string, lang: string, platform: string, card: XCard, now = Date.now()): void {
    if (card.media.some((m) => m.local)) return; // local paths are gone after upload
    this.#db
      .prepare("INSERT OR REPLACE INTO card_cache (key, platform, card, at) VALUES (?, ?, ?, ?)")
      .run(key(url, lang), platform, JSON.stringify(card), now);
  }

  forget(url: string, lang: string): void {
    this.#db.prepare("DELETE FROM card_cache WHERE key = ?").run(key(url, lang));
  }

  prune(now = Date.now()): void {
    this.#db.prepare("DELETE FROM card_cache WHERE at < ?").run(now - TTL_MS);
  }
}

function key(url: string, lang: string): string {
  return `${url}#${lang}`;
}
