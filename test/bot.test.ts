import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Update } from "grammy/types";
import { openDbAt } from "../src/db.ts";
import { createBot, QUESTIONS_PER_USER_PER_HOUR } from "../src/telegram/bot.ts";
import { GroupStore } from "../src/telegram/groups.ts";
import { ReminderStore } from "../src/reminders.ts";
import { ImageStudio } from "../src/agent/images.ts";
import { MemoryStore } from "../src/memory.ts";
import { LimitStore, UsageStore } from "../src/usage.ts";
import { PermissionStore } from "../src/permissions.ts";
import { PollDesk } from "../src/agent/polls.ts";
import { ActionDesk, confirmerFor, type Confirmer } from "../src/agent/actions.ts";

const OWNER = 1000001;

/** One second of audio as MP3, standing in for xAI's text-to-speech answer. */
function sineMp3(): string {
  const path = join(tmpdir(), "grokbot-test-sine.mp3");
  if (!existsSync(path)) execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", path]);
  return path;
}
const GROUP = -1001234567890;

/** The real bot wiring with Telegram and Grok faked: records every API call instead of sending it. */
function harness(
  options: {
    loggedIn?: boolean;
    ask?: (system: string, prompt: string) => string;
    files?: Record<string, string>;
    /** Telegram refuses ephemeral messages (bot is not an admin). */
    refuseEphemeral?: boolean;
    /** Title and snippet of a web page (default: a fixed fake page). */
    preview?: (url: string) => Promise<{ title?: string; snippet: string } | undefined>;
    /** The video reader (YouTube cards and summaries). */
    video?: Record<string, unknown>;
    /** Each message the bot sends gets its own id (default: all are message 1). */
    distinctIds?: boolean;
    /** Draws X posts for /xstyle picture. */
    xPicture?: (post: { text: string }, translation: string | undefined) => Promise<Buffer>;
    /** The chat agent's turn: may call the create_image tool like Grok would. */
    agent?: (
      images: ImageStudio,
      key: string,
      extra: { memory: MemoryStore; speakers: Map<string, { userId?: number; userName: string }>; polls: PollDesk; confirm: Confirmer },
    ) => Promise<string | { text: string; stopReason?: string; usedTool?: boolean }>;
  } = {},
) {
  const calls: { method: string; payload: Record<string, unknown>; sentId?: number }[] = [];
  const db = openDbAt(":memory:");
  const groups = new GroupStore(db);
  const reminders = new ReminderStore(db, (chatId) => groups.timeZone(chatId));
  const memory = new MemoryStore(db);
  const usage = new UsageStore(db);
  const limits = new LimitStore(db);
  const permissions = new PermissionStore(db);
  const polls = new PollDesk();
  const actions = new ActionDesk();
  const speakers = new Map<string, { userId?: number; userName: string }>();
  const created: { prompt: string; sources: number }[] = [];
  const images = new ImageStudio(async ({ prompt, sources }) => {
    created.push({ prompt, sources: sources?.length ?? 0 });
    return Buffer.from(`jpeg:${prompt}`);
  });
  const cards = new Map<string, { card: unknown }>();
  const runs: { key: string; ephemeral?: boolean; text: string; images: number }[] = [];
  const sessions = {
    forgetChat: () => 0,
    reset: () => undefined,
    abort: () => false,
    abortChat: () => 0,
    run: async (key: string, input: { text: string; images?: unknown[] }, handlers: { onStart?: () => void }, turn: { ephemeral?: boolean } = {}) => {
      runs.push({ key, ephemeral: turn.ephemeral, text: input.text, images: input.images?.length ?? 0 });
      handlers.onStart?.();
      const confirm = confirmerFor({ actions, confirmActions: (chatId) => groups.confirmActions(chatId), speakers }, key);
      const out = options.agent ? await options.agent(images, key, { memory, speakers, polls, confirm }) : "ok";
      const { text, stopReason = "stop", usedTool = false } = typeof out === "string" ? { text: out } : out;
      if (usedTool) (handlers as { onTool?: (name: string) => void }).onTool?.("create_poll");
      return { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason };
    },
  };
  const asked: { system: string; prompt: string; images: number }[] = [];
  const grok = {
    isLoggedIn: async () => options.loggedIn ?? false,
    signedIn: async () => options.loggedIn ?? false,
    transcribe: async () => ({ text: "現在幾點？", language: "zh", words: [] }),
    speak: async () => readFileSync(sineMp3()),
    ask: async (system: string, prompt: string, extra: { images?: unknown[] } = {}) => {
      asked.push({ system, prompt, images: extra.images?.length ?? 0 });
      return options.ask?.(system, prompt) ?? "";
    },
  };
  const bot = createBot({
    token: "1:test",
    ownerId: OWNER,
    grok: grok as never,
    sessions: sessions as never,
    groups,
    reminders,
    images,
    memory,
    speakers,
    usage,
    limits,
    permissions,
    polls,
    actions,
    xPicture: options.xPicture as never,
    apiRoot: "http://127.0.0.1:1", // "local Bot API": getFile returns a path on disk
    links: {
      db,
      grok,
      reader: { read: async (url: string) => ({ url, text: "页面正文：翊联电子在郑州。", source: "direct" }) },
      preview: options.preview ?? (async () => ({ title: "A page", snippet: "Its first lines." })),
      cache: { get: (url: string, lang: string) => cards.get(`${url}#${lang}`), put: (url: string, lang: string, _p: string, card: unknown) => void cards.set(`${url}#${lang}`, { card }) },
      video: options.video ?? {},
      uploadLimits: { photoBytes: 10 * 1024 * 1024, videoBytes: 50 * 1024 * 1024 },
      mediaDir: mkdtempSync(join(tmpdir(), "media-")),
    } as never,
  });
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Grokky",
    username: "GrokTest_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: true,
  } as never;
  bot.api.config.use(async (_prev, method, payload) => {
    if (options.refuseEphemeral && (payload as { ephemeral_message_parameters?: unknown }).ephemeral_message_parameters) {
      return { ok: false, error_code: 400, description: "Bad Request: not enough rights to send ephemeral messages" } as never;
    }
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "getFile") {
      const id = (payload as { file_id: string }).file_id;
      return { ok: true, result: { file_id: id, file_unique_id: id, file_path: options.files?.[id] } } as never;
    }
    const message_id = options.distinctIds ? ++sentId : 1;
    calls.at(-1)!.sentId = message_id;
    if (method === "sendMediaGroup") {
      const media = (payload as { media: unknown[] }).media;
      return { ok: true, result: media.map((_, i) => ({ message_id: message_id + i, date: 0, chat: { id: GROUP, type: "supergroup" }, photo: [{ file_id: `f${message_id + i}` }] })) } as never;
    }
    return { ok: true, result: ["sendMessage", "sendPhoto", "sendVoice"].includes(method) ? { message_id, date: 0, chat: { id: GROUP, type: "supergroup" }, photo: [{ file_id: `f${message_id}` }] } : true } as never;
  });
  let updateId = 0;
  let messageId = 100;
  let sentId = 5000;
  const groupText = (from: number, text: string, extra: Record<string, unknown> = {}): Update => ({
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      date: 0,
      chat: { id: GROUP, type: "supergroup", title: "Grok bot test" },
      from: { id: from, is_bot: false, first_name: `user${from}` },
      text,
      ...extra,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }] } : {}),
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  /** Wait until the bot made a call that `match` accepts (fails the test after `ms`). */
  const until = async (match: (call: { method: string; payload: Record<string, unknown> }) => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!calls.some(match)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the bot");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  /** Someone taps an inline button under message 1 in the group (or in their private chat with `chat`). */
  const press = (from: number, data: string, chat: { id: number; type: string } = { id: GROUP, type: "supergroup" }): Update =>
    ({
      update_id: ++updateId,
      callback_query: { id: String(updateId), from: { id: from, is_bot: false, first_name: `user${from}` }, chat_instance: "c", data, message: { message_id: 1, date: 0, chat } },
    }) as Update;
  /** Wait until `done()` holds (fails the test after `ms`), instead of guessing how long the bot takes. */
  const waitFor = async (done: () => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!done()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the bot");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { bot, calls, runs, until, waitFor, press, actions, groups, reminders, memory, speakers, usage, limits, permissions, polls, asked, created, images, groupText, settle, next: () => ++updateId };
}

test("inline queries reach their handler (they have no chat, unlike every other update)", async () => {
  const h = harness();
  await h.bot.handleUpdate({
    update_id: h.next(),
    inline_query: { id: "q1", from: { id: OWNER, is_bot: false, first_name: "Owner" }, query: "no link here", offset: "" },
  });
  assert.deepEqual(
    h.calls.map((c) => c.method),
    ["answerInlineQuery"],
  );
});

test("a member is limited per hour; the owner is not; the over-limit notice is sent once", async () => {
  const h = harness();
  h.groups.enable(GROUP, "Grok bot test");
  const member = 5;
  for (let i = 0; i < QUESTIONS_PER_USER_PER_HOUR + 5; i++) await h.bot.handleUpdate(h.groupText(member, `grok, question ${i}`));
  await h.settle();
  const replies = h.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
  const answered = replies.filter((text) => text.includes("needs to log in")).length;
  const refused = replies.filter((text) => text.startsWith("⏳")).length;
  assert.equal(answered, QUESTIONS_PER_USER_PER_HOUR);
  assert.equal(refused, 1);

  h.calls.length = 0;
  for (let i = 0; i < QUESTIONS_PER_USER_PER_HOUR + 5; i++) await h.bot.handleUpdate(h.groupText(OWNER, `grok, owner question ${i}`));
  await h.settle();
  assert.equal(h.calls.filter((c) => c.method === "sendMessage" && String(c.payload.text).includes("Send /login")).length, QUESTIONS_PER_USER_PER_HOUR + 5);
});

test("in groups only the owner can /new and /stop", async () => {
  const h = harness();
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(5, "/new"));
  await h.bot.handleUpdate(h.groupText(OWNER, "/stop"));
  const texts = h.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
  assert.deepEqual(texts, ["Only the bot owner can do that.", "Nothing is running."]);
});

test("strict groups log nothing: not members' messages, not the bot's own replies", async () => {
  const h = harness();
  h.groups.enable(GROUP, "official"); // new groups start strict
  assert.equal(h.groups.privacy(GROUP), "strict");
  await h.bot.handleUpdate(h.groupText(5, "something private"));
  await h.bot.handleUpdate(h.groupText(5, "grok, what do you think?"));
  await h.settle();
  assert.equal(h.groups.contextSinceLastReply(GROUP, 0, 10_000).length, 0);
});

test("/tr translates the replied message into the group language and replies to that message", async () => {
  const h = harness({ loggedIn: true, ask: () => "Is this true?" });
  h.groups.enable(GROUP, "Grok bot test");
  const original = { message_id: 7, date: 0, chat: { id: GROUP, type: "supergroup" }, from: { id: 5, is_bot: false, first_name: "A" }, text: "這是真的嗎？" };
  h.groups.setLanguage(GROUP, "en");
  await h.bot.handleUpdate(h.groupText(6, "/tr", { reply_to_message: original }));
  await h.settle();
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0]!.prompt, "這是真的嗎？");
  assert.match(h.asked[0]!.system, /into English/);
  const sent = h.calls.find((c) => c.method === "sendMessage");
  assert.match(String(sent?.payload.text), /Is this true\?/);
  assert.equal((sent?.payload.reply_parameters as { message_id: number }).message_id, 7);
});

test("/tr ja <text> uses the given language for inline text", async () => {
  const h = harness({ loggedIn: true, ask: () => "こんにちは" });
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(6, "/tr ja hello there"));
  await h.settle();
  assert.equal(h.asked[0]!.prompt, "hello there");
  assert.match(h.asked[0]!.system, /Japanese/);
});

test("“grok, 提醒我們…” stores a reminder in Taipei time instead of asking the chat agent", async () => {
  // Two days from now, 20:00 Taipei (= 12:00 UTC).
  const day = new Date(Date.now() + 2 * 24 * 3600_000 + 8 * 3600_000).toISOString().slice(0, 10);
  const h = harness({ loggedIn: true, ask: () => `{"at":"${day} 20:00","repeat":"weekly","text":"開會"}` });
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(5, "grok, 提醒我們每週五晚上8點開會"));
  await h.settle();
  assert.equal(h.asked[0]!.prompt, "提醒我們每週五晚上8點開會");
  const [reminder] = h.reminders.list(GROUP);
  assert.equal(reminder?.text, "開會");
  assert.equal(reminder?.repeat, "weekly");
  assert.equal(reminder?.dueAt, Date.parse(`${day}T12:00:00Z`)); // 20:00 in Taipei is 12:00 UTC
  assert.equal(reminder?.userId, 5);
  const confirmation = h.calls.find((c) => c.method === "sendMessage" && String(c.payload.text).includes(`/remind edit ${reminder!.id}`));
  assert.ok(confirmation, "the confirmation shows the time understood and how to correct it");
  assert.match(String(confirmation.payload.text), /\(Taipei, in \d+ days?\)/);
  assert.deepEqual(JSON.stringify(confirmation.payload.reply_markup).match(/rem:\w:\d+/g), [`rem:p:${reminder!.id}`, `rem:x:${reminder!.id}`]);
});

test("only the person who set a reminder, or the owner, can cancel it", async () => {
  const h = harness();
  h.groups.enable(GROUP, "Grok bot test");
  const id = h.reminders.add({ chatId: GROUP, threadId: 0, messageId: 1, userId: 5, userName: "A", text: "x", dueAt: Date.now() + 60_000, repeat: "none" });
  await h.bot.handleUpdate(h.groupText(6, `/unremind ${id}`));
  assert.equal(h.reminders.count(GROUP), 1);
  await h.bot.handleUpdate(h.groupText(5, `/unremind ${id}`));
  assert.equal(h.reminders.count(GROUP), 0);
});

test("the bot leaves groups that someone other than the owner adds it to", async () => {
  const h = harness();
  const added = (by: number, chat: number) =>
    h.bot.handleUpdate({
      update_id: h.next(),
      my_chat_member: {
        chat: { id: chat, type: "supergroup", title: "x" },
        from: { id: by, is_bot: false, first_name: "x" },
        date: 0,
        old_chat_member: { status: "left", user: { id: 999, is_bot: true, first_name: "Grokky" } },
        new_chat_member: { status: "member", user: { id: 999, is_bot: true, first_name: "Grokky" } },
      },
    } as Update);
  await added(5, -100);
  await added(OWNER, -200);
  assert.deepEqual(
    h.calls.filter((c) => c.method === "leaveChat").map((c) => c.payload.chat_id),
    [-100],
  );
});

test("a screenshot captioned “/tr” gets the text in the image translated (grammY ignores commands in captions)", async () => {
  const shot = join(mkdtempSync(join(tmpdir(), "tr-")), "shot.jpg");
  writeFileSync(shot, "jpeg bytes");
  const h = harness({ loggedIn: true, ask: () => "我在實際工作上測試了 Haiku 5.5。", files: { p1: shot } });
  h.groups.enable(GROUP, "Grok bot test");
  const photo = [{ file_id: "p1", file_unique_id: "p1", width: 800, height: 600 }];
  await h.bot.handleUpdate(h.groupText(OWNER, "", { text: undefined, photo, caption: "/tr" }));
  await h.until((c) => c.method === "sendMessage");
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0]!.images, 1);
  assert.match(h.asked[0]!.system, /text visible in the image into Traditional Chinese/);
  const sent = h.calls.find((c) => c.method === "sendMessage");
  assert.match(String(sent?.payload.text), /Haiku 5\.5/);
});

test("“/tr en” as a caption picks the language; other captions are not commands", async () => {
  const shot = join(mkdtempSync(join(tmpdir(), "tr-")), "shot.jpg");
  writeFileSync(shot, "jpeg bytes");
  const h = harness({ loggedIn: true, ask: () => "hello", files: { p1: shot } });
  h.groups.enable(GROUP, "Grok bot test");
  const photo = [{ file_id: "p1", file_unique_id: "p1", width: 800, height: 600 }];
  await h.bot.handleUpdate(h.groupText(OWNER, "", { text: undefined, photo, caption: "look at this /tr" }));
  await h.settle();
  assert.equal(h.asked.length, 0);
  await h.bot.handleUpdate(h.groupText(OWNER, "", { text: undefined, photo, caption: "/tr en" }));
  await h.waitFor(() => h.asked.length > 0);
  assert.match(h.asked[0]!.system, /into English/);
});

const photoOf = (id: string) => [{ file_id: id, file_unique_id: id, width: 800, height: 600 }];
function tempJpeg(): string {
  const path = join(mkdtempSync(join(tmpdir(), "img-")), "p.jpg");
  writeFileSync(path, "jpeg bytes");
  return path;
}

test("/tr replying to a screenshot captioned “/tr” translates the image, not the word “/tr”", async () => {
  const h = harness({ loggedIn: true, ask: () => "我測試了 Haiku 5.5", files: { p1: tempJpeg() } });
  h.groups.enable(GROUP, "Grok bot test");
  const screenshot = { message_id: 50, date: 0, chat: { id: GROUP, type: "supergroup" }, from: { id: OWNER, is_bot: false, first_name: "O" }, photo: photoOf("p1"), caption: "/tr" };
  await h.bot.handleUpdate(h.groupText(OWNER, "/tr@GrokTest_bot", { reply_to_message: screenshot }));
  await h.waitFor(() => h.asked.length > 0);
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0]!.images, 1, "the screenshot is read");
  assert.notEqual(h.asked[0]!.prompt, "/tr");
});

test("/img creates an image and posts it as a reply; replying to a photo edits that photo", async () => {
  const h = harness({ loggedIn: true, files: { p1: tempJpeg() } });
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(5, "/img a shiba astronaut"));
  await h.settle();
  assert.deepEqual(h.created, [{ prompt: "a shiba astronaut", sources: 0 }]);
  const photo = h.calls.find((c) => c.method === "sendPhoto");
  assert.ok(photo, "photo posted");
  assert.equal((photo.payload.reply_parameters as { message_id: number }).message_id, 101);

  const original = { message_id: 60, date: 0, chat: { id: GROUP, type: "supergroup" }, from: { id: 6, is_bot: false, first_name: "B" }, photo: photoOf("p1") };
  await h.bot.handleUpdate(h.groupText(5, "/img 改成鉛筆素描", { reply_to_message: original }));
  await h.settle();
  assert.deepEqual(h.created[1], { prompt: "改成鉛筆素描", sources: 1 });
});

test("members get 10 images a day; the owner is not limited", async () => {
  const h = harness({ loggedIn: true });
  h.groups.enable(GROUP, "Grok bot test");
  for (let i = 0; i < 12; i++) await h.bot.handleUpdate(h.groupText(5, `/img cat ${i}`));
  for (let i = 0; i < 12; i++) await h.bot.handleUpdate(h.groupText(OWNER, `/img dog ${i}`));
  await h.settle();
  assert.equal(h.created.filter((c) => c.prompt.startsWith("cat")).length, 10);
  assert.equal(h.created.filter((c) => c.prompt.startsWith("dog")).length, 12);
});

test("an image Grok creates while answering is posted after the text reply", async () => {
  const h = harness({
    loggedIn: true,
    agent: async (images, key) => {
      const result = await images.tool(key).execute("call1", { prompt: "a shiba astronaut, watercolor" });
      assert.equal(result.isError, false);
      return "畫好了！";
    },
  });
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(5, "grok, 畫一隻柴犬太空人"));
  await h.settle();
  const methods = h.calls.map((c) => c.method).filter((m) => m === "sendMessage" || m === "sendPhoto");
  assert.deepEqual(methods, ["sendMessage", "sendPhoto"]);
});

test("/lm add, list and delete: anyone adds, only the author or the owner deletes", async () => {
  const h = harness();
  h.groups.enable(GROUP, "Grok bot test");
  h.groups.setTidy(GROUP, false);
  await h.bot.handleUpdate(h.groupText(5, "/lm add 小明吃素"));
  await h.bot.handleUpdate(h.groupText(6, "/lm 我們住在台北"));
  const [veg, taipei] = h.memory.list(GROUP);
  assert.deepEqual([veg?.text, veg?.userId, taipei?.text], ["小明吃素", 5, "我們住在台北"]);
  await h.bot.handleUpdate(h.groupText(6, `/lm del ${veg!.id}`));
  assert.equal(h.memory.list(GROUP).length, 2, "someone else's note stays");
  await h.bot.handleUpdate(h.groupText(OWNER, `/lm del ${veg!.id}`));
  assert.deepEqual(h.memory.list(GROUP).map((f) => f.text), ["我們住在台北"]);
  await h.bot.handleUpdate(h.groupText(5, "/lm"));
  const listing = h.calls.filter((c) => c.method === "sendMessage").at(-1);
  assert.match(String(listing?.payload.text), /我們住在台北/);
});

test("“grok, 記住…”: the remember tool saves the note under the person who asked", async () => {
  const h = harness({
    loggedIn: true,
    agent: async (_images, key, { memory, speakers }) => {
      const tool = memory.tool(GROUP, () => speakers.get(key));
      const result = await tool.execute("c1", { note: "小美對花生過敏" });
      assert.equal(result.isError, undefined);
      return "記住了";
    },
  });
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(7, "grok, 記住小美對花生過敏"));
  await h.settle();
  const [fact] = h.memory.list(GROUP);
  assert.deepEqual([fact?.text, fact?.userId, fact?.userName], ["小美對花生過敏", 7, "user7"]);
  assert.equal(h.speakers.size, 0, "the speaker is cleared after the answer");
});

test("/tidy deletes setting commands and replies after 2 minutes; /tr and /disable-tidy groups are left alone", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = harness({ loggedIn: true, ask: () => "hello" });
    h.groups.enable(GROUP, "Grok bot test");
    await h.bot.handleUpdate(h.groupText(OWNER, "/lang en")); // message 101, reply = sendMessage id 1
    await h.bot.handleUpdate(h.groupText(OWNER, "/tr ja hi")); // kept
    await h.bot.handleUpdate(h.groupText(OWNER, "/links@SomeOtherBot")); // not ours
    const deleted = () => h.calls.filter((c) => c.method === "deleteMessage").map((c) => c.payload.message_id);
    mock.timers.tick(119_000);
    assert.deepEqual(deleted(), []);
    mock.timers.tick(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deleted().sort(), [1, 101]);

    h.calls.length = 0;
    h.groups.setTidy(GROUP, false);
    await h.bot.handleUpdate(h.groupText(OWNER, "/voice"));
    mock.timers.tick(200_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(deleted(), []);
  } finally {
    mock.timers.reset();
  }
});

test("trusted members are not limited; a limit the owner lowers applies to everyone else at once", async () => {
  const h = harness();
  h.groups.enable(GROUP, "Grok bot test");
  h.limits.set("questionsPerUserHour", 2);
  h.limits.setTrusted(6, true);
  for (let i = 0; i < 4; i++) {
    await h.bot.handleUpdate(h.groupText(5, `grok, q${i}`));
    await h.bot.handleUpdate(h.groupText(6, `grok, q${i}`));
  }
  await h.settle();
  const texts = h.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
  assert.equal(texts.filter((t) => t.includes("needs to log in")).length, 2 + 4, "member 5: 2 answers; trusted member 6: all 4");
  assert.equal(texts.filter((t) => t.startsWith("⏳")).length, 1);
});

test("/stats shows today's usage and what is left of the limits", async () => {
  const h = harness({ loggedIn: true, ask: () => "translated" });
  h.groups.enable(GROUP, "Grok bot test");
  h.groups.setTidy(GROUP, false);
  await h.bot.handleUpdate(h.groupText(5, "grok, hello"));
  await h.bot.handleUpdate(h.groupText(5, "/tr en 你好"));
  await h.settle();
  await h.bot.handleUpdate(h.groupText(5, "/stats"));
  const stats = String(h.calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.text);
  assert.match(stats, /Today: ❓1 · 🌐1/);
  assert.match(stats, /Questions left this hour: 18\/20/, "the question and the /tr both count against the hourly limit");
});

test("an ephemeral command is answered privately to its sender and not scheduled for deletion", async () => {
  const h = harness();
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(5, "/lang", { message_id: 0, ephemeral_message_id: 77 }));
  const reply = h.calls.find((c) => c.method === "sendMessage")!;
  assert.deepEqual(reply.payload.reply_parameters, { ephemeral_message_id: 77 });
  assert.deepEqual(reply.payload.ephemeral_message_parameters, { receiver_user_id: 5 });
  assert.match(String(reply.payload.text), /Translations and link cards/);
});

test("over-limit notices go only to that member; without admin rights they fall back to a normal reply", async () => {
  for (const refuseEphemeral of [false, true]) {
    const h = harness({ refuseEphemeral });
    h.groups.enable(GROUP, "Grok bot test");
    h.limits.set("questionsPerUserHour", 1);
    await h.bot.handleUpdate(h.groupText(5, "grok, one"));
    await h.bot.handleUpdate(h.groupText(5, "grok, two"));
    await h.settle();
    const notice = h.calls.find((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("⏳"))!;
    if (refuseEphemeral) assert.equal(notice.payload.ephemeral_message_parameters, undefined);
    else assert.deepEqual(notice.payload.ephemeral_message_parameters, { receiver_user_id: 5 });
  }
});

test("a question asked by voice in private chat is answered as text and as a voice note", async () => {
  const voice = join(mkdtempSync(join(tmpdir(), "v-")), "q.ogg");
  writeFileSync(voice, "ogg bytes");
  const h = harness({ loggedIn: true, files: { v1: voice } });
  await h.bot.handleUpdate({
    update_id: h.next(),
    message: {
      message_id: 900,
      date: 0,
      chat: { id: OWNER, type: "private", first_name: "O" },
      from: { id: OWNER, is_bot: false, first_name: "O" },
      voice: { file_id: "v1", file_unique_id: "v1", duration: 3 },
    },
  } as Update);
  await h.until((c) => c.method === "sendVoice");
  const methods = h.calls.map((c) => c.method).filter((m) => ["sendMessage", "sendVoice"].includes(m));
  assert.deepEqual(methods, ["sendMessage", "sendMessage", "sendVoice"], "transcript, answer, then the voice note");
  assert.match(String(h.calls.find((c) => c.method === "sendMessage")!.payload.text), /現在幾點/);
  assert.ok(h.calls.some((c) => c.method === "sendMessageDraft"), "the answer streamed as a draft first");
  assert.deepEqual(h.usage.member(OWNER, 1).counts.tts, "ok".length);
});

test("/schedule: owner and trusted members only; it stores an AI-written post", async () => {
  const day = new Date(Date.now() + 2 * 24 * 3600_000 + 8 * 3600_000).toISOString().slice(0, 10);
  const h = harness({ loggedIn: true, ask: () => `{"at":"${day} 08:00","repeat":"daily","text":"台北天氣和重點新聞"}` });
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(5, "/schedule 每天早上8點 台北天氣和重點新聞"));
  await h.settle();
  assert.equal(h.reminders.count(GROUP), 0);
  await h.bot.handleUpdate(h.groupText(OWNER, "/schedule 每天早上8點 台北天氣和重點新聞"));
  await h.settle();
  const [post] = h.reminders.list(GROUP);
  assert.deepEqual([post?.ai, post?.repeat, post?.text], [true, "daily", "台北天氣和重點新聞"]);
});

const STRANGER = 4242;
const privateUpdate = (h: ReturnType<typeof harness>, from: number, text: string, extra: Record<string, unknown> = {}): Update => ({
  update_id: h.next(),
  message: {
    message_id: 3000 + h.next(),
    date: 0,
    chat: { id: from, type: "private", first_name: "S" },
    from: { id: from, is_bot: false, first_name: from === OWNER ? "Owner" : "Stranger", username: "stranger" },
    text,
    ...(text.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }] } : {}),
    ...extra,
  },
} as Update);
const ownerPress = (h: ReturnType<typeof harness>, data: string): Update => ({
  update_id: h.next(),
  callback_query: {
    id: String(h.next()),
    from: { id: OWNER, is_bot: false, first_name: "Owner" },
    chat_instance: "c",
    data,
    message: { message_id: 1, date: 0, chat: { id: OWNER, type: "private", first_name: "Owner" } },
  },
} as Update);
const sentTo = (h: ReturnType<typeof harness>, chatId: number) =>
  h.calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === chatId).map((c) => String(c.payload.text));

test("a stranger's private message: told the bot is private, owner asked once a day; Allow opens the private chat", async () => {
  const h = harness();
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "hi"));
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "hello??"));
  assert.deepEqual(sentTo(h, STRANGER), ["🔒 This bot is private. I've asked its owner whether you may use it."]);
  const request = h.calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === OWNER);
  assert.equal(request.length, 1, "one request per person per day");
  assert.match(String(request[0]!.payload.text), /Stranger[\s\S]*4242/);
  assert.match(JSON.stringify(request[0]!.payload.reply_markup), /adm:req:4242:allow/);

  await h.bot.handleUpdate(ownerPress(h, "adm:req:4242:allow"));
  assert.ok(h.permissions.has(STRANGER, "private"));
  assert.match(sentTo(h, STRANGER).at(-1)!, /You can chat with me now/);
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "what is 2+2?"));
  await h.settle();
  assert.match(sentTo(h, STRANGER).at(-1)!, /owner needs to log in/, "now the stranger is served like the owner");
});

test("people with private access can reset their own chat but not use owner commands; their limits apply", async () => {
  const h = harness();
  h.permissions.set(STRANGER, "private", true);
  h.limits.set("questionsPerUserHour", 1);
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "/new"));
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "/admin"));
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "first"));
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "second"));
  await h.settle();
  const texts = sentTo(h, STRANGER);
  assert.equal(texts[0], "🆕 New conversation.");
  assert.equal(texts[1], "Only the bot owner can do that.");
  assert.ok(texts.some((t) => t.startsWith("⏳ You've reached your limit")));
});

test("private /tr and /remind count against the question limit like questions do", async () => {
  const h = harness({ loggedIn: true, ask: () => "translated" });
  h.permissions.set(STRANGER, "private", true);
  h.limits.set("questionsPerUserHour", 1);
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "first question"));
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "/tr en 你好"));
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "/tr ja hello"));
  await h.bot.handleUpdate(privateUpdate(h, STRANGER, "/remind tomorrow 9:00 call the bank"));
  await h.settle();
  assert.equal(h.runs.length, 1, "the first question was answered");
  assert.deepEqual(h.asked, [], "no translation or reminder parsing reached the AI");
  assert.equal(sentTo(h, STRANGER).filter((t) => t.startsWith("⏳ You've reached your limit")).length, 3);

  // The owner is never limited.
  await h.bot.handleUpdate(privateUpdate(h, OWNER, "/tr en 你好"));
  await h.settle();
  assert.equal(h.asked.length, 1);
});

test("strict groups answer in a throwaway conversation; normal groups keep one", async () => {
  const h = harness({ loggedIn: true });
  h.groups.enable(GROUP, "Grok bot test"); // new groups start strict
  await h.bot.handleUpdate(h.groupText(5, "grok, strict question"));
  await h.settle();
  h.groups.setPrivacy(GROUP, "normal");
  await h.bot.handleUpdate(h.groupText(5, "grok, normal question"));
  await h.settle();
  assert.deepEqual(h.runs.map((r) => [r.key.replace(/:q\d+$/, ":q"), r.ephemeral]), [
    [`tg:${GROUP}:q`, true],
    [`tg:${GROUP}`, false],
  ]);
});

test("blocked people are ignored everywhere; approved-only groups ignore members who aren't approved", async () => {
  const h = harness();
  h.groups.enable(GROUP, "Grok bot test");
  h.permissions.set(5, "blocked", true);
  await h.bot.handleUpdate(h.groupText(5, "grok, hello"));
  await h.bot.handleUpdate(privateUpdate(h, 5, "hello"));
  await h.settle();
  assert.equal(h.calls.filter((c) => c.method === "sendMessage").length, 0, "no answer, no access request");

  h.groups.setAccess(GROUP, "approved");
  h.permissions.set(6, "approved", true);
  h.permissions.set(8, "trusted", true);
  for (const user of [6, 7, 8, OWNER]) await h.bot.handleUpdate(h.groupText(user, `grok, I am ${user}`));
  await h.settle();
  const answeredQuestions = h.calls.filter((c) => c.method === "sendMessage").length;
  assert.equal(answeredQuestions, 3, "approved 6, trusted 8 and the owner; not 7");
});

test("➕ Add people: contacts picked with Telegram's user picker get private access", async () => {
  const h = harness();
  await h.bot.handleUpdate(
    privateUpdate(h, OWNER, "", {
      text: undefined,
      users_shared: { request_id: 71, users: [{ user_id: 9001, first_name: "Mia", username: "mia" }, { user_id: OWNER, first_name: "Me" }] },
    }),
  );
  assert.ok(h.permissions.has(9001, "private"));
  assert.equal(h.permissions.get(9001)?.name, "Mia");
  assert.equal(h.permissions.get(OWNER), undefined, "the owner is never added to the list");
});

test("inline mode works for people with private access, not for others", async () => {
  const h = harness();
  h.permissions.set(STRANGER, "private", true);
  const inline = (from: number) =>
    h.bot.handleUpdate({ update_id: h.next(), inline_query: { id: String(from), from: { id: from, is_bot: false, first_name: "x" }, query: "no link", offset: "" } } as Update);
  await inline(STRANGER);
  await inline(7);
  assert.equal(h.calls.filter((c) => c.method === "answerInlineQuery").length, 2, "both get an answer (empty without a link)");
});

test("/help: members get how-to-talk + their commands; the owner in private is pointed to the guide", async () => {
  const h = harness();
  h.groups.enable(GROUP, "Grok bot test");
  h.groups.setTidy(GROUP, false);
  await h.bot.handleUpdate(h.groupText(5, "/help"));
  assert.match(sentTo(h, GROUP).at(-1)!, /Talking to the bot[\s\S]*Commands for everyone/);
  await h.bot.handleUpdate(privateUpdate(h, OWNER, "/help"));
  assert.match(sentTo(h, OWNER).at(-1)!, /\/admin<\/code> → 📖 <b>Guide/);
});

import { docx } from "./fixtures.ts";

test("reminder buttons: only whoever set it (or the owner) can snooze, pause or cancel; the buttons then show what happened", async () => {
  const h = harness();
  h.groups.enable(GROUP, "Grok bot test");
  const id = h.reminders.add({ chatId: GROUP, threadId: 0, messageId: 1, userId: 5, userName: "A", text: "call", dueAt: Date.now() - 1000, repeat: "none" });
  h.reminders.delivered(h.reminders.get(GROUP, id)!);
  await h.bot.handleUpdate(h.press(6, `rem:s:${id}:10`));
  assert.equal(h.reminders.count(GROUP), 0, "someone else can't snooze it");
  assert.match(JSON.stringify(h.calls.at(-1)!.payload), /Only the person who set it/);

  const before = Date.now();
  await h.bot.handleUpdate(h.press(5, `rem:s:${id}:10`));
  const snoozed = h.reminders.list(GROUP)[0]!;
  assert.ok(snoozed.dueAt >= before + 10 * 60_000 && snoozed.dueAt <= Date.now() + 10 * 60_000);
  const edit = h.calls.find((c) => c.method === "editMessageReplyMarkup")!;
  assert.match(JSON.stringify(edit.payload), /💤 Snoozed to .* by user5/);

  await h.bot.handleUpdate(h.press(OWNER, `rem:p:${id}`));
  assert.equal(h.reminders.list(GROUP)[0]!.paused, true, "the owner may pause anyone's");
  await h.bot.handleUpdate(h.press(5, `rem:x:${id}`));
  assert.equal(h.reminders.get(GROUP, id), undefined);
});

test("/remind edit gives the AI the current reminder and applies the complete change; others can't edit it", async () => {
  const day = new Date(Date.now() + 3 * 24 * 3600_000).toISOString().slice(0, 10);
  const h = harness({ loggedIn: true, ask: () => `{"at":"${day} 21:00","repeat":"none","text":"開會"}` });
  h.groups.enable(GROUP, "Grok bot test");
  const id = h.reminders.add({ chatId: GROUP, threadId: 0, messageId: 1, userId: 5, userName: "A", text: "開會", dueAt: Date.parse(`${day}T12:00:00Z`), repeat: "weekly" });
  await h.bot.handleUpdate(h.groupText(6, `/remind edit ${id} 改到9點`));
  await h.settle();
  assert.equal(h.asked.length, 0);
  await h.bot.handleUpdate(h.groupText(5, `/remind edit ${id} 改到9點，只要這次`));
  await h.settle();
  assert.match(h.asked[0]!.system, new RegExp(`CHANGES this existing reminder: \\{"at":"${day} 20:00","repeat":"weekly","text":"開會"\\}`));
  assert.equal(h.asked[0]!.prompt, "改到9點，只要這次");
  const [changed] = h.reminders.list(GROUP);
  assert.deepEqual([changed?.id, changed?.dueAt, changed?.repeat], [id, Date.parse(`${day}T13:00:00Z`), "none"]);
  assert.ok(h.calls.some((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("✏️ Changed")));
});

test("/tz: anyone can see it, only the owner changes it in a group; reminders there use it", async () => {
  const day = new Date(Date.now() + 2 * 24 * 3600_000).toISOString().slice(0, 10);
  const h = harness({ loggedIn: true, ask: () => `{"at":"${day} 20:00","repeat":"none","text":"call"}` });
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(5, "/tz tokyo"));
  assert.equal(h.groups.timeZone(GROUP), "Asia/Taipei");
  await h.bot.handleUpdate(h.groupText(OWNER, "/tz tokyo"));
  assert.equal(h.groups.timeZone(GROUP), "Asia/Tokyo", "a city name is enough");
  await h.bot.handleUpdate(h.groupText(OWNER, "/tz Mars/Olympus"));
  assert.match(String(h.calls.at(-1)!.payload.text), /don't know the time zone/);
  await h.bot.handleUpdate(h.groupText(5, "/remind tomorrow 20:00 call"));
  await h.settle();
  assert.equal(h.reminders.list(GROUP)[0]!.dueAt, Date.parse(`${day}T11:00:00Z`), "20:00 in Tokyo is 11:00 UTC");
  assert.match(h.asked[0]!.system, /\(Asia\/Tokyo\)/);
  await h.bot.handleUpdate(h.groupText(OWNER, "/tz default"));
  assert.equal(h.groups.timeZone(GROUP), "Asia/Taipei");
});

test("a document sent privately is read and summarized; /tr on a document translates its text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-"));
  const path = (name: string) => {
    const p = join(dir, name);
    writeFileSync(p, docx(["Budget 2027", "Hiring freeze until March"]));
    return p;
  };
  const h = harness({ loggedIn: true, ask: () => "預算 2027", files: { d1: path("a.docx"), d2: path("b.docx") } });
  const document = (id: string, extra: Record<string, unknown> = {}) =>
    privateUpdate(h, OWNER, "", { text: undefined, document: { file_id: id, file_unique_id: id, file_name: "plan.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, ...extra });
  await h.bot.handleUpdate(document("d1"));
  await h.until(() => h.runs.length > 0);
  const input = h.runs[0]!.text;
  assert.match(input, /^Summarize this document/);
  assert.match(input, /<external_content url="document: plan\.docx">[\s\S]*"plan\.docx" \(Word document\)\n\nBudget 2027\nHiring freeze until March[\s\S]*<\/external_content>/);
  assert.equal(existsSync(join(dir, "a.docx")), false, "the downloaded file is deleted once read");

  const sent = { message_id: 77, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "O" }, document: { file_id: "d2", file_unique_id: "d2", file_name: "plan.docx" } };
  await h.bot.handleUpdate(privateUpdate(h, OWNER, "/tr", { reply_to_message: sent }));
  await h.until(() => h.asked.length > 0);
  assert.equal(h.asked[0]!.prompt, "Budget 2027\nHiring freeze until March");

  await h.bot.handleUpdate(privateUpdate(h, OWNER, "", { text: undefined, document: { file_id: "x", file_unique_id: "x", file_name: "setup.exe" } }));
  assert.match(String(h.calls.at(-1)!.payload.text), /I can read PDF, Word/);
});

test("with ✋ confirmations on, the AI's note waits for the asker's ✅: others can't confirm, a second tap does nothing", async () => {
  const h = harness({
    loggedIn: true,
    agent: async (_images, key, { memory, speakers, confirm }) => {
      const result = await memory.tool(GROUP, () => speakers.get(key), confirm).execute("c1", { note: "小美對花生過敏" });
      assert.match(String((result.content[0] as { text: string }).text), /Not saved yet/);
      return "請按 ✅";
    },
  });
  h.groups.enable(GROUP, "Grok bot test");
  assert.equal(h.groups.confirmActions(GROUP), true, "on by default in groups");
  await h.bot.handleUpdate(h.groupText(7, "grok, 記住小美對花生過敏"));
  await h.settle();
  assert.deepEqual(h.memory.list(GROUP), [], "nothing saved before the tap");
  const preview = h.calls.find((c) => c.method === "sendMessage" && String(c.payload.text).includes("Save this note?"))!;
  assert.match(String(preview.payload.text), /小美對花生過敏[\s\S]*user7 or the bot owner can confirm/);
  const ok = JSON.stringify(preview.payload.reply_markup).match(/act:ok:[\w-]+/)![0];

  await h.bot.handleUpdate(h.press(8, ok));
  assert.deepEqual(h.memory.list(GROUP), []);
  await h.bot.handleUpdate(h.press(7, ok));
  await h.bot.handleUpdate(h.press(7, ok));
  assert.deepEqual(h.memory.list(GROUP).map((f) => [f.text, f.userId]), [["小美對花生過敏", 7]], "saved once, under the asker");
  const edits = h.calls.filter((c) => c.method === "editMessageText");
  assert.equal(edits.length, 1, "the second tap runs nothing");
  assert.match(String(edits[0]!.payload.text), /Saved as note #\d+[\s\S]*confirmed by user7/);
});

test("a suggested poll can be discarded; with confirmations off it is posted at once", async () => {
  const h = harness({
    loggedIn: true,
    agent: async (_images, key, { polls, confirm }) => {
      await polls.tool(key, confirm).execute("c1", { question: "晚餐?", options: ["拉麵", "火鍋"] });
      return "ok";
    },
  });
  h.groups.enable(GROUP, "Grok bot test");
  await h.bot.handleUpdate(h.groupText(7, "grok, 開個投票 晚餐 拉麵/火鍋"));
  await h.settle();
  const preview = h.calls.find((c) => String(c.payload.text ?? "").includes("Post this poll?"))!;
  assert.match(String(preview.payload.text), /晚餐\?\n• 拉麵\n• 火鍋/);
  await h.bot.handleUpdate(h.press(OWNER, JSON.stringify(preview.payload.reply_markup).match(/act:no:[\w-]+/)![0]));
  assert.equal(h.calls.filter((c) => c.method === "sendPoll").length, 0);
  assert.match(String(h.calls.find((c) => c.method === "editMessageText")!.payload.text), /Discarded by user1000001/);

  h.groups.setConfirmActions(GROUP, false);
  await h.bot.handleUpdate(h.groupText(7, "grok, 再開一個"));
  await h.settle();
  assert.equal(h.calls.filter((c) => c.method === "sendPoll").length, 1);
});

test("what members see when a reply has no text, or was cut off at the length limit", async () => {
  const replies: { text: string; stopReason?: string; usedTool?: boolean }[] = [
    { text: "", usedTool: true },
    { text: "" },
    { text: "第一段……", stopReason: "length" },
  ];
  const h = harness({ loggedIn: true, agent: async () => replies.shift()! });
  h.groups.enable(GROUP, "Grok bot test");
  const lastText = () => {
    const call = h.calls.filter((c) => ["sendMessage", "editMessageText"].includes(c.method)).at(-1)!;
    return String(call.payload.text);
  };
  await h.bot.handleUpdate(h.groupText(7, "grok, 開個投票"));
  await h.settle();
  assert.equal(lastText(), "✅", "a poll was the answer");
  await h.bot.handleUpdate(h.groupText(7, "grok, ?"));
  await h.settle();
  assert.match(lastText(), /couldn't come up with an answer/);
  await h.bot.handleUpdate(h.groupText(7, "grok, 寫長文"));
  await h.settle();
  assert.match(lastText(), /第一段[\s\S]*cut off at the length limit/);
});

test("only replies to the bot's answers continue a conversation; replies to its other posts are people talking", async () => {
  const voice = join(mkdtempSync(join(tmpdir(), "v-")), "q.ogg");
  writeFileSync(voice, "ogg bytes");
  const h = harness({ loggedIn: true, files: { v1: voice }, distinctIds: true });
  h.groups.enable(GROUP, "Grok bot test");
  h.groups.setPrivacy(GROUP, "normal");
  const now = Math.ceil(Date.now() / 1000) + 1; // Telegram dates are whole seconds; after answers started being recorded
  const fromBot = (message_id: number, text: string) => ({ message_id, date: now, chat: { id: GROUP, type: "supergroup" }, from: { id: 999, is_bot: true, first_name: "Grokky" }, text });
  const sentText = (pattern: RegExp) => h.calls.find((c) => c.method === "sendMessage" && pattern.test(String(c.payload.text)));

  // An answer: the bot's reply to a question.
  await h.bot.handleUpdate(h.groupText(6, "grok, 几点了"));
  await h.until((c) => c.method === "sendMessage" && c.payload.text === "ok");
  const answerId = h.calls.find((c) => c.method === "sendMessage" && c.payload.text === "ok")!.sentId!;
  // A voice transcript (automatic) and a reminder-style notice (any other bot message).
  await h.bot.handleUpdate(h.groupText(5, "", { text: undefined, voice: { file_id: "v1", file_unique_id: "v1", duration: 3 } }));
  await h.until((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("🎙️"));
  assert.ok(sentText(/^🎙️/));
  const runs = h.runs.length;

  const transcriptId = sentText(/^🎙️/)!.sentId!;
  await h.bot.handleUpdate(h.groupText(6, "哈哈 他又在问时间", { reply_to_message: fromBot(transcriptId, "🎙️ 現在幾點？") }));
  await h.bot.handleUpdate(h.groupText(6, "收到", { reply_to_message: fromBot(9999, "⏰ 开会") }));
  await h.settle();
  assert.equal(h.runs.length, runs, "transcripts and reminders don't summon the bot");

  await h.bot.handleUpdate(h.groupText(6, "grok, 他说的对吗", { reply_to_message: fromBot(transcriptId, "🎙️ 現在幾點？") }));
  await h.settle();
  assert.equal(h.runs.length, runs + 1, "with grok, it does");
  await h.bot.handleUpdate(h.groupText(6, "哈哈哈", { reply_to_message: fromBot(answerId, "ok") }));
  await h.bot.handleUpdate(h.groupText(6, "", { text: undefined, sticker: { file_id: "s", file_unique_id: "s", type: "regular", width: 1, height: 1, is_animated: false, is_video: false, emoji: "😂" }, reply_to_message: fromBot(answerId, "ok") }));
  await h.settle();
  assert.equal(h.runs.length, runs + 1, "laughing at an answer isn't a question");
  await h.bot.handleUpdate(h.groupText(6, "那北京呢", { reply_to_message: fromBot(answerId, "ok") }));
  await h.settle();
  assert.equal(h.runs.length, runs + 2, "a reply to an answer continues the conversation");
  const old = { ...fromBot(42, "an answer from before the update"), date: 0 };
  await h.bot.handleUpdate(h.groupText(6, "继续", { reply_to_message: old }));
  await h.settle();
  assert.equal(h.runs.length, runs + 3, "bot messages from before answers were recorded still count");
});

test("no cards for t.me links or adult sites (unless the owner shows them); /platforms off upload stops video cards", async () => {
  const h = harness({ loggedIn: true });
  h.groups.enable(GROUP, "Grok bot test");
  const linkMessage = (url: string) => h.groupText(5, `看 ${url}`, { entities: [{ type: "url", offset: 2, length: url.length }] });
  const startedCards = () => h.calls.filter((c) => c.method === "sendChatAction").length;
  await h.bot.handleUpdate(linkMessage("https://t.me/zaihuanews"));
  await h.bot.handleUpdate(linkMessage("https://pornhub.com"));
  await h.settle();
  assert.equal(startedCards(), 0);
  await h.bot.handleUpdate(linkMessage("https://example.com/article"));
  await h.settle();
  assert.equal(startedCards(), 1, "an ordinary link still gets a card");
  await h.bot.handleUpdate(linkMessage("https://example.com/article"));
  await h.settle();
  assert.equal(startedCards(), 1, "the same link reposted soon after gets no second card");
  const reaction = h.calls.find((c) => c.method === "setMessageReaction");
  assert.deepEqual(reaction?.payload.reaction, [{ type: "emoji", emoji: "👌" }], "the repost gets a 👌 instead, so it doesn't look ignored");
  assert.equal(h.calls.filter((c) => c.method === "setMessageReaction").length, 1, "only the repost, not the t.me or adult links");
  h.groups.setHideAdult(GROUP, false);
  await h.bot.handleUpdate(linkMessage("https://pornhub.com"));
  await h.settle();
  assert.equal(startedCards(), 2, "the owner can allow them");

  const video = () => h.groupText(5, "", { text: undefined, video: { file_id: "vid", file_unique_id: "vid", duration: 30, width: 1, height: 1 } });
  await h.bot.handleUpdate(h.groupText(OWNER, "/platforms off upload"));
  await h.bot.handleUpdate(video());
  await h.settle();
  assert.equal(startedCards(), 2, "uploaded video ignored");
  await h.bot.handleUpdate(h.groupText(OWNER, "/platforms on upload"));
  await h.bot.handleUpdate(video());
  await h.settle();
  assert.equal(startedCards(), 3);
});

test("a YouTube link gets a plain card (no AI) with 📝 Summary; a tap adds the summary once and counts against the tapper's limit", async () => {
  const metadataCalls: string[] = [];
  const video = {
    metadata: async (url: string) => (metadataCalls.push(url), { title: "山间日出", uploader: "Hill Studio", durationSec: 11, description: "日出延时", thumbnail: "https://i.ytimg.com/vi/x/hq.jpg", isLive: false }),
    downloadVideo: async () => undefined,
    watchUrl: async (url: string) => ({ url, title: "山间日出", uploader: "Hill Studio", durationSec: 11, transcriptSource: "subtitles", transcript: "[00:01] 你好", frames: [] }),
  };
  const h = harness({ loggedIn: true, video, distinctIds: true, ask: () => "🎬 **山间日出**\n- 山顶的日出" });
  h.groups.enable(GROUP, "Grok bot test");
  const url = "https://youtube.com/shorts/aBcDeFgHiJk";
  await h.bot.handleUpdate(h.groupText(5, url, { entities: [{ type: "url", offset: 0, length: url.length }] }));
  await h.until((c) => c.method === "editMessageReplyMarkup");
  assert.deepEqual(h.asked, [], "no AI for the card");
  const card = h.calls.find((c) => c.method === "sendPhoto")!;
  assert.match(String(card.payload.caption), /^🎬 <a href="https:\/\/youtube\.com\/shorts\/aBcDeFgHiJk"><b>山间日出<\/b><\/a>\nHill Studio · 0:11/);
  const button = h.calls.find((c) => c.method === "editMessageReplyMarkup")!;
  assert.equal(button.payload.message_id, card.sentId);
  assert.deepEqual(button.payload.reply_markup, { inline_keyboard: [[{ text: "📝", callback_data: "vsum" }, { text: "▶️", url }]] });

  // Someone taps 📝 Summary. The link is read back from the card's title.
  const tap = (from: number) =>
    ({
      update_id: h.next(),
      callback_query: {
        id: String(h.next()),
        from: { id: from, is_bot: false, first_name: `user${from}` },
        chat_instance: "c",
        data: "vsum",
        message: {
          message_id: card.sentId!,
          date: 1,
          chat: { id: GROUP, type: "supergroup" },
          from: { id: 999, is_bot: true, first_name: "Grokky" },
          photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }],
          caption: "🎬 山间日出\nHill Studio · 0:11",
          caption_entities: [{ type: "text_link", offset: 3, length: 7, url }],
        },
      },
    }) as Update;
  h.limits.set("questionsPerUserHour", 1);
  await h.bot.handleUpdate(tap(6));
  await h.until((c) => c.method === "sendMessage" && String(c.payload.text).includes("山顶的日出"));
  assert.equal(h.asked.length, 1, "the AI is asked only now");
  const summary = h.calls.find((c) => c.method === "sendMessage" && String(c.payload.text).includes("山顶的日出"))!;
  assert.equal((summary.payload.reply_parameters as { message_id: number }).message_id, card.sentId, "posted as a reply to the card");
  assert.deepEqual(h.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!.payload.reply_markup, { inline_keyboard: [[{ text: "▶️", url }]] }, "📝 goes, ▶️ stays");
  assert.equal(h.groups.isAnswer(GROUP, summary.sentId!, Date.now()), true, "replies to the summary continue the conversation");

  // Same person again: over their limit (1 per hour), refused without asking the AI.
  await h.bot.handleUpdate(tap(6));
  assert.match(JSON.stringify(h.calls.at(-1)!.payload), /question limit/);
  assert.equal(h.asked.length, 1);
  assert.deepEqual(metadataCalls, [url]);
});

test("a web link gets a plain card (no AI) with 📝 and 🔗; 📝 adds the AI summary of the page", async () => {
  const h = harness({ loggedIn: true, distinctIds: true, preview: async () => ({ title: "翊联电子", snippet: "超硬材料企业" }), ask: () => "🔗 **翊联电子**\n- 郑州的超硬材料企业" });
  h.groups.enable(GROUP, "Grok bot test");
  const url = "https://example.com/yilian";
  await h.bot.handleUpdate(h.groupText(5, `看这个 ${url}`, { entities: [{ type: "url", offset: 4, length: url.length }] }));
  await h.until((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("🔗"));
  assert.equal(h.asked.length, 0, "no AI for the card");
  const card = h.calls.find((c) => c.method === "sendMessage" && String(c.payload.text).startsWith("🔗"))!;
  assert.equal(card.payload.text, `🔗 <a href="${url}"><b>翊联电子</b></a>\n<blockquote expandable>超硬材料企业</blockquote>`);
  assert.deepEqual(card.payload.reply_markup, { inline_keyboard: [[{ text: "📝", callback_data: "vsum" }, { text: "🔗", url }]] });

  await h.bot.handleUpdate({
    update_id: h.next(),
    callback_query: {
      id: "1",
      from: { id: 6, is_bot: false, first_name: "user6" },
      chat_instance: "c",
      data: "vsum",
      message: { message_id: card.sentId!, date: 1, chat: { id: GROUP, type: "supergroup" }, from: { id: 999, is_bot: true, first_name: "Grokky" }, text: "🔗 翊联电子\n超硬材料企业", entities: [{ type: "text_link", offset: 3, length: 4, url }] },
    },
  } as Update);
  await h.until((c) => c.method === "sendMessage" && String(c.payload.text).includes("郑州的超硬材料企业"));
  assert.match(h.asked[0]!.prompt, /翊联电子在郑州/, "the summary reads the page");
  assert.deepEqual(h.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!.payload.reply_markup, { inline_keyboard: [[{ text: "🔗", url }]] }, "📝 goes, 🔗 stays");
});

test("/xstyle picture: the post drawn as a picture first, its own images after, text folded in the caption; drawing fails → text card", async () => {
  const fx = {
    tweet: {
      url: "https://x.com/someone/status/123456",
      text: "港区Netflix已支持微信支付 https://t.co/abc",
      raw_text: { text: "港区Netflix已支持微信支付 https://t.co/abc" },
      lang: "zh",
      created_at: "Fri Oct 10 14:17:00 +0000 2026",
      author: { name: "奶昔", screen_name: "someone", avatar_url: "https://pbs.twimg.com/a.jpg", verification: { verified: true } },
      media: { photos: [{ url: "https://pbs.twimg.com/media/one.jpg" }, { url: "https://pbs.twimg.com/media/two.jpg" }] },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => (String(input).includes("fxtwitter") ? new Response(JSON.stringify(fx)) : realFetch(input))) as typeof fetch;
  try {
    let fail = false;
    const drawn: string[] = [];
    const h = harness({ loggedIn: true, distinctIds: true, xPicture: async (post) => (drawn.push(post.text), fail ? Promise.reject(new Error("fonts missing")) : Buffer.from("png")) });
    h.groups.enable(GROUP, "Grok bot test");
    h.groups.setLanguage(GROUP, "zh-cn");
    await h.bot.handleUpdate(h.groupText(5, "/xstyle picture"));
    assert.equal(h.groups.xStyle(GROUP), "text", "only the owner changes it");
    await h.bot.handleUpdate(h.groupText(OWNER, "/xstyle picture"));
    assert.equal(h.groups.xStyle(GROUP), "picture");

    const post = (url: string) => h.groupText(5, url, { entities: [{ type: "url", offset: 0, length: url.length }] });
    await h.bot.handleUpdate(post("https://x.com/someone/status/123456"));
    await h.until((c) => c.method === "sendMediaGroup");
    const album = h.calls.find((c) => c.method === "sendMediaGroup")!.payload.media as { type: string; media: unknown; caption?: string }[];
    assert.deepEqual(album.map((m) => [m.type, typeof m.media === "string" ? m.media : "uploaded file"]), [
      ["photo", "uploaded file"],
      ["photo", "https://pbs.twimg.com/media/one.jpg?name=large"],
      ["photo", "https://pbs.twimg.com/media/two.jpg?name=large"],
    ], "the picture first, then the post's own images");
    assert.match(album[0]!.caption!, /^𝕏 <b>奶昔<\/b> ☑️ <a href="https:\/\/x\.com\/someone\/status\/123456">@someone<\/a>.*\n<blockquote expandable>港区Netflix已支持微信支付<\/blockquote>$/s);
    assert.equal(h.calls.filter((c) => c.method === "sendMessage" && !String(c.payload.text).startsWith("X posts:") && !String(c.payload.text).startsWith("Only the bot owner")).length, 0, "no follow-up text message under the album");
    assert.deepEqual(drawn, ["港区Netflix已支持微信支付"]);

    // Drawing fails (fonts missing): the ordinary text card, so the post is never lost.
    fail = true;
    h.groups.setXStyle(GROUP, "picture");
    await h.bot.handleUpdate(post("https://x.com/someone/status/999999"));
    await h.until((c) => c.method === "sendMediaGroup" && !(c.payload.media as { media: unknown }[]).some((m) => typeof m.media !== "string"));

  } finally {
    globalThis.fetch = realFetch;
  }
});
