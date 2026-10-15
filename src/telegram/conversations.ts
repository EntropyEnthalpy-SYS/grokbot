import type { SentMessage } from "../agent/sent.ts";
import type { PrivacyMode } from "./groups.ts";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export interface HistoryWindow {
  turns: number;
  maxAgeMs: number;
}

/** A person's own follow-ups in a strict or focused group: "grok, and the second one?" a few minutes later. */
export const PERSONAL_WINDOW: HistoryWindow = { turns: 6, maxAgeMs: 30 * MINUTE };
/** Normal groups share one conversation with the bot: the latest questions of the day. */
export const SHARED_WINDOW: HistoryWindow = { turns: 20, maxAgeMs: DAY };
/** A forum topic is its own thread: it keeps its questions and answers for as long as conversations are kept. */
export const TOPIC_WINDOW: HistoryWindow = { turns: 30, maxAgeMs: 7 * DAY };
/** A reply to one of the bot's answers picks up the conversation that wrote it, however old (within retention). */
export const CONTINUED_WINDOW: HistoryWindow = { turns: 20, maxAgeMs: 7 * DAY };

export interface Conversation {
  key: string;
  history?: HistoryWindow;
  /** Never stored: a focused group's question that carries the group chat. */
  ephemeral: boolean;
  /** The question continues the conversation of the answer it replies to. */
  continued: boolean;
}

/** One conversation per private chat, group, or forum topic (the base every group conversation key starts with). */
export function sessionKey(chatId: number, threadId: number): string {
  return threadId ? `tg:${chatId}:topic:${threadId}` : `tg:${chatId}`;
}

/**
 * Which conversation a question in a group belongs to:
 * - a reply to one of the bot's answers continues that answer's conversation;
 * - a forum topic is one conversation;
 * - a normal group shares one conversation;
 * - strict and focused groups keep one per person, so follow-ups work without mixing people's questions.
 */
export function groupConversation(options: {
  chatId: number;
  threadId: number;
  privacy: PrivacyMode;
  userId?: number;
  messageId: number;
  repliedTo?: SentMessage;
  /** Focused privacy only: the question is about the group chat, so this turn carries it. */
  withChat: boolean;
}): Conversation {
  const base = sessionKey(options.chatId, options.threadId);
  if (options.privacy === "focused" && options.withChat) return { key: `${base}:q${options.messageId}`, ephemeral: true, continued: false };
  const earlier = options.repliedTo?.chatKey;
  if (earlier && belongsTo(earlier, options.chatId) && !/:q\d+$/.test(earlier)) {
    return { key: earlier, history: CONTINUED_WINDOW, ephemeral: false, continued: true };
  }
  if (options.threadId) return { key: base, history: TOPIC_WINDOW, ephemeral: false, continued: false };
  if (options.privacy === "normal") return { key: base, history: SHARED_WINDOW, ephemeral: false, continued: false };
  if (options.userId === undefined) return { key: `${base}:q${options.messageId}`, ephemeral: true, continued: false };
  return { key: personalKey(options.chatId, options.threadId, options.userId), history: PERSONAL_WINDOW, ephemeral: false, continued: false };
}

/** A member's own conversation in a strict or focused group (also what /new clears for them there). */
export function personalKey(chatId: number, threadId: number, userId: number): string {
  return `${sessionKey(chatId, threadId)}:u:${userId}`;
}

function belongsTo(chatKey: string, chatId: number): boolean {
  return chatKey === `tg:${chatId}` || chatKey.startsWith(`tg:${chatId}:`);
}
