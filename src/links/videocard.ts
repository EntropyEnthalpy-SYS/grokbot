import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { VideoReader } from "../media/video.ts";
import { markdownToTelegramHtml } from "../telegram/format.ts";
import type { CardCache } from "./cardCache.ts";
import { CAPTION_BUDGET } from "./compose.ts";
import { prepareVideo, type UploadLimits } from "./phcard.ts";
import { summarizeLink, type LinkSummaryDeps } from "./summarize.ts";
import { sendXCard, type CardApi, type XCard, type XCardMedia } from "./xcard.ts";

/** Videos up to this length are posted as video; longer ones get the text card only. */
export const MAX_POSTED_VIDEO_SECONDS = 20 * 60;

export interface VideoCardDeps {
  links: LinkSummaryDeps & { video: VideoReader };
  api: CardApi;
  limits: UploadLimits;
  cache?: CardCache;
  /** Where downloads go (deleted right after upload). */
  mediaDir: string;
}

type SendOptions = { reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean }; message_thread_id?: number };

/**
 * YouTube and other yt-dlp video links: the 🎬 content card (from subtitles or
 * speech) as the caption of the video itself, so the group can watch it in
 * Telegram. Re-posts come from the card cache instantly.
 */
export async function sendVideoLinkCard(
  deps: VideoCardDeps,
  chatId: number,
  url: string,
  lang: string,
  options: SendOptions,
): Promise<{ ids: number[]; plain: string }> {
  const hit = deps.cache?.get(url, lang);
  if (hit) {
    const sent = await sendXCard(deps.api, chatId, hit.card, options);
    return { ids: sent.ids, plain: hit.card.plain };
  }
  const text = await summarizeLink(deps.links, url, lang);
  const info = await deps.links.video.watchUrl(url, { preferLanguage: lang === "off" ? undefined : lang }).catch(() => undefined);
  const dir = join(deps.mediaDir, randomUUID());
  const media: XCardMedia[] = [];
  try {
    if ((info?.durationSec ?? 0) <= MAX_POSTED_VIDEO_SECONDS) {
      await mkdir(dir, { recursive: true });
      const file = await deps.links.video.downloadVideo(url, dir, deps.limits.videoBytes);
      if (file) media.push(await prepareVideo({ kind: "video", ...file }, 0, "ffmpeg", dir));
    }
    const card = cardFromMarkdown(text, media);
    const sent = await sendXCard(deps.api, chatId, card, options);
    if (sent.reusable) deps.cache?.put(url, lang, "video", sent.reusable);
    return { ids: sent.ids, plain: card.plain };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A Markdown 🎬 card as an XCard: whole card as caption when it fits, else the title line with the rest folded below. */
export function cardFromMarkdown(markdown: string, media: XCardMedia[]): XCard {
  const html = markdownToTelegramHtml(markdown);
  const [first = "", ...rest] = markdown.split("\n");
  const headerHtml = markdownToTelegramHtml(first);
  const fits = markdown.length <= CAPTION_BUDGET;
  return {
    html,
    plain: markdown,
    headerHtml,
    bodyHtml: markdownToTelegramHtml(rest.join("\n")),
    bodyPlain: rest.join("\n"),
    captionHtml: fits ? html : headerHtml,
    clipped: !fits,
    fullTextHtml: fits ? "" : `<blockquote expandable>${markdownToTelegramHtml(rest.join("\n").trim())}</blockquote>`,
    media,
  };
}
