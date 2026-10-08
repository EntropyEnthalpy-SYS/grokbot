import assert from "node:assert/strict";
import { test } from "node:test";
import { isConnectError, withAuthRetry } from "../src/net/authRetry.ts";

// Shape of the real failure seen on the VPS: fetch failed <- AggregateError ETIMEDOUT.
const connectTimeout = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new AggregateError([{ code: "ETIMEDOUT" }, { code: "ENETUNREACH" }]), { code: "ETIMEDOUT" }),
  });
const resetAfterSend = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

function scripted(outcomes: Array<"ok" | Error>) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = outcomes.shift() ?? "ok";
    if (next instanceof Error) throw next;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { impl, urls };
}

const noSleep = { sleep: async () => undefined };

test("retries auth.x.ai after connect failures and returns the response", async () => {
  const { impl, urls } = scripted([connectTimeout(), connectTimeout(), "ok"]);
  const response = await withAuthRetry(impl, noSleep)("https://auth.x.ai/oauth2/token", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(urls.length, 3);
});

test("gives up after the attempt limit", async () => {
  const { impl, urls } = scripted([connectTimeout(), connectTimeout(), connectTimeout(), connectTimeout(), "ok"]);
  await assert.rejects(withAuthRetry(impl, { ...noSleep, attempts: 4 })("https://auth.x.ai/x"));
  assert.equal(urls.length, 4);
});

test("never resends after a reset, since the single-use refresh token may have been consumed", async () => {
  const { impl, urls } = scripted([resetAfterSend(), "ok"]);
  await assert.rejects(withAuthRetry(impl, noSleep)("https://auth.x.ai/oauth2/token", { method: "POST" }));
  assert.equal(urls.length, 1);
});

test("leaves other hosts alone", async () => {
  const { impl, urls } = scripted([connectTimeout(), "ok"]);
  await assert.rejects(withAuthRetry(impl, noSleep)("https://api.x.ai/v1/responses"));
  assert.equal(urls.length, 1);
});

test("classifies connect errors", () => {
  assert.equal(isConnectError(connectTimeout()), true);
  assert.equal(isConnectError(resetAfterSend()), false);
  assert.equal(isConnectError(new Error("plain")), false);
});
