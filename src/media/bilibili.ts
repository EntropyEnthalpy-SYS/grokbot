import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "./run.ts";

/**
 * Bilibili blocks the main VPS's IP for its website and API (HTTP 412), and
 * its video CDN crawls (~130 KB/s) through the Taiwan tunnel. So: ask yt-dlp
 * for the stream URLs through the tunnel, then download the streams directly
 * from the fastest CDN host for this VPS (the original, or rewritten like
 * ParseHub does), and merge them with ffmpeg.
 */

/** CDN hosts tried besides the original; the one serving a sample fastest wins. */
export const BILIBILI_CDN_HOSTS = ["upos-sz-upcdnbda2.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"];

export interface BiliStream {
  url: string;
  headers: Record<string, string>;
}

export interface BiliVideo {
  path: string;
  size: number;
  width: number;
  height: number;
  duration: number;
}

export interface BiliOptions {
  ytdlp: string;
  ffmpeg?: string;
  proxy?: string;
  dir: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** H.264 so every Telegram client plays it; 1080p unless that would be huge. */
const FORMAT = "bv*[height<=1080][vcodec^=avc][filesize<?1500M]+ba/bv*[height<=720][vcodec^=avc]+ba/bv*[height<=720]+ba/b";

export async function downloadBilibili(url: string, options: BiliOptions): Promise<BiliVideo> {
  const proxyArgs = options.proxy ? ["--proxy", options.proxy] : [];
  const { stdout } = await run(options.ytdlp, [...proxyArgs, "-j", "--no-warnings", "--no-playlist", "-f", FORMAT, "--", url], {
    timeoutMs: 90_000,
    signal: options.signal,
  });
  const info = JSON.parse(stdout) as YtFormat & { requested_formats?: YtFormat[]; duration?: number };
  const formats = info.requested_formats ?? [info];
  const expected = formats.reduce((sum, f) => sum + (f.filesize ?? f.filesize_approx ?? 0), 0);
  if (expected > options.maxBytes) throw new Error(`video is ${Math.round(expected / 1048576)} MB, over the upload limit`);

  await mkdir(options.dir, { recursive: true });
  const parts: string[] = [];
  for (const [index, format] of formats.entries()) {
    const part = join(options.dir, `part${index}.${format.ext ?? "m4s"}`);
    await downloadStream({ url: format.url, headers: format.http_headers ?? {} }, part, options);
    parts.push(part);
  }
  const out = join(options.dir, "bilibili.mp4");
  await run(
    options.ffmpeg ?? "ffmpeg",
    ["-nostdin", "-loglevel", "error", "-y", ...parts.flatMap((p) => ["-i", p]), "-c", "copy", "-movflags", "+faststart", out],
    { timeoutMs: 300_000, signal: options.signal },
  );
  for (const part of parts) await rm(part, { force: true });
  const video = formats.find((f) => f.vcodec && f.vcodec !== "none") ?? formats[0]!;
  return { path: out, size: (await stat(out)).size, width: video.width ?? 0, height: video.height ?? 0, duration: Math.round(info.duration ?? 0) };
}

interface YtFormat {
  url: string;
  ext?: string;
  vcodec?: string;
  width?: number;
  height?: number;
  filesize?: number;
  filesize_approx?: number;
  http_headers?: Record<string, string>;
}

/** Candidate URLs: the original first only if it is already one of the good hosts, else the good hosts, then the original. */
export function candidateUrls(raw: string, hosts: readonly string[] = BILIBILI_CDN_HOSTS): string[] {
  const original = new URL(raw);
  const rewritten = hosts.map((host) => {
    const url = new URL(raw);
    url.hostname = host;
    return url.href;
  });
  return [...new Set(hosts.includes(original.hostname) ? [raw, ...rewritten] : [...rewritten, raw])];
}

/** Size of the sample each candidate host downloads; the fastest host gets the whole stream. */
const SAMPLE_BYTES = 1024 * 1024;

/**
 * Which host is fast changes (the original was ~30× faster than the rewritten
 * ones on Oct 27, the reverse on Oct 25), so time a sample from each at once.
 */
async function hostsBySpeed(stream: BiliStream, options: BiliOptions, errors: string[]): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timed = await Promise.all(
    candidateUrls(stream.url).map(async (url) => {
      const started = performance.now();
      try {
        const response = await fetchImpl(url, { headers: { ...stream.headers, Range: `bytes=0-${SAMPLE_BYTES - 1}` }, signal: timeout(options.signal, 15_000) });
        if (!response.ok) throw new Error(String(response.status));
        await response.arrayBuffer();
        return { url, ms: performance.now() - started };
      } catch (error) {
        errors.push(`${new URL(url).hostname}: ${(error as Error).message}`);
        return undefined;
      }
    }),
  );
  return timed.filter((t) => t !== undefined).sort((a, b) => a.ms - b.ms).map((t) => t.url);
}

async function downloadStream(stream: BiliStream, path: string, options: BiliOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const errors: string[] = [];
  for (const candidate of await hostsBySpeed(stream, options, errors)) {
    const response = await fetchImpl(candidate, { headers: stream.headers, signal: timeout(options.signal, 15 * 60_000) });
    if (!response.ok || !response.body) {
      errors.push(`${new URL(candidate).hostname}: ${response.status}`);
      continue;
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
    return;
  }
  throw new Error(`no Bilibili CDN host served the stream (${errors.join("; ")})`);
}

function timeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const own = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, own]) : own;
}
