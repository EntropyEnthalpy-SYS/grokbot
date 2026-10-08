/**
 * Post one ParseHub card per platform into a group, through the bot's code, and
 * log them so people can reply and ask about them.
 * Usage: node scripts/showcase-social.ts <group chat id> [url ...]
 */
import { Api } from "grammy";
import { bilibiliDownloader, createApp } from "../src/app.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { languageName } from "../src/lang.ts";
import { sendPostCard } from "../src/links/postcard.ts";

const SAMPLES = [
  "https://www.douyin.com/video/7615533976798727464",
  "https://weibo.com/tv/show/1034:5307969483767845",
  "https://v.m.chenzhongtech.com/fw/photo/3xbr5pi8hxi4e6s",
  "https://tieba.baidu.com/p/9939510114",
  "https://www.douban.com/group/topic/495373106/",
  "https://www.xiaoheihe.cn/app/bbs/link/174972336",
  "https://share.xiaochuankeji.cn/hybrid/share/post?pid=393346270",
  "https://www.facebook.com/reel/761988213517369",
  "https://www.bilibili.com/video/BV1R6NFzXE1H",
];

loadDotEnv();
const config = loadConfig();
const chatId = Number(process.argv[2]);
if (!(chatId < 0)) throw new Error("usage: node scripts/showcase-social.ts <group chat id> [url ...]");
const urls = process.argv.length > 3 ? process.argv.slice(3) : SAMPLES;
const app = createApp(config);
if (!app.parsehub) throw new Error("PARSEHUB_URL is not set");
const api = new Api(config.botToken, config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : undefined);
const me = await api.getMe();
const lang = app.groups.language(chatId);
const translate = async (text: string, target: string) =>
  app.grok.ask(`Translate the user's text into ${languageName(target)}. Output only the translation.`, text).catch(() => undefined);

await api.sendMessage(chatId, "🧪 <b>Social platforms</b> (via ParseHub): one post each.", { parse_mode: "HTML" });
for (const url of urls) {
  const started = Date.now();
  const intro = await api.sendMessage(chatId, url, { link_preview_options: { is_disabled: true } });
  try {
    const sent = await sendPostCard(
      {
        parsehub: app.parsehub,
        api,
        limits: { photoBytes: 10 * 1024 * 1024, videoBytes: config.maxUploadMb * 1024 * 1024 },
        translate,
        downloaders: { bilibili: bilibiliDownloader({ ...config, maxBytes: config.maxUploadMb * 1024 * 1024 }) },
      },
      chatId,
      url,
      lang,
      { reply_parameters: { message_id: intro.message_id } },
    );
    if (sent.status !== "sent") throw new Error(`not posted: ${sent.status}`);
    for (const id of sent.ids) app.groups.log(chatId, 0, { messageId: id, userId: me.id, name: me.first_name, text: `[content of ${url}]\n${sent.plain}`, isBot: true, at: Date.now() });
    console.log(`ok   ${((Date.now() - started) / 1000).toFixed(1)}s ${url}`);
  } catch (error) {
    const reason = (error as Error).message.slice(0, 160);
    console.log(`FAIL ${((Date.now() - started) / 1000).toFixed(1)}s ${url}: ${reason}`);
    await api.sendMessage(chatId, `⚠️ ${reason}`, { reply_parameters: { message_id: intro.message_id } });
  }
}
app.db.close();
