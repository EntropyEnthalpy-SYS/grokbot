/**
 * Live check of image creation through the chat agent (run on the server):
 * asks Grok to draw, then to change its drawing, and posts both to a chat.
 * Usage: node scripts/probe-images.ts <chat_id>
 */
import { Bot, InputFile } from "grammy";
import { createApp } from "../src/app.ts";
import { assistantText } from "../src/grok/grok.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";

loadDotEnv();
const chatId = Number(process.argv[2]);
if (!chatId) throw new Error("usage: node scripts/probe-images.ts <chat_id>");
const config = loadConfig();
const app = createApp(config);
const bot = new Bot(config.botToken, config.telegramApiRoot ? { client: { apiRoot: config.telegramApiRoot } } : undefined);
const key = `tg:${chatId}:probe-images`;

for (const request of ["畫一隻戴太空頭盔的柴犬，水彩風格", "把它改成鉛筆素描"]) {
  const started = Date.now();
  let turn: ReturnType<typeof app.images.begin> | undefined;
  const tools: string[] = [];
  const reply = await app.sessions.run(key, { text: request }, {
    onStart: () => (turn = app.images.begin(key, { unlimited: true })),
    onTool: (name) => tools.push(name),
  });
  const created = turn ? app.images.end(turn) : [];
  const text = assistantText(reply);
  console.log(`${request} → tools [${tools.join(", ")}], ${created.length} image(s), ${((Date.now() - started) / 1000).toFixed(1)} s, reply: ${text.slice(0, 80)}`);
  for (const image of created) await bot.api.sendPhoto(chatId, new InputFile(image, "image.jpg"), { caption: `image check: ${request}` });
}
app.sessions.reset(key);
app.db.close();
