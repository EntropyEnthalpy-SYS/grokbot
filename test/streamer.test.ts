import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ReplyStreamer, type MessageApi } from "../src/telegram/streamer.ts";

type Call = { method: "send" | "edit"; id?: number; text: string; html: boolean; replyTo?: number };

function fakeApi(options: { rejectHtml?: boolean } = {}) {
  const calls: Call[] = [];
  let nextId = 100;
  const api: MessageApi = {
    async sendMessage(_chat, text, other) {
      if (options.rejectHtml && other?.parse_mode) throw { description: "Bad Request: can't parse entities" };
      calls.push({ method: "send", text, html: !!other?.parse_mode, replyTo: other?.reply_parameters?.message_id });
      return { message_id: nextId++ };
    },
    async editMessageText(_chat, id, text, other) {
      if (options.rejectHtml && other?.parse_mode) throw { description: "Bad Request: can't parse entities" };
      const last = calls.filter((c) => c.id === id || c.method === "send").at(-1);
      if (last?.text === text) throw { description: "Bad Request: message is not modified" };
      calls.push({ method: "edit", id, text, html: !!other?.parse_mode });
      return true;
    },
  };
  return { api, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("sends one preview, then edits at most once per throttle window", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { api, calls } = fakeApi();
    const streamer = new ReplyStreamer(api, 1, { replyTo: 7, throttleMs: 1000, minInitialChars: 5 });
    let text = "";
    for (let i = 0; i < 50; i++) {
      text += "word ";
      streamer.update(text);
    }
    mock.timers.tick(1000);
    await settle();
    for (let i = 0; i < 50; i++) {
      text += "more ";
      streamer.update(text);
    }
    mock.timers.tick(1000);
    await settle();
    assert.deepEqual(
      calls.map((c) => c.method),
      ["send", "edit"],
    );
    assert.equal(calls[0]?.replyTo, 7);
    assert.equal(calls[1]?.text, text.trim());

    await streamer.finish("**Done**");
    assert.deepEqual(calls.at(-1), { method: "edit", id: 100, text: "<b>Done</b>", html: true });
  } finally {
    mock.timers.reset();
  }
});

test("waits for enough text before the first preview", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { api, calls } = fakeApi();
    const streamer = new ReplyStreamer(api, 1, { throttleMs: 1000, minInitialChars: 24 });
    streamer.update("Hi");
    mock.timers.tick(1000);
    await settle();
    assert.equal(calls.length, 0);
    await streamer.finish("Hi");
    assert.deepEqual(calls, [{ method: "send", text: "Hi", html: true, replyTo: undefined }]);
  } finally {
    mock.timers.reset();
  }
});

test("long final replies continue in new messages chained as replies", async () => {
  const { api, calls } = fakeApi();
  const streamer = new ReplyStreamer(api, 1, { replyTo: 7 });
  const ids = await streamer.finish(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
  assert.deepEqual(ids, [100, 101]);
  assert.equal(calls[0]?.replyTo, 7);
  assert.equal(calls[1]?.replyTo, 100);
});

test("falls back to plain text when Telegram rejects the HTML", async () => {
  const { api, calls } = fakeApi({ rejectHtml: true });
  const streamer = new ReplyStreamer(api, 1);
  await streamer.finish("**x**");
  assert.deepEqual(calls, [{ method: "send", text: "**x**", html: false, replyTo: undefined }]);
});
