/**
 * End-to-end check of reading Telegram files (run on the server): uploads a
 * short video, a voice note and a >20 MB audio file to a chat, reads each one
 * back through TelegramMedia (download to disk, ffmpeg, speech-to-text), then
 * deletes the test messages.
 * Usage: node scripts/e2e-telegram-media.ts <chat_id>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot, InputFile } from "grammy";
import { createApp } from "../src/app.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { TelegramMedia } from "../src/telegram/media.ts";

loadDotEnv();
const chatId = Number(process.argv[2]);
if (!chatId) throw new Error("usage: node scripts/e2e-telegram-media.ts <chat_id>");
const config = loadConfig();
const app = createApp(config);
const apiRoot = config.telegramApiRoot;
const bot = new Bot(config.botToken, apiRoot ? { client: { apiRoot } } : undefined);
const media = new TelegramMedia({ api: bot.api, token: config.botToken, grok: app.grok, video: app.video, apiRoot });

const dir = mkdtempSync(join(tmpdir(), "e2e-tg-"));
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...args]);
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "v.mp4"));
ff("-f", "lavfi", "-i", "sine=frequency=330", "-t", "4", "-c:a", "libopus", join(dir, "voice.ogg"));
ff("-f", "lavfi", "-i", "sine=frequency=550", "-t", "190", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", join(dir, "big.wav"));
console.log(`big.wav: ${(statSync(join(dir, "big.wav")).size / 1024 / 1024).toFixed(1)} MB`);

const sent: number[] = [];
async function step(name: string, task: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const out = await task();
    console.log(`OK   ${name} (${((Date.now() - started) / 1000).toFixed(1)} s): ${out}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

try {
  await step("video → frames + duration", async () => {
    const message = await bot.api.sendVideo(chatId, new InputFile(join(dir, "v.mp4")), { caption: "e2e test (will be deleted)" });
    sent.push(message.message_id);
    const info = await media.watchVideo(message, { frames: true });
    if (!info || !info.frames.length) throw new Error("no frames");
    return `${info.durationSec?.toFixed(1)} s, ${info.frames.length} frames, transcript: ${info.transcriptSource}`;
  });
  await step("voice note → speech-to-text", async () => {
    const message = await bot.api.sendVoice(chatId, new InputFile(join(dir, "voice.ogg")));
    sent.push(message.message_id);
    const result = await media.transcribeVoice(message);
    return `text: ${JSON.stringify(result?.text ?? null)}`;
  });
  await step(">20 MB audio file → compressed → speech-to-text", async () => {
    const message = await bot.api.sendAudio(chatId, new InputFile(join(dir, "big.wav"), "big.wav"));
    sent.push(message.message_id);
    const result = await media.transcribeVoice(message);
    return `file ${(message.audio!.file_size! / 1024 / 1024).toFixed(1)} MB, text: ${JSON.stringify(result?.text ?? null)}`;
  });
} finally {
  for (const id of sent) await bot.api.deleteMessage(chatId, id).catch(() => undefined);
  execFileSync("rm", ["-rf", dir]);
  app.db.close();
}
