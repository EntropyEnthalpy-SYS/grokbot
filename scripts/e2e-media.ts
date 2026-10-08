/**
 * End-to-end check of phase 3 against the real services (run on the server):
 * YouTube via subtitles, TikTok via speech-to-text, an X video, and a voice
 * note. Prints each card; changes nothing except the link cache.
 * Usage: node scripts/e2e-media.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { loadDotEnv } from "../src/config.ts";
import { summarizeLink, videoCardFromInfo } from "../src/links/summarize.ts";
import { fetchXPost } from "../src/links/xpost.ts";

loadDotEnv();
const app = createApp({
  dataDir: process.env.DATA_DIR?.trim() || "./data",
  defaultModel: process.env.GROK_MODEL?.trim() || "grok-4.7",
  tavilyKey: process.env.TAVILY_API_KEY?.trim() || undefined,
});
const deps = { db: app.db, grok: app.grok, reader: app.reader, video: app.video };
app.db.prepare("DELETE FROM link_cache WHERE url LIKE 'video:%' OR url LIKE '%youtube%' OR url LIKE '%tiktok%'").run();

async function step(name: string, task: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const out = await task();
    console.log(`\n=== ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)\n${out}`);
  } catch (error) {
    console.log(`\n=== ${name} FAILED (${((Date.now() - started) / 1000).toFixed(1)} s): ${(error as Error).message}`);
  }
}

await step("YouTube link (subtitles)", async () => {
  const info = await app.video.watchUrl("https://www.youtube.com/watch?v=8S0FDjFBj8o", { preferLanguage: "zh-tw" });
  return `source=${info.transcriptSource}, transcript ${info.transcript?.length ?? 0} chars\n` +
    (await summarizeLink(deps, "https://www.youtube.com/watch?v=8S0FDjFBj8o", "zh-tw"));
});

await step("TikTok link (speech-to-text, no subtitles)", async () => {
  const info = await app.video.watchUrl("https://www.tiktok.com/@scout2015/video/6718335390845095173");
  return `source=${info.transcriptSource}: ${info.transcript?.slice(0, 160)}\n` +
    (await summarizeLink(deps, "https://www.tiktok.com/@scout2015/video/6718335390845095173", "zh-tw"));
});

await step("X post video (direct mp4, speech + frames)", async () => {
  const post = await fetchXPost("https://x.com/elonmusk/status/1585341984679469056");
  const mp4 = post.videos[0]?.url;
  if (!mp4) throw new Error("no mp4 in post");
  const info = await app.video.watchUrl(mp4, { frames: true });
  return `source=${info.transcriptSource}, frames=${info.frames.length}: ${info.transcript ?? "(none)"}\n` +
    (await videoCardFromInfo(app.grok, mp4, info, "zh-tw"));
});

await step("Voice note (ogg/opus, like Telegram)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-voice-"));
  const ogg = join(dir, "voice.ogg");
  execFileSync("yt-dlp", ["-f", "ba/wa/w", "--no-warnings", "--no-progress", "-o", join(dir, "a.%(ext)s"), "--", "https://www.youtube.com/watch?v=jNQXAC9IVRw"]);
  const source = execFileSync("sh", ["-c", `ls ${dir}/a.*`], { encoding: "utf8" }).trim();
  execFileSync("ffmpeg", ["-loglevel", "error", "-i", source, "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", ogg]);
  const result = await app.grok.transcribe(new Blob([readFileSync(ogg)]), "voice.ogg");
  return `language=${result.language}, ${result.duration}s: ${result.text}`;
});

app.db.close();
