import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { chatOfKey, cleanPoll, PollDesk } from "../src/agent/polls.ts";
import { openDbAt } from "../src/db.ts";
import { speakableText, toVoiceNote } from "../src/media/tts.ts";
import { backupWithoutSecrets, OpsClient } from "../src/ops.ts";
import { deliverDueReminders, ReminderStore } from "../src/reminders.ts";
import { RateLimiter } from "../src/telegram/rateLimit.ts";
import { ReplyStreamer } from "../src/telegram/streamer.ts";
import { LimitStore, usageDay, UsageStore } from "../src/usage.ts";
import { PermissionStore } from "../src/permissions.ts";

const HOUR = 3600_000;

test("usage days follow Taipei midnight, not UTC", () => {
  assert.equal(usageDay(Date.UTC(2026, 9, 8, 15, 59)), "2026-10-08"); // 23:59 Taipei
  assert.equal(usageDay(Date.UTC(2026, 9, 8, 16, 0)), "2026-10-09"); // 00:00 Taipei
});

test("usage: per-member counts add up per day and window; providers keep tokens apart; other chats can be filtered", () => {
  const usage = new UsageStore(openDbAt(":memory:"));
  const now = Date.UTC(2026, 9, 9, 4, 0);
  const amy = { id: 5, name: "Amy" };
  usage.record(-1, amy, "question", 1, now);
  usage.record(-1, amy, "question", 1, now);
  usage.record(-1, amy, "image", 1, now - 3 * 24 * HOUR);
  usage.record(-2, { id: 6, name: "Ben" }, "question", 1, now);
  usage.recordTokens("xai", 1200, 300, now);
  usage.recordTokens("xai", 800, 100, now);
  usage.recordTokens("openai", 50, 10, now);
  assert.deepEqual(usage.member(5, 1, now).counts, { question: 2 });
  assert.deepEqual(usage.member(5, 7, now).counts, { question: 2, image: 1 });
  assert.deepEqual(
    usage.members(7, now, -1).map((m) => m.name),
    ["Amy"],
  );
  assert.deepEqual(usage.providers(1, now), [
    { provider: "xai", input: 2000, output: 400, requests: 2 },
    { provider: "openai", input: 50, output: 10, requests: 1 },
  ]);
  assert.ok(usage.members(7, now).every((m) => m.userId !== 0), "provider rows never show up as members");
});

test("limits: defaults, clamped nudges, trusted members; a changed limit applies to the running limiter at once", () => {
  const limits = new LimitStore(openDbAt(":memory:"));
  assert.equal(limits.get("questionsPerUserHour"), 20);
  assert.equal(limits.nudge("questionsPerUserHour", -1), 15);
  assert.equal(limits.set("imagesPerUserDay", -5), 0, "never below the minimum");
  limits.setTrusted(7, true);
  limits.setTrusted(8, true);
  limits.setTrusted(7, false);
  assert.deepEqual([...limits.trusted()], [8]);

  const limiter = new RateLimiter(() => limits.get("questionsPerUserHour"), HOUR);
  for (let i = 0; i < 15; i++) assert.equal(limiter.take("u", 1000 + i), true);
  assert.equal(limiter.take("u", 2000), false);
  limits.nudge("questionsPerUserHour", 1); // 20 again
  assert.equal(limiter.take("u", 2001), true, "the owner raised the limit: allowed without a restart");
});

test("polls: input is checked and cleaned; the chat and forum topic come from the conversation key", async () => {
  assert.deepEqual(chatOfKey("tg:-100123:topic:7"), { chatId: -100123, threadId: 7 });
  assert.deepEqual(chatOfKey("tg:-5:q99"), { chatId: -5, threadId: undefined });
  assert.deepEqual(cleanPoll({ question: " 晚餐？ ", options: ["拉麵", " 拉麵", "火鍋", ""] }), {
    question: "晚餐？",
    options: ["拉麵", "火鍋"],
    multiple: false,
    anonymous: false,
  });
  assert.throws(() => cleanPoll({ question: "x", options: ["only one", "only one"] }), /at least 2/);
  assert.throws(() => cleanPoll({ question: "x", options: Array.from({ length: 13 }, (_, i) => `o${i}`) }), /at most 12/);

  const desk = new PollDesk();
  const posted: unknown[] = [];
  desk.poster = async (chatId, threadId, poll) => void posted.push({ chatId, threadId, poll });
  const ok = await desk.tool("tg:-100123:topic:7").execute("c", { question: "晚餐？", options: ["拉麵", "火鍋"], multiple_answers: true });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(posted, [{ chatId: -100123, threadId: 7, poll: { question: "晚餐？", options: ["拉麵", "火鍋"], multiple: true, anonymous: false } }]);
  const bad = await desk.tool("tg:-1").execute("c", { question: "?", options: ["a"] });
  assert.equal(bad.isError, true);
});

test("spoken replies leave out code, links and formatting, and stop at a sentence end", () => {
  const md = "**好的！** 這是答案。\n- 第一點 [來源](https://x.com/a)\n```js\nconst x = 1\n```\n看 https://example.com 更多。";
  assert.equal(speakableText(md), "好的！ 這是答案。\n第一點 來源\n看 更多。");
  const long = "一句話。".repeat(400);
  const spoken = speakableText(long, 100);
  assert.ok(spoken.length <= 100 && spoken.endsWith("。"));
});

test("voice notes: MP3 becomes OGG/Opus (what Telegram plays as a voice message)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-"));
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", join(dir, "a.mp3")]);
  const ogg = await toVoiceNote(readFileSync(join(dir, "a.mp3")));
  assert.equal(ogg.subarray(0, 4).toString(), "OggS");
  assert.ok(ogg.includes(Buffer.from("OpusHead")));
});

test("private replies stream as a Telegram draft (with Stop) and still end as a real message", async () => {
  const calls: string[] = [];
  const api = {
    sendMessage: async (_c: number, text: string) => (calls.push(`send:${text.slice(0, 12)}`), { message_id: 9 }),
    editMessageText: async () => void calls.push("edit"),
    sendMessageDraft: async (_c: number, _d: number, text: string, other?: { can_stop?: boolean }) =>
      void calls.push(`draft:${text.slice(0, 12)}:${other?.can_stop}`),
  };
  const streamer = new ReplyStreamer(api, 1, { draftId: 42, throttleMs: 5 });
  await streamer.start();
  streamer.update("Hello there, this is the beginning of a long answer");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const ids = await streamer.finish("Hello there, final answer.");
  assert.deepEqual(calls, ["draft::true", "draft:Hello there,:true", "send:Hello there,"]);
  assert.deepEqual(ids, [9]);
});

test("if drafts fail, the reply still arrives as a normal message", async () => {
  const calls: string[] = [];
  const api = {
    sendMessage: async (_c: number, text: string) => (calls.push(`send:${text}`), { message_id: 3 }),
    editMessageText: async () => void calls.push("edit"),
    sendMessageDraft: async () => {
      throw new Error("Bad Request: method not found");
    },
  };
  const streamer = new ReplyStreamer(api, 1, { draftId: 42, throttleMs: 5 });
  await streamer.start();
  streamer.update("partial answer text that is long enough");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await streamer.finish("final");
  assert.deepEqual(calls, ["send:final"]);
});

test("ops: a request file is picked up, the result is read once; leftovers (bot restart) are reported once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-"));
  const ops = new OpsClient(dir);
  // Stand-in for the root runner: answer the first request it sees.
  const runner = setInterval(() => {
    for (const name of readdirSync(dir)) {
      const id = name.match(/^request-([a-z0-9]+)\.json$/)?.[1];
      if (!id) continue;
      const { action } = JSON.parse(readFileSync(join(dir, name), "utf8"));
      unlinkSync(join(dir, name));
      writeFileSync(join(dir, `result-${id}.json`), JSON.stringify({ action, ok: true, output: "grokbot: active", finishedAt: 1 }));
    }
  }, 20);
  try {
    const result = await ops.run("status", 3000);
    assert.deepEqual(result, { action: "status", ok: true, output: "grokbot: active", finishedAt: 1 });
    await ops.request("restart-bot");
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    clearInterval(runner);
  }
  assert.deepEqual((await ops.leftovers()).map((r) => r.action), ["restart-bot"]);
  assert.deepEqual(await ops.leftovers(), []);
});

test("backup copies everything except logins and API keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "bak-"));
  const db = openDbAt(join(dir, "live.db"));
  db.prepare("INSERT INTO credentials (provider_id, json, updated_at) VALUES ('xai', '{\"type\":\"oauth\"}', 1)").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('device_id', 'abc'), ('model', 'grok-4.7')").run();
  db.prepare("INSERT INTO group_memory (chat_id, text, user_name, created_at) VALUES (-1, '小明吃素', 'A', 1)").run();
  const path = backupWithoutSecrets(db, dir);
  const copy = new DatabaseSync(path);
  assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n, 0);
  assert.deepEqual(copy.prepare("SELECT key FROM settings").all().map((r) => (r as { key: string }).key), ["model"]);
  assert.equal((copy.prepare("SELECT text FROM group_memory").get() as { text: string }).text, "小明吃素");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n, 1, "the live database keeps its logins");
});

test("scheduled posts are written at due time and stand alone; plain reminders still reply to the request", async () => {
  const store = new ReminderStore(openDbAt(":memory:"), () => "Asia/Taipei");
  const now = Date.UTC(2026, 9, 9, 0, 0);
  store.add({ chatId: -1, threadId: 0, messageId: 11, userId: 5, userName: "A", text: "台北天氣", dueAt: now, repeat: "daily", ai: true });
  store.add({ chatId: -1, threadId: 0, messageId: 12, userId: 5, userName: "A", text: "開會", dueAt: now, repeat: "none" });
  const sent: { text: string; other: Record<string, unknown> }[] = [];
  const api = { sendMessage: async (_c: number, text: string, other: Record<string, unknown>) => void sent.push({ text, other }) };
  await deliverDueReminders(store, api, () => true, async (r) => (r.ai ? `🗓 written: ${r.text}` : `⏰ ${r.text}`), now);
  // Plain reminders go first; an AI-written post (slow) must not hold them up.
  assert.deepEqual(sent.map((s) => s.text), ["⏰ 開會", "🗓 written: 台北天氣"]);
  assert.equal((sent[0]!.other.reply_parameters as { message_id: number }).message_id, 12);
  assert.equal(sent[1]!.other.reply_parameters, undefined);
  assert.equal(store.list(-1)[0]!.ai, true, "the daily post stays scheduled");
});

test("trusted members saved before permissions existed carry over once; blocking clears the other permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-"));
  const path = join(dir, "old.db");
  const old = openDbAt(path);
  old.prepare("INSERT INTO settings (key, value) VALUES ('trusted', '[5, 6]')").run();
  old.prepare("DELETE FROM permissions").run();
  old.close();
  const db = openDbAt(path);
  const limits = new LimitStore(db);
  assert.deepEqual([...limits.trusted()].sort(), [5, 6]);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'trusted'").get(), undefined);
  const permissions = new PermissionStore(db);
  permissions.set(5, "private", true);
  const blocked = permissions.set(5, "blocked", true);
  assert.deepEqual([blocked.private, blocked.trusted, blocked.blocked], [false, false, true]);
  assert.equal(permissions.set(5, "approved", true).blocked, false, "giving a permission unblocks");
});

test("/tidy deletions survive a restart: overdue ones are deleted on start, later ones re-armed", async () => {
  const { DeleteQueue } = await import("../src/telegram/deleteQueue.ts");
  const db = openDbAt(":memory:");
  const deleted: string[] = [];
  const api = { deleteMessage: async (chat: number, id: number) => void deleted.push(`${chat}/${id}`) };
  const before = new DeleteQueue(db, api);
  const t0 = Date.now();
  before.schedule(-1, 10, 60_000, t0 - 120_000); // was due a minute ago
  before.schedule(-1, 11, 60_000, t0); // due in a minute
  before.schedule(-1, 0, 60_000, t0); // ephemeral: nothing to delete
  before.stop(); // the bot restarts before any timer fires

  const after = new DeleteQueue(db, api);
  assert.equal(await after.resume(t0), 1);
  assert.deepEqual(deleted, ["-1/10"]);
  assert.deepEqual(
    db.prepare("SELECT message_id FROM pending_deletes").all().map((r) => Number((r as { message_id: number }).message_id)),
    [11],
    "the later one waits for its time",
  );
  after.stop();
});

test("rate limiter forgets idle keys once per window, not only above 1000 keys", () => {
  const limiter = new RateLimiter(5, HOUR);
  for (let i = 0; i < 10; i++) limiter.take(`user${i}`, 0);
  limiter.take("late", 2 * HOUR);
  assert.equal(limiter.size, 1);
});

test("site cookies: a pasted header is cleaned and stored privately; junk is refused; values are never listed", async () => {
  const { CookieStore } = await import("../src/links/cookies.ts");
  const { statSync } = await import("node:fs");
  const path = join(mkdtempSync(join(tmpdir(), "ck-")), "cookies.json");
  const cookies = new CookieStore(path);
  cookies.set("zhihu", "Cookie: z_c0=abc; d_c0=xyz\n");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { zhihu: "z_c0=abc; d_c0=xyz" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => cookies.set("zhihu", "just some text"), /doesn't look like a cookie/);
  assert.throws(() => cookies.set("evilsite", "a=1"), /unknown platform/);
  assert.equal(cookies.has("zhihu"), true);
  cookies.clear("zhihu");
  assert.equal(cookies.has("zhihu"), false);
});
