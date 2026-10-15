import type { Bot, Context } from "grammy";
import type { Message, User } from "grammy/types";
import { escapeHtml } from "./format.ts";
import { errorMessage } from "../grok/grok.ts";

/** Telegram allows 128; shorter titles stay readable in the topic list. */
const TITLE_MAX = 60;

export interface PuckDeps {
  /** Why this person can't open a topic in this chat, or undefined when they can. */
  refusal: (chatId: number, user: User) => string | undefined;
  /** Puck posted the question in a new topic: the main bot answers it there. */
  opened: (posted: Message, question: string, asker: User) => void;
}

export function topicTitle(question: string): string {
  const title = question.replace(/\s+/g, " ").trim();
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export function topicLink(chatId: number, threadId: number): string {
  return `https://t.me/c/${String(chatId).replace(/^-100/, "")}/${threadId}`;
}

/**
 * Puck, a second bot that only opens topics: `/topic <question>` (or `/topic` as a reply) in a forum
 * group creates a topic named after the question and posts the question there as Puck, so the topic
 * starts with the question rather than the bot's answer. The main bot then answers inside it.
 */
export function installPuck(puck: Bot, { refusal, opened }: PuckDeps): void {
  puck.command("topic", async (ctx) => {
    const message = ctx.message;
    if (!message || !ctx.from || ctx.from.is_bot) return;
    const chat = message.chat;
    const here = message.is_topic_message && message.message_thread_id ? { message_thread_id: message.message_thread_id } : {};
    const reply = (html: string) =>
      ctx.reply(html, {
        ...here,
        parse_mode: "HTML",
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        link_preview_options: { is_disabled: true },
      });
    if (chat.type !== "supergroup" || !chat.is_forum) return void (await reply("This group doesn't have Topics turned on."));
    const refused = refusal(chat.id, ctx.from);
    if (refused) return void (await reply(refused));
    const quoted = message.reply_to_message;
    const question = (ctx.match || quoted?.text || quoted?.caption || "").trim();
    if (!question) return void (await reply("Usage: <code>/topic your question</code>, or reply <code>/topic</code> to a message."));
    const title = topicTitle(question);
    let posted: Message;
    try {
      const topic = await ctx.api.createForumTopic(chat.id, title);
      posted = await ctx.api.sendMessage(chat.id, `${escapeHtml(question)}\n\n— ${escapeHtml(asker(ctx.from))}`, {
        message_thread_id: topic.message_thread_id,
        parse_mode: "HTML",
      });
    } catch (error) {
      return void (await reply(`❌ Couldn't open the topic: ${escapeHtml(errorMessage(error))}`));
    }
    opened(posted, question, ctx.from);
    await reply(`➡️ <a href="${topicLink(chat.id, posted.message_thread_id!)}">${escapeHtml(title)}</a>`).catch(() => undefined);
  });
}

export async function registerPuckCommands(puck: Bot): Promise<void> {
  await puck.api.setMyCommands([{ command: "topic", description: "Open a topic for a question; the bot answers there" }], {
    scope: { type: "all_group_chats" },
  });
}

function asker(user: User): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "someone";
}
