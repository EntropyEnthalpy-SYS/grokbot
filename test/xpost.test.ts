import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dropOldImages } from "../src/agent/sessions.ts";
import { downloadXImages, fetchXPost, formatXPost, parseFx, parseSyndication, xPostImageUrls, xStatusId } from "../src/links/xpost.ts";

// Trimmed from the real responses for https://x.com/deepanshusharmx/status/2108106795332038952
const fx = {
  code: 200,
  tweet: {
    url: "https://x.com/deepanshusharmx/status/2108106795332038952",
    text: "Astra is going to have a very tough time",
    author: { name: "Deepanshu Sharma", screen_name: "deepanshusharmx" },
    created_at: "Thu Oct 08 10:12:00 +0000 2026",
    media: { photos: [{ type: "photo", url: "https://pbs.twimg.com/media/HUF_27QbgAA3H55.jpg?name=orig" }] },
  },
};
const syndication = {
  id_str: "2108106795332038952",
  text: "Astra is going to have a very tough time https://t.co/rMgIsaN4KY",
  user: { name: "Deepanshu Sharma", screen_name: "deepanshusharmx" },
  mediaDetails: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/HUF_27QbgAA3H55.jpg" }],
  photos: [{ url: "https://pbs.twimg.com/media/HUF_27QbgAA3H55.jpg" }],
};

test("finds the status id in x.com and twitter.com links", () => {
  assert.equal(xStatusId("https://x.com/a/status/2108106795332038952"), "2108106795332038952");
  assert.equal(xStatusId("https://twitter.com/a/statuses/123456789"), "123456789");
  assert.equal(xStatusId("https://x.com/a"), undefined);
});

test("both sources parse to the same post, without the trailing media t.co link", () => {
  const a = parseFx(fx.tweet);
  const b = parseSyndication(syndication);
  assert.equal(a.text, "Astra is going to have a very tough time");
  assert.equal(b.text, a.text);
  assert.equal(a.handle, "deepanshusharmx");
  assert.equal(b.handle, "deepanshusharmx");
  assert.equal(b.photos[0], "https://pbs.twimg.com/media/HUF_27QbgAA3H55.jpg");
  assert.match(formatXPost(a), /^X post by Deepanshu Sharma \(@deepanshusharmx\)[\s\S]*\[1 image\(s\) attached below\]/);
});

test("quoted posts and video thumbnails are included, images capped at 4", () => {
  const post = parseFx({
    text: "look",
    author: { name: "A", screen_name: "a" },
    media: { photos: [1, 2, 3].map((n) => ({ url: `https://pbs.twimg.com/media/p${n}.jpg` })), videos: [{ thumbnail_url: "https://pbs.twimg.com/v.jpg" }] },
    quote: { text: "quoted text", author: { screen_name: "q" }, media: { photos: [{ url: "https://pbs.twimg.com/media/q.jpg" }] } },
  });
  assert.match(formatXPost(post), /Quoting @q:\nquoted text/);
  assert.deepEqual(xPostImageUrls(post).map((u) => u.split("/").pop()), ["p1.jpg", "p2.jpg", "p3.jpg", "q.jpg"]);
});

test("falls back to X's embed CDN when fxtwitter fails", async () => {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(new URL(url).hostname);
    if (url.includes("fxtwitter")) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(syndication), { status: 200 });
  }) as typeof fetch;
  const post = await fetchXPost("https://x.com/deepanshusharmx/status/2108106795332038952", impl);
  assert.deepEqual(urls, ["api.fxtwitter.com", "cdn.syndication.twimg.com"]);
  assert.equal(post.photos.length, 1);
});

test("downloads images only from pbs.twimg.com, at medium size", async () => {
  const requested: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  const images = await downloadXImages(
    ["https://pbs.twimg.com/media/a.jpg?name=orig", "https://evil.example/x.jpg", "http://pbs.twimg.com/media/b.jpg"],
    impl,
  );
  assert.deepEqual(requested, ["https://pbs.twimg.com/media/a.jpg?name=medium"]);
  assert.deepEqual(images, [{ type: "image", data: "AQID", mimeType: "image/jpeg" }]);
});

test("old images become placeholders; the latest turn keeps its images", () => {
  const img = { type: "image", data: "x", mimeType: "image/png" };
  const messages = [
    { role: "user", content: [{ type: "text", text: "photo 1" }, img], timestamp: 1 },
    { role: "assistant", content: [], timestamp: 2 },
    { role: "toolResult", toolCallId: "t", toolName: "read_link", content: [{ type: "text", text: "post" }, img], timestamp: 3 },
    { role: "user", content: [{ type: "text", text: "photo 2" }, img], timestamp: 4 },
    { role: "toolResult", toolCallId: "u", toolName: "read_link", content: [img], timestamp: 5 },
  ] as unknown as AgentMessage[];
  const result = dropOldImages(messages) as unknown as { content: { type: string; text?: string }[] }[];
  assert.deepEqual(result[0]!.content, [{ type: "text", text: "photo 1" }, { type: "text", text: "[image]" }]);
  assert.deepEqual(result[2]!.content, [{ type: "text", text: "post" }, { type: "text", text: "[image]" }]);
  assert.equal(result[3]!.content[1]!.type, "image");
  assert.equal(result[4]!.content[0]!.type, "image");
});
