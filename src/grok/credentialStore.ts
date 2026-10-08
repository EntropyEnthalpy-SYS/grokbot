import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { Db } from "../db.ts";

/**
 * pi-ai credential store backed by SQLite.
 *
 * xAI rotates the refresh token on every refresh, so two concurrent refreshes
 * would invalidate each other. pi-ai runs refresh inside `modify`, and this
 * store serializes `modify`/`delete` per provider id, so only one refresh can
 * be in flight. The bot is a single process; the CLI login script only writes
 * after a fresh login and never refreshes.
 */
export class SqliteCredentialStore implements CredentialStore {
  readonly #db: Db;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(db: Db) {
    this.#db = db;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const row = this.#db.prepare("SELECT json FROM credentials WHERE provider_id = ?").get(providerId) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Credential) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const rows = this.#db.prepare("SELECT provider_id, json FROM credentials").all() as {
      provider_id: string;
      json: string;
    }[];
    return rows.map((row) => ({ providerId: row.provider_id, type: (JSON.parse(row.json) as Credential).type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#serialize(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      this.#db
        .prepare(
          "INSERT INTO credentials (provider_id, json, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(provider_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        )
        .run(providerId, JSON.stringify(next), Date.now());
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#serialize(providerId, async () => {
      this.#db.prepare("DELETE FROM credentials WHERE provider_id = ?").run(providerId);
    });
  }

  #serialize<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    this.#chains.set(providerId, result);
    return result;
  }
}
