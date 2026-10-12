import { Bot, InputFile, type Context } from "grammy";
import type { ImageStudio } from "../agent/images.ts";
import type { PollDesk } from "../agent/polls.ts";
import type { ActionDesk } from "../agent/actions.ts";
import type { OpsClient } from "../ops.ts";
import type { PermissionStore } from "../permissions.ts";
import type { Db } from "../db.ts";
import { DeleteQueue } from "./deleteQueue.ts";
import type { CookieStore } from "../links/cookies.ts";
import { LIMITS, type LimitStore, type UsageStore } from "../usage.ts";
import { speakableText, toVoiceNote } from "../media/tts.ts";
import { formatCounts } from "./admin.ts";
import type { HealthMonitor } from "../health.ts";
import { installAdmin, renderHealth } from "./admin.ts";
import { MEMBER_HELP, OWNER_HELP } from "./guide.ts";
import { addLocalDays, findTimeZone, formatFromNow, formatLocalTime as formatInZone, timeZone, zoneLabel } from "../time.ts";
import { InputFile as VoiceFile } from "grammy";
import { MAX_FACTS_PER_CHAT, type MemoryStore } from "../memory.ts";
import type { Message } from "grammy/types";
import type { ImageContent } from "@earendil-works/pi-ai";
import { TurnCancelledError, type ChatSessions } from "../agent/sessions.ts";
import { assistantText, CHAT_PROVIDERS, errorMessage, ROUTES, type Grok, type ProbeResult, type Route } from "../grok/grok.ts";
import { extractLinks, isAdultUrl, isTelegramLink, linkKind } from "../links/detect.ts";
import { untrusted } from "../links/reader.ts";
import { summarizeLink, videoCardFromInfo, type LinkSummaryDeps } from "../links/summarize.ts";
import type { VideoReader } from "../media/video.ts";
import type { ParseHubClient } from "../links/parsehub.ts";
import type { UploadLimits } from "../links/phcard.ts";
import { sendPostCard, type PostCardDeps } from "../links/postcard.ts";
import { sendPlainVideoCard } from "../links/videocard.ts";
import { plainWebCard, webPreview, type WebPreview } from "../links/webcard.ts";
import type { CardCache } from "../links/cardCache.ts";
import { inlineResults, urlFromQuery } from "./inline.ts";
import { defaultLanguage } from "../lang.ts";
import { AUTO_VOICE_MAX_SECONDS, documentOf, TelegramMedia, videoOf, voiceOf } from "./media.ts";
import { buildXCard, needsTranslation, sendXCard, type XCard } from "../links/xcard.ts";
import { fetchXPost, type XPost } from "../links/xpost.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { escapeHtml, markdownToTelegramHtml, splitMarkdown } from "./format.ts";
import {
  asksAboutChat,
  buildGroupPrompt,
  describeMessage,
  displayName,
  isAddressedToBot,
  LANGUAGES,
  languageName,
  LINK_MODES,
  isOnlyLinks,
  linksIn,
  PLATFORMS,
  PRIVACY_MODES,
  type PrivacyMode,
  startsWithBotName,
  stripAddress,
  threadIdOf,
  type GroupStore,
  type LinkMode,
} from "./groups.ts";
import { activityLine, ReplyStreamer } from "./streamer.ts";
import { AlbumCollector } from "./albums.ts";
import { RateLimiter } from "./rateLimit.ts";
import { Semaphore } from "../media/run.ts";
import {
  isReminderRequest,
  MAX_REMINDERS_PER_CHAT,
  parseReminderAnswer,
  REMINDER_SYSTEM_PROMPT,
  type Reminder,
  type ReminderStore,
} from "../reminders.ts";
import { MAX_SKILLS_PER_CHAT, parseSkillDefinition, type SkillStore } from "../skills.ts";
import { isWatchRequest, MAX_WATCHES_PER_CHAT, parseWatchAnswer, parseWatchRequest, WATCH_PROMPT, type WatchStore } from "../watches.ts";

export const COMMANDS = [
  { command: "admin", description: "Control panel: AI providers, groups, status (owner)" },
  { command: "new", description: "Start a new conversation" },
  { command: "stop", description: "Stop the current reply" },
  { command: "tr", description: "Reply to a message to translate it (/tr en …)" },
  { command: "img", description: "Create an image, or reply to a photo to change it" },
  { command: "stats", description: "Your usage and what's left of your limits" },
  { command: "schedule", description: "Daily/weekly post written by the bot (owner/trusted)" },
  { command: "lm", description: "Notes I always remember: /lm, /lm add …, /lm del <id>" },
  { command: "remind", description: "Set a reminder: /remind Friday 20:00 meeting (edit · pause · resume)" },
  { command: "reminders", description: "List reminders in this chat" },
  { command: "watch", description: "Tell me when…: /watch every 3h GPT-7 release (owner/trusted)" },
  { command: "watches", description: "List watches in this chat (/unwatch <id> stops one)" },
  { command: "skill", description: "Saved requests: /skill, /skill add 早報 = …, then “grok 早報”" },
  { command: "tz", description: "This chat's time zone: /tz Europe/London" },
  { command: "unremind", description: "Cancel a reminder: /unremind <id>" },
  { command: "status", description: "Login, model and SuperGrok quota" },
  { command: "health", description: "Live check of the bot and its services (owner)" },
  { command: "model", description: "Show or switch the Grok model" },
  { command: "search", description: "Turn web/X search on or off" },
  { command: "links", description: "Group link content: auto | mention | off" },
  { command: "lang", description: "Group translation language" },
  { command: "xstyle", description: "X posts as text or as a picture of the post" },
  { command: "voice", description: "Group voice transcripts: auto | off" },
  { command: "platforms", description: "Turn link content on/off per platform" },
  { command: "privacy", description: "Group privacy: strict | focused | normal" },
  { command: "forget", description: "Delete what the bot stored for this chat (owner)" },
  { command: "tidy", description: "Auto-delete my setting replies after 2 min: on | off" },
  { command: "deletelink", description: "Delete link-only messages after the card: on | off" },
  { command: "enable", description: "Let the bot work in this group (owner)" },
  { command: "disable", description: "Stop the bot in this group (owner)" },
  { command: "login", description: "Sign in with your Grok subscription" },
  { command: "logout", description: "Sign out of Grok" },
  { command: "route", description: "api | proxy | auto (advanced)" },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Focused privacy: questions and answers kept for follow-ups. */
const FOCUSED_TURNS = 6;
/** /tidy: how long setting replies stay. */
const TIDY_DELAY_MS = 2 * 60 * 1000;
/** AI-written scheduled posts per chat (each run uses the AI). */
const MAX_SCHEDULED_POSTS = 5;
/** Commands whose messages and replies are kept even with /tidy on. */
const KEEP_COMMANDS = new Set(["tr", "img", "remind", "enable", "start"]);
/** Default question limits (the owner changes them in /admin → ⚖️ Limits). */
export const QUESTIONS_PER_USER_PER_HOUR = LIMITS.questionsPerUserHour.default;
export const QUESTIONS_PER_GROUP_PER_HOUR = LIMITS.questionsPerGroupHour.default;
/** Callback data of the 📝 Summary button under video cards. */
const SUMMARY_BUTTON = "vsum";

/** Buttons under a video or web card: 📝 (until used) asks the AI for a summary; ▶️ / 🔗 opens the original. */
function linkButtons(url: string, summary: { text: string; callback_data: string } | undefined, open: "▶️" | "🔗") {
  return { inline_keyboard: [[...(summary ? [summary] : []), { text: open, url }]] };
}
// Symbols only: a full-width Telegram button with a short label looks lighter under a video.
const SUMMARY = { text: "📝", callback_data: SUMMARY_BUTTON };
/** A link reposted within this time after its card gets no second card. */
const REPOST_WINDOW_MS = 6 * HOUR;
/** Group answers Grok works on at once; more wait their turn. */
const CONCURRENT_ANSWERS = 3;
/** Automatic downloads and cards (videos, posts, voice) running at once across all groups. */
const CONCURRENT_AUTO_JOBS = 2;

export interface BotDeps {
  token: string;
  ownerId: number;
  grok: Grok;
  sessions: ChatSessions;
  groups: GroupStore;
  reminders: ReminderStore;
  watches: WatchStore;
  skills: SkillStore;
  images: ImageStudio;
  memory: MemoryStore;
  usage: UsageStore;
  limits: LimitStore;
  permissions: PermissionStore;
  /** When given, /tidy deletions are kept in the database and survive restarts. */
  db?: Db;
  /** Site cookies the owner sets in /admin for the ParseHub helper. */
  cookies?: CookieStore;
  polls?: PollDesk;
  /** AI-suggested notes and polls waiting for a ✅ (groups with confirmations on). */
  actions?: ActionDesk;
  ops?: OpsClient;
  /** A database copy without logins, for /admin → Maintenance → Backup. */
  backup?: () => string;
  /** Who is asking in each running answer; read by the remember tool. */
  speakers: Map<string, { userId?: number; userName: string }>;
  /** Scheduled checks and alerts; /health runs them on demand. */
  health?: HealthMonitor;
  /** Draws X posts as pictures for groups with /xstyle picture; without it they stay text cards. */
  xPicture?: (post: XPost, translation: string | undefined) => Promise<Buffer>;
  links: LinkSummaryDeps & {
    video: VideoReader;
    parsehub?: ParseHubClient;
    uploadLimits: UploadLimits;
    cache: CardCache;
    downloaders?: PostCardDeps["downloaders"];
    mediaDir: string;
    /** Title and snippet of a web page for its plain card (default: fetched directly, then the link reader). */
    preview?: (url: string) => Promise<WebPreview | undefined>;
  };
  inlinePublic?: boolean;
  /** Local Bot API server, e.g. http://127.0.0.1:8081 (2000 MB files); default Telegram's cloud. */
  apiRoot?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);
}

function isYouTube(url: string): boolean {
  return /^https?:\/\/([a-z]+\.)?(youtube\.com|youtu\.be)\//i.test(url);
}

type ChatTarget = {
  key: string;
  replyTo?: number;
  threadId?: number;
  logGroup?: { chatId: number; threadId: number };
  /** The question came by voice: answer with a voice note too. */
  speak?: boolean;
  /** Focused privacy: only the last few questions and answers are kept and re-sent. */
  history?: { turns: number; maxAgeMs: number };
  /** Strict privacy: the conversation is never stored. */
  ephemeral?: boolean;
};

/** Commands whose replies only the sender sees in groups (Telegram ephemeral commands, Bot API 10.2). */
const EPHEMERAL_COMMANDS = new Set([
  "help", "start", "stats", "status", "health", "links", "lang", "voice", "platforms", "privacy", "deletelink",
  "tidy", "lm", "reminders", "unremind", "watches", "unwatch", "new", "stop", "forget", "admin", "tz", "xstyle",
]);

export function createBot({
  token,
  ownerId,
  grok,
  sessions,
  groups,
  reminders,
  watches,
  skills,
  images,
  memory,
  speakers,
  usage,
  limits,
  permissions,
  db,
  cookies,
  polls,
  actions,
  ops,
  backup,
  health,
  links,
  inlinePublic = false,
  apiRoot,
  xPicture,
}: BotDeps): Bot {
  const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined);
  const media = new TelegramMedia({ api: bot.api, token, grok, video: links.video, apiRoot });
  // Limits are read on every check, so changes in /admin → ⚖️ Limits apply immediately.
  const autoCards = new RateLimiter(() => limits.get("autoCardsPerGroupHour"), HOUR);
  const autoVoice = new RateLimiter(() => limits.get("autoVoicePerGroupHour"), HOUR);
  const userQuestions = new RateLimiter(() => limits.get("questionsPerUserHour"), HOUR);
  const groupQuestions = new RateLimiter(() => limits.get("questionsPerGroupHour"), HOUR);
  const limitNotices = new RateLimiter(1, 10 * 60 * 1000);
  const answers = new Semaphore(CONCURRENT_ANSWERS);
  const autoJobs = new Semaphore(CONCURRENT_AUTO_JOBS);
  let loginAbort: AbortController | undefined;
  // Failed background tasks also go to /health's error list.
  const background = (ctx: Context, task: () => Promise<void>, options: { quiet?: boolean } = {}) =>
    runInBackground(ctx, task, { ...options, report: (error) => health?.recordError(error) });

  const isOwner = (ctx: Context) => ctx.from?.id === ownerId;
  /** The owner and members the owner marked trusted are never limited. */
  const unlimited = (ctx: Context) => isOwner(ctx) || (ctx.from !== undefined && limits.trusted().has(ctx.from.id));
  const who = (ctx: Context) => ({ id: ctx.from?.id, name: displayName(ctx.from) });

  // Polls asked for in a conversation (create_poll tool) are posted here.
  if (polls) {
    polls.poster = async (chatId, threadId, poll) => {
      await bot.api.sendPoll(
        chatId,
        poll.question,
        poll.options.map((text) => ({ text })),
        { is_anonymous: poll.anonymous, allows_multiple_answers: poll.multiple, ...(threadId ? { message_thread_id: threadId } : {}) },
      );
    };
  }
  const isGroup = (ctx: Context) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

  // A note or poll the AI suggested in a group with ✋ confirmations on: a preview with ✅ / ✖️ buttons.
  if (actions) {
    actions.presenter = async (action) => {
      const who = action.userId ? `${escapeHtml(action.userName)} or the bot owner` : "the bot owner";
      await bot.api.sendMessage(action.chatId, `${action.preview}\n<i>Suggested by the AI; ${who} can confirm.</i>`, {
        parse_mode: "HTML",
        ...(action.threadId ? { message_thread_id: action.threadId } : {}),
        reply_markup: { inline_keyboard: [[{ text: action.label, callback_data: `act:ok:${action.id}` }, { text: "✖️ Discard", callback_data: `act:no:${action.id}` }]] },
      });
    };
    bot.callbackQuery(/^act:(ok|no):([\w-]+)$/, async (ctx) => {
      const [, choice, id] = ctx.match as RegExpMatchArray;
      const action = actions.get(id!);
      const finish = (text: string) =>
        ctx.editMessageText(text, { parse_mode: "HTML" }).catch((error) => console.warn(`confirmation edit failed: ${errorMessage(error)}`));
      if (!action || action.chatId !== ctx.chat?.id) {
        await ctx.answerCallbackQuery({ text: "This suggestion expired." });
        return ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      }
      if (!isOwner(ctx) && ctx.from.id !== action.userId) {
        return ctx.answerCallbackQuery({ text: `Only ${action.userName} or the bot owner can decide this.`, show_alert: true });
      }
      if (!actions.take(id!)) return ctx.answerCallbackQuery();
      const by = escapeHtml(displayName(ctx.from));
      if (choice === "no") {
        await ctx.answerCallbackQuery({ text: "Discarded." });
        return finish(`${action.preview}\n<i>✖️ Discarded by ${by}.</i>`);
      }
      try {
        const result = await action.run();
        await ctx.answerCallbackQuery({ text: result.slice(0, 200) });
        await finish(`${action.preview}\n<i>${escapeHtml(result)} · confirmed by ${by}</i>`);
      } catch (error) {
        await ctx.answerCallbackQuery({ text: `⚠️ ${errorMessage(error)}`.slice(0, 200), show_alert: true });
        await finish(`${action.preview}\n<i>⚠️ Failed: ${escapeHtml(errorMessage(error))}</i>`);
      }
    });
  }

  // Only the owner may add the bot to groups or channels: if anyone else does, it leaves right away.
  bot.on("my_chat_member", async (ctx) => {
    const { old_chat_member: before, new_chat_member: after } = ctx.myChatMember;
    const joined = ["left", "kicked"].includes(before.status) && ["member", "administrator", "restricted"].includes(after.status);
    if (!joined || ctx.chat.type === "private" || ctx.from.id === ownerId) return;
    console.log(`added to ${ctx.chat.type} ${ctx.chat.id} by ${ctx.from.id} (not the owner): leaving`);
    await ctx.leaveChat().catch((error) => console.warn(`leaveChat failed: ${errorMessage(error)}`));
  });

  // Access (managed in /admin → 🔐 Permissions):
  // - private chats: the owner and people with 💬 private access; others may ask the owner for access;
  // - groups the owner enabled: everyone, or only ✅ approved / ⭐ trusted members if the group is set so;
  // - ⛔ blocked people are ignored everywhere. Everything else is ignored.
  bot.use(async (ctx, next) => {
    const stopped = ctx.update.stopped_message_generation;
    // The Stop button under a streaming draft (no sender in this update): only from chats that may use the bot.
    // Drafts are only used in private chats, where the chat id is the user's id.
    if (stopped) {
      const allowed = stopped.chat.type === "private" && (stopped.chat.id === ownerId || permissions.has(stopped.chat.id, "private"));
      return allowed ? next() : undefined;
    }
    const userId = ctx.from?.id;
    if (!isOwner(ctx) && permissions.has(userId, "blocked")) return;
    // Guest Mode: summoned in a chat the bot isn't in; its handler decides who may use it.
    if (ctx.update.guest_message) return next();
    if (ctx.chat?.type === "private") {
      if (isOwner(ctx) || permissions.has(userId, "private")) return next();
      if (ctx.message) await requestAccess(ctx);
      return;
    }
    // Inline queries have no chat; their handler checks who may use inline mode.
    if (ctx.inlineQuery) return next();
    if (!isGroup(ctx)) return;
    const chatId = ctx.chat!.id;
    if (groups.isEnabled(chatId)) {
      // Anonymous admins post as GroupAnonymousBot (is_bot): group admins are never restricted here.
      const restricted = groups.access(chatId) === "approved" && !isOwner(ctx) && ctx.from && !ctx.from.is_bot;
      if (restricted && !permissions.has(userId, "approved") && !permissions.has(userId, "trusted")) return;
      return next();
    }
    if (isOwner(ctx) && /^\/enable(@\w+)?(\s|$)/.test(ctx.message?.text ?? "")) return next();
  });

  /** Access requests reach the owner at most once per person per day, and 20 per day in total. */
  const accessRequests = new RateLimiter(1, 24 * HOUR);
  const accessRequestsTotal = new RateLimiter(20, 24 * HOUR);

  /** A stranger wrote privately: tell them the bot is private and ask the owner (Allow / Block buttons). */
  async function requestAccess(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user || user.is_bot || !accessRequests.take(String(user.id)) || !accessRequestsTotal.take("all")) return;
    await ctx.reply("🔒 This bot is private. I've asked its owner whether you may use it.").catch(() => undefined);
    const name = displayName(user);
    const handle = user.username ? ` (@${user.username})` : "";
    await bot.api
      .sendMessage(ownerId, `🔐 <b>${escapeHtml(name)}</b>${escapeHtml(handle)} · id <code>${user.id}</code> wants to chat with the bot privately.`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Allow private chat", callback_data: `adm:req:${user.id}:allow` },
              { text: "⛔ Block", callback_data: `adm:req:${user.id}:block` },
            ],
            [{ text: "Ignore", callback_data: `adm:req:${user.id}:ignore` }],
          ],
        },
      })
      .catch((error) => console.warn(`access request not sent: ${errorMessage(error)}`));
    permissions.remember(user.id, { name, username: user.username });
  }

  // Remember what is said in enabled groups; it becomes context when someone talks to the bot.
  bot.use(async (ctx, next) => {
    const message = ctx.message;
    if (message && isGroup(ctx) && !message.text?.startsWith("/") && groups.privacy(ctx.chat!.id) !== "strict") {
      const text = describeMessage(message);
      if (text) {
        groups.log(ctx.chat!.id, threadIdOf(message), {
          messageId: message.message_id,
          userId: message.from?.id,
          name: displayName(message.from),
          text,
          isBot: message.from?.is_bot ?? false,
          at: Date.now(),
        });
      }
    }
    return next();
  });

  /** Delete a message later (the bot's own messages always; others' only when the bot is an admin). */
  const deletes = db ? new DeleteQueue(db, bot.api) : undefined;
  if (deletes) void deletes.resume().catch((error) => console.warn(`pending deletes: ${errorMessage(error)}`));
  const deleteLater = (chatId: number, messageId: number, delayMs = TIDY_DELAY_MS) => {
    if (deletes) return deletes.schedule(chatId, messageId, delayMs);
    setTimeout(() => void bot.api.deleteMessage(chatId, messageId).catch(() => undefined), delayMs).unref();
  };

  // Ephemeral commands (only the sender sees them): answer privately too. Telegram allows that within 15 s.
  bot.use(async (ctx, next) => {
    const ephemeralId = ctx.message?.ephemeral_message_id;
    if (!ephemeralId || !isGroup(ctx) || !ctx.from) return next();
    const chatId = ctx.chat!.id;
    const receiver = ctx.from.id;
    ctx.reply = ((text: string, other?: Record<string, unknown>) => {
      const { reply_parameters: _ignored, ...rest } = other ?? {};
      return bot.api.sendMessage(chatId, text, {
        ...rest,
        reply_parameters: { ephemeral_message_id: ephemeralId },
        ephemeral_message_parameters: { receiver_user_id: receiver },
      } as never);
    }) as typeof ctx.reply;
    return next();
  });

  /** A notice for one member only: private when Telegram allows it (bot is admin), else a normal reply that /tidy removes. */
  async function notifyMember(ctx: Context, text: string, threadId?: number): Promise<void> {
    const chatId = ctx.chat!.id;
    const thread = threadId ? { message_thread_id: threadId } : {};
    try {
      await bot.api.sendMessage(chatId, text, { ...thread, ephemeral_message_parameters: { receiver_user_id: ctx.from!.id } } as never);
    } catch {
      const sent = await bot.api.sendMessage(chatId, text, {
        ...thread,
        ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } } : {}),
      });
      if (groups.tidy(chatId)) deleteLater(chatId, sent.message_id);
    }
  }

  // Tidy groups: commands for settings and lists, and the bot's replies to them, disappear after a while.
  // Commands whose result people want to keep (/tr, /img, /remind, /enable) are left alone.
  bot.use(async (ctx, next) => {
    const message = ctx.message;
    const command = message?.entities?.[0]?.type === "bot_command" && message.entities[0].offset === 0
      ? message.text!.slice(1, message.entities[0].length).toLowerCase().split("@")
      : undefined;
    if (!command || !isGroup(ctx) || !groups.tidy(ctx.chat!.id) || message?.ephemeral_message_id) return next();
    const [name = "", target] = command;
    if ((target && target !== ctx.me.username.toLowerCase()) || KEEP_COMMANDS.has(name)) return next();
    const chatId = ctx.chat!.id;
    deleteLater(chatId, message!.message_id);
    const reply = ctx.reply.bind(ctx);
    ctx.reply = (async (...args: Parameters<typeof reply>) => {
      const sent = await reply(...args);
      deleteLater(chatId, sent.message_id);
      return sent;
    }) as typeof ctx.reply;
    return next();
  });

  installAdmin(bot, {
    ownerId,
    grok,
    groups,
    health,
    onStrict: (chatId) => {
      groups.forget(chatId);
      sessions.forgetChat(chatId);
    },
    onFocused: (chatId) => applyFocused(chatId),
    usage,
    limits,
    permissions,
    ops,
    backup,
    cookies,
  });

  // Owner-only commands. In groups, others get a short refusal.
  const ownerOnly = (handler: (ctx: Context & { match: string }) => unknown) => async (ctx: Context & { match: string }) => {
    if (!isOwner(ctx)) return ctx.reply("Only the bot owner can do that.");
    return handler(ctx);
  };

  // In groups only the owner may wipe the bot's memory or stop answers meant for others; in private chats it's your own.
  const ownerInGroups = (handler: (ctx: Context & { match: string }) => unknown) => (ctx: Context & { match: string }) =>
    isGroup(ctx) ? ownerOnly(handler)(ctx) : handler(ctx);

  // Same text as /admin → 📖 Guide (src/telegram/guide.ts).
  bot.command(["start", "help"], (ctx) =>
    ctx.reply(isOwner(ctx) && !isGroup(ctx) ? OWNER_HELP : MEMBER_HELP, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
  );

  bot.command(
    "enable",
    ownerOnly(async (ctx) => {
      if (!isGroup(ctx)) return ctx.reply("Use /enable inside a group.");
      groups.enable(ctx.chat!.id, ctx.chat && "title" in ctx.chat ? ctx.chat.title : undefined);
      const lines = [
        "✅ Enabled in this group.",
        "• Mention me, reply to me, or start with “grok” (“grok, …” or “grok analyze this”) to ask something.",
        `• Links: <b>${groups.linkMode(ctx.chat!.id)}</b> — I show what links contain; I comment only when asked (/links auto|mention|off).`,
        `• Translation language: <b>${groups.language(ctx.chat!.id)}</b> (/lang).`,
        `• Privacy: <b>${groups.privacy(ctx.chat!.id)}</b> (/privacy).`,
      ];
      if (!ctx.me.can_read_all_group_messages) {
        lines.push(
          "",
          "⚠️ <b>Privacy mode is on</b>, so I only see messages that mention me. For automatic link summaries, “grok,” and chat context:",
          "@BotFather → /setprivacy → choose this bot → <b>Disable</b>, then remove me from this group and add me again (or make me an admin).",
        );
      }
      return ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    }),
  );

  bot.command(
    "disable",
    ownerOnly(async (ctx) => {
      if (!isGroup(ctx)) return ctx.reply("Use /disable inside a group.");
      groups.disable(ctx.chat!.id);
      sessions.forgetChat(ctx.chat!.id);
      reminders.forgetChat(ctx.chat!.id);
      watches.forgetChat(ctx.chat!.id);
      skills.forgetChat(ctx.chat!.id);
      memory.forgetChat(ctx.chat!.id);
      return ctx.reply("Disabled. I'll ignore this group until the owner sends /enable.");
    }),
  );

  bot.command("links", async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply("Link summaries are a group setting. In private chat, just send me a link.");
    const arg = ctx.match.trim().toLowerCase();
    if ((LINK_MODES as readonly string[]).includes(arg)) {
      if (!isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
      groups.setLinkMode(ctx.chat!.id, arg as LinkMode);
    }
    const mode = groups.linkMode(ctx.chat!.id);
    const explain = {
      auto: "I show the content of every link posted here (no comments unless asked).",
      mention: "I read links only when someone asks me.",
      off: "I don't show link content.",
    }[mode];
    return ctx.reply(`Links: ${mode}. ${explain}\nOwner can change it: /links auto | mention | off`);
  });

  bot.command("privacy", async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply("Privacy is a group setting.");
    const arg = ctx.match.trim().toLowerCase();
    if ((PRIVACY_MODES as readonly string[]).includes(arg)) {
      if (!isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
      groups.setPrivacy(ctx.chat!.id, arg as PrivacyMode);
      if (arg === "strict") {
        groups.forget(ctx.chat!.id);
        sessions.forgetChat(ctx.chat!.id);
      }
      if (arg === "focused") applyFocused(ctx.chat!.id);
    }
    return ctx.reply(privacyText(groups.privacy(ctx.chat!.id)), { parse_mode: "HTML" });
  });

  bot.command(
    "forget",
    ownerInGroups(async (ctx) => {
      const removedReminders = reminders.forgetChat(ctx.chat!.id) + watches.forgetChat(ctx.chat!.id);
      const removedNotes = memory.forgetChat(ctx.chat!.id) + skills.forgetChat(ctx.chat!.id);
      usage.forgetChat(ctx.chat!.id);
      images.forgetChat(ctx.chat!.id);
      if (!isGroup(ctx)) {
        sessions.forgetChat(ctx.chat!.id);
        return ctx.reply(`🧹 Our private conversation history, ${removedReminders} reminder(s) and ${removedNotes} note(s) are deleted.`);
      }
      const logged = groups.forget(ctx.chat!.id);
      const conversations = sessions.forgetChat(ctx.chat!.id);
      return ctx.reply(
        `🧹 Deleted ${logged} logged messages, ${conversations} stored conversation(s), ${removedReminders} reminder(s) and ${removedNotes} note(s) for this group.`,
      );
    }),
  );

  bot.command("platforms", async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply("Platforms are a group setting.");
    const [action, ...names] = ctx.match.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (action === "on" || action === "off") {
      if (!isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
      const unknown = names.filter((name) => !(name in PLATFORMS));
      if (names.length === 0 || unknown.length) return ctx.reply(`Unknown platform: ${unknown.join(", ") || "(none)"}. Use names from /platforms.`);
      groups.setPlatforms(ctx.chat!.id, names, action === "on");
    }
    const disabled = groups.disabledPlatforms(ctx.chat!.id);
    const lines = Object.entries(PLATFORMS).map(([id, name]) => `${disabled.has(id) ? "⛔" : "✅"} <code>${id}</code> ${escapeHtml(name)}`);
    return ctx.reply(`Link content per platform:\n${lines.join("\n")}\n\nOwner: <code>/platforms off douyin weibo</code> · <code>/platforms on douyin</code>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("tidy", async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply("This is a group setting.");
    const arg = ctx.match.trim().toLowerCase();
    if (arg === "on" || arg === "off") {
      if (!isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
      groups.setTidy(ctx.chat!.id, arg === "on");
    }
    const on = groups.tidy(ctx.chat!.id);
    return ctx.reply(
      `Tidy: ${on ? "on" : "off"}. ${on ? "Setting commands and my replies to them disappear after 2 minutes (deleting your command needs me to be an admin)." : "Setting replies stay."}\nOwner: /tidy on | off`,
    );
  });

  bot.command("lm", (ctx) => {
    const chatId = ctx.chat.id;
    const args = ctx.match.trim();
    const [first = "", ...rest] = args.split(/\s+/);
    const verb = first.toLowerCase();
    if (!args || verb === "list") {
      const facts = memory.list(chatId);
      const lines = facts.map((f) => `<code>${f.id}</code> ${escapeHtml(f.text)} <i>— ${escapeHtml(f.userName)}</i>`);
      return ctx.reply(
        [
          facts.length ? `📝 Notes I always remember here (${facts.length}/${MAX_FACTS_PER_CHAT}):` : "📝 No notes yet.",
          ...lines,
          "",
          "Add: <code>/lm add 小明吃素</code> or say “grok, 記住小明吃素”",
          "Delete: <code>/lm del &lt;id&gt;</code> (the person who added it, or the owner)",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    }
    if (["del", "delete", "rm", "remove"].includes(verb)) {
      const fact = memory.get(chatId, Number(rest[0]?.replace(/^#/, "")));
      if (!fact) return ctx.reply("No such note here. /lm lists them with their ids.");
      if (!isOwner(ctx) && fact.userId !== ctx.from?.id) return ctx.reply("Only the person who added it (or the bot owner) can delete it.");
      memory.remove(fact.id);
      return ctx.reply(`🗑 Forgot: ${fact.text}`);
    }
    const text = verb === "add" ? rest.join(" ") : args;
    const result = memory.add(chatId, text, { userId: ctx.from?.id, userName: displayName(ctx.from) });
    return ctx.reply(result.ok ? `📝 Noted (#${result.fact.id}): ${result.fact.text}` : `Not saved: ${result.reason}.`);
  });

  bot.command("deletelink", async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply("This is a group setting.");
    const arg = ctx.match.trim().toLowerCase();
    if (arg === "on" || arg === "off") {
      if (!isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
      groups.setDeleteLink(ctx.chat!.id, arg === "on");
    }
    const on = groups.deleteLink(ctx.chat!.id);
    return ctx.reply(
      `Delete link-only messages after posting their content: ${on ? "on" : "off"}.` +
        (on ? " I need to be an admin with “Delete messages” for this." : "") +
        "\nOwner: /deletelink on | off",
    );
  });

  bot.command("voice", async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply("In private chat I always transcribe voice messages.");
    const arg = ctx.match.trim().toLowerCase();
    if (arg === "auto" || arg === "off") {
      if (!isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
      groups.setVoiceMode(ctx.chat!.id, arg);
    }
    const mode = groups.voiceMode(ctx.chat!.id);
    return ctx.reply(
      `Voice messages: ${mode}. ${mode === "auto" ? "I post a transcript (and translation) of every voice message." : "I transcribe only when asked."}\nOwner can change it: /voice auto | off`,
    );
  });

  bot.command("xstyle", async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply("The X post style is a group setting.");
    const arg = ctx.match.trim().toLowerCase();
    if (arg === "text" || arg === "picture") {
      if (!isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
      groups.setXStyle(ctx.chat!.id, arg);
    }
    const style = groups.xStyle(ctx.chat!.id);
    return ctx.reply(
      `X posts: ${style}. ${style === "picture" ? "Each post is drawn like on X, with its text folded below." : "Each post is shown as text under its images."}\nOwner can change it: /xstyle text | picture`,
    );
  });

  bot.command("lang", async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply("Language is a group setting; in private chat I reply in your language.");
    const arg = ctx.match.trim().toLowerCase();
    if (arg) {
      if (!isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
      if (!(arg in LANGUAGES)) return ctx.reply(`Unknown language. Choose: ${Object.keys(LANGUAGES).join(" | ")}`);
      groups.setLanguage(ctx.chat!.id, arg);
    }
    const lang = groups.language(ctx.chat!.id);
    return ctx.reply(
      `Translations and link cards: ${lang} (${languageName(lang)}).\nOwner can change it: /lang ${Object.keys(LANGUAGES).join(" | ")}`,
    );
  });

  bot.command(
    "login",
    ownerOnly((ctx) => {
      if (isGroup(ctx)) return ctx.reply("Please run /login in our private chat.");
      loginAbort?.abort();
      const abort = new AbortController();
      loginAbort = abort;
      background(ctx, async () => {
        await ctx.reply("Starting Grok login…");
        await grok.login(async (code) => {
          const minutes = code.expiresInSeconds ? Math.round(code.expiresInSeconds / 60) : undefined;
          await ctx.reply(
            [
              "<b>Approve this bot in your browser</b>",
              `1. Open: ${escapeHtml(code.url)}`,
              `2. Code: <code>${escapeHtml(code.userCode)}</code>`,
              minutes ? `Expires in ${minutes} min. Never share this code.` : "Never share this code.",
            ].join("\n"),
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
          );
        }, abort.signal);
        await ctx.reply("✅ Logged in. Checking which endpoint your plan allows…");
        const results = await grok.selectRoute(abort.signal);
        await ctx.reply(describeProbe(results, grok.route), { parse_mode: "HTML" });
      });
    }),
  );

  bot.command(
    "logout",
    ownerOnly(async (ctx) => {
      loginAbort?.abort();
      await grok.logout();
      await ctx.reply("Logged out of Grok.");
    }),
  );

  bot.command(
    "new",
    ownerInGroups(async (ctx) => {
      sessions.reset(sessionKey(ctx.chat!.id, ctx.message ? threadIdOf(ctx.message) : 0));
      await ctx.reply("🆕 New conversation.");
    }),
  );

  bot.command(
    "stop",
    ownerInGroups(async (ctx) => {
      // Groups: every running answer (strict mode runs one conversation per question).
      const stopped = isGroup(ctx) ? sessions.abortChat(ctx.chat!.id) > 0 : sessions.abort(sessionKey(ctx.chat!.id, 0));
      await ctx.reply(stopped ? "Stopped." : "Nothing is running.");
    }),
  );

  bot.command(
    "model",
    ownerOnly(async (ctx) => {
      const wanted = ctx.match.trim();
      if (wanted) {
        try {
          grok.modelId = wanted;
          await ctx.reply(`Model set to <code>${escapeHtml(wanted)}</code>.`, { parse_mode: "HTML" });
        } catch (error) {
          await ctx.reply(errorMessage(error));
        }
        return;
      }
      const lines = grok.listModelIds().map((id) => (id === grok.modelId ? `• <b>${id}</b> (current)` : `• ${id}`));
      await ctx.reply(`Models:\n${lines.join("\n")}\n\nSwitch with <code>/model grok-4.7</code>`, { parse_mode: "HTML" });
    }),
  );

  bot.command(
    "search",
    ownerOnly(async (ctx) => {
      const arg = ctx.match.trim().toLowerCase();
      if (arg === "on" || arg === "off") grok.hostedSearch = arg === "on";
      await ctx.reply(`Web/X search is ${grok.hostedSearch ? "on" : "off"}. Use /search on|off.`);
    }),
  );

  bot.command(
    "route",
    ownerOnly((ctx) => {
      const arg = ctx.match.trim().toLowerCase();
      if ((ROUTES as readonly string[]).includes(arg)) {
        grok.route = arg as Route;
        return ctx.reply(`Route set to ${arg}.`);
      }
      if (arg !== "auto") return ctx.reply(`Route is ${grok.route}. Use /route api|proxy|auto.`);
      background(ctx, async () => {
        const results = await grok.selectRoute();
        await ctx.reply(describeProbe(results, grok.route), { parse_mode: "HTML" });
      });
    }),
  );

  bot.command(
    "health",
    ownerOnly((ctx) => {
      background(ctx, async () => void (await ctx.reply(await renderHealth(health), { parse_mode: "HTML" })));
    }),
  );

  bot.command(
    "status",
    ownerOnly((ctx) => {
      background(ctx, async () => {
        const loggedIn = await grok.signedIn("xai");
        const lines: string[] = [];
        for (const p of grok.chain) {
          lines.push(`${CHAT_PROVIDERS[p].name}: ${(await grok.signedIn(p)) ? "✅" : "❌"} ${grok.providerModelId(p)}`);
        }
        lines.push(
          `Grok login: ${loggedIn ? "✅" : "❌ (use /login)"}`,
          `Route: ${grok.route}`,
          `Web/X search: ${grok.hostedSearch ? "on" : "off"}`,
          `Link reader: ${links.reader.hasTavily ? "Tavily + direct fallback" : "direct fetch only"}`,
          "Providers and order: /admin",
        );
        if (isGroup(ctx)) {
          lines.push(`This group: links ${groups.linkMode(ctx.chat!.id)}, language ${groups.language(ctx.chat!.id)}, privacy ${groups.privacy(ctx.chat!.id)}`);
        }
        if (loggedIn) {
          try {
            const quota = await grok.quota();
            const used = quota.usedPercent !== undefined ? `${quota.usedPercent.toFixed(1)}% used` : "usage not reported";
            const resets = quota.resetsAt ? `, resets ${formatLocalIso(quota.resetsAt)}` : "";
            lines.push(`Quota: ${used}${quota.window ? ` (${quota.window})` : ""}${resets}`);
            if (quota.plan) lines.push(`Plan: ${quota.plan}`);
          } catch (error) {
            lines.push(`Quota: unavailable (${errorMessage(error)})`);
          }
        }
        await ctx.reply(lines.join("\n"));
      });
    }),
  );

  bot.command("tr", (ctx) => runTr(ctx, ctx.message!, ctx.match));

  /**
   * /tr [lang] [text]. Translates the text given, else the replied message, else
   * the media the command is the caption of (a screenshot captioned “/tr”).
   */
  function runTr(ctx: Context, message: Message, args: string, ownMedia?: Message) {
    const chatId = ctx.chat!.id;
    const threadId = threadIdOf(message);
    const [first = "", ...rest] = args.trim().split(/\s+/);
    const explicit = first.toLowerCase() in LANGUAGES && first.toLowerCase() !== "off" ? first.toLowerCase() : undefined;
    const ownText = (explicit ? rest.join(" ") : args).trim();
    const source = ownText ? undefined : (realReply(message) ?? ownMedia);
    if (!ownText && !source) {
      return ctx.reply(`Reply to a message (text, voice or photo) with /tr to translate it. Other language: /tr en (${Object.keys(LANGUAGES).filter((l) => l !== "off").join(", ")}).`);
    }
    if (!mayAsk(ctx, chatId)) return refuseOverLimit(ctx, message, threadId);
    const groupLang = isGroup(ctx) ? groups.language(chatId) : defaultLanguage();
    const lang = explicit ?? (groupLang === "off" ? defaultLanguage() : groupLang);
    background(ctx, async () => {
      const typing = keepTyping(ctx, threadId);
      let translation: string;
      try {
        // The caption of our own media is the command itself, not text to translate.
        translation = await translateForTr(ownText, source, lang, source === ownMedia);
        usage.record(chatId, who(ctx), "tr");
      } finally {
        typing.stop();
      }
      // Reply to the translated message itself, so it's clear what the translation belongs to.
      const ids = await new ReplyStreamer(bot.api, chatId, { replyTo: source?.message_id ?? message.message_id, threadId }).finish(`🌐 ${translation}`);
      answered(chatId, ids);
      if (isGroup(ctx)) logBotMessage(ctx, chatId, threadId, ids[0], `[translation]\n${translation}`);
    });
  }

  bot.command("img", (ctx) => runImg(ctx, ctx.message!, ctx.match));

  /** /img <description>: a new image; as a reply to a photo (or a photo's caption), that photo changed as described. */
  function runImg(ctx: Context, message: Message, args: string, ownMedia?: Message) {
    const chatId = ctx.chat!.id;
    const threadId = threadIdOf(message);
    const prompt = args.trim();
    if (!prompt) {
      return ctx.reply("Examples:\n/img a shiba inu astronaut, watercolor\nReply to a photo: /img 改成吉卜力動畫風格\n\nOr just ask: grok, 畫一隻戴太空頭盔的柴犬");
    }
    if (!images.allow(ctx.from?.id, unlimited(ctx))) return ctx.reply("You reached today's image limit. Try again tomorrow.");
    const source = [realReply(message), ownMedia].find((m) => m?.photo);
    background(ctx, async () => {
      if (!(await grok.isLoggedIn())) return void (await ctx.reply("The bot owner needs to log in to Grok first."));
      const other = threadId ? { message_thread_id: threadId } : undefined;
      const action = () => void ctx.replyWithChatAction("upload_photo", other).catch(() => undefined);
      action();
      const timer = setInterval(action, 4500);
      try {
        const photo = source ? await media.photo(source) : undefined;
        const image = await images.create(sessionKey(chatId, threadId), prompt, { sources: photo ? [photo] : undefined });
        answered(chatId, await postImages(chatId, [image], message.message_id, threadId));
        usage.record(chatId, who(ctx), "image");
      } finally {
        clearInterval(timer);
      }
    });
  }

  async function postImages(chatId: number, created: Buffer[], replyTo: number | undefined, threadId: number | undefined): Promise<number[]> {
    if (created.length === 0) return [];
    const other = {
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      ...(threadId ? { message_thread_id: threadId } : {}),
    };
    if (created.length === 1) return [(await bot.api.sendPhoto(chatId, new InputFile(created[0]!, "image.jpg"), other)).message_id];
    const sent = await bot.api.sendMediaGroup(
      chatId,
      created.map((image, i) => ({ type: "photo" as const, media: new InputFile(image, `image${i + 1}.jpg`) })),
      other,
    );
    return sent.map((message) => message.message_id);
  }

  bot.command("remind", (ctx) => {
    if (!ctx.from || !ctx.message) return;
    const message = ctx.message;
    const request = ctx.match.trim();
    if (!request) {
      return ctx.reply(
        "Examples:\n/remind tomorrow 9:00 call the bank\n/remind 週五晚上8點 開會\n/remind every Monday 10:00 weekly report\n/remind in 30 minutes check the oven\n\n" +
          "Change one: /remind edit 3 改到9點 · /remind pause 3 · /remind resume 3 (ids in /reminders)\n\nOr just say: grok, 提醒我們明天下午3點交報告",
      );
    }
    // "/remind edit 3 …", "/remind pause 3", "/remind resume 3"
    const manage = request.match(/^(edit|pause|resume)\s+#?(\d+)(?:\s+([\s\S]+))?$/i);
    if (manage) {
      const action = manage[1]!.toLowerCase();
      const reminder = reminders.get(ctx.chat.id, Number(manage[2]));
      if (!reminder || !reminders.isActive(reminder.id)) return ctx.reply("No such reminder here. See /reminders for the ids.");
      if (!mayManage(ctx, reminder)) return ctx.reply("Only the person who set it (or the bot owner) can change it.");
      if (action !== "edit") {
        const updated = reminders.setPaused(reminder, action === "pause");
        return ctx.reply(updated.paused ? `⏸ Paused: ${updated.text}` : `▶️ Resumed: ${updated.text}, next ${formatInZone(updated.dueAt, reminders.zone(ctx.chat.id))}`);
      }
      if (!manage[3]) return ctx.reply(`What should change? e.g. /remind edit ${reminder.id} 改到明天早上9點`);
      if (!mayAsk(ctx, ctx.chat.id)) return refuseOverLimit(ctx, message, threadIdOf(message));
      background(ctx, async () => {
        const failure = await createReminder(ctx, message, manage[3]!, reminder.ai, reminder);
        if (failure) await ctx.reply(`⏰ I couldn't change that: ${failure}.`);
      });
      return;
    }
    if (!mayAsk(ctx, ctx.chat.id)) return refuseOverLimit(ctx, message, threadIdOf(message));
    background(ctx, async () => {
      const failure = await createReminder(ctx, message, request);
      if (failure) await ctx.reply(`⏰ I couldn't set that: ${failure}. Try e.g. /remind Friday 20:00 meeting`);
    });
  });

  /** Who may change, pause, snooze or cancel a reminder: whoever set it, and the owner. */
  function mayManage(ctx: Context, reminder: Reminder): boolean {
    return isOwner(ctx) || (ctx.from !== undefined && reminder.userId === ctx.from.id);
  }

  // Buttons under reminder confirmations and delivered reminders: rem:<action>:<id>[:<arg>]
  bot.callbackQuery(/^rem:(p|r|x|s):(\d+)(?::(\w+))?$/, async (ctx) => {
    const [, action, idText, arg] = ctx.match as RegExpMatchArray;
    const chatId = ctx.chat?.id;
    const reminder = chatId === undefined ? undefined : reminders.get(chatId, Number(idText));
    if (!reminder) return ctx.answerCallbackQuery({ text: "That reminder no longer exists." });
    if (!mayManage(ctx, reminder)) return ctx.answerCallbackQuery({ text: "Only the person who set it (or the bot owner) can change it.", show_alert: true });
    const zone = reminders.zone(reminder.chatId);
    const by = displayName(ctx.from);
    let note: string;
    if (action === "x") {
      reminders.remove(reminder.id);
      note = `🗑 Cancelled by ${by}`;
    } else if (action === "p" || action === "r") {
      if (!reminders.isActive(reminder.id)) return ctx.answerCallbackQuery({ text: "That reminder was already delivered." });
      const updated = reminders.setPaused(reminder, action === "p");
      note = updated.paused ? `⏸ Paused by ${by} · /remind resume ${reminder.id}` : `▶️ Resumed · next ${formatInZone(updated.dueAt, zone)}`;
    } else {
      const now = Date.now();
      const until = arg === "tm" ? addLocalDays(now, 1, zone) : now + Math.min(Number(arg) || 10, 24 * 60) * 60_000;
      reminders.snooze(reminder, until, now);
      note = `💤 Snoozed to ${formatInZone(until, zone)} by ${by}`;
    }
    await ctx.answerCallbackQuery({ text: note.slice(0, 200) });
    // The buttons are replaced by what happened, so everyone in the chat sees it.
    await ctx
      .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: note.slice(0, 60), callback_data: "rem:done" }]] } })
      .catch(() => undefined);
  });
  bot.callbackQuery("rem:done", (ctx) => ctx.answerCallbackQuery());

  // ⏹ under a watch confirmation or alert.
  bot.callbackQuery(/^wat:x:(\d+)$/, async (ctx) => {
    const watch = ctx.chat ? watches.get(ctx.chat.id, Number(ctx.match![1])) : undefined;
    if (!watch) return ctx.answerCallbackQuery({ text: "That watch was already stopped." });
    if (!isOwner(ctx) && ctx.from?.id !== watch.userId) return ctx.answerCallbackQuery({ text: "Only the person who set it (or the bot owner) can stop it.", show_alert: true });
    watches.remove(watch.id);
    const note = `⏹ Stopped by ${displayName(ctx.from)}`;
    await ctx.answerCallbackQuery({ text: note });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: note.slice(0, 60), callback_data: "rem:done" }]] } }).catch(() => undefined);
  });

  bot.command("watch", (ctx) => {
    if (!ctx.message) return;
    const message = ctx.message;
    const request = ctx.match.trim();
    if (!request) {
      return ctx.reply(
        "I check every few hours with web and X search and post here only when something new comes up:\n" +
          "/watch GPT-7 發布的時候告訴我\n/watch every 6h new releases of github.com/yt-dlp/yt-dlp\n\n" +
          "Or just say: grok, tell me when … · /watches lists them, /unwatch <id> stops one.",
      );
    }
    background(ctx, () => createWatch(ctx, message, request));
  });

  bot.command("skill", (ctx) => {
    if (!ctx.message) return;
    const message = ctx.message;
    const chatId = ctx.chat.id;
    const arg = ctx.match.trim();
    const verb = arg.split(/\s+/)[0] ?? "";
    const after = arg.slice(verb.length).trim();
    if (!arg) {
      const list = skills.list(chatId);
      const lines = list.map((k) => `• <b>${escapeHtml(k.name)}</b> → ${escapeHtml(k.prompt.slice(0, 100))}${k.prompt.length > 100 ? "…" : ""} <i>(${k.uses}×)</i>`);
      return ctx.reply(
        `${list.length ? `<b>Saved requests here</b>\n${lines.join("\n")}\n\nRun one: <code>grok ${escapeHtml(list[0]!.name)}</code>, or add to it: <code>grok ${escapeHtml(list[0]!.name)} …</code>` : "No saved requests here yet."}\n\n` +
          "Save one (owner and ⭐ trusted): <code>/skill add 早報 = 搜今天最重要的5條AI新聞，每條一行附連結</code>\nDelete: <code>/skill del 早報</code> · Daily: <code>/schedule 每天早上8點 早報</code>",
        { parse_mode: "HTML" },
      );
    }
    if (verb === "add" || verb === "del" || verb === "delete") {
      if (!unlimited(ctx)) return ctx.reply("Only the owner and trusted members can change saved requests.");
      if (verb !== "add") return ctx.reply(skills.remove(chatId, after) ? `🗑 Deleted ${after}.` : `There's no saved request called ${after} here.`);
      const parsed = parseSkillDefinition(after);
      if ("error" in parsed) return ctx.reply(`${parsed.error}, e.g. /skill add 早報 = 搜今天最重要的5條AI新聞`);
      if (!skills.get(chatId, parsed.name) && skills.count(chatId) >= MAX_SKILLS_PER_CHAT) return ctx.reply(`This chat already has ${MAX_SKILLS_PER_CHAT} saved requests; delete one first.`);
      skills.set(chatId, parsed.name, parsed.prompt, who(ctx));
      return ctx.reply(`✅ Saved <b>${escapeHtml(parsed.name)}</b>. Run it with <code>grok ${escapeHtml(parsed.name)}</code>.`, { parse_mode: "HTML" });
    }
    // "/skill 早報 …": run it like a question.
    if (!skills.get(chatId, verb)) return ctx.reply(`There's no saved request called ${verb} here. /skill lists them.`);
    if (!mayAsk(ctx, chatId)) return refuseOverLimit(ctx, message, threadIdOf(message));
    if (isGroup(ctx)) return background(ctx, () => answers.use(() => answerInGroup(ctx, message, threadIdOf(message))));
    return background(ctx, () => chat(ctx, { text: skills.expand(chatId, arg).text }, { key: sessionKey(chatId, 0) }));
  });

  bot.command("watches", (ctx) => {
    const list = watches.list(ctx.chat.id);
    if (list.length === 0) return ctx.reply("Nothing is being watched here. Start with /watch, e.g. /watch GPT-7 release");
    const now = Date.now();
    const lines = list.map(
      (w) =>
        `#${w.id} 👀 <b>${escapeHtml(w.task.slice(0, 120))}</b>\n   every ${w.everyHours} h · next check ${formatFromNow(w.nextAt, now)} · ${w.alerts} alert(s) · by ${escapeHtml(w.userName)}` +
        (w.lastError ? `\n   ⚠️ last check failed: ${escapeHtml(w.lastError.slice(0, 100))}` : ""),
    );
    return ctx.reply(`${lines.join("\n")}\n\nStop one: <code>/unwatch ${list[0]!.id}</code>`, { parse_mode: "HTML" });
  });

  bot.command("unwatch", (ctx) => {
    const watch = watches.get(ctx.chat.id, Number(ctx.match.trim().replace(/^#/, "")));
    if (!watch) return ctx.reply("No such watch here. See /watches for the ids.");
    if (!isOwner(ctx) && ctx.from?.id !== watch.userId) return ctx.reply("Only the person who set it (or the bot owner) can stop it.");
    watches.remove(watch.id);
    return ctx.reply(`⏹ Stopped watching: ${watch.task}`);
  });

  /**
   * /watch and "grok, tell me when…": one check now, so the reply shows what the bot found and
   * understood; later checks post only news. Each check uses the AI, so owner and trusted members only.
   */
  async function createWatch(ctx: Context, message: Message, request: string): Promise<void> {
    const chatId = ctx.chat!.id;
    const threadId = threadIdOf(message);
    const reply = (html: string, extra: Record<string, unknown> = {}) =>
      ctx.reply(html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        ...(threadId ? { message_thread_id: threadId } : {}),
        ...extra,
      });
    if (!unlimited(ctx)) return void (await reply("👀 Watches use the AI every few hours, so only the owner and trusted members can set them."));
    if (!(await grok.isLoggedIn())) return void (await reply("The bot owner needs to log in to Grok first."));
    if (watches.count(chatId) >= MAX_WATCHES_PER_CHAT) return void (await reply(`👀 This chat already has ${MAX_WATCHES_PER_CHAT} watches. Stop one first (/watches).`));
    const { everyHours, task } = parseWatchRequest(request);
    if (task.length < 3) return void (await reply("👀 What should I watch? e.g. <code>/watch GPT-7 release</code>"));
    const typing = keepTyping(ctx, threadId);
    let found;
    try {
      found = parseWatchAnswer(await grok.ask(WATCH_PROMPT(Date.now(), groups.timeZone(chatId), undefined), task, { search: true }), undefined);
    } catch (error) {
      return void (await reply(`👀 I couldn't start that watch: ${escapeHtml(errorMessage(error))}`));
    } finally {
      typing.stop();
    }
    usage.record(chatId, who(ctx), "watch");
    if (found.done) return void (await reply(`👀 That has already happened, so there's nothing to watch:\n${escapeHtml(found.state)}`));
    const id = watches.add({ chatId, threadId, userId: ctx.from?.id ?? null, userName: displayName(ctx.from), task, everyHours, state: found.state });
    await reply(
      `👀 Watching: <b>${escapeHtml(task)}</b>\nI check every ${everyHours} h and post here only when something new comes up.\n\n<b>Now:</b> ${escapeHtml(found.state)}`,
      { reply_markup: { inline_keyboard: [[{ text: "⏹ Stop", callback_data: `wat:x:${id}` }]] } },
    );
  }

  // 📝 Summary under a video card: the AI watches the video and replies with a summary in the group's language.
  // The video's link is read back from the card itself (its title), so nothing about the card is stored.
  const summarizing = new Set<string>();
  bot.callbackQuery(SUMMARY_BUTTON, async (ctx) => {
    const card = ctx.callbackQuery.message;
    const chatId = ctx.chat?.id;
    if (!card || chatId === undefined || !("date" in card) || card.date === 0) return ctx.answerCallbackQuery({ text: "This card is too old." });
    const url = extractLinks(card.caption ?? card.text, card.caption_entities ?? card.entities)[0];
    const key = `${chatId}:${card.message_id}`;
    if (!url) return ctx.answerCallbackQuery({ text: "No video link on this card." });
    if (summarizing.has(key)) return ctx.answerCallbackQuery({ text: "Already summarizing…" });
    if (!(await grok.isLoggedIn())) return ctx.answerCallbackQuery({ text: "The bot owner needs to log in first.", show_alert: true });
    if (!mayAsk(ctx, chatId)) return ctx.answerCallbackQuery({ text: "You've reached your question limit for now. (/stats)", show_alert: true });
    summarizing.add(key);
    const threadId = card.message_thread_id && card.is_topic_message ? card.message_thread_id : 0;
    // A 🎬 card is a video, anything else a web page.
    const open = (card.caption ?? card.text ?? "").startsWith("🎬") ? "▶️" : "🔗";
    const restore = linkButtons(url, SUMMARY, open);
    await ctx.answerCallbackQuery({ text: "📝 Watching the video… (about 15 s)" });
    await ctx
      .editMessageReplyMarkup({ reply_markup: linkButtons(url, { text: "⏳", callback_data: "rem:done" }, open) })
      .catch(() => undefined);
    const typing = keepTyping(ctx, threadId);
    try {
      const summary = await summarizeLink(links, url, groups.language(chatId));
      const ids = await new ReplyStreamer(bot.api, chatId, { replyTo: card.message_id, threadId }).finish(summary);
      answered(chatId, ids);
      logBotMessage(ctx, chatId, threadId, ids[0], `[summary of ${url}]\n${summary}`);
      usage.record(chatId, who(ctx), "card");
      // The summary is posted: only ▶️ Original stays.
      await ctx.editMessageReplyMarkup({ reply_markup: linkButtons(url, undefined, open) }).catch(() => undefined);
    } catch (error) {
      console.warn(`summary failed for ${url}: ${errorMessage(error)}`);
      health?.recordError(error);
      await ctx.editMessageReplyMarkup({ reply_markup: restore }).catch(() => undefined);
      await bot.api
        .sendMessage(chatId, `⚠️ ${friendlyError(errorMessage(error), grok.route, isOwner(ctx))}`, {
          reply_parameters: { message_id: card.message_id, allow_sending_without_reply: true },
          ...(threadId ? { message_thread_id: threadId } : {}),
        })
        .catch(() => undefined);
    } finally {
      typing.stop();
      summarizing.delete(key);
    }
  });

  bot.command("tz", (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.match.trim();
    const current = groups.timeZone(chatId);
    if (!arg) {
      return ctx.reply(
        `🕒 Time zone here: <b>${escapeHtml(current)}</b>, now ${escapeHtml(formatInZone(Date.now(), current))}.\nReminders and the time I'm told use it.\nChange: <code>/tz Europe/London</code> · <code>/tz Tokyo</code> · <code>/tz default</code> (${escapeHtml(timeZone())})`,
        { parse_mode: "HTML" },
      );
    }
    if (isGroup(ctx) && !isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
    const wanted = /^(default|reset)$/i.test(arg) ? timeZone() : findTimeZone(arg);
    if (!wanted) return ctx.reply(`I don't know the time zone "${arg}". Use a name like Asia/Taipei, Europe/London or America/New_York, or a city like Tokyo.`);
    groups.setTimeZone(chatId, /^(default|reset)$/i.test(arg) ? "" : wanted);
    return ctx.reply(
      `🕒 Time zone set to <b>${escapeHtml(wanted)}</b> (now ${escapeHtml(formatInZone(Date.now(), wanted))}). Existing reminders keep their moment in time; new ones use this zone.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("stats", (ctx) => {
    if (!ctx.from) return;
    const id = ctx.from.id;
    const today = usage.member(id, 1).counts;
    const week = usage.member(id, 7).counts;
    const lines = [`📈 <b>${escapeHtml(displayName(ctx.from))}</b>`, `Today: ${formatCounts(today)}`, `7 days: ${formatCounts(week)}`];
    if (unlimited(ctx)) {
      lines.push("No limits for you.");
    } else {
      const left = Math.max(0, limits.get("questionsPerUserHour") - userQuestions.used(String(id)));
      lines.push(`Questions left this hour: ${left}/${limits.get("questionsPerUserHour")}`, `Images left today: ${images.remaining(id)}/${images.perUserPerDay}`);
    }
    return ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("schedule", (ctx) => {
    if (!ctx.from || !ctx.message) return;
    const message = ctx.message;
    const request = ctx.match.trim();
    if (!unlimited(ctx)) return ctx.reply("Scheduled posts use the AI every time they run, so only the owner and trusted members can set them.");
    if (!request) {
      return ctx.reply(
        "I write the post myself at that time (with web search):\n/schedule 每天早上8點 台北天氣和今天重點新聞\n/schedule every Monday 9:00 this week's tech news in 5 bullets\n\n/reminders lists them (🗓), /unremind cancels.",
      );
    }
    background(ctx, async () => {
      const failure = await createReminder(ctx, message, request, true);
      if (failure) await ctx.reply(`🗓 I couldn't schedule that: ${failure}. Try e.g. /schedule 每天早上8點 台北天氣`);
    });
  });

  bot.command("reminders", (ctx) => {
    const list = reminders.list(ctx.chat.id);
    if (list.length === 0) return ctx.reply("No reminders here. Set one with /remind Friday 20:00 meeting");
    const zone = reminders.zone(ctx.chat.id);
    const lines = list.map((r) => reminderLine(r, zone));
    const id = list[0]!.id;
    return ctx.reply(
      `⏰ Reminders and 🗓 scheduled posts (${escapeHtml(zoneLabel(zone))} time):\n${lines.join("\n")}\n\n` +
        `Change: <code>/remind edit ${id} …</code> · <code>/remind pause ${id}</code> · <code>/remind resume ${id}</code> · cancel: <code>/unremind ${id}</code>`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("unremind", (ctx) => {
    const id = Number(ctx.match.trim().replace(/^#/, ""));
    const reminder = Number.isInteger(id) ? reminders.get(ctx.chat.id, id) : undefined;
    if (!reminder) return ctx.reply("No such reminder here. See /reminders for the ids.");
    if (!isOwner(ctx) && reminder.userId !== ctx.from?.id) return ctx.reply("Only the person who set it (or the bot owner) can cancel it.");
    reminders.remove(reminder.id);
    return ctx.reply(`Cancelled: ${reminder.text}`);
  });

  // Pictures sent together: each arrives as its own message, only one with the text.
  const albums = new AlbumCollector<Message>();
  bot.on("message", (ctx) => {
    const message = ctx.message;
    albums.add(message);
    // grammY matches commands only in text, but people caption a screenshot or voice note with “/tr”.
    const captionTr = message.caption?.match(/^\/tr(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
    if (captionTr && (!captionTr[1] || captionTr[1].toLowerCase() === ctx.me.username.toLowerCase())) {
      return runTr(ctx, message, captionTr[2] ?? "", message);
    }
    const captionImg = message.caption?.match(/^\/img(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
    if (captionImg && message.photo && (!captionImg[1] || captionImg[1].toLowerCase() === ctx.me.username.toLowerCase())) {
      return runImg(ctx, message, captionImg[2] ?? "", message);
    }
    if (message.text?.startsWith("/")) {
      // In groups, other bots' commands are none of our business.
      return isGroup(ctx) ? undefined : ctx.reply("Unknown command. Try /help.");
    }
    if (isGroup(ctx)) return onGroupMessage(ctx, message);
    // People with private access have the same per-person limits as in groups.
    // The rest of an album is covered by the answer to its first picture.
    if (message.photo && !albums.claim(message)) return;
    if (!mayAsk(ctx, ctx.chat.id)) return refuseOverLimit(ctx, message, 0);
    const key = sessionKey(ctx.chat.id, 0);
    if (message.text && isWatchRequest(message.text)) return background(ctx, () => createWatch(ctx, message, message.text!));
    if (message.text) return background(ctx, () => chat(ctx, { text: skills.expand(ctx.chat.id, message.text!).text }, { key }));
    if (message.photo) {
      return background(ctx, async () => {
        const album = (await albums.complete(message)).filter((m) => m.photo);
        const pictures = (await Promise.all(album.map((m) => media.photo(m)))).filter((image) => image !== undefined);
        const caption = album.find((m) => m.caption)?.caption;
        await chat(ctx, { text: caption || (pictures.length > 1 ? "What's in these images?" : "What's in this image?"), images: pictures }, { key });
      });
    }
    if (voiceOf(message)) {
      return background(ctx, async () => {
        const typing = keepTyping(ctx);
        const result = await media.transcribeVoice(message).finally(() => typing.stop());
        if (!result?.text) return void (await ctx.reply("🎙️ I couldn't hear any speech in that."));
        usage.record(ctx.chat.id, who(ctx), "voice_sec", voiceOf(message)?.duration ?? 0);
        await ctx.reply(`🎙️ ${result.text}`);
        await chat(ctx, { text: result.text }, { key, speak: true });
      });
    }
    if (videoOf(message)) {
      return background(ctx, async () => {
        const typing = keepTyping(ctx);
        const content = await media.content(message).finally(() => typing.stop());
        const question = message.caption || "What's in this video? Summarize what is said and shown.";
        await chat(ctx, { text: `${question}\n\n${untrusted("telegram-video", content?.text ?? "")}`, images: content?.images }, { key });
      });
    }
    if (message.document) {
      if (!documentOf(message)) return ctx.reply("I can read PDF, Word (.docx), PowerPoint (.pptx), OpenDocument and text files.");
      return background(ctx, async () => {
        const typing = keepTyping(ctx);
        const doc = await media.document(message).finally(() => typing.stop());
        if (!doc) return;
        const question = message.caption || (doc.text ? DOCUMENT_SUMMARY_REQUEST : "What's in this image?");
        await chat(ctx, { text: `${question}\n\n${untrusted(`document: ${doc.name}`, documentPrompt(doc))}`, images: doc.images }, { key });
      });
    }
    return ctx.reply("I can read text, links, photos, voice messages, videos and documents (PDF, Word, PowerPoint, text).");
  });

  /** Switching to focused: the stored conversation carried group chat with it, so it goes; the log keeps one day. */
  function applyFocused(chatId: number): void {
    sessions.forgetChat(chatId);
    groups.prune();
  }

  function onGroupMessage(ctx: Context, message: Message): void {
    const me = { id: ctx.me.id, username: ctx.me.username };
    if (message.from?.is_bot) return;
    const chatId = ctx.chat!.id;
    const threadId = threadIdOf(message);
    // Focused groups keep normal's automatic features (voice transcripts, round videos); only the AI's background differs.
    const normal = groups.privacy(chatId) !== "strict";
    if (isAddressedToBot(message, me, (id, sentAt) => groups.isAnswer(chatId, id, sentAt))) {
      // One answer per album, however many of its pictures count as addressed.
      if (!albums.claim(message)) return;
      if (!mayAsk(ctx, chatId)) return refuseOverLimit(ctx, message, threadId);
      void ctx.react("👀").catch(() => undefined);
      background(ctx, () => answers.use(() => answerInGroup(ctx, message, threadId)));
      return;
    }
    // Only real voice notes (not music or podcast files), and only when the group allows it.
    if (message.voice && normal && groups.voiceMode(chatId) === "auto" && message.voice.duration <= AUTO_VOICE_MAX_SECONDS) {
      if (autoVoice.take(String(chatId))) background(ctx, () => autoJobs.use(() => transcribeInGroup(ctx, message, threadId)), { quiet: true });
      return;
    }
    const auto = groups.linkMode(chatId) === "auto";
    // Shared videos get a card like links do; round video messages are personal speech, so only in normal mode.
    const sharedVideo = message.video ?? (normal ? message.video_note : undefined);
    if (sharedVideo && auto && !groups.disabledPlatforms(chatId).has("upload") && autoCards.take(String(chatId))) {
      background(ctx, () => autoJobs.use(() => showUploadedVideo(ctx, message, threadId)), { quiet: true });
      return;
    }
    // Telegram channel/group links (forwarded posts' footers) aren't content; adult sites are skipped unless the owner allows them.
    const hideAdult = groups.hideAdult(chatId);
    const cardable = linksIn(message).filter((url) => !isTelegramLink(url) && !(hideAdult && isAdultUrl(url)));
    const found = cardable.filter((url) => !recentlyCarded(chatId, url));
    // Only links that already have a card above: a 👌 reaction instead of a second card, so it doesn't look ignored.
    if (auto && cardable.length > 0 && found.length === 0) {
      void ctx.react("👌").catch((error) => console.warn(`repost reaction failed: ${errorMessage(error)}`));
      return;
    }
    if (found.length > 0 && auto && autoCards.take(String(chatId))) {
      for (const url of found) cardedAt.set(`${chatId} ${url}`, Date.now());
      background(ctx, () => autoJobs.use(() => showLinkContent(ctx, message, found, threadId)), { quiet: true });
    }
  }

  /** Links that got a card, per chat: a repost within REPOST_WINDOW_MS gets no second card (memory, then the group log after a restart). */
  const cardedAt = new Map<string, number>();
  function recentlyCarded(chatId: number, url: string, now = Date.now()): boolean {
    for (const [key, at] of cardedAt) if (now - at > REPOST_WINDOW_MS) cardedAt.delete(key);
    return cardedAt.has(`${chatId} ${url}`) || groups.cardedSince(chatId, url, now - REPOST_WINDOW_MS);
  }

  /**
   * Per-member and per-chat question budgets for everything that uses the AI on someone's
   * request (questions, /tr, /remind), in groups and private chats; the owner is never limited.
   */
  function mayAsk(ctx: Context, chatId: number): boolean {
    if (unlimited(ctx)) return true;
    return userQuestions.take(String(ctx.from?.id ?? 0)) && groupQuestions.take(String(chatId));
  }

  function refuseOverLimit(ctx: Context, message: Message, threadId: number): void {
    const user = String(ctx.from?.id ?? 0);
    const waitMs = Math.max(userQuestions.retryAfter(user), groupQuestions.retryAfter(String(ctx.chat!.id)));
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    if (!isGroup(ctx)) {
      void ctx.reply(`⏳ You've reached your limit for now. Try again in about ${minutes} min. (/stats)`).catch(() => undefined);
      return;
    }
    if (!limitNotices.take(user)) return; // one notice per member per 10 minutes, not one per message
    void notifyMember(ctx, `⏳ Too many questions right now. Please try again in about ${minutes} min. (/stats shows your usage)`, threadId).catch(
      () => undefined,
    );
  }

  /**
   * Answer a message addressed to the bot. Media in the message and in the
   * message it replies to (photos, voice, videos) is read and given to Grok.
   */
  async function answerInGroup(ctx: Context, addressed: Message, threadId: number, spokenText?: string): Promise<void> {
    // An album: wait for all its pictures; the one with the text speaks for it.
    const album = spokenText === undefined ? await albums.complete(addressed) : [addressed];
    const message = album.find((m) => m.caption) ?? addressed;
    const me = { id: ctx.me.id, username: ctx.me.username };
    const chatId = ctx.chat!.id;
    // "grok, 提醒我們週五8點開會": set a reminder. If Grok finds no time in it, answer it as a normal question.
    const request = stripAddress(spokenText ?? message.text ?? message.caption ?? "", me);
    if (isReminderRequest(request) && (await createReminder(ctx, message, request)) === undefined) return;
    // "grok, GPT-7 發布的時候告訴我": a watch. Answering it as a question would promise a message that never comes.
    if (!spokenText && isWatchRequest(request)) return createWatch(ctx, message, request);
    const privacy = groups.privacy(chatId);
    const strict = privacy === "strict";
    const reply = realReply(message);
    const images: ImageContent[] = [];
    const notes: string[] = [];
    let ownText = spokenText;
    // Every picture of the album, and of the album the question replies to (if it's recent enough to be known).
    for (const source of [...album, ...(reply ? albums.items(reply) : [])]) {
      if (!source) continue;
      try {
        if (source === message && voiceOf(source) && ownText === undefined) {
          ownText = (await media.transcribeVoice(source))?.text ?? "";
          continue;
        }
        if (source === reply && voiceOf(source)) {
          const logged = groups.loggedText(chatId, source.message_id);
          if (logged?.includes("🎙️")) continue; // transcript already in the reply context
        }
        const content = await media.content(source);
        if (!content) continue;
        images.push(...content.images);
        if (content.text) notes.push(content.text);
      } catch (error) {
        notes.push(`(Couldn't read the attached media: ${errorMessage(error)})`);
      }
    }
    // "grok 早報": a saved request (/skill) stands in for its name.
    const asked = skills.expand(chatId, stripAddress(ownText ?? describeMessage(message), me)).text;
    const text = album.length > 1 ? `${asked}\n(${album.length} pictures sent together, all attached)` : asked;
    // Focused: the recent group chat only for a question about it ("tldr"), and then that turn isn't kept.
    const aboutChat = asksAboutChat(asked);
    const withChat = privacy === "normal" || (privacy === "focused" && aboutChat);
    let prompt = buildGroupPrompt({
      title: "title" in ctx.chat! ? ctx.chat.title : undefined,
      context: withChat ? groups.contextSinceLastReply(chatId, threadId, message.message_id, Date.now(), aboutChat) : [],
      speaker: displayName(message.from),
      speakerId: message.from?.id,
      text: ownText !== undefined ? `(voice) ${text}` : text,
      replyTo: reply
        ? {
            name: displayName(reply.from),
            text: groups.loggedText(chatId, reply.message_id) ?? describeMessage(reply),
            isBot: reply.from?.id === me.id,
          }
        : undefined,
    });
    if (notes.length) prompt += `\n\n${untrusted("attached-media", notes.join("\n\n"))}`;
    // Strict (and a focused question that carries the group chat): a throwaway conversation per question,
    // never written to disk. Focused otherwise: the last few questions and answers of the day, for follow-ups.
    const ephemeral = strict || (privacy === "focused" && withChat);
    const key = ephemeral ? `${sessionKey(chatId, threadId)}:q${message.message_id}` : sessionKey(chatId, threadId);
    const history = privacy === "focused" && !ephemeral ? { turns: FOCUSED_TURNS, maxAgeMs: DAY } : undefined;
    const speak = ownText !== undefined && groups.voiceReply(chatId);
    await chat(ctx, { text: prompt, images }, { key, replyTo: message.message_id, threadId, logGroup: { chatId, threadId }, speak, ephemeral, history });
  }

  /** Transcribe a group voice note (with a translation when it's in another language). "grok, …" by voice is a question. */
  async function transcribeInGroup(ctx: Context, message: Message, threadId: number): Promise<void> {
    const chatId = ctx.chat!.id;
    const lang = groups.language(chatId);
    const result = await media.transcribeVoice(message);
    usage.record(chatId, who(ctx), "voice_sec", voiceOf(message)?.duration ?? 0);
    if (!result?.text) return;
    const translation = needsTranslation({ text: result.text, lang: result.language }, lang) ? await translate(result.text, lang) : undefined;
    const body = translation ? `🎙️ ${result.text}\n\n🌐 ${translation}` : `🎙️ ${result.text}`;
    const sent = await ctx.reply(body, {
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
    // Replace "[voice message]" in the log so later questions see what was said.
    groups.log(chatId, threadId, {
      messageId: message.message_id,
      userId: message.from?.id,
      name: displayName(message.from),
      text: `[voice message] 🎙️ ${result.text}`,
      isBot: false,
      at: Date.now(),
    });
    autoPost(ctx, chatId, threadId, [sent.message_id], `[transcript of ${displayName(message.from)}'s voice message]\n${body}`);
    if (startsWithBotName(result.text)) {
      if (!mayAsk(ctx, chatId)) return refuseOverLimit(ctx, message, threadId);
      await answers.use(() => answerInGroup(ctx, message, threadId, result.text));
    }
  }

  /** A video uploaded to the group: watch it and post a neutral 🎬 card. */
  async function showUploadedVideo(ctx: Context, message: Message, threadId: number): Promise<void> {
    if (!(await grok.isLoggedIn())) return;
    const chatId = ctx.chat!.id;
    const lang = groups.language(chatId);
    const typing = keepTyping(ctx, threadId);
    let card: string;
    try {
      const info = await media.watchVideo(message, { frames: true });
      if (!info) return;
      card = await videoCardFromInfo(grok, "telegram-video", info, lang);
    } finally {
      typing.stop();
    }
    const ids = await new ReplyStreamer(bot.api, chatId, { replyTo: message.message_id, threadId }).finish(card);
    usage.record(chatId, who(ctx), "card");
    autoPost(ctx, chatId, threadId, ids, `[content of a video ${displayName(message.from)} uploaded]\n${card}`);
  }

  /**
   * Show what posted links contain, without commentary: X posts as their own
   * media plus text and translation; web pages and videos as a neutral card.
   * Opinions come only when someone asks the bot.
   */
  async function showLinkContent(ctx: Context, message: Message, urls: string[], threadId: number): Promise<void> {
    const chatId = ctx.chat!.id;
    const lang = groups.language(chatId);
    const disabled = groups.disabledPlatforms(chatId);
    const allowed = (platform: string) => !disabled.has(platform);
    const replyOptions = {
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      ...(threadId ? { message_thread_id: threadId } : {}),
    };
    let shown = 0;
    const typing = keepTyping(ctx, threadId);
    try {
      for (const url of urls) {
        try {
          if (linkKind(url) === "x") {
            if (!allowed("twitter")) continue;
            const picture = groups.xStyle(chatId) === "picture" && xPicture !== undefined;
            // Picture cards are cached apart from text cards (same post, different look).
            const cacheLang = picture ? `${lang}:picture` : lang;
            const hit = links.cache.get(url, cacheLang);
            const dir = join(links.mediaDir, randomUUID());
            let card: XCard;
            try {
              card = hit?.card ?? (picture ? await buildXPicture(url, lang, dir) : (await buildXPostCard(url, lang)));
              const sent = await sendXCard(bot.api, chatId, card, replyOptions);
              if (!hit && sent.reusable) links.cache.put(url, cacheLang, "twitter", sent.reusable);
              // Link first: reply context is truncated from the end.
              autoPost(ctx, chatId, threadId, sent.ids, `[content of ${url}]\n${card.plain}`);
            } finally {
              await rm(dir, { recursive: true, force: true });
            }
            shown++;
            continue;
          }
          // Douyin, Weibo, Xiaohongshu, Instagram, … : the post's own media through ParseHub.
          if (links.parsehub && !isYouTube(url)) {
            try {
              const result = await sendPostCard(
                { parsehub: links.parsehub, api: bot.api, limits: links.uploadLimits, translate, cache: links.cache, allowed, downloaders: links.downloaders },
                chatId,
                url,
                lang,
                replyOptions,
              );
              if (result.status === "disabled") continue;
              if (result.status === "sent") {
                autoPost(ctx, chatId, threadId, result.ids, `[content of ${url}]\n${result.plain}`);
                shown++;
                continue;
              }
            } catch (error) {
              console.warn(`ParseHub failed for ${url}, falling back: ${errorMessage(error)}`);
            }
          }
          const fallbackPlatform = isYouTube(url) ? "youtube" : linkKind(url) === "video" ? "video" : "web";
          if (!allowed(fallbackPlatform)) continue;
          if (fallbackPlatform !== "web") {
            // YouTube & co., like a parse bot: the video with its title and description, no AI. 📝 Summary on request.
            const sent = await sendPlainVideoCard(
              { video: links.video, api: bot.api, limits: links.uploadLimits, cache: links.cache, mediaDir: links.mediaDir },
              chatId,
              url,
              replyOptions,
            );
            await bot.api
              .editMessageReplyMarkup(chatId, sent.ids[0]!, { reply_markup: linkButtons(url, SUMMARY, "▶️") })
              .catch((error) => console.warn(`summary button not added: ${errorMessage(error)}`));
            autoPost(ctx, chatId, threadId, sent.ids, `[content of ${url}]\n${sent.plain}`);
            shown++;
            continue;
          }
          // Web pages, like a link preview: title and the start of the page, no AI. 📝 for a summary on request.
          const preview = await (links.preview ?? ((u: string) => webPreview(links.reader, u)))(url);
          if (!preview) continue;
          const card = plainWebCard(url, preview);
          const sent = await bot.api.sendMessage(chatId, card.html, {
            ...replyOptions,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: linkButtons(url, SUMMARY, "🔗"),
          });
          autoPost(ctx, chatId, threadId, [sent.message_id], `[content of ${url}]\n${card.plain}`);
          shown++;
        } catch (error) {
          console.warn(`link content failed for ${url}: ${errorMessage(error)}`);
        }
      }
    } finally {
      typing.stop();
    }
    usage.record(chatId, who(ctx), "card", shown);
    // Optional: remove a link-only message once every link in it has a card.
    if (shown === urls.length && groups.deleteLink(chatId) && isOnlyLinks(message.text ?? message.caption ?? "", urls)) {
      await ctx.api.deleteMessage(chatId, message.message_id).catch((error) => console.warn(`delete link failed: ${errorMessage(error)}`));
    }
  }

  /**
   * Parse a reminder request with Grok and store it, or apply a change to `existing` (/remind edit).
   * Confirms the time as understood, with Pause/Cancel buttons. Returns why it failed, or undefined.
   */
  async function createReminder(ctx: Context, message: Message, request: string, ai = false, existing?: Reminder): Promise<string | undefined> {
    const chatId = ctx.chat!.id;
    if (!(await grok.isLoggedIn())) return "the bot owner needs to log in to Grok first";
    if (!existing) {
      if (reminders.count(chatId) >= MAX_REMINDERS_PER_CHAT) return `this chat already has ${MAX_REMINDERS_PER_CHAT} reminders (see /reminders)`;
      if (ai && reminders.list(chatId).filter((r) => r.ai).length >= MAX_SCHEDULED_POSTS) return `this chat already has ${MAX_SCHEDULED_POSTS} scheduled posts`;
    }
    const now = Date.now();
    const zone = reminders.zone(chatId);
    const parsed = parseReminderAnswer(await grok.ask(REMINDER_SYSTEM_PROMPT(now, zone, existing), request), now, zone);
    if (!parsed.ok) return parsed.reason;
    const threadId = threadIdOf(message);
    let id: number;
    if (existing) {
      reminders.update(existing.id, parsed);
      id = existing.id;
    } else {
      id = reminders.add({
        chatId,
        threadId,
        messageId: message.message_id,
        userId: message.from?.id ?? null,
        userName: displayName(message.from),
        text: parsed.text,
        dueAt: parsed.dueAt,
        repeat: parsed.repeat,
        ai,
      });
    }
    const title = existing ? "✏️ Changed" : ai ? "🗓 Scheduled post" : "⏰ OK";
    await ctx.reply(
      `${title}: <b>${escapeHtml(parsed.text)}</b>\n${escapeHtml(formatInZone(parsed.dueAt, zone))} (${escapeHtml(zoneLabel(zone))}, ${formatFromNow(parsed.dueAt, now)})` +
        `${parsed.repeat === "none" ? "" : `, ${repeatLabel(parsed.repeat)}`}\n<i>Wrong time? <code>/remind edit ${id} …</code></i>`,
      {
        parse_mode: "HTML",
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        reply_markup: { inline_keyboard: [[{ text: "⏸ Pause", callback_data: `rem:p:${id}` }, { text: "🗑 Cancel", callback_data: `rem:x:${id}` }]] },
        ...(threadId ? { message_thread_id: threadId } : {}),
      },
    );
    return undefined;
  }

  /** /tr: the given text, or the replied message's text, voice note, or the text in its photo. */
  async function translateForTr(ownText: string, source: Message | undefined, lang: string, ignoreCaption = false): Promise<string> {
    if (!(await grok.isLoggedIn())) throw new Error("The bot owner needs to log in to Grok first.");
    const target = languageName(lang);
    const system = `Translate the user's text into ${target}. If it is already in ${target}, translate it into English instead. Output only the translation, nothing else.`;
    // A message that is itself "/tr" (e.g. a screenshot captioned /tr) has nothing to translate in its text.
    const notCommand = (value: string | undefined) => (value && !/^\/tr(@\w+)?(\s|$)/i.test(value) ? value : "");
    let text = ownText || notCommand(source?.text) || (ignoreCaption ? "" : notCommand(source?.caption));
    if (!text && source && voiceOf(source)) text = (await media.transcribeVoice(source))?.text ?? "";
    if (!text && source && documentOf(source)) {
      const doc = (await media.document(source))!;
      if (doc.images.length) {
        return grok.ask(`Translate all text visible in these pages into ${target}. Output only the translation.`, `Translate the text in "${doc.name}".`, { images: doc.images });
      }
      // Long documents: the first part only (a translation must fit in a few messages).
      const part = doc.text.slice(0, TRANSLATE_DOCUMENT_CHARS);
      const translation = await grok.ask(system, part);
      return doc.text.length > part.length ? `${translation}\n\n(${doc.name}: first ${part.length.toLocaleString("en-US")} of ${doc.text.length.toLocaleString("en-US")} characters translated)` : translation;
    }
    if (!text && source?.photo) {
      const image = await media.photo(source);
      if (image) {
        return grok.ask(
          `Translate all text visible in the image into ${target}. Output only the translation. If the image has no text, reply exactly: (no text in the image)`,
          "Translate the text in this image.",
          { images: [image] },
        );
      }
    }
    if (!text) throw new Error("There is no text to translate in that message.");
    return grok.ask(system, text);
  }

  async function fetchXWithTranslation(url: string, lang: string): Promise<{ post: XPost; translation: string | undefined }> {
    const post = await fetchXPost(url, fetch, undefined, lang === "off" ? undefined : lang);
    const translation = needsTranslation(post, lang) ? (post.translation ?? (await translate(post.text, lang))) : undefined;
    return { post, translation };
  }

  async function buildXPostCard(url: string, lang: string) {
    const { post, translation } = await fetchXWithTranslation(url, lang);
    return buildXCard(post, translation);
  }

  /**
   * /xstyle picture: the post drawn like on X, first in an album with the post's own media. The caption
   * keeps the author link and the text folded, so links stay tappable and the post searchable.
   * Falls back to the text card if drawing fails (fonts missing).
   */
  async function buildXPicture(url: string, lang: string, dir: string): Promise<XCard> {
    const { post, translation } = await fetchXWithTranslation(url, lang);
    const card = buildXCard(post, translation);
    let png: Buffer;
    try {
      png = await xPicture!(post, translation);
    } catch (error) {
      console.warn(`X picture failed, sending the text card: ${errorMessage(error)}`);
      return card;
    }
    await mkdir(dir, { recursive: true });
    const path = join(dir, "post.png");
    await writeFile(path, png);
    // Same compact caption as the text card: author line, then the text folded.
    return { ...card, media: [{ type: "photo", url: path, local: true }, ...card.media] };
  }

  /** Fallback when X has no translation ready: ask Grok for a plain translation. */
  async function translate(text: string, lang: string): Promise<string | undefined> {
    if (!(await grok.isLoggedIn())) return undefined;
    try {
      return await grok.ask(
        `Translate the user's text into ${languageName(lang)}. Output only the translation, nothing else.`,
        text,
      );
    } catch (error) {
      console.warn(`translation failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async function chat(ctx: Context, input: { text: string; images?: ImageContent[] }, target: ChatTarget): Promise<void> {
    if (!(await grok.isLoggedIn())) {
      await ctx.reply(isOwner(ctx) ? "Not connected to Grok yet. Send /login first." : "The bot owner needs to log in to Grok first.");
      return;
    }
    const chatId = ctx.chat!.id;
    usage.record(chatId, who(ctx), "question");
    // Private chat: a native draft with Telegram's Stop button; groups: send-and-edit preview.
    const draftId = ctx.chat!.type === "private" ? 1 + Math.floor(Math.random() * 2_000_000_000) : undefined;
    const streamer = new ReplyStreamer(bot.api, chatId, { replyTo: target.replyTo, threadId: target.threadId, draftId });
    await streamer.start();
    const typing = streamer.usesDraft ? { stop: () => undefined } : keepTyping(ctx, target.threadId);
    let finalText: string | undefined;
    let ids: number[] = [];
    let imageTurn: ReturnType<ImageStudio["begin"]> | undefined;
    let toolsUsed = false;
    // This turn's author for the remember tool. The next question in the chat may start before this
    // one's cleanup runs, so cleanup removes only our own entry.
    const speaker = { userId: ctx.from?.id, userName: displayName(ctx.from) };
    try {
      const reply = await sessions.run(
        target.key,
        input,
        {
          onStart: () => {
            imageTurn = images.begin(target.key, { userId: ctx.from?.id, unlimited: isOwner(ctx), attached: input.images });
            speakers.set(target.key, speaker);
          },
          onText: (text) => {
            typing.stop();
            streamer.update(text);
          },
          onTool: () => {
            toolsUsed = true;
          },
          onActivity: (name) => streamer.status(activityLine(name)),
        },
        { ephemeral: target.ephemeral, history: target.history },
      );
      if (reply.stopReason === "error") {
        // Logged (no message content) so a failed answer leaves a trace in the journal and /health.
        console.warn(`answer failed in chat ${chatId}: ${reply.errorMessage ?? "unknown error"}`);
        health?.recordError(new Error(`answer failed: ${reply.errorMessage ?? "unknown error"}`));
        ids = await streamer.fail(friendlyError(reply.errorMessage ?? "unknown error", grok.route, isOwner(ctx)));
      } else if (reply.stopReason === "aborted") {
        ids = await streamer.fail("Stopped.");
      } else {
        finalText = assistantText(reply).trim();
        if (!finalText) {
          // Tools did the work (a poll, an image, a note) and there is nothing to add; or the model gave nothing even when asked again.
          ids = await streamer.finish(toolsUsed ? "✅" : "I couldn't come up with an answer this time. Please ask again, maybe in other words.");
          finalText = undefined;
        } else {
          // Hit the length limit mid-answer: say so, instead of ending mid-sentence without a hint.
          ids = await streamer.finish(reply.stopReason === "length" ? `${finalText}\n\n_(cut off at the length limit; reply “continue” for the rest)_` : finalText);
        }
      }
    } catch (error) {
      // Queued behind another answer when /new or /forget cleared the chat: same as being stopped.
      if (!(error instanceof TurnCancelledError)) {
        console.warn(`answer failed in chat ${chatId}: ${errorMessage(error)}`);
        health?.recordError(error);
      }
      ids = await streamer.fail(error instanceof TurnCancelledError ? "Stopped." : friendlyError(errorMessage(error), grok.route, isOwner(ctx)));
    } finally {
      typing.stop();
      if (speakers.get(target.key) === speaker) speakers.delete(target.key);
      const created = imageTurn ? images.end(imageTurn) : [];
      answered(chatId, ids);
      await postImages(ctx.chat!.id, created, target.replyTo, target.threadId).then((imageIds) => answered(chatId, imageIds), async (error) => {
        await ctx.reply(`⚠️ Couldn't post the image: ${errorMessage(error)}`).catch(() => undefined);
      });
      if (created.length) usage.record(chatId, who(ctx), "image", created.length);
    }
    if (target.speak && finalText) {
      await speakReply(ctx, finalText, target).catch((error) => console.warn(`voice reply failed: ${errorMessage(error)}`));
    }
    if (target.logGroup && finalText) logBotMessage(ctx, target.logGroup.chatId, target.logGroup.threadId, ids[0], finalText);
  }

  /** Read an answer aloud (xAI text-to-speech) and send it as a voice note under the text. */
  async function speakReply(ctx: Context, markdown: string, target: ChatTarget): Promise<void> {
    const text = speakableText(markdown);
    if (!text || !(await grok.signedIn("xai"))) return;
    const voice = await toVoiceNote(await grok.speak(text));
    const sent = await bot.api.sendVoice(ctx.chat!.id, new VoiceFile(voice, "reply.ogg"), {
      ...(target.replyTo ? { reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true } } : {}),
      ...(target.threadId ? { message_thread_id: target.threadId } : {}),
    });
    answered(ctx.chat!.id, [sent.message_id]);
    usage.record(ctx.chat!.id, who(ctx), "tts", text.length);
  }

  // The Stop button under a streaming draft in our private chat.
  bot.on("stopped_message_generation", (ctx) => {
    sessions.abort(sessionKey(ctx.update.stopped_message_generation!.chat.id, 0));
  });

  /** A card or transcript the bot posted by itself (not an answer: replies to it aren't questions). */
  function autoPost(ctx: Context, chatId: number, threadId: number, ids: readonly number[], text: string): void {
    for (const id of ids) logBotMessage(ctx, chatId, threadId, id, text);
  }

  /** The bot's answers in a group: replies to them continue the conversation. */
  function answered(chatId: number, ids: readonly (number | undefined)[]): void {
    if (chatId < 0) groups.markAnswer(chatId, ids.filter((id): id is number => id !== undefined));
  }

  function logBotMessage(ctx: Context, chatId: number, threadId: number, messageId: number | undefined, text: string): void {
    // Strict groups keep no log at all: bot answers often quote the person who asked.
    if (messageId === undefined || groups.privacy(chatId) === "strict") return;
    groups.log(chatId, threadId, { messageId, userId: ctx.me.id, name: ctx.me.first_name, text, isBot: true, at: Date.now() });
  }

  // Guest Mode: "@bot …" in a chat the bot isn't a member of. Telegram shows it only that message and the one it
  // replies to, and lets it send one reply, which is edited while it works. Owner, 💬 private and ⭐ trusted only.
  bot.on("guest_message", (ctx) => {
    const message = ctx.guestMessage!;
    if (!message.from || message.from.is_bot || !message.guest_query_id) return;
    background(ctx, () => answerGuest(ctx, message), { quiet: true });
  });

  async function answerGuest(ctx: Context, message: Message): Promise<void> {
    const from = message.from!;
    const answer = (text: string) =>
      bot.api.answerGuestQuery(message.guest_query_id!, {
        type: "article",
        id: "answer",
        title: "Grok",
        input_message_content: { message_text: text, parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      });
    const allowed = from.id === ownerId || permissions.has(from.id, "private") || permissions.has(from.id, "trusted");
    if (!allowed) return void (await answer("🔒 I'm a private bot. Ask my owner for access."));
    if (!(await grok.isLoggedIn())) return void (await answer("The bot owner needs to log in to Grok first."));
    if (!mayAsk(ctx, from.id)) return void (await answer("⏳ You've reached your question limit for now. Try again later."));
    const sent = await answer("⏳ …");
    const edit = (html: string) =>
      bot.api.editMessageTextInline(sent.inline_message_id, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => undefined);
    const me = { id: ctx.me.id, username: ctx.me.username };
    const reply = message.reply_to_message;
    const images: ImageContent[] = [];
    const notes: string[] = [];
    for (const source of [message, reply]) {
      if (!source) continue;
      try {
        const content = await media.content(source as Message);
        if (content) {
          images.push(...content.images);
          if (content.text) notes.push(content.text);
        }
      } catch (error) {
        notes.push(`(Couldn't read the attached media: ${errorMessage(error)})`);
      }
    }
    // "@bot ts …": the caller's own saved requests (from their private chat with the bot).
    const request = skills.expand(from.id, stripAddress(describeMessage(message), me)).text;
    let prompt = buildGroupPrompt({
      context: [],
      speaker: displayName(from),
      speakerId: from.id,
      text: request,
      replyTo: reply ? { name: displayName(reply.from), text: describeMessage(reply), isBot: reply.from?.id === me.id } : undefined,
    });
    if (notes.length) prompt += `\n\n${untrusted("attached-media", notes.join("\n\n"))}`;
    prompt += "\n\n(You were summoned in a chat you are not part of: answer only this, in one message, text only.)";
    usage.record(from.id, { id: from.id, name: displayName(from) }, "question");
    let shown = "";
    try {
      const result = await sessions.run(
        `tg:${from.id}:g${message.message_id}`,
        { text: prompt, images },
        {
          onActivity: (name) => {
            const line = activityLine(name);
            if (line !== shown) void edit(escapeHtml((shown = line)));
          },
        },
        { ephemeral: true },
      );
      const text = assistantText(result).trim() || "I couldn't come up with an answer this time.";
      const [first = text, ...rest] = splitMarkdown(text, 3800);
      await edit(markdownToTelegramHtml(first) + (rest.length ? "\n\n<i>(cut short: ask me privately for the rest)</i>" : ""));
    } catch (error) {
      console.warn(`guest answer failed: ${errorMessage(error)}`);
      await edit(`⚠️ ${escapeHtml(friendlyError(errorMessage(error), grok.route, from.id === ownerId))}`);
    }
  }

  // Inline mode: "@bot <link>" in any chat. Owner only unless INLINE_PUBLIC is set (translations use the Grok quota).
  bot.on("inline_query", async (ctx) => {
    const url = urlFromQuery(ctx.inlineQuery.query);
    const allowed = inlinePublic || ctx.from.id === ownerId || permissions.has(ctx.from.id, "private");
    if (!url || !allowed) return ctx.answerInlineQuery([], { cache_time: 30 });
    try {
      const results = await withTimeout(
        inlineResults({ cache: links.cache, parsehub: links.parsehub, buildXCard: buildXPostCard, translate }, url, defaultLanguage()),
        9000,
      );
      await ctx.answerInlineQuery(results, { cache_time: 300, is_personal: !inlinePublic });
    } catch (error) {
      console.warn(`inline query failed for ${url}: ${errorMessage(error)}`);
      await ctx.answerInlineQuery([], { cache_time: 5 }).catch(() => undefined);
    }
  });

  bot.catch((error) => {
    console.error("bot error:", error.error);
    health?.recordError(error.error);
  });
  return bot;
}

export async function registerCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(COMMANDS);
  // In groups, setting and info commands are ephemeral: only the sender sees the command and the answer.
  await bot.api.setMyCommands(
    COMMANDS.filter((c) => !["login", "logout", "route", "model", "search"].includes(c.command)).map((c) =>
      EPHEMERAL_COMMANDS.has(c.command) ? { ...c, is_ephemeral: true } : c,
    ),
    { scope: { type: "all_group_chats" } },
  );
}

export function privacyText(mode: PrivacyMode): string {
  if (mode === "focused") {
    return [
      "🎯 <b>Privacy: focused</b>",
      "• When someone asks me, Grok sees that message, the one it replies to, the /lm notes and my last few answers here (up to 6, 1 day) for follow-ups.",
      "• The group chat goes to Grok only for a question about it (<code>grok tldr</code>, “grok, 刚才说了什么”), or when Grok decides a question needs it; it isn't kept afterwards.",
      "• Keys, passwords, server logins, emails, phone and card numbers in others' messages are hidden before anything is sent.",
      "• Group messages are stored on the bot's server for 1 day, for that.",
      "• Voice notes are transcribed automatically (/voice).",
      "",
      "Owner: <code>/privacy strict</code> stores nothing · <code>/privacy normal</code> sends recent chat with every question.",
    ].join("\n");
  }
  return mode === "strict"
    ? [
        "🔒 <b>Privacy: strict</b>",
        "• Group messages are <b>not stored</b> and <b>never sent to Grok</b> as background.",
        "• When someone asks me, Grok sees only that message, the one it replies to, and the notes saved with /lm. No memory between questions.",
        "• Voice notes and round video messages are processed only when someone asks me about one.",
        "• Shared links and uploaded videos still get content cards (only that content is processed).",
        "• Image requests send only the description (and the photo to change) to xAI; images are not stored.",
        "",
        "Owner: <code>/privacy focused</code> (chat only when asked about it) or <code>/privacy normal</code> enables chat context and memory.",
      ].join("\n")
    : [
        "🔓 <b>Privacy: normal</b>",
        "• Group messages are stored on the bot's server for 7 days.",
        "• When someone asks me, Grok also sees up to 30 recent messages (last 24 h) and earlier questions to me (7 days).",
        "• Voice notes are transcribed automatically (/voice).",
        "",
        "Owner: <code>/privacy strict</code> stops this and deletes what is stored. <code>/forget</code> deletes it without changing the mode.",
      ].join("\n");
}

/** One conversation per private chat, group, or forum topic. */
export function sessionKey(chatId: number, threadId: number): string {
  return threadId ? `tg:${chatId}:topic:${threadId}` : `tg:${chatId}`;
}

/**
 * The message being replied to, ignoring the forum quirk where every message in
 * a topic "replies" to the topic's creation message.
 */
function realReply(message: Message): Message | undefined {
  const reply = message.reply_to_message;
  if (!reply) return undefined;
  if (message.is_topic_message && reply.message_id === message.message_thread_id) return undefined;
  return reply;
}

/**
 * grammY handles updates one at a time, so slow work (LLM replies, the login
 * wait) runs in the background to keep other messages flowing.
 */
function runInBackground(ctx: Context, task: () => Promise<void>, options: { quiet?: boolean; report?: (error: unknown) => void } = {}): void {
  task().catch(async (error) => {
    console.error("task failed:", error);
    options.report?.(error);
    if (!options.quiet) await ctx.reply(`⚠️ ${errorMessage(error)}`).catch(() => undefined);
  });
}

function keepTyping(ctx: Context, threadId?: number): { stop: () => void } {
  const other = threadId ? { message_thread_id: threadId } : undefined;
  const send = () => void ctx.replyWithChatAction("typing", other).catch(() => undefined);
  send();
  const timer = setInterval(send, 4500);
  return { stop: () => clearInterval(timer) };
}

/** "2026-10-14T16:51:36.56+00:00" → "Thu, Oct 15, 00:51 (Taipei)" in local time; unparseable input is returned as is. */
export function formatLocalIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toLocaleString("en-US", {
    timeZone: timeZone(),
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${text} (${zoneLabel()})`;
}

/** What to tell the user when an answer failed. Only the owner sees raw provider errors and fixes. */
export function friendlyError(message: string, route: Route, forOwner = true): string {
  if (/\b403\b|permission|not authorized|do not have an active Grok subscription/i.test(message)) {
    return forOwner
      ? `Grok refused this request on the "${route}" route (403). Try /route auto, or check your subscription.`
      : "The AI service refused this request. The bot owner has been told how to fix it in /status.";
  }
  if (/\b401\b|unauthorized|invalid_grant|token refresh failed/i.test(message)) {
    return forOwner ? "Your Grok login expired or was revoked. Send /login again." : "The bot owner needs to sign in to the AI service again.";
  }
  if (/\b402\b|\b429\b|quota|rate limit|run out/i.test(message)) {
    return forOwner ? "Grok usage limit reached. Check /status and try again later." : "The AI usage limit is reached for now. Please try again later.";
  }
  if (/connection error|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|network/i.test(message)) {
    return forOwner
      ? `Couldn't reach the AI service (${message}), even after retrying. Usually a short network hiccup: ask again. A second provider in /admin → 🤖 AI providers answers when Grok can't.`
      : "Couldn't reach the AI service just now. Please ask again in a moment.";
  }
  return forOwner ? `Grok error: ${message}` : "Something went wrong with the AI service. Please try again in a moment.";
}

export function describeProbe(results: readonly ProbeResult[], selected: Route): string {
  const lines = results.map(
    (result) => `${result.ok ? "✅" : "❌"} <b>${result.route}</b>: ${escapeHtml(result.detail.slice(0, 160))}`,
  );
  const anyOk = results.some((result) => result.ok);
  lines.push("", anyOk ? `Using route <b>${selected}</b>. You can chat now.` : "No route worked for this account.");
  return lines.join("\n");
}

export function repeatLabel(repeat: string): string {
  return repeat === "daily" ? "every day" : repeat === "weekly" ? "every week" : "once";
}

/** What the bot does with a document sent without a question. */
const DOCUMENT_SUMMARY_REQUEST = "Summarize this document: what it is, its main points as bullets, and any important numbers, dates or decisions.";
/** /tr on a document translates at most this many characters. */
const TRANSLATE_DOCUMENT_CHARS = 12_000;

/** A document's text for the prompt, with its name and kind. */
function documentPrompt(doc: { name: string; kind: string; text: string; truncated: boolean }): string {
  const header = `"${doc.name}" (${doc.kind}${doc.truncated ? "; long, the middle is omitted" : ""})`;
  return doc.text ? `${header}\n\n${doc.text}` : `${header}: the pages are attached as images.`;
}

/** One line of /reminders: id, next time, repeat, state, text, who set it, and its delivery history. */
export function reminderLine(r: Reminder, zone: string): string {
  const parts = [`${r.ai ? "🗓 " : ""}${r.paused ? "⏸ " : ""}<code>${r.id}</code> · ${escapeHtml(formatInZone(r.dueAt, zone))}`];
  if (r.repeat !== "none") parts[0] += ` (${repeatLabel(r.repeat)})`;
  parts.push(`${escapeHtml(r.text)} <i>— ${escapeHtml(r.userName)}</i>`);
  let line = parts.join(" · ");
  if (r.sentCount) line += `\n   <i>sent ${r.sentCount}×, last ${escapeHtml(formatInZone(r.lastSentAt ?? 0, zone))}</i>`;
  if (r.lastError) line += `\n   <i>⚠️ last attempt failed: ${escapeHtml(r.lastError.slice(0, 80))}</i>`;
  return line;
}

/** Buttons under a delivered reminder: 💤 snooze (one-off), or snooze/pause (repeating); scheduled posts can be paused. */
export function reminderKeyboard(r: Pick<Reminder, "id" | "repeat" | "ai">): { inline_keyboard: { text: string; callback_data: string }[][] } {
  if (r.ai) return { inline_keyboard: [[{ text: "⏸ Pause these posts", callback_data: `rem:p:${r.id}` }]] };
  if (r.repeat !== "none") {
    return { inline_keyboard: [[{ text: "💤 1 hour", callback_data: `rem:s:${r.id}:60` }, { text: "⏸ Pause", callback_data: `rem:p:${r.id}` }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: "💤 10 min", callback_data: `rem:s:${r.id}:10` },
        { text: "💤 1 hour", callback_data: `rem:s:${r.id}:60` },
        { text: "💤 Tomorrow", callback_data: `rem:s:${r.id}:tm` },
      ],
    ],
  };
}

/** The message a reminder sends when it is due. */
export function renderReminder(reminder: { text: string; userName: string; repeat: string }): string {
  const again = reminder.repeat === "none" ? "" : ` · ${repeatLabel(reminder.repeat)}`;
  return `⏰ <b>${escapeHtml(reminder.text)}</b>\n<i>reminder from ${escapeHtml(reminder.userName)}${again}</i>`;
}
