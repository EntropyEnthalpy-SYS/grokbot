import assert from "node:assert/strict";
import { test } from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { openDbAt } from "../src/db.ts";
import { SqliteCredentialStore } from "../src/grok/credentialStore.ts";

const oauth = (refresh: string): Credential => ({ type: "oauth", access: `access-${refresh}`, refresh, expires: 1 });

test("concurrent refreshes run one at a time, each seeing the rotated token", async () => {
  const store = new SqliteCredentialStore(openDbAt(":memory:"));
  await store.modify("xai", async () => oauth("r0"));

  // Simulates xAI's single-use refresh tokens: refreshing with a stale token fails.
  let live = "r0";
  let counter = 0;
  const refresh = (current: Credential | undefined) =>
    new Promise<Credential>((resolve, reject) => {
      const used = current?.type === "oauth" ? current.refresh : "";
      setTimeout(() => {
        if (used !== live) return reject(new Error(`invalid_grant: ${used} already used`));
        live = `r${++counter}`;
        resolve(oauth(live));
      }, 5);
    });

  const results = await Promise.all([store.modify("xai", refresh), store.modify("xai", refresh), store.modify("xai", refresh)]);
  assert.deepEqual(
    results.map((c) => (c as { refresh: string }).refresh),
    ["r1", "r2", "r3"],
  );
  assert.equal(((await store.read("xai")) as { refresh: string }).refresh, "r3");
});

test("a failed modify keeps the old credential and does not block later writes", async () => {
  const store = new SqliteCredentialStore(openDbAt(":memory:"));
  await store.modify("xai", async () => oauth("good"));
  await assert.rejects(store.modify("xai", async () => {
    throw new Error("refresh failed");
  }));
  assert.equal(((await store.read("xai")) as { refresh: string }).refresh, "good");
  await store.modify("xai", async () => oauth("next"));
  assert.equal(((await store.read("xai")) as { refresh: string }).refresh, "next");
});

test("returning undefined leaves the credential unchanged; delete removes it", async () => {
  const store = new SqliteCredentialStore(openDbAt(":memory:"));
  await store.modify("xai", async () => oauth("keep"));
  const unchanged = await store.modify("xai", async () => undefined);
  assert.equal((unchanged as { refresh: string }).refresh, "keep");
  assert.deepEqual(await store.list(), [{ providerId: "xai", type: "oauth" }]);
  await store.delete("xai");
  assert.equal(await store.read("xai"), undefined);
});
