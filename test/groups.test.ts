import assert from "node:assert/strict";
import { test } from "node:test";
import { openDbAt } from "../src/db.ts";
import { buildGroupPrompt, describeMessage, GroupStore, isAddressedToBot, stripAddress, threadIdOf, type TgMessage } from "../src/telegram/groups.ts";

const bot = { id: 999, username: "GrokTest_bot" };
const msg = (extra: Partial<TgMessage>): TgMessage => ({ message_id: 1, date: 0, from: { id: 1, first_name: "Amy" }, ...extra });

test("addressed by @mention (exact username, any case), text mention, or reply to the bot", () => {
  assert.equal(isAddressedToBot(msg({ text: "hi @groktest_BOT ?", entities: [{ type: "mention", offset: 3, length: 13 }] }), bot), true);
  assert.equal(isAddressedToBot(msg({ text: "hi @GrokTest_bot2", entities: [{ type: "mention", offset: 3, length: 14 }] }), bot), false);
  assert.equal(isAddressedToBot(msg({ text: "hi @someone", entities: [{ type: "mention", offset: 3, length: 8 }] }), bot), false);
  assert.equal(
    isAddressedToBot(msg({ caption: "look Tokni", caption_entities: [{ type: "text_mention", offset: 5, length: 5, user: { id: 999, first_name: "T" } }] }), bot),
    true,
  );
  assert.equal(isAddressedToBot(msg({ text: "how so?", reply_to_message: msg({ message_id: 0, from: { id: 999, first_name: "T" } }) }), bot), true);
  assert.equal(isAddressedToBot(msg({ text: "how so?", reply_to_message: msg({ message_id: 0, from: { id: 2, first_name: "Bob" } }) }), bot), false);
  assert.equal(isAddressedToBot(msg({ text: "ok", reply_to_message: msg({ message_id: 0, from: { id: 999, first_name: "T" } }) }), bot), false, "a reaction to the bot");
});

test("addressed by name only at the start of a message", () => {
  for (const text of ["grok, what's up", "Grok：這是真的嗎", "hey grok is this true?", "GROK!"]) assert.equal(isAddressedToBot(msg({ text }), bot), true, text);
  for (const text of ["I asked grok yesterday", "grokking is fun", "groko"]) assert.equal(isAddressedToBot(msg({ text }), bot), false, text);
  // Starting with the word is not enough: the name must be followed by punctuation, CJK text, or nothing.
  for (const text of ["grok 這是真的嗎", "Grok，幫我查", "grok?", "grok", "hi grok what is this"]) assert.equal(isAddressedToBot(msg({ text }), bot), true, text);
  for (const text of ["grok's answer was wrong", "grok is down again lol", "Grok 4.7 is out", "grokbot"]) assert.equal(isAddressedToBot(msg({ text }), bot), false, text);
});

test("stripAddress removes the mention and the name prefix", () => {
  assert.equal(stripAddress("@GrokTest_bot  is this true?", bot), "is this true?");
  assert.equal(stripAddress("grok, 這是真的嗎 @groktest_bot", bot), "這是真的嗎");
});

test("describeMessage covers media and reveals hidden link targets", () => {
  assert.equal(
    describeMessage(msg({ caption: "read this", photo: [{}], caption_entities: [{ type: "text_link", offset: 0, length: 4, url: "https://e.com/p" }] })),
    "[photo] read this (https://e.com/p)",
  );
  assert.equal(describeMessage(msg({ sticker: { emoji: "😂" } })), "[sticker 😂]");
  assert.equal(describeMessage(msg({ voice: {} })), "[voice message]");
});

test("topic messages get their topic id; normal and General-topic messages get 0", () => {
  assert.equal(threadIdOf(msg({ is_topic_message: true, message_thread_id: 42 })), 42);
  assert.equal(threadIdOf(msg({ message_thread_id: 42 })), 0);
  assert.equal(threadIdOf(msg({})), 0);
});

test("context is what was said since the bot last spoke, per topic, without the trigger", () => {
  const groups = new GroupStore(openDbAt(":memory:"));
  const now = 1_000_000_000_000;
  const log = (thread: number, id: number, name: string, text: string, at: number, isBot = false) =>
    groups.log(-100, thread, { messageId: id, userId: id, name, text, isBot, at });
  log(0, 1, "Amy", "before bot", now - 5000);
  log(0, 2, "Tokni", "bot answer", now - 4000, true);
  log(0, 3, "Bob", "after bot", now - 3000);
  log(7, 4, "Cat", "other topic", now - 2500);
  log(0, 5, "Amy", "@bot what do you think?", now - 1000);
  const context = groups.contextSinceLastReply(-100, 0, 5, now);
  assert.deepEqual(context.map((e) => e.text), ["after bot"]);
  assert.deepEqual(groups.contextSinceLastReply(-100, 7, 99, now).map((e) => e.text), ["other topic"]);
});

test("context keeps the most recent messages within the character budget, and ignores messages older than a day", () => {
  const groups = new GroupStore(openDbAt(":memory:"));
  const now = 2_000_000_000_000;
  groups.log(-1, 0, { messageId: 1, name: "Old", text: "stale", isBot: false, at: now - 25 * 3600 * 1000 });
  for (let i = 2; i <= 6; i++) groups.log(-1, 0, { messageId: i, name: "P", text: `${i}`.repeat(2000), isBot: false, at: now - (10 - i) * 1000 });
  const context = groups.contextSinceLastReply(-1, 0, 0, now);
  assert.deepEqual(context.map((e) => e.messageId), [4, 5, 6]);
});

test("the group prompt separates context from the message addressed to the bot", () => {
  const prompt = buildGroupPrompt({
    title: "Friends",
    context: [{ messageId: 1, userId: 2, name: "Bob", text: "https://e.com/a", isBot: false, at: 0 }],
    speaker: "Amy",
    speakerId: 1,
    text: "is this true?",
    replyTo: { name: "Bob", text: "https://e.com/a", isBot: false },
  });
  assert.equal(
    prompt,
    [
      '[Recent messages in "Friends" since you last spoke]',
      "Bob [uid:2]: https://e.com/a",
      "",
      "[Message addressed to you]",
      'Amy [uid:1] (replying to Bob: "https://e.com/a"): is this true?',
    ].join("\n"),
  );
});

test("DEFAULT_LANGUAGE applies to newly enabled groups; existing groups keep theirs", async () => {
  const { setDefaultLanguage } = await import("../src/lang.ts");
  const { openDbAt } = await import("../src/db.ts");
  const store = new GroupStore(openDbAt(":memory:"));
  store.enable(-1, "old");
  setDefaultLanguage("en");
  try {
    store.enable(-2, "new");
    store.enable(-1, "old renamed");
    assert.equal(store.language(-1), "zh-tw");
    assert.equal(store.language(-2), "en");
    assert.throws(() => setDefaultLanguage("klingon"), /Unknown DEFAULT_LANGUAGE/);
  } finally {
    setDefaultLanguage("zh-tw");
  }
});

import { isJustReaction } from "../src/telegram/groups.ts";

test("a sticker, emoji or a short reaction word is a reaction; anything with a real question isn't", () => {
  const m = (text: string | undefined, extra: Record<string, unknown> = {}) => ({ message_id: 1, date: 0, text, ...extra }) as never;
  const reactions = ["哈哈哈", "哈哈哈哈。", "6", "666", "笑死", "谢谢！", "👍", "😂😂", "ok", "Thanks", "收到", "?", "hahaha", "牛逼", "草"];
  const questions = ["哈哈那北京呢", "为什么", "6点呢", "谢谢，那上海呢？", "ok but why", "再来一张", "不对吧", "多少钱", "真的吗？为什么"];
  assert.deepEqual(reactions.filter((t) => !isJustReaction(m(t))), []);
  assert.deepEqual(questions.filter((t) => isJustReaction(m(t))), []);
  assert.equal(isJustReaction(m(undefined, { sticker: { emoji: "😂" } })), true);
  assert.equal(isJustReaction(m(undefined, { caption: "哈哈", photo: [{}] })), false, "a photo is content");
});
