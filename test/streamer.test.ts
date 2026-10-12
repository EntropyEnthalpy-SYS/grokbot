import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { activityLine, ReplyStreamer, type MessageApi } from "../src/telegram/streamer.ts";

type Call = { method: "send" | "edit" | "rich"; id?: number; text: string; html: boolean; replyTo?: number };

function fakeApi(options: { rejectHtml?: boolean; rich?: "accept" | "reject" } = {}) {
  const calls: Call[] = [];
  let nextId = 100;
  const api: MessageApi = {
    async sendMessage(_chat, text, other) {
      if (options.rejectHtml && other?.parse_mode) throw { description: "Bad Request: can't parse entities" };
      calls.push({ method: "send", text, html: !!other?.parse_mode, replyTo: other?.reply_parameters?.message_id });
      return { message_id: nextId++ };
    },
    async editMessageText(_chat, id, text, other) {
      if (typeof text !== "string") {
        if (options.rich === "reject") throw { error_code: 400, description: "Bad Request: RICH_MESSAGE_TEXT_TOO_LONG" };
        calls.push({ method: "rich", id, text: text.markdown, html: false });
        return true;
      }
      if (options.rejectHtml && other?.parse_mode) throw { description: "Bad Request: can't parse entities" };
      const last = calls.filter((c) => c.id === id || c.method === "send").at(-1);
      if (last?.text === text) throw { description: "Bad Request: message is not modified" };
      calls.push({ method: "edit", id, text, html: !!other?.parse_mode });
      return true;
    },
  };
  if (options.rich) {
    api.sendRichMessage = async (_chat, rich, other) => {
      if (options.rich === "reject") throw { error_code: 400, description: "Bad Request: RICH_MESSAGE_TEXT_TOO_LONG" };
      calls.push({ method: "rich", text: rich.markdown, html: false, replyTo: other?.reply_parameters?.message_id });
      return { message_id: nextId++ };
    };
  }
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

test("a long answer is one rich message: long code collapses, code blocks get 📋, tag-like text survives; short answers stay plain messages", async () => {
  const yaml = Array.from({ length: 40 }, (_, i) => `  rule${i}: <b>${i}</b>`).join("\n");
  const answer = `Use Vec<String> and \`a<b>\`.\n\n${"说明。".repeat(1200)}\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n\`\`\`sh\necho short\n\`\`\``;
  const { api, calls } = fakeApi({ rich: "accept" });
  const streamer = new ReplyStreamer(api, 1, { replyTo: 7 });
  assert.deepEqual(await streamer.finish(answer), [100]);
  assert.equal(calls.length, 1);
  const sent = calls[0]!;
  assert.equal(sent.method, "rich");
  assert.equal(sent.replyTo, 7);
  assert.match(sent.text, /^Use Vec&lt;String> and `a<b>`\./);
  assert.match(sent.text, /<details><summary>📄 yaml · 40 lines<\/summary>\n\n```yaml\n  rule0: <b>0<\/b>\n/);
  // Long code: 📋 asks the bot for block 0 (Telegram's copy button holds 256 characters); short code copies in one tap.
  assert.match(sent.text, /```\n\n<\/details>\n\n<tg-button-row align="left"><tg-button type="callback_data" data="code:0">📋 Copy<\/tg-button><\/tg-button-row>\n\n```sh\n/, "a short block stays open");
  assert.match(sent.text, /```sh\necho short\n```\n\n<tg-button-row align="left"><tg-button type="copy_text" text="echo short">📋 Copy<\/tg-button><\/tg-button-row>$/);

  const short = fakeApi({ rich: "accept" });
  await new ReplyStreamer(short.api, 1).finish("**short**");
  assert.deepEqual(short.calls.map((c) => c.method), ["send"]);
});

test("a long answer edits the preview into the rich message; if Telegram refuses it, the answer is split as before", async () => {
  const long = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
  for (const rich of ["accept", "reject"] as const) {
    const { api, calls } = fakeApi({ rich });
    const streamer = new ReplyStreamer(api, 1, { replyTo: 7, throttleMs: 10, minInitialChars: 1 });
    streamer.update("in progress");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ids = await streamer.finish(long);
    if (rich === "accept") {
      assert.deepEqual(ids, [100]);
      assert.deepEqual(calls.slice(1).map((c) => [c.method, c.id]), [["rich", 100]]);
    } else {
      assert.deepEqual(ids, [100, 101]);
      assert.deepEqual(calls.slice(1).map((c) => [c.method, c.replyTo ?? c.id]), [["edit", 100], ["send", 100]]);
    }
  }
});

test("falls back to plain text when Telegram rejects the HTML", async () => {
  const { api, calls } = fakeApi({ rejectHtml: true });
  const streamer = new ReplyStreamer(api, 1);
  await streamer.finish("**x**");
  assert.deepEqual(calls, [{ method: "send", text: "**x**", html: false, replyTo: undefined }]);
});

test("a status line shows what the bot is doing before any text, sits under the text, and the answer replaces it", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { api, calls } = fakeApi();
    const streamer = new ReplyStreamer(api, 1, { replyTo: 7, throttleMs: 1000, minInitialChars: 24 });
    streamer.status(activityLine("x_keyword_search"));
    mock.timers.tick(1000);
    await settle();
    assert.deepEqual(calls.map((c) => [c.method, c.text, c.replyTo]), [["send", "🔍 Searching X…", 7]], "sent at once, though shorter than minInitialChars");
    streamer.update("我查一下");
    streamer.status(activityLine("read_link"));
    mock.timers.tick(1000);
    await settle();
    assert.equal(calls.at(-1)?.text, "我查一下\n\n📖 Reading the link…");
    streamer.update("我查一下。答案是");
    mock.timers.tick(1000);
    await settle();
    assert.equal(calls.at(-1)?.text, "我查一下。答案是", "new text ends the status line");
    await streamer.finish("Answer");
    assert.deepEqual(calls.at(-1), { method: "edit", id: 100, text: "Answer", html: true });
    assert.equal(calls.filter((c) => c.method === "send").length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("status lines name Grok's own searches and the bot's tools", () => {
  assert.equal(activityLine("web_search"), "🔍 Searching the web…");
  assert.equal(activityLine("x_semantic_search"), "🔍 Searching X…");
  assert.equal(activityLine("watch_video"), "🎬 Watching the video…");
  assert.equal(activityLine("something_new"), "⚙️ Working on it…");
});

test("“Too Many Requests” on the final answer: it waits as long as Telegram says and sends it anyway", async () => {
  const { api, calls } = fakeApi();
  let refused = 0;
  const edit = api.editMessageText.bind(api);
  api.editMessageText = async (chat, id, text, other) => {
    if (other?.parse_mode && refused++ === 0) throw { error_code: 429, description: "Too Many Requests: retry after 0", parameters: { retry_after: 0 } };
    return edit(chat, id, text, other);
  };
  const streamer = new ReplyStreamer(api, 1, { throttleMs: 10, minInitialChars: 1 });
  streamer.update("a long answer in progress");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = Date.now();
  const ids = await streamer.finish("**Done**");
  assert.deepEqual(ids, [100]);
  assert.equal(refused, 2, "refused once, then accepted");
  assert.ok(Date.now() - started >= 900, "waited before retrying");
  assert.deepEqual(calls.at(-1), { method: "edit", id: 100, text: "<b>Done</b>", html: true });
});
