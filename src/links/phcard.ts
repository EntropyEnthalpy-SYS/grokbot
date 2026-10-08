import { open } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../media/run.ts";
import { escapeAttr, escapeHtml } from "../telegram/format.ts";
import { composeCard, type Block } from "./compose.ts";
import type { PhDownload, PhFile } from "./parsehub.ts";
import type { XCard, XCardMedia } from "./xcard.ts";

/** Telegram upload limits for the hosted Bot API (a local Bot API server allows 2000 MB). */
export interface UploadLimits {
  photoBytes: number;
  videoBytes: number;
}
export const CLOUD_LIMITS: UploadLimits = { photoBytes: 10 * 1024 * 1024, videoBytes: 50 * 1024 * 1024 };

const MAX_ALBUM = 10;
/** Telegram re-processes big photos and sometimes fails ("IMAGE_PROCESS_FAILED"); keep them modest. */
const MAX_PHOTO_SIDE = 2560;

/**
 * Content card for a post parsed by ParseHub (Douyin, Weibo, Xiaohongshu, …):
 * the post's own media plus title, text and translation, without commentary.
 */
export function buildPostCard(download: PhDownload, url: string, media: XCardMedia[], notes: string[], translation?: string): XCard {
  const post = download.post;
  const platform = post.platform_name ?? post.platform ?? "Post";
  const header = {
    html: `📌 <b>${escapeHtml(platform)}</b> · <a href="${escapeAttr(url)}">原文 / source</a>`,
    plain: `📌 ${platform} · ${url}`,
  };
  const title = post.title.trim();
  const content = post.content.trim();
  const blocks: Block[] = [];
  if (title) blocks.push({ kind: "title", text: title });
  if (content && content !== title && !title.startsWith(content)) blocks.push({ kind: "text", text: content });
  if (translation?.trim()) blocks.push({ kind: "translation", text: translation });
  for (const note of notes) blocks.push({ kind: "note", text: note });
  return { ...composeCard(header, blocks), media };
}

/** The text worth translating: content, or the title when there is no content. */
export function postText(download: Pick<PhDownload, "post">): string {
  const { title, content } = download.post;
  return [title, content && content !== title ? content : ""].filter(Boolean).join("\n");
}

/**
 * Turn downloaded files into uploadable media: images re-encoded unless they
 * are genuine, modest JPEG/PNG; very tall images sliced; videos remuxed for
 * streaming with duration, size and a preview image; anything over Telegram's
 * limits dropped with a note; at most 10 items (one album).
 */
export async function prepareMedia(
  files: readonly PhFile[],
  limits: UploadLimits,
  options: { ffmpeg?: string; workDir: string },
): Promise<{ media: XCardMedia[]; notes: string[] }> {
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const media: XCardMedia[] = [];
  const notes: string[] = [];
  for (const [index, file] of files.entries()) {
    if (file.kind === "video" || file.kind === "gif") {
      if (file.size > limits.videoBytes) {
        notes.push(`▶️ Video too large to upload here (${Math.round(file.size / 1024 / 1024)} MB): open the source link.`);
        continue;
      }
      media.push(await prepareVideo(file, index, ffmpeg, options.workDir));
      continue;
    }
    if (file.kind !== "image" && file.kind !== "livephoto") continue;
    try {
      for (const path of await photoParts(file, index, ffmpeg, options.workDir)) media.push({ type: "photo", url: path, local: true });
    } catch (error) {
      console.warn(`image ${file.path} skipped: ${(error as Error).message}`);
    }
  }
  if (media.length > MAX_ALBUM) notes.push(`+${media.length - MAX_ALBUM} more in the original post.`);
  return { media: media.slice(0, MAX_ALBUM), notes };
}

/**
 * Without duration, size and a thumbnail, a video uploaded through a local Bot
 * API server shows as a black "00:00" box that must be fully downloaded before
 * playing. "faststart" moves the index to the front so it can stream.
 */
export async function prepareVideo(file: PhFile, index: number, ffmpeg: string, workDir: string): Promise<XCardMedia> {
  const out = join(workDir, `vid_${index}.mp4`);
  const thumb = join(workDir, `vid_${index}.jpg`);
  let path = file.path;
  try {
    await run(ffmpeg, ["-nostdin", "-loglevel", "error", "-y", "-i", file.path, "-c", "copy", "-movflags", "+faststart", out], { timeoutMs: 300_000 });
    path = out;
  } catch (error) {
    console.warn(`faststart remux failed, sending as is: ${(error as Error).message}`);
  }
  let thumbFile: string | undefined;
  try {
    const at = file.duration > 2 ? 1 : 0;
    await run(
      ffmpeg,
      ["-nostdin", "-loglevel", "error", "-y", "-ss", String(at), "-i", path, "-frames:v", "1", "-vf", "scale='min(320,iw)':-2,format=yuvj420p", "-q:v", "4", thumb],
      { timeoutMs: 60_000 },
    );
    thumbFile = thumb;
  } catch (error) {
    console.warn(`thumbnail failed: ${(error as Error).message}`);
  }
  return {
    type: "video",
    url: path,
    local: true,
    ...(file.width ? { width: file.width } : {}),
    ...(file.height ? { height: file.height } : {}),
    ...(file.duration ? { duration: file.duration } : {}),
    ...(thumbFile ? { thumbFile } : {}),
  };
}

/**
 * One file → one or more photos Telegram accepts. Real JPEG/PNG files within
 * size limits pass through; everything else (WebP/HEIC/AVIF, mislabelled
 * files, huge images) is re-encoded to JPEG. Images taller than 2.5× their
 * width are cut into slices of 2× width (min 1280 px) so they stay readable.
 */
export async function photoParts(file: PhFile, index: number, ffmpeg: string, workDir: string): Promise<string[]> {
  const { width, height } = file;
  const tall = width > 0 && height > 2.5 * width && height > 2000;
  if (!tall) {
    const ok =
      (await isJpegOrPng(file.path)) && file.size <= 5 * 1024 * 1024 && width > 0 && width <= MAX_PHOTO_SIDE && height <= MAX_PHOTO_SIDE;
    if (ok) return [file.path];
    const out = join(workDir, `img_${index}.jpg`);
    await run(
      ffmpeg,
      ["-nostdin", "-loglevel", "error", "-y", "-i", file.path, "-frames:v", "1", "-vf", `scale='min(${MAX_PHOTO_SIDE},iw)':-2,format=yuvj420p`, "-q:v", "3", out],
      { timeoutMs: 60_000 },
    );
    return [out];
  }
  const sliceHeight = Math.max(1280, width * 2);
  const parts: string[] = [];
  for (let top = 0, n = 0; top < height && n < MAX_ALBUM; top += sliceHeight, n++) {
    const h = Math.min(sliceHeight, height - top);
    const out = join(workDir, `img_${index}_${n}.jpg`);
    await run(
      ffmpeg,
      ["-nostdin", "-loglevel", "error", "-y", "-i", file.path, "-frames:v", "1", "-vf", `crop=iw:${h}:0:${top},scale='min(${MAX_PHOTO_SIDE},iw)':-2,format=yuvj420p`, "-q:v", "3", out],
      { timeoutMs: 60_000 },
    );
    parts.push(out);
  }
  return parts;
}

/** Check the file's first bytes, not its name: ParseHub may save WebP as ".jpg". */
export async function isJpegOrPng(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(8), 0, 8, 0);
    if (bytesRead < 4) return false;
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const png = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return jpeg || png;
  } finally {
    await handle.close();
  }
}

