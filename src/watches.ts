import type { Db } from "./db.ts";
import { escapeHtml, markdownToTelegramHtml, splitMarkdown } from "./telegram/format.ts";
import { formatLocalTime } from "./time.ts";
import { isPermanentSendError } from "./reminders.ts";

/**
 * /watch: "tell me when…". Every few hours the bot searches the web and X for the watched thing,
 * compares it with what it found last time, and posts only when something is new. One-time events
 * ("when GPT-7 is released") end the watch once they happen; every watch ends after 30 days.
 */

const HOUR = 60 * 60 * 1000;
export const MAX_WATCHES_PER_CHAT = 5;
export const DEFAULT_WATCH_HOURS = 3;
export const MIN_WATCH_HOURS = 1;
export const MAX_WATCH_HOURS = 24;
export const WATCH_LIFETIME_MS = 30 * 24 * HOUR;
/** A failed check (AI or Telegram down) is tried again this soon, or at the next regular time if sooner. */
const RETRY_MS = HOUR;
const MAX_STATE_CHARS = 1000;

export interface Watch {
  id: number;
  chatId: number;
  threadId: number;
  userId: number | null;
  userName: string;
  task: string;
  everyHours: number;
  nextAt: number;
  /** What the last check found; the next check is compared against it. */
  state: string;
  checks: number;
  alerts: number;
  lastError?: string;
  createdAt: number;
}

type Row = {
  id: number;
  chat_id: number;
  thread_id: number;
  user_id: number | null;
  user_name: string;
  task: string;
  every_hours: number;
  next_at: number;
  state: string;
  checks: number;
  alerts: number;
  last_error: string | null;
  created_at: number;
};

const fromRow = (r: Row): Watch => ({
  id: Number(r.id),
  chatId: Number(r.chat_id),
  threadId: Number(r.thread_id),
  userId: r.user_id === null ? null : Number(r.user_id),
  userName: r.user_name,
  task: r.task,
  everyHours: Number(r.every_hours),
  nextAt: Number(r.next_at),
  state: r.state,
  checks: Number(r.checks),
  alerts: Number(r.alerts),
  lastError: r.last_error ?? undefined,
  createdAt: Number(r.created_at),
});

export class WatchStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  add(watch: Pick<Watch, "chatId" | "threadId" | "userId" | "userName" | "task" | "everyHours" | "state">, now = Date.now()): number {
    const result = this.#db
      .prepare(
        "INSERT INTO watches (chat_id, thread_id, user_id, user_name, task, every_hours, next_at, state, checks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
      )
      .run(watch.chatId, watch.threadId, watch.userId, watch.userName, watch.task, watch.everyHours, now + watch.everyHours * HOUR, watch.state, now);
    return Number(result.lastInsertRowid);
  }

  list(chatId: number): Watch[] {
    return (this.#db.prepare("SELECT * FROM watches WHERE chat_id = ? ORDER BY id").all(chatId) as Row[]).map(fromRow);
  }

  get(chatId: number, id: number): Watch | undefined {
    const row = this.#db.prepare("SELECT * FROM watches WHERE chat_id = ? AND id = ?").get(chatId, id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  count(chatId: number): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM watches WHERE chat_id = ?").get(chatId) as { n: number }).n);
  }

  due(now = Date.now()): Watch[] {
    return (this.#db.prepare("SELECT * FROM watches WHERE next_at <= ? ORDER BY next_at").all(now) as Row[]).map(fromRow);
  }

  /** A check finished: remember what it found and schedule the next one. */
  checked(watch: Watch, state: string, alerted: boolean, now = Date.now()): void {
    this.#db
      .prepare("UPDATE watches SET state = ?, next_at = ?, checks = checks + 1, alerts = alerts + ?, last_error = NULL WHERE id = ?")
      .run(state.slice(0, MAX_STATE_CHARS), now + watch.everyHours * HOUR, alerted ? 1 : 0, watch.id);
  }

  failed(watch: Watch, error: string, now = Date.now()): void {
    this.#db
      .prepare("UPDATE watches SET next_at = ?, last_error = ? WHERE id = ?")
      .run(now + Math.min(RETRY_MS, watch.everyHours * HOUR), error.slice(0, 200), watch.id);
  }

  remove(id: number): void {
    this.#db.prepare("DELETE FROM watches WHERE id = ?").run(id);
  }

  forgetChat(chatId: number): number {
    return Number(this.#db.prepare("DELETE FROM watches WHERE chat_id = ?").run(chatId).changes);
  }
}

/**
 * "every 2h …", "每2小時 …", "… 每隔 6 小时": how often to check (default 3 hours, 1–24) and what to watch.
 */
export function parseWatchRequest(text: string): { everyHours: number; task: string } {
  const pattern = /(?:^|\s)(?:every\s+(\d{1,2})\s*(?:h|hrs?|hours?)\b|每隔?\s*(\d{1,2})\s*(?:個|个)?\s*(?:小時|小时|钟头|鐘頭))[,，:：]?/i;
  const match = text.match(pattern);
  const hours = match ? Number(match[1] ?? match[2]) : DEFAULT_WATCH_HOURS;
  const task = (match ? text.replace(match[0], " ") : text).replace(/\s+/g, " ").trim();
  return { everyHours: Math.min(MAX_WATCH_HOURS, Math.max(MIN_WATCH_HOURS, hours)), task };
}

/** "tell me when…", "let us know if…", "GPT-7 發布的時候告訴我": a watch request rather than a question. */
export function isWatchRequest(text: string): boolean {
  return (
    /^\s*(?:please\s+|pls\s+)?(?:(?:tell|notify|ping|alert|message)\s+(?:me|us)|let\s+(?:me|us)\s+know)\s+(?:when|if|as soon as|once)\b/i.test(text) ||
    // Not plain "watch": "watch this video and summarize it" is a question.
    /^\s*(?:please\s+)?(?:keep an eye on|monitor)\s+/i.test(text) ||
    /(?:時|时|的時候|的时候|的話|的话|之後|之后|以後|以后|一旦?)\s*(?:就|請|请)?\s*(?:告訴|告诉|通知)\s*(?:我們|我们|我|大家)/.test(text) ||
    /^\s*(?:請|请)?\s*(?:幫我|帮我)?\s*(?:盯著|盯着)/.test(text)
  );
}

/** The system prompt for one check. `previous`: what the last check found (none on the first check). */
export const WATCH_PROMPT = (now: number, tz: string, previous: string | undefined) =>
  [
    "You keep watch over something for a Telegram chat. Search the web and X now for the current state of what the task below is about.",
    `Current time: ${formatLocalTime(now, tz)} (${tz}).`,
    previous ? `What the last check found: ${previous}` : "This is the first check: there is nothing to compare with yet.",
    'Reply with only one JSON object: {"state":"...","new":"...","done":false}',
    '- "state": what is true now, in 1–3 short factual sentences with dates, in the language of the task. The next check compares against it.',
    previous
      ? '- "new": only if something happened since the last check that the task asks to hear about: a short post (a few lines, simple Markdown, with a source link). Otherwise "". Do not repeat what the last check already found, and do not report rumours as facts.'
      : '- "new": always "" on the first check.',
    '- "done": true only when the task is about a one-time event ("when X is released", "if Y happens") and it has now happened. Otherwise false.',
  ].join("\n");

export interface WatchResult {
  state: string;
  news: string;
  done: boolean;
}

/** Validate the AI's JSON answer for a check. Throws when it isn't usable (the check is retried). */
export function parseWatchAnswer(answer: string, previous: string | undefined): WatchResult {
  const json = answer.match(/\{[\s\S]*\}/)?.[0];
  let data: { state?: unknown; new?: unknown; done?: unknown } = {};
  try {
    data = json ? JSON.parse(json) : {};
  } catch {
    // handled below
  }
  const state = typeof data.state === "string" ? data.state.trim() : "";
  if (!state) throw new Error("the check gave no usable answer");
  // Nothing is "new" on the first check, or when the state is word for word what it was.
  const news = previous && state !== previous.trim() && typeof data.new === "string" ? data.new.trim() : "";
  return { state, news, done: data.done === true };
}

export interface WatchDeps {
  /** One AI request with web/X search. */
  ask(system: string, prompt: string): Promise<string>;
  send(chatId: number, html: string, other: Record<string, unknown>): Promise<unknown>;
  /** Groups that were disabled lose their watches. */
  isActive(chatId: number): boolean;
  zoneOf(chatId: number): string;
  /** Buttons under an alert (⏹ Stop). */
  markup?(watch: Watch): unknown;
}

/** Check every watch that is due, one at a time. Returns how many alerts were posted. */
export async function checkDueWatches(store: WatchStore, deps: WatchDeps, now = Date.now(), counted: (watch: Watch) => void = () => undefined): Promise<number> {
  let posted = 0;
  for (const watch of store.due(now)) {
    if (!deps.isActive(watch.chatId)) {
      store.remove(watch.id);
      continue;
    }
    const target = watch.threadId ? { message_thread_id: watch.threadId } : {};
    try {
      if (now - watch.createdAt > WATCH_LIFETIME_MS) {
        await deps.send(watch.chatId, `👀 Stopped watching <b>${escapeHtml(watch.task)}</b> after 30 days. Start it again with /watch.`, { parse_mode: "HTML", ...target });
        store.remove(watch.id);
        continue;
      }
      const answer = await deps.ask(WATCH_PROMPT(now, deps.zoneOf(watch.chatId), watch.state), watch.task);
      counted(watch);
      const result = parseWatchAnswer(answer, watch.state);
      if (result.news) {
        const body = splitMarkdown(result.news, 3000)[0] ?? result.news.slice(0, 3000);
        const ending = result.done ? "\n\n<i>That's what you asked about, so I've stopped watching it.</i>" : "";
        const keyboard = result.done ? undefined : deps.markup?.(watch);
        await deps.send(watch.chatId, `👀 <b>${escapeHtml(watch.task.slice(0, 200))}</b>\n\n${markdownToTelegramHtml(body)}${ending}`, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...target,
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
        posted++;
      }
      if (result.done && result.news) store.remove(watch.id);
      else store.checked(watch, result.state, Boolean(result.news), now);
    } catch (error) {
      const message = (error as Error).message;
      console.warn(`watch ${watch.id} failed: ${message}`);
      if (isPermanentSendError(message)) store.remove(watch.id);
      else store.failed(watch, message, now);
    }
  }
  return posted;
}
