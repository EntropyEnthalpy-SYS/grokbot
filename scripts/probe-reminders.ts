/**
 * Live check of reminder parsing and /tr prompts against real Grok (run on the server).
 * Usage: node scripts/probe-reminders.ts [chat_id]  — with a chat id, also schedules a real reminder 30 s ahead there.
 */
import { createApp } from "../src/app.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { formatLocalTime, parseReminderAnswer, REMINDER_SYSTEM_PROMPT, ReminderStore } from "../src/reminders.ts";

loadDotEnv();
const app = createApp(loadConfig());
const now = Date.now();
console.log(`now: ${formatLocalTime(now)} Taipei`);
for (const request of ["提醒我們週五晚上8點開會", "remind me in 2 hours to call mom", "每週一早上10點 提醒交週報", "明天提醒我繳電費", "remind us about the thing"]) {
  const answer = await app.grok.ask(REMINDER_SYSTEM_PROMPT(now), request);
  const parsed = parseReminderAnswer(answer, now);
  console.log(`${request}\n  -> ${parsed.ok ? `${formatLocalTime(parsed.dueAt)} ${parsed.repeat} "${parsed.text}"` : `refused: ${parsed.reason}`}`);
}
const tr = (lang: string) =>
  `Translate the user's text into ${lang}. If it is already in ${lang}, translate it into English instead. Output only the translation, nothing else.`;
console.log(`tr zh-tw: ${await app.grok.ask(tr("Traditional Chinese (Taiwan)"), "The meeting is moved to Friday night.")}`);
console.log(`tr zh-tw (already Chinese): ${await app.grok.ask(tr("Traditional Chinese (Taiwan)"), "會議改到週五晚上。")}`);
const chatId = Number(process.argv[2]);
if (chatId) {
  const id = new ReminderStore(app.db).add({ chatId, threadId: 0, messageId: null, userId: null, userName: "deploy check", text: "測試提醒 / test reminder (/reminders works)", dueAt: Date.now() + 30_000, repeat: "none" });
  console.log(`scheduled reminder ${id} in 30 s`);
}
app.db.close();
