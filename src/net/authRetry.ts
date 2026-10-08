/**
 * pi-ai's xAI login and token refresh call the global `fetch` once per step, so
 * a single network blip (seen in practice: one Cloudflare connect timeout)
 * aborts a login the user already started, or fails a refresh.
 *
 * This wrapper retries requests to xAI's auth host only when the TCP/TLS
 * connection could not be established. In that case no request bytes reached
 * the server, so even a single-use refresh-token POST is safe to resend.
 * Errors after connecting (resets, HTTP errors) are passed through unchanged.
 */
const AUTH_HOSTS = new Set(["auth.x.ai", "accounts.x.ai"]);
const CONNECT_ERRORS = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function withAuthRetry(fetchImpl: typeof fetch, options: RetryOptions = {}): typeof fetch {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  return async (input, init) => {
    if (!AUTH_HOSTS.has(hostOf(input))) return fetchImpl(input, init);
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchImpl(input, init);
      } catch (error) {
        if (attempt >= attempts || init?.signal?.aborted || !isConnectError(error)) throw error;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  };
}

export function installAuthRetry(): void {
  globalThis.fetch = withAuthRetry(globalThis.fetch.bind(globalThis));
}

export function isConnectError(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause as { code?: unknown; errors?: unknown[] } | undefined;
  if (!cause) return false;
  if (typeof cause.code === "string" && CONNECT_ERRORS.has(cause.code)) return true;
  // Happy-eyeballs failures arrive as an AggregateError of per-address connect errors.
  return Array.isArray(cause.errors) && cause.errors.length > 0 &&
    cause.errors.every((inner) => CONNECT_ERRORS.has(String((inner as { code?: unknown }).code)));
}

function hostOf(input: Parameters<typeof fetch>[0]): string {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
