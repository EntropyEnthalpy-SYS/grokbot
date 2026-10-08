import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./run.ts";

/** Spoken replies stop at about this many characters (long answers stay text-only after that). */
export const MAX_SPOKEN_CHARS = 900;

/**
 * The part of a Markdown answer worth saying out loud: no code, links, URLs or
 * formatting marks, cut at a sentence end before `max` characters.
 */
export function speakableText(markdown: string, max = MAX_SPOKEN_CHARS): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~>|]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(...["。", "！", "？", ". ", "! ", "? ", "\n"].map((mark) => cut.lastIndexOf(mark)));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
}

/** MP3 from xAI → OGG/Opus, the format Telegram shows as a voice note. */
export async function toVoiceNote(mp3: Buffer, ffmpeg = "ffmpeg"): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "grokbot-tts-"));
  try {
    const input = join(dir, "in.mp3");
    const output = join(dir, "out.ogg");
    await writeFile(input, mp3);
    await run(ffmpeg, ["-nostdin", "-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", output], {
      timeoutMs: 60_000,
    });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
