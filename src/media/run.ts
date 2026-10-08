import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a program with an argument array (never through a shell, so URLs can't
 * inject commands), with a timeout and an output cap.
 */
export function run(
  program: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      {
        timeout: options.timeoutMs ?? 120_000,
        signal: options.signal,
        cwd: options.cwd,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim().split("\n").filter(Boolean).at(-1) ?? error.message;
          reject(new Error(`${program} failed: ${detail.slice(0, 300)}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** Let at most `limit` heavy jobs (downloads, ffmpeg) run at once. */
export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async use<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try {
      return await task();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}
