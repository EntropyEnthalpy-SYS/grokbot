import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { XPost } from "./xpost.ts";

/**
 * An X post drawn like the post itself (avatar, name, ✓, text, translation, quoted post, time) as a
 * PNG, for groups that prefer pictures to text cards. Rendered in-process: satori lays out the card
 * as SVG, resvg turns it into pixels. No browser. Needs the Noto Sans CJK fonts in `fontDir`
 * (deploy.sh installs them); without them `renderXPicture` reports that pictures are unavailable.
 */

/** Card width in CSS pixels; the PNG is twice as wide for sharp text on phones. */
const WIDTH = 560;
/** Card plus its grey frame. */
const OUTER = WIDTH + 36;
const SCALE = 2;
/** Text drawn in the picture; longer posts end with "…" (the full text is in the caption). */
const MAX_TEXT = 1200;
const MAX_QUOTE = 280;

/**
 * The picture's shape (width ÷ height), chosen so Telegram's album shows it large next to the post's media:
 * a wide photo/video gets a picture of the same shape (the album stacks them, each full width); square or
 * tall media get a 4:3 picture (placed first, it takes most of the width). Undefined without media.
 */
export function pictureRatio(post: XPost): number | undefined {
  const count = (p: XPost) => p.photos.length + p.videos.length;
  const source = count(post) > 0 ? post : post.quote && count(post.quote) > 0 ? post.quote : undefined;
  if (!source) return undefined;
  const size = source.mediaSize;
  const ratio = size ? size.width / size.height : 16 / 9;
  return ratio > 1.2 ? Math.min(ratio, 2.2) : 4 / 3;
}
/** Latin first (proportional punctuation: "Starship's", not a wide CJK apostrophe), then Chinese. */
export const FONT_FILES = [
  { file: "NotoSans-Regular.ttf", name: "Noto Latin", weight: 400 },
  { file: "NotoSans-Bold.ttf", name: "Noto Latin", weight: 700 },
  { file: "NotoSansSC-Regular.otf", name: "Noto CJK", weight: 400 },
  { file: "NotoSansSC-Bold.otf", name: "Noto CJK", weight: 700 },
  { file: "NotoSansTC-Regular.otf", name: "Noto CJK", weight: 400 },
] as const;

type Font = { name: string; data: Buffer; weight: 400 | 700; style: "normal" };
const fontsByDir = new Map<string, Font[]>();

function loadFonts(fontDir: string): Font[] {
  const cached = fontsByDir.get(fontDir);
  if (cached) return cached;
  const missing = FONT_FILES.filter((f) => !existsSync(join(fontDir, f.file)));
  if (missing.length) throw new Error(`fonts missing in ${fontDir}: ${missing.map((f) => f.file).join(", ")}`);
  const fonts: Font[] = FONT_FILES.map((f) => ({ name: f.name, data: readFileSync(join(fontDir, f.file)), weight: f.weight, style: "normal" }));
  fontsByDir.set(fontDir, fonts);
  return fonts;
}

/** Emoji as Twemoji pictures (fetched once each, then cached in memory). */
const emojiCache = new Map<string, string>();
async function emojiImage(segment: string, fetchImpl: typeof fetch): Promise<string> {
  const code = [...segment].map((c) => c.codePointAt(0)!.toString(16)).filter((c) => c !== "fe0f").join("-");
  const cached = emojiCache.get(code);
  if (cached !== undefined) return cached;
  let data = "";
  try {
    const response = await fetchImpl(`https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${code}.svg`, { signal: AbortSignal.timeout(4000) });
    if (response.ok) data = `data:image/svg+xml;base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
  } catch {
    // No emoji picture: the character is left out of the picture (it is in the caption).
  }
  if (emojiCache.size > 500) emojiCache.clear();
  emojiCache.set(code, data);
  return data;
}

async function avatarData(url: string | undefined, fetchImpl: typeof fetch): Promise<string | undefined> {
  if (!url || !/^https:\/\/pbs\.twimg\.com\//.test(url)) return undefined;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const type = response.headers.get("content-type") ?? "image/jpeg";
    if (!/^image\/(jpeg|png|webp)/.test(type)) return undefined;
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
  } catch {
    return undefined;
  }
}

type Node = { type: string; props: Record<string, unknown> & { children?: unknown; style?: Record<string, unknown> } };
const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({ type, props: { style, children, ...extra } });

const VERIFIED =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1d9bf0" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"/></svg>';
const X_LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#0f1419" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
const svgData = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

function header(post: XPost, avatar: string | undefined, size: number): Node {
  const initial = h("div", { width: size, height: size, borderRadius: size, background: "#cfd9de", color: "#fff", fontSize: size / 2, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }, [...(post.author || post.handle || "?")][0]!.toUpperCase());
  const picture = avatar ? h("img", { width: size, height: size, borderRadius: size, objectFit: "cover" }, undefined, { src: avatar, width: size, height: size }) : initial;
  const name = h("div", { display: "flex", alignItems: "center", gap: 4 }, [
    h("div", { fontWeight: 700, fontSize: size >= 40 ? 17 : 15, color: "#0f1419", lineClamp: 1, maxWidth: WIDTH - 220 }, post.author || post.handle),
    ...(post.verified ? [h("img", { width: 18, height: 18 }, undefined, { src: svgData(VERIFIED), width: 18, height: 18 })] : []),
  ]);
  return h("div", { display: "flex", alignItems: "center", gap: 10 }, [
    picture,
    h("div", { display: "flex", flexDirection: "column" }, [name, h("div", { fontSize: size >= 40 ? 15 : 14, color: "#536471" }, `@${post.handle}`)]),
  ]);
}

/** The layout tree for one post (exported for tests). */
export function xPictureTree(
  post: XPost,
  options: { avatar?: string; quoteAvatar?: string; translation?: string; time?: string; textMax?: number; minHeight?: number; height?: number } = {},
): Node {
  const textMax = options.textMax ?? MAX_TEXT;
  const text = clip(post.text.trim(), textMax);
  const children: Node[] = [
    h("div", { display: "flex", justifyContent: "space-between", alignItems: "flex-start" }, [
      header(post, options.avatar, 44),
      h("img", { width: 24, height: 24 }, undefined, { src: svgData(X_LOGO), width: 24, height: 24 }),
    ]),
  ];
  if (text) children.push(h("div", { fontSize: 19, lineHeight: 1.45, color: "#0f1419", whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 14 }, text));
  if (options.translation?.trim()) {
    children.push(
      h("div", { display: "flex", flexDirection: "column", marginTop: 14, padding: "10px 14px", background: "#f7f9f9", borderRadius: 12 }, [
        h("div", { fontSize: 13, color: "#536471", marginBottom: 4 }, "🌐 翻译 / Translation"),
        h("div", { fontSize: 17, lineHeight: 1.45, color: "#0f1419", whiteSpace: "pre-wrap", wordBreak: "break-word" }, clip(options.translation.trim(), textMax)),
      ]),
    );
  }
  if (post.quote) {
    children.push(
      h("div", { display: "flex", flexDirection: "column", marginTop: 14, padding: 14, border: "1px solid #cfd9de", borderRadius: 14, gap: 8 }, [
        header(post.quote, options.quoteAvatar, 24),
        h("div", { fontSize: 16, lineHeight: 1.4, color: "#0f1419", whiteSpace: "pre-wrap", wordBreak: "break-word" }, clip(post.quote.text.trim() || "(no text)", Math.min(MAX_QUOTE, textMax))),
      ]),
    );
  }
  // The time sits at the bottom when the picture is taller than its content.
  if (options.time) children.push(h("div", { fontSize: 14, color: "#536471", marginTop: "auto", paddingTop: 14 }, options.time));
  // Sizes are of the whole picture; the style's width and height exclude the 18px frame on each side.
  const size = options.height ? { height: options.height - 36, overflow: "hidden" } : options.minHeight ? { minHeight: options.minHeight - 36 } : {};
  return h("div", { display: "flex", width: WIDTH, padding: 18, background: "#eef1f5", fontFamily: "Noto Latin, Noto CJK", ...size }, [
    h("div", { display: "flex", flexDirection: "column", width: "100%", padding: "20px 22px", background: "#ffffff", borderRadius: 20, border: "1px solid #e1e8ed" }, children),
  ]);
}

/** The post as a PNG shaped by `pictureRatio`. Throws when the fonts are not installed. */
export async function renderXPicture(
  post: XPost,
  options: { fontDir: string; translation?: string; time?: string; fetchImpl?: typeof fetch },
): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const loaded = loadFonts(options.fontDir);
  const [avatar, quoteAvatar] = await Promise.all([avatarData(post.avatarUrl, fetchImpl), avatarData(post.quote?.avatarUrl, fetchImpl)]);
  // Next to media: exactly that shape (Telegram lays out albums by shape). Alone: at most square.
  // Text that doesn't fit ends with "…"; the caption below has all of it.
  const ratio = pictureRatio(post);
  const height = Math.round(OUTER / (ratio ?? 1));
  const minHeight = ratio ? height : undefined;
  const draw = (textMax: number, fixed = false) =>
    satori(xPictureTree(post, { avatar, quoteAvatar, translation: options.translation, time: options.time, textMax, minHeight, height: fixed ? height : undefined }) as never, {
      width: OUTER,
      fonts: loaded,
      loadAdditionalAsset: async (code, segment) => (code === "emoji" ? emojiImage(segment, fetchImpl) : []),
    });
  // The most text that fits: binary search on the characters drawn (a handful of renders, ~50 ms each).
  let hi = Math.min(MAX_TEXT, Math.max([...post.text].length, [...(options.translation ?? "")].length));
  let svg = await draw(hi);
  if (svgHeight(svg) > height) {
    let lo = 0;
    let best: string | undefined;
    while (hi - lo > Math.max(4, hi / 20)) {
      const mid = Math.floor((lo + hi) / 2);
      const tried = await draw(mid);
      if (svgHeight(tried) <= height) [lo, best] = [mid, tried];
      else hi = mid;
    }
    svg = best ?? (await draw(lo, true));
  }
  return new Resvg(svg, { fitTo: { mode: "zoom", value: SCALE }, font: { loadSystemFonts: false } }).render().asPng();
}

function svgHeight(svg: string): number {
  return Number(svg.match(/^<svg[^>]*\sheight="([\d.]+)"/)?.[1] ?? 0);
}
