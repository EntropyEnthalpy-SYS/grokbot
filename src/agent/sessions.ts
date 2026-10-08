import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Db } from "../db.ts";
import { isServerSideToolCall, stripServerSideToolCalls, type Grok } from "../grok/grok.ts";

/** Messages sent to Grok per request; older ones stay stored but are not sent. */
export const CONTEXT_MESSAGES = 60;
/** Messages kept in the database per chat. */
export const STORED_MESSAGES = 200;

export interface TurnInput {
  text: string;
  images?: ImageContent[];
}

export interface TurnHandlers {
  /** Runs when the turn actually starts (after earlier turns of the same chat finished). */
  onStart?: () => void;
  onText?: (text: string) => void;
  onTool?: (name: string) => void;
}

/**
 * One pi agent per chat, persisted in SQLite. Turns in the same chat run one
 * at a time; different chats run concurrently.
 */
export class ChatSessions {
  readonly #db: Db;
  readonly #grok: Grok;
  readonly #systemPrompt: (chatKey: string) => string;
  readonly #tools: (chatKey: string) => AgentTool[];
  readonly #systemExtra: (chatKey: string) => string;
  readonly #agents = new Map<string, Agent>();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: {
    db: Db;
    grok: Grok;
    systemPrompt: (chatKey: string) => string;
    tools?: (chatKey: string) => AgentTool[];
    /** Appended to the system prompt on every request (e.g. the chat's saved notes); never stored. */
    systemExtra?: (chatKey: string) => string;
  }) {
    this.#db = options.db;
    this.#grok = options.grok;
    this.#systemPrompt = options.systemPrompt;
    this.#tools = options.tools ?? (() => []);
    this.#systemExtra = options.systemExtra ?? (() => "");
  }

  run(chatKey: string, input: TurnInput, handlers: TurnHandlers = {}): Promise<AssistantMessage> {
    const previous = this.#queues.get(chatKey) ?? Promise.resolve();
    const turn = previous.catch(() => undefined).then(() => this.#runTurn(chatKey, input, handlers));
    this.#queues.set(chatKey, turn);
    const done = () => {
      if (this.#queues.get(chatKey) === turn) this.#queues.delete(chatKey);
    };
    turn.then(done, done);
    return turn;
  }

  /** Delete stored conversations not used for `maxAgeMs`, and their in-memory agents. */
  prune(maxAgeMs: number, now = Date.now()): number {
    const stale = this.#db.prepare("SELECT chat_key FROM chats WHERE updated_at < ?").all(now - maxAgeMs) as { chat_key: string }[];
    for (const { chat_key } of stale) this.reset(chat_key);
    return stale.length;
  }

  /** Delete every conversation of a chat (all forum topics). */
  forgetChat(chatId: number): number {
    const keys = this.#db
      .prepare("SELECT chat_key FROM chats WHERE chat_key = ? OR chat_key LIKE ?")
      .all(`tg:${chatId}`, `tg:${chatId}:%`) as { chat_key: string }[];
    for (const key of new Set([...keys.map((k) => k.chat_key), ...[...this.#agents.keys()].filter((k) => k === `tg:${chatId}` || k.startsWith(`tg:${chatId}:`))])) {
      this.reset(key);
    }
    return keys.length;
  }

  reset(chatKey: string): void {
    this.#agents.get(chatKey)?.abort();
    this.#agents.delete(chatKey);
    this.#db.prepare("DELETE FROM chats WHERE chat_key = ?").run(chatKey);
  }

  /** Stop every running reply of a chat (all forum topics and per-question conversations). */
  abortChat(chatId: number): number {
    let stopped = 0;
    for (const [key, agent] of this.#agents) {
      if ((key === `tg:${chatId}` || key.startsWith(`tg:${chatId}:`)) && agent.state.isStreaming) {
        agent.abort();
        stopped++;
      }
    }
    return stopped;
  }

  /** Turns queued or running, for tests and /status. */
  get pendingChats(): number {
    return this.#queues.size;
  }

  abort(chatKey: string): boolean {
    const agent = this.#agents.get(chatKey);
    if (!agent?.state.isStreaming) return false;
    agent.abort();
    return true;
  }

  async #runTurn(chatKey: string, input: TurnInput, handlers: TurnHandlers): Promise<AssistantMessage> {
    handlers.onStart?.();
    const agent = this.#agent(chatKey);
    // Pick up /model and /route changes made since the agent was created.
    agent.state.model = this.#grok.model();
    agent.state.messages = dropOldImages(agent.state.messages);

    let text = "";
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_start" && event.message.role === "assistant") text = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
        handlers.onText?.(text);
      }
      if (event.type === "tool_execution_start") handlers.onTool?.(event.toolName);
    });
    try {
      await agent.prompt(input.text, input.images);
    } finally {
      unsubscribe();
      // reset() (/new, /forget, /privacy strict) removed this agent mid-turn: don't write the history back.
      if (this.#agents.get(chatKey) === agent) this.#save(chatKey, agent.state.messages);
    }
    const reply = lastAssistant(agent.state.messages);
    if (!reply) throw new Error("Grok returned no reply");
    return reply;
  }

  #agent(chatKey: string): Agent {
    const existing = this.#agents.get(chatKey);
    if (existing) return existing;
    const agent = new Agent({
      initialState: {
        systemPrompt: this.#systemPrompt(chatKey),
        model: this.#grok.model(),
        thinkingLevel: "low",
        tools: this.#tools(chatKey),
        messages: this.#load(chatKey),
      },
      streamFn: this.#grok.streamFn,
      transformContext: async (messages) => withSystemExtra(trimContext(messages, CONTEXT_MESSAGES), this.#systemExtra(chatKey)),
      sessionId: chatKey,
    });
    this.#agents.set(chatKey, agent);
    return agent;
  }

  #load(chatKey: string): AgentMessage[] {
    const row = this.#db.prepare("SELECT messages FROM chats WHERE chat_key = ?").get(chatKey) as
      | { messages: string }
      | undefined;
    return row ? cleanHistory(JSON.parse(row.messages) as AgentMessage[]) : [];
  }

  #save(chatKey: string, messages: readonly AgentMessage[]): void {
    // The system prompt is rebuilt from code on load, so it is never stored.
    const stored = trimContext(
      dropOldImages(messages.filter((message) => message.role !== "system")),
      STORED_MESSAGES,
    );
    this.#db
      .prepare(
        "INSERT INTO chats (chat_key, messages, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(chat_key) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at",
      )
      .run(chatKey, JSON.stringify(stored), Date.now());
  }
}

/** Add text to the leading system message of a request (a copy; the stored transcript is untouched). */
export function withSystemExtra(messages: AgentMessage[], extra: string): AgentMessage[] {
  if (!extra || messages[0]?.role !== "system") return messages;
  const first = messages[0] as AgentMessage & { content: string | { type: string; text?: string }[] };
  const content = typeof first.content === "string" ? first.content + extra : [...first.content, { type: "text", text: extra }];
  return [{ ...first, content } as AgentMessage, ...messages.slice(1)];
}

/**
 * Keep leading system messages plus at most `limit` recent messages, starting
 * at a user message so a tool result is never separated from its call.
 */
export function trimContext(messages: readonly AgentMessage[], limit: number): AgentMessage[] {
  let head = 0;
  while (head < messages.length && messages[head]?.role === "system") head++;
  const system = messages.slice(0, head);
  const rest = messages.slice(head);
  if (rest.length <= limit) return [...system, ...rest];
  let start = rest.length - limit;
  while (start < rest.length && rest[start]?.role !== "user") start++;
  return [...system, ...rest.slice(start)];
}

/**
 * Replace images with "[image]" everywhere except the latest turn (from the
 * last user message on), so photos and X charts don't pile up in memory, in
 * the database, and in every later request. One follow-up still sees them.
 */
export function dropOldImages(messages: readonly AgentMessage[]): AgentMessage[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  return messages.map((message, index) => {
    if (index >= lastUser || (message.role !== "user" && message.role !== "toolResult")) return message;
    const content = (message as { content: unknown }).content;
    if (!Array.isArray(content) || !content.some((block) => block.type === "image")) return message;
    return {
      ...message,
      content: content.map((block) => (block.type === "image" ? { type: "text", text: "[image]" } : block)),
    } as AgentMessage;
  });
}

/**
 * Remove xAI server-side tool calls from stored assistant messages, and the
 * tool results answering them (written before the stream filter existed).
 */
export function cleanHistory(messages: readonly AgentMessage[]): AgentMessage[] {
  const removed = new Set<string>();
  const cleaned: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      for (const block of assistant.content) {
        if (block.type === "toolCall" && isServerSideToolCall(block)) removed.add(block.id);
      }
      cleaned.push(stripServerSideToolCalls(assistant));
    } else if (message.role === "toolResult" && removed.has((message as ToolResultMessage).toolCallId)) {
      continue;
    } else {
      cleaned.push(message);
    }
  }
  return cleaned;
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
}
