import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Client for the local ParseHub helper (sidecar/parsehub_server.py), which
 * parses and downloads posts from Douyin, Weibo, Xiaohongshu, Kuaishou,
 * Bilibili, Instagram, Threads, Facebook, Tieba, Douban, Zhihu and more.
 */

export interface PhMediaRef {
  url: string;
  ext?: string;
  thumb_url?: string;
  width?: number;
  height?: number;
  duration?: number;
  video_url?: string;
}

export interface PhPost {
  platform: string | null;
  platform_name: string | null;
  type: string;
  title: string;
  content: string;
  raw_url: string;
  media: PhMediaRef[];
}

export type PhFileKind = "image" | "video" | "gif" | "livephoto" | "file";

export interface PhFile {
  kind: PhFileKind;
  path: string;
  size: number;
  width: number;
  height: number;
  /** Seconds (the library reports milliseconds for some files; normalized here). */
  duration: number;
}

export interface PhDownload {
  post: PhPost;
  dir: string;
  files: PhFile[];
}

/** Platforms our own code handles better (X: translation + media; YouTube: subtitles). */
const HANDLED_ELSEWHERE = new Set(["twitter", "youtube"]);

export class ParseHubClient {
  readonly #base: string;
  readonly #mediaRoot: string;
  readonly #fetch: typeof fetch;

  constructor(options: { baseUrl: string; mediaRoot?: string; fetchImpl?: typeof fetch }) {
    this.#base = options.baseUrl.replace(/\/$/, "");
    this.#mediaRoot = resolve(options.mediaRoot ?? "/var/lib/grokbot/media");
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** The parsed post, or undefined when ParseHub doesn't support the link (or we handle it ourselves). */
  async parse(url: string, signal?: AbortSignal): Promise<PhPost | undefined> {
    const body = (await this.#post("/parse", url, 60_000, signal)) as { supported: boolean; post?: PhPost };
    if (!body.supported || !body.post) return undefined;
    if (body.post.platform && HANDLED_ELSEWHERE.has(body.post.platform)) return undefined;
    return body.post;
  }

  /** Download the post's media into a fresh folder. Call `cleanup(result)` when done. */
  async download(url: string, signal?: AbortSignal): Promise<PhDownload> {
    const body = (await this.#post("/download", url, 10 * 60_000, signal)) as PhDownload;
    return { ...body, files: body.files.map(normalizeFile) };
  }

  /** Delete a download folder, only if it really is inside the media root. */
  async cleanup(download: Pick<PhDownload, "dir">): Promise<void> {
    const dir = resolve(download.dir);
    if (!dir.startsWith(this.#mediaRoot + sep)) return;
    await rm(dir, { recursive: true, force: true });
  }

  async #post(path: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(body.error ?? `ParseHub HTTP ${response.status}`);
    return body;
  }
}

export function normalizeFile(file: PhFile): PhFile {
  // A 3-hour cap in seconds; anything larger is milliseconds.
  const duration = file.duration > 3 * 60 * 60 ? Math.round(file.duration / 1000) : file.duration;
  return { ...file, duration };
}

/** Text of a post for Grok: platform, title, body. */
export function formatPhPost(post: PhPost, url: string): string {
  const lines = [`${post.platform_name ?? post.platform ?? "Post"} post: ${url}`];
  if (post.title) lines.push(`Title: ${post.title}`);
  if (post.content && post.content !== post.title) lines.push(post.content);
  const kinds = post.media.map((m) => (m.ext === "mp4" || m.video_url ? "video" : "image"));
  if (kinds.length) lines.push(`[${kinds.filter((k) => k === "image").length} image(s), ${kinds.filter((k) => k === "video").length} video(s)]`);
  return lines.join("\n");
}
