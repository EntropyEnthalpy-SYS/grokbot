import { rename, statfs, writeFile } from "node:fs/promises";
import { connect } from "node:net";

/** A health check: resolves with a short detail when healthy, throws when not. */
export interface Check {
  name: string;
  /** How often to run it (default 5 min). */
  everyMs?: number;
  run: (signal: AbortSignal) => Promise<string>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  at: number;
  ms: number;
}

type CheckState = { last?: CheckResult; failures: number; alerted: boolean; downSince?: number };

const DEFAULT_EVERY_MS = 5 * 60 * 1000;
const CHECK_TIMEOUT_MS = 20_000;
const MINUTE = 60 * 1000;

/**
 * Runs checks on a schedule, tells the owner when one breaks (after
 * `failuresBeforeAlert` failures in a row, so one blip stays quiet) and when it
 * recovers, and writes a heartbeat file every minute for the external watchdog.
 */
export class HealthMonitor {
  readonly #checks: readonly Check[];
  readonly #notify: (text: string) => Promise<void>;
  readonly #heartbeatPath: string | undefined;
  readonly #failuresBeforeAlert: number;
  readonly #state = new Map<string, CheckState>();
  readonly #errors: { at: number; message: string }[] = [];
  readonly startedAt = Date.now();
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<CheckResult[]> | undefined;

  constructor(options: { checks: readonly Check[]; notify: (text: string) => Promise<void>; heartbeatPath?: string; failuresBeforeAlert?: number }) {
    this.#checks = options.checks;
    this.#notify = options.notify;
    this.#heartbeatPath = options.heartbeatPath;
    this.#failuresBeforeAlert = options.failuresBeforeAlert ?? 2;
    for (const check of this.#checks) this.#state.set(check.name, { failures: 0, alerted: false });
  }

  start(tickMs = MINUTE): void {
    const tick = () => void this.run().catch((error) => console.error("health check failed:", error));
    tick();
    this.#timer = setInterval(tick, tickMs);
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  /** Run the checks that are due (all of them when `force`), alert on changes, write the heartbeat. */
  run(options: { force?: boolean; now?: number } = {}): Promise<CheckResult[]> {
    // One run at a time: /health during a scheduled run waits for it instead of doubling the probes.
    const previous = this.#running ?? Promise.resolve([]);
    const next = previous.catch(() => []).then(() => this.#run(options.force ?? false, options.now));
    this.#running = next;
    return next;
  }

  /** Latest result of every check, in definition order. */
  results(): CheckResult[] {
    return this.#checks.map((check) => this.#state.get(check.name)?.last).filter((r): r is CheckResult => r !== undefined);
  }

  /** Remember a failed task (an answer, a card, …) for /health. */
  recordError(error: unknown, now = Date.now()): void {
    const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
    this.#errors.push({ at: now, message });
    if (this.#errors.length > 50) this.#errors.shift();
  }

  recentErrors(windowMs = 24 * 60 * MINUTE, now = Date.now()): { at: number; message: string }[] {
    return this.#errors.filter((e) => now - e.at < windowMs);
  }

  async #run(force: boolean, now = Date.now()): Promise<CheckResult[]> {
    const due = this.#checks.filter((check) => {
      const last = this.#state.get(check.name)?.last;
      return force || !last || now - last.at >= (check.everyMs ?? DEFAULT_EVERY_MS) - 5_000;
    });
    const results = await Promise.all(due.map((check) => runCheck(check, now)));
    const messages: string[] = [];
    for (const result of results) {
      const message = this.#update(result);
      if (message) messages.push(message);
    }
    if (messages.length) await this.#notify(messages.join("\n")).catch((error) => console.error(`health alert not sent: ${(error as Error).message}`));
    await this.#writeHeartbeat(now);
    return results;
  }

  /** Update one check's state; returns an alert line when the owner should hear about it. */
  #update(result: CheckResult): string | undefined {
    const state = this.#state.get(result.name)!;
    state.last = result;
    if (!result.ok) {
      state.failures++;
      state.downSince ??= result.at;
      if (state.failures >= this.#failuresBeforeAlert && !state.alerted) {
        state.alerted = true;
        return `🔴 ${result.name}: ${result.detail}`;
      }
      return undefined;
    }
    const wasAlerted = state.alerted;
    const downFor = state.downSince === undefined ? 0 : result.at - state.downSince;
    state.failures = 0;
    state.alerted = false;
    state.downSince = undefined;
    return wasAlerted ? `🟢 ${result.name} recovered after ${Math.max(1, Math.round(downFor / MINUTE))} min: ${result.detail}` : undefined;
  }

  async #writeHeartbeat(now: number): Promise<void> {
    if (!this.#heartbeatPath) return;
    const body = JSON.stringify({ at: now, pid: process.pid, checks: this.results() });
    const tmp = `${this.#heartbeatPath}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, this.#heartbeatPath);
  }
}

async function runCheck(check: Check, now: number): Promise<CheckResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  try {
    const detail = await Promise.race([
      check.run(signal),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error(`no answer in ${CHECK_TIMEOUT_MS / 1000} s`)))),
    ]);
    return { name: check.name, ok: true, detail, at: now, ms: Date.now() - started };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
    return { name: check.name, ok: false, detail, at: now, ms: Date.now() - started };
  }
}

/** Free space where the bot keeps its data: fails under 2 GB or 5 %. */
export async function diskCheck(path: string): Promise<string> {
  const stats = await statfs(path);
  const free = stats.bavail * stats.bsize;
  const total = stats.blocks * stats.bsize;
  const detail = `${(free / 1024 ** 3).toFixed(1)} GB free (${Math.round((free / total) * 100)}%)`;
  if (free < 2 * 1024 ** 3 || free / total < 0.05) throw new Error(`low disk: ${detail}`);
  return detail;
}

/** The bot's own memory, against the service's 1 GB MemoryMax. */
export function memoryCheck(limitBytes = 850 * 1024 * 1024, rss = process.memoryUsage().rss): string {
  const detail = `${Math.round(rss / 1024 / 1024)} MB used`;
  if (rss > limitBytes) throw new Error(`high memory: ${detail} (service limit 1 GB)`);
  return detail;
}

/** A SOCKS5 proxy answers its greeting (proves the tunnel is up, not only the port). */
export function socksCheck(proxyUrl: string, signal?: AbortSignal): Promise<string> {
  const { hostname, port } = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) || 1080, signal });
    socket.setTimeout(10_000, () => socket.destroy(new Error("SOCKS proxy timed out")));
    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.once("data", (data: Buffer) => {
      socket.end();
      if (data[0] === 0x05 && data[1] === 0x00) resolve(`SOCKS5 OK on ${hostname}:${port}`);
      else reject(new Error(`unexpected SOCKS reply ${data.subarray(0, 2).toString("hex")}`));
    });
    socket.once("error", (error) => reject(new Error(`tunnel down: ${error.message}`)));
  });
}

/** yt-dlp versions are dates (2026.10.05). Releases can be ~3 months apart, so only a much older one means updates are failing. */
export function ytdlpAgeCheck(version: string, now = Date.now()): string {
  const match = version.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!match) throw new Error(`unknown yt-dlp version "${version.trim()}"`);
  const days = Math.floor((now - Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) / (24 * 60 * MINUTE));
  if (days > 120) throw new Error(`yt-dlp ${version.trim()} is ${days} days old; the daily update may be failing`);
  return `yt-dlp ${version.trim()} (${days} days old)`;
}

export function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / MINUTE);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
