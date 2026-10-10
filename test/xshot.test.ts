import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FONT_FILES, renderXPicture } from "../src/links/xshot.ts";
import type { XPost } from "../src/links/xpost.ts";

const fontDir = process.env.FONT_DIR ?? "/usr/local/share/grokbot-fonts";
const haveFonts = FONT_FILES.every((f) => existsSync(join(fontDir, f.file)));
const offline = (async () => new Response("", { status: 404 })) as typeof fetch;
const post = (text: string, extra: Partial<XPost> = {}): XPost => ({ url: "https://x.com/a/status/1", author: "奶昔", handle: "a", verified: true, text, photos: [], videos: [], videoThumbnails: [], ...extra });
/** Width and height from a PNG's header. */
const size = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

test("X picture: a sharp PNG (2× width) that grows with the post; translation and quote add to it", { skip: !haveFonts && `fonts not in ${fontDir}` }, async () => {
  const short = await renderXPicture(post("港区Netflix已支持微信支付"), { fontDir, fetchImpl: offline });
  assert.equal(short.subarray(1, 4).toString(), "PNG");
  assert.equal(size(short).width, 1192);
  const long = await renderXPicture(post("部分用户反馈，老账号没有该选项。\n".repeat(12)), { fontDir, fetchImpl: offline });
  assert.ok(size(long).height > size(short).height + 400, `long ${size(long).height} vs short ${size(short).height}`);
  const extras = await renderXPicture(post("港区Netflix已支持微信支付", { quote: post("引用的帖子") }), { fontDir, translation: "Netflix HK now takes WeChat Pay", time: "10/10 22:17", fetchImpl: offline });
  assert.ok(size(extras).height > size(short).height + 150);
});

test("X picture next to media has a fixed shape so the album shows it large; long text is cut to fit", { skip: !haveFonts && `fonts not in ${fontDir}` }, async () => {
  const long = "部分用户反馈，老账号没有该选项。\n".repeat(12);
  // Wide video: the same shape (1920×1080 → 596×335 CSS px, drawn at 2×), short or long.
  const video = { videos: [{ url: "https://video.twimg.com/v.mp4", thumbnail: "" }], mediaSize: { width: 1920, height: 1080 } };
  assert.deepEqual(size(await renderXPicture(post("hi", video), { fontDir, fetchImpl: offline })), { width: 1192, height: 670 });
  assert.deepEqual(size(await renderXPicture(post(long, video), { fontDir, translation: long, time: "10/10 22:17", fetchImpl: offline })), { width: 1192, height: 670 });
  // Tall photo: a 4:3 picture, which Telegram places first and wider.
  const tall = { photos: ["https://pbs.twimg.com/p.jpg"], mediaSize: { width: 1170, height: 2532 } };
  assert.deepEqual(size(await renderXPicture(post(long, tall), { fontDir, fetchImpl: offline })), { width: 1192, height: 894 });
  // No media: grows with the text up to a square.
  assert.ok(size(await renderXPicture(post(long.repeat(3)), { fontDir, fetchImpl: offline })).height <= 1192);
});

test("X picture: without the fonts it says so (the bot then sends the text card)", async () => {
  await assert.rejects(renderXPicture(post("x"), { fontDir: mkdtempSync(join(tmpdir(), "nofonts-")), fetchImpl: offline }), /fonts missing/);
});
