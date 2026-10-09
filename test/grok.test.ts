import assert from "node:assert/strict";
import { test } from "node:test";
import { Grok, parseQuota, withHostedSearch } from "../src/grok/grok.ts";
import { formatLocalIso, friendlyError } from "../src/telegram/bot.ts";

test("shows the quota reset in Taipei time", () => {
  assert.equal(formatLocalIso("2026-10-14T16:51:36.560820+00:00"), "Thu, Oct 15, 00:51 (Taipei)");
  assert.equal(formatLocalIso("soon"), "soon");
});

test("adds web_search and x_search once, keeping existing tools and fields", () => {
  const payload = { model: "grok-4.7", tools: [{ type: "function", name: "read_link" }, { type: "x_search" }] };
  assert.deepEqual(withHostedSearch(payload), {
    model: "grok-4.7",
    tools: [{ type: "function", name: "read_link" }, { type: "x_search" }, { type: "web_search" }],
  });
  assert.deepEqual(withHostedSearch({ model: "m" }), { model: "m", tools: [{ type: "web_search" }, { type: "x_search" }] });
});

test("reads quota fields wherever the billing response nests them", () => {
  const quota = parseQuota({
    subscription_tier: "SUPERGROK",
    config: {
      used: { val: "25" },
      monthlyLimit: { val: 200 },
      currentPeriod: { type: "BILLING_PERIOD_TYPE_WEEKLY", end: "2026-10-12T00:00:00Z" },
    },
  });
  assert.deepEqual(quota, { plan: "SUPERGROK", usedPercent: 12.5, window: "weekly", resetsAt: "2026-10-12T00:00:00Z" });
  assert.equal(parseQuota({ config: { creditUsagePercent: 40, used: { val: 1 }, monthlyLimit: { val: 2 } } }).usedPercent, 40);
});

test("maps Grok failures to actionable messages", () => {
  assert.match(friendlyError("403 The caller does not have permission", "api"), /\/route auto/);
  assert.match(friendlyError("xAI OAuth token refresh failed (HTTP 400): invalid_grant", "api"), /\/login again/);
  assert.match(friendlyError("429 Too Many Requests", "proxy"), /usage limit/);
  assert.match(friendlyError("Connection error.", "api"), /^Couldn't reach the AI service \(Connection error\.\), even after retrying/);
  assert.match(friendlyError("socket hang up", "api"), /Couldn't reach the AI service/);
  assert.equal(friendlyError("Connection error.", "api", false), "Couldn't reach the AI service just now. Please ask again in a moment.");
  assert.equal(friendlyError("model overloaded", "api"), "Grok error: model overloaded");
  // Group members never see raw provider errors or owner-only fixes.
  assert.equal(friendlyError("invalid schema at https://internal.example/v1", "api", false), "Something went wrong with the AI service. Please try again in a moment.");
  assert.doesNotMatch(friendlyError("401 unauthorized", "api", false), /\/login/);
});

import { createServer, type Server } from "node:http";
import { openDbAt } from "../src/db.ts";
import { SqliteCredentialStore } from "../src/grok/credentialStore.ts";

test("a request whose connection drops before any answer is retried, and the answer still arrives", { timeout: 15_000 }, async () => {
  // xAI's Responses API stand-in: the first connection is cut before any reply, the next one answers.
  let connections = 0;
  const server: Server = createServer((req, res) => {
    connections++;
    req.resume();
    if (connections === 1) return void req.socket.destroy();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "就是大疆的收纳包。", annotations: [] }] };
      send({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } });
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      send({ type: "response.content_part.added", output_index: 0, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "" } });
      send({ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "就是大疆的收纳包。" });
      send({ type: "response.output_item.done", output_index: 0, item });
      send({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const db = openDbAt(":memory:");
    const credentials = new SqliteCredentialStore(db);
    await credentials.modify("xai", async () => ({ type: "api_key", key: "xai-test" }));
    const grok = new Grok({ db, credentials, defaultModel: "grok-4.7" });
    const port = (server.address() as { port: number }).port;
    const model = { ...grok.model(), baseUrl: `http://127.0.0.1:${port}/v1` };
    (grok as unknown as { targets: () => Promise<unknown[]> }).targets = async () => [{ provider: "xai", model }];
    assert.equal(await grok.ask("system", "这是什么"), "就是大疆的收纳包。");
    assert.equal(connections, 2, "one dropped connection, one retry");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
