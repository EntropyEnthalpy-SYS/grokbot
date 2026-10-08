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
