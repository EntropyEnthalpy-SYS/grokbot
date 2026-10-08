import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ChatSessions } from "../src/agent/sessions.ts";
import { openDbAt } from "../src/db.ts";
import { GroupStore } from "../src/telegram/groups.ts";

test("newly enabled groups start strict; groups from before keep 'normal'; re-enabling keeps the choice", () => {
  const path = join(mkdtempSync(join(tmpdir(), "priv-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE groups (chat_id INTEGER PRIMARY KEY, title TEXT, link_mode TEXT NOT NULL DEFAULT 'auto', enabled_at INTEGER NOT NULL)");
  old.prepare("INSERT INTO groups (chat_id, title, enabled_at) VALUES (-1, 'test group', 1)").run();
  old.close();
  const groups = new GroupStore(openDbAt(path));
  assert.equal(groups.privacy(-1), "normal");
  groups.enable(-2, "official");
  assert.equal(groups.privacy(-2), "strict");
  groups.setPrivacy(-2, "normal");
  groups.enable(-2, "official renamed");
  assert.equal(groups.privacy(-2), "normal");
});

test("forget deletes only that group's log", () => {
  const groups = new GroupStore(openDbAt(":memory:"));
  for (const chat of [-1, -2]) groups.log(chat, 0, { messageId: 1, name: "A", text: "hi", isBot: false, at: Date.now() });
  assert.equal(groups.forget(-1), 1);
  assert.equal(groups.contextSinceLastReply(-1, 0, 0).length, 0);
  assert.equal(groups.contextSinceLastReply(-2, 0, 0).length, 1);
});

function sessionsWith(rows: Record<string, number>) {
  const db = openDbAt(":memory:");
  for (const [key, at] of Object.entries(rows)) db.prepare("INSERT INTO chats (chat_key, messages, updated_at) VALUES (?, '[]', ?)").run(key, at);
  const keys = () => (db.prepare("SELECT chat_key FROM chats ORDER BY chat_key").all() as { chat_key: string }[]).map((r) => r.chat_key);
  return { sessions: new ChatSessions({ db, grok: {} as never, systemPrompt: () => "" }), keys };
}

test("conversations unused for 7 days expire", () => {
  const now = 10 * 24 * 3600 * 1000;
  const { sessions, keys } = sessionsWith({ "tg:-1": now - 8 * 24 * 3600 * 1000, "tg:-2": now - 3600 * 1000 });
  assert.equal(sessions.prune(7 * 24 * 3600 * 1000, now), 1);
  assert.deepEqual(keys(), ["tg:-2"]);
});

test("forgetChat removes a group's conversations including forum topics, and nothing else", () => {
  const { sessions, keys } = sessionsWith({ "tg:-100": 1, "tg:-100:topic:7": 1, "tg:-1001": 1, "tg:5": 1 });
  assert.equal(sessions.forgetChat(-100), 2);
  assert.deepEqual(keys(), ["tg:-1001", "tg:5"]);
});
