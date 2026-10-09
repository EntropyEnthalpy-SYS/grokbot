/**
 * Local time. The bot's default zone is TIMEZONE (an IANA name such as
 * "Asia/Taipei" or "America/New_York"); each chat can override it with /tz.
 * Every function takes an optional zone and falls back to the default.
 * Daylight saving time is handled through Intl.
 */
let zone = "Asia/Taipei";

/** The canonical IANA name for user input: exact names in any case, or a city ("taipei", "New York"). */
export function findTimeZone(input: string): string | undefined {
  const wanted = input.trim().replace(/\s+/g, "_").toLowerCase();
  if (!wanted) return undefined;
  const zones = [...Intl.supportedValuesOf("timeZone"), "UTC"];
  const exact = zones.find((z) => z.toLowerCase() === wanted);
  if (exact) return exact;
  const city = zones.filter((z) => z.toLowerCase().endsWith(`/${wanted}`));
  if (city.length === 1) return city[0];
  try {
    // Names Intl accepts but doesn't list (aliases such as "Asia/Calcutta").
    return new Intl.DateTimeFormat("en-US", { timeZone: input.trim() }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function setTimeZone(name: string): void {
  const found = findTimeZone(name);
  if (!found) throw new Error(`Unknown TIMEZONE "${name}". Use an IANA name such as Asia/Taipei or Europe/Berlin.`);
  zone = found;
}

/** The bot's default zone. */
export function timeZone(): string {
  return zone;
}

/** "Asia/Taipei" → "Taipei", "America/New_York" → "New York": for labels like "(Taipei time)". */
export function zoneLabel(tz: string = zone): string {
  return (tz.split("/").at(-1) ?? tz).replace(/_/g, " ");
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; weekday: string };

const formatters = new Map<string, Intl.DateTimeFormat>();

function wall(ms: number, tz: string): Wall {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(tz, format);
  }
  const parts = Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: String(parts.weekday),
  };
}

/** How far (ms) the zone is ahead of UTC at this instant. */
function offsetMs(ms: number, tz: string): number {
  const w = wall(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(ms / 60_000) * 60_000;
}

/** A local wall-clock time (month 1-12; day/hour overflow is fine) → UTC milliseconds. */
export function localToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string = zone): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - offsetMs(asUtc, tz);
  // Second pass: the offset at the result can differ around a DST change.
  return asUtc - offsetMs(first, tz);
}

/** "2026-10-09": the local calendar day of an instant. */
export function localDay(ms: number, tz: string = zone): string {
  const w = wall(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** "2026-10-09 Fri 14:05" in local time, for Grok and for users. */
export function formatLocalTime(ms: number, tz: string = zone): string {
  const w = wall(ms, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${localDay(ms, tz)} ${w.weekday} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** "HH:MM" local time. */
export function formatLocalClock(ms: number, tz: string = zone): string {
  return formatLocalTime(ms, tz).slice(-5);
}

/** The same local clock time `days` calendar days later (keeps 08:00 at 08:00 across DST). */
export function addLocalDays(ms: number, days: number, tz: string = zone): number {
  const w = wall(ms, tz);
  return localToUtc(w.year, w.month, w.day + days, w.hour, w.minute, tz);
}

/** "in 45 min", "in 3 h 10 min", "in 2 days": how far away a time is, for confirmations. */
export function formatFromNow(at: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 60) return `in ${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
