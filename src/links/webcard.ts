import { escapeAttr, escapeHtml, linkifyEscaped } from "../telegram/format.ts";
import { htmlToText } from "./html.ts";
import type { LinkReader } from "./reader.ts";
import { safeFetch } from "./safeFetch.ts";

/** Snippet shown under a web page's title (the rest is one tap away). */
const SNIPPET_CHARS = 300;
const SNIPPET_LINES = 4;
const TITLE_CHARS = 120;

export interface WebPreview {
  title?: string;
  snippet: string;
}

/**
 * What a link preview shows: the page's title and description (og: tags), fetched directly;
 * pages that hide them (JavaScript sites, blocked servers) fall back to the start of their text
 * from the link reader (Tavily). No AI. Undefined when nothing readable was found.
 */
export async function webPreview(
  reader: Pick<LinkReader, "read">,
  url: string,
  options: { signal?: AbortSignal; fetchPage?: typeof safeFetch } = {},
): Promise<WebPreview | undefined> {
  let title: string | undefined;
  let snippet = "";
  try {
    const page = await (options.fetchPage ?? safeFetch)(url, { timeoutMs: 8000, maxBytes: 1024 * 1024, signal: options.signal });
    if (page.status < 400 && /html/i.test(page.contentType)) {
      const parsed = htmlToText(page.body);
      title = parsed.title;
      snippet = parsed.description ?? "";
    }
  } catch {
    // Blocked or unreachable from the server: the reader may still get the text.
  }
  if (!snippet || !title) {
    try {
      const text = (await reader.read(url, options.signal)).text;
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      title ??= lines.find((line) => /^#\s/.test(line))?.replace(/^#\s+/, "");
      // Headings are usually site navigation ("#### 所有版块"); the first real sentences say more.
      const content = lines.filter((line) => !line.startsWith("#") && line !== title);
      // No title at all (a forum post): its first sentence is the best title there is.
      if (!title && content.length > 0) title = content.shift()!.slice(0, TITLE_CHARS);
      snippet ||= content.slice(0, SNIPPET_LINES).join("\n");
    } catch {
      // Nothing readable.
    }
  }
  if (!title && !snippet) return undefined;
  return { title, snippet: shorten(snippet.replace(/[ \t]+/g, " "), SNIPPET_CHARS) };
}

/** "🔗 Title" (linked) and the snippet, folded: like a link preview, with no commentary. */
export function plainWebCard(url: string, preview: WebPreview): { html: string; plain: string } {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const title = shorten((preview.title ?? "").trim() || host, TITLE_CHARS);
  const headerHtml = `🔗 <a href="${escapeAttr(url)}"><b>${escapeHtml(title)}</b></a>`;
  const snippet = preview.snippet.trim();
  return {
    html: snippet ? `${headerHtml}\n<blockquote expandable>${linkifyEscaped(escapeHtml(snippet))}</blockquote>` : headerHtml,
    plain: snippet ? `🔗 ${title}\n${snippet}` : `🔗 ${title}`,
  };
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
