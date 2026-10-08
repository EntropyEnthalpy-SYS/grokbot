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
    /** The chat agent's turn: may call the create_image tool like Grok would. */
    agent?: (images: ImageStudio, key: string, extra: { memory: MemoryStore; speakers: Map<string, { userId?: number; userName: string }> }) => Promise<string>;
  } = {},
) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const db = openDbAt(":memory:");
  const groups = new GroupStore(db);
  const reminders = new ReminderStore(db);
  const memory = new MemoryStore(db);
  const usage = new UsageStore(db);
  const limits = new LimitStore(db);
  const permissions = new PermissionStore(db);
  const polls = new PollDesk();
  const speakers = new Map<string, { userId?: number; userName: string }>();
  const created: { prompt: string; sources: number }[] = [];
  const images = new ImageStudio(async ({ prompt, sources }) => {
    created.push({ prompt, sources: sources?.length ?? 0 });
    return Buffer.from(`jpeg:${prompt}`);
  });
  const sessions = {
    forgetChat: () => 0,
    reset: () => undefined,
    abort: () => false,
    abortChat: () => 0,
    run: async (key: string, _input: unknown, handlers: { onStart?: () => void }) => {
      handlers.onStart?.();
      const text = options.agent ? await options.agent(images, key, { memory, speakers }) : "ok";
      return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
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
    apiRoot: "http://127.0.0.1:1", // "local Bot API": getFile returns a path on disk
    links: { cache: { get: () => undefined }, video: {} } as never,
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
    return { ok: true, result: ["sendMessage", "sendPhoto", "sendVoice"].includes(method) ? { message_id: 1, date: 0, chat: { id: GROUP, type: "supergroup" } } : true } as never;
  });
  let updateId = 0;
  let messageId = 100;
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
  return { bot, calls, groups, reminders, memory, speakers, usage, limits, permissions, polls, asked, created, images, groupText, settle, next: () => ++updateId };
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
  assert.ok(h.calls.some((c) => c.method === "sendMessage" && String(c.payload.text).includes("/unremind")));
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
  await h.settle();
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
  await h.settle();
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
  await h.settle();
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
  await new Promise((resolve) => setTimeout(resolve, 400));
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
