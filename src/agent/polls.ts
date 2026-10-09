import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Confirmer } from "./actions.ts";
import { escapeHtml } from "../telegram/format.ts";

export interface PollRequest {
  question: string;
  options: string[];
  multiple: boolean;
  anonymous: boolean;
}

/** Posts a poll into a chat (set by the bot once it exists). */
export type PollPoster = (chatId: number, threadId: number | undefined, poll: PollRequest) => Promise<void>;

const PollParams = Type.Object({
  question: Type.String({ description: "The poll question, at most 300 characters." }),
  options: Type.Array(Type.String({ description: "One answer, at most 100 characters." }), { description: "2 to 12 answers." }),
  multiple_answers: Type.Optional(Type.Boolean({ description: "Allow choosing several answers." })),
  anonymous: Type.Optional(Type.Boolean({ description: "Hide who voted what. Default false (friends see each other's votes)." })),
});

/** "tg:-123:topic:5" → { chatId: -123, threadId: 5 }; per-question keys ("…:q77") keep the chat. */
export function chatOfKey(key: string): { chatId: number; threadId?: number } {
  const match = key.match(/^tg:(-?\d+)(?::topic:(\d+))?/);
  return { chatId: Number(match?.[1]), threadId: match?.[2] ? Number(match[2]) : undefined };
}

/** Check and tidy a poll the model asked for; throws with a reason Grok can relay. */
export function cleanPoll(input: { question: string; options: string[]; multiple_answers?: boolean; anonymous?: boolean }): PollRequest {
  const question = input.question.trim();
  const options = [...new Set(input.options.map((o) => o.trim()).filter(Boolean))];
  if (!question) throw new Error("The poll needs a question.");
  if (question.length > 300) throw new Error("The question is longer than 300 characters.");
  if (options.length < 2) throw new Error("A poll needs at least 2 different answers.");
  if (options.length > 12) throw new Error("Telegram polls allow at most 12 answers.");
  const tooLong = options.find((o) => o.length > 100);
  if (tooLong) throw new Error(`The answer "${tooLong.slice(0, 30)}…" is longer than 100 characters.`);
  return { question, options, multiple: input.multiple_answers ?? false, anonymous: input.anonymous ?? false };
}

/** The create_poll agent tool: "grok, 開個投票 晚餐吃什麼 拉麵/火鍋/壽司". */
export class PollDesk {
  poster: PollPoster | undefined;

  /** `confirm`: in groups that want it, the poll is shown as a preview and posted after the asker's ✅. */
  tool(key: string, confirm?: Confirmer): AgentTool<typeof PollParams, undefined> {
    return {
      name: "create_poll",
      label: "Creating poll",
      description:
        "Post a native Telegram poll in this chat. Use it when someone asks for a poll or a vote (投票, 表決, poll). " +
        "The poll appears right away; then reply with at most one short sentence.",
      parameters: PollParams,
      execute: async (_id, input) => {
        const { chatId, threadId } = chatOfKey(key);
        if (!this.poster || !Number.isFinite(chatId)) return { content: [{ type: "text", text: "Polls can't be posted here." }], details: undefined, isError: true };
        try {
          const poll = cleanPoll(input);
          const poster = this.poster;
          if (confirm?.required()) {
            await confirm.propose({
              label: "✅ Post poll",
              preview: `📊 <b>Post this poll?</b>\n${escapeHtml(poll.question)}\n${poll.options.map((o) => `• ${escapeHtml(o)}`).join("\n")}`,
              run: async () => {
                await poster(chatId, threadId, poll);
                return "📊 Poll posted";
              },
            });
            return { content: [{ type: "text", text: "Not posted yet: a preview with a ✅ Post button is shown for the person who asked. Say so in one short sentence." }], details: undefined };
          }
          await poster(chatId, threadId, poll);
          return { content: [{ type: "text", text: "Poll posted." }], details: undefined };
        } catch (error) {
          return { content: [{ type: "text", text: `Poll not posted: ${(error as Error).message}` }], details: undefined, isError: true };
        }
      },
    };
  }
}
