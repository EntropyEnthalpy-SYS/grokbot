import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { VideoMetadata, VideoReader } from "../media/video.ts";
import { escapeAttr, escapeHtml } from "../telegram/format.ts";
import type { CardCache } from "./cardCache.ts";
import { CAPTION_BUDGET } from "./compose.ts";
import { prepareVideo, type UploadLimits } from "./phcard.ts";
import { sendXCard, type CardApi, type XCard, type XCardMedia } from "./xcard.ts";

/** Videos up to this length are posted as video; longer ones get their thumbnail. */
export const MAX_POSTED_VIDEO_SECONDS = 20 * 60;
/** Description characters shown on the card (the rest is on the video's page). */
const DESCRIPTION_CHARS = 400;
const DESCRIPTION_LINES = 6;
/** Cache key "language": plain cards are the same in every group. */
const PLAIN = "plain";

export interface VideoCardDeps {
  video: VideoReader;
  api: CardApi;
  limits: UploadLimits;
  cache?: CardCache;
  /** Where downloads go (deleted right after upload). */
  mediaDir: string;
}

type SendOptions = { reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean }; message_thread_id?: number };

/**
 * YouTube and other yt-dlp video links, like a parse bot: the video itself with its title,
 * channel, length and the start of its description. No AI: a summary is added only when
 * someone taps 📝 Summary (or asks). Metadata and download run at the same time; re-posts come
 * from the card cache instantly.
 */
export async function sendPlainVideoCard(deps: VideoCardDeps, chatId: number, url: string, options: SendOptions): Promise<{ ids: number[]; plain: string }> {
  const hit = deps.cache?.get(url, PLAIN);
  if (hit) {
    const sent = await sendXCard(deps.api, chatId, hit.card, options);
    return { ids: sent.ids, plain: hit.card.plain };
  }
  const dir = join(deps.mediaDir, randomUUID());
  await mkdir(dir, { recursive: true });

  // The download starts at once, next to the metadata lookup; it is cancelled for live streams and long videos.
  const stop = new AbortController();
  const download = deps.video.downloadVideo(url, dir, deps.limits.videoBytes, stop.signal);
  try {
    const meta = await deps.video.metadata(url).catch((error: unknown) => {
      stop.abort();
      throw error;
    });
    if (meta.isLive) throw new Error("live streams get no card");
    if ((meta.durationSec ?? 0) > MAX_POSTED_VIDEO_SECONDS) stop.abort();
    const file = await download;
    const media: XCardMedia[] = [];
    if (file) media.push({ ...(await prepareVideo({ kind: "video", ...file }, 0, "ffmpeg", dir)), ...(meta.thumbnail ? { thumbnail: meta.thumbnail } : {}) });
    else if (meta.thumbnail) media.push({ type: "photo", url: meta.thumbnail });
    const card = plainVideoCard(url, meta, media);
    const sent = await sendXCard(deps.api, chatId, card, options);
    if (sent.reusable) deps.cache?.put(url, PLAIN, "video", sent.reusable);
    return { ids: sent.ids, plain: card.plain };
  } finally {
    stop.abort();
    await download.catch(() => undefined); // yt-dlp has stopped writing before the folder goes
    await rm(dir, { recursive: true, force: true });
  }
}

/** "🎬 Title" (linked to the video), "Channel · 3:21", and the start of the description, within one caption. */
export function plainVideoCard(url: string, meta: Pick<VideoMetadata, "title" | "uploader" | "durationSec" | "description">, media: XCardMedia[]): XCard {
  // "Beautiful Girls #shorts #model": the hashtag tail goes, unless the title is only hashtags.
  const raw = (meta.title ?? "").trim();
  const onlyHashtags = /^(#[^\s#]+\s*)+$/u.test(raw);
  const title = ((onlyHashtags ? raw : raw.replace(/(\s+#[^\s#]+)+$/u, "")) || "Video").slice(0, 200);
  const info = [meta.uploader, meta.durationSec ? formatDuration(meta.durationSec) : undefined].filter(Boolean).join(" · ");
  const headerPlain = `🎬 ${title}`;
  const headerHtml = `🎬 <a href="${escapeAttr(url)}"><b>${escapeHtml(title)}</b></a>`;
  const room = CAPTION_BUDGET - headerPlain.length - info.length - 4;
  const description = shortDescription(meta.description ?? "", Math.min(DESCRIPTION_CHARS, Math.max(0, room)));
  const bodyPlain = [info, description].filter(Boolean).join("\n\n");
  const bodyHtml = [info && escapeHtml(info), description && `<blockquote expandable>${escapeHtml(description)}</blockquote>`].filter(Boolean).join("\n");
  const html = bodyHtml ? `${headerHtml}\n${bodyHtml}` : headerHtml;
  const plain = bodyPlain ? `${headerPlain}\n${bodyPlain}` : headerPlain;
  return { html, plain, headerHtml, bodyHtml, bodyPlain, captionHtml: html, clipped: false, fullTextHtml: "", media };
}

/** The first lines of a description: links and hashtag walls removed, at most `max` characters. */
export function shortDescription(text: string, max: number): string {
  const lines = text
    .replace(/https?:\/\/\S+/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(#\S+\s*)+$/.test(line))
    .slice(0, DESCRIPTION_LINES);
  const joined = lines.join("\n");
  return joined.length <= max ? joined : `${joined.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
