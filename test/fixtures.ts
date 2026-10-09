import { crc32, deflateRawSync } from "node:zlib";

/** A zip archive (deflated entries), as Office documents are. */
export function zipFile(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const header = (size: number) => Buffer.alloc(size);
    const local = header(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = header(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A Word document with these paragraphs (a paragraph may contain \t for a tab). */
export function docx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:r>${p.split("\t").map((part) => `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`).join("<w:tab/>")}</w:r></w:p>`)
    .join("");
  return zipFile({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`,
  });
}

/** A PowerPoint file; slide files are written out of order to check the reading order. */
export function pptx(slides: string[][]): Buffer {
  const entries: Record<string, string> = { "[Content_Types].xml": "<Types/>" };
  for (const [i, lines] of [...slides.entries()].reverse()) {
    entries[`ppt/slides/slide${i + 1}.xml`] = `<p:sld><p:txBody>${lines.map((l) => `<a:p><a:r><a:t>${escapeXml(l)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sld>`;
  }
  return zipFile(entries);
}

/** A PDF with one page per entry; each page shows its lines (ASCII). An empty page has no text (like a scan). */
export function pdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (const [i, lines] of pages.entries()) {
    const text = lines.map((line, n) => `${n === 0 ? "72 720 Td" : "0 -16 Td"} (${line.replace(/[()\\]/g, "\\$&")}) Tj`).join(" ");
    const stream = lines.length ? `BT /F1 12 Tf ${text} ET` : "";
    objects[pageIds[i]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageIds[i]! + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
