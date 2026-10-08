import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeOldFiles, removeStaleMedia } from "../src/media/cleanup.ts";
import { openDbAt } from "../src/db.ts";
import { CardCache } from "../src/links/cardCache.ts";
import { isOnlyLinks } from "../src/telegram/groups.ts";
import { cardFromMarkdown } from "../src/links/videocard.ts";
import { buildPostCard, CLOUD_LIMITS, isJpegOrPng, photoParts, prepareMedia, prepareVideo } from "../src/links/phcard.ts";
import { normalizeFile, ParseHubClient, type PhDownload, type PhPost } from "../src/links/parsehub.ts";
import { sendPostCard } from "../src/links/postcard.ts";
import type { CardApi } from "../src/links/xcard.ts";

const douyin: PhPost = {
  platform: "douyin",
  platform_name: "抖音",
  type: "video",
  title: "挑战自制乐高车跨越狭窄桥梁 #乐高",
  content: "",
  raw_url: "https://www.douyin.com/video/7615533976798727464",
  media: [{ url: "https://cdn/v.mp4", ext: "mp4" }],
};

function fakeSidecar(routes: Record<string, (url: string) => { status: number; body: unknown }>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const url = JSON.parse(String(init?.body)).url as string;
    calls.push(`${path} ${url}`);
    const { status, body } = routes[path]!(url);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

test("client: unsupported links and platforms we handle ourselves come back undefined; errors carry the reason", async () => {
  const { impl } = fakeSidecar({
    "/parse": (url) =>
      url.includes("wikipedia")
        ? { status: 200, body: { supported: false } }
        : url.includes("x.com")
          ? { status: 200, body: { supported: true, post: { ...douyin, platform: "twitter" } } }
          : url.includes("bilibili")
            ? { status: 422, body: { error: "解析错误: Bilibili 解析失败" } }
            : { status: 200, body: { supported: true, post: douyin } },
  });
  const client = new ParseHubClient({ baseUrl: "http://127.0.0.1:8765/", fetchImpl: impl });
  assert.equal(await client.parse("https://en.wikipedia.org/wiki/X"), undefined);
  assert.equal(await client.parse("https://x.com/a/status/1"), undefined);
  assert.equal((await client.parse("https://v.douyin.com/abc/"))?.platform_name, "抖音");
  await assert.rejects(client.parse("https://www.bilibili.com/video/BV1"), /Bilibili 解析失败/);
});

test("client: durations in milliseconds are converted; cleanup never leaves the media root", async () => {
  assert.equal(normalizeFile({ kind: "video", path: "a", size: 1, width: 1, height: 1, duration: 154576 }).duration, 155);
  assert.equal(normalizeFile({ kind: "video", path: "a", size: 1, width: 1, height: 1, duration: 154 }).duration, 154);
  const root = mkdtempSync(join(tmpdir(), "ph-root-"));
  const outside = mkdtempSync(join(tmpdir(), "ph-outside-"));
  const inside = join(root, "abc");
  mkdirSync(inside);
  const client = new ParseHubClient({ baseUrl: "http://x", mediaRoot: root });
  await client.cleanup({ dir: outside });
  await client.cleanup({ dir: join(root, "..") });
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(root), true);
  await client.cleanup({ dir: inside });
  assert.equal(existsSync(inside), false);
});

function image(dir: string, name: string, w: number, h: number): string {
  const path = join(dir, name);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=${w}x${h}`, "-frames:v", "1", path]);
  return path;
}

test("media: webp → jpeg, tall images sliced, oversized videos dropped with a note, album capped at 10", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ph-media-"));
  const webp = image(dir, "a.webp", 400, 300);
  const tall = image(dir, "long.jpg", 600, 4000);
  const jpg = image(dir, "b.jpg", 300, 300);
  const files = [
    { kind: "image" as const, path: webp, size: 1000, width: 400, height: 300, duration: 0 },
    { kind: "image" as const, path: tall, size: 1000, width: 600, height: 4000, duration: 0 },
    { kind: "video" as const, path: join(dir, "big.mp4"), size: 120 * 1024 * 1024, width: 0, height: 0, duration: 60 },
    { kind: "video" as const, path: join(dir, "ok.mp4"), size: 5 * 1024 * 1024, width: 0, height: 0, duration: 10 },
    ...Array.from({ length: 8 }, () => ({ kind: "image" as const, path: jpg, size: 1000, width: 300, height: 300, duration: 0 })),
  ];
  const { media, notes } = await prepareMedia(files, CLOUD_LIMITS, { workDir: dir });
  assert.equal(media.length, 10);
  assert.match(media[0]!.url, /img_0\.jpg$/, "webp converted");
  // 4000 / max(1280, 1200) → slices of 1280: 4 parts
  assert.deepEqual(media.slice(1, 5).map((m) => m.url.split("/").pop()), ["img_1_0.jpg", "img_1_1.jpg", "img_1_2.jpg", "img_1_3.jpg"]);
  // ok.mp4 is not a real video here, so remux/thumbnail fail and the original is sent with its duration.
  assert.deepEqual(media[5], { type: "video", url: join(dir, "ok.mp4"), local: true, duration: 10 });
  assert.equal(media.every((m) => m.local), true);
  assert.match(notes[0]!, /Video too large .*120 MB/);
  assert.match(notes[1]!, /\+4 more in the original post/);
});

test("card: platform, source link, title, text and translation; no commentary; HTML escaped", () => {
  const download: PhDownload = { post: { ...douyin, content: "a <b> & c" }, dir: "", files: [] };
  const card = buildPostCard(download, "https://v.douyin.com/abc/", [], ["note"], "翻譯");
  assert.equal(card.plain, "📌 抖音 · https://v.douyin.com/abc/\n\n挑战自制乐高车跨越狭窄桥梁 #乐高\n\na <b> & c\n\n🌐 翻譯\n\nnote");
  assert.match(card.html, /^📌 <b>抖音<\/b> · <a href="https:\/\/v.douyin.com\/abc\/">原文 \/ source<\/a>/);
  assert.match(card.bodyHtml, /a &lt;b&gt; &amp; c/);
});

test("flow: download, upload as a local video, translate only foreign text, always clean up", async () => {
  const root = mkdtempSync(join(tmpdir(), "ph-flow-"));
  const dir = join(root, "req1");
  mkdirSync(dir);
  const video = join(dir, "v.mp4");
  writeFileSync(video, "x");
  const { impl, calls } = fakeSidecar({
    "/parse": () => ({ status: 200, body: { supported: true, post: { ...douyin, platform: "instagram", platform_name: "Instagram", title: "Sunset at the beach" } } }),
    "/download": () => ({ status: 200, body: { post: { ...douyin, platform_name: "Instagram", title: "Sunset at the beach" }, dir, files: [{ kind: "video", path: video, size: 1, width: 1, height: 1, duration: 3 }] } }),
  });
  const sent: { method: string; local: boolean; caption?: string }[] = [];
  const api: CardApi = {
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 2 }),
    sendVideo: async (_c, source, other) => {
      sent.push({ method: "sendVideo", local: typeof source !== "string", caption: other?.caption });
      return { message_id: 3 };
    },
    sendMediaGroup: async () => [],
  };
  const translations: string[] = [];
  const result = await sendPostCard(
    {
      parsehub: new ParseHubClient({ baseUrl: "http://s", mediaRoot: root, fetchImpl: impl }),
      api,
      limits: CLOUD_LIMITS,
      translate: async (text) => (translations.push(text), "海灘夕陽"),
    },
    -1,
    "https://www.instagram.com/reel/abc/",
    "zh-tw",
    {},
  );
  assert.deepEqual(calls.map((c) => c.split(" ")[0]), ["/parse", "/download"]);
  assert.equal(result.status, "sent");
  assert.deepEqual(result.status === "sent" && result.ids, [3]);
  assert.equal(sent[0]!.local, true);
  assert.match(sent[0]!.caption!, /Sunset at the beach[\s\S]*🌐 海灘夕陽/);
  assert.deepEqual(translations, ["Sunset at the beach"]);
  assert.equal(existsSync(dir), false, "download folder removed");
});

test("stale download folders are removed, fresh ones kept", async () => {
  const root = mkdtempSync(join(tmpdir(), "ph-stale-"));
  mkdirSync(join(root, "old"));
  mkdirSync(join(root, "new"));
  const past = new Date(Date.now() - 2 * 3600 * 1000);
  utimesSync(join(root, "old"), past, past);
  assert.equal(await removeStaleMedia(root, 3600 * 1000), 1);
  assert.equal(existsSync(join(root, "old")), false);
  assert.equal(existsSync(join(root, "new")), true);
});

test("card cache: local paths never stored, expires after 7 days, keyed by language", () => {
  const cache = new CardCache(openDbAt(":memory:"));
  const card = { html: "h", plain: "p", headerHtml: "", bodyHtml: "", bodyPlain: "", captionHtml: "", clipped: false, fullTextHtml: "", media: [{ type: "photo" as const, url: "FILEID" }] };
  cache.put("https://u", "zh-tw", "douyin", { ...card, media: [{ type: "photo", url: "/tmp/x.jpg", local: true }] });
  assert.equal(cache.get("https://u", "zh-tw"), undefined);
  cache.put("https://u", "zh-tw", "douyin", card, 1000);
  assert.deepEqual(cache.get("https://u", "zh-tw", 2000), { platform: "douyin", card });
  assert.equal(cache.get("https://u", "en", 2000), undefined);
  assert.equal(cache.get("https://u", "zh-tw", 1000 + 8 * 24 * 3600 * 1000), undefined);
});

test("re-posted link: sent from cache without touching ParseHub; disabled platforms are skipped before downloading", async () => {
  const { impl, calls } = fakeSidecar({
    "/parse": () => ({ status: 200, body: { supported: true, post: douyin } }),
    "/download": () => ({ status: 500, body: { error: "should not download" } }),
  });
  const cache = new CardCache(openDbAt(":memory:"));
  const card = { html: "<b>c</b>", plain: "c", headerHtml: "", bodyHtml: "", bodyPlain: "", captionHtml: "", clipped: false, fullTextHtml: "", media: [{ type: "video" as const, url: "VIDEO_FILE_ID" }] };
  cache.put("https://v.douyin.com/a/", "zh-tw", "douyin", card);
  const videos: string[] = [];
  const api: CardApi = {
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 2 }),
    sendVideo: async (_c, source) => (videos.push(String(source)), { message_id: 3 }),
    sendMediaGroup: async () => [],
  };
  const deps = { parsehub: new ParseHubClient({ baseUrl: "http://s", fetchImpl: impl }), api, limits: CLOUD_LIMITS, translate: async () => undefined, cache };
  const hit = await sendPostCard(deps, -1, "https://v.douyin.com/a/", "zh-tw", {});
  assert.deepEqual(hit, { status: "sent", ids: [3], plain: "c", platform: "douyin", cached: true });
  assert.deepEqual(videos, ["VIDEO_FILE_ID"]);
  assert.equal(calls.length, 0);

  const off = await sendPostCard({ ...deps, allowed: (p) => p !== "douyin" }, -1, "https://v.douyin.com/other/", "zh-tw", {});
  assert.deepEqual(off, { status: "disabled", platform: "douyin" });
  assert.deepEqual((calls as string[]).map((c) => c.split(" ")[0]), ["/parse"]);
});

test("only link-only messages may be deleted", () => {
  assert.equal(isOnlyLinks("https://v.douyin.com/a/  https://x.com/b/status/1", ["https://v.douyin.com/a/", "https://x.com/b/status/1"]), true);
  assert.equal(isOnlyLinks("看這個 https://v.douyin.com/a/", ["https://v.douyin.com/a/"]), false);
});

test("old files deep inside the Bot API folder are deleted; folders and fresh files stay", async () => {
  const root = mkdtempSync(join(tmpdir(), "tgapi-"));
  const videos = join(root, "123:token", "videos");
  mkdirSync(videos, { recursive: true });
  writeFileSync(join(videos, "old.mp4"), "x");
  writeFileSync(join(videos, "new.mp4"), "x");
  const past = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  utimesSync(join(videos, "old.mp4"), past, past);
  assert.equal(await removeOldFiles(root, 24 * 3600 * 1000), 1);
  assert.equal(existsSync(join(videos, "old.mp4")), false);
  assert.equal(existsSync(join(videos, "new.mp4")), true);
});

test("a WebP saved as .jpg is detected by its bytes and re-encoded; real JPEGs pass through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ph-magic-"));
  const webpAsJpg = join(dir, "fake.jpg");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=200x200", "-frames:v", "1", "-f", "webp", webpAsJpg]);
  const realJpg = image(dir, "real.jpg", 200, 200);
  assert.equal(await isJpegOrPng(webpAsJpg), false);
  assert.equal(await isJpegOrPng(realJpg), true);
  const base = { kind: "image" as const, size: 1000, width: 200, height: 200, duration: 0 };
  assert.deepEqual(await photoParts({ ...base, path: realJpg }, 0, "ffmpeg", dir), [realJpg]);
  const [converted] = await photoParts({ ...base, path: webpAsJpg }, 1, "ffmpeg", dir);
  assert.equal(converted, join(dir, "img_1.jpg"));
  assert.equal(await isJpegOrPng(converted!), true);
});

test("local videos get a streamable copy, a thumbnail, and their size and duration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ph-vid-"));
  const src = join(dir, "in.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", "-c:v", "libx264", src]);
  const media = await prepareVideo({ kind: "video", path: src, size: 1000, width: 320, height: 240, duration: 4 }, 0, "ffmpeg", dir);
  assert.deepEqual(media, { type: "video", url: join(dir, "vid_0.mp4"), local: true, width: 320, height: 240, duration: 4, thumbFile: join(dir, "vid_0.jpg") });
  assert.equal(await isJpegOrPng(media.thumbFile!), true);
  // faststart: the "moov" index comes before the "mdat" media data.
  const bytes = readFileSync(media.url).toString("latin1");
  assert.ok(bytes.indexOf("moov") < bytes.indexOf("mdat"), "moov atom first");
});

test("video card: short cards are the whole caption; long ones show the title and fold the rest", () => {
  const short = cardFromMarkdown("🎬 **美麗的中國女孩**\nMin Min · 0:07\n- 影片沒有語音", []);
  assert.equal(short.captionHtml, "🎬 <b>美麗的中國女孩</b>\nMin Min · 0:07\n• 影片沒有語音");
  assert.equal(short.clipped, false);
  const long = cardFromMarkdown(`🎬 **Title**\n${"- point\n".repeat(200)}`, []);
  assert.equal(long.captionHtml, "🎬 <b>Title</b>");
  assert.equal(long.clipped, true);
  assert.match(long.fullTextHtml, /^<blockquote expandable>• point/);
});
