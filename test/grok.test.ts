import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuota, withHostedSearch } from "../src/grok/grok.ts";
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
  assert.equal(friendlyError("socket hang up", "api"), "Grok error: socket hang up");
  // Group members never see raw provider errors or owner-only fixes.
  assert.equal(friendlyError("socket hang up at https://internal.example/v1", "api", false), "Something went wrong with the AI service. Please try again in a moment.");
  assert.doesNotMatch(friendlyError("401 unauthorized", "api", false), /\/login/);
});
