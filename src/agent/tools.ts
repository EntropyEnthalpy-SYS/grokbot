import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { linkKind, normalizeUrl } from "../links/detect.ts";
import { untrusted, type LinkReader } from "../links/reader.ts";
import { formatPhPost, type ParseHubClient, type PhDownload } from "../links/parsehub.ts";
import { fetchXPost } from "../links/xpost.ts";
import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { formatVideo, VideoReader } from "../media/video.ts";

const UrlParams = Type.Object({
  url: Type.String({ description: "The http(s) URL" }),
});

type ToolResult = Awaited<ReturnType<AgentTool<typeof UrlParams, { source: string } | undefined>["execute"]>>;

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

export function readLinkTool(reader: LinkReader, parsehub?: ParseHubClient): AgentTool<typeof UrlParams, { source: string } | undefined> {
  return {
    name: "read_link",
    label: "Reading link",
    description:
      "Read a link and return its content. Use it whenever the user shares or asks about a link. " +
      "Works for web pages and X/Twitter posts (returns the post text and its images, e.g. charts). " +
      "For what a video says or shows, use watch_video. For broader X context such as replies, use x_search.",
    parameters: UrlParams,
    execute: async (_id, { url }, signal) => {
      const normalized = normalizeUrl(url);
      if (!normalized) return failure(`Not a readable http(s) link: ${url}`);
      try {
        if (linkKind(normalized) === "x") {
          const post = await reader.readX(normalized, signal);
          return { content: [{ type: "text", text: untrusted(normalized, post.text) }, ...post.images], details: { source: "x" } };
        }
        const social = parsehub ? await readWithParseHub(parsehub, normalized, signal) : undefined;
        if (social) return social;
        const page = await reader.read(normalized, signal);
        return { content: [{ type: "text", text: untrusted(page.url, page.text) }], details: { source: page.source } };
      } catch (error) {
        const hint = linkKind(normalized) === "x" ? " Try x_search for this post instead." : "";
        return failure(`${(error as Error).message}${hint}`);
      }
    },
  };
}

export function watchVideoTool(video: VideoReader, preferLanguage: () => string | undefined, parsehub?: ParseHubClient): AgentTool<typeof UrlParams, { source: string } | undefined> {
  return {
    name: "watch_video",
    label: "Watching video",
    description:
      "Watch a video and return its title, channel, length, a timestamped transcript (subtitles or speech recognition) and a few frames. " +
      "Works for YouTube, TikTok, Bilibili, Vimeo links and X posts that contain a video. Can take up to a minute for long videos.",
    parameters: UrlParams,
    execute: async (_id, { url }, signal) => {
      const normalized = normalizeUrl(url);
      if (!normalized) return failure(`Not a readable http(s) link: ${url}`);
      try {
        let target = normalized;
        let context = "";
        if (linkKind(normalized) === "x") {
          const post = await fetchXPost(normalized, fetch, signal);
          const mp4 = post.videos.find((v) => v.url)?.url ?? post.quote?.videos.find((v) => v.url)?.url;
          if (!mp4) return failure("This X post has no downloadable video. Use read_link for its text and images.");
          target = mp4;
          context = `From X post by @${post.handle}: ${post.text}\n\n`;
        } else if (!VideoReader.canWatch(normalized) || /douyin|kuaishou|weibo|xiaohongshu|xhslink|bilibili|b23\.tv|instagram|facebook|threads/i.test(normalized)) {
          const watched = parsehub ? await watchWithParseHub(parsehub, video, normalized, signal) : undefined;
          if (watched) return watched;
          if (!VideoReader.canWatch(normalized)) return failure("Not a supported video link. Use read_link for web pages.");
        }
        const info = await video.watchUrl(target, { frames: true, preferLanguage: preferLanguage(), signal });
        return {
          content: [{ type: "text", text: untrusted(normalized, context + formatVideo(info)) }, ...info.frames],
          details: { source: info.transcriptSource },
        };
      } catch (error) {
        return failure(`Couldn't watch the video: ${(error as Error).message}`);
      }
    },
  };
}

const MAX_TOOL_IMAGES = 4;

/** Social posts (Douyin, Weibo, Xiaohongshu, …): text plus up to 4 images. Undefined if ParseHub doesn't handle the link. */
async function readWithParseHub(parsehub: ParseHubClient, url: string, signal?: AbortSignal): Promise<ToolResult | undefined> {
  const post = await parsehub.parse(url, signal);
  if (!post) return undefined;
  const images: ImageContent[] = [];
  const hasImages = post.media.some((m) => m.ext !== "mp4" && !m.video_url);
  if (hasImages) {
    let download: PhDownload | undefined;
    try {
      download = await parsehub.download(url, signal);
      for (const file of download.files.filter((f) => f.kind === "image" || f.kind === "livephoto").slice(0, MAX_TOOL_IMAGES)) {
        if (file.size > 5 * 1024 * 1024 || !/\.(jpe?g|png|webp)$/i.test(file.path)) continue;
        const ext = file.path.split(".").pop()!.toLowerCase();
        images.push({ type: "image", data: (await readFile(file.path)).toString("base64"), mimeType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg" });
      }
    } catch (error) {
      console.warn(`ParseHub images failed for ${url}: ${(error as Error).message}`);
    } finally {
      if (download) await parsehub.cleanup(download);
    }
  }
  const note = post.media.some((m) => m.ext === "mp4") ? "\n(This post has a video: use watch_video to hear what is said.)" : "";
  return { content: [{ type: "text", text: untrusted(url, formatPhPost(post, url) + note) }, ...images], details: { source: post.platform ?? "parsehub" } };
}

/** Download a social video through ParseHub and watch the file (speech + frames). */
async function watchWithParseHub(parsehub: ParseHubClient, video: VideoReader, url: string, signal?: AbortSignal): Promise<ToolResult | undefined> {
  const post = await parsehub.parse(url, signal);
  if (!post) return undefined;
  const download = await parsehub.download(url, signal);
  try {
    const file = download.files.find((f) => f.kind === "video" || f.kind === "gif");
    if (!file) return failure("This post has no video. Use read_link for its text and images.");
    const info = await video.watchFile(file.path, { frames: true, title: post.title || post.content.slice(0, 80), uploader: post.platform_name ?? undefined, signal });
    return { content: [{ type: "text", text: untrusted(url, formatVideo(info)) }, ...info.frames], details: { source: info.transcriptSource } };
  } finally {
    await parsehub.cleanup(download);
  }
}
