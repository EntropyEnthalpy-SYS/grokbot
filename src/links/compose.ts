import { escapeHtml, linkifyEscaped } from "../telegram/format.ts";

/**
 * Card layout shared by X posts and ParseHub posts, compact like parse_hub_bot:
 * the media, the author line (and a title), then the text, translation and
 * quoted post together in ONE collapsed quote: Telegram shows its first lines
 * and an arrow to expand the rest.
 *  - `captionHtml` fits Telegram's 1024-character media caption (text clipped with "…" if needed;
 *    the author link opens the full post). No second message repeats the text.
 */

export type Block =
  | { kind: "title"; text: string }
  | { kind: "text"; text: string }
  | { kind: "translation"; text: string }
  | { kind: "quote"; handle: string; text: string }
  | { kind: "note"; text: string };

export interface Composed {
  html: string;
  plain: string;
  headerHtml: string;
  bodyHtml: string;
  bodyPlain: string;
  captionHtml: string;
}

export const CAPTION_BUDGET = 1000;
/** Per-block cap for the full version so text + translation fit one 4096-character message. */
const FULL_BLOCK = 1800;

export function composeCard(header: { html: string; plain: string }, blocks: readonly Block[]): Composed {
  const nonEmpty = blocks.filter((block) => block.text.trim());
  const full = nonEmpty.map((block) => render(block, FULL_BLOCK));

  // Caption: titles, quotes and notes get a small fixed share; text and translation split the rest.
  let budget = CAPTION_BUDGET - header.plain.length - 2;
  const fixed = nonEmpty.filter((b) => b.kind !== "text" && b.kind !== "translation");
  const flexible = nonEmpty.filter((b) => b.kind === "text" || b.kind === "translation");
  const limits = new Map<Block, number>();
  for (const block of fixed) {
    const limit = Math.min(block.text.length, block.kind === "title" ? 120 : 200);
    limits.set(block, limit);
    budget -= limit + 8;
  }
  let remaining = flexible.length;
  for (const block of [...flexible].sort((a, b) => a.text.length - b.text.length)) {
    const share = Math.max(80, Math.floor(budget / remaining) - 6);
    const limit = Math.min(block.text.trim().length, share);
    limits.set(block, limit);
    budget -= limit + 6;
    remaining--;
  }
  const compact = nonEmpty.map((block) => ({ block, ...render(block, limits.get(block)!) }));

  const fullWithBlocks = nonEmpty.map((block, i) => ({ block, ...full[i]! }));
  const bodyHtml = layout(fullWithBlocks);
  const bodyPlain = full.map((r) => r.plain).join("\n\n");
  return {
    headerHtml: header.html,
    bodyHtml,
    bodyPlain,
    html: [header.html, bodyHtml].filter(Boolean).join("\n"),
    plain: [header.plain, bodyPlain].filter(Boolean).join("\n\n"),
    captionHtml: [header.html, layout(compact)].filter(Boolean).join("\n"),
  };
}

/** Titles stay visible; everything else goes into one collapsed quote. */
function layout(parts: readonly { block: Block; html: string }[]): string {
  const titles = parts.filter((p) => p.block.kind === "title").map((p) => p.html);
  const rest = parts.filter((p) => p.block.kind !== "title").map((p) => p.html);
  return [...titles, rest.length ? folded(rest.join("\n\n")) : ""].filter(Boolean).join("\n");
}

const folded = (inner: string) => (inner ? `<blockquote expandable>${inner}</blockquote>` : "");

function render(block: Block, limit: number): { html: string; plain: string } {
  const text = clip(block.text.trim(), limit);
  switch (block.kind) {
    case "title":
      return { html: `<b>${linkifyEscaped(escapeHtml(text))}</b>`, plain: text };
    case "text":
      return { html: linkifyEscaped(escapeHtml(text)), plain: text };
    case "translation":
      return { html: `🌐 ${linkifyEscaped(escapeHtml(text))}`, plain: `🌐 ${text}` };
    case "quote":
      return { html: `↪️ <b>@${escapeHtml(block.handle)}</b>: ${linkifyEscaped(escapeHtml(text))}`, plain: `↪️ @${block.handle}: ${text}` };
    case "note":
      return { html: linkifyEscaped(escapeHtml(text)), plain: text };
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}
