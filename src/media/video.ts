import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Db } from "../db.ts";
import type { Transcription } from "../grok/grok.ts";
import { linkKind } from "../links/detect.ts";
import { capText } from "../links/reader.ts";
import { run, Semaphore } from "./run.ts";
import { formatTimestamp, joinTimed, parseVtt, wordsToTimed } from "./transcript.ts";

/**
 * "Watch" a video: metadata, a transcript (subtitles when the video has them,
 * otherwise xAI speech-to-text on the audio), and a few frames. Uses yt-dlp for
 * YouTube/TikTok/Bilibili/Vimeo links and ffmpeg for files and direct mp4s.
 */

export interface VideoInfo {
  url: string;
  title?: string;
  uploader?: string;
  durationSec?: number;
  description?: string;
  transcript?: string;
  transcriptSource: "subtitles" | "speech" | "none";
  frames: ImageContent[];
}

export interface DownloadedVideo {
  path: string;
  size: number;
  width: number;
  height: number;
  duration: number;
}

export interface WatchOptions {
  /** Also extract frames (only for videos up to `maxFrameSeconds`). */
  frames?: boolean;
  /** Preferred subtitle language, e.g. "zh-tw"; the original language is used otherwise. */
  preferLanguage?: string;
  signal?: AbortSignal;
}

type Transcribe = (audio: Blob, filename: string, options: { signal?: AbortSignal }) => Promise<Transcription>;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FRAME_COUNT = 4;
export const DEFAULT_PROXY_SITES = /(^|[./])(bilibili\.com|b23\.tv|bilivideo\.com|bilivideo\.cn)(\/|:|$)/i;

/** Scale down and use full-range YUV, which the JPEG encoder requires for some streams. */
const JPEG_FILTER = "scale=640:-2,format=yuvj420p";
/** Grok reads 500k tokens; 40k chars covers about an hour of speech before start/end trimming. */
const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_DIRECT_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** Direct video files we fetch ourselves (only X's video CDN). */
const DIRECT_VIDEO_HOSTS = new Set(["video.twimg.com"]);

export class VideoReader {
  readonly #db: Db;
  readonly #transcribe: Transcribe;
  readonly #ytdlp: string;
  readonly #ffmpeg: string;
  readonly #ffprobe: string;
  readonly #maxSpeechSeconds: number;
  readonly #maxFrameSeconds: number;
  readonly #proxy: string | undefined;
  readonly #proxySites: RegExp;
  readonly #heavy = new Semaphore(2);

  constructor(options: {
    db: Db;
    transcribe: Transcribe;
    ytdlp?: string;
    ffmpeg?: string;
    ffprobe?: string;
    maxSpeechSeconds?: number;
    maxFrameSeconds?: number;
    /** e.g. "socks5://host:1080"; for sites that block the server's IP (Bilibili). */
    proxy?: string;
    /** Which links use the proxy (default: Bilibili only). */
    proxySites?: RegExp;
  }) {
    this.#db = options.db;
    this.#transcribe = options.transcribe;
    this.#ytdlp = options.ytdlp ?? "yt-dlp";
    this.#ffmpeg = options.ffmpeg ?? "ffmpeg";
    this.#ffprobe = options.ffprobe ?? "ffprobe";
    this.#maxSpeechSeconds = options.maxSpeechSeconds ?? 3 * 60 * 60;
    this.#maxFrameSeconds = options.maxFrameSeconds ?? 20 * 60;
    this.#proxy = options.proxy;
    this.#proxySites = options.proxySites ?? DEFAULT_PROXY_SITES;
  }

  static canWatch(url: string): boolean {
    return linkKind(url) === "video" || isDirectVideo(url);
  }

  async watchUrl(url: string, options: WatchOptions = {}): Promise<VideoInfo> {
    if (!VideoReader.canWatch(url)) throw new Error("not a supported video link");
    const cacheKey = `video:${url}#${options.preferLanguage ?? ""}`;
    const cached = this.#cached(cacheKey);
    if (cached && !options.frames) return cached;

    return this.#heavy.use(() =>
      withTempDir(async (dir) => {
        if (isDirectVideo(url)) {
          const file = join(dir, "video.mp4");
          await downloadFile(url, file, options.signal);
          const info = cached ?? { ...(await this.#fromFile(file, dir, { ...options, frames: false })), url };
          if (!cached) this.#store(cacheKey, info);
          return options.frames ? { ...info, frames: await this.#frames(file, dir, info.durationSec, options.signal) } : info;
        }
        const info = cached ?? (await this.#fromYtDlp(url, dir, options));
        if (!cached) this.#store(cacheKey, info);
        if (!options.frames) return info;
        // Any length: seek into the stream and grab single frames, no full download.
        const seeked = await this.#framesFromStream(url, dir, info.durationSec, options.signal);
        if (seeked.length > 0 || (info.durationSec ?? Infinity) > this.#maxFrameSeconds) return { ...info, frames: seeked };
        const video = await this.#ytDownload(url, dir, "video", "wv*[height<=360]/w[height<=360]/wv*/w", options.signal);
        return { ...info, frames: video ? await this.#frames(video, dir, info.durationSec, options.signal) : [] };
      }),
    );
  }

  /**
   * Download a video link as one H.264/AAC MP4 Telegram can play: best quality
   * up to 1080p on the short side (works for vertical Shorts), within `maxBytes`.
   */
  async downloadVideo(url: string, dir: string, maxBytes: number, signal?: AbortSignal): Promise<DownloadedVideo | undefined> {
    const maxMb = Math.max(1, Math.floor(maxBytes / 1024 / 1024));
    try {
      await run(
        this.#ytdlp,
        [
          ...this.#ytArgs(url), "--no-warnings", "--no-progress", "--no-playlist",
          "-f", "bv*[vcodec^=avc]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc]/bv*+ba/b",
          "-S", "res:1080", "--merge-output-format", "mp4", "--max-filesize", `${maxMb}M`,
          "-o", join(dir, "video.%(ext)s"), "--", url,
        ],
        { timeoutMs: 900_000, signal },
      );
    } catch (error) {
      console.warn(`video download failed for ${url}: ${(error as Error).message}`);
      return undefined;
    }
    const name = (await readdir(dir)).find((entry) => entry.startsWith("video.") && entry.endsWith(".mp4"));
    if (!name) return undefined; // skipped by --max-filesize
    const path = join(dir, name);
    return { path, size: (await stat(path)).size, ...(await this.probe(path, signal)) };
  }

  /** Width, height and duration (seconds) of a local video. */
  async probe(path: string, signal?: AbortSignal): Promise<{ width: number; height: number; duration: number }> {
    try {
      const { stdout } = await run(
        this.#ffprobe,
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
        { timeoutMs: 30_000, signal },
      );
      const info = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
      return { width: info.streams?.[0]?.width ?? 0, height: info.streams?.[0]?.height ?? 0, duration: Math.round(Number(info.format?.duration ?? 0)) };
    } catch {
      return { width: 0, height: 0, duration: 0 };
    }
  }

  /** A local file, e.g. a video or voice note uploaded to Telegram. */
  async watchFile(path: string, options: WatchOptions & { title?: string; uploader?: string } = {}): Promise<VideoInfo> {
    return this.#heavy.use(() =>
      withTempDir(async (dir) => ({ ...(await this.#fromFile(path, dir, options)), title: options.title, uploader: options.uploader })),
    );
  }

  async #fromYtDlp(url: string, dir: string, options: WatchOptions): Promise<VideoInfo> {
    const { stdout } = await run(this.#ytdlp, [...this.#ytArgs(url), "-J", "--no-warnings", "--no-playlist", "--", url], { timeoutMs: 60_000, signal: options.signal });
    const meta = JSON.parse(stdout) as YtInfo;
    if (meta.is_live) throw new Error("live streams can't be watched");
    const info: VideoInfo = {
      url,
      title: meta.title,
      uploader: meta.uploader ?? meta.channel,
      durationSec: meta.duration,
      description: meta.description ? capText(meta.description, 1500) : undefined,
      transcriptSource: "none",
      frames: [],
    };

    const track = chooseSubtitle(meta, options.preferLanguage);
    if (track) {
      try {
        await run(
          this.#ytdlp,
          [
            ...this.#ytArgs(url),
            "--skip-download", "--no-warnings", "--no-playlist",
            track.auto ? "--write-auto-subs" : "--write-subs",
            "--sub-langs", track.lang, "--sub-format", "vtt/best", "--convert-subs", "vtt",
            "-o", join(dir, "sub.%(ext)s"), "--", url,
          ],
          { timeoutMs: 90_000, signal: options.signal },
        );
        const vtt = (await readdir(dir)).find((name) => name.startsWith("sub.") && name.endsWith(".vtt"));
        const text = vtt ? joinTimed(parseVtt(await readFile(join(dir, vtt), "utf8"))) : "";
        if (text) return { ...info, transcript: capText(text, MAX_TRANSCRIPT_CHARS), transcriptSource: "subtitles" };
      } catch (error) {
        console.warn(`subtitles failed for ${url}: ${(error as Error).message}`);
      }
    }

    if ((info.durationSec ?? 0) > this.#maxSpeechSeconds) return info;
    const audio = await this.#ytDownload(url, dir, "audio", "ba[ext=m4a]/ba/wa/w", options.signal);
    if (!audio) return info;
    return { ...info, ...(await this.#speech(audio, dir, options.signal)) };
  }

  async #fromFile(path: string, dir: string, options: WatchOptions): Promise<VideoInfo> {
    const durationSec = await this.#duration(path, options.signal);
    let info: VideoInfo = { url: "", durationSec, transcriptSource: "none", frames: [] };
    if ((durationSec ?? 0) <= this.#maxSpeechSeconds) info = { ...info, ...(await this.#speech(path, dir, options.signal)) };
    if (options.frames && (durationSec ?? 0) <= this.#maxFrameSeconds) {
      info.frames = await this.#frames(path, dir, durationSec, options.signal);
    }
    return info;
  }

  /** Audio → small mono Opus → xAI speech-to-text. Videos without sound give no transcript. */
  async #speech(input: string, dir: string, signal?: AbortSignal): Promise<Pick<VideoInfo, "transcript" | "transcriptSource">> {
    const audio = join(dir, "speech.ogg");
    try {
      await run(this.#ffmpeg, ["-nostdin", "-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", audio], {
        timeoutMs: 180_000,
        signal,
      });
    } catch (error) {
      console.warn(`no audio track: ${(error as Error).message}`);
      return { transcriptSource: "none" };
    }
    const result = await this.#transcribe(new Blob([await readFile(audio)], { type: "audio/ogg" }), "speech.ogg", { signal });
    const text = result.words.length ? joinTimed(wordsToTimed(result.words)) : result.text;
    return text ? { transcript: capText(text, MAX_TRANSCRIPT_CHARS), transcriptSource: "speech" } : { transcriptSource: "none" };
  }

  async #frames(video: string, dir: string, durationSec: number | undefined, signal?: AbortSignal): Promise<ImageContent[]> {
    const fps = durationSec && durationSec > 0 ? `${FRAME_COUNT}/${Math.max(durationSec, FRAME_COUNT)}` : "1/5";
    try {
      await run(
        this.#ffmpeg,
        ["-nostdin", "-loglevel", "error", "-y", "-i", video, "-vf", `fps=${fps},${JPEG_FILTER}`, "-frames:v", String(FRAME_COUNT), "-q:v", "5", join(dir, "frame_%02d.jpg")],
        { timeoutMs: 120_000, signal },
      );
    } catch (error) {
      console.warn(`frames failed: ${(error as Error).message}`);
      return [];
    }
    const names = (await readdir(dir)).filter((name) => /^frame_\d+\.jpg$/.test(name)).sort();
    return Promise.all(
      names.map(async (name) => ({ type: "image" as const, data: (await readFile(join(dir, name))).toString("base64"), mimeType: "image/jpeg" })),
    );
  }

  /** Ask yt-dlp for the low-res stream URL and let ffmpeg seek to 4 evenly spaced points. */
  async #framesFromStream(url: string, dir: string, durationSec: number | undefined, signal?: AbortSignal): Promise<ImageContent[]> {
    if (!durationSec || durationSec <= 0) return [];
    // Plain HTTPS formats only: HLS segments need auth ffmpeg can't supply (YouTube answers 401).
    let stream: { url: string; headers: string } | undefined;
    try {
      const { stdout } = await run(
        this.#ytdlp,
        [
          ...this.#ytArgs(url), "-j", "--no-warnings", "--no-playlist",
          "-f", "bv*[height<=360][protocol=https]/wv*[protocol=https]/b[height<=480][protocol=https]/w[protocol=https]",
          "--", url,
        ],
        { timeoutMs: 60_000, signal },
      );
      stream = streamOf(JSON.parse(stdout));
    } catch (error) {
      console.warn(`no seekable stream for ${url}: ${(error as Error).message}`);
      return [];
    }
    if (!stream) return [];
    const frames: ImageContent[] = [];
    for (const [index, at] of frameTimes(durationSec, FRAME_COUNT).entries()) {
      const file = join(dir, `seek_${index}.jpg`);
      try {
        await run(
          this.#ffmpeg,
          [
            "-nostdin", "-loglevel", "error", "-y",
            ...(stream.headers ? ["-headers", stream.headers] : []),
            "-ss", at.toFixed(1), "-i", stream.url,
            "-frames:v", "1", "-vf", JPEG_FILTER, "-q:v", "5", file,
          ],
          { timeoutMs: 60_000, signal },
        );
        frames.push({ type: "image", data: (await readFile(file)).toString("base64"), mimeType: "image/jpeg" });
      } catch (error) {
        console.warn(`frame at ${at}s failed: ${(error as Error).message}`);
      }
    }
    return frames;
  }

  #ytArgs(url: string): string[] {
    return this.#proxy && this.#proxySites.test(url) ? ["--proxy", this.#proxy] : [];
  }

  async #duration(path: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
      const { stdout } = await run(this.#ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { timeoutMs: 30_000, signal });
      const value = Number(stdout.trim());
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async #ytDownload(url: string, dir: string, name: string, format: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      await run(
        this.#ytdlp,
        [...this.#ytArgs(url), "-f", format, "--no-warnings", "--no-progress", "--no-playlist", "--max-filesize", "300M", "-o", join(dir, `${name}.%(ext)s`), "--", url],
        { timeoutMs: 600_000, signal },
      );
    } catch (error) {
      console.warn(`yt-dlp ${name} download failed for ${url}: ${(error as Error).message}`);
      return undefined;
    }
    const file = (await readdir(dir)).find((entry) => entry.startsWith(`${name}.`) && !entry.endsWith(".part"));
    return file ? join(dir, file) : undefined;
  }

  #cached(key: string): VideoInfo | undefined {
    const row = this.#db.prepare("SELECT content, fetched_at FROM link_cache WHERE url = ?").get(key) as
      | { content: string | null; fetched_at: number }
      | undefined;
    if (!row?.content || Date.now() - row.fetched_at > CACHE_TTL_MS) return undefined;
    return { ...(JSON.parse(row.content) as VideoInfo), frames: [] };
  }

  #store(key: string, info: VideoInfo): void {
    this.#db
      .prepare(
        "INSERT INTO link_cache (url, content, source, fetched_at) VALUES (?, ?, 'video', ?) " +
          "ON CONFLICT(url) DO UPDATE SET content = excluded.content, fetched_at = excluded.fetched_at",
      )
      .run(key, JSON.stringify({ ...info, frames: [] }), Date.now());
  }
}

interface YtInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  description?: string;
  language?: string;
  is_live?: boolean;
  subtitles?: Record<string, unknown>;
  automatic_captions?: Record<string, unknown>;
}

/**
 * Pick one subtitle track, never a machine translation (YouTube rate-limits
 * those): human subtitles in the preferred language, then human subtitles in
 * the original language, then auto-captions in the original language.
 */
/** Direct URL and request headers of the format yt-dlp selected (merged formats list it first). */
export function streamOf(info: { url?: string; http_headers?: Record<string, string>; requested_formats?: { url?: string; http_headers?: Record<string, string> }[] }): { url: string; headers: string } | undefined {
  const format = info.requested_formats?.[0] ?? info;
  if (!format.url?.startsWith("https://")) return undefined;
  const headers = Object.entries(format.http_headers ?? {}).map(([key, value]) => `${key}: ${value}\r\n`).join("");
  return { url: format.url, headers };
}

/** `count` points spread through the video, avoiding the very first and last seconds. */
export function frameTimes(durationSec: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.max(0, (durationSec * (i + 0.5)) / count));
}

export function chooseSubtitle(meta: Pick<YtInfo, "language" | "subtitles" | "automatic_captions">, prefer?: string): { lang: string; auto: boolean } | undefined {
  const manual = Object.keys(meta.subtitles ?? {}).filter((key) => key !== "live_chat");
  const auto = Object.keys(meta.automatic_captions ?? {});
  const original = meta.language?.toLowerCase();
  const matches = (key: string, lang: string) => key.toLowerCase() === lang || key.toLowerCase().startsWith(`${lang}-`);
  const preferred = prefer ? preferredCodes(prefer) : [];
  for (const lang of preferred) {
    const hit = manual.find((key) => key.toLowerCase() === lang);
    if (hit) return { lang: hit, auto: false };
  }
  if (original) {
    const hit = manual.find((key) => matches(key, original));
    if (hit) return { lang: hit, auto: false };
    const orig = auto.find((key) => key.toLowerCase() === `${original}-orig`) ?? auto.find((key) => key.toLowerCase() === original);
    if (orig) return { lang: orig, auto: true };
  }
  const anyOrig = auto.find((key) => key.endsWith("-orig"));
  if (anyOrig) return { lang: anyOrig, auto: true };
  if (manual.length === 1) return { lang: manual[0]!, auto: false };
  return undefined;
}

function preferredCodes(prefer: string): string[] {
  const code = prefer.toLowerCase();
  if (code === "zh-tw") return ["zh-tw", "zh-hant", "zh-hk"];
  if (code === "zh-cn") return ["zh-cn", "zh-hans", "zh"];
  return [code];
}

/** Text for Grok: what the video is, then the transcript. */
export function formatVideo(info: VideoInfo): string {
  const lines = [`Video: ${info.title ?? "(no title)"}`];
  const meta = [info.uploader, info.durationSec ? formatTimestamp(info.durationSec) : undefined].filter(Boolean).join(" · ");
  if (meta) lines.push(meta);
  if (info.description) lines.push(`Description: ${info.description}`);
  if (info.transcript) {
    lines.push("", `Transcript (${info.transcriptSource === "subtitles" ? "from subtitles" : "speech recognition"}):`, info.transcript);
  } else {
    lines.push("", "No transcript: the video has no subtitles and no recognizable speech.");
  }
  if (info.frames.length) lines.push("", `[${info.frames.length} frames from the video attached, in order]`);
  return lines.join("\n");
}

function isDirectVideo(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && DIRECT_VIDEO_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

async function downloadFile(url: string, path: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(120_000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`video download HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DIRECT_DOWNLOAD_BYTES) throw new Error("video is too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DIRECT_DOWNLOAD_BYTES) throw new Error("video is too large");
  await writeFile(path, bytes);
}

async function withTempDir<T>(task: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "grokbot-video-"));
  try {
    return await task(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
