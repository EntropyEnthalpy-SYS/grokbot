import type { Db } from "./db.ts";

/**
 * /skill: saved requests a chat runs by name. "/skill add 早報 = today's top 5 AI news, one line each"
 * once, then "grok 早報" (or "grok 早報 crypto" to add to it) any time, and "/schedule 每天8點 早報".
 */

export const MAX_SKILLS_PER_CHAT = 20;
export const MAX_SKILL_CHARS = 1000;
/** One word: letters (any script), digits, _ or -. */
const NAME = /^[\p{L}\p{N}_-]{1,20}$/u;

export interface Skill {
  chatId: number;
  name: string;
  prompt: string;
  userId: number | null;
  userName: string;
  uses: number;
}

type Row = { chat_id: number; name: string; prompt: string; user_id: number | null; user_name: string; uses: number };
const fromRow = (r: Row): Skill => ({
  chatId: Number(r.chat_id),
  name: r.name,
  prompt: r.prompt,
  userId: r.user_id === null ? null : Number(r.user_id),
  userName: r.user_name,
  uses: Number(r.uses),
});

/** "早報 = …", "news: …", "news：…" → name and request, or why it isn't one. */
export function parseSkillDefinition(text: string): { name: string; prompt: string } | { error: string } {
  const match = text.trim().match(/^(\S+?)\s*[=:：]\s*([\s\S]+)$/);
  if (!match) return { error: "Write it as /skill add name = what to do" };
  const [, name, prompt] = match as unknown as [string, string, string];
  if (!NAME.test(name)) return { error: "The name must be one word (up to 20 letters or digits)" };
  if (prompt.trim().length > MAX_SKILL_CHARS) return { error: `The request is longer than ${MAX_SKILL_CHARS} characters` };
  return { name, prompt: prompt.trim() };
}

export class SkillStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Add or replace. Names match case-insensitively ("News" replaces "news"). */
  set(chatId: number, name: string, prompt: string, user: { id?: number; name: string }, now = Date.now()): void {
    const existing = this.get(chatId, name);
    if (existing) this.#db.prepare("DELETE FROM skills WHERE chat_id = ? AND name = ?").run(chatId, existing.name);
    this.#db
      .prepare("INSERT INTO skills (chat_id, name, prompt, user_id, user_name, uses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(chatId, name, prompt, user.id ?? null, user.name, existing?.uses ?? 0, now);
  }

  get(chatId: number, name: string): Skill | undefined {
    const row = this.#db.prepare("SELECT * FROM skills WHERE chat_id = ? AND lower(name) = lower(?)").get(chatId, name) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(chatId: number): Skill[] {
    return (this.#db.prepare("SELECT * FROM skills WHERE chat_id = ? ORDER BY uses DESC, name").all(chatId) as Row[]).map(fromRow);
  }

  count(chatId: number): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM skills WHERE chat_id = ?").get(chatId) as { n: number }).n);
  }

  remove(chatId: number, name: string): boolean {
    return Number(this.#db.prepare("DELETE FROM skills WHERE chat_id = ? AND lower(name) = lower(?)").run(chatId, name).changes) > 0;
  }

  /**
   * "早報" or "早報 crypto" (also "/skill 早報 …") → the saved request, plus the extra words; any other
   * text is returned unchanged. A match counts as a use.
   */
  expand(chatId: number, text: string): { text: string; skill?: Skill } {
    const match = text.trim().match(/^(?:\/skill(?:@\w+)?\s+)?(\S+?)(?:[\s,，:：]+([\s\S]*))?$/i);
    const skill = match && NAME.test(match[1]!) ? this.get(chatId, match[1]!) : undefined;
    if (!skill) return { text };
    this.#db.prepare("UPDATE skills SET uses = uses + 1 WHERE chat_id = ? AND name = ?").run(chatId, skill.name);
    const extra = match![2]?.trim();
    return { text: extra ? `${skill.prompt}\n\nAlso: ${extra}` : skill.prompt, skill };
  }

  forgetChat(chatId: number): number {
    return Number(this.#db.prepare("DELETE FROM skills WHERE chat_id = ?").run(chatId).changes);
  }
}
