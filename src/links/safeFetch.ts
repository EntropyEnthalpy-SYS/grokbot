import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";

/**
 * Fetch a public web page without letting group members aim the bot at the
 * server's own network (SSRF). Every DNS answer is checked against private,
 * loopback, link-local (cloud metadata), CGNAT and other special ranges; the
 * socket connects to the checked address (no DNS-rebinding gap); redirects
 * are followed by hand and each hop is checked again.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export function isBlockedAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isBlockedAddress(mapped[1]!);
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) return blocked.check(address, "ipv6");
  return true;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** For tests only: decide which addresses are off limits. */
  isBlocked?: (address: string) => boolean;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

export class BlockedUrlError extends Error {}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 grokbot";

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const isBlocked = options.isBlocked ?? isBlockedAddress;
  const maxRedirects = options.maxRedirects ?? 5;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    checkUrl(url, isBlocked);
    const response = await request(url, isBlocked, signal);
    const location = response.headers.location;
    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
      response.resume();
      if (hop >= maxRedirects) throw new Error(`Too many redirects (${maxRedirects})`);
      url = new URL(location, url);
      continue;
    }
    const { body, truncated } = await readBody(response, options.maxBytes ?? 2 * 1024 * 1024, signal);
    return {
      url: url.href,
      status: response.statusCode ?? 0,
      contentType: String(response.headers["content-type"] ?? ""),
      body,
      truncated,
    };
  }
}

function checkUrl(url: URL, isBlocked: (address: string) => boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError(`Only http(s) links can be read`);
  if (url.username || url.password) throw new BlockedUrlError("Links with credentials are not read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|metadata\.google\.internal)$/i.test(host) || /\.(local|internal|localhost)$/i.test(host)) {
    throw new BlockedUrlError(`Blocked host: ${host}`);
  }
  if (isIP(host) && isBlocked(host)) throw new BlockedUrlError(`Blocked address: ${host}`);
}

/** DNS lookup that refuses to return any address if one of them is off limits. */
function guardedLookup(isBlocked: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, "", 0);
      const bad = addresses.find((entry) => isBlocked(entry.address));
      if (bad || addresses.length === 0) {
        return callback(new BlockedUrlError(`Blocked: ${hostname} resolves to ${bad?.address ?? "nothing"}`), "", 0);
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

function request(url: URL, isBlocked: (address: string) => boolean, signal: AbortSignal): Promise<http.IncomingMessage> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {
        lookup: guardedLookup(isBlocked),
        signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en,zh-TW;q=0.8,zh;q=0.7",
        },
      },
      resolve,
    );
    req.on("error", reject);
  });
}

async function readBody(
  response: http.IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ body: string; truncated: boolean }> {
  const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
  let stream: Readable = response;
  if (encoding === "gzip") stream = response.pipe(createGunzip());
  else if (encoding === "deflate") stream = response.pipe(createInflate());
  else if (encoding === "br") stream = response.pipe(createBrotliDecompress());
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const buffer = chunk as Buffer;
      if (size + buffer.length > maxBytes) {
        chunks.push(buffer.subarray(0, maxBytes - size));
        truncated = true;
        break;
      }
      chunks.push(buffer);
      size += buffer.length;
    }
  } finally {
    response.destroy();
  }
  return { body: Buffer.concat(chunks).toString("utf8"), truncated };
}
