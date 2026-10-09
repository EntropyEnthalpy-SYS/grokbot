import type { Db } from "./db.ts";
import { addLocalDays, formatLocalClock, formatLocalTime, localDay, localToUtc, timeZone } from "./time.ts";

/** Reminder times are in the chat's time zone (/tz; default TIMEZONE, Asia/Taipei). */
export { formatLocalTime };

const DAY = 24 * 60 * 60 * 1000;
export const MAX_REMINDERS_PER_CHAT = 20;
const MAX_AHEAD_MS = 366 * DAY;
/** A reminder that can't be delivered for this long (network, Telegram down) is given up. */
const GIVE_UP_AFTER_MS = 60 * 60 * 1000;
const RETRY_AFTER_MS = 60_000;
/** Delivered one-off reminders stay this long so their 💤 Snooze buttons keep working. */
const KEEP_DELIVERED_MS = DAY;

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
  paused?: boolean;
  /** Delivery history: how often it was sent, when last, and the last failed attempt's error. */
  sentCount?: number;
  lastSentAt?: number;
  lastError?: string;
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
  paused?: number;
  sent_count?: number;
  last_sent_at?: number | null;
  last_error?: string | null;
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
  paused: Number(row.paused ?? 0) === 1,
  sentCount: Number(row.sent_count ?? 0),
  lastSentAt: row.last_sent_at == null ? undefined : Number(row.last_sent_at),
  lastError: row.last_error ?? undefined,
});

/** Reminders still to come. Delivered one-offs are kept a day for snoozing, but are not active. */
const ACTIVE = "done_at IS NULL";

export class ReminderStore {
  readonly #db: Db;
  readonly #zoneOf: (chatId: number) => string;

  /** `zoneOf`: each chat's time zone, so daily/weekly reminders keep their local time across DST. */
  constructor(db: Db, zoneOf: (chatId: number) => string) {
    this.#db = db;
    this.#zoneOf = zoneOf;
  }

  zone(chatId: number): string {
    return this.#zoneOf(chatId);
  }

  add(reminder: Omit<Reminder, "id">, now = Date.now()): number {
    const result = this.#db
      .prepare(
        "INSERT INTO reminders (chat_id, thread_id, message_id, user_id, user_name, text, due_at, repeat, created_at, ai) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(reminder.chatId, reminder.threadId, reminder.messageId, reminder.userId, reminder.userName, reminder.text, reminder.dueAt, reminder.repeat, now, reminder.ai ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  /** Active reminders of a chat (paused ones included), soonest first. */
  list(chatId: number): Reminder[] {
    return (this.#db.prepare(`SELECT * FROM reminders WHERE chat_id = ? AND ${ACTIVE} ORDER BY due_at`).all(chatId) as Row[]).map(fromRow);
  }

  count(chatId: number): number {
    return Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE chat_id = ? AND ${ACTIVE}`).get(chatId) as { n: number }).n);
  }

  /** An active reminder, or a delivered one-off that can still be snoozed. */
  get(chatId: number, id: number): Reminder | undefined {
    const row = this.#db.prepare("SELECT * FROM reminders WHERE chat_id = ? AND id = ?").get(chatId, id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  isActive(id: number): boolean {
    return this.#db.prepare(`SELECT 1 FROM reminders WHERE id = ? AND ${ACTIVE}`).get(id) !== undefined;
  }

  remove(id: number): void {
    this.#db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
  }

  /** /remind edit: new time, repeat and text. It becomes active again and its failed attempts are forgotten. */
  update(id: number, change: { dueAt: number; repeat: Repeat; text: string }): void {
    this.#db
      .prepare("UPDATE reminders SET due_at = ?, repeat = ?, text = ?, done_at = NULL, retry_at = NULL, attempts = 0, last_error = NULL WHERE id = ?")
      .run(change.dueAt, change.repeat, change.text, id);
  }

  /** Pause or resume. A resumed daily/weekly reminder continues at its next regular time, skipping the missed ones. */
  setPaused(reminder: Reminder, paused: boolean, now = Date.now()): Reminder {
    const dueAt = paused || reminder.repeat === "none" ? reminder.dueAt : nextDue(reminder.dueAt, reminder.repeat, now, this.zone(reminder.chatId));
    this.#db.prepare("UPDATE reminders SET paused = ?, due_at = ?, retry_at = NULL, attempts = 0 WHERE id = ?").run(paused ? 1 : 0, dueAt, reminder.id);
    return { ...reminder, paused, dueAt };
  }

  /**
   * 💤 Remind again at `until`. A one-off reminder comes back itself; a daily/weekly one keeps
   * its schedule and gets a one-off copy. Returns the id of the reminder that will fire.
   */
  snooze(reminder: Reminder, until: number, now = Date.now()): number {
    if (reminder.repeat !== "none") return this.add({ ...reminder, dueAt: until, repeat: "none", ai: false }, now);
    this.#db
      .prepare("UPDATE reminders SET due_at = ?, done_at = NULL, paused = 0, retry_at = NULL, attempts = 0, last_error = NULL WHERE id = ?")
      .run(until, reminder.id);
    return reminder.id;
  }

  due(now = Date.now()): Reminder[] {
    return (
      this.#db
        .prepare(`SELECT * FROM reminders WHERE ${ACTIVE} AND paused = 0 AND due_at <= ? AND (retry_at IS NULL OR retry_at <= ?) ORDER BY due_at`)
        .all(now, now) as Row[]
    ).map(fromRow);
  }

  /** After delivery: repeating reminders move to their next time; one-off ones are kept a day for 💤 snooze. */
  delivered(reminder: Reminder, now = Date.now()): void {
    const history = "sent_count = sent_count + 1, last_sent_at = ?, retry_at = NULL, attempts = 0, last_error = NULL";
    if (reminder.repeat === "none") {
      this.#db.prepare(`UPDATE reminders SET done_at = ?, ${history} WHERE id = ?`).run(now, now, reminder.id);
    } else {
      const next = nextDue(reminder.dueAt, reminder.repeat, now, this.zone(reminder.chatId));
      this.#db.prepare(`UPDATE reminders SET due_at = ?, ${history} WHERE id = ?`).run(next, now, reminder.id);
    }
  }

  /**
   * A failed send is retried a minute later. The wait is kept in the database, so a restart
   * neither loses it nor resends early. After an hour it is given up: one-off reminders are
   * deleted, repeating ones skip to their next time. The error stays visible in /reminders.
   */
  failed(reminder: Reminder, error: string, now = Date.now()): void {
    const message = error.slice(0, 200);
    if (isPermanentSendError(error)) {
      // Removed from the group, chat deleted, no right to post: retrying can't help. A one-off reminder
      // goes; a repeating one is paused (kept, with the reason in /reminders) so it can be resumed.
      if (reminder.repeat === "none") return this.remove(reminder.id);
      this.#db.prepare("UPDATE reminders SET paused = 1, retry_at = NULL, attempts = 0, last_error = ? WHERE id = ?").run(message, reminder.id);
      return;
    }
    if (now - reminder.dueAt <= GIVE_UP_AFTER_MS) {
      this.#db.prepare("UPDATE reminders SET retry_at = ?, attempts = attempts + 1, last_error = ? WHERE id = ?").run(now + RETRY_AFTER_MS, message, reminder.id);
    } else if (reminder.repeat === "none") {
      this.remove(reminder.id);
    } else {
      const next = nextDue(reminder.dueAt, reminder.repeat, now, this.zone(reminder.chatId));
      this.#db.prepare("UPDATE reminders SET due_at = ?, retry_at = NULL, attempts = 0, last_error = ? WHERE id = ?").run(next, message, reminder.id);
    }
  }

  /** Delete delivered one-off reminders whose snooze window has passed. */
  prune(now = Date.now()): void {
    this.#db.prepare("DELETE FROM reminders WHERE done_at IS NOT NULL AND done_at < ?").run(now - KEEP_DELIVERED_MS);
  }

  forgetChat(chatId: number): number {
    return Number(this.#db.prepare("DELETE FROM reminders WHERE chat_id = ?").run(chatId).changes);
  }
}

/** Telegram refused for good: the bot was removed, the chat is gone, or it may not post there. */
export function isPermanentSendError(message: string): boolean {
  return /\b403\b|bot was kicked|bot is not a member|chat not found|have no rights to send|not enough rights to send|CHAT_WRITE_FORBIDDEN|user is deactivated|bot was blocked/i.test(message);
}

/**
 * The first time after `now` on the repeat schedule (skips missed ones instead of
 * firing a backlog). Steps by local calendar days, so 08:00 stays 08:00 across DST.
 */
export function nextDue(dueAt: number, repeat: Repeat, now: number, tz: string = timeZone()): number {
  if (dueAt > now || repeat === "none") return dueAt;
  const stepDays = repeat === "weekly" ? 7 : 1;
  // Jump close to `now` first (no long loops after downtime), then step until it's in the future.
  let steps = Math.max(1, Math.floor((now - dueAt) / (stepDays * DAY)));
  let next = addLocalDays(dueAt, steps * stepDays, tz);
  while (next <= now) next = addLocalDays(dueAt, ++steps * stepDays, tz);
  return next;
}

/** The system prompt for writing a scheduled post at its due time. */
export const SCHEDULED_POST_PROMPT = (now: number, tz: string = timeZone()) =>
  [
    "You write a scheduled post for a Telegram chat. Do the task below now and output only the post.",
    `Current time: ${formatLocalTime(now, tz)} (${tz}).`,
    "- Search the web for anything current (weather, news, prices, schedules) and keep facts accurate.",
    "- Short and skimmable: a few bullets or lines. Simple Markdown only, no tables.",
    "- Write in the language of the task.",
  ].join("\n");

export type ParsedReminder = { ok: true; dueAt: number; repeat: Repeat; text: string } | { ok: false; reason: string };

/** `current`: /remind edit, the reminder being changed; the answer is the complete updated reminder. */
export const REMINDER_SYSTEM_PROMPT = (now: number, tz: string = timeZone(), current?: Pick<Reminder, "dueAt" | "repeat" | "text">) =>
  [
    "You turn a reminder request from a Telegram chat into JSON.",
    `Current time: ${formatLocalTime(now, tz)} (${tz}).`,
    ...(current
      ? [
          `The request CHANGES this existing reminder: ${JSON.stringify({ at: `${localDay(current.dueAt, tz)} ${formatLocalClock(current.dueAt, tz)}`, repeat: current.repeat, text: current.text })}`,
          "Apply the change and output the complete updated reminder; keep every field the request doesn't mention.",
        ]
      : []),
    'Reply with only one JSON object: {"at":"YYYY-MM-DD HH:MM","repeat":"none|daily|weekly","text":"..."}',
    '- "at": the first time to remind, in that local time. If only a day is given, use 09:00. "in 2 hours" etc. count from the current time.',
    '- "repeat": "daily" or "weekly" only when the request says every day / every week (每天, 每週, 每個星期一…), else "none".',
    '- "text": what to remind about, short, in the language of the request, without the time words and without "remind me/us".',
    'If the request contains no understandable time, reply {"error":"<short reason>"}.',
  ].join("\n");

/** Validate Grok's JSON answer for a reminder request. */
export function parseReminderAnswer(answer: string, now: number, tz: string = timeZone()): ParsedReminder {
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
  const dueAt = localToUtc(y, mo, d, h, mi, tz);
  const repeat: Repeat = (REPEATS as readonly string[]).includes(String(data.repeat)) ? (data.repeat as Repeat) : "none";
  const text = typeof data.text === "string" ? data.text.trim().slice(0, 500) : "";
  if (!text) return { ok: false, reason: "nothing to remind about" };
  if (Number.isNaN(dueAt)) return { ok: false, reason: "no time found" };
  if (dueAt > now + MAX_AHEAD_MS) return { ok: false, reason: "that is more than a year away" };
  if (dueAt <= now) {
    // "every Monday 9:00" asked on Monday afternoon: start next week. A one-off time in the past is an error.
    if (repeat === "none") return { ok: false, reason: `${formatLocalTime(dueAt, tz)} has already passed` };
    return { ok: true, dueAt: nextDue(dueAt, repeat, now, tz), repeat, text };
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
 * `markup` adds buttons under a reminder (💤 snooze, ⏸ pause).
 */
export async function deliverDueReminders(
  store: ReminderStore,
  api: ReminderSender,
  isActive: (chatId: number) => boolean,
  render: (reminder: Reminder) => string | Promise<string>,
  now = Date.now(),
  markup?: (reminder: Reminder) => unknown,
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
      const keyboard = markup?.(reminder);
      await api.sendMessage(reminder.chatId, await render(reminder), {
        parse_mode: "HTML",
        // Scheduled posts stand on their own; plain reminders point back at the request.
        ...(reminder.messageId && !reminder.ai ? { reply_parameters: { message_id: reminder.messageId, allow_sending_without_reply: true } } : {}),
        ...(reminder.threadId ? { message_thread_id: reminder.threadId } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      store.delivered(reminder, now);
      sent++;
    } catch (error) {
      console.warn(`reminder ${reminder.id} failed: ${(error as Error).message}`);
      store.failed(reminder, (error as Error).message, now);
    }
  }
  return sent;
}
