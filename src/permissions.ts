import type { Db } from "./db.ts";

/** What a person may do. The owner always may do everything and can't be restricted. */
export const PERMISSION_FLAGS = {
  private: { icon: "💬", label: "Private chat", help: "may chat with the bot privately (and use @bot inline)" },
  approved: { icon: "✅", label: "Approved", help: "may use the bot in groups set to “approved members only”" },
  trusted: { icon: "⭐", label: "Trusted", help: "no usage limits" },
  blocked: { icon: "⛔", label: "Blocked", help: "the bot ignores them everywhere" },
} as const;
export type PermissionFlag = keyof typeof PERMISSION_FLAGS;

export interface Person {
  userId: number;
  name: string;
  username?: string;
  private: boolean;
  approved: boolean;
  trusted: boolean;
  blocked: boolean;
}

type Row = { user_id: number; name: string; username: string | null; private: number; approved: number; trusted: number; blocked: number };
const fromRow = (r: Row): Person => ({
  userId: Number(r.user_id),
  name: r.name,
  username: r.username ?? undefined,
  private: r.private === 1,
  approved: r.approved === 1,
  trusted: r.trusted === 1,
  blocked: r.blocked === 1,
});

/** Per-person permissions, managed in /admin → 🔐 Permissions. Unknown people have no flags. */
export class PermissionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(userId: number): Person | undefined {
    const row = this.#db.prepare("SELECT * FROM permissions WHERE user_id = ?").get(userId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** People with at least one permission, or known by name; blocked and private first. */
  list(): Person[] {
    return (this.#db.prepare("SELECT * FROM permissions ORDER BY blocked DESC, private DESC, approved DESC, trusted DESC, name").all() as Row[]).map(fromRow);
  }

  has(userId: number | undefined, flag: PermissionFlag): boolean {
    if (userId === undefined) return false;
    const row = this.#db.prepare(`SELECT ${flag} AS value FROM permissions WHERE user_id = ?`).get(userId) as { value: number } | undefined;
    return row?.value === 1;
  }

  ids(flag: PermissionFlag): Set<number> {
    return new Set((this.#db.prepare(`SELECT user_id FROM permissions WHERE ${flag} = 1`).all() as { user_id: number }[]).map((r) => Number(r.user_id)));
  }

  /** Turn one permission on or off (creating the person if needed). Blocking clears the others, and vice versa. */
  set(userId: number, flag: PermissionFlag, on: boolean, who?: { name?: string; username?: string }): Person {
    this.remember(userId, who ?? {});
    this.#db.prepare(`UPDATE permissions SET ${flag} = ?, updated_at = ? WHERE user_id = ?`).run(on ? 1 : 0, Date.now(), userId);
    if (on && flag === "blocked") this.#db.prepare("UPDATE permissions SET private = 0, approved = 0, trusted = 0 WHERE user_id = ?").run(userId);
    if (on && flag !== "blocked") this.#db.prepare("UPDATE permissions SET blocked = 0 WHERE user_id = ?").run(userId);
    return this.get(userId)!;
  }

  /** Keep a display name for the panel; never changes permissions. */
  remember(userId: number, who: { name?: string; username?: string }): void {
    this.#db
      .prepare(
        "INSERT INTO permissions (user_id, name, username, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END, " +
          "username = COALESCE(excluded.username, username)",
      )
      .run(userId, who.name ?? "", who.username ?? null, Date.now());
  }

  /** Forget a person entirely (back to default: member of enabled groups, no private chat). */
  remove(userId: number): void {
    this.#db.prepare("DELETE FROM permissions WHERE user_id = ?").run(userId);
  }
}

/** "⛔" / "💬✅⭐" / "–" for lists. */
export function permissionIcons(person: Person): string {
  if (person.blocked) return PERMISSION_FLAGS.blocked.icon;
  const icons = (["private", "approved", "trusted"] as const).filter((f) => person[f]).map((f) => PERMISSION_FLAGS[f].icon);
  return icons.join("") || "–";
}
