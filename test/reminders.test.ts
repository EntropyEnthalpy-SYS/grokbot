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
  const store = new ReminderStore(openDbAt(":memory:"));
  for (const entry of entries) {
    store.add({ chatId: -1, threadId: 0, messageId: 3, userId: 5, userName: "A", text: "t", dueAt: NOW, repeat: "none", ...entry });
  }
  return store;
}

test("delivery: one-off reminders are deleted, weekly ones move a week on, disabled groups' are dropped, future ones wait", async () => {
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
