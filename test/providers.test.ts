import assert from "node:assert/strict";
import { test } from "node:test";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { openDbAt } from "../src/db.ts";
import { SqliteCredentialStore } from "../src/grok/credentialStore.ts";
import { chooseLoginMethod, Grok, pipeWithFailover, type LoginUi } from "../src/grok/grok.ts";
import { installAdmin } from "../src/telegram/admin.ts";
import { GroupStore } from "../src/telegram/groups.ts";
import { LimitStore, UsageStore } from "../src/usage.ts";
import { CookieStore } from "../src/links/cookies.ts";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (text: string, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  api: "openai-responses",
  provider: "x",
  model: "m",
  usage,
  stopReason,
  errorMessage,
  timestamp: Date.now(),
});

/** A provider stream: "start", then either an answer or an error after `textBeforeError`. */
function fake(script: { answer?: string; error?: string; textBeforeError?: string }) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial = message("");
    stream.push({ type: "start", partial });
    if (script.textBeforeError) stream.push({ type: "text_delta", contentIndex: 0, delta: script.textBeforeError, partial });
    if (script.error) {
      stream.push({ type: "error", reason: "error", error: message(script.textBeforeError ?? "", "error", script.error) });
    } else {
      stream.push({ type: "text_delta", contentIndex: 0, delta: script.answer!, partial });
      stream.push({ type: "done", reason: "stop", message: message(script.answer!) });
    }
    stream.end();
  });
  return stream;
}

async function run(scripts: Record<string, Parameters<typeof fake>[0]>, signal?: AbortSignal) {
  const out = createAssistantMessageEventStream();
  const failovers: string[] = [];
  const opened: string[] = [];
  let answeredBy: string | undefined;
  const done = pipeWithFailover(out, Object.keys(scripts), (name) => (opened.push(name), fake(scripts[name]!)), {
    signal,
    onFailover: (from, to, error) => failovers.push(`${from}→${to}: ${error}`),
    onAnswer: (name) => (answeredBy = name),
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of out) events.push(event);
  await done;
  const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta).join("");
  return { events, text, failovers, opened, answeredBy, final: await out.result() };
}

test("quota error before any output: the next provider answers and the user sees only its answer", async () => {
  const r = await run({ grok: { error: "HTTP 429: weekly limit reached" }, chatgpt: { answer: "來自 ChatGPT 的回答" } });
  assert.equal(r.text, "來自 ChatGPT 的回答");
  assert.deepEqual(r.failovers, ["grok→chatgpt: HTTP 429: weekly limit reached"]);
  assert.equal(r.answeredBy, "chatgpt");
  assert.equal(r.final.stopReason, "stop");
  assert.equal(r.events.filter((e) => e.type === "start").length, 1, "the failed provider's start is never forwarded");
});

test("an error after text was streamed stays with that provider (no duplicate half-answers)", async () => {
  const r = await run({ grok: { textBeforeError: "部分回答", error: "connection reset" }, chatgpt: { answer: "x" } });
  assert.deepEqual(r.opened, ["grok"]);
  assert.equal(r.text, "部分回答");
  assert.equal(r.final.stopReason, "error");
  assert.deepEqual(r.failovers, []);
});

test("the last provider's error is passed through; a stopped request is not retried elsewhere", async () => {
  const last = await run({ grok: { error: "429" }, chatgpt: { error: "401 login expired" } });
  assert.equal(last.final.errorMessage, "401 login expired");
  assert.equal(last.failovers.length, 1);

  const abort = new AbortController();
  abort.abort();
  const stopped = await run({ grok: { error: "aborted by user" }, chatgpt: { answer: "x" } }, abort.signal);
  assert.deepEqual(stopped.opened, ["grok"]);
});

test("the provider chain keeps valid, unique entries and never becomes empty", () => {
  const db = openDbAt(":memory:");
  const grok = new Grok({ db, credentials: new SqliteCredentialStore(db), defaultModel: "grok-4.7" });
  assert.deepEqual(grok.chain, ["xai"]);
  grok.chain = ["openai", "xai", "openai"];
  assert.deepEqual(grok.chain, ["openai", "xai"]);
  assert.throws(() => (grok.chain = []), /at least one/);
  assert.equal(grok.providerModelId("openai"), "gpt-6-luna");
  assert.ok(grok.listProviderModels("openai").includes("gpt-6-luna"));
  assert.throws(() => grok.setProviderModel("openai", "gpt-nope"), /Unknown model/);
});

const OWNER = 1000001;

function panel() {
  const db = openDbAt(":memory:");
  const groups = new GroupStore(db);
  groups.enable(-100, "Official");
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let chain: string[] = ["xai"];
  const signedIn = new Set(["xai"]);
  let loginUi: LoginUi | undefined;
  const logins: string[] = [];
  let pasted: Promise<string> | undefined;
  const grok = {
    get chain() {
      return chain;
    },
    set chain(value: string[]) {
      chain = value;
    },
    signedIn: async (p: string) => signedIn.has(p),
    authKind: async (p: string) => (signedIn.has(p) ? "oauth" : undefined),
    providerModelId: (p: string) => (p === "xai" ? "grok-4.7" : "gpt-6-luna"),
    listProviderModels: () => ["gpt-6-luna", "gpt-6-sol"],
    setProviderModel: () => undefined,
    stats: new Map(),
    hostedSearch: true,
    route: "api",
    logout: async (p: string) => void signedIn.delete(p),
    testProvider: async () => "gpt-6-luna: OK",
    loginProvider: async (p: string, ui: LoginUi, _signal: AbortSignal, kind = "oauth") => {
      loginUi = ui;
      logins.push(`${p}:${kind}`);
      if (kind === "api_key") {
        pasted = ui.onSecret!("key");
      } else {
        await ui.onUrl!("https://auth.example/authorize?x=1");
        pasted = ui.onPaste!("paste it");
      }
      await pasted;
      signedIn.add(p);
    },
  };
  const strict: number[] = [];
  const bot = new Bot("1:test", { botInfo: { id: 9, is_bot: true, first_name: "Grokky", username: "GrokTest_bot" } as never });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === "sendMessage" ? { message_id: calls.length, date: 0, chat: { id: OWNER, type: "private" } } : true;
    return { ok: true, result } as never;
  });
  const usage = new UsageStore(db);
  const limits = new LimitStore(db);
  const opsRequests: string[] = [];
  const ops = {
    run: async (action: string) => (opsRequests.push(action), { action, ok: true, output: "grokbot: active", finishedAt: 1 }),
    request: async (action: string) => (opsRequests.push(action), "id"),
  };
  const backupFile = join(mkdtempSync(join(tmpdir(), "bk-")), "backup.db");
  const cookies = new CookieStore(join(mkdtempSync(join(tmpdir(), "ck-")), "cookies.json"));
  installAdmin(bot, {
    ownerId: OWNER,
    grok: grok as never,
    groups,
    onStrict: (id) => strict.push(id),
    usage,
    limits,
    ops: ops as never,
    backup: () => (writeFileSync(backupFile, "db"), backupFile),
    cookies,
  });
  let id = 0;
  const privateText = (from: number, text: string): Update => ({
    update_id: ++id,
    message: {
      message_id: 500 + id,
      date: 0,
      chat: { id: from, type: "private", first_name: "x" },
      from: { id: from, is_bot: false, first_name: "x" },
      text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.length }] } : {}),
    },
  });
  const press = (from: number, data: string): Update => ({
    update_id: ++id,
    callback_query: {
      id: String(id),
      from: { id: from, is_bot: false, first_name: "x" },
      chat_instance: "c",
      data,
      message: { message_id: 1, date: 0, chat: { id: from, type: "private", first_name: "x" } },
    } as never,
  });
  return { bot, calls, groups, strict, grok, privateText, press, chain: () => chain, signedIn, logins, usage, limits, opsRequests, backupFile, cookies, pending: () => pasted, ui: () => loginUi };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("/admin opens the panel for the owner only", async () => {
  const p = panel();
  await p.bot.handleUpdate(p.privateText(5, "/admin"));
  await p.bot.handleUpdate(p.privateText(OWNER, "/admin"));
  const sent = p.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sent[0]!.payload.text, "Only the bot owner can do that.");
  assert.match(String(sent[1]!.payload.text), /Bot admin[\s\S]*Grok \(SuperGrok\)/);
  assert.ok(JSON.stringify(sent[1]!.payload.reply_markup).includes("adm:prov"));
});

test("buttons: add ChatGPT to the chain and put it first; members' button presses are refused", async () => {
  const p = panel();
  await p.bot.handleUpdate(p.press(5, "adm:tog:openai"));
  assert.deepEqual(p.chain(), ["xai"]);
  await p.bot.handleUpdate(p.press(OWNER, "adm:tog:openai"));
  await p.bot.handleUpdate(p.press(OWNER, "adm:up:openai"));
  assert.deepEqual(p.chain(), ["openai", "xai"]);
});

test("ChatGPT sign-in: the pasted callback address completes it, is deleted from the chat, and ChatGPT joins the chain", async () => {
  const p = panel();
  await p.bot.handleUpdate(p.press(OWNER, "adm:in:openai"));
  await settle();
  assert.ok(p.calls.some((c) => c.method === "sendMessage" && String(c.payload.text).includes("127.0.0.1")));
  await p.bot.handleUpdate(p.privateText(OWNER, "hello?")); // not an address: left for the normal chat
  assert.equal(p.calls.filter((c) => c.method === "deleteMessage").length, 0);
  await p.bot.handleUpdate(p.privateText(OWNER, "http://127.0.0.1:1455/auth/callback?code=abc&state=s"));
  assert.equal(await p.pending(), "http://127.0.0.1:1455/auth/callback?code=abc&state=s");
  await settle();
  assert.equal(p.calls.filter((c) => c.method === "deleteMessage").length, 1);
  assert.ok(p.signedIn.has("openai"));
  assert.deepEqual(p.chain(), ["xai", "openai"]);
  assert.match(String(p.calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.text), /ChatGPT \(Plus\/Pro\) signed in/);
});

test("group settings from the panel; switching to strict wipes what normal mode stored", async () => {
  const p = panel();
  p.groups.setPrivacy(-100, "normal");
  await p.bot.handleUpdate(p.press(OWNER, "adm:gs:-100:links"));
  await p.bot.handleUpdate(p.press(OWNER, "adm:gs:-100:privacy"));
  await p.bot.handleUpdate(p.press(OWNER, "adm:gs:-100:tidy"));
  assert.equal(p.groups.linkMode(-100), "mention");
  assert.equal(p.groups.privacy(-100), "strict");
  assert.equal(p.groups.tidy(-100), false);
  assert.deepEqual(p.strict, [-100]);
});

test("Claude's login choice: the bot takes the copy-code way (it can't receive a browser redirect)", () => {
  const options = [
    { id: "browser", label: "Browser login (default)" },
    { id: "copy-code", label: "Copy code login (headless)" },
  ];
  assert.equal(chooseLoginMethod(options), "copy-code");
  assert.throws(() => chooseLoginMethod([{ id: "browser", label: "Browser login" }]), /no method the bot can use/);
});

test("an API key counts as signed in and puts Claude in the answer order", async () => {
  const db = openDbAt(":memory:");
  const credentials = new SqliteCredentialStore(db);
  const grok = new Grok({ db, credentials, defaultModel: "grok-4.7" });
  grok.chain = ["xai", "anthropic"];
  assert.deepEqual(await grok.targets(), []);
  await credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-test" }));
  assert.equal(await grok.authKind("anthropic"), "api_key");
  assert.deepEqual((await grok.targets()).map((t) => `${t.provider}/${t.model.id}`), ["anthropic/claude-haiku-5-5"]);
  assert.ok(grok.listProviderModels("anthropic").every((id) => /^claude-(haiku-5|sonnet-5|opus-5|fable)/.test(id)));
});

test("Claude API key from the panel: only a key-shaped message is taken, and it is deleted", async () => {
  const p = panel();
  await p.bot.handleUpdate(p.press(OWNER, "adm:key:anthropic"));
  await settle();
  assert.match(String(p.calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.text), /sk-ant-/);
  await p.bot.handleUpdate(p.privateText(OWNER, "what's the weather?"));
  assert.equal(p.calls.filter((c) => c.method === "deleteMessage").length, 0);
  await p.bot.handleUpdate(p.privateText(OWNER, "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"));
  assert.equal(await p.pending(), "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
  await settle();
  assert.deepEqual(p.logins, ["anthropic:api_key"]);
  assert.equal(p.calls.filter((c) => c.method === "deleteMessage").length, 1);
  assert.deepEqual(p.chain(), ["xai", "anthropic"]);
});

test("Claude subscription sign-in: the code Claude shows (code#state) is taken", async () => {
  const p = panel();
  await p.bot.handleUpdate(p.press(OWNER, "adm:in:anthropic"));
  await settle();
  assert.match(String(p.calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.text), /Claude shows a code/);
  await p.bot.handleUpdate(p.privateText(OWNER, "Xy12AbCdEfGh34#st4te-value"));
  assert.equal(await p.pending(), "Xy12AbCdEfGh34#st4te-value");
});

const lastText = (p: ReturnType<typeof panel>, method = "editMessageText") => String(p.calls.filter((c) => c.method === method).at(-1)?.payload.text ?? "");

test("panel: usage per member and provider; limits change with buttons; members can be made trusted", async () => {
  const p = panel();
  p.usage.record(-100, { id: 5, name: "Amy" }, "question", 3);
  p.usage.record(-100, { id: 5, name: "Amy" }, "image", 2);
  p.usage.recordTokens("xai", 12_000, 3_000);
  await p.bot.handleUpdate(p.press(OWNER, "adm:use:7"));
  assert.match(lastText(p), /Amy<\/b>: ❓3 · 🖼2/);
  assert.match(lastText(p), /Grok: 1 · 12k \/ 3k/);
  await p.bot.handleUpdate(p.press(OWNER, "adm:ln:questionsPerUserHour:+"));
  await p.bot.handleUpdate(p.press(OWNER, "adm:ln:imagesPerUserDay:-"));
  assert.equal(p.limits.get("questionsPerUserHour"), 25);
  assert.equal(p.limits.get("imagesPerUserDay"), 8);
  assert.ok(lastText(p).includes("Questions per member / hour: <b>25</b>"));
  await p.bot.handleUpdate(p.press(OWNER, "adm:tr:5"));
  assert.ok(p.limits.trusted().has(5));
});

test("panel: persona is asked for, saved for that group, and /cancel keeps it", async () => {
  const p = panel();
  await p.bot.handleUpdate(p.press(OWNER, "adm:gp:-100"));
  await settle();
  await p.bot.handleUpdate(p.privateText(OWNER, "輕鬆幽默，用繁體中文，回答短一點"));
  await settle();
  assert.equal(p.groups.persona(-100), "輕鬆幽默，用繁體中文，回答短一點");
  await p.bot.handleUpdate(p.press(OWNER, "adm:gp:-100"));
  await settle();
  await p.bot.handleUpdate(p.privateText(OWNER, "/cancel"));
  await settle();
  assert.equal(p.groups.persona(-100), "輕鬆幽默，用繁體中文，回答短一點");
  await p.bot.handleUpdate(p.press(OWNER, "adm:gpc:-100"));
  assert.equal(p.groups.persona(-100), "");
});

test("panel maintenance: actions go to the ops runner, restart asks first, backup is sent and deleted", async () => {
  const p = panel();
  await p.bot.handleUpdate(p.press(OWNER, "adm:op:status"));
  await settle();
  assert.deepEqual(p.opsRequests, ["status"]);
  assert.match(lastText(p, "sendMessage"), /Service status[\s\S]*grokbot: active/);
  await p.bot.handleUpdate(p.press(OWNER, "adm:op:restart-bot"));
  assert.deepEqual(p.opsRequests, ["status"], "restart needs a confirmation");
  await p.bot.handleUpdate(p.press(OWNER, "adm:opy:restart-bot"));
  await settle();
  assert.deepEqual(p.opsRequests, ["status", "restart-bot"]);
  await p.bot.handleUpdate(p.press(OWNER, "adm:bak"));
  await settle();
  assert.ok(p.calls.some((c) => c.method === "sendDocument"));
  assert.equal(existsSync(p.backupFile), false, "the backup file is removed after sending");
});

test("panel: a pasted site cookie is saved and its message deleted; the screen shows only whether one is set", async () => {
  const p = panel();
  await p.bot.handleUpdate(p.press(OWNER, "adm:cks:zhihu"));
  await settle();
  await p.bot.handleUpdate(p.privateText(OWNER, "z_c0=secretvalue; d_c0=other"));
  await settle();
  assert.equal(p.cookies.has("zhihu"), true);
  assert.equal(p.calls.filter((c) => c.method === "deleteMessage").length, 1, "the cookie message is removed from the chat");
  await p.bot.handleUpdate(p.press(OWNER, "adm:ck"));
  assert.match(lastText(p), /✅ 知乎 Zhihu/);
  assert.doesNotMatch(JSON.stringify(p.calls), /secretvalue/, "the value never appears in anything the bot sends");
});

test("panel: 📖 Guide has contents and pages with previous/next navigation", async () => {
  const p = panel();
  await p.bot.handleUpdate(p.press(OWNER, "adm:guide"));
  assert.match(JSON.stringify(p.calls.at(-1)?.payload.reply_markup), /adm:gd:talk[\s\S]*adm:gd:tasks/);
  await p.bot.handleUpdate(p.press(OWNER, "adm:gd:group"));
  assert.match(lastText(p), /Owner commands in a group/);
  const buttons = JSON.stringify(p.calls.at(-1)?.payload.reply_markup);
  assert.match(buttons, /adm:gd:everyone/, "previous page");
  assert.match(buttons, /adm:gd:private/, "next page");
});

test("👥 group screen: ✋ toggles confirmations; 🕒 takes a typed zone or city and refuses unknown ones", async () => {
  const p = panel();
  p.groups.enable(-100, "Friends");
  await p.bot.handleUpdate(p.press(OWNER, "adm:gs:-100:confirm"));
  assert.equal(p.groups.confirmActions(-100), false);
  const screen = p.calls.filter((c) => c.method === "editMessageText").at(-1)!;
  const rows = (screen.payload.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.map((row) => row.map((b) => b.text).join(" | "));
  assert.ok(rows.includes("🔊 Voice replies: on | ✋ Confirm notes/polls: off"), rows.join("\n"));
  assert.ok(rows.includes("🕒 Time zone: Taipei | 🔞 Adult links: hidden"), rows.join("\n"));
  await p.bot.handleUpdate(p.press(OWNER, "adm:gs:-100:adult"));
  assert.equal(p.groups.hideAdult(-100), false);

  await p.bot.handleUpdate(p.press(OWNER, "adm:gtz:-100"));
  await settle();
  await p.bot.handleUpdate(p.privateText(OWNER, "Atlantis"));
  await settle();
  assert.equal(p.groups.timeZone(-100), "Asia/Taipei");
  await p.bot.handleUpdate(p.press(OWNER, "adm:gtz:-100"));
  await settle();
  await p.bot.handleUpdate(p.privateText(OWNER, "new york"));
  await settle();
  assert.equal(p.groups.timeZone(-100), "America/New_York");
  assert.match(String(p.calls.filter((c) => c.method === "sendMessage").at(-1)!.payload.text), /Friends: America\/New_York, now 20\d\d-/);
});
