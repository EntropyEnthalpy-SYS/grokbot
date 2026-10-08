import type { ImageContent } from "@earendil-works/pi-ai";

/**
 * Read an X (Twitter) post without logging in, through two public read-only
 * endpoints: fxtwitter's API (full long-post text, quotes) and X's own embed
 * CDN (the one Vercel's react-tweet uses). Both are unofficial and may change,
 * so callers fall back to Grok's x_search when this fails.
 */

export interface XVideo {
  /** Direct mp4 URL, when the source provides one. */
  url?: string;
  thumbnail: string;
}

export interface XPost {
  url: string;
  author: string;
  handle: string;
  verified?: boolean;
  createdAt?: string;
  /** Language X detected for the text, e.g. "en", "zh". */
  lang?: string;
  text: string;
  /** X's own translation (via fxtwitter) into the requested language; absent when not requested or not ready. */
  translation?: string;
  photos: string[];
  videos: XVideo[];
  /** Video thumbnails; derived from `videos`. */
  videoThumbnails: string[];
  quote?: XPost;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_HOSTS = new Set(["pbs.twimg.com"]);

export function xStatusId(url: string): string | undefined {
  return url.match(/\/status(?:es)?\/(\d{5,25})/)?.[1];
}

/** `translateTo` is a language code such as "zh-tw"; fxtwitter then includes X's translation when available. */
export async function fetchXPost(
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  translateTo?: string,
): Promise<XPost> {
  const id = xStatusId(url);
  if (!id) throw new Error("not an X post link");
  const errors: string[] = [];
  const sources = [
    (postId: string) => fromFxTwitter(postId, fetchImpl, signal, translateTo),
    (postId: string) => fromSyndication(postId, fetchImpl, signal),
  ];
  for (const source of sources) {
    try {
      return await source(id);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  throw new Error(`couldn't fetch the post (${errors.join("; ")})`);
}

async function getJson(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; grokbot)", Accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`);
  return response.json();
}

type Json = Record<string, any>;

async function fromFxTwitter(id: string, fetchImpl: typeof fetch, signal?: AbortSignal, translateTo?: string): Promise<XPost> {
  const suffix = translateTo && /^[a-z]{2}(-[a-z]{2,4})?$/i.test(translateTo) ? `/${translateTo}` : "";
  const body = (await getJson(`https://api.fxtwitter.com/status/${id}${suffix}`, fetchImpl, signal)) as Json;
  if (!body.tweet) throw new Error(`fxtwitter: ${body.message ?? "no post"}`);
  return parseFx(body.tweet);
}

export function parseFx(tweet: Json): XPost {
  const media = tweet.media ?? {};
  const videos: XVideo[] = (media.videos ?? [])
    .map((video: Json) => ({ url: video.url ? String(video.url) : undefined, thumbnail: String(video.thumbnail_url ?? "") }))
    .filter((video: XVideo) => video.thumbnail || video.url);
  const translation = String(tweet.translation?.text ?? "").trim();
  return {
    url: tweet.url ?? "",
    author: tweet.author?.name ?? "",
    handle: tweet.author?.screen_name ?? "",
    verified: Boolean(tweet.author?.verification?.verified ?? tweet.author?.verified),
    createdAt: tweet.created_at,
    lang: tweet.lang ?? undefined,
    text: stripMediaLink(String(tweet.raw_text?.text ?? tweet.text ?? "")),
    translation: translation ? stripMediaLink(translation) : undefined,
    photos: (media.photos ?? []).map((photo: Json) => String(photo.url)).filter(Boolean),
    videos,
    videoThumbnails: videos.map((video) => video.thumbnail).filter(Boolean),
    quote: tweet.quote ? parseFx(tweet.quote) : undefined,
  };
}

async function fromSyndication(id: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<XPost> {
  // Token scheme used by X's embed widget (and react-tweet).
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const body = (await getJson(
    `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`,
    fetchImpl,
    signal,
  )) as Json;
  if (!body.text && !body.id_str) throw new Error("syndication: no post");
  return parseSyndication(body);
}

export function parseSyndication(tweet: Json): XPost {
  const details: Json[] = tweet.mediaDetails ?? [];
  const videos: XVideo[] = details
    .filter((m) => m.type !== "photo")
    .map((m) => {
      const mp4 = ((m.video_info?.variants ?? []) as Json[])
        .filter((v) => v.content_type === "video/mp4")
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
      return { url: mp4?.url ? String(mp4.url) : undefined, thumbnail: String(m.media_url_https ?? "") };
    });
  return {
    url: `https://x.com/${tweet.user?.screen_name ?? "i"}/status/${tweet.id_str}`,
    author: tweet.user?.name ?? "",
    handle: tweet.user?.screen_name ?? "",
    verified: Boolean(tweet.user?.is_blue_verified ?? tweet.user?.verified),
    createdAt: tweet.created_at,
    lang: tweet.lang ?? undefined,
    text: stripMediaLink(String(tweet.text ?? "")),
    photos: details.filter((m) => m.type === "photo").map((m) => String(m.media_url_https)),
    videos,
    videoThumbnails: videos.map((video) => video.thumbnail).filter(Boolean),
    quote: tweet.quoted_tweet ? parseSyndication(tweet.quoted_tweet) : undefined,
  };
}

/** X appends a t.co link to the attached media at the end of the text; it's noise once the media is shown. */
export function stripMediaLink(text: string): string {
  return text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, "").trim();
}

/** The post as text for Grok (author, date, text, quoted post, media notes). */
export function formatXPost(post: XPost): string {
  const lines = [
    `X post by ${post.author} (@${post.handle})${post.createdAt ? `, ${post.createdAt}` : ""}:`,
    post.text || "(no text)",
  ];
  if (post.photos.length) lines.push(`[${post.photos.length} image(s) attached below]`);
  if (post.videoThumbnails.length) lines.push(`[${post.videoThumbnails.length} video(s); thumbnail attached below]`);
  if (post.quote) lines.push("", `Quoting @${post.quote.handle}:`, post.quote.text || "(no text)");
  return lines.join("\n");
}

/** Image URLs worth showing Grok, in order: post photos, quoted photos, video thumbnails. */
export function xPostImageUrls(post: XPost): string[] {
  return [...post.photos, ...(post.quote?.photos ?? []), ...post.videoThumbnails, ...(post.quote?.videoThumbnails ?? [])].slice(
    0,
    MAX_IMAGES,
  );
}

/** Download X media images (only from pbs.twimg.com), resized by X to a medium size. */
export async function downloadXImages(urls: readonly string[], fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const raw of urls.slice(0, MAX_IMAGES)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !IMAGE_HOSTS.has(url.hostname)) continue;
    url.searchParams.set("name", "medium");
    try {
      const timeout = AbortSignal.timeout(15_000);
      const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.startsWith("image/")) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) continue;
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: type.split(";")[0]! });
    } catch {
      // A missing image shouldn't stop the summary.
    }
  }
  return images;
}
