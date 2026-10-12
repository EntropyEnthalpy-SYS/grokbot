import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../src/redact.ts";

test("keys, tokens, passwords, server logins, emails, phone numbers and card numbers are hidden", () => {
  const cases: [string, string][] = [
    ["token 1234567890:AAExampleExampleExampleExample0000 ok", "token [hidden] ok"],
    ["key sk-proj-abcdefghijklmnopqrstuvwx", "key [hidden]"],
    ["tavily tvly-dev-0exampleExampleExample0000", "tavily [hidden]"],
    ["gh ghp_abcdefghijklmnopqrstuvwxyz0123", "gh [hidden]"],
    ["password: hunter2!", "password: [hidden]"],
    ["the password is hunter2", "the password is [hidden]"],
    ["密码是abc123，记住", "密码是[hidden]"],
    ["203.0.113.7 22 root Ex4mplePassw0rd", "203.0.113.7 22 root [hidden]"],
    ["mail me at bob.lee@example.com.", "mail me at [hidden]."],
    ["call +86 138 1234 5678 or 13812345678 or 0912-345-678", "call [hidden] or [hidden] or [hidden]"],
    ["card 4111 1111 1111 1111 exp 12/28", "card [hidden] exp 12/28"],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test("ordinary text, prices, dates, ids and links are left alone", () => {
  for (const text of [
    "pass the salt, I forgot my password again",
    "Switch 2 卖 14,021 元，2026-10-12 到货",
    "订单号 1234567890123456 不是卡号",
    "https://x.com/a/status/1234567890123456789 和 https://e.com/u?email=a@b.co",
    "GPT-6.1 Sol 的上下文 500k",
  ])
    assert.equal(redactSecrets(text), text, text);
});
