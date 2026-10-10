import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToTelegramHtml, splitMarkdown } from "../src/telegram/format.ts";

test("escapes HTML so user text cannot inject tags", () => {
  assert.equal(markdownToTelegramHtml("a < b && c > d <script>"), "a &lt; b &amp;&amp; c &gt; d &lt;script&gt;");
});

test("formats bold, italic, strike, inline code and links", () => {
  assert.equal(
    markdownToTelegramHtml("**bold** *it* ~~old~~ `x<y` [site](https://e.com/a?b=1&c=2)"),
    '<b>bold</b> <i>it</i> <s>old</s> <code>x&lt;y</code> <a href="https://e.com/a?b=1&amp;c=2">site</a>',
  );
});

test("leaves snake_case and lone asterisks alone", () => {
  assert.equal(markdownToTelegramHtml("use snake_case_name and 2 * 3 * 4"), "use snake_case_name and 2 * 3 * 4");
});

test("does not format markup inside code", () => {
  assert.equal(markdownToTelegramHtml("`**not bold**`"), "<code>**not bold**</code>");
  assert.equal(
    markdownToTelegramHtml("```py\nx = a**2 < b\n```"),
    '<pre><code class="language-py">x = a**2 &lt; b</code></pre>',
  );
});

test("turns headings into bold and bullets into dots", () => {
  assert.equal(markdownToTelegramHtml("## Title\n- one\n* two"), "<b>Title</b>\n• one\n• two");
});

test("short text is one chunk; empty text is none", () => {
  assert.deepEqual(splitMarkdown("hello"), ["hello"]);
  assert.deepEqual(splitMarkdown("  \n "), []);
});

test("splits long text within the limit without losing words", () => {
  const words = Array.from({ length: 900 }, (_, i) => `w${i}`);
  const text = words.join(" ");
  const chunks = splitMarkdown(text, 500);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 500, `chunk too long: ${chunk.length}`);
  assert.deepEqual(chunks.join(" ").split(/\s+/), words);
});

test("prefers paragraph boundaries", () => {
  const a = "a".repeat(300);
  const b = "b".repeat(300);
  assert.deepEqual(splitMarkdown(`${a}\n\n${b}`, 400), [a, b]);
});

test("a code block cut across chunks is closed and reopened with its language", () => {
  const code = Array.from({ length: 80 }, (_, i) => `line_${i} = ${i}`).join("\n");
  const chunks = splitMarkdown(`Intro\n\n\`\`\`python\n${code}\n\`\`\`\n\nDone`, 400);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 400);
    const fences = chunk.split("\n").filter((line) => line.trimStart().startsWith("```")).length;
    assert.equal(fences % 2, 0, `unbalanced fences in chunk:\n${chunk}`);
  }
  assert.ok(chunks[1]?.startsWith("```python\n"), "continuation should reopen the python block");
  const allLines = chunks.join("\n").split("\n");
  for (let i = 0; i < 80; i++) assert.ok(allLines.includes(`line_${i} = ${i}`), `missing line_${i}`);
});

test("emphasis tags always nest: overlapping markers stay literal instead of breaking Telegram's HTML", () => {
  assert.equal(markdownToTelegramHtml("**bold _it** x_"), "<b>bold _it</b> x_");
  assert.equal(markdownToTelegramHtml("***both***"), "<b><i>both</i></b>");
  assert.equal(markdownToTelegramHtml("**a *b* c**"), "<b>a <i>b</i> c</b>");
  assert.equal(markdownToTelegramHtml("**never closed"), "**never closed");
  assert.equal(markdownToTelegramHtml("2*3*4 and file_name_here"), "2*3*4 and file_name_here");
});

test("markup inside a link's URL is left alone; quotes in URLs can't break the attribute", () => {
  assert.equal(markdownToTelegramHtml("[d](https://e.com/a**b**c)"), '<a href="https://e.com/a**b**c">d</a>');
  assert.equal(markdownToTelegramHtml("**[d](https://e.com/x_y_z)**"), '<b><a href="https://e.com/x_y_z">d</a></b>');
  assert.equal(markdownToTelegramHtml('[q](https://e.com/?a="x")'), '<a href="https://e.com/?a=&quot;x&quot;">q</a>');
});

test("every converted line has balanced tags (random markdown)", () => {
  const pieces = ["**", "__", "*", "_", "~~", "word", " ", "`c`", "[l](https://e.com/a_b)", "x_y", "**z**"];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 2000; n++) {
    const md = Array.from({ length: 12 }, () => pieces[Math.floor(rand() * pieces.length)]).join("");
    const html = markdownToTelegramHtml(md);
    const stack: string[] = [];
    for (const [, close, name] of html.matchAll(/<(\/?)(b|i|s|a|code)\b[^>]*>/g)) {
      if (!close) stack.push(name!);
      else assert.equal(stack.pop(), name, `unbalanced for ${JSON.stringify(md)} → ${html}`);
    }
    assert.deepEqual(stack, [], `unclosed for ${JSON.stringify(md)} → ${html}`);
  }
});

import { linkifyEscaped } from "../src/telegram/format.ts";

test("bare addresses are linked with ASCII-only edges, so Telegram can't stretch a link over the Chinese text around it", () => {
  assert.equal(
    markdownToTelegramHtml("- 登录Claude后打开claude.ai/settings/account，复制Account页面里的Organization ID。"),
    '• 登录Claude后打开<a href="https://claude.ai/settings/account">claude.ai/settings/account</a>，复制Account页面里的Organization ID。',
  );
  assert.equal(markdownToTelegramHtml("见 https://example.com/a?b=1&c=2。"), '见 <a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>。');
  assert.equal(markdownToTelegramHtml("(github.com/a_b_c)"), '(<a href="https://github.com/a_b_c">github.com/a_b_c</a>)', "brackets outside, underscores not italic");
  assert.equal(markdownToTelegramHtml("https://en.wikipedia.org/wiki/Foo_(bar) end"), '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a> end');
  const untouched = "v2.0.1、Node.js、README.md、3.8、mail@foo.com、e.g. this";
  assert.equal(markdownToTelegramHtml(untouched), untouched, "versions, file names and e-mail stay text");
  assert.equal(markdownToTelegramHtml("`claude.ai/x` [官网](https://claude.ai)"), '<code>claude.ai/x</code> <a href="https://claude.ai">官网</a>', "code and real links are not linked twice");
  // Card text (X, Douyin, … posts) gets the same treatment.
  assert.equal(linkifyEscaped("打开claude.ai，然后"), '打开<a href="https://claude.ai">claude.ai</a>，然后');
});
