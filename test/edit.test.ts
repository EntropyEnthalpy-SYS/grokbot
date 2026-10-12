import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDocument, zipEntry, zipNew } from "../src/media/documents.ts";
import { asksToEditFile, editParagraphs, newDocx, openForEdit, wantsEditedFile } from "../src/media/edit.ts";

const dir = () => mkdtempSync(join(tmpdir(), "edit-"));
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

test("edit requests are told apart from questions about a file", () => {
  for (const t of ["修正语法和格式，发回文件", "把语气改得正式一点", "translate this into English", "proofread it", "帮我改一下", "润色"]) assert.equal(asksToEditFile(t), true, t);
  for (const t of ["总结这个文件", "这份合同讲了什么", "translate this word for me?", "这个版本改了什么", "what changed in v2?"]) assert.equal(asksToEditFile(t), false, t);
});

test("any wording works: what clear words don't settle, the AI decides", async () => {
  const asked: string[] = [];
  const ai = (reply: string | Error) => async (_system: string, prompt: string) => {
    asked.push(prompt);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  assert.equal(await wantsEditedFile(ai("ANSWER"), "润色一下"), true);
  assert.equal(asked.length, 0, "clear wording needs no AI call");
  assert.equal(await wantsEditedFile(ai("EDIT"), "翻译这个文件"), true);
  assert.equal(await wantsEditedFile(ai("Answer"), "这个文件讲了什么"), false);
  assert.deepEqual(asked, ["Request: 翻译这个文件", "Request: 这个文件讲了什么"]);
  // Unsure or failing: an answer in the chat, never an unwanted rewrite.
  assert.equal(await wantsEditedFile(ai("EDIT or ANSWER"), "嗯"), false);
  assert.equal(await wantsEditedFile(ai(new Error("offline")), "make it nicer"), false);
  assert.equal(await wantsEditedFile(ai("EDIT"), "  "), false);
});

test("the AI returns only changed paragraphs: unknown numbers and unchanged text are ignored, long files go in batches", async () => {
  const prompts: string[] = [];
  const paragraphs = ["Title", "", "teh first line", "x".repeat(7_990), "last line"];
  const ask = async (_system: string, prompt: string) => {
    prompts.push(prompt);
    return prompts.length === 1
      ? 'Sure:\n```json\n{"edits":[{"p":2,"text":"The first line"},{"p":0,"text":"Title"},{"p":99,"text":"nope"}],"summary":["Fixed a typo"]}\n```'
      : '{"edits":[{"p":4,"text":"Last line."}],"summary":["Fixed a typo","Added a full stop"]}';
  };
  const { edits, summary } = await editParagraphs(ask, paragraphs, "fix typos");
  assert.deepEqual([...edits], [[2, "The first line"], [4, "Last line."]]);
  assert.deepEqual(summary, ["Fixed a typo", "Added a full stop"]);
  assert.equal(prompts.length, 2, "split before the batch passes 8000 characters");
  assert.match(prompts[0]!, /^Request: fix typos\n\nDocument:\n\[0\] Title\n\[2\] teh first line$/m, "empty lines aren't sent; numbers are the real indices");
  await assert.rejects(editParagraphs(ask, ["y".repeat(60_001)], "fix"), /too long/);
});

test("a text file comes back as the same kind of file with the changed lines", async () => {
  const d = dir();
  writeFileSync(join(d, "notes.md"), "# Notes\n\nteh plan\nkeep me\n");
  const doc = await openForEdit(join(d, "notes.md"), "notes.md", "text/markdown", d);
  assert.equal(doc.name, "notes-edited.md");
  assert.equal(doc.build(new Map([[2, "The plan"], [3, ""]])).toString(), "# Notes\n\nThe plan\n");
});

test("a Word file keeps its formatting: only changed paragraphs are rewritten, in their style; other parts are untouched", async () => {
  const d = dir();
  const body =
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Teh </w:t></w:r><w:r><w:t>Report</w:t></w:r></w:p>` +
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell &amp; text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
    `<w:p/><w:p><w:r><w:t>Unchanged</w:t></w:r></w:p>`;
  const styles = `<?xml version="1.0"?><w:styles ${W}><w:style w:styleId="Heading1"/></w:styles>`;
  writeFileSync(join(d, "r.docx"), zipNew({ "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`, "word/styles.xml": styles }));
  const doc = await openForEdit(join(d, "r.docx"), "r.docx", undefined, d);
  assert.deepEqual(doc.paragraphs, ["Teh Report", "cell & text", "", "Unchanged"]);
  const out = doc.build(new Map([[0, "The Report"], [1, "A < B\nnext"]]));
  const xml = zipEntry(out, "word/document.xml");
  assert.match(xml, /<w:p><w:pPr><w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">The Report<\/w:t><\/w:r><\/w:p>/, "heading style and the first run's bold stay");
  assert.match(xml, /<w:tc><w:p><w:r><w:t xml:space="preserve">A &lt; B<\/w:t><w:br\/><w:t xml:space="preserve">next<\/w:t><\/w:r><\/w:p><\/w:tc>/, "inside the table, escaped, line break kept");
  assert.match(xml, /<w:p\/><w:p><w:r><w:t>Unchanged<\/w:t><\/w:r><\/w:p>/, "unchanged paragraphs byte for byte");
  assert.equal(zipEntry(out, "word/styles.xml"), styles);
  writeFileSync(join(d, "out.docx"), out);
  execFileSync("unzip", ["-tq", join(d, "out.docx")]);
  assert.equal((await readDocument(join(d, "out.docx"), { fileName: "out.docx", workDir: d })).text, "The Report\nA < B\nnext\nUnchanged");
});

test("a PDF comes back as a new Word file with the edited paragraphs", async () => {
  const d = dir();
  // A real PDF without extra tools: a minimal one-page PDF with two paragraphs of text.
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 88>>stream
BT /F1 12 Tf 20 150 Td (First paragraph here) Tj 0 -60 Td (Second paragraph text) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
  writeFileSync(join(d, "a.pdf"), pdf);
  const doc = await openForEdit(join(d, "a.pdf"), "a.pdf", "application/pdf", d);
  assert.equal(doc.name, "a-edited.docx");
  assert.ok(doc.paragraphs.length >= 1 && doc.paragraphs.join(" ").includes("First paragraph"), doc.paragraphs.join("|"));
  writeFileSync(join(d, "out.docx"), doc.build(new Map([[0, "Edited first"]])));
  assert.match((await readDocument(join(d, "out.docx"), { fileName: "out.docx", workDir: d })).text, /^Edited first/);
  assert.ok(readFileSync(join(d, "out.docx")).length > 0);
});

test("file names from the AI are made safe: no folders, odd extensions become .txt", async () => {
  const { safeFileName } = await import("../src/agent/files.ts");
  assert.equal(safeFileName("../../etc/passwd"), "passwd.txt");
  assert.equal(safeFileName("notes/iplc-ss.md"), "iplc-ss.md");
  assert.equal(safeFileName("report.DOCX"), "report.DOCX");
  assert.equal(safeFileName("run.exe"), "run.exe.txt");
});

test("send_file writes real code fences in Markdown even when the AI escaped them", async () => {
  const { FileDesk } = await import("../src/agent/files.ts");
  const desk = new FileDesk();
  const turn = desk.begin("k");
  await desk.tool("k").execute("1", { name: "a.md", content: "\\`\\`\\`bash\nls\n\\`\\`\\`" });
  await desk.tool("k").execute("2", { name: "run.sh", content: "echo \\`date\\`" });
  const [md, sh] = desk.end(turn);
  assert.equal(md!.data.toString(), "```bash\nls\n```");
  assert.equal(sh!.data.toString(), "echo \\`date\\`", "scripts keep their escapes");
});
