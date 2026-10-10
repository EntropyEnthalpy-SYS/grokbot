import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db.ts";

/** Actions the root runner (deploy/grokbot-ops.sh) accepts. */
export const OPS_ACTIONS = {
  status: "Service status",
  logs: "Recent errors (6 h)",
  "update-tools": "Update yt-dlp + ParseHub",
  "restart-helpers": "Restart helpers",
  "restart-bot": "Restart the bot",
} as const;
export type OpsAction = keyof typeof OPS_ACTIONS;

export interface OpsResult {
  action: string;
  ok: boolean;
  output: string;
  finishedAt: number;
}

/**
 * Asks the root ops runner to do something by dropping a request file into the
 * bot's data folder (a systemd path unit picks it up), then waits for the result
 * file. The bot never gets root; it can only ask for the fixed actions.
 */
export class OpsClient {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  /** Start an action; resolves with its result, or undefined if the runner didn't answer in time. */
  async run(action: OpsAction, timeoutMs = 120_000): Promise<OpsResult | undefined> {
    const id = await this.request(action);
    return this.waitFor(id, timeoutMs);
  }

  async request(action: OpsAction): Promise<string> {
    await mkdir(this.#dir, { recursive: true });
    const id = randomBytes(8).toString("hex");
    const tmp = join(this.#dir, `.request-${id}.tmp`);
    await writeFile(tmp, JSON.stringify({ action, at: Date.now() }));
    await rename(tmp, join(this.#dir, `request-${id}.json`));
    return id;
  }

  async waitFor(id: string, timeoutMs: number): Promise<OpsResult | undefined> {
    const path = join(this.#dir, `result-${id}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const result = JSON.parse(await readFile(path, "utf8")) as OpsResult;
        await unlink(path).catch(() => undefined);
        return result;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return undefined;
  }

  /** Results nobody waited for (e.g. "restart-bot" finished after this process was replaced). Each is returned once. */
  async leftovers(): Promise<OpsResult[]> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    const results: OpsResult[] = [];
    for (const name of names.filter((n) => /^result-[a-z0-9]+\.json$/.test(n))) {
      const path = join(this.#dir, name);
      try {
        results.push(JSON.parse(await readFile(path, "utf8")) as OpsResult);
      } catch {
        // half-written or broken: drop it
      }
      await unlink(path).catch(() => undefined);
    }
    return results;
  }
}

/**
 * A copy of the database for the owner, without logins and API keys (those stay
 * on the server). Returns the copy's path; the caller deletes it after sending.
 */
/**
 * A copy of the database without logins and API keys. `withoutHistory` (the nightly off-server
 * copy) also leaves out conversations, the group log and cached pages, so stored messages still
 * disappear after 7 days; notes, reminders, settings, permissions and usage are kept.
 */
export function backupWithoutSecrets(db: Db, dir: string, options: { withoutHistory?: boolean } = {}): string {
  const path = join(dir, `grokbot-backup-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}.db`);
  // VACUUM INTO takes a string literal; the path is built from the data dir, a date and hex only.
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(path);
  try {
    copy.exec("DELETE FROM credentials; DELETE FROM settings WHERE key = 'device_id';");
    if (options.withoutHistory) copy.exec("DELETE FROM chats; DELETE FROM group_log; DELETE FROM bot_answers; DELETE FROM link_cache;");
    copy.exec("VACUUM;");
  } finally {
    copy.close();
  }
  return path;
}
