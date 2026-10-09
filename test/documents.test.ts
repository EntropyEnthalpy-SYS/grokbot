import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DOCUMENT_MAX_CHARS, readDocument, xmlText } from "../src/media/documents.ts";
import { docx, pdf, pptx, zipFile } from "./fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "docs-"));
const file = (name: string, data: Buffer | string) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};
const read = (path: string, fileName: string, mimeType?: string) => readDocument(path, { fileName, mimeType, workDir: mkdtempSync(join(dir, "w-")) });

test("PDF: text of every page, in order, with the page count; a short PDF (a receipt) is text, not a scan", async () => {
  const doc = await read(file("a.pdf", pdf([["Quarterly report", "Revenue rose 42 percent"], ["Page two: risks"]])), "report.pdf");
  assert.equal(doc.kind, "PDF, 2 pages");
  assert.match(doc.text, /Quarterly report[\s\S]*Revenue rose 42 percent[\s\S]*Page two: risks/);
  assert.deepEqual(doc.images, []);
  const receipt = await read(file("r.pdf", pdf([["Total: NT$420"]])), "receipt.pdf");
  assert.deepEqual([receipt.kind, receipt.text, receipt.images.length], ["PDF, 1 page", "Total: NT$420", 0]);
});

test("a PDF without a text layer (a scan) is read as page images instead", async () => {
  const doc = await read(file("scan.pdf", pdf([[], [], ["p3"]])), "scan.pdf");
  assert.equal(doc.images.length, 3);
  assert.equal(doc.images[0]!.mimeType, "image/jpeg");
  assert.equal(doc.kind, "scanned PDF (first 3 pages as images)");
});

test("Word: paragraphs become lines, tabs and XML entities survive", async () => {
  const doc = await read(file("a.docx", docx(["Agenda", "1.\tBudget & hiring", "2.\t<Q4> plan"])), "notes.docx");
  assert.equal(doc.text, "Agenda\n1.\tBudget & hiring\n2.\t<Q4> plan");
  assert.equal(doc.kind, "Word document");
});

test("PowerPoint: slides in numeric order (slide10 after slide2), however the zip lists them", async () => {
  const slides = Array.from({ length: 10 }, (_, i) => [`Title ${i + 1}`]);
  const doc = await read(file("deck.pptx", pptx(slides)), "deck.pptx");
  const order = [...doc.text.matchAll(/Title (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(doc.text, /--- Slide 10 ---\nTitle 10/);
});

test("text and code files are read by extension or MIME type; binary files and unknown types are refused", async () => {
  assert.equal((await read(file("a.csv", "name,score\nAmy,9"), "a.csv")).text, "name,score\nAmy,9");
  assert.equal((await read(file("noext", "hello"), "noext", "text/plain")).text, "hello");
  await assert.rejects(read(file("bin.txt", Buffer.from([0x50, 0x4b, 0, 1, 2])), "bin.txt"), /isn't text/);
  await assert.rejects(read(file("a.exe", "MZ"), "a.exe", "application/octet-stream"), /I can read PDF/);
  await assert.rejects(read(file("fake.docx", "not a zip at all"), "fake.docx"), /damaged/);
  await assert.rejects(read(file("other.docx", zipFile({ "x.xml": "<a/>" })), "other.docx"), /damaged or not the format/);
});

test("long documents keep their start and end and say so", async () => {
  const text = `START ${"x".repeat(DOCUMENT_MAX_CHARS * 2)} END`;
  const doc = await read(file("long.txt", text), "long.txt");
  assert.equal(doc.truncated, true);
  assert.ok(doc.text.length <= DOCUMENT_MAX_CHARS);
  assert.match(doc.text, /^START[\s\S]*characters omitted[\s\S]*END$/);
});

test("xmlText: OpenDocument paragraphs and headings, numeric entities", () => {
  assert.equal(xmlText("<text:h>Title</text:h><text:p>caf&#233; &#x4E2D;<text:line-break/>next</text:p>", "text"), "Title\ncafé 中\nnext");
});
