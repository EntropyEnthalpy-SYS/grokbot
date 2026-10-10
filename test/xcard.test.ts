import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputFile } from "grammy";
import { openDbAt } from "../src/db.ts";
import { buildXCard, CAPTION_LIMIT, needsTranslation, pickMedia, sendXCard, type CardApi } from "../src/links/xcard.ts";
import { parseFx, type XPost } from "../src/links/xpost.ts";
import { GroupStore } from "../src/telegram/groups.ts";

const post = (extra: Partial<XPost> = {}): XPost => ({
  url: "https://x.com/deepanshusharmx/status/2108106795332038952",
  author: "Deepanshu <Sharma>",
  handle: "deepanshusharmx",
  verified: true,
  createdAt: "Thu Oct 08 08:06:00 +0000 2026",
  lang: "en",
  text: "Astra is going to have a very tough time",
  photos: ["https://pbs.twimg.com/media/HUF_27QbgAA3H55.jpg?name=orig"],
  videos: [],
  videoThumbnails: [],
  ...extra,
});

test("translate only when the post is in another language; never for link-only posts or 'off'", () => {
  assert.equal(needsTranslation({ text: "hello", lang: "en" }, "zh-tw"), true);
  assert.equal(needsTranslation({ text: "你好", lang: "zh" }, "zh-tw"), false);
  assert.equal(needsTranslation({ text: "你好", lang: "zh" }, "en"), true);
  assert.equal(needsTranslation({ text: "https://t.co/x", lang: "zxx" }, "zh-tw"), false);
  assert.equal(needsTranslation({ text: "hello", lang: "en" }, "off"), false);
  assert.equal(needsTranslation({ text: "hello world", lang: undefined }, "zh-tw"), true);
  assert.equal(needsTranslation({ text: "今天天氣", lang: undefined }, "zh-tw"), false);
});

test("the card is the post itself: author, Taipei time, text, translation; no commentary; HTML escaped", () => {
  const card = buildXCard(post(), "Astra 將會度過非常艱難的時刻");
  assert.equal(
    card.plain,
    "𝕏 Deepanshu <Sharma> ☑️ @deepanshusharmx · 10/08 16:06\n\nAstra is going to have a very tough time\n\n🌐 Astra 將會度過非常艱難的時刻",
  );
  assert.match(card.html, /^𝕏 <b>Deepanshu &lt;Sharma&gt;<\/b> ☑️ <a href="https:\/\/x.com\/deepanshusharmx\/status\/2108106795332038952">@deepanshusharmx<\/a>/);
  assert.doesNotMatch(card.plain, /💡/);
  assert.deepEqual(card.media, [{ type: "photo", url: "https://pbs.twimg.com/media/HUF_27QbgAA3H55.jpg?name=large" }]);
});

test("videos are sent as videos with a thumbnail fallback; quoted media is used only when the post has none", () => {
  const withVideo = post({ photos: [], videos: [{ url: "https://video.twimg.com/v.mp4", thumbnail: "https://pbs.twimg.com/t.jpg" }] });
  assert.deepEqual(pickMedia(withVideo), [{ type: "video", url: "https://video.twimg.com/v.mp4", thumbnail: "https://pbs.twimg.com/t.jpg" }]);
  const quoteOnly = post({ photos: [], quote: post({ handle: "q", text: "quoted", photos: ["https://pbs.twimg.com/q.jpg"] }) });
  assert.deepEqual(pickMedia(quoteOnly), [{ type: "photo", url: "https://pbs.twimg.com/q.jpg?name=large" }]);
  assert.match(buildXCard(quoteOnly).plain, /↪️ @q: quoted/);
});

const describe = (source: string | InputFile) => (typeof source === "string" ? source : `file:${String((source as unknown as { fileData: string }).fileData)}`);

function fakeApi(fail: { video?: boolean; photo?: boolean } = {}) {
  const calls: { method: string; caption?: string; text?: string; replyTo?: number; media?: string }[] = [];
  let id = 500;
  const api: CardApi = {
    async sendMessage(_c, text, other) {
      calls.push({ method: "sendMessage", text, replyTo: other?.reply_parameters?.message_id });
      return { message_id: id++ };
    },
    async sendPhoto(_c, photo, other) {
      if (fail.photo) throw new Error("Bad Request: wrong file identifier/HTTP URL specified");
      calls.push({ method: "sendPhoto", media: describe(photo), caption: other?.caption, replyTo: other?.reply_parameters?.message_id });
      return { message_id: id++ };
    },
    async sendVideo(_c, video, other) {
      if (fail.video) throw new Error("Bad Request: failed to get HTTP URL content");
      calls.push({ method: "sendVideo", media: describe(video), caption: other?.caption, replyTo: other?.reply_parameters?.message_id });
      return { message_id: id++ };
    },
    async sendMediaGroup(_c, media, other) {
      calls.push({ method: "sendMediaGroup", media: media.map((m) => m.type).join(","), caption: media[0]?.caption, replyTo: other?.reply_parameters?.message_id });
      return media.map(() => ({ message_id: id++ }));
    },
  };
  return { api, calls };
}

const reply = { reply_parameters: { message_id: 42, allow_sending_without_reply: true } };

test("one photo goes out as a photo with the card as caption, replying to the shared link", async () => {
  const { api, calls } = fakeApi();
  const card = buildXCard(post());
  assert.deepEqual((await sendXCard(api, -1, card, reply)).ids, [500]);
  assert.deepEqual(calls, [{ method: "sendPhoto", media: card.media[0]!.url, caption: card.html, replyTo: 42 }]);
});

test("a video Telegram can't fetch falls back to its thumbnail", async () => {
  const { api, calls } = fakeApi({ video: true });
  const card = buildXCard(post({ photos: [], videos: [{ url: "https://video.twimg.com/big.mp4", thumbnail: "https://pbs.twimg.com/t.jpg" }] }));
  await sendXCard(api, -1, card, reply);
  assert.deepEqual(calls.map((c) => [c.method, c.media]), [["sendPhoto", "https://pbs.twimg.com/t.jpg"]]);
});

test("when media fails entirely, the card is sent as text", async () => {
  const { api, calls } = fakeApi({ photo: true });
  await sendXCard(api, -1, buildXCard(post()), reply);
  assert.deepEqual(calls.map((c) => [c.method, c.replyTo]), [["sendMessage", 42]]);
});

test("too long for a caption: media + compact caption with the text clipped and folded; no second message repeats it", async () => {
  const { api, calls } = fakeApi();
  const card = buildXCard(post({ photos: ["https://pbs.twimg.com/a.jpg", "https://pbs.twimg.com/b.jpg"], text: "x".repeat(900) }), "y".repeat(400));
  assert.ok(card.plain.length > CAPTION_LIMIT);
  const { ids } = await sendXCard(api, -1, card, reply);
  assert.deepEqual(calls.map((c) => c.method), ["sendMediaGroup"]);
  const caption = calls[0]!.caption!;
  assert.equal(caption, card.captionHtml);
  assert.ok(caption.replace(/<[^>]+>/g, "").length <= CAPTION_LIMIT, "caption fits Telegram's limit");
  assert.match(caption, /^𝕏 <b>Deepanshu &lt;Sharma&gt;<\/b>[^\n]*\n<blockquote expandable>x+…\n\n🌐 y{400}<\/blockquote>$/, "text and translation in one collapsed quote");
  assert.deepEqual(ids, [500, 501]);
});

test("long but captionable posts send one message, no follow-up", async () => {
  const { api, calls } = fakeApi();
  const card = buildXCard(post({ text: "z".repeat(600) }), "w".repeat(300));
  await sendXCard(api, -1, card, reply);
  assert.deepEqual(calls.map((c) => c.method), ["sendPhoto"]);
  assert.match(calls[0]!.caption!, /\n<blockquote expandable>z{600}\n\n🌐 w{300}<\/blockquote>$/);
});

test("a short post is folded too: media, author line, then one collapsed quote (Telegram shows its first lines)", () => {
  const card = buildXCard(post({ text: "This is INSANE." }), "这太疯狂了。");
  assert.match(card.captionHtml, /^𝕏 <b>Deepanshu &lt;Sharma&gt;<\/b>[^\n]*\n<blockquote expandable>This is INSANE\.\n\n🌐 这太疯狂了。<\/blockquote>$/);
  assert.equal(card.html, card.captionHtml, "same layout when sent as text");
});

test("a very long post keeps up to 1800 characters of both text and translation, within one message", () => {
  const card = buildXCard(post({ text: "a".repeat(2500) }), "b".repeat(2500));
  assert.match(card.bodyPlain, new RegExp(`^a{1799}…\\n\\n🌐 b{1799}…$`));
  assert.ok(card.html.length < 4096);
});

test("text-only fallback keeps the header since there is no captioned media", async () => {
  const { api, calls } = fakeApi({ photo: true });
  const card = buildXCard(post({ text: "z".repeat(1200) }));
  await sendXCard(api, -1, card, reply);
  assert.equal(calls[0]!.text, card.html);
});

test("fxtwitter translation, language and video URL are parsed", () => {
  const parsed = parseFx({
    text: "Astra is going to have a very tough time",
    lang: "en",
    author: { name: "D", screen_name: "d", verification: { verified: true } },
    translation: { text: "Astra 將會度過非常艱難的時刻", target_lang: "zh-tw" },
    media: { videos: [{ url: "https://video.twimg.com/v.mp4", thumbnail_url: "https://pbs.twimg.com/t.jpg" }] },
  });
  assert.equal(parsed.translation, "Astra 將會度過非常艱難的時刻");
  assert.equal(parsed.lang, "en");
  assert.equal(parsed.verified, true);
  assert.deepEqual(parsed.videos, [{ url: "https://video.twimg.com/v.mp4", thumbnail: "https://pbs.twimg.com/t.jpg" }]);
  assert.equal(parseFx({ text: "a", translation: { text: "" } }).translation, undefined, "empty translation = not ready");
  // Real fxtwitter raw_text keeps the media t.co link at the end.
  assert.equal(parseFx({ raw_text: { text: "Entering Twitter HQ – let that sink in! https://t.co/D68z4K2wq7" } }).text, "Entering Twitter HQ – let that sink in!");
});

test("existing databases get the language column; groups default to zh-tw and can change", () => {
  const path = join(mkdtempSync(join(tmpdir(), "grokbot-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE groups (chat_id INTEGER PRIMARY KEY, title TEXT, link_mode TEXT NOT NULL DEFAULT 'auto', enabled_at INTEGER NOT NULL)");
  old.prepare("INSERT INTO groups (chat_id, title, enabled_at) VALUES (-5, 'old', 1)").run();
  old.close();
  const groups = new GroupStore(openDbAt(path));
  assert.equal(groups.language(-5), "zh-tw");
  groups.setLanguage(-5, "en");
  assert.equal(groups.language(-5), "en");
});

test("sent media is remembered by Telegram file_id (largest photo size) for instant re-sending; fallbacks are not", async () => {
  const api: CardApi = {
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 2, photo: [{ file_id: "small" }, { file_id: "big" }] }),
    sendVideo: async () => {
      throw new Error("Bad Request: failed to get HTTP URL content");
    },
    sendMediaGroup: async (_c, media) => media.map((_, i) => ({ message_id: 10 + i, photo: [{ file_id: `p${i}` }] })),
  };
  const one = await sendXCard(api, -1, buildXCard(post()), reply);
  assert.deepEqual(one.reusable?.media, [{ type: "photo", url: "big" }]);
  const two = await sendXCard(api, -1, buildXCard(post({ photos: ["https://pbs.twimg.com/a.jpg", "https://pbs.twimg.com/b.jpg"] })), reply);
  assert.deepEqual(two.reusable?.media.map((m) => m.url), ["p0", "p1"]);
  const video = buildXCard(post({ photos: [], videos: [{ url: "https://video.twimg.com/v.mp4", thumbnail: "https://pbs.twimg.com/t.jpg" }] }));
  const fallback = await sendXCard(api, -1, video, reply);
  assert.equal(fallback.reusable, undefined, "thumbnail fallback must not be cached as the card");
});

test("an album item Telegram can't process is dropped and the rest is sent", async () => {
  const groups: number[] = [];
  const api: CardApi = {
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 2 }),
    sendVideo: async () => ({ message_id: 3 }),
    sendMediaGroup: async (_c, media) => {
      groups.push(media.length);
      if (media.length === 3) throw new Error('Call to \'sendMediaGroup\' failed! (400: Bad Request: failed to send message #2 with the error message "IMAGE_PROCESS_FAILED")');
      return media.map((_, i) => ({ message_id: 20 + i, photo: [{ file_id: `f${i}` }] }));
    },
  };
  const card = buildXCard(post({ photos: ["https://pbs.twimg.com/1.jpg", "https://pbs.twimg.com/bad.jpg", "https://pbs.twimg.com/3.jpg"] }));
  const sent = await sendXCard(api, -1, card, reply);
  assert.deepEqual(groups, [3, 2]);
  assert.deepEqual(sent.ids, [20, 21]);
  assert.deepEqual(sent.reusable?.media.map((m) => m.url), ["f0", "f1"]);
});
