import type { Db } from "../db.ts";
import { getSetting, setSetting } from "../db.ts";
import { defaultLanguage } from "../lang.ts";
import { timeZone } from "../time.ts";
import { extractLinks, type Entity } from "../links/detect.ts";

export type LinkMode = "auto" | "mention" | "off";
export const LINK_MODES: readonly LinkMode[] = ["auto", "mention", "off"];
export type VoiceMode = "auto" | "off";
export type GroupAccess = "everyone" | "approved";
export type PrivacyMode = "strict" | "normal";
export type XStyle = "text" | "picture";
export { defaultLanguage, LANGUAGES, languageName } from "../lang.ts";

/** Context window handed to Grok when someone addresses the bot in a group. */
export const CONTEXT_LIMIT = 30;
export const CONTEXT_CHARS = 6000;
const CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The parts of a Telegram message this module reads (grammY's Message satisfies it). */
export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  date: number;
  from?: TgUser;
  text?: string;
  caption?: string;
  entities?: Entity[];
  caption_entities?: (Entity & { user?: TgUser })[];
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: TgMessage;
  photo?: unknown[];
  video?: unknown;
  voice?: unknown;
  audio?: unknown;
  video_note?: unknown;
  document?: { file_name?: string };
  sticker?: { emoji?: string };
  poll?: { question: string };
  location?: unknown;
  forward_origin?: unknown;
}

export interface LogEntry {
  messageId: number;
  userId?: number;
  name: string;
  text: string;
  isBot: boolean;
  at: number;
}

export interface Bot {
  id: number;
  username: string;
}

export class GroupStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Enabled groups, oldest first. */
  list(): { chatId: number; title: string }[] {
    const rows = this.#db.prepare("SELECT chat_id, title FROM groups ORDER BY enabled_at").all() as { chat_id: number; title: string | null }[];
    return rows.map((r) => ({ chatId: Number(r.chat_id), title: r.title ?? String(r.chat_id) }));
  }

  isEnabled(chatId: number): boolean {
    return this.#db.prepare("SELECT 1 FROM groups WHERE chat_id = ?").get(chatId) !== undefined;
  }

  enable(chatId: number, title: string | undefined): void {
    this.#db
      .prepare(
        "INSERT INTO groups (chat_id, title, enabled_at, privacy, lang) VALUES (?, ?, ?, 'strict', ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title",
      )
      .run(chatId, title ?? null, Date.now(), defaultLanguage());
  }

  /**
   * strict: group messages are not logged and never sent to Grok as context;
   * each question is answered on its own (no conversation memory); voice notes
   * are transcribed only when someone asks. normal: the full context features.
   */
  privacy(chatId: number): PrivacyMode {
    const row = this.#db.prepare("SELECT privacy FROM groups WHERE chat_id = ?").get(chatId) as { privacy: string } | undefined;
    return row?.privacy === "normal" ? "normal" : "strict";
  }

  setPrivacy(chatId: number, mode: PrivacyMode): void {
    this.#db.prepare("UPDATE groups SET privacy = ? WHERE chat_id = ?").run(mode, chatId);
  }

  /** Delete everything logged for a group. */
  forget(chatId: number): number {
    return Number(this.#db.prepare("DELETE FROM group_log WHERE chat_id = ?").run(chatId).changes);
  }

  disable(chatId: number): void {
    this.#db.prepare("DELETE FROM groups WHERE chat_id = ?").run(chatId);
    this.#db.prepare("DELETE FROM group_log WHERE chat_id = ?").run(chatId);
  }

  linkMode(chatId: number): LinkMode {
    const row = this.#db.prepare("SELECT link_mode FROM groups WHERE chat_id = ?").get(chatId) as { link_mode: string } | undefined;
    return (LINK_MODES as readonly string[]).includes(row?.link_mode ?? "") ? (row!.link_mode as LinkMode) : "auto";
  }

  setLinkMode(chatId: number, mode: LinkMode): void {
    this.#db.prepare("UPDATE groups SET link_mode = ? WHERE chat_id = ?").run(mode, chatId);
  }

  /** Language for translations and link cards, e.g. "zh-tw", "en", or "off" (no translation). */
  language(chatId: number): string {
    const row = this.#db.prepare("SELECT lang FROM groups WHERE chat_id = ?").get(chatId) as { lang: string } | undefined;
    return row?.lang ?? defaultLanguage();
  }

  setLanguage(chatId: number, lang: string): void {
    this.#db.prepare("UPDATE groups SET lang = ? WHERE chat_id = ?").run(lang, chatId);
  }

  /** Platforms whose links this group doesn't want content cards for (e.g. "douyin", "twitter", "web"). */
  disabledPlatforms(chatId: number): Set<string> {
    const row = this.#db.prepare("SELECT disabled_platforms FROM groups WHERE chat_id = ?").get(chatId) as
      | { disabled_platforms: string }
      | undefined;
    return new Set((row?.disabled_platforms ?? "").split(",").filter(Boolean));
  }

  setPlatforms(chatId: number, platforms: readonly string[], enabled: boolean): Set<string> {
    const current = this.disabledPlatforms(chatId);
    for (const platform of platforms) enabled ? current.delete(platform) : current.add(platform);
    this.#db.prepare("UPDATE groups SET disabled_platforms = ? WHERE chat_id = ?").run([...current].sort().join(","), chatId);
    return current;
  }

  /** Who may use the bot here: everyone, or only members the owner approved in /admin → Permissions. */
  access(chatId: number): GroupAccess {
    const row = this.#db.prepare("SELECT access FROM groups WHERE chat_id = ?").get(chatId) as { access: string } | undefined;
    return row?.access === "approved" ? "approved" : "everyone";
  }

  setAccess(chatId: number, access: GroupAccess): void {
    this.#db.prepare("UPDATE groups SET access = ? WHERE chat_id = ?").run(access, chatId);
  }

  /** The owner's style instructions for the bot in this group; empty = default. */
  persona(chatId: number): string {
    const row = this.#db.prepare("SELECT persona FROM groups WHERE chat_id = ?").get(chatId) as { persona: string } | undefined;
    return row?.persona ?? "";
  }

  setPersona(chatId: number, text: string): void {
    this.#db.prepare("UPDATE groups SET persona = ? WHERE chat_id = ?").run(text.trim().slice(0, 600), chatId);
  }

  /** Answer voice questions with a voice note too. */
  voiceReply(chatId: number): boolean {
    const row = this.#db.prepare("SELECT voice_reply FROM groups WHERE chat_id = ?").get(chatId) as { voice_reply: number } | undefined;
    return row?.voice_reply !== 0;
  }

  setVoiceReply(chatId: number, on: boolean): void {
    this.#db.prepare("UPDATE groups SET voice_reply = ? WHERE chat_id = ?").run(on ? 1 : 0, chatId);
  }

  /** Auto-delete the bot's housekeeping replies (and the command) after a minute. */
  tidy(chatId: number): boolean {
    const row = this.#db.prepare("SELECT tidy FROM groups WHERE chat_id = ?").get(chatId) as { tidy: number } | undefined;
    return row?.tidy !== 0;
  }

  setTidy(chatId: number, on: boolean): void {
    this.#db.prepare("UPDATE groups SET tidy = ? WHERE chat_id = ?").run(on ? 1 : 0, chatId);
  }

  /** Delete the original link-only message once its content card is posted (needs admin rights). */
  deleteLink(chatId: number): boolean {
    const row = this.#db.prepare("SELECT delete_link FROM groups WHERE chat_id = ?").get(chatId) as { delete_link: number } | undefined;
    return row?.delete_link === 1;
  }

  setDeleteLink(chatId: number, on: boolean): void {
    this.#db.prepare("UPDATE groups SET delete_link = ? WHERE chat_id = ?").run(on ? 1 : 0, chatId);
  }

  /**
   * The chat's time zone (/tz) for reminders and the time Grok is told; the bot's
   * TIMEZONE unless set. Groups keep it with their settings; private chats in settings.
   */
  timeZone(chatId: number): string {
    if (chatId > 0) return getSetting(this.#db, `tz.${chatId}`) || timeZone();
    const row = this.#db.prepare("SELECT timezone FROM groups WHERE chat_id = ?").get(chatId) as { timezone: string } | undefined;
    return row?.timezone || timeZone();
  }

  /** An IANA zone, or "" for the bot's default. */
  setTimeZone(chatId: number, tz: string): void {
    if (chatId > 0) setSetting(this.#db, `tz.${chatId}`, tz);
    else this.#db.prepare("UPDATE groups SET timezone = ? WHERE chat_id = ?").run(tz, chatId);
  }

  /** Notes and polls the AI suggests in this group wait for the asker to tap ✅ (private chats: never). */
  confirmActions(chatId: number): boolean {
    if (chatId > 0) return false;
    const row = this.#db.prepare("SELECT confirm_actions FROM groups WHERE chat_id = ?").get(chatId) as { confirm_actions: number } | undefined;
    return row?.confirm_actions !== 0;
  }

  setConfirmActions(chatId: number, on: boolean): void {
    this.#db.prepare("UPDATE groups SET confirm_actions = ? WHERE chat_id = ?").run(on ? 1 : 0, chatId);
  }

  /** How X posts are shown here: a text card, or a picture drawn like the post. */
  xStyle(chatId: number): XStyle {
    const row = this.#db.prepare("SELECT x_style FROM groups WHERE chat_id = ?").get(chatId) as { x_style: string } | undefined;
    return row?.x_style === "picture" ? "picture" : "text";
  }

  setXStyle(chatId: number, style: XStyle): void {
    this.#db.prepare("UPDATE groups SET x_style = ? WHERE chat_id = ?").run(style, chatId);
  }

  /** Skip link cards for adult sites (🔞, on unless the owner turns it off). */
  hideAdult(chatId: number): boolean {
    const row = this.#db.prepare("SELECT hide_adult FROM groups WHERE chat_id = ?").get(chatId) as { hide_adult: number } | undefined;
    return row?.hide_adult !== 0;
  }

  setHideAdult(chatId: number, on: boolean): void {
    this.#db.prepare("UPDATE groups SET hide_adult = ? WHERE chat_id = ?").run(on ? 1 : 0, chatId);
  }

  /**
   * Remember the bot's answers in a group (chat replies, images, translations): a reply to one
   * continues the conversation. A reply to anything else the bot posts (link cards, transcripts,
   * reminders, previews, notices) is people talking, so it needs "grok," or a mention.
   * Only message ids are kept (for a week), so this also works in strict groups.
   */
  markAnswer(chatId: number, messageIds: readonly number[], now = Date.now()): void {
    const insert = this.#db.prepare("INSERT OR IGNORE INTO bot_answers (chat_id, message_id, at) VALUES (?, ?, ?)");
    for (const id of messageIds) insert.run(chatId, id, now);
  }

  /** Whether a bot message is one of its answers. `sentAt` (ms): older messages, sent before answers were recorded, count as answers. */
  isAnswer(chatId: number, messageId: number, sentAt: number): boolean {
    const since = Number((this.#db.prepare("SELECT value FROM settings WHERE key = 'answers_tracked_since'").get() as { value: string } | undefined)?.value ?? 0);
    if (sentAt < since) return true;
    return this.#db.prepare("SELECT 1 FROM bot_answers WHERE chat_id = ? AND message_id = ?").get(chatId, messageId) !== undefined;
  }

  /** Whether voice notes are transcribed automatically in this group. */
  voiceMode(chatId: number): VoiceMode {
    const row = this.#db.prepare("SELECT voice_mode FROM groups WHERE chat_id = ?").get(chatId) as { voice_mode: string } | undefined;
    return row?.voice_mode === "off" ? "off" : "auto";
  }

  setVoiceMode(chatId: number, mode: VoiceMode): void {
    this.#db.prepare("UPDATE groups SET voice_mode = ? WHERE chat_id = ?").run(mode, chatId);
  }

  log(chatId: number, threadId: number, entry: LogEntry): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO group_log (chat_id, thread_id, message_id, user_id, name, text, is_bot, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(chatId, threadId, entry.messageId, entry.userId ?? null, entry.name, entry.text, entry.isBot ? 1 : 0, entry.at);
  }

  /**
   * Messages in this thread since the bot last spoke (at most CONTEXT_LIMIT,
   * CONTEXT_CHARS, and one day), oldest first, excluding `excludeMessageId`.
   */
  contextSinceLastReply(chatId: number, threadId: number, excludeMessageId: number, now = Date.now()): LogEntry[] {
    const lastBot = this.#db
      .prepare("SELECT MAX(at) AS at FROM group_log WHERE chat_id = ? AND thread_id = ? AND is_bot = 1")
      .get(chatId, threadId) as { at: number | null };
    const since = Math.max(lastBot.at ?? 0, now - CONTEXT_MAX_AGE_MS);
    const rows = this.#db
      .prepare(
        "SELECT message_id, user_id, name, text, is_bot, at FROM group_log " +
          "WHERE chat_id = ? AND thread_id = ? AND at > ? AND message_id != ? AND is_bot = 0 ORDER BY at DESC, message_id DESC LIMIT ?",
      )
      .all(chatId, threadId, since, excludeMessageId, CONTEXT_LIMIT) as {
      message_id: number;
      user_id: number | null;
      name: string;
      text: string;
      is_bot: number;
      at: number;
    }[];
    const picked: LogEntry[] = [];
    let chars = 0;
    for (const row of rows) {
      chars += row.text.length;
      if (chars > CONTEXT_CHARS && picked.length > 0) break;
      picked.push({ messageId: row.message_id, userId: row.user_id ?? undefined, name: row.name, text: row.text, isBot: false, at: row.at });
    }
    return picked.reverse();
  }

  /** What was logged for a message, e.g. the full card text and link behind one photo of the bot's album. */
  loggedText(chatId: number, messageId: number): string | undefined {
    const row = this.#db.prepare("SELECT text FROM group_log WHERE chat_id = ? AND message_id = ?").get(chatId, messageId) as
      | { text: string }
      | undefined;
    return row?.text;
  }

  prune(now = Date.now()): void {
    this.#db.prepare("DELETE FROM group_log WHERE at < ?").run(now - LOG_RETENTION_MS);
    this.#db.prepare("DELETE FROM bot_answers WHERE at < ?").run(now - LOG_RETENTION_MS);
  }
}

export function displayName(user: TgUser | undefined): string {
  if (!user) return "Unknown";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return (name || user.username || "Unknown").slice(0, 64);
}

/** Thread key: forum topic id, or 0 for normal groups and the General topic. */
export function threadIdOf(message: TgMessage): number {
  return message.is_topic_message && message.message_thread_id ? message.message_thread_id : 0;
}

/** One line of text describing any kind of message, with hidden link targets made visible. */
export function describeMessage(message: TgMessage): string {
  const body = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities;
  const hidden = (entities ?? []).filter((e) => e.type === "text_link" && e.url).map((e) => e.url!);
  const parts: string[] = [];
  if (message.forward_origin) parts.push("[forwarded]");
  if (message.photo) parts.push("[photo]");
  if (message.video || message.video_note) parts.push("[video]");
  if (message.voice) parts.push("[voice message]");
  if (message.audio) parts.push("[audio]");
  if (message.document) parts.push(`[file: ${message.document.file_name ?? "unnamed"}]`);
  if (message.sticker) parts.push(`[sticker ${message.sticker.emoji ?? ""}]`.replace(" ]", "]"));
  if (message.poll) parts.push(`[poll: ${message.poll.question}]`);
  if (message.location) parts.push("[location]");
  if (body) parts.push(body);
  for (const url of hidden) if (!body.includes(url)) parts.push(`(${url})`);
  return parts.join(" ").trim();
}

export function linksIn(message: TgMessage): string[] {
  return extractLinks(message.text ?? message.caption, message.entities ?? message.caption_entities);
}

/** Short reactions people reply with: laughter, thanks, agreement. */
const REACTION_WORDS =
  /^(哈+|呵+|嘿+|h+a+h*[ah]*|lol+|lmao|xd+|笑死|笑死了|笑哭|绝了|絕了|6+|好的?|好吧|ok|okay|k|嗯+|哦+|噢+|收到|了解|明白|懂了|谢谢|謝謝|感谢|感謝|多谢|多謝|thanks|thank you|thx|ty|牛|牛逼|nb|nice|赞|讚|厉害|厲害|可以|行|对|對|是的|yes|yep|真的假的|离谱|離譜|草|？+|\?+|!+|！+)$/i;

/** A message that is only a sticker, emoji, or a short reaction word ("哈哈哈", "6", "谢谢", "👍"). */
export function isJustReaction(message: TgMessage): boolean {
  if (message.sticker) return true;
  const text = (message.text ?? "").trim();
  if (!text || message.photo || message.video || message.voice || message.document) return false;
  const words = text.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s。，,.~～…！!？?]+/gu, "");
  return words === "" || REACTION_WORDS.test(words);
}

/** Bot is called by name at the start of a message: "grok, …", "hey grok …". */
/**
 * "grok, …", "grok: …", "grok？", "grok 這是…" (CJK right after), or "hey/hi grok …".
 * Plain sentences that start with the word ("grok's answer was wrong", "grok is down") don't count.
 */
const NAME_TRIGGER = /^\s*(?:(?:hey|hi)\s+grok\b[\s,:，：!！?？]*|grok(?:\s*[,:，：!！?？。]+\s*|\s+(?=[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af])|\s*$))/i;

/**
 * Whether a group message is addressed to the bot: an @mention, starting with its name, or a
 * reply to one of its answers (`isAnswer`). A reply to anything else it posted (cards,
 * transcripts, reminders, notices) is people talking, so it counts only with the name or a mention.
 */
export function isAddressedToBot(message: TgMessage, bot: Bot, isAnswer: (messageId: number, sentAt: number) => boolean = () => true): boolean {
  const replied = message.reply_to_message;
  // "哈哈", "6", "谢谢", a sticker: a reaction to the answer, not a new question.
  if (replied?.from?.id === bot.id && isAnswer(replied.message_id, replied.date * 1000) && !isJustReaction(message)) return true;
  const text = message.text ?? message.caption ?? "";
  const entities = (message.entities ?? message.caption_entities ?? []) as (Entity & { user?: TgUser })[];
  for (const entity of entities) {
    if (entity.type === "mention") {
      const mention = text.slice(entity.offset, entity.offset + entity.length);
      if (mention.toLowerCase() === `@${bot.username.toLowerCase()}`) return true;
    }
    if (entity.type === "text_mention" && entity.user?.id === bot.id) return true;
  }
  return NAME_TRIGGER.test(text);
}

/** Whether text (e.g. a voice transcript) starts by calling the bot by name. */
/** Platform ids /platforms understands, with display names. ParseHub ids plus our own handlers. */
export const PLATFORMS: Record<string, string> = {
  twitter: "X / Twitter",
  youtube: "YouTube",
  web: "Web pages",
  video: "Other video sites",
  douyin: "抖音 Douyin",
  tiktok: "TikTok",
  xhs: "小红书 Xiaohongshu",
  weibo: "微博 Weibo",
  bilibili: "Bilibili",
  kuaishou: "快手 Kuaishou",
  instagram: "Instagram",
  threads: "Threads",
  facebook: "Facebook",
  tieba: "贴吧 Tieba",
  douban: "豆瓣 Douban",
  zhihu: "知乎 Zhihu",
  weixin: "微信公众号 WeChat",
  xiaoheihe: "小黑盒 Xiaoheihe",
  zuiyou: "最右 Zuiyou",
  pipix: "皮皮虾 Pipix",
  coolapk: "酷安 Coolapk",
  snapchat: "Snapchat",
  upload: "Videos uploaded to the group",
};

/** True when a message is only links (plus whitespace), so deleting it loses nothing once cards are posted. */
export function isOnlyLinks(text: string, urls: readonly string[]): boolean {
  let rest = text;
  for (const url of urls) rest = rest.split(url).join(" ");
  return rest.replace(/https?:\/\/\S+/g, " ").trim() === "";
}

export function startsWithBotName(text: string): boolean {
  return NAME_TRIGGER.test(text);
}

/** Remove the bot's @username and a leading "grok," so Grok sees the actual question. */
export function stripAddress(text: string, bot: Bot): string {
  const mention = new RegExp(`@${bot.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  return text.replace(mention, " ").replace(NAME_TRIGGER, "").replace(/\s+/g, " ").trim();
}

/** The user message Grok receives for a group turn. */
export function buildGroupPrompt(options: {
  title?: string;
  context: readonly LogEntry[];
  speaker: string;
  speakerId?: number;
  text: string;
  replyTo?: { name: string; text: string; isBot: boolean };
}): string {
  const lines: string[] = [];
  if (options.context.length > 0) {
    lines.push(`[Recent messages in ${options.title ? `"${options.title}"` : "the group"} since you last spoke]`);
    for (const entry of options.context) lines.push(`${entry.name} [uid:${entry.userId ?? "?"}]: ${entry.text}`);
    lines.push("");
  }
  lines.push("[Message addressed to you]");
  const replying = options.replyTo
    ? ` (replying to ${options.replyTo.isBot ? "you" : options.replyTo.name}: "${truncate(options.replyTo.text, 500)}")`
    : "";
  lines.push(`${options.speaker} [uid:${options.speakerId ?? "?"}]${replying}: ${options.text || "(no text)"}`);
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
