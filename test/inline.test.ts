import assert from "node:assert/strict";
import { test } from "node:test";
import { openDbAt } from "../src/db.ts";
import { CardCache } from "../src/links/cardCache.ts";
import type { XCard } from "../src/links/xcard.ts";
import { cardResults, inlineResults, urlFromQuery } from "../src/telegram/inline.ts";

const card = (media: XCard["media"], plain = "𝕏 A @a\n\nhello"): XCard => ({
  html: "<b>A</b> hello",
  plain,
  headerHtml: "<b>A</b>",
  bodyHtml: "hello",
  bodyPlain: "hello",
  captionHtml: "<b>A</b> hello",
  media,
});

test("finds the link in an inline query, with or without a scheme", () => {
  assert.equal(urlFromQuery("看 https://x.com/a/status/123?s=20"), "https://x.com/a/status/123");
  assert.equal(urlFromQuery("v.douyin.com/abc/"), "https://v.douyin.com/abc/");
  assert.equal(urlFromQuery("hello"), undefined);
});

test("cached cards become cached photo/video results plus a text result; long cards use the header as caption", () => {
  const photo = cardResults(card([{ type: "photo", url: "FILE" }]), "https://u", "cached");
  assert.deepEqual(photo.map((r) => r.type), ["photo", "article"]);
  assert.equal((photo[0] as { photo_file_id: string }).photo_file_id, "FILE");
  assert.equal((photo[0] as { caption: string }).caption, "<b>A</b> hello");
  const long = cardResults(card([{ type: "video", url: "VID" }], "x".repeat(2000)), "https://u", "cached");
  assert.equal((long[0] as { video_file_id: string }).video_file_id, "VID");
  assert.equal((long[0] as { caption: string }).caption, "<b>A</b>");
});

test("fresh X cards use X's CDN URLs; a video needs its thumbnail", () => {
  const results = cardResults(card([{ type: "video", url: "https://video.twimg.com/v.mp4", thumbnail: "https://pbs.twimg.com/t.jpg" }]), "https://x.com/a/status/1", "x");
  assert.deepEqual(results.map((r) => r.type), ["video", "article"]);
  assert.equal((results[0] as { mime_type: string }).mime_type, "video/mp4");
});

test("cache first, then X, then ParseHub text card, else nothing", async () => {
  const cache = new CardCache(openDbAt(":memory:"));
  cache.put("https://v.douyin.com/a/", "zh-tw", "douyin", card([{ type: "video", url: "VID" }]));
  const calls: string[] = [];
  const deps = {
    cache,
    buildXCard: async (url: string) => (calls.push(`x ${url}`), card([])),
    translate: async () => "翻譯",
    parsehub: {
      parse: async (url: string) =>
        url.includes("weibo")
          ? { platform: "weibo", platform_name: "微博", type: "video", title: "Hello world", content: "", raw_url: url, media: [{ url: "https://cdn/v.mp4", ext: "mp4", thumb_url: "https://cdn/t.jpg" }] }
          : undefined,
    } as never,
  };
  assert.equal((await inlineResults(deps, "https://v.douyin.com/a/", "zh-tw"))[0]!.type, "video");
  assert.deepEqual((await inlineResults(deps, "https://x.com/a/status/1", "zh-tw")).map((r) => r.type), ["article"]);
  const weibo = await inlineResults(deps, "https://weibo.com/1/2", "zh-tw");
  assert.equal(weibo.length, 1);
  assert.match(JSON.stringify(weibo[0]), /Hello world[\s\S]*🌐 翻譯/);
  assert.equal((weibo[0] as { thumbnail_url: string }).thumbnail_url, "https://cdn/t.jpg");
  assert.deepEqual(await inlineResults(deps, "https://example.com/", "zh-tw"), []);
  assert.deepEqual(calls, ["x https://x.com/a/status/1"]);
});
