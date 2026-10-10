import assert from "node:assert/strict";
import { test } from "node:test";
import { plainWebCard, webPreview } from "../src/links/webcard.ts";

const page = (body: string, status = 200, contentType = "text/html") => async () => ({ url: "", status, contentType, body, truncated: false });
const reader = (text: string | Error) => ({ read: async () => (text instanceof Error ? Promise.reject(text) : { url: "", text, source: "tavily" as const }) });

test("web preview: the page's own title and description when it has them; the reader is not needed", async () => {
  let read = false;
  const html = '<html><head><meta property="og:title" content="出Claude Pro 一个月70RMB"><meta name="description" content="只需要 Organization ID"></head><body>x</body></html>';
  const preview = await webPreview({ read: async () => ((read = true), { url: "", text: "", source: "tavily" }) }, "https://www.nodeseek.com/post-1", { fetchPage: page(html) as never });
  assert.deepEqual(preview, { title: "出Claude Pro 一个月70RMB", snippet: "只需要 Organization ID" });
  assert.equal(read, false);
});

test("web preview: a blocked or script-only page falls back to the reader's text, skipping navigation headings", async () => {
  const text = "#### 所有版块\n\n出Claude Pro 一个月70RMB. 只需要 Organization ID。\n\n登录 Claude 后打开 claude.ai/settings/account。\n\n#### 你好啊，陌生人!";
  const blocked = (async () => { throw new Error("403"); }) as never;
  const preview = await webPreview(reader(text), "https://www.nodeseek.com/post-1", { fetchPage: blocked });
  assert.deepEqual(preview, { title: "出Claude Pro 一个月70RMB. 只需要 Organization ID。", snippet: "登录 Claude 后打开 claude.ai/settings/account。" }, "no title: the first sentence is the title");
  assert.equal(await webPreview(reader(new Error("no content")), "https://x.example/", { fetchPage: blocked }), undefined, "nothing readable: no card");
  // A title but no description: the start of the text is the snippet.
  const titled = await webPreview(reader("First paragraph."), "https://x.example/", { fetchPage: page("<title>Hello</title>") as never });
  assert.deepEqual(titled, { title: "Hello", snippet: "First paragraph." });
});

test("plain web card: linked title (or the site name), the snippet folded, addresses in it linked; long text shortened", () => {
  const card = plainWebCard("https://www.nodeseek.com/post-1", { title: "A & B", snippet: "打开claude.ai/settings设置" });
  assert.equal(card.html, '🔗 <a href="https://www.nodeseek.com/post-1"><b>A &amp; B</b></a>\n<blockquote expandable>打开<a href="https://claude.ai/settings">claude.ai/settings</a>设置</blockquote>');
  assert.equal(plainWebCard("https://www.example.com/x", { snippet: "" }).plain, "🔗 example.com");
  assert.ok(plainWebCard("https://x.example/", { title: "t".repeat(500), snippet: "" }).plain.length <= 125);
});
