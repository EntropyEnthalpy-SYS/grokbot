/**
 * Sliding-window counter: at most `limit` events per key within `windowMs`.
 * Keys whose events have all expired are dropped, so the map stays small.
 */
export class RateLimiter {
  readonly #limitOf: () => number;
  readonly #windowMs: number;
  readonly #events = new Map<string, number[]>();

  /** `limit` may be a function, read on every check, so the owner can change it at runtime. */
  constructor(limit: number | (() => number), windowMs: number) {
    this.#limitOf = typeof limit === "function" ? limit : () => limit;
    this.#windowMs = windowMs;
  }

  get #limit(): number {
    return this.#limitOf();
  }

  /** Record an event for `key` if it is under the limit; false when the limit is reached. */
  #lastSweep = 0;

  take(key: string, now = Date.now()): boolean {
    // Drop keys whose events all expired, at most once per window (or sooner if the map grows large).
    if (this.#events.size > 1000 || now - this.#lastSweep >= this.#windowMs) {
      this.#sweep(now);
      this.#lastSweep = now;
    }
    const recent = (this.#events.get(key) ?? []).filter((at) => now - at < this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#events.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#events.set(key, recent);
    return true;
  }

  /** Milliseconds until `key` may take again (0 when it can now). */
  retryAfter(key: string, now = Date.now()): number {
    const recent = (this.#events.get(key) ?? []).filter((at) => now - at < this.#windowMs);
    if (recent.length < this.#limit) return 0;
    return recent[recent.length - this.#limit]! + this.#windowMs - now;
  }

  /** Events of `key` inside the window. */
  used(key: string, now = Date.now()): number {
    return (this.#events.get(key) ?? []).filter((at) => now - at < this.#windowMs).length;
  }

  get size(): number {
    return this.#events.size;
  }

  #sweep(now: number): void {
    for (const [key, times] of this.#events) {
      if (times.every((at) => now - at >= this.#windowMs)) this.#events.delete(key);
    }
  }
}
