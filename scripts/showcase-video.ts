/**
 * Post video-link cards (YouTube etc.) into a group through the bot's code.
 * Usage: node scripts/showcase-video.ts <group chat id> <url> [url ...]
 */
import { Api } from "grammy";
import { createApp } from "../src/app.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { CardCache } from "../src/links/cardCache.ts";
import { sendPlainVideoCard } from "../src/links/videocard.ts";

loadDotEnv();
const config = loadConfig();
const [chatArg, ...urls] = process.argv.slice(2);
const chatId = Number(chatArg);
const app = createApp(config);
const api = new Api(config.botToken, config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : undefined);
const me = await api.getMe();
const cache = new CardCache(app.db);
for (const url of urls) {
  const started = Date.now();
  const intro = await api.sendMessage(chatId, url, { link_preview_options: { is_disabled: true } });
  try {
    const sent = await sendPlainVideoCard(
      {
        video: app.video,
        api,
        limits: { photoBytes: 10 * 1024 * 1024, videoBytes: config.maxUploadMb * 1024 * 1024 },
        cache,
        mediaDir: `${config.dataDir}/media`,
      },
      chatId,
      url,
      { reply_parameters: { message_id: intro.message_id } },
    );
    for (const id of sent.ids) app.groups.log(chatId, 0, { messageId: id, userId: me.id, name: me.first_name, text: `[content of ${url}]\n${sent.plain}`, isBot: true, at: Date.now() });
    console.log(`ok   ${((Date.now() - started) / 1000).toFixed(1)}s ${url} (${sent.ids.length} message(s))`);
  } catch (error) {
    console.log(`FAIL ${url}: ${(error as Error).message.slice(0, 200)}`);
  }
}
app.db.close();
