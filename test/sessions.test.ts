import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { trimContext } from "../src/agent/sessions.ts";

const msg = (role: string, tag: string) => ({ role, tag }) as unknown as AgentMessage;
const tags = (messages: AgentMessage[]) => messages.map((m) => (m as unknown as { tag: string }).tag);

test("keeps everything when under the limit", () => {
  const messages = [msg("system", "s"), msg("user", "u1"), msg("assistant", "a1")];
  assert.deepEqual(tags(trimContext(messages, 10)), ["s", "u1", "a1"]);
});

test("keeps the system prompt and starts the window at a user message", () => {
  const messages = [
    msg("system", "s"),
    msg("user", "u1"),
    msg("assistant", "a1-call"),
    msg("toolResult", "t1"),
    msg("assistant", "a1"),
    msg("user", "u2"),
    msg("assistant", "a2"),
  ];
  // The last 4 would start at the tool result t1; it must not be sent without its call.
  assert.deepEqual(tags(trimContext(messages, 4)), ["s", "u2", "a2"]);
});

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { ChatSessions } from "../src/agent/sessions.ts";
import { openDbAt } from "../src/db.ts";

const model = xaiProvider().getModels()[0]!;
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A Grok whose replies wait until the test releases them. */
function slowGrok() {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const streaming = new Promise<void>((resolve) => (started = resolve));
  const grok = {
    model: () => model,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zero,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      started();
      release = () => stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  };
  return { grok, streaming, release: () => release() };
}

test("a reply still running when /new or /forget resets the chat does not write its history back", { timeout: 5000 }, async () => {
  const db = openDbAt(":memory:");
  const fake = slowGrok();
  const sessions = new ChatSessions({ db, grok: fake.grok as never, systemPrompt: () => "" });
  const rows = () => (db.prepare("SELECT chat_key FROM chats").all() as { chat_key: string }[]).map((r) => r.chat_key);

  const turn = sessions.run("tg:-1", { text: "secret group talk" }).catch(() => undefined);
  await fake.streaming;
  sessions.reset("tg:-1");
  fake.release();
  await turn;
  assert.deepEqual(rows(), [], "reset must win over the finishing turn");
  assert.equal(sessions.pendingChats, 0, "finished queues are dropped");

  // Without a reset, the conversation is stored as usual.
  const fake2 = slowGrok();
  const normal = new ChatSessions({ db, grok: fake2.grok as never, systemPrompt: () => "" });
  const turn2 = normal.run("tg:-2", { text: "hi" });
  await fake2.streaming;
  fake2.release();
  await turn2;
  assert.deepEqual(rows(), ["tg:-2"]);
  assert.equal(normal.pendingChats, 0);
});

test("saved notes reach Grok in the system prompt of every request, but are never stored in the conversation", { timeout: 5000 }, async () => {
  const db = openDbAt(":memory:");
  let notes = "\n- 小明吃素";
  const systems: string[] = [];
  const grok = {
    model: () => model,
    streamFn: (_model: unknown, context: { systemPrompt?: string; messages: { role: string; content: unknown }[] }) => {
      const first = context.messages.find((m) => m.role === "system");
      systems.push(JSON.stringify(context.systemPrompt ?? "") + JSON.stringify(first?.content ?? ""));
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: "stop", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  };
  const sessions = new ChatSessions({ db, grok: grok as never, systemPrompt: () => "BASE", systemExtra: () => notes });
  await sessions.run("tg:-1", { text: "what can 小明 eat?" });
  notes = "\n- 小美對花生過敏";
  await sessions.run("tg:-1", { text: "and 小美?" });
  assert.match(systems[0]!, /BASE[\s\S]*小明吃素/);
  assert.match(systems[1]!, /小美對花生過敏/);
  assert.doesNotMatch(systems[1]!, /小明吃素/, "a deleted note is gone on the next request");
  const stored = (db.prepare("SELECT messages FROM chats").get() as { messages: string }).messages;
  assert.doesNotMatch(stored, /小明吃素|小美對花生過敏/);
});

import { CONVERSATION_RETENTION_MS, dropExpired, TurnCancelledError } from "../src/agent/sessions.ts";

const DAY = 24 * 60 * 60 * 1000;
const at = (role: string, tag: string, timestamp: number) => ({ role, tag, timestamp }) as unknown as AgentMessage;

/** A Grok that records each request and answers only when the test releases that request. */
function gatedGrok() {
  const requests: { texts: string; release: () => void }[] = [];
  let arrived: () => void = () => undefined;
  const grok = {
    model: () => model,
    streamFn: (_model: unknown, context: { messages: { content: unknown }[] }, options?: { signal?: AbortSignal }) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "answer" }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      options?.signal?.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted" } }));
      requests.push({ texts: JSON.stringify(context.messages.map((m) => m.content)), release: () => stream.push({ type: "done", reason: "stop", message }) });
      arrived();
      return stream;
    },
  };
  /** Resolves once `count` requests have reached Grok. */
  const requested = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => (requests.length >= count ? resolve() : (arrived = check));
      check();
    });
  return { grok, requests, requested };
}

/** The database, recording every SQL statement prepared on it. */
function recordingDb() {
  const db = openDbAt(":memory:");
  const statements: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  return { db, statements };
}

test("dropExpired starts at the first recent question and never keeps a tool result without its call", () => {
  const cutoff = 1000;
  const messages = [
    at("system", "s", 0),
    at("user", "u1", 10),
    at("assistant", "a1-call", 20),
    at("toolResult", "t1", cutoff + 5), // recent timestamp, but its question is old
    at("assistant", "a1", cutoff + 6),
    at("user", "u2", cutoff), // exactly at the cutoff: kept
    at("assistant", "a2", cutoff + 1),
  ];
  assert.deepEqual(tags(dropExpired(messages, cutoff)), ["s", "u2", "a2"]);
  assert.deepEqual(tags(dropExpired(messages, cutoff + 1)), ["s"], "nothing recent left");
  assert.deepEqual(tags(dropExpired(messages, 0)), tags(messages), "nothing expired");
});

test("strict (ephemeral) turns never touch the conversations table, and /stop can still abort them", { timeout: 5000 }, async () => {
  const { db, statements } = recordingDb();
  const fake = gatedGrok();
  const sessions = new ChatSessions({ db, grok: fake.grok as never, systemPrompt: () => "" });
  const before = statements.length;

  const done = sessions.run("tg:-1:q7", { text: "strict secret" }, {}, { ephemeral: true });
  await fake.requested(1);
  fake.requests[0]!.release();
  const reply = await done;
  assert.equal(reply.stopReason, "stop");
  assert.deepEqual(statements.slice(before).filter((sql) => /\bchats\b/.test(sql)), [], "no read, write or delete of stored conversations");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number }).n, 0);

  const stopped = sessions.run("tg:-1:q8", { text: "stop me" }, {}, { ephemeral: true });
  await fake.requested(2);
  assert.equal(sessions.abortChat(-1), 1, "the running strict answer is found by /stop");
  assert.equal((await stopped).stopReason, "aborted");
  assert.equal(sessions.abort("tg:-1:q8"), false, "the throwaway agent is gone afterwards");
});

test("/forget cancels questions queued behind a running answer, so they can't recreate the history", { timeout: 5000 }, async () => {
  const db = openDbAt(":memory:");
  const fake = gatedGrok();
  const sessions = new ChatSessions({ db, grok: fake.grok as never, systemPrompt: () => "" });
  const rows = () => (db.prepare("SELECT messages FROM chats").all() as { messages: string }[]).map((r) => r.messages);

  const running = sessions.run("tg:-1", { text: "first secret" }).catch((error: unknown) => error);
  await fake.requested(1);
  let queuedStarted = false;
  const queued = sessions.run("tg:-1", { text: "queued secret" }, { onStart: () => (queuedStarted = true) }).catch((error: unknown) => error);
  sessions.forgetChat(-1);
  fake.requests[0]!.release();
  await running;
  assert.ok((await queued) instanceof TurnCancelledError);
  assert.equal(queuedStarted, false);
  assert.equal(fake.requests.length, 1, "the queued question never reached the provider");
  assert.deepEqual(rows(), []);
  assert.equal(sessions.pendingChats, 0);

  // A question asked after /forget runs normally, with none of the forgotten text.
  const after = sessions.run("tg:-1", { text: "fresh start" });
  await fake.requested(2);
  fake.requests[1]!.release();
  await after;
  assert.doesNotMatch(fake.requests[1]!.texts, /secret/);
  assert.equal(rows().length, 1);
  assert.doesNotMatch(rows()[0]!, /secret/);
  assert.match(rows()[0]!, /fresh start/);
});

test("retention: turns older than 7 days are neither sent nor kept, even in a chat that stays active", { timeout: 5000 }, async () => {
  const db = openDbAt(":memory:");
  const now = Date.now();
  const user = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });
  const assistant = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: "stop", timestamp });
  const history = [user("eight days old", now - 8 * DAY), assistant("old answer", now - 8 * DAY), user("two days old", now - 2 * DAY), assistant("recent answer", now - 2 * DAY)];
  const insert = db.prepare("INSERT INTO chats (chat_key, messages, updated_at) VALUES (?, ?, ?)");
  insert.run("tg:-1", JSON.stringify(history), now - DAY); // active yesterday
  insert.run("tg:-2", JSON.stringify(history), now - DAY);
  insert.run("tg:-3", JSON.stringify(history.slice(2)), now - 8 * DAY); // idle for 8 days
  const fake = gatedGrok();
  const sessions = new ChatSessions({ db, grok: fake.grok as never, systemPrompt: () => "" });
  const stored = (key: string) => (db.prepare("SELECT messages FROM chats WHERE chat_key = ?").get(key) as { messages: string } | undefined)?.messages;

  const turn = sessions.run("tg:-1", { text: "today" });
  await fake.requested(1);
  fake.requests[0]!.release();
  await turn;
  assert.doesNotMatch(fake.requests[0]!.texts, /eight days old|old answer/);
  assert.match(fake.requests[0]!.texts, /two days old/);
  assert.doesNotMatch(stored("tg:-1")!, /eight days old/);

  // Housekeeping trims chats nobody wrote in since, and deletes idle ones.
  assert.equal(sessions.prune(now), 1);
  assert.doesNotMatch(stored("tg:-2")!, /eight days old|old answer/);
  assert.match(stored("tg:-2")!, /two days old/);
  assert.equal(stored("tg:-3"), undefined);
  assert.equal(CONVERSATION_RETENTION_MS, 7 * DAY);
});

import { FINISH_NOW, isBarePromise } from "../src/agent/sessions.ts";

test("a reply that only promises a lookup is not an answer; reporting a result is", () => {
  for (const text of ["地点在河南，我按这个再查。", "画面很像陈一发，我核对一下。", "我查一下", "讓我確認一下！", "Let me check.", "I'll look that up…", "One moment."]) {
    assert.equal(isBarePromise(text), true, text);
  }
  for (const text of ["查不到。", "我查過了，是翊聯電子。", "好的，我記住了。", "可以看看官網。", "Checked: it's in Zhengzhou.", "Let me know if you need more.", `我查一下${"。".repeat(0)}，結果：${"x".repeat(60)}`]) {
    assert.equal(isBarePromise(text), false, text);
  }
});

test("when the model only promises to check, the turn continues once and the answer replaces the promise", { timeout: 5000 }, async () => {
  const db = openDbAt(":memory:");
  const replies = ["我核对一下。", "查到了：翊联电子，在郑州。"];
  const requests: string[] = [];
  const shown: string[] = [];
  const grok = {
    model: () => model,
    streamFn: (_model: unknown, context: { messages: { role: string; content: unknown }[] }) => {
      requests.push(JSON.stringify(context.messages.filter((m) => m.role === "user").map((m) => m.content)));
      const text = replies[requests.length - 1] ?? "unexpected third request";
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: "stop", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  };
  const sessions = new ChatSessions({ db, grok: grok as never, systemPrompt: () => "" });
  const reply = await sessions.run("tg:-1", { text: "这是什么企业", images: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }] }, { onText: (t) => shown.push(t) });
  assert.equal((reply.content[0] as { text: string }).text, "查到了：翊联电子，在郑州。");
  assert.equal(requests.length, 2, "continued exactly once");
  assert.ok(requests[1]!.includes("You said you would check"));
  assert.equal(shown.at(-1), "查到了：翊联电子，在郑州。", "the message ends with the answer, not the promise");
  const stored = JSON.parse((db.prepare("SELECT messages FROM chats").get() as { messages: string }).messages) as { role: string; content: unknown }[];
  assert.deepEqual(stored.map((m) => m.role), ["user", "assistant"], "stored as question → answer");
  assert.match(JSON.stringify(stored[0]!.content), /"type":"image"/, "the question's photo is still there for a follow-up");
  assert.doesNotMatch(JSON.stringify(stored), /核对一下|automatic note/);
  assert.ok(FINISH_NOW.startsWith("(automatic note)"));

  // A real short answer is not continued.
  replies.splice(0, 2, "查不到。");
  requests.length = 0;
  await sessions.run("tg:-2", { text: "这是什么企业" });
  assert.equal(requests.length, 1);
});
