import type { Db } from "./db.ts";
import { addLocalDays, formatLocalTime, localToUtc, timeZone } from "./time.ts";

/** Reminder times are in the bot's time zone (TIMEZONE, default Asia/Taipei). */
export { formatLocalTime };

const DAY = 24 * 60 * 60 * 1000;
export const MAX_REMINDERS_PER_CHAT = 20;
const MAX_AHEAD_MS = 366 * DAY;
/** A reminder that can't be delivered for this long (network, Telegram down) is given up. */
const GIVE_UP_AFTER_MS = 60 * 60 * 1000;

export const REPEATS = ["none", "daily", "weekly"] as const;
export type Repeat = (typeof REPEATS)[number];

export interface Reminder {
  id: number;
  chatId: number;
  threadId: number;
  /** The message that asked for it; the reminder replies to it. */
  messageId: number | null;
  userId: number | null;
  userName: string;
  text: string;
  dueAt: number;
  repeat: Repeat;
  /** /schedule: the bot writes the post at due time (text is the task), instead of repeating a fixed text. */
  ai?: boolean;
}

type Row = {
  id: number;
  chat_id: number;
  thread_id: number;
  message_id: number | null;
  user_id: number | null;
  user_name: string;
  text: string;
  due_at: number;
  repeat: string;
  ai?: number;
};

const fromRow = (row: Row): Reminder => ({
  id: Number(row.id),
  chatId: Number(row.chat_id),
  threadId: Number(row.thread_id),
  messageId: row.message_id === null ? null : Number(row.message_id),
  userId: row.user_id === null ? null : Number(row.user_id),
  userName: row.user_name,
  text: row.text,
  dueAt: Number(row.due_at),
  repeat: (REPEATS as readonly string[]).includes(row.repeat) ? (row.repeat as Repeat) : "none",
  ai: Number(row.ai ?? 0) === 1,
});

export class ReminderStore {
  readonly #db: Db;
  /** Failed sends wait until this time; kept in memory so the scheduled time itself never drifts. */
  readonly #retryAt = new Map<number, number>();

  constructor(db: Db) {
    this.#db = db;
  }

  add(reminder: Omit<Reminder, "id">, now = Date.now()): number {
    const result = this.#db
      .prepare(
        "INSERT INTO reminders (chat_id, thread_id, message_id, user_id, user_name, text, due_at, repeat, created_at, ai) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(reminder.chatId, reminder.threadId, reminder.messageId, reminder.userId, reminder.userName, reminder.text, reminder.dueAt, reminder.repeat, now, reminder.ai ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  list(chatId: number): Reminder[] {
    return (this.#db.prepare("SELECT * FROM reminders WHERE chat_id = ? ORDER BY due_at").all(chatId) as Row[]).map(fromRow);
  }

  count(chatId: number): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE chat_id = ?").get(chatId) as { n: number }).n);
  }

  get(chatId: number, id: number): Reminder | undefined {
    const row = this.#db.prepare("SELECT * FROM reminders WHERE chat_id = ? AND id = ?").get(chatId, id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  remove(id: number): void {
    this.#retryAt.delete(id);
    this.#db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
  }

  due(now = Date.now()): Reminder[] {
    return (this.#db.prepare("SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at").all(now) as Row[])
      .map(fromRow)
      .filter((reminder) => (this.#retryAt.get(reminder.id) ?? 0) <= now);
  }

  /** After delivery: repeating reminders move to their next time, one-off ones are deleted. */
  done(reminder: Reminder, now = Date.now()): void {
    if (reminder.repeat === "none") return this.remove(reminder.id);
    this.#retryAt.delete(reminder.id);
    this.#db.prepare("UPDATE reminders SET due_at = ? WHERE id = ?").run(nextDue(reminder.dueAt, reminder.repeat, now), reminder.id);
  }

  retryLater(reminder: Reminder, at: number): void {
    this.#retryAt.set(reminder.id, at);
  }

  forgetChat(chatId: number): number {
    return Number(this.#db.prepare("DELETE FROM reminders WHERE chat_id = ?").run(chatId).changes);
  }
}

/**
 * The first time after `now` on the repeat schedule (skips missed ones instead of
 * firing a backlog). Steps by local calendar days, so 08:00 stays 08:00 across DST.
 */
export function nextDue(dueAt: number, repeat: Repeat, now: number): number {
  if (dueAt > now) return dueAt;
  const stepDays = repeat === "weekly" ? 7 : 1;
  // Jump close to `now` first (no long loops after downtime), then step until it's in the future.
  let steps = Math.max(1, Math.floor((now - dueAt) / (stepDays * DAY)));
  let next = addLocalDays(dueAt, steps * stepDays);
  while (next <= now) next = addLocalDays(dueAt, ++steps * stepDays);
  return next;
}

/** The system prompt for writing a scheduled post at its due time. */
export const SCHEDULED_POST_PROMPT = (now: number) =>
  [
    "You write a scheduled post for a Telegram chat. Do the task below now and output only the post.",
    `Current time: ${formatLocalTime(now)} (${timeZone()}).`,
    "- Search the web for anything current (weather, news, prices, schedules) and keep facts accurate.",
    "- Short and skimmable: a few bullets or lines. Simple Markdown only, no tables.",
    "- Write in the language of the task.",
  ].join("\n");

export type ParsedReminder = { ok: true; dueAt: number; repeat: Repeat; text: string } | { ok: false; reason: string };

export const REMINDER_SYSTEM_PROMPT = (now: number) =>
  [
    "You turn a reminder request from a Telegram chat into JSON.",
    `Current time: ${formatLocalTime(now)} (${timeZone()}).`,
    'Reply with only one JSON object: {"at":"YYYY-MM-DD HH:MM","repeat":"none|daily|weekly","text":"..."}',
    '- "at": the first time to remind, in that local time. If only a day is given, use 09:00. "in 2 hours" etc. count from the current time.',
    '- "repeat": "daily" or "weekly" only when the request says every day / every week (每天, 每週, 每個星期一…), else "none".',
    '- "text": what to remind about, short, in the language of the request, without the time words and without "remind me/us".',
    'If the request contains no understandable time, reply {"error":"<short reason>"}.',
  ].join("\n");

/** Validate Grok's JSON answer for a reminder request. */
export function parseReminderAnswer(answer: string, now: number): ParsedReminder {
  const json = answer.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return { ok: false, reason: "no time found" };
  let data: { at?: unknown; repeat?: unknown; text?: unknown; error?: unknown };
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, reason: "no time found" };
  }
  if (typeof data.error === "string") return { ok: false, reason: data.error };
  const match = typeof data.at === "string" ? data.at.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/) : null;
  if (!match) return { ok: false, reason: "no time found" };
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const dueAt = localToUtc(y, mo, d, h, mi);
  const repeat: Repeat = (REPEATS as readonly string[]).includes(String(data.repeat)) ? (data.repeat as Repeat) : "none";
  const text = typeof data.text === "string" ? data.text.trim().slice(0, 500) : "";
  if (!text) return { ok: false, reason: "nothing to remind about" };
  if (Number.isNaN(dueAt)) return { ok: false, reason: "no time found" };
  if (dueAt > now + MAX_AHEAD_MS) return { ok: false, reason: "that is more than a year away" };
  if (dueAt <= now) {
    // "every Monday 9:00" asked on Monday afternoon: start next week. A one-off time in the past is an error.
    if (repeat === "none") return { ok: false, reason: `${formatLocalTime(dueAt)} has already passed` };
    return { ok: true, dueAt: nextDue(dueAt, repeat, now), repeat, text };
  }
  return { ok: true, dueAt, repeat, text };
}

/** "remind us …", "提醒我…", "請提醒…": a reminder request rather than a question. */
export function isReminderRequest(text: string): boolean {
  return /^\s*(?:please\s+|pls\s+|請\s*|请\s*)?(?:remind\b|set\s+a\s+reminder|提醒|リマインド)/i.test(text);
}

export interface ReminderSender {
  sendMessage(chatId: number, text: string, other: Record<string, unknown>): Promise<unknown>;
}

/**
 * Send every reminder that is due. Reminders for groups that were disabled are
 * dropped; failed sends are retried each minute for up to an hour.
 */
export async function deliverDueReminders(
  store: ReminderStore,
  api: ReminderSender,
  isActive: (chatId: number) => boolean,
  render: (reminder: Reminder) => string | Promise<string>,
  now = Date.now(),
): Promise<number> {
  let sent = 0;
  // Plain reminders first: an AI-written post can take a while and must not hold them up.
  const due = store.due(now).sort((a, b) => Number(a.ai ?? false) - Number(b.ai ?? false));
  for (const reminder of due) {
    if (!isActive(reminder.chatId)) {
      store.remove(reminder.id);
      continue;
    }
    try {
      await api.sendMessage(reminder.chatId, await render(reminder), {
        parse_mode: "HTML",
        // Scheduled posts stand on their own; plain reminders point back at the request.
        ...(reminder.messageId && !reminder.ai ? { reply_parameters: { message_id: reminder.messageId, allow_sending_without_reply: true } } : {}),
        ...(reminder.threadId ? { message_thread_id: reminder.threadId } : {}),
      });
      store.done(reminder, now);
      sent++;
    } catch (error) {
      console.warn(`reminder ${reminder.id} failed: ${(error as Error).message}`);
      if (now - reminder.dueAt > GIVE_UP_AFTER_MS) store.done(reminder, now);
      else store.retryLater(reminder, now + 60_000);
    }
  }
  return sent;
}
