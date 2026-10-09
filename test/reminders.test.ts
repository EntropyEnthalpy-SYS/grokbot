import assert from "node:assert/strict";
import { test } from "node:test";
import { openDbAt } from "../src/db.ts";
import { deliverDueReminders, isReminderRequest, nextDue, parseReminderAnswer, ReminderStore, type Reminder } from "../src/reminders.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// Thu 2026-10-08 22:00 in Taipei = 14:00 UTC.
const NOW = Date.UTC(2026, 9, 8, 14, 0);

test("Grok's Taipei local time becomes the right instant", () => {
  const parsed = parseReminderAnswer('```json\n{"at":"2026-10-09 09:30","repeat":"none","text":"call the bank"}\n```', NOW);
  assert.deepEqual(parsed, { ok: true, dueAt: Date.UTC(2026, 9, 9, 1, 30), repeat: "none", text: "call the bank" });
});

test("a one-off time in the past is refused; a repeating one starts at its next occurrence", () => {
  assert.equal(parseReminderAnswer('{"at":"2026-10-08 21:00","repeat":"none","text":"x"}', NOW).ok, false);
  // "every day 21:00" asked at 22:00 → tomorrow 21:00, not now.
  const daily = parseReminderAnswer('{"at":"2026-10-08 21:00","repeat":"daily","text":"x"}', NOW);
  assert.ok(daily.ok);
  assert.equal(daily.ok && daily.dueAt, Date.UTC(2026, 9, 9, 13, 0));
});

test("no time, bad JSON, empty text, and far-future times are refused", () => {
  assert.deepEqual(parseReminderAnswer('{"error":"no time given"}', NOW), { ok: false, reason: "no time given" });
  assert.equal(parseReminderAnswer("sure! tomorrow", NOW).ok, false);
  assert.equal(parseReminderAnswer('{"at":"2026-10-09 09:00","text":""}', NOW).ok, false);
  assert.equal(parseReminderAnswer('{"at":"2028-01-01 09:00","text":"x"}', NOW).ok, false);
  assert.equal(parseReminderAnswer('{"at":"tomorrow 9am","text":"x"}', NOW).ok, false);
});

test("nextDue skips missed occurrences instead of firing a backlog", () => {
  const due = NOW - 3 * DAY - HOUR; // missed 4 daily runs
  assert.equal(nextDue(due, "daily", NOW), due + 4 * DAY);
  assert.equal(nextDue(NOW, "weekly", NOW), NOW + 7 * DAY, "exactly due now → next week");
  assert.equal(nextDue(NOW + 5, "daily", NOW), NOW + 5);
});

test("reminder requests are recognised; questions that merely mention reminding are not", () => {
  for (const text of ["提醒我們週五開會", "remind us tomorrow 9:00", "請提醒我明天交報告", "please remind me in 2 hours", "Set a reminder for 5pm"]) {
    assert.equal(isReminderRequest(text), true, text);
  }
  for (const text of ["我忘了提醒他", "reminder of the group rules?", "what does remind mean"]) assert.equal(isReminderRequest(text), false, text);
});

function storeWith(...entries: Partial<Reminder>[]) {
  const store = new ReminderStore(openDbAt(":memory:"), () => "Asia/Taipei");
  for (const entry of entries) {
    store.add({ chatId: -1, threadId: 0, messageId: 3, userId: 5, userName: "A", text: "t", dueAt: NOW, repeat: "none", ...entry });
  }
  return store;
}

test("delivery: one-off reminders leave the list, weekly ones move a week on, disabled groups' are dropped, future ones wait", async () => {
  const store = storeWith({ text: "once" }, { text: "weekly", repeat: "weekly" }, { text: "gone", chatId: -2 }, { text: "later", dueAt: NOW + HOUR });
  const sent: { chatId: number; text: string; other: Record<string, unknown> }[] = [];
  const api = { sendMessage: async (chatId: number, text: string, other: Record<string, unknown>) => void sent.push({ chatId, text, other }) };
  const count = await deliverDueReminders(store, api, (chatId) => chatId === -1, (r) => r.text, NOW);
  assert.equal(count, 2);
  assert.deepEqual(sent.map((s) => s.text), ["once", "weekly"]);
  assert.deepEqual((sent[0]!.other.reply_parameters as { message_id: number }).message_id, 3);
  assert.deepEqual(
    store.list(-1).map((r) => [r.text, r.dueAt]),
    [["later", NOW + HOUR], ["weekly", NOW + 7 * DAY]],
  );
  assert.equal(store.count(-2), 0);
});

test("a failed send is retried a minute later at the same scheduled time, and given up after an hour", async () => {
  const store = storeWith({ text: "flaky", repeat: "daily" });
  let fail = true;
  const sent: string[] = [];
  const api = { sendMessage: async (_: number, text: string) => { if (fail) throw new Error("network"); sent.push(text); } };
  await deliverDueReminders(store, api, () => true, (r) => r.text, NOW);
  assert.equal(store.list(-1)[0]!.dueAt, NOW, "the schedule does not drift");
  await deliverDueReminders(store, api, () => true, (r) => r.text, NOW + 30_000);
  assert.deepEqual(sent, [], "not retried within the minute");
  fail = false;
  await deliverDueReminders(store, api, () => true, (r) => r.text, NOW + 61_000);
  assert.deepEqual(sent, ["flaky"]);
  assert.equal(store.list(-1)[0]!.dueAt, NOW + DAY, "daily schedule kept at the original time of day");

  const stuck = storeWith({ text: "stuck" });
  const broken = { sendMessage: async () => { throw new Error("down"); } };
  await deliverDueReminders(stuck, broken, () => true, (r) => r.text, NOW + HOUR + 1);
  assert.equal(stuck.count(-1), 0, "gave up after an hour");
});

test("other time zones, with daylight saving: wall-clock times stay put across the change", async () => {
  const { setTimeZone, localToUtc, localDay, formatLocalTime } = await import("../src/time.ts");
  setTimeZone("America/New_York"); // DST ends 2026-11-01 02:00 local
  try {
    assert.equal(localToUtc(2026, 10, 31, 8, 0), Date.UTC(2026, 9, 31, 12, 0), "EDT = UTC-4");
    assert.equal(localToUtc(2026, 11, 2, 8, 0), Date.UTC(2026, 10, 2, 13, 0), "EST = UTC-5");
    // A daily 08:00 reminder last due on Oct 31: the next ones are 08:00 local, not 07:00.
    const lastDue = Date.UTC(2026, 9, 31, 12, 0);
    assert.equal(nextDue(lastDue, "daily", Date.UTC(2026, 10, 1, 13, 0)), Date.UTC(2026, 10, 2, 13, 0));
    assert.equal(nextDue(lastDue, "daily", Date.UTC(2026, 10, 1, 12, 59)), Date.UTC(2026, 10, 1, 13, 0));
    const parsed = parseReminderAnswer('{"at":"2026-11-02 08:00","repeat":"none","text":"x"}', Date.UTC(2026, 9, 30));
    assert.ok(parsed.ok && parsed.dueAt === Date.UTC(2026, 10, 2, 13, 0));
    assert.equal(localDay(Date.UTC(2026, 10, 2, 4, 59)), "2026-11-01", "still Nov 1 in New York");
    assert.equal(formatLocalTime(Date.UTC(2026, 10, 2, 13, 0)), "2026-11-02 Mon 08:00");
    assert.throws(() => setTimeZone("Mars/Olympus"), /Unknown TIMEZONE/);
  } finally {
    setTimeZone("Asia/Taipei");
  }
});

test("a delivered one-off reminder leaves the list but can be snoozed back for a day; then it is pruned", async () => {
  const store = storeWith({ text: "call the bank" });
  const api = { sendMessage: async () => undefined };
  await deliverDueReminders(store, api, () => true, (r) => r.text, NOW);
  assert.equal(store.count(-1), 0, "no longer listed");
  const delivered = store.get(-1, 1)!;
  assert.equal(delivered.sentCount, 1);
  assert.equal(delivered.lastSentAt, NOW);
  assert.deepEqual(store.due(NOW + DAY), [], "never sent twice");

  assert.equal(store.snooze(delivered, NOW + 10 * 60_000, NOW), 1, "the same reminder comes back");
  assert.deepEqual(store.list(-1).map((r) => [r.id, r.dueAt]), [[1, NOW + 10 * 60_000]]);
  await deliverDueReminders(store, api, () => true, (r) => r.text, NOW + 10 * 60_000);
  assert.equal(store.get(-1, 1)!.sentCount, 2);

  store.prune(NOW + 10 * 60_000 + DAY - 1);
  assert.ok(store.get(-1, 1), "kept for a day");
  store.prune(NOW + 10 * 60_000 + DAY + 1);
  assert.equal(store.get(-1, 1), undefined);
});

test("snoozing a daily reminder adds a one-off copy and leaves the daily schedule alone", () => {
  const store = storeWith({ text: "standup", repeat: "daily" });
  const daily = store.list(-1)[0]!;
  const copy = store.snooze(daily, NOW + HOUR, NOW);
  assert.notEqual(copy, daily.id);
  assert.deepEqual(
    store.list(-1).map((r) => [r.id, r.dueAt, r.repeat]),
    [[daily.id, NOW, "daily"], [copy, NOW + HOUR, "none"]],
  );
});

test("paused reminders are not delivered; a resumed daily one continues at its next time without the missed ones", async () => {
  const store = storeWith({ text: "water plants", repeat: "daily" });
  const sent: string[] = [];
  const api = { sendMessage: async (_: number, text: string) => void sent.push(text) };
  store.setPaused(store.list(-1)[0]!, true, NOW);
  await deliverDueReminders(store, api, () => true, (r) => r.text, NOW + 3 * DAY + HOUR);
  assert.deepEqual(sent, []);
  const resumed = store.setPaused(store.list(-1)[0]!, false, NOW + 3 * DAY + HOUR);
  assert.equal(resumed.dueAt, NOW + 4 * DAY, "next regular time, same clock time");
  assert.deepEqual(store.due(NOW + 3 * DAY + HOUR), []);
});

test("a failed send's retry wait and error survive a restart (they are stored, not in memory)", async () => {
  const db = openDbAt(":memory:");
  const first = new ReminderStore(db, () => "Asia/Taipei");
  first.add({ chatId: -1, threadId: 0, messageId: null, userId: 5, userName: "A", text: "flaky", dueAt: NOW, repeat: "none" });
  await deliverDueReminders(first, { sendMessage: async () => { throw new Error("Bad Gateway"); } }, () => true, (r) => r.text, NOW);
  const restarted = new ReminderStore(db, () => "Asia/Taipei");
  assert.deepEqual(restarted.due(NOW + 30_000), [], "still waiting after the restart");
  assert.equal(restarted.list(-1)[0]!.lastError, "Bad Gateway", "the error shows in /reminders");
  assert.equal(restarted.due(NOW + 60_000).length, 1);
});

test("each chat's time zone: a New York chat's daily 08:00 stays 08:00 across DST; a Taipei chat is unaffected", () => {
  const db = openDbAt(":memory:");
  const store = new ReminderStore(db, (chatId) => (chatId === -7 ? "America/New_York" : "Asia/Taipei"));
  const parsed = parseReminderAnswer('{"at":"2026-10-31 08:00","repeat":"daily","text":"run"}', Date.UTC(2026, 9, 30), store.zone(-7));
  assert.ok(parsed.ok && parsed.dueAt === Date.UTC(2026, 9, 31, 12, 0), "08:00 EDT");
  const ny = store.add({ chatId: -7, threadId: 0, messageId: null, userId: 5, userName: "A", text: "run", dueAt: Date.UTC(2026, 9, 31, 12, 0), repeat: "daily" });
  const tp = store.add({ chatId: -8, threadId: 0, messageId: null, userId: 5, userName: "A", text: "run", dueAt: Date.UTC(2026, 9, 31, 12, 0), repeat: "daily" });
  for (const id of [ny, tp]) store.delivered(store.get(id === ny ? -7 : -8, id)!, Date.UTC(2026, 10, 1, 13, 30));
  assert.equal(store.get(-7, ny)!.dueAt, Date.UTC(2026, 10, 2, 13, 0), "08:00 EST is 13:00 UTC");
  assert.equal(store.get(-8, tp)!.dueAt, Date.UTC(2026, 10, 2, 12, 0), "Taipei has no DST: still 12:00 UTC");
});

test("when Telegram refuses for good (bot removed from the group), there are no retries: one-offs go, repeating ones pause with the reason", async () => {
  const store = storeWith({ text: "once" }, { text: "daily", repeat: "daily" });
  let attempts = 0;
  const kicked = { sendMessage: async () => { attempts++; throw new Error("Call to 'sendMessage' failed! (403: Forbidden: bot was kicked from the supergroup chat)"); } };
  await deliverDueReminders(store, kicked, () => true, (r) => r.text, NOW);
  await deliverDueReminders(store, kicked, () => true, (r) => r.text, NOW + 61_000);
  assert.equal(attempts, 2, "each tried once, never again");
  const [daily] = store.list(-1);
  assert.deepEqual([store.list(-1).length, daily?.text, daily?.paused], [1, "daily", true]);
  assert.match(daily!.lastError!, /bot was kicked/);
  assert.deepEqual(store.due(NOW + 3 * DAY), [], "paused: not delivered");

  // A temporary failure still retries.
  const flaky = storeWith({ text: "x" });
  await deliverDueReminders(flaky, { sendMessage: async () => { throw new Error("Network request for 'sendMessage' failed!"); } }, () => true, (r) => r.text, NOW);
  assert.equal(flaky.due(NOW + 60_000).length, 1);
});
