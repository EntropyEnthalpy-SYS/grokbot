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
import { isAdultUrl, isTelegramLink, linkKind } from "../links/detect.ts";
import { untrusted } from "../links/reader.ts";
import { summarizeLink, videoCardFromInfo, type LinkSummaryDeps } from "../links/summarize.ts";
import type { VideoReader } from "../media/video.ts";
import type { ParseHubClient } from "../links/parsehub.ts";
import type { UploadLimits } from "../links/phcard.ts";
import { sendPostCard, type PostCardDeps } from "../links/postcard.ts";
import { sendVideoLinkCard } from "../links/videocard.ts";
import type { CardCache } from "../links/cardCache.ts";
import { inlineResults, urlFromQuery } from "./inline.ts";
import { defaultLanguage } from "../lang.ts";
import { AUTO_VOICE_MAX_SECONDS, documentOf, TelegramMedia, videoOf, voiceOf } from "./media.ts";
import { buildXCard, needsTranslation, sendXCard } from "../links/xcard.ts";
import { fetchXPost } from "../links/xpost.ts";
import { escapeHtml } from "./format.ts";
import {
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
  startsWithBotName,
  stripAddress,
  threadIdOf,
  type GroupStore,
  type LinkMode,
} from "./groups.ts";
import { ReplyStreamer } from "./streamer.ts";
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
  { command: "tz", description: "This chat's time zone: /tz Europe/London" },
  { command: "unremind", description: "Cancel a reminder: /unremind <id>" },
  { command: "status", description: "Login, model and SuperGrok quota" },
  { command: "health", description: "Live check of the bot and its services (owner)" },
  { command: "model", description: "Show or switch the Grok model" },
  { command: "search", description: "Turn web/X search on or off" },
  { command: "links", description: "Group link content: auto | mention | off" },
  { command: "lang", description: "Group translation language" },
  { command: "voice", description: "Group voice transcripts: auto | off" },
  { command: "platforms", description: "Turn link content on/off per platform" },
  { command: "privacy", description: "Group privacy: strict | normal" },
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
/** /tidy: how long setting replies stay. */
const TIDY_DELAY_MS = 2 * 60 * 1000;
/** AI-written scheduled posts per chat (each run uses the AI). */
const MAX_SCHEDULED_POSTS = 5;
/** Commands whose messages and replies are kept even with /tidy on. */
const KEEP_COMMANDS = new Set(["tr", "img", "remind", "enable", "start"]);
/** Default question limits (the owner changes them in /admin → ⚖️ Limits). */
export const QUESTIONS_PER_USER_PER_HOUR = LIMITS.questionsPerUserHour.default;
export const QUESTIONS_PER_GROUP_PER_HOUR = LIMITS.questionsPerGroupHour.default;
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
  links: LinkSummaryDeps & {
    video: VideoReader;
    parsehub?: ParseHubClient;
    uploadLimits: UploadLimits;
    cache: CardCache;
    downloaders?: PostCardDeps["downloaders"];
    mediaDir: string;
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
  /** Strict privacy: the conversation is never stored. */
  ephemeral?: boolean;
};

/** Commands whose replies only the sender sees in groups (Telegram ephemeral commands, Bot API 10.2). */
const EPHEMERAL_COMMANDS = new Set([
  "help", "start", "stats", "status", "health", "links", "lang", "voice", "platforms", "privacy", "deletelink",
  "tidy", "lm", "reminders", "unremind", "new", "stop", "forget", "admin", "tz",
]);

export function createBot({
  token,
  ownerId,
  grok,
  sessions,
  groups,
  reminders,
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
    if (message && isGroup(ctx) && !message.text?.startsWith("/") && groups.privacy(ctx.chat!.id) === "normal") {
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
        "• Mention me, reply to me, or start with “grok,” to ask something.",
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
    if (arg === "strict" || arg === "normal") {
      if (!isOwner(ctx)) return ctx.reply("Only the bot owner can change this.");
      groups.setPrivacy(ctx.chat!.id, arg);
      if (arg === "strict") {
        groups.forget(ctx.chat!.id);
        sessions.forgetChat(ctx.chat!.id);
      }
    }
    return ctx.reply(privacyText(groups.privacy(ctx.chat!.id)), { parse_mode: "HTML" });
  });

  bot.command(
    "forget",
    ownerInGroups(async (ctx) => {
      const removedReminders = reminders.forgetChat(ctx.chat!.id);
      const removedNotes = memory.forgetChat(ctx.chat!.id);
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

  bot.on("message", (ctx) => {
    const message = ctx.message;
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
    if (!mayAsk(ctx, ctx.chat.id)) return refuseOverLimit(ctx, message, 0);
    const key = sessionKey(ctx.chat.id, 0);
    if (message.text) return background(ctx, () => chat(ctx, { text: message.text! }, { key }));
    if (message.photo) {
      return background(ctx, async () => {
        const image = await media.photo(message);
        await chat(ctx, { text: message.caption || "What's in this image?", images: image ? [image] : [] }, { key });
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

  function onGroupMessage(ctx: Context, message: Message): void {
    const me = { id: ctx.me.id, username: ctx.me.username };
    if (message.from?.is_bot) return;
    const chatId = ctx.chat!.id;
    const threadId = threadIdOf(message);
    const normal = groups.privacy(chatId) === "normal";
    if (isAddressedToBot(message, me, (id, sentAt) => groups.isAnswer(chatId, id, sentAt))) {
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
    const found = linksIn(message).filter((url) => !isTelegramLink(url) && !(hideAdult && isAdultUrl(url)) && !recentlyCarded(chatId, url));
    if (found.length > 0 && auto && autoCards.take(String(chatId))) {
      for (const url of found) cardedAt.set(`${chatId} ${url}`, Date.now());
      background(ctx, () => autoJobs.use(() => showLinkContent(ctx, message, found, threadId)), { quiet: true });
    }
  }

  /** Links that got a card, per chat: a repost within REPOST_WINDOW_MS gets no second card. */
  const cardedAt = new Map<string, number>();
  function recentlyCarded(chatId: number, url: string, now = Date.now()): boolean {
    for (const [key, at] of cardedAt) if (now - at > REPOST_WINDOW_MS) cardedAt.delete(key);
    return cardedAt.has(`${chatId} ${url}`);
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
  async function answerInGroup(ctx: Context, message: Message, threadId: number, spokenText?: string): Promise<void> {
    const me = { id: ctx.me.id, username: ctx.me.username };
    const chatId = ctx.chat!.id;
    // "grok, 提醒我們週五8點開會": set a reminder. If Grok finds no time in it, answer it as a normal question.
    const request = stripAddress(spokenText ?? message.text ?? message.caption ?? "", me);
    if (isReminderRequest(request) && (await createReminder(ctx, message, request)) === undefined) return;
    const strict = groups.privacy(chatId) === "strict";
    const reply = realReply(message);
    const images: ImageContent[] = [];
    const notes: string[] = [];
    let ownText = spokenText;
    for (const source of [message, reply]) {
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
    const text = stripAddress(ownText ?? describeMessage(message), me);
    let prompt = buildGroupPrompt({
      title: "title" in ctx.chat! ? ctx.chat.title : undefined,
      context: strict ? [] : groups.contextSinceLastReply(chatId, threadId, message.message_id),
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
    // Strict: a throwaway conversation per question that is never written to disk; nothing earlier is re-sent.
    const key = strict ? `${sessionKey(chatId, threadId)}:q${message.message_id}` : sessionKey(chatId, threadId);
    const speak = ownText !== undefined && groups.voiceReply(chatId);
    await chat(ctx, { text: prompt, images }, { key, replyTo: message.message_id, threadId, logGroup: { chatId, threadId }, speak, ephemeral: strict });
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
    const webCards: { url: string; card: string }[] = [];
    let shown = 0;
    const typing = keepTyping(ctx, threadId);
    try {
      for (const url of urls) {
        try {
          if (linkKind(url) === "x") {
            if (!allowed("twitter")) continue;
            const hit = links.cache.get(url, lang);
            const card = hit?.card ?? (await buildXPostCard(url, lang));
            const sent = await sendXCard(bot.api, chatId, card, replyOptions);
            if (!hit && sent.reusable) links.cache.put(url, lang, "twitter", sent.reusable);
            // Link first: reply context is truncated from the end.
            autoPost(ctx, chatId, threadId, sent.ids, `[content of ${url}]\n${card.plain}`);
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
          if (!allowed(fallbackPlatform) || !(await grok.isLoggedIn())) continue;
          if (fallbackPlatform !== "web") {
            // YouTube & co.: the video itself with the 🎬 card as caption.
            const sent = await sendVideoLinkCard(
              { links, api: bot.api, limits: links.uploadLimits, cache: links.cache, mediaDir: links.mediaDir },
              chatId,
              url,
              lang,
              replyOptions,
            );
            autoPost(ctx, chatId, threadId, sent.ids, `[content of ${url}]\n${sent.plain}`);
            shown++;
            continue;
          }
          webCards.push({ url, card: await summarizeLink(links, url, lang) });
        } catch (error) {
          console.warn(`link content failed for ${url}: ${errorMessage(error)}`);
        }
      }
    } finally {
      typing.stop();
    }
    if (webCards.length > 0) {
      const text = webCards.map((entry) => entry.card).join("\n\n");
      const ids = await new ReplyStreamer(bot.api, chatId, { replyTo: message.message_id, threadId }).finish(text);
      const logged = `[content of ${webCards.map((entry) => entry.url).join(", ")}]\n${text}`;
      autoPost(ctx, chatId, threadId, ids, logged);
      shown += webCards.length;
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

  async function buildXPostCard(url: string, lang: string) {
    const post = await fetchXPost(url, fetch, undefined, lang === "off" ? undefined : lang);
    const translation = needsTranslation(post, lang) ? (post.translation ?? (await translate(post.text, lang))) : undefined;
    return buildXCard(post, translation);
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
        },
        { ephemeral: target.ephemeral },
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
    if (messageId === undefined || groups.privacy(chatId) !== "normal") return;
    groups.log(chatId, threadId, { messageId, userId: ctx.me.id, name: ctx.me.first_name, text, isBot: true, at: Date.now() });
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

export function privacyText(mode: "strict" | "normal"): string {
  return mode === "strict"
    ? [
        "🔒 <b>Privacy: strict</b>",
        "• Group messages are <b>not stored</b> and <b>never sent to Grok</b> as background.",
        "• When someone asks me, Grok sees only that message, the one it replies to, and the notes saved with /lm. No memory between questions.",
        "• Voice notes and round video messages are processed only when someone asks me about one.",
        "• Shared links and uploaded videos still get content cards (only that content is processed).",
        "• Image requests send only the description (and the photo to change) to xAI; images are not stored.",
        "",
        "Owner: <code>/privacy normal</code> enables chat context and memory.",
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
