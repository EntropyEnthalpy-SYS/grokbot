import assert from "node:assert/strict";
import { test } from "node:test";
import { openDbAt } from "../src/db.ts";
import { checkDueWatches, isWatchRequest, parseWatchAnswer, parseWatchRequest, WatchStore, type WatchDeps } from "../src/watches.ts";

const HOUR = 3600_000;

test("how often and what: every Nh / 每N小時, default 3 h, kept within 1–24 h", () => {
  assert.deepEqual(parseWatchRequest("every 6h new yt-dlp releases"), { everyHours: 6, task: "new yt-dlp releases" });
  assert.deepEqual(parseWatchRequest("台積電股價跌破900 每2小時"), { everyHours: 2, task: "台積電股價跌破900" });
  assert.deepEqual(parseWatchRequest("每隔 12 个小时 看看 iPhone 18 发布"), { everyHours: 12, task: "看看 iPhone 18 发布" });
  assert.deepEqual(parseWatchRequest("GPT-7 release"), { everyHours: 3, task: "GPT-7 release" });
  assert.equal(parseWatchRequest("every 99 hours x").everyHours, 24);
  assert.equal(parseWatchRequest("every 0h x").everyHours, 1);
});

test("watch requests are told apart from questions and from reminders", () => {
  for (const text of ["tell me when GPT-7 is released", "let us know if SpaceX launches today", "Notify me once the price drops", "keep an eye on github.com/a/b releases", "OpenAI 發布 GPT-7 的時候告訴我", "股价跌破900时通知我们", "幫我盯著 iPhone 18 的消息"])
    assert.equal(isWatchRequest(text), true, text);
  for (const text of ["告诉我这是什么", "tell me about GPT-7", "what's the weather?", "明天8點提醒我開會", "remind me at 9", "when is GPT-7 coming?", "I'll tell you when I'm home", "watch this video and summarize it", "关注一下这个问题"])
    assert.equal(isWatchRequest(text), false, text);
});

test("a check's answer: nothing is news on the first check or when the state didn't change", () => {
  assert.deepEqual(parseWatchAnswer('ok {"state":"Not out yet.","new":"It is out!","done":false}', undefined), { state: "Not out yet.", news: "", done: false });
  assert.equal(parseWatchAnswer('{"state":"Not out yet.","new":"Still not out","done":false}', "Not out yet.").news, "");
  assert.deepEqual(parseWatchAnswer('{"state":"Released 12 Oct.","new":"**GPT-7 is out** https://openai.com","done":true}', "Not out yet."), {
    state: "Released 12 Oct.",
    news: "**GPT-7 is out** https://openai.com",
    done: true,
  });
  assert.throws(() => parseWatchAnswer("I couldn't search right now.", "x"), /no usable answer/);
});

function setup(answers: string[], options: { active?: boolean; sendError?: string } = {}) {
  const store = new WatchStore(openDbAt(":memory:"));
  const sent: { chatId: number; html: string; other: Record<string, unknown> }[] = [];
  const prompts: string[] = [];
  const deps: WatchDeps = {
    ask: async (system) => {
      prompts.push(system);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("AI is down");
      return answer;
    },
    send: async (chatId, html, other) => {
      if (options.sendError) throw new Error(options.sendError);
      sent.push({ chatId, html, other });
    },
    isActive: () => options.active ?? true,
    zoneOf: () => "Asia/Taipei",
    markup: (w) => ({ inline_keyboard: [[{ text: "⏹", callback_data: `wat:x:${w.id}` }]] }),
  };
  const t0 = 2_000_000_000_000;
  const id = store.add({ chatId: -5, threadId: 7, userId: 1, userName: "A", task: "GPT-7 release", everyHours: 3, state: "Not out yet." }, t0);
  return { store, deps, sent, prompts, t0, id };
}

test("due watches are checked against the last state and post only news; a one-time event ends the watch", async () => {
  const { store, deps, sent, prompts, t0, id } = setup([
    '{"state":"Not out yet.","new":"","done":false}',
    '{"state":"Released 12 Oct.","new":"**GPT-7 is out**","done":true}',
  ]);
  assert.equal(await checkDueWatches(store, deps, t0 + 2 * HOUR), 0, "not due yet");
  assert.equal(prompts.length, 0);
  assert.equal(await checkDueWatches(store, deps, t0 + 3 * HOUR), 0, "due, nothing new: silent");
  assert.match(prompts[0]!, /What the last check found: Not out yet\./);
  assert.equal(store.get(-5, id)!.nextAt, t0 + 6 * HOUR);
  assert.equal(await checkDueWatches(store, deps, t0 + 6 * HOUR), 1);
  assert.match(sent[0]!.html, /^👀 <b>GPT-7 release<\/b>\n\n<b>GPT-7 is out<\/b>[\s\S]*stopped watching/);
  assert.equal(sent[0]!.other.message_thread_id, 7, "in the topic it was set in");
  assert.equal(sent[0]!.other.reply_markup, undefined, "no Stop button: it already stopped");
  assert.equal(store.get(-5, id), undefined);
});

test("ongoing watches keep the new state and a Stop button; failures retry within the hour; disabled groups and 30-day-old watches end", async () => {
  const ongoing = setup(['{"state":"v2 released.","new":"v2 is out","done":false}']);
  await checkDueWatches(ongoing.store, ongoing.deps, ongoing.t0 + 3 * HOUR);
  assert.deepEqual(ongoing.sent[0]!.other.reply_markup, { inline_keyboard: [[{ text: "⏹", callback_data: `wat:x:${ongoing.id}` }]] });
  assert.deepEqual([ongoing.store.get(-5, ongoing.id)!.state, ongoing.store.get(-5, ongoing.id)!.alerts], ["v2 released.", 1]);

  const down = setup([]);
  await checkDueWatches(down.store, down.deps, down.t0 + 3 * HOUR);
  const after = down.store.get(-5, down.id)!;
  assert.deepEqual([after.lastError, after.nextAt, after.state], ["AI is down", down.t0 + 4 * HOUR, "Not out yet."]);

  const kicked = setup(['{"state":"x","new":"y","done":false}'], { sendError: "Forbidden: bot was kicked from the supergroup chat" });
  await checkDueWatches(kicked.store, kicked.deps, kicked.t0 + 3 * HOUR);
  assert.equal(kicked.store.count(-5), 0);

  const disabled = setup([], { active: false });
  await checkDueWatches(disabled.store, disabled.deps, disabled.t0 + 3 * HOUR);
  assert.equal(disabled.store.count(-5), 0);

  const old = setup([]);
  await checkDueWatches(old.store, old.deps, old.t0 + 31 * 24 * HOUR);
  assert.match(old.sent[0]!.html, /Stopped watching <b>GPT-7 release<\/b> after 30 days/);
  assert.equal(old.prompts.length, 0, "no AI request for it");
  assert.equal(old.store.count(-5), 0);
});
