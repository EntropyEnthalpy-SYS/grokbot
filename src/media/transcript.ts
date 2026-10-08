/**
 * Turn subtitles or word timings into a compact transcript with a [mm:ss]
 * marker roughly every 30 seconds, so Grok can cite where things are said.
 */

export interface TimedText {
  start: number;
  text: string;
}

const MARK_EVERY_SECONDS = 30;

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
  return h ? `${h}:${mmss}` : mmss;
}

/**
 * Parse WebVTT. Handles YouTube auto-captions, where each cue repeats the
 * previous line and adds inline word timings (`<00:00:19.720><c> that?</c>`):
 * tags are stripped and lines already seen in the previous cue are skipped.
 */
export function parseVtt(vtt: string): TimedText[] {
  const out: TimedText[] = [];
  let previous: string[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing === -1) continue;
    const start = parseVttTime(lines[timing]!.split("-->")[0]!.trim());
    const textLines = lines
      .slice(timing + 1)
      .map((line) => decode(line.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const fresh = textLines.filter((line) => !previous.includes(line));
    previous = textLines;
    for (const text of fresh) {
      if (out.at(-1)?.text !== text) out.push({ start, text });
    }
  }
  return out;
}

function parseVttTime(raw: string): number {
  const parts = raw.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function decode(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

/** Speech-to-text words → timed text, one entry per word. */
export function wordsToTimed(words: readonly { text: string; start: number }[]): TimedText[] {
  return words.map((word) => ({ start: word.start, text: word.text }));
}

/** "[0:00] Hear that? That's nothing. [0:31] …" */
export function joinTimed(items: readonly TimedText[]): string {
  const parts: string[] = [];
  let nextMark = 0;
  for (const item of items) {
    if (item.start >= nextMark) {
      parts.push(`${parts.length ? "\n" : ""}[${formatTimestamp(item.start)}]`);
      nextMark = Math.floor(item.start / MARK_EVERY_SECONDS) * MARK_EVERY_SECONDS + MARK_EVERY_SECONDS;
    }
    parts.push(item.text);
  }
  return parts.join(" ").replace(/ \n/g, "\n").trim();
}
