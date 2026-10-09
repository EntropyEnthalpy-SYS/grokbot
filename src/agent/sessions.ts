import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Db } from "../db.ts";
import { isServerSideToolCall, stripServerSideToolCalls, type Grok } from "../grok/grok.ts";

/** Messages sent to Grok per request; older ones stay stored but are not sent. */
export const CONTEXT_MESSAGES = 60;
/** Messages kept in the database per chat. */
export const STORED_MESSAGES = 200;
/** Turns older than this are dropped from conversations, even while the chat stays active. */
export const CONVERSATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TurnInput {
  text: string;
  images?: ImageContent[];
}

export interface TurnOptions {
  /** Strict privacy: start with no history, never read or write the database, forget the turn afterwards. */
  ephemeral?: boolean;
}

/** A queued turn whose conversation was cleared (/new, /forget, /disable) before it started. */
export class TurnCancelledError extends Error {
  constructor() {
    super("The conversation was cleared before this question started.");
  }
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
  readonly #retentionMs: number;
  readonly #agents = new Map<string, Agent>();
  readonly #queues = new Map<string, Promise<unknown>>();
  /**
   * Bumped by reset() while turns are queued, so turns queued before a reset don't start and
   * recreate the history. Only kept while the chat has queued turns.
   */
  readonly #generations = new Map<string, number>();

  constructor(options: {
    db: Db;
    grok: Grok;
    systemPrompt: (chatKey: string) => string;
    tools?: (chatKey: string) => AgentTool[];
    /** Appended to the system prompt on every request (e.g. the chat's saved notes); never stored. */
    systemExtra?: (chatKey: string) => string;
    retentionMs?: number;
  }) {
    this.#db = options.db;
    this.#grok = options.grok;
    this.#systemPrompt = options.systemPrompt;
    this.#tools = options.tools ?? (() => []);
    this.#systemExtra = options.systemExtra ?? (() => "");
    this.#retentionMs = options.retentionMs ?? CONVERSATION_RETENTION_MS;
  }

  run(chatKey: string, input: TurnInput, handlers: TurnHandlers = {}, options: TurnOptions = {}): Promise<AssistantMessage> {
    const generation = this.#generation(chatKey);
    const previous = this.#queues.get(chatKey) ?? Promise.resolve();
    const turn = previous.catch(() => undefined).then(() => this.#runTurn(chatKey, input, handlers, generation, options.ephemeral ?? false));
    this.#queues.set(chatKey, turn);
    const done = () => {
      if (this.#queues.get(chatKey) !== turn) return;
      this.#queues.delete(chatKey);
      this.#generations.delete(chatKey);
    };
    turn.then(done, done);
    return turn;
  }

  /**
   * Retention: delete conversations not used for the retention period, and drop
   * older turns from the ones still in use (stored and in memory).
   */
  prune(now = Date.now()): number {
    const cutoff = now - this.#retentionMs;
    const rows = this.#db.prepare("SELECT chat_key, messages, updated_at FROM chats").all() as {
      chat_key: string;
      messages: string;
      updated_at: number;
    }[];
    let deleted = 0;
    for (const row of rows) {
      const messages = JSON.parse(row.messages) as AgentMessage[];
      const kept = dropExpired(messages, cutoff);
      if (row.updated_at < cutoff || (kept.length === 0 && messages.length > 0)) {
        this.reset(row.chat_key);
        deleted++;
      } else if (kept.length !== messages.length) {
        this.#db.prepare("UPDATE chats SET messages = ? WHERE chat_key = ?").run(JSON.stringify(kept), row.chat_key);
      }
    }
    for (const agent of this.#agents.values()) {
      if (!agent.state.isStreaming) agent.state.messages = dropExpired(agent.state.messages, cutoff);
    }
    return deleted;
  }

  /** Delete every conversation of a chat (all forum topics), and cancel its queued turns. */
  forgetChat(chatId: number): number {
    const keys = this.#db
      .prepare("SELECT chat_key FROM chats WHERE chat_key = ? OR chat_key LIKE ?")
      .all(`tg:${chatId}`, `tg:${chatId}:%`) as { chat_key: string }[];
    const ofChat = (key: string) => key === `tg:${chatId}` || key.startsWith(`tg:${chatId}:`);
    const live = [...this.#agents.keys(), ...this.#queues.keys()].filter(ofChat);
    for (const key of new Set([...keys.map((k) => k.chat_key), ...live])) this.reset(key);
    return keys.length;
  }

  /** Delete a conversation: stop its running turn and cancel the turns queued behind it. */
  reset(chatKey: string): void {
    if (this.#queues.has(chatKey)) this.#generations.set(chatKey, this.#generation(chatKey) + 1);
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

  #generation(chatKey: string): number {
    return this.#generations.get(chatKey) ?? 0;
  }

  async #runTurn(chatKey: string, input: TurnInput, handlers: TurnHandlers, generation: number, ephemeral: boolean): Promise<AssistantMessage> {
    if (generation !== this.#generation(chatKey)) throw new TurnCancelledError();
    handlers.onStart?.();
    // Ephemeral agents are registered too, so /stop and reset() can abort them.
    const agent = ephemeral ? this.#newAgent(chatKey, []) : (this.#agents.get(chatKey) ?? this.#newAgent(chatKey, this.#load(chatKey)));
    // Pick up /model and /route changes made since the agent was created.
    agent.state.model = this.#grok.model();
    agent.state.messages = dropOldImages(dropExpired(agent.state.messages, Date.now() - this.#retentionMs));

    let text = "";
    let toolsRan = false;
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_start" && event.message.role === "assistant") text = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
        handlers.onText?.(text);
      }
      if (event.type === "tool_execution_start") {
        toolsRan = true;
        handlers.onTool?.(event.toolName);
      }
    });
    try {
      await agent.prompt(input.text, input.images);
      // "我查一下。" and nothing else, or no text at all: the bot can't send a second message later,
      // so the model is asked once to do the work now.
      // A turn whose tools did the work (a poll posted, an image made) may end without text: that's an answer.
      const first = lastAssistant(agent.state.messages);
      const firstText = first ? assistantText(first).trim() : "";
      if (first?.stopReason === "stop" && ((!firstText && !toolsRan) || isBarePromise(firstText))) {
        await agent.prompt(FINISH_NOW);
        // Keep the conversation as question → answer: the promise and the note go, the question's photos stay the latest.
        const promiseAt = agent.state.messages.indexOf(first);
        if (lastAssistant(agent.state.messages)?.stopReason === "stop" && agent.state.messages[promiseAt + 1]?.role === "user") {
          agent.state.messages = agent.state.messages.filter((_, i) => i !== promiseAt && i !== promiseAt + 1);
        }
      }
    } finally {
      unsubscribe();
      // reset() (/new, /forget, /privacy strict) removed this agent mid-turn: don't write the history back.
      const current = this.#agents.get(chatKey) === agent && generation === this.#generation(chatKey);
      if (ephemeral) {
        if (this.#agents.get(chatKey) === agent) this.#agents.delete(chatKey);
      } else if (current) {
        this.#save(chatKey, agent.state.messages);
      }
    }
    const reply = lastAssistant(agent.state.messages);
    if (!reply) throw new Error("Grok returned no reply");
    return reply;
  }

  #newAgent(chatKey: string, messages: AgentMessage[]): Agent {
    const agent = new Agent({
      initialState: {
        systemPrompt: this.#systemPrompt(chatKey),
        model: this.#grok.model(),
        thinkingLevel: "low",
        tools: this.#tools(chatKey),
        messages,
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
 * Drop turns that started before `cutoff`. Keeps leading system messages and
 * starts at a user message, so a tool result is never separated from its call.
 */
export function dropExpired(messages: readonly AgentMessage[], cutoff: number): AgentMessage[] {
  let head = 0;
  while (head < messages.length && messages[head]?.role === "system") head++;
  let start = head;
  while (start < messages.length) {
    const message = messages[start] as AgentMessage & { timestamp?: number };
    if (message.role === "user" && (message.timestamp ?? 0) >= cutoff) break;
    start++;
  }
  if (start === head) return [...messages];
  return [...messages.slice(0, head), ...messages.slice(start)];
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

/** Sent when a reply only promised to look something up. */
export const FINISH_NOW =
  "(automatic note) Your last reply didn't answer: it was empty or only said you would check, but you can't send another message later. Do it now with your tools (search, read_link…) and give the result in this reply. If you can't find it, say what you found and what's missing.";

/** A lookup verb ("查", "核对", "調べ", "check"…). */
const LOOKUP = /查|搜|找|核對|核对|確認|确认|看看|調べ|確認し|探し|検索|\b(check(ing)?|look(ing)? (it |that )?(up|into)|search(ing)?|verify(ing)?|find(ing)? out|dig(ging)? (in|into))\b/i;
/** Who promises, or "right now": first person, "hold on", or a Japanese polite future. */
const PROMISE = /我|咱|讓我|让我|等我|稍等|馬上|马上|這就|这就|現在|现在|接下來|接下来|ます|みます|ましょう|\b(let me|i'?ll|i will|i'?m going to|hold on|checking|searching|looking|digging)\b/i;
/** Not a promise: no need / don't, someone else should look, or the lookup already happened. */
const NOT_PROMISE = new RegExp(
  [
    "不用|不必|不需要|沒必要|没必要|別|别|不要|自己|建議|建议|可以去",
    "(?<![帮幫替给給])(你|您|妳)(可以|先|再|去|自己)?(查|搜|找|看)",
    "(查|搜|找|核對|核对|確認|确认)(過|过|到|完|好了|不到|是|為|为)",
    "\\b(can'?t|cannot|won'?t|no need|already|you can|you could)\\b",
  ].join("|"),
  "i",
);
/** A reply that is only "one moment" / "稍等". */
const WAIT_ONLY = /^(請|请)?(稍等|稍候|等等|等一下|馬上|马上)[一下哈呀喔哦啊]*$|^(one (sec|second|moment)|hold on|just a (sec|second|moment))$/i;

/**
 * A short reply that only announces a lookup ("地点在河南，我按这个再查。", "收到，我查一下资料。",
 * "Hold on, checking.") instead of answering. It is judged by its last clause, so a result
 * ("查不到。", "我查過了，是翊聯。"), advice ("你可以自己查。") or a question ("要我查嗎？") doesn't count.
 */
export function isBarePromise(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 60 || /[?？]\s*$/.test(t)) return false;
  const clauses = t.split(/[，,；;。.!！…~～\n]+/).map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) return false;
  if (clauses.length === 1 && WAIT_ONLY.test(clauses[0]!)) return true;
  // "我查一下，稍等。": the promise is the clause before the "wait".
  const last = clauses.length > 1 && WAIT_ONLY.test(clauses.at(-1)!) ? clauses.at(-2)! : clauses.at(-1)!;
  return LOOKUP.test(last) && PROMISE.test(last) && !NOT_PROMISE.test(last);
}

function assistantText(message: AssistantMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
}
