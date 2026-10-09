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

function hostOf(href: string): string | undefined {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

const matchesHost = (host: string, domains: ReadonlySet<string>) => [...domains].some((d) => host === d || host.endsWith(`.${d}`));

/** t.me / telegram.me links: channels, groups and invites (forwarded posts end with them). Not content to summarize. */
export function isTelegramLink(href: string): boolean {
  const host = hostOf(href);
  return host !== undefined && matchesHost(host, TELEGRAM_HOSTS);
}
const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog", "telegram.org"]);

/** Adult sites: well-known domains, or a host name that says so ("…porn…", "…xxx…", ".xxx", "…hentai…"). */
export function isAdultUrl(href: string): boolean {
  const host = hostOf(href);
  if (!host) return false;
  if (matchesHost(host, ADULT_HOSTS)) return true;
  // Every label, the ending too: .xxx is the adult-site top-level domain.
  return host.split(".").some((label) => /porn|xxx|hentai|nsfw/.test(label));
}
const ADULT_HOSTS = new Set([
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com", "youporn.com", "tube8.com", "spankbang.com",
  "eporner.com", "beeg.com", "txxx.com", "motherless.com", "onlyfans.com", "fansly.com", "manyvids.com", "chaturbate.com",
  "stripchat.com", "bongacams.com", "livejasmin.com", "cam4.com", "camsoda.com", "brazzers.com", "missav.com", "missav.ws",
  "jable.tv", "avgle.com", "supjav.com", "thisav.com", "javlibrary.com", "javdb.com", "nhentai.net", "e-hentai.org",
  "rule34.xxx", "91porn.com", "hanime.tv", "iwara.tv", "erome.com", "rule34video.com",
]);

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
