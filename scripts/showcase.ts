/**
 * Post one example of every automatic feature into a group, through the same
 * code the bot uses, and log each message so people can reply to it and ask
 * the bot about it. Ends with a checklist of the features a person triggers.
 * Usage: node scripts/showcase.ts <group chat id>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api, InputFile } from "grammy";
import { createApp } from "../src/app.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { languageName } from "../src/lang.ts";
import { summarizeLink, videoCardFromInfo } from "../src/links/summarize.ts";
import { buildXCard, needsTranslation, sendXCard } from "../src/links/xcard.ts";
import { fetchXPost } from "../src/links/xpost.ts";
import { ReplyStreamer } from "../src/telegram/streamer.ts";

loadDotEnv();
const config = loadConfig();
const chatId = Number(process.argv[2]);
if (!(chatId < 0)) throw new Error("usage: node scripts/showcase.ts <group chat id>");
const app = createApp(config);
const api = new Api(config.botToken, config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : undefined);
const me = await api.getMe();
const lang = app.groups.language(chatId);
const deps = { db: app.db, grok: app.grok, reader: app.reader, video: app.video };

function log(messageId: number, text: string): void {
  app.groups.log(chatId, 0, { messageId, userId: me.id, name: me.first_name, text, isBot: true, at: Date.now() });
}

async function say(text: string): Promise<number> {
  const sent = await api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  return sent.message_id;
}

async function step(title: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
    console.log(`ok   ${title}`);
  } catch (error) {
    console.log(`FAIL ${title}: ${(error as Error).message}`);
    await say(`⚠️ ${title}: ${(error as Error).message.slice(0, 200)}`);
  }
}

await say(`🧪 <b>Showcase</b>: automatic features, one by one. Language: ${lang} (${languageName(lang)}).`);

async function xCard(label: string, url: string): Promise<void> {
  const intro = await say(`${label}\n${url}`);
  const post = await fetchXPost(url, fetch, undefined, lang === "off" ? undefined : lang);
  const translation = needsTranslation(post, lang) ? post.translation : undefined;
  const card = buildXCard(post, translation);
  const { ids } = await sendXCard(api, chatId, card, { reply_parameters: { message_id: intro, allow_sending_without_reply: true } });
  for (const id of ids) log(id, `[content of ${url}]\n${card.plain}`);
}

await step("X post with a chart", () => xCard("1️⃣ <b>X post with images</b> → original media + text + translation", "https://x.com/ArtificialAnlys/status/2107911905822351609"));
await step("X post with a video", () => xCard("2️⃣ <b>X post with a video</b> → the real video", "https://x.com/elonmusk/status/1585341984679469056"));

async function linkCard(label: string, url: string): Promise<void> {
  const intro = await say(`${label}\n${url}`);
  const card = await summarizeLink(deps, url, lang);
  const ids = await new ReplyStreamer(api, chatId, { replyTo: intro }).finish(card);
  for (const id of ids) log(id, `[content of ${url}]\n${card}`);
}

await step("web article", () => linkCard("3️⃣ <b>Web article</b> → neutral 🔗 card (Tavily)", "https://en.wikipedia.org/wiki/Golden_Gate_Bridge"));
await step("YouTube", () => linkCard("4️⃣ <b>YouTube</b> → 🎬 card from subtitles, with timestamps", "https://www.youtube.com/watch?v=8S0FDjFBj8o"));
await step("TikTok", () => linkCard("5️⃣ <b>TikTok</b> (no subtitles) → 🎬 card from speech-to-text", "https://www.tiktok.com/@scout2015/video/6718335390845095173"));

const work = mkdtempSync(join(tmpdir(), "showcase-"));

await step("voice message", async () => {
  execFileSync("yt-dlp", ["-f", "ba/wa/w", "--no-warnings", "--no-progress", "-o", join(work, "a.%(ext)s"), "--", "https://www.youtube.com/watch?v=jNQXAC9IVRw"]);
  const source = execFileSync("sh", ["-c", `ls ${work}/a.*`], { encoding: "utf8" }).trim();
  const ogg = join(work, "voice.ogg");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", source, "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", ogg]);
  await say("6️⃣ <b>Voice message</b> → transcript + translation (a sample voice note follows)");
  const voice = await api.sendVoice(chatId, new InputFile(ogg));
  log(voice.message_id, "[voice message]");
  const result = await app.grok.transcribe(new Blob([readFileSync(ogg)]), "voice.ogg");
  const translation = needsTranslation({ text: result.text, lang: result.language }, lang)
    ? await app.grok.ask(`Translate the user's text into ${languageName(lang)}. Output only the translation.`, result.text)
    : undefined;
  const body = translation ? `🎙️ ${result.text}\n\n🌐 ${translation}` : `🎙️ ${result.text}`;
  const sent = await api.sendMessage(chatId, body, { reply_parameters: { message_id: voice.message_id } });
  log(voice.message_id, `[voice message] 🎙️ ${result.text}`);
  log(sent.message_id, `[transcript of a voice message]\n${body}`);
});

await step("uploaded video", async () => {
  const post = await fetchXPost("https://x.com/elonmusk/status/1585341984679469056");
  const videoUrl = post.videos[0]?.url;
  if (!videoUrl) throw new Error("sample post has no video");
  const mp4 = join(work, "clip.mp4");
  execFileSync("curl", ["-sSfL", "--max-time", "60", "-o", mp4, videoUrl]);
  await say("7️⃣ <b>Video uploaded to the group</b> → 🎬 card from speech + frames");
  const video = await api.sendVideo(chatId, new InputFile(mp4), { caption: "sample upload" });
  log(video.message_id, "[video] sample upload");
  const info = await app.video.watchFile(mp4, { frames: true, title: "sample upload", uploader: `uploaded by ${me.first_name}` });
  const card = await videoCardFromInfo(app.grok, "telegram-video", info, lang);
  const ids = await new ReplyStreamer(api, chatId, { replyTo: video.message_id }).finish(card);
  for (const id of ids) log(id, `[content of an uploaded video]\n${card}`);
});

await say(
  [
    "✅ <b>Now try these yourself</b> (I can't trigger myself):",
    "",
    "<b>Ask &amp; comment</b>",
    "• Reply to any card above: <code>這代表什麼？</code> / <code>is this true?</code>",
    `• <code>@${me.username} 今天台北天氣？</code> (web search)`,
    "• <code>grok, 最新的 xAI 新聞</code> (X search, name trigger)",
    "• Reply to the voice note or the video: <code>重點是什麼？</code>",
    "• Reply to the YouTube card: <code>他在 2:30 說了什麼？</code> (watches the video)",
    "• Send a photo with caption <code>@" + me.username + " 這是什麼？</code>",
    "• Reply to someone's message with <code>@" + me.username + " 幫我翻譯成英文</code>",
    "",
    "<b>Automatic</b>",
    "• Post any link (X, news, YouTube, TikTok) → content card, no comments",
    "• Send a voice note → 🎙️ transcript; start it with “Grok,” to ask a question by voice",
    "• Upload a short video → 🎬 card",
    "",
    "<b>Settings (owner)</b>: /status /links mention /voice off /lang en /new /stop /help",
  ].join("\n"),
);
app.db.close();
console.log("done");
