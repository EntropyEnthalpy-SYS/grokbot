import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardCache } from "./cardCache.ts";
import { needsTranslation, sendXCard, type CardApi, type XCard } from "./xcard.ts";
import { buildPostCard, postText, prepareMedia, type UploadLimits } from "./phcard.ts";
import type { ParseHubClient, PhDownload, PhPost } from "./parsehub.ts";

export interface PostCardDeps {
  parsehub: ParseHubClient;
  api: CardApi;
  limits: UploadLimits;
  translate: (text: string, lang: string) => Promise<string | undefined>;
  cache?: CardCache;
  /** Per-group platform switch (e.g. "douyin" turned off); default all allowed. */
  allowed?: (platform: string) => boolean;
  /** Platform-specific downloaders that replace ParseHub's (e.g. Bilibili through the CDN). */
  downloaders?: Partial<Record<string, (url: string, post: PhPost) => Promise<PhDownload>>>;
}

type SendOptions = { reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean }; message_thread_id?: number };

export type PostCardResult =
  | { status: "sent"; ids: number[]; plain: string; platform: string; cached: boolean }
  | { status: "disabled"; platform: string }
  | { status: "unsupported" };

/**
 * Post the content of a ParseHub-supported link (media + text + translation).
 * "unsupported" lets the caller fall back to a web or video card.
 */
export async function sendPostCard(deps: PostCardDeps, chatId: number, url: string, lang: string, options: SendOptions): Promise<PostCardResult> {
  const hit = deps.cache?.get(url, lang);
  if (hit) {
    if (deps.allowed && !deps.allowed(hit.platform)) return { status: "disabled", platform: hit.platform };
    try {
      const sent = await sendXCard(deps.api, chatId, hit.card, options);
      return { status: "sent", ids: sent.ids, plain: hit.card.plain, platform: hit.platform, cached: true };
    } catch (error) {
      console.warn(`cached card failed for ${url}, rebuilding: ${(error as Error).message}`);
      deps.cache?.forget(url, lang);
    }
  }

  const post = await deps.parsehub.parse(url);
  if (!post) return { status: "unsupported" };
  const platform = post.platform ?? "unknown";
  if (deps.allowed && !deps.allowed(platform)) return { status: "disabled", platform };

  let download: PhDownload = { post, dir: "", files: [] };
  try {
    const own = deps.downloaders?.[platform];
    download = own ? await own(url, post) : await deps.parsehub.download(url);
  } catch (error) {
    console.warn(`ParseHub download failed for ${url}, sending text only: ${(error as Error).message}`);
  }
  const work = await mkdtemp(join(tmpdir(), "grokbot-card-"));
  try {
    const { media, notes } = await prepareMedia(download.files, deps.limits, { workDir: work });
    const text = postText(download);
    const translation = text && needsTranslation({ text, lang: undefined }, lang) ? await deps.translate(text, lang) : undefined;
    const card: XCard = buildPostCard(download, url, media, notes, translation);
    const sent = await sendXCard(deps.api, chatId, card, options);
    if (sent.reusable) deps.cache?.put(url, lang, platform, sent.reusable);
    return { status: "sent", ids: sent.ids, plain: card.plain, platform, cached: false };
  } finally {
    await rm(work, { recursive: true, force: true });
    if (download.dir) await deps.parsehub.cleanup(download);
  }
}
