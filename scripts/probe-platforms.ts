/**
 * Which social platforms work right now (run on the server): parses and downloads
 * one post per platform through the ParseHub helper, prints what came back, and
 * deletes the downloads. Sends nothing to Telegram.
 * Usage: node scripts/probe-platforms.ts [url …]
 */
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { ParseHubClient } from "../src/links/parsehub.ts";

loadDotEnv();
const config = loadConfig();
if (!config.parsehubUrl) throw new Error("PARSEHUB_URL is not set");
const parsehub = new ParseHubClient({ baseUrl: config.parsehubUrl, mediaRoot: `${config.dataDir}/media` });

const SAMPLES = [
  "https://www.douyin.com/video/7615533976798727464",
  "https://weibo.com/tv/show/1034:5307969483767845",
  "https://v.m.chenzhongtech.com/fw/photo/3xbr5pi8hxi4e6s",
  "https://tieba.baidu.com/p/9939510114",
  "https://www.douban.com/group/topic/495373106/",
  "https://www.xiaoheihe.cn/app/bbs/link/174972336",
  "https://share.xiaochuankeji.cn/hybrid/share/post?pid=393346270",
  "https://www.facebook.com/reel/761988213517369",
  "https://www.tiktok.com/@scout2015/video/6718335390845095173",
  "https://www.instagram.com/reel/C4dPmXsS8hJ/",
  "https://www.threads.com/@zuck/post/DFtKZ6dyC5V",
  "https://www.zhihu.com/question/19550256",
];

for (const url of process.argv.slice(2).length ? process.argv.slice(2) : SAMPLES) {
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  try {
    const download = await parsehub.download(url, AbortSignal.timeout(180_000));
    const files = download.files.map((f) => `${f.kind}:${(f.size / 1e6).toFixed(1)}MB`);
    const title = (download.post.title || download.post.content).replace(/\s+/g, " ").slice(0, 30);
    console.log(`OK   ${download.post.platform ?? "?"} (${secs()} s) ${files.length} file(s) ${files.slice(0, 4).join(" ")} "${title}"`);
    await parsehub.cleanup(download);
  } catch (error) {
    console.log(`FAIL ${url} (${secs()} s): ${(error as Error).message.replace(/\s+/g, " ").slice(0, 160)}`);
  }
}
