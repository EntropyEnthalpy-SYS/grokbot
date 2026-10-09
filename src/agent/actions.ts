import { randomBytes } from "node:crypto";
import { chatOfKey } from "./polls.ts";

/** Unconfirmed suggestions expire after this long (they are kept in memory only). */
export const ACTION_TTL_MS = 60 * 60 * 1000;

/** Something the AI wants to do in a group (save a note, post a poll) that waits for a person's ✅. */
export interface PendingAction {
  id: string;
  chatId: number;
  threadId?: number;
  /** The person who asked; they (or the owner) may confirm. */
  userId?: number;
  userName: string;
  /** Confirm button text, e.g. "✅ Save note". */
  label: string;
  /** Telegram HTML shown above the buttons. */
  preview: string;
  /** Does it; returns a short plain-text result ("Saved as note #4"). */
  run: () => Promise<string>;
  createdAt: number;
}

export type Proposal = Pick<PendingAction, "label" | "preview" | "run">;

/** What a tool sees: whether this chat wants confirmations, and how to ask for one. */
export interface Confirmer {
  required(): boolean;
  propose(proposal: Proposal): Promise<void>;
}

/**
 * Suggestions waiting for confirmation. Model instructions alone can't stop a page or a
 * message from talking the AI into saving a note or posting a poll; a person's tap can.
 */
export class ActionDesk {
  /** Shows the preview with ✅ / ✖️ buttons (set by the bot). */
  presenter: ((action: PendingAction) => Promise<void>) | undefined;
  readonly #pending = new Map<string, PendingAction>();

  async propose(action: Omit<PendingAction, "id" | "createdAt">, now = Date.now()): Promise<PendingAction> {
    if (!this.presenter) throw new Error("Confirmations can't be shown here.");
    this.#expire(now);
    const pending = { ...action, id: randomBytes(6).toString("base64url"), createdAt: now };
    this.#pending.set(pending.id, pending);
    await this.presenter(pending);
    return pending;
  }

  /** A suggestion still waiting, or undefined when it was handled or expired. */
  get(id: string, now = Date.now()): PendingAction | undefined {
    this.#expire(now);
    return this.#pending.get(id);
  }

  /** Remove and return it, so two taps can't run it twice. */
  take(id: string, now = Date.now()): PendingAction | undefined {
    const action = this.get(id, now);
    this.#pending.delete(id);
    return action;
  }

  #expire(now: number): void {
    for (const [id, action] of this.#pending) if (now - action.createdAt > ACTION_TTL_MS) this.#pending.delete(id);
  }
}

/**
 * The confirmer for one conversation: in groups with ✋ confirmations on, a tool's change
 * waits for the person asking in that conversation (or the owner) to tap ✅.
 */
export function confirmerFor(
  deps: { actions: ActionDesk; confirmActions: (chatId: number) => boolean; speakers: ReadonlyMap<string, { userId?: number; userName: string }> },
  key: string,
): Confirmer {
  const { chatId, threadId } = chatOfKey(key);
  return {
    required: () => deps.confirmActions(chatId),
    propose: async (proposal) => {
      const speaker = deps.speakers.get(key);
      await deps.actions.propose({ ...proposal, chatId, threadId, userId: speaker?.userId, userName: speaker?.userName ?? "the person who asked" });
    },
  };
}
