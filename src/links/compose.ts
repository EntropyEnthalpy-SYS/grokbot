import { escapeHtml, linkifyEscaped } from "../telegram/format.ts";

/**
 * Card layout shared by X posts and ParseHub posts:
 *  - `captionHtml` fits Telegram's 1024-character media caption: long text is
 *    clipped and folded into an expandable quote (tap to open), like
 *    parse_hub_bot does.
 *  - `fullTextHtml` holds the untrimmed text and translation (each still in an
 *    expandable quote), sent as a reply only when the caption had to clip.
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
  /** Some text was shortened in the caption; `fullTextHtml` has all of it. */
  clipped: boolean;
  fullTextHtml: string;
}

export const CAPTION_BUDGET = 1000;
/** Per-block cap for the full version so text + translation fit one 4096-character message. */
const FULL_BLOCK = 1800;
/** Longer blocks are folded into an expandable quote. */
const FOLD_OVER = 280;

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
  const compact = nonEmpty.map((block) => render(block, limits.get(block)!));
  const clipped = nonEmpty.some((block) => block.text.trim().length > limits.get(block)!);

  const fullText = nonEmpty
    .filter((b) => b.kind === "text" || b.kind === "translation" || b.kind === "quote")
    .map((block) => render(block, FULL_BLOCK, true));

  const bodyHtml = full.map((r) => r.html).join("\n\n");
  const bodyPlain = full.map((r) => r.plain).join("\n\n");
  return {
    headerHtml: header.html,
    bodyHtml,
    bodyPlain,
    html: [header.html, bodyHtml].filter(Boolean).join("\n\n"),
    plain: [header.plain, bodyPlain].filter(Boolean).join("\n\n"),
    captionHtml: [header.html, ...compact.map((r) => r.html)].join("\n\n"),
    clipped,
    fullTextHtml: fullText.map((r) => r.html).join("\n\n"),
  };
}

function render(block: Block, limit: number, alwaysFold = false): { html: string; plain: string } {
  const text = clip(block.text.trim(), limit);
  const folded = (inner: string) => (alwaysFold || text.length > FOLD_OVER ? `<blockquote expandable>${inner}</blockquote>` : inner);
  switch (block.kind) {
    case "title":
      return { html: `<b>${linkifyEscaped(escapeHtml(text))}</b>`, plain: text };
    case "text":
      return { html: folded(linkifyEscaped(escapeHtml(text))), plain: text };
    case "translation":
      return { html: `🌐 ${folded(linkifyEscaped(escapeHtml(text)))}`, plain: `🌐 ${text}` };
    case "quote":
      return { html: `↪️ <b>@${escapeHtml(block.handle)}</b>: ${linkifyEscaped(escapeHtml(text))}`, plain: `↪️ @${block.handle}: ${text}` };
    case "note":
      return { html: linkifyEscaped(escapeHtml(text)), plain: text };
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}
