import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** Platforms that work better (or only) with a logged-in browser cookie, in panel order. */
export const COOKIE_PLATFORMS: Record<string, { name: string; why: string; site: string }> = {
  instagram: { name: "Instagram", why: "needed for most posts", site: "instagram.com" },
  threads: { name: "Threads", why: "needed (login wall)", site: "threads.com" },
  zhihu: { name: "知乎 Zhihu", why: "needed", site: "zhihu.com" },
  xhs: { name: "小红书 Xiaohongshu", why: "helps when posts are restricted", site: "xiaohongshu.com" },
  bilibili: { name: "Bilibili", why: "higher video quality", site: "bilibili.com" },
  weibo: { name: "微博 Weibo", why: "helps with restricted posts", site: "weibo.com" },
};

/**
 * Site cookies for the ParseHub helper, pasted by the owner in /admin. One JSON
 * file the bot owns (mode 600) that the helper reads on every request; values are
 * never shown back, only whether one is set.
 */
export class CookieStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  #read(): Record<string, string> {
    try {
      const data = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  has(platform: string): boolean {
    return Boolean(this.#read()[platform]);
  }

  /** Store a cookie header ("a=1; b=2"); a pasted "Cookie: …" line or newlines are cleaned up. */
  set(platform: string, cookie: string): void {
    if (!(platform in COOKIE_PLATFORMS)) throw new Error(`unknown platform ${platform}`);
    const clean = cookie.replace(/^\s*cookie:\s*/i, "").replace(/[\r\n]+/g, " ").trim();
    if (!/^[^=;\s]+=[^;]*(;\s*[^=;\s]+=[^;]*)*;?$/.test(clean)) throw new Error("That doesn't look like a cookie (name=value; name2=value2).");
    this.#write({ ...this.#read(), [platform]: clean });
  }

  clear(platform: string): void {
    const data = this.#read();
    delete data[platform];
    this.#write(data);
  }

  #write(data: Record<string, string>): void {
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}
