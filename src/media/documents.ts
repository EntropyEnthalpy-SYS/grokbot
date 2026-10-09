import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { ImageContent } from "@earendil-works/pi-ai";
import { capText } from "../links/reader.ts";
import { run } from "./run.ts";

/** Documents larger than this are not read (Telegram's cloud Bot API allows 20 MB anyway). */
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Text handed to the model per document; longer documents keep their start and end. */
export const DOCUMENT_MAX_CHARS = 60_000;
/** PDF pages read for text, and pages rendered as images when a PDF has no text layer (scans). */
const PDF_MAX_PAGES = 300;
const PDF_SCAN_PAGES = 4;
/** Fewer visible characters than this per page on average: treated as a scan. */
const SCAN_CHARS_PER_PAGE = 5;
/** A zip entry may not unpack to more than this (zip bombs). */
const ZIP_ENTRY_MAX_BYTES = 50 * 1024 * 1024;

export interface DocumentContent {
  /** "PDF, 12 pages", "Word document", "text file"… */
  kind: string;
  text: string;
  /** Pages of a scanned PDF, for a vision model to read. */
  images: ImageContent[];
  truncated: boolean;
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "html", "htm", "yaml", "yml", "toml", "ini", "log", "srt", "vtt",
  "py", "js", "ts", "tsx", "jsx", "java", "kt", "go", "rs", "c", "h", "cpp", "cs", "rb", "php", "swift", "sh", "sql", "css",
]);

/** Whether a Telegram document is one the bot can read (by file name or MIME type). */
export function isReadableDocument(fileName: string | undefined, mimeType: string | undefined): boolean {
  return documentType(fileName, mimeType) !== undefined;
}

type DocType = "pdf" | "docx" | "pptx" | "odt" | "text";

function documentType(fileName = "", mimeType = ""): DocType | undefined {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (ext === "docx" || mimeType.includes("wordprocessingml")) return "docx";
  if (ext === "pptx" || mimeType.includes("presentationml")) return "pptx";
  if (ext === "odt" || ext === "odp" || mimeType.includes("opendocument.text") || mimeType.includes("opendocument.presentation")) return "odt";
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith("text/") || /json|xml|yaml|csv/.test(mimeType)) return "text";
  return undefined;
}

/**
 * The text of a document on disk: PDF (poppler's pdftotext; scanned pages become images),
 * Word/PowerPoint/OpenDocument (read straight from the zip), or plain text and code.
 * Throws a short, user-presentable error for anything else.
 */
export async function readDocument(path: string, options: { fileName?: string; mimeType?: string; workDir: string; signal?: AbortSignal }): Promise<DocumentContent> {
  const type = documentType(options.fileName, options.mimeType);
  if (!type) throw new Error("I can read PDF, Word (.docx), PowerPoint (.pptx), OpenDocument and text files.");
  if ((await stat(path)).size > DOCUMENT_MAX_BYTES) throw new Error(`That document is larger than ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB.`);
  let kind: string;
  let text: string;
  let images: ImageContent[] = [];
  switch (type) {
    case "pdf": {
      const { stdout } = await run("pdftotext", ["-enc", "UTF-8", "-l", String(PDF_MAX_PAGES), "-q", path, "-"], { timeoutMs: 60_000, signal: options.signal });
      // pdftotext ends every page with a form feed, also pages without any text.
      const pages = Math.max(1, stdout.split("\f").length - 1);
      text = stdout.replace(/\f/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      kind = `PDF, ${pages} page${pages === 1 ? "" : "s"}`;
      // A scan has (almost) no text layer; a short PDF such as a receipt still has real text.
      if (text.replace(/\s/g, "").length < SCAN_CHARS_PER_PAGE * pages) {
        // Scanned: no text layer. The first pages go to the model as pictures instead.
        images = await renderPdfPages(path, options.workDir, options.signal);
        kind = `scanned PDF (first ${images.length} page${images.length === 1 ? "" : "s"} as images)`;
      }
      break;
    }
    case "docx":
      kind = "Word document";
      text = xmlText(zipEntry(await readFile(path), "word/document.xml"), "w");
      break;
    case "pptx": {
      kind = "PowerPoint presentation";
      const zip = await readFile(path);
      const slides = zipNames(zip)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
      text = slides.map((name, i) => `--- Slide ${i + 1} ---\n${xmlText(zipEntry(zip, name), "a")}`).join("\n\n");
      break;
    }
    case "odt":
      kind = "OpenDocument file";
      text = xmlText(zipEntry(await readFile(path), "content.xml"), "text");
      break;
    case "text": {
      const raw = await readFile(path);
      if (raw.subarray(0, 8192).includes(0)) throw new Error("That file isn't text.");
      kind = "text file";
      text = raw.toString("utf8");
      break;
    }
  }
  text = text.trim();
  if (!text && images.length === 0) throw new Error("I couldn't find any text in that document.");
  return { kind, text: capText(text, DOCUMENT_MAX_CHARS), images, truncated: text.length > DOCUMENT_MAX_CHARS };
}

async function renderPdfPages(path: string, dir: string, signal?: AbortSignal): Promise<ImageContent[]> {
  const prefix = join(dir, "page");
  await run("pdftoppm", ["-jpeg", "-r", "110", "-l", String(PDF_SCAN_PAGES), path, prefix], { timeoutMs: 60_000, signal });
  const files = (await readdir(dir)).filter((name) => name.startsWith("page") && name.endsWith(".jpg")).sort();
  return Promise.all(files.map(async (name) => ({ type: "image" as const, data: (await readFile(join(dir, name))).toString("base64"), mimeType: "image/jpeg" })));
}

/**
 * Text of an Office/OpenDocument XML part: paragraphs become lines, tabs and breaks are kept,
 * every other tag is dropped. `ns` is the text namespace (w: Word, a: slides, text: ODF).
 */
export function xmlText(xml: string, ns: string): string {
  return decodeXml(
    xml
      .replace(new RegExp(`<${ns}:tab\\b[^>]*/>`, "g"), "\t")
      .replace(new RegExp(`<${ns}:(br|line-break)\\b[^>]*/>`, "g"), "\n")
      .replace(new RegExp(`</${ns}:(p|h)>`, "g"), "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[lower]!;
  });
}

type ZipEntry = { name: string; method: number; compressedSize: number; size: number; localOffset: number };

/** The central directory of a zip file (Office documents are zips). */
function zipDirectory(zip: Buffer): ZipEntry[] {
  const minEnd = Math.max(0, zip.length - 65_557);
  let end = -1;
  for (let i = zip.length - 22; i >= minEnd; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("That document is damaged (not a valid Office file).");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw new Error("That document is damaged (not a valid Office file).");
    const nameLength = zip.readUInt16LE(at + 28);
    entries.push({
      name: zip.toString("utf8", at + 46, at + 46 + nameLength),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      localOffset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

function zipNames(zip: Buffer): string[] {
  return zipDirectory(zip).map((entry) => entry.name);
}

/** One file from a zip, as UTF-8 text. */
export function zipEntry(zip: Buffer, name: string): string {
  const entry = zipDirectory(zip).find((e) => e.name === name);
  if (!entry) throw new Error("That document is damaged or not the format its name says.");
  if (entry.size > ZIP_ENTRY_MAX_BYTES) throw new Error("That document is too large to read.");
  const local = entry.localOffset;
  if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("That document is damaged (not a valid Office file).");
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.toString("utf8");
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: ZIP_ENTRY_MAX_BYTES }).toString("utf8");
  throw new Error("That document uses a compression I can't read.");
}
