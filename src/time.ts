/**
 * The bot's local time zone (TIMEZONE, an IANA name such as "Asia/Taipei" or
 * "America/New_York"): reminders, usage days, dates shown to users and the date
 * in prompts all use it. Daylight saving time is handled through Intl.
 */
let zone = "Asia/Taipei";

export function setTimeZone(name: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
  } catch {
    throw new Error(`Unknown TIMEZONE "${name}". Use an IANA name such as Asia/Taipei or Europe/Berlin.`);
  }
  zone = name;
}

export function timeZone(): string {
  return zone;
}

/** "Asia/Taipei" → "Taipei", "America/New_York" → "New York": for labels like "(Taipei time)". */
export function zoneLabel(): string {
  return (zone.split("/").at(-1) ?? zone).replace(/_/g, " ");
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; weekday: string };

function wall(ms: number): Wall {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
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
function offsetMs(ms: number): number {
  const w = wall(ms);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(ms / 60_000) * 60_000;
}

/** A local wall-clock time (month 1-12; day/hour overflow is fine) → UTC milliseconds. */
export function localToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - offsetMs(asUtc);
  // Second pass: the offset at the result can differ around a DST change.
  return asUtc - offsetMs(first);
}

/** "2026-10-09": the local calendar day of an instant. */
export function localDay(ms: number): string {
  const w = wall(ms);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** "2026-10-09 Fri 14:05" in local time, for Grok and for users. */
export function formatLocalTime(ms: number): string {
  const w = wall(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${localDay(ms)} ${w.weekday} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** The same local clock time `days` calendar days later (keeps 08:00 at 08:00 across DST). */
export function addLocalDays(ms: number, days: number): number {
  const w = wall(ms);
  return localToUtc(w.year, w.month, w.day + days, w.hour, w.minute);
}
