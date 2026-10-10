/** Telegram rejects messages longer than this many characters (after entity parsing). */
export const TELEGRAM_LIMIT = 4096;
/** Markdown chunk size; leaves room for HTML tags added by conversion. */
export const CHUNK_LIMIT = 3500;

const FENCE = /^\s*```/;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert the Markdown Grok writes into Telegram's HTML subset:
 * code blocks, inline code, bold, italic, strikethrough, links, headings, bullets.
 * Every tag is produced from a matched pair, so output is always balanced.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i] ?? "")) code.push(lines[i++] ?? "");
      const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    out.push(formatLine(line));
  }
  return out.join("\n");
}

function formatLine(line: string): string {
  const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
  if (heading) return `<b>${formatInline(heading[1] ?? "")}</b>`;
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return `${bullet[1]}• ${formatInline(bullet[2] ?? "")}`;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "──────";
  return formatInline(line);
}

function formatInline(text: string): string {
  // Split on inline code first so markup inside `code` is left alone.
  return text
    .split(/(`[^`\n]+`)/)
    .map((part) => (part.length > 1 && part.startsWith("`") && part.endsWith("`")
      ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
      : formatEmphasis(escapeHtml(part))))
    .join("");
}

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const SLOT = /\u0000(\d+)\u0000/g;

/** Escape for a double-quoted HTML attribute (text already passed through escapeHtml, or raw). */
export function escapeAttr(text: string): string {
  return text.replace(/&(?!(amp|lt|gt|quot);)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Links first (so markup inside a URL stays untouched), then bold/italic/strike. Input is HTML-escaped. */
function formatEmphasis(text: string): string {
  const links: string[] = [];
  const slot = (html: string) => (links.push(html), `\u0000${links.length - 1}\u0000`);
  const slotted = text
    .replace(LINK, (_m, label: string, url: string) => slot(`<a href="${escapeAttr(url)}">${emphasize(label)}</a>`))
    .replace(BARE_URL, (match: string) => linkBare(match, slot));
  return emphasize(slotted).replace(SLOT, (_m, i: string) => links[Number(i)] ?? "");
}

/**
 * Bare addresses ("claude.ai/settings/account", "https://x.com/a?b=1"): ASCII only, so a link
 * never swallows the Chinese text around it. Telegram would otherwise link them itself and, with
 * no space between, take "登录Claude后打开claude.ai/…，复制…" as one (wrong) address.
 * Domains without https:// need a common top-level domain, so "Node.js", "README.md" and "3.8" stay text.
 */
const TLDS = "com|net|org|edu|gov|io|ai|app|dev|me|co|tv|gg|xyz|info|biz|cn|tw|jp|hk|sg|kr|uk|us|de|fr|ru|in|au|ca|nl|eu|ly|to|cc|fm|im|la|vc|page|site|online|tech|top|cloud|blog|news|store|shop|live|link|club|vip|pro|art|one|life|world|today|wiki|tools";
const URL_PATH = "(?:&amp;|[A-Za-z0-9\\-._~%!$'()*+,;=:@/?#\\[\\]])*";
const BARE_URL = new RegExp(
  `(?<![A-Za-z0-9.@/\\-])(?:https?://[A-Za-z0-9.-]+(?::\\d{1,5})?(?:/${URL_PATH})?|(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+(?:${TLDS})(?![A-Za-z0-9-])(?::\\d{1,5})?(?:/${URL_PATH})?)`,
  "gi",
);

/** One bare address as a link; trailing sentence punctuation ("…/account." or "(see x.com)") stays outside. */
function linkBare(match: string, slot: (html: string) => string): string {
  let url = match;
  let tail = "";
  while (/[.,;:!?'\])]$/.test(url) && !(url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0))) {
    tail = url.slice(-1) + tail;
    url = url.slice(0, -1);
  }
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return slot(`<a href="${escapeAttr(href)}">${url}</a>`) + tail;
}

/** Bare addresses in HTML-escaped plain text (card bodies), linked the same way as in replies. */
export function linkifyEscaped(escaped: string): string {
  const links: string[] = [];
  const slotted = escaped.replace(BARE_URL, (match: string) => linkBare(match, (html) => (links.push(html), `\u0000${links.length - 1}\u0000`)));
  return slotted.replace(SLOT, (_m, i: string) => links[Number(i)] ?? "");
}

const MARKERS = ["**", "__", "~~", "*", "_"] as const;
type Marker = (typeof MARKERS)[number];
const TAG: Record<Marker, string> = { "**": "b", __: "b", "~~": "s", "*": "i", _: "i" };
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/**
 * Bold/italic/strike with a stack, so tags always nest properly: a closing
 * marker closes its nearest opener, and anything opened inside it but never
 * closed stays literal text, as do markers never closed. Single * and _ need word boundaries
 * outside (snake_case, 2*3*4 are left alone).
 */
function emphasize(text: string): string {
  const out: string[] = [];
  const open: { marker: Marker; at: number }[] = [];
  let i = 0;
  while (i < text.length) {
    // Close the innermost open marker first when it is here ("***x***" → <b><i>x</i></b>).
    const innermost = open.at(-1)?.marker;
    const marker = innermost && text.startsWith(innermost, i) && !isSpace(text[i - 1]) ? innermost : MARKERS.find((m) => text.startsWith(m, i));
    if (!marker) {
      out.push(text[i]!);
      i++;
      continue;
    }
    const before = text[i - 1];
    const after = text[i + marker.length];
    const single = marker.length === 1;
    const depth = open.findLastIndex((o) => o.marker === marker);
    const opener = open[depth];
    const canClose = opener !== undefined && !isSpace(before) && opener.at < out.length - 1 && !(single && isWord(after));
    const canOpen = !isSpace(after) && !(single && isWord(before)) && opener === undefined;
    if (canClose) {
      // Markers opened inside this one and never closed stay literal text.
      open.length = depth;
      out[opener.at] = `<${TAG[marker]}>`;
      out.push(`</${TAG[marker]}>`);
    } else if (canOpen) {
      open.push({ marker, at: out.length });
      out.push(marker);
    } else {
      out.push(marker);
    }
    i += marker.length;
  }
  return out.join("");
}

/**
 * Split Markdown into chunks of at most `limit` characters, preferring
 * paragraph, then line, then word boundaries. A code block cut across chunks
 * is closed at the end of one chunk and reopened (same language) in the next.
 */
export function splitMarkdown(markdown: string, limit: number = CHUNK_LIMIT): string[] {
  const text = markdown.trim();
  if (text.length <= limit) return text ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  let reopen = "";
  while (rest.length > 0) {
    const budget = limit - reopen.length - 4; // room for a closing fence
    if (reopen.length + rest.length <= limit) {
      chunks.push(reopen + rest);
      break;
    }
    const cut = findCut(rest, budget);
    let chunk = reopen + rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).replace(/^\n+/, "");
    const openFence = unclosedFence(chunk);
    if (openFence !== undefined) {
      chunk += "\n```";
      reopen = "```" + openFence + "\n";
    } else {
      reopen = "";
    }
    chunks.push(chunk);
  }
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function findCut(text: string, budget: number): number {
  const window = text.slice(0, budget);
  for (const separator of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(separator);
    if (at > budget / 2) return at + separator.length;
  }
  return budget;
}

/** If the text ends inside a ``` block, return that block's language ("" if none). */
function unclosedFence(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const fence = line.match(/^\s*```\s*([\w+#.-]*)/);
    if (!fence) continue;
    open = open === undefined ? (fence[1] ?? "") : undefined;
  }
  return open;
}
