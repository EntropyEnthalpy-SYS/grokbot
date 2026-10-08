import { timeZone } from "../time.ts";
import { InputFile } from "grammy";
import { escapeAttr, escapeHtml } from "../telegram/format.ts";
import type { XPost } from "./xpost.ts";
import { composeCard, type Block, type Composed } from "./compose.ts";

/**
 * A faithful, comment-free rendering of an X post for a Telegram group: the
 * post's own photos/video with a caption holding author, time, original text,
 * a translation, and any quoted post. Grok is not involved except to fill in
 * a missing translation.
 */

/** Telegram's caption limit (characters after entity parsing). */
export const CAPTION_LIMIT = 1024;
const MESSAGE_TEXT_LIMIT = 3500;
const MAX_MEDIA = 4;

export interface XCardMedia {
  type: "photo" | "video";
  /** Remote URL Telegram fetches itself, or a local file path when `local` is set. */
  url: string;
  /** Upload `url` as a local file (media downloaded on the server, e.g. by ParseHub). */
  local?: boolean;
  /** For videos: a photo URL to send instead if Telegram can't fetch the video. */
  thumbnail?: string;
  /** For local videos: what the Bot API needs to show a playable, streamable video. */
  width?: number;
  height?: number;
  duration?: number;
  /** Local JPEG used as the video's preview image. */
  thumbFile?: string;
}

/** A card: full text (`html`/`plain`), a caption that fits media (`captionHtml`), and the media. */
export interface XCard extends Composed {
  media: XCardMedia[];
}

/** Whether the post text should be translated into `target` ("off" disables). */
export function needsTranslation(post: Pick<XPost, "text" | "lang">, target: string): boolean {
  if (target === "off" || !post.text.trim()) return false;
  const targetBase = target.toLowerCase().split("-")[0]!;
  const source = (post.lang ?? "").toLowerCase().split("-")[0]!;
  // X's codes for "no linguistic content" (links, emoji, hashtags only).
  if (["zxx", "und", "qme", "qam", "qht", "qct", "qst"].includes(source)) return false;
  if (source) return source !== targetBase;
  // Unknown language: guess from the script.
  const hasCjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(post.text);
  return targetBase === "zh" || targetBase === "ja" || targetBase === "ko" ? !hasCjk : hasCjk;
}

export function buildXCard(post: XPost, translation?: string): XCard {
  const when = post.createdAt ? formatPostTime(post.createdAt) : "";
  const headerPlain = `𝕏 ${post.author}${post.verified ? " ☑️" : ""} @${post.handle}${when ? ` · ${when}` : ""}`;
  const headerHtml =
    `𝕏 <b>${escapeHtml(post.author)}</b>${post.verified ? " ☑️" : ""} ` +
    `<a href="${escapeAttr(post.url)}">@${escapeHtml(post.handle)}</a>${when ? ` · ${when}` : ""}`;

  const blocks: Block[] = [{ kind: "text", text: post.text }];
  if (translation?.trim()) blocks.push({ kind: "translation", text: translation });
  if (post.quote) blocks.push({ kind: "quote", handle: post.quote.handle, text: post.quote.text || "(no text)" });
  if (post.videos.some((video) => !video.url)) blocks.push({ kind: "note", text: "▶️ Video in post" });
  return { ...composeCard({ html: headerHtml, plain: headerPlain }, blocks), media: pickMedia(post) };
}

/** The post's own media first; a quoted post's media only when the post has none. */
export function pickMedia(post: XPost): XCardMedia[] {
  const own = mediaOf(post);
  return (own.length > 0 ? own : post.quote ? mediaOf(post.quote) : []).slice(0, MAX_MEDIA);
}

function mediaOf(post: XPost): XCardMedia[] {
  const photos = post.photos.map((url): XCardMedia => ({ type: "photo", url: largePhoto(url) }));
  const videos = post.videos.map((video): XCardMedia =>
    video.url ? { type: "video", url: video.url, thumbnail: video.thumbnail || undefined } : { type: "photo", url: largePhoto(video.thumbnail) },
  );
  return [...photos, ...videos].filter((media) => media.url);
}

function largePhoto(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.hostname === "pbs.twimg.com") url.searchParams.set("name", "large");
    return url.href;
  } catch {
    return raw;
  }
}



/** "Thu Oct 08 08:06:00 +0000 2026" → "10/08 16:06" in local time (TIMEZONE). */
export function formatPostTime(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date
    .toLocaleString("en-US", { timeZone: timeZone(), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .replace(",", "");
}

interface SendOptions {
  reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
  message_thread_id?: number;
}
type MediaSource = string | InputFile;
type MediaInput = {
  type: "photo" | "video";
  media: MediaSource;
  caption?: string;
  parse_mode?: "HTML";
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: InputFile;
  supports_streaming?: boolean;
};
type VideoExtra = { width?: number; height?: number; duration?: number; thumbnail?: InputFile; supports_streaming?: boolean };

/** The Bot API calls needed to post a card; grammY's `bot.api` satisfies this. */
/** The parts of a sent message we read; grammY's Message satisfies it. */
export interface SentMessage {
  message_id: number;
  photo?: { file_id: string }[];
  video?: { file_id: string };
}

export interface CardApi {
  sendMessage(chatId: number, text: string, other?: SendOptions & { parse_mode?: "HTML"; link_preview_options?: { is_disabled?: boolean } }): Promise<SentMessage>;
  sendPhoto(chatId: number, photo: MediaSource, other?: SendOptions & { caption?: string; parse_mode?: "HTML" }): Promise<SentMessage>;
  sendVideo(chatId: number, video: MediaSource, other?: SendOptions & VideoExtra & { caption?: string; parse_mode?: "HTML" }): Promise<SentMessage>;
  sendMediaGroup(chatId: number, media: MediaInput[], other?: SendOptions): Promise<SentMessage[]>;
}

export interface SentCard {
  /** Every message sent, media first. */
  ids: number[];
  /** The same card pointing at Telegram's stored files, for instant re-sending; absent if media fell back. */
  reusable?: XCard;
}

/**
 * Post the card as a reply. Tries the real media; if Telegram can't fetch a
 * video (too big, blocked), retries with thumbnails; if media fails entirely,
 * sends text only.
 */
export async function sendXCard(api: CardApi, chatId: number, card: XCard, options: SendOptions): Promise<SentCard> {
  const fitsCaption = card.plain.length <= CAPTION_LIMIT;
  const caption = fitsCaption ? card.html : card.captionHtml;
  const attempts = [card.media, card.media.map((m) => (m.type === "video" && m.thumbnail ? { type: "photo" as const, url: m.thumbnail } : m))];
  let ids: number[] | undefined;
  let reusable: XCard | undefined = card.media.length === 0 ? { ...card, media: [] } : undefined;
  for (const [attempt, media] of attempts.entries()) {
    if (media.length === 0) break;
    try {
      const { sent, used } = await sendMediaDroppingRejected(api, chatId, media, caption, options);
      ids = sent.map((message) => message.message_id);
      const fileIds = sent.map((message) => message.video?.file_id ?? message.photo?.at(-1)?.file_id);
      if (attempt === 0 && fileIds.every(Boolean)) {
        reusable = {
          ...card,
          media: used.map((m, i) => ({
            type: m.type,
            url: fileIds[i]!,
            ...(m.width ? { width: m.width } : {}),
            ...(m.height ? { height: m.height } : {}),
            ...(m.duration ? { duration: m.duration } : {}),
          })),
        };
      }
      break;
    } catch (error) {
      console.warn(`card media failed: ${(error as Error).message}`);
    }
  }
  // Caption had to be shortened: the full text follows, folded. No media at all: the whole card as text.
  const followUp = ids && !fitsCaption && card.clipped && card.fullTextHtml ? { html: card.fullTextHtml, plain: card.bodyPlain } : undefined;
  const textOnly = !ids ? { html: card.html, plain: card.plain } : undefined;
  const text = followUp ?? textOnly;
  if (text) {
    const replyTo = ids ? { message_id: ids[0]!, allow_sending_without_reply: true } : options.reply_parameters;
    const common = { ...options, reply_parameters: replyTo, link_preview_options: { is_disabled: true } };
    let sent: { message_id: number };
    try {
      sent = await api.sendMessage(chatId, text.html, { ...common, parse_mode: "HTML" });
    } catch (error) {
      console.warn(`card text failed as HTML, sending plain: ${(error as Error).message}`);
      sent = await api.sendMessage(chatId, text.plain.slice(0, MESSAGE_TEXT_LIMIT), common);
    }
    ids = [...(ids ?? []), sent.message_id];
  }
  return { ids: ids!, reusable };
}

/**
 * Telegram rejects a whole album when one item is bad ("failed to send message
 * #7 … IMAGE_PROCESS_FAILED"). Drop that item and try again, a few times.
 */
async function sendMediaDroppingRejected(
  api: CardApi,
  chatId: number,
  media: XCardMedia[],
  caption: string,
  options: SendOptions,
): Promise<{ sent: SentMessage[]; used: XCardMedia[] }> {
  let items = media;
  for (let round = 0; ; round++) {
    try {
      return { sent: await sendMedia(api, chatId, items, caption, options), used: items };
    } catch (error) {
      const bad = Number(String((error as Error).message).match(/message #(\d+)/)?.[1]);
      if (round >= 3 || !bad || bad > items.length || items.length === 1) throw error;
      console.warn(`dropping album item #${bad}: ${(error as Error).message.slice(0, 120)}`);
      items = items.filter((_, index) => index !== bad - 1);
    }
  }
}

async function sendMedia(api: CardApi, chatId: number, media: XCardMedia[], caption: string, options: SendOptions): Promise<SentMessage[]> {
  if (media.length === 1) {
    const only = media[0]!;
    const sent =
      only.type === "video"
        ? await api.sendVideo(chatId, source(only), { ...options, ...videoExtra(only), caption, parse_mode: "HTML" })
        : await api.sendPhoto(chatId, source(only), { ...options, caption, parse_mode: "HTML" });
    return [sent];
  }
  const items: MediaInput[] = media.map((m, index) => ({
    type: m.type,
    media: source(m),
    ...(m.type === "video" ? videoExtra(m) : {}),
    ...(index === 0 ? { caption, parse_mode: "HTML" as const } : {}),
  }));
  return api.sendMediaGroup(chatId, items, options);
}

function videoExtra(media: XCardMedia): VideoExtra {
  return {
    supports_streaming: true,
    ...(media.width ? { width: media.width } : {}),
    ...(media.height ? { height: media.height } : {}),
    ...(media.duration ? { duration: Math.round(media.duration) } : {}),
    ...(media.local && media.thumbFile ? { thumbnail: new InputFile(media.thumbFile) } : {}),
  };
}

function source(media: XCardMedia): MediaSource {
  return media.local ? new InputFile(media.url) : media.url;
}
