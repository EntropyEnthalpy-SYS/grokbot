/** Most links handled per message, as in OpenClaw's link understanding. */
export const MAX_LINKS = 3;

export interface Entity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

export type LinkKind = "x" | "video" | "web";

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com", "fxtwitter.com", "vxtwitter.com"]);
const VIDEO_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "tiktok.com",
  "vm.tiktok.com",
  "bilibili.com",
  "b23.tv",
  "vimeo.com",
]);

/**
 * Links in a Telegram message, read from its entities (not guessed with a
 * regex): visible URLs (`url`) and links hidden behind text (`text_link`).
 * Only http(s); normalized and de-duplicated; at most MAX_LINKS.
 */
export function extractLinks(text: string | undefined, entities: readonly Entity[] | undefined): string[] {
  if (!text || !entities) return [];
  const found: string[] = [];
  for (const entity of entities) {
    let raw: string | undefined;
    if (entity.type === "text_link") raw = entity.url;
    else if (entity.type === "url") raw = sliceUtf16(text, entity.offset, entity.length);
    const url = raw ? normalizeUrl(raw) : undefined;
    if (url && !found.includes(url)) found.push(url);
    if (found.length >= MAX_LINKS) break;
  }
  return found;
}

/** Telegram entity offsets count UTF-16 code units, which is also how JS strings index. */
function sliceUtf16(text: string, offset: number, length: number): string {
  return text.slice(offset, offset + length);
}

/** Add a scheme to bare "example.com/x", drop fragments and tracking params; undefined if not http(s). */
export function normalizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  url.hash = "";
  const kind = linkKind(url.href);
  for (const key of [...url.searchParams.keys()]) {
    const tracker =
      /^(utm_.*|fbclid|gclid|igshid|mc_eid)$/i.test(key) ||
      (kind === "x" && (key === "s" || key === "t")) || // X share trackers
      (kind === "video" && key === "si"); // YouTube share tracker; `t=` (timestamp) is kept
    if (tracker) url.searchParams.delete(key);
  }
  return url.href;
}

export function linkKind(href: string): LinkKind {
  let host: string;
  try {
    host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "web";
  }
  if (X_HOSTS.has(host)) return "x";
  if (VIDEO_HOSTS.has(host) || host.endsWith(".bilibili.com")) return "video";
  return "web";
}
