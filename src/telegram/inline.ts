import { InlineQueryResultBuilder } from "grammy";
import type { InlineQueryResult } from "grammy/types";
import type { CardCache } from "../links/cardCache.ts";
import { linkKind, normalizeUrl } from "../links/detect.ts";
import type { ParseHubClient } from "../links/parsehub.ts";
import { buildPostCard, postText } from "../links/phcard.ts";
import { CAPTION_LIMIT, needsTranslation, type XCard } from "../links/xcard.ts";

/**
 * Inline mode: "@bot <link>" in any chat offers the link's content card to
 * send there. Media comes from the card cache (Telegram file_ids) or, for X,
 * straight from X's CDN; other platforms offer a text card.
 */
export interface InlineDeps {
  cache: CardCache;
  parsehub?: ParseHubClient;
  buildXCard: (url: string, lang: string) => Promise<XCard>;
  translate: (text: string, lang: string) => Promise<string | undefined>;
}

const URL_IN_QUERY = /https?:\/\/\S+|\b[\w-]+(\.[\w-]+)+\/\S*/;

export function urlFromQuery(query: string): string | undefined {
  const match = query.match(URL_IN_QUERY)?.[0];
  return match ? normalizeUrl(match) : undefined;
}

export async function inlineResults(deps: InlineDeps, url: string, lang: string): Promise<InlineQueryResult[]> {
  const cached = deps.cache.get(url, lang);
  if (cached) return cardResults(cached.card, url, "cached");
  if (linkKind(url) === "x") return cardResults(await deps.buildXCard(url, lang), url, "x");
  const post = deps.parsehub ? await deps.parsehub.parse(url) : undefined;
  if (post) {
    const text = postText({ post });
    const translation = text && needsTranslation({ text, lang: undefined }, lang) ? await deps.translate(text, lang) : undefined;
    const card = buildPostCard({ post, dir: "", files: [] }, url, [], [], translation);
    const thumb = post.media.find((m) => m.thumb_url)?.thumb_url ?? post.media.find((m) => m.ext !== "mp4")?.url;
    return [article(card, url, thumb)];
  }
  return [];
}

/** First media item as a photo/video result with the card as caption, plus a text-only version. */
export function cardResults(card: XCard, url: string, origin: "cached" | "x"): InlineQueryResult[] {
  const caption = card.plain.length <= CAPTION_LIMIT ? card.html : card.headerHtml;
  const results: InlineQueryResult[] = [];
  const first = card.media[0];
  const id = (suffix: string) => `${hash(url)}-${suffix}`;
  if (first && !first.local) {
    if (origin === "cached") {
      results.push(
        first.type === "photo"
          ? InlineQueryResultBuilder.photoCached(id("p"), first.url, { caption, parse_mode: "HTML" })
          : InlineQueryResultBuilder.videoCached(id("v"), titleOf(card), first.url, { caption, parse_mode: "HTML" }),
      );
    } else if (first.type === "photo") {
      results.push(InlineQueryResultBuilder.photo(id("p"), first.url, { thumbnail_url: first.url, caption, parse_mode: "HTML" }));
    } else if (first.thumbnail) {
      results.push(
        InlineQueryResultBuilder.videoMp4(id("v"), titleOf(card), first.url, first.thumbnail, { caption, parse_mode: "HTML" }),
      );
    }
  }
  results.push(article(card, url, first?.type === "photo" && origin === "x" ? first.url : first?.thumbnail));
  return results;
}

function article(card: XCard, url: string, thumbnail?: string): InlineQueryResult {
  return InlineQueryResultBuilder.article(`${hash(url)}-t`, titleOf(card), {
    description: card.bodyPlain.slice(0, 120),
    ...(thumbnail ? { thumbnail_url: thumbnail } : {}),
  }).text(card.html.slice(0, 4000), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

function titleOf(card: XCard): string {
  const header = card.plain.split("\n")[0] ?? "Link";
  return header.slice(0, 100);
}

/** Short stable id (result ids are limited to 64 bytes). */
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
