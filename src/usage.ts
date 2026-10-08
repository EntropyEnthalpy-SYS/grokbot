import { getSetting, setSetting, type Db } from "./db.ts";
import { PermissionStore } from "./permissions.ts";
import { localDay } from "./time.ts";

const KEEP_DAYS = 90;

/** Usage days start at local midnight (TIMEZONE). */
export { localDay as usageDay };

/** What is counted per member: questions, created images, /tr, voice seconds transcribed, link/video cards, spoken replies. */
export const USAGE_KINDS = ["question", "image", "tr", "voice_sec", "card", "tts"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export interface MemberUsage {
  userId: number;
  name: string;
  counts: Partial<Record<UsageKind, number>>;
}

export interface ProviderTokens {
  provider: string;
  input: number;
  output: number;
  requests: number;
}

/**
 * Daily usage counters: per member (what they used) and per AI provider (tokens).
 * Only counts and display names are stored, never message content; rows older
 * than 90 days are pruned.
 */
export class UsageStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  record(chatId: number, user: { id?: number; name: string }, kind: UsageKind, amount = 1, now = Date.now()): void {
    this.#add(localDay(now), chatId, user.id ?? 0, user.name, kind, amount);
  }

  recordTokens(provider: string, input: number, output: number, now = Date.now()): void {
    const day = localDay(now);
    this.#add(day, 0, 0, provider, `tokens_in.${provider}`, input);
    this.#add(day, 0, 0, provider, `tokens_out.${provider}`, output);
    this.#add(day, 0, 0, provider, `requests.${provider}`, 1);
  }

  /** Per-member totals over the last `days` days (today included), most active first. */
  members(days: number, now = Date.now(), chatId?: number): MemberUsage[] {
    const rows = this.#db
      .prepare(
        `SELECT user_id, MAX(user_name) AS name, kind, SUM(amount) AS total FROM usage
         WHERE day >= ? AND user_id != 0 AND kind NOT LIKE '%.%' ${chatId === undefined ? "" : "AND chat_id = ?"}
         GROUP BY user_id, kind`,
      )
      .all(...([localDay(now - (days - 1) * 86_400_000), ...(chatId === undefined ? [] : [chatId])] as [string, ...number[]])) as {
      user_id: number;
      name: string;
      kind: UsageKind;
      total: number;
    }[];
    const byUser = new Map<number, MemberUsage>();
    for (const row of rows) {
      const entry = byUser.get(Number(row.user_id)) ?? { userId: Number(row.user_id), name: row.name, counts: {} };
      entry.counts[row.kind] = Number(row.total);
      byUser.set(entry.userId, entry);
    }
    const weight = (m: MemberUsage) => (m.counts.question ?? 0) + (m.counts.image ?? 0) * 3 + (m.counts.tr ?? 0);
    return [...byUser.values()].sort((a, b) => weight(b) - weight(a));
  }

  member(userId: number, days: number, now = Date.now()): MemberUsage {
    return this.members(days, now).find((m) => m.userId === userId) ?? { userId, name: "", counts: {} };
  }

  providers(days: number, now = Date.now()): ProviderTokens[] {
    const rows = this.#db
      .prepare("SELECT kind, SUM(amount) AS total FROM usage WHERE day >= ? AND kind LIKE '%.%' GROUP BY kind")
      .all(localDay(now - (days - 1) * 86_400_000)) as { kind: string; total: number }[];
    const byProvider = new Map<string, ProviderTokens>();
    for (const row of rows) {
      const [field, provider] = row.kind.split(".") as [string, string];
      const entry = byProvider.get(provider) ?? { provider, input: 0, output: 0, requests: 0 };
      if (field === "tokens_in") entry.input = Number(row.total);
      if (field === "tokens_out") entry.output = Number(row.total);
      if (field === "requests") entry.requests = Number(row.total);
      byProvider.set(provider, entry);
    }
    return [...byProvider.values()].sort((a, b) => b.requests - a.requests);
  }

  prune(now = Date.now()): void {
    this.#db.prepare("DELETE FROM usage WHERE day < ?").run(localDay(now - KEEP_DAYS * 86_400_000));
  }

  forgetChat(chatId: number): void {
    this.#db.prepare("DELETE FROM usage WHERE chat_id = ?").run(chatId);
  }

  #add(day: string, chatId: number, userId: number, name: string, kind: string, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.#db
      .prepare(
        "INSERT INTO usage (day, chat_id, user_id, user_name, kind, amount) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(day, chat_id, user_id, kind) DO UPDATE SET amount = amount + excluded.amount, user_name = excluded.user_name",
      )
      .run(day, chatId, userId, name, kind, amount);
  }
}

/** Limits the owner can change in /admin → ⚖️ Limits. */
export const LIMITS = {
  questionsPerUserHour: { label: "Questions per member / hour", short: "Q/member/h", default: 20, step: 5, min: 1, max: 500 },
  questionsPerGroupHour: { label: "Questions per group / hour", short: "Q/group/h", default: 60, step: 10, min: 5, max: 2000 },
  imagesPerUserDay: { label: "Images per member / day", short: "Images/day", default: 10, step: 2, min: 0, max: 200 },
  autoCardsPerGroupHour: { label: "Link/video cards per group / hour", short: "Cards/h", default: 20, step: 5, min: 0, max: 500 },
  autoVoicePerGroupHour: { label: "Voice transcripts per group / hour", short: "Voice/h", default: 30, step: 5, min: 0, max: 500 },
} as const;
export type LimitName = keyof typeof LIMITS;

/** Current limits (settings) and trusted members (no limits, like the owner). */
export class LimitStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(name: LimitName): number {
    const value = Number(getSetting(this.#db, `limit.${name}`));
    return Number.isFinite(value) && getSetting(this.#db, `limit.${name}`) !== undefined ? value : LIMITS[name].default;
  }

  set(name: LimitName, value: number): number {
    const { min, max } = LIMITS[name];
    const clamped = Math.min(max, Math.max(min, Math.round(value)));
    setSetting(this.#db, `limit.${name}`, String(clamped));
    return clamped;
  }

  /** Step a limit up (+1) or down (-1) by its step size. */
  nudge(name: LimitName, direction: 1 | -1): number {
    return this.set(name, this.get(name) + direction * LIMITS[name].step);
  }

  /** Trusted members (the ⭐ permission; stored with the other permissions). */
  trusted(): Set<number> {
    return new PermissionStore(this.#db).ids("trusted");
  }

  setTrusted(userId: number, on: boolean): void {
    new PermissionStore(this.#db).set(userId, "trusted", on);
  }
}
