/**
 * Live check of the newer features against the real services (run on the server):
 * ops runner, group command menu (ephemeral flags), streaming draft, ephemeral
 * group message, voice reply (TTS), poll, scheduled-post writing, backup.
 * Sends a few clearly labelled test messages to the owner and the given test group.
 * Usage: node scripts/probe-features.ts <test_group_id>
 */
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { Bot, InputFile } from "grammy";
import { createApp } from "../src/app.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { toVoiceNote, speakableText } from "../src/media/tts.ts";
import { backupWithoutSecrets, OpsClient } from "../src/ops.ts";
import { SCHEDULED_POST_PROMPT } from "../src/reminders.ts";

loadDotEnv();
const group = Number(process.argv[2]);
const config = loadConfig();
const app = createApp(config);
const bot = new Bot(config.botToken, config.telegramApiRoot ? { client: { apiRoot: config.telegramApiRoot } } : undefined);
const owner = config.ownerId;

async function step(name: string, task: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const out = await task();
    console.log(`OK   ${name} (${((Date.now() - started) / 1000).toFixed(1)} s): ${out}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${(error as Error).message.split("\n")[0]}`);
  }
}

const ops = new OpsClient(`${config.dataDir}/ops`);
await step("ops runner: status", async () => {
  const r = await ops.run("status", 30_000);
  if (!r) throw new Error("no answer from grokbot-ops.path");
  return r.output.replace(/\n/g, " | ");
});
await step("ops runner: logs", async () => {
  const r = await ops.run("logs", 30_000);
  if (!r) throw new Error("no answer");
  return `${r.output.split("\n").length} line(s), first: ${r.output.split("\n")[0]?.slice(0, 90)}`;
});
await step("group command menu has ephemeral commands", async () => {
  const commands = await bot.api.getMyCommands({ scope: { type: "all_group_chats" } });
  const ephemeral = commands.filter((c) => (c as { is_ephemeral?: boolean }).is_ephemeral).map((c) => c.command);
  if (ephemeral.length === 0) throw new Error(`no ephemeral commands among ${commands.length}`);
  return `${commands.length} commands, ephemeral: ${ephemeral.join(",")}`;
});
await step("streaming draft in private chat", async () => {
  const id = 1 + Math.floor(Math.random() * 1e9);
  await bot.api.sendMessageDraft(owner, id, "", { can_stop: true });
  await bot.api.sendMessageDraft(owner, id, "🧪 draft test: streaming…", { can_stop: true });
  const sent = await bot.api.sendMessage(owner, "🧪 draft test: final message (you can ignore this)");
  return `drafts accepted, final message ${sent.message_id}`;
});
await step("ephemeral message in the test group (needs the bot to be an admin there)", async () => {
  const sent = await bot.api.sendMessage(group, "🧪 private test: only you can see this", { ephemeral_message_parameters: { receiver_user_id: owner } } as never);
  return `sent, ephemeral id ${(sent as { ephemeral_message_id?: number }).ephemeral_message_id}`;
});
await step("voice reply (xAI TTS → voice note)", async () => {
  const text = speakableText("**測試** 這是語音回覆測試。The bot can answer by voice.");
  const voice = await toVoiceNote(await app.grok.speak(text));
  await bot.api.sendVoice(owner, new InputFile(voice, "reply.ogg"), { caption: "🧪 voice reply test" });
  return `${voice.length} bytes OGG for "${text}"`;
});
await step("poll in the test group", async () => {
  const sent = await bot.api.sendPoll(group, "🧪 poll test: 晚餐吃什麼？", [{ text: "拉麵" }, { text: "火鍋" }, { text: "壽司" }], { is_anonymous: false });
  return `poll message ${sent.message_id}`;
});
await step("scheduled post written with web search", async () => {
  const answer = await app.grok.ask(SCHEDULED_POST_PROMPT(Date.now()), "台北今天天氣（三行以內）", { search: true });
  return answer.replace(/\s+/g, " ").slice(0, 160);
});
await step("backup without logins", async () => {
  const path = backupWithoutSecrets(app.db, `${config.dataDir}/backups`);
  const copy = new DatabaseSync(path);
  const creds = (copy.prepare("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n;
  const tables = (copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n;
  copy.close();
  unlinkSync(path);
  if (creds !== 0) throw new Error(`${creds} credentials in the backup!`);
  return `${tables} tables, 0 credentials`;
});
app.db.close();
