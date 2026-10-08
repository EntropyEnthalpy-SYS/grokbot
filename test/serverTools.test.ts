import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { cleanHistory } from "../src/agent/sessions.ts";
import { withoutServerSideToolCalls } from "../src/grok/grok.ts";

const model = xaiProvider().getModels()[0]!;
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Shape recorded on the VPS: xAI's x_search step arrives as a custom tool call
// (id "<call_id>|ctc_…") in the same response as the final answer text.
const searchCall = {
  type: "toolCall" as const,
  id: "xs_call-0749-3|ctc_5a79_call-0749-3",
  name: "x_keyword_search",
  arguments: { input: '{"query":"xAI"}' },
};

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
}

function fakeStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: message.stopReason as "toolUse", message });
  });
  return stream;
}

// Without the filter the agent re-asks forever (the fake always answers with the call), hence the timeout.
test("the agent keeps Grok's searched answer instead of running the hosted search tool locally", { timeout: 5000 }, async () => {
  let requests = 0;
  const agent = new Agent({
    initialState: { model, tools: [] },
    streamFn: () => {
      requests++;
      return withoutServerSideToolCalls(
        fakeStream(reply([searchCall, { type: "text", text: "xAI released Grok 4.7 [source](https://x.ai)" }], "toolUse")),
      );
    },
  });
  await agent.prompt("what's the latest news about xAI?");
  const roles = agent.state.messages.map((m) => m.role).filter((role) => role !== "system");
  assert.equal(requests, 1, "no second request after a failed local tool run");
  assert.deepEqual(roles, ["user", "assistant"]);
  const last = agent.state.messages.at(-1) as AssistantMessage;
  assert.equal(last.stopReason, "stop");
  assert.deepEqual(last.content, [{ type: "text", text: "xAI released Grok 4.7 [source](https://x.ai)" }]);
});

test("our own function tool calls are still executed", async () => {
  const ownCall = { type: "toolCall" as const, id: "call_1|fc_1", name: "read_link", arguments: { url: "https://e.com" } };
  const message = reply([searchCall, ownCall], "toolUse");
  const stream = withoutServerSideToolCalls(fakeStream(message));
  const result = await stream.result();
  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.content, [ownCall]);
});

test("cleanHistory drops stored server-side calls and their 'not found' results", () => {
  const history = [
    { role: "user", content: "news?", timestamp: 1 },
    reply([searchCall, { type: "text", text: "answer" }], "toolUse"),
    {
      role: "toolResult",
      toolCallId: searchCall.id,
      toolName: "x_keyword_search",
      content: [{ type: "text", text: "Tool x_keyword_search not found" }],
      isError: true,
      timestamp: 2,
    },
    reply([{ type: "text", text: "That looks like a tool error" }], "stop"),
  ] as AgentMessage[];
  const cleaned = cleanHistory(history);
  assert.deepEqual(cleaned.map((m) => m.role), ["user", "assistant", "assistant"]);
  assert.deepEqual((cleaned[1] as AssistantMessage).content, [{ type: "text", text: "answer" }]);
  assert.equal((cleaned[1] as AssistantMessage).stopReason, "stop");
});
