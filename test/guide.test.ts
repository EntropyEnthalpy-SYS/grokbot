import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS } from "../src/telegram/bot.ts";
import { GUIDE, MEMBER_HELP, OWNER_HELP } from "../src/telegram/guide.ts";

const ALLOWED_TAGS = new Set(["b", "i", "code", "s", "u", "a", "pre"]);

test("every guide page is valid Telegram HTML and fits in one message", () => {
  for (const page of [...GUIDE, { id: "member-help", html: MEMBER_HELP }, { id: "owner-help", html: OWNER_HELP }]) {
    assert.ok(page.html.length < 4096, `${page.id} is ${page.html.length} characters`);
    const stack: string[] = [];
    for (const [, close, name] of page.html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
      assert.ok(ALLOWED_TAGS.has(name!), `${page.id}: <${name}> is not a Telegram tag`);
      if (!close) stack.push(name!);
      else assert.equal(stack.pop(), name, `${page.id}: unbalanced </${name}>`);
    }
    assert.deepEqual(stack, [], `${page.id}: unclosed tags`);
    assert.doesNotMatch(page.html.replace(/<\/?[a-z]+[^>]*>/g, ""), /[<>]/, `${page.id}: a raw < or > would break Telegram's parser`);
  }
});

test("the guide documents every command in the bot's menu (a new command needs a guide line)", () => {
  const all = GUIDE.map((p) => p.html).join("\n");
  const missing = COMMANDS.map((c) => c.command).filter((c) => !new RegExp(`/${c}\\b`).test(all));
  assert.deepEqual(missing, []);
});
