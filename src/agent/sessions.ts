import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Db } from "../db.ts";
import { isServerSideToolCall, serverSearchStarted, stripServerSideToolCalls, type Grok } from "../grok/grok.ts";
import { SentStore } from "./sent.ts";

/** Messages sent to Grok per request; older ones stay stored but are not sent. */
export const CONTEXT_MESSAGES = 60;
/**
 * Characters of history sent per request (about 15k tokens). Older turns go first; documents, pages
 * and transcripts in turns before the latest are cut to their start and end, since the answer that
 * used them is in the history too.
 */
export const CONTEXT_CHARS = 60_000;
/** Text blocks longer than this in earlier turns are shortened to SHORTENED_HEAD + SHORTENED_TAIL. */
const LONG_BLOCK_CHARS = 6_000;
const SHORTENED_HEAD = 2_500;
const SHORTENED_TAIL = 1_000;
/** Messages kept in the database per chat. */
export const STORED_MESSAGES = 200;
/** Turns older than this are dropped from conversations, even while the chat stays active. */
export const CONVERSATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A reply that makes no progress this long is given up (time in our own tools, such as watching a
 * long video, doesn't count). Grok's own searches send stream events while they run, so a long
 * search isn't a stall; a dropped connection that never closes is.
 */
export const STALL_MS = 120_000;

export interface TurnInput {
  text: string;
  images?: ImageContent[];
}

export interface TurnOptions {
  /** Strict privacy: start with no history, never read or write the database, forget the turn afterwards. */
  ephemeral?: boolean;
  /** Send only the last few questions and answers, none older than this (the stored conversation keeps the rest). */
  history?: { turns: number; maxAgeMs: number };
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
  /** A tool step began, ours or one Grok runs on its servers (web_search, x_keyword_search…): for a status line. */
  onActivity?: (name: string) => void;
}

/**
 * One pi agent per chat, persisted in SQLite. Turns in the same chat run one
 * at a time; different chats run concurrently.
 */
export class ChatSessions {
  /** The bot's own messages and the conversation behind each answer (see SentStore). */
  readonly sent: SentStore;
  readonly #db: Db;
  readonly #grok: Grok;
  readonly #systemPrompt: (chatKey: string) => string;
  readonly #tools: (chatKey: string) => AgentTool[];
  readonly #systemExtra: (chatKey: string) => string;
  readonly #retentionMs: number;
  readonly #agents = new Map<string, Agent>();
  /**
   * The running turn of each chat, told when Grok starts one of its own searches and how much of the
   * reply's text came before it (`undefined` name: a new reply started). Counted in the raw stream,
   * which runs ahead of the agent's events.
   */
  readonly #onSearch = new Map<string, (name: string | undefined, textBefore: number) => void>();
  /** The running turn of each chat, told that the raw stream is still alive. */
  readonly #onStream = new Map<string, () => void>();
  readonly #stallMs: number;
  readonly #queues = new Map<string, Promise<unknown>>();
  /** How much of each conversation the current turn sends (TurnOptions.history). */
  readonly #windows = new Map<string, { turns: number; maxAgeMs: number }>();
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
    stallMs?: number;
  }) {
    this.#db = options.db;
    this.sent = new SentStore(options.db);
    this.#grok = options.grok;
    this.#systemPrompt = options.systemPrompt;
    this.#tools = options.tools ?? (() => []);
    this.#systemExtra = options.systemExtra ?? (() => "");
    this.#retentionMs = options.retentionMs ?? CONVERSATION_RETENTION_MS;
    this.#stallMs = options.stallMs ?? STALL_MS;
  }

  run(chatKey: string, input: TurnInput, handlers: TurnHandlers = {}, options: TurnOptions = {}): Promise<AssistantMessage> {
    const generation = this.#generation(chatKey);
    const previous = this.#queues.get(chatKey) ?? Promise.resolve();
    const turn = previous.catch(() => undefined).then(() => this.#runTurn(chatKey, input, handlers, generation, options));
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
    this.sent.prune(now);
    return deleted;
  }

  /** Delete every conversation of a chat (all forum topics) and the bot's messages there, and cancel its queued turns. */
  forgetChat(chatId: number): number {
    this.sent.forget(chatId);
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
    this.#windows.delete(chatKey);
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

  async #runTurn(chatKey: string, input: TurnInput, handlers: TurnHandlers, generation: number, options: TurnOptions): Promise<AssistantMessage> {
    const ephemeral = options.ephemeral ?? false;
    if (generation !== this.#generation(chatKey)) throw new TurnCancelledError();
    handlers.onStart?.();
    // Ephemeral agents are registered too, so /stop and reset() can abort them.
    const agent = ephemeral ? this.#newAgent(chatKey, []) : (this.#agents.get(chatKey) ?? this.#newAgent(chatKey, this.#load(chatKey)));
    // Pick up /model, /route and /privacy changes (which tools the chat may use) made since the agent was created.
    agent.state.model = this.#grok.model();
    agent.state.tools = this.#tools(chatKey);
    agent.state.messages = dropOldImages(dropExpired(agent.state.messages, Date.now() - this.#retentionMs));
    // Only what is sent is limited; the stored conversation keeps older turns for replies to old answers.
    if (options.history) this.#windows.set(chatKey, options.history);
    else this.#windows.delete(chatKey);

    let text = "";
    // Where Grok's last own search started in the current reply: text before it ("先查一下…", a first
    // draft) was written before the search results and doesn't belong in the answer.
    let searchCut = 0;
    const toolsUsed = new Set<string>();
    const onSearch = (name: string | undefined, textBefore: number) => {
      searchCut = textBefore;
      if (name === undefined) return;
      toolsUsed.add(LOOKED_UP);
      handlers.onActivity?.(name);
    };
    this.#onSearch.set(chatKey, onSearch);
    // No progress for #stallMs: abort, and report it as an error rather than as a /stop.
    let stalled = false;
    let toolsRunning = 0;
    let stallTimer: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(stallTimer);
      if (toolsRunning === 0) stallTimer = setTimeout(() => ((stalled = true), agent.abort()), this.#stallMs);
    };
    this.#onStream.set(chatKey, alive);
    alive();
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "tool_execution_start") toolsRunning++;
      if (event.type === "tool_execution_end") toolsRunning = Math.max(0, toolsRunning - 1);
      alive();
      if (event.type === "message_start" && event.message.role === "assistant") text = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
        handlers.onText?.(text);
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start") {
        const { partial, contentIndex } = event.assistantMessageEvent;
        const block = partial.content[contentIndex];
        if (block?.type === "toolCall" && block.name) {
          handlers.onActivity?.(block.name);
          // Grok's own web/X searches run on its servers: they never reach tool_execution_start.
          if (SEARCHES.test(block.name)) toolsUsed.add(LOOKED_UP);
        }
      }
      if (event.type === "tool_execution_start") {
        toolsUsed.add(event.toolName);
        if (LOOKUP_TOOLS.has(event.toolName)) toolsUsed.add(LOOKED_UP);
        handlers.onTool?.(event.toolName);
      }
    });
    let reply: AssistantMessage | undefined;
    const afterLastSearch = () => {
      const last = lastAssistant(agent.state.messages);
      if (!last || searchCut === 0 || assistantText(last) !== text) return;
      const kept = text.slice(searchCut).trim();
      if (kept) agent.state.messages = agent.state.messages.map((m) => (m === last ? withText(last, kept) : m));
    };
    try {
      await agent.prompt(input.text, input.images);
      afterLastSearch();
      // The model is asked once more when its reply isn't a real answer:
      // - "我查一下。" and nothing else, or no text at all: the bot can't send a second message later;
      //   a turn whose tools did the work (a poll posted, an image made) may end without text, though;
      // - "再发一张。" when no picture was made: it claims something that didn't happen.
      const first = lastAssistant(agent.state.messages);
      const firstText = first ? assistantText(first).trim() : "";
      const unfinished = (!firstText && toolsUsed.size === 0) || isBarePromise(firstText);
      const claim = unfinished ? undefined : falseClaim(firstText, toolsUsed);
      if (first?.stopReason === "stop" && (unfinished || claim)) {
        await agent.prompt(claim ? claim.note : FINISH_NOW);
        afterLastSearch();
        // Keep the conversation as question → answer: the promise and the note go, the question's photos stay the latest.
        const promiseAt = agent.state.messages.indexOf(first);
        if (lastAssistant(agent.state.messages)?.stopReason === "stop" && agent.state.messages[promiseAt + 1]?.role === "user") {
          agent.state.messages = agent.state.messages.filter((_, i) => i !== promiseAt && i !== promiseAt + 1);
        }
      }
    } finally {
      // The reply as it happened (an error stays an error for the caller), before the history is tidied.
      reply = lastAssistant(agent.state.messages);
      unsubscribe();
      clearTimeout(stallTimer);
      if (this.#onSearch.get(chatKey) === onSearch) this.#onSearch.delete(chatKey);
      if (this.#onStream.get(chatKey) === alive) this.#onStream.delete(chatKey);
      // reset() (/new, /forget, /privacy strict) removed this agent mid-turn: don't write the history back.
      const current = this.#agents.get(chatKey) === agent && generation === this.#generation(chatKey);
      if (ephemeral) {
        if (this.#agents.get(chatKey) === agent) this.#agents.delete(chatKey);
      } else if (current) {
        agent.state.messages = keepWhatWasSeen(forgetTransient(agent.state.messages), text);
        this.#save(chatKey, agent.state.messages);
      }
    }
    if (!reply) throw new Error("Grok returned no reply");
    if (stalled && reply.stopReason === "aborted") {
      return { ...reply, stopReason: "error", errorMessage: `no response from the AI for ${Math.round(this.#stallMs / 1000)} s (network)` };
    }
    return reply;
  }

  #newAgent(chatKey: string, messages: AgentMessage[]): Agent {
    // The current response's text so far, from the raw stream (one chat's turns run one at a time).
    let rawText = "";
    const agent = new Agent({
      initialState: {
        systemPrompt: this.#systemPrompt(chatKey),
        model: this.#grok.model(),
        thinkingLevel: "low",
        tools: this.#tools(chatKey),
        messages,
      },
      // Grok's own searches only show in the raw stream: tell the running turn about them.
      streamFn: (model, context, options) =>
        this.#grok.streamFn(model, context, {
          ...options,
          onProviderStreamEvent: (event, eventModel) => {
            this.#onStream.get(chatKey)?.();
            rawText = rawTextAfter(rawText, event);
            if ((event as { type?: unknown } | undefined)?.type === "response.created") this.#onSearch.get(chatKey)?.(undefined, 0);
            const search = serverSearchStarted(event);
            if (search) this.#onSearch.get(chatKey)?.(search, rawText.length);
            return options?.onProviderStreamEvent?.(event, eventModel);
          },
        }),
      transformContext: async (messages) => {
        const window = this.#windows.get(chatKey);
        const recent = window ? lastTurns(dropExpired(messages, Date.now() - window.maxAgeMs), window.turns) : messages;
        return withSystemExtra(fitBudget(trimContext(recent, CONTEXT_MESSAGES), CONTEXT_CHARS), this.#systemExtra(chatKey));
      },
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

/** The text of the current Responses API reply after a raw stream event (a new response starts empty). */
function rawTextAfter(text: string, event: unknown): string {
  const { type, delta } = (event ?? {}) as { type?: unknown; delta?: unknown };
  if (type === "response.created") return "";
  return type === "response.output_text.delta" && typeof delta === "string" ? text + delta : text;
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
 * Keep a request's history under `budget` characters: text in turns before the latest is shortened
 * to its start and end (a document, page or transcript the answer already used), then the oldest
 * turns go. The latest turn is always sent whole.
 */
export function fitBudget(messages: readonly AgentMessage[], budget: number): AgentMessage[] {
  let head = 0;
  while (head < messages.length && messages[head]?.role === "system") head++;
  let latest = messages.length;
  for (let i = messages.length - 1; i >= head; i--) {
    if (messages[i]?.role === "user") {
      latest = i;
      break;
    }
  }
  const result = messages.map((message, i) => (i >= head && i < latest ? shortened(message) : message));
  let total = result.slice(head).reduce((sum, message) => sum + messageChars(message), 0);
  let start = head;
  while (total > budget && start < latest) {
    // Drop one whole turn: from this user message up to the next one.
    let end = start + 1;
    while (end < latest && result[end]?.role !== "user") end++;
    for (let i = start; i < end; i++) total -= messageChars(result[i]!);
    start = end;
  }
  return [...result.slice(0, head), ...result.slice(start)];
}

function messageChars(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content as { type: string; text?: string; thinking?: string; arguments?: unknown }[]) {
    if (block.type === "text") chars += block.text?.length ?? 0;
    else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
    else if (block.type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length;
    else if (block.type === "image") chars += 1_000;
  }
  return chars;
}

function shorten(text: string): string {
  if (text.length <= LONG_BLOCK_CHARS) return text;
  const cut = text.length - SHORTENED_HEAD - SHORTENED_TAIL;
  return `${text.slice(0, SHORTENED_HEAD)}\n[… ${cut} characters left out of this earlier message …]\n${text.slice(-SHORTENED_TAIL)}`;
}

function shortened(message: AgentMessage): AgentMessage {
  if (message.role !== "user" && message.role !== "toolResult") return message;
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content.length > LONG_BLOCK_CHARS ? ({ ...message, content: shorten(content) } as AgentMessage) : message;
  if (!Array.isArray(content) || !content.some((b) => b.type === "text" && b.text.length > LONG_BLOCK_CHARS)) return message;
  return { ...message, content: content.map((b) => (b.type === "text" ? { ...b, text: shorten(b.text) } : b)) } as AgentMessage;
}

/** An assistant message with its text replaced (thinking and tool calls stay). */
function withText(message: AssistantMessage, text: string): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  let placed = false;
  for (const block of message.content) {
    if (block.type !== "text") content.push(block);
    else if (!placed) {
      content.push({ ...block, text });
      placed = true;
    }
  }
  return { ...message, content };
}

/**
 * A failed or stopped reply is skipped when the history is sent again, so the model would never know
 * what the person saw (and the next question would follow theirs with no answer between). It becomes
 * the text that was shown, marked unfinished.
 */
export function keepWhatWasSeen(messages: readonly AgentMessage[], shownText: string): AgentMessage[] {
  const last = messages.at(-1) as AssistantMessage | undefined;
  if (last?.role !== "assistant" || (last.stopReason !== "error" && last.stopReason !== "aborted")) return [...messages];
  const how = last.stopReason === "aborted" ? "stopped" : "failed";
  const shown = shownText.trim();
  const text = shown ? `${shown}\n\n(this answer ${how} before it was finished)` : `(no answer: it ${how})`;
  const kept: AssistantMessage = { ...last, content: [{ type: "text", text }], stopReason: "stop", errorMessage: undefined };
  return [...messages.slice(0, -1), kept];
}

/** Tools whose results serve one answer only (the group chat): later questions see a placeholder instead. */
export const TRANSIENT_TOOLS = new Set(["read_group_chat", "search_chat"]);

export function forgetTransient(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((m) =>
    m.role === "toolResult" && TRANSIENT_TOOLS.has((m as { toolName?: string }).toolName ?? "")
      ? ({ ...m, content: [{ type: "text", text: "(group chat was read for that answer; not kept)" }] } as AgentMessage)
      : m,
  );
}

/** Only the last `turns` questions with their answers (and tool calls), plus leading system messages. */
export function lastTurns(messages: readonly AgentMessage[], turns: number): AgentMessage[] {
  let head = 0;
  while (head < messages.length && messages[head]?.role === "system") head++;
  const starts = messages.map((m, i) => (i >= head && m.role === "user" ? i : -1)).filter((i) => i >= 0);
  if (starts.length <= turns) return [...messages];
  const from = turns > 0 ? starts[starts.length - turns]! : messages.length;
  return [...messages.slice(0, head), ...messages.slice(from)];
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


/** Sent when a reply said it posted a picture but none was made. */
export const NO_IMAGE_SENT =
  "(automatic note) Your reply says you sent a picture, but no picture was posted: pictures only appear when you call create_image. Either call create_image now (only for a drawing or illustration, never a fake photo of a real person), or say plainly that you can't post that picture, and give a search link instead if it helps.";

/** Any search or read during a reply; facts stated without one came from the model's memory. */
const LOOKED_UP = "lookup";
/** Grok's server-side tools (web_search, x_keyword_search, browse_page…). */
const SEARCHES = /search|browse|^x_/i;
/** Our tools that look things up. */
const LOOKUP_TOOLS = new Set(["search_web", "read_link", "watch_video", "read_group_chat", "search_chat"]);
/** "官网", "官方标价", "according to the official site". */
const OFFICIAL = /官網|官网|官方(標價|标价|價格|价格|定價|定价|公布|說明|说明|文檔|文档|資料|资料)|\b(according to (the )?official|official (site|website|pricing|price|docs))\b/i;
/** A price with a period or a plan: "$25/月", "每月 $5", "40刀套餐", "$10 per month". */
const PRICE = /[$¥€£]\s?\d|\d\s?(美元|美金|刀|USD|RMB)/i;
const PLAN = /月|年|套餐|訂閱|订阅|額度|额度|價|价|month|year|\/mo\b|plan|subscription|tier|credit/i;

/** Sent when a reply states current facts (or says it checked) but nothing was searched or read. */
export const UNCHECKED_FACTS =
  "(automatic note) Your reply states current facts (prices, plans, what an official site says) or says you checked, but you didn't search or read anything in this reply: it came from memory, which is often outdated or wrong. Search now (the official site first; third-party pages are often old) and answer only from what you find; leave out what you can't confirm and say so. If you can't search, say you can't confirm it right now. If the numbers only come from the question or are plain arithmetic, give the same answer again.";

/** Things the bot can only do through a tool; saying it did them without the tool is a false claim. */
const CLAIMS: { action: string; tool?: string; says: (sentence: string) => boolean; note: string; refusal?: boolean }[] = [
  { action: "image", tool: "create_image", says: (s) => claimsImageSent(s), note: NO_IMAGE_SENT },
  {
    action: "note",
    tool: "remember",
    says: (s) => /(記住了|记住了|已記住|已记住|記下了|记下了|已記下|已记下|存好了|已保存|已存下)|\b(noted|i'?ll remember (that|it|this)|saved (it|that|this|a note))\b/i.test(s),
    note: "(automatic note) Your reply says you saved a note, but nothing was saved: notes are saved only when you call the remember tool. Call it now if someone explicitly asked you to remember something, or say it wasn't saved and that /lm add … saves a note.",
  },
  {
    action: "poll",
    tool: "create_poll",
    says: (s) => /(投票(已|來了|来了|開好|开好|發起|发起|建好)|(已|幫你|帮你)?(發起|发起|開了|开了|建了)(一個|一个)?投票)|\b(poll (is up|posted|created)|i'?ve (posted|created|started) (a|the) poll)\b/i.test(s),
    note: "(automatic note) Your reply says a poll was posted, but none was: polls appear only when you call create_poll. Call it now if someone asked for a poll, or say you didn't post one.",
  },
  {
    action: "file",
    tool: "send_file",
    says: (s) =>
      /(文件|檔案|档案|附件)(已经|已經|已)?(發|发|傳|传|附上|送)(出|好|了|上|到)?|(文件|檔案|档案|附件)(在上面|在下面|在這|在这|見上|见上|如下)|(見|见)附件|(已经|已經|已)(發|发|傳|传|附上)(給你|给你)?(了)?(一個|一个)?[\w.-]*\s*(文件|檔案|档案)|\b(here(?:'s| is) (?:the|your) file|i'?ve (?:sent|attached) (?:the|a|your) file|file (?:is )?(?:attached|sent|above|below))\b/i.test(s),
    note: "(automatic note) Your reply says you sent a file, but none was sent: files are sent only when you call send_file. Call send_file now with the complete content and a fitting file name, and keep your reply to one line.",
  },
  {
    action: "file refusal",
    tool: "send_file",
    refusal: true,
    says: (s) => /(發不出|发不出|發不了|发不了|不能發|不能发|沒法發|没法发|無法發送|无法发送|没办法发|沒辦法發)(送)?(任何)?(文件|檔案|档案|附件)|\bcan'?t (?:send|attach) (?:a |the |any )?files?\b/i.test(s),
    note: "(automatic note) You can send files: call send_file now with the complete content and a fitting file name (e.g. .md for Markdown), and keep your reply to one line.",
  },
  {
    action: "reminder",
    says: (s) => /((已|會|会|到時|到时|屆時|届时)(幫你|帮你|給你|给你)?(設|设|定)?(好)?(提醒|叫你)|提醒(已|設好|设好|定好))|\b(i'?ll remind|i will remind|reminder (is )?set|i'?ve set (a|the|your) reminder)\b/i.test(s),
    note: "(automatic note) Your reply says a reminder was set, but you can't set reminders in a reply: nothing was scheduled. Say so, and tell them to send: /remind <time> <what>, e.g. /remind 明天9点 开会.",
  },
  {
    // "我去对一下…" followed by an answer from memory; "官方标价是…"; "Pro $25/月".
    action: "unchecked facts",
    tool: LOOKED_UP,
    says: (s) => announcesLookup(s) || OFFICIAL.test(s) || (PRICE.test(s) && PLAN.test(s)),
    note: UNCHECKED_FACTS,
  },
];

/** "我去对一下 OpenCode 的价格。", "Let me check the docs." (the clause that announces a lookup). */
function announcesLookup(sentence: string): boolean {
  return sentence.split(/[，,：:]/).some((c) => LOOKUP.test(c) && PROMISE.test(c) && !NOT_PROMISE.test(c));
}

/** "不會提醒", "can't remember", "没保存": a sentence that denies the action isn't a claim. */
const DENIES = /不|沒|没|無法|无法|未|別|别|can'?t|cannot|won'?t|didn'?t|not\b|unable/i;

/** The first action a reply claims to have done although its tool didn't run (one sentence at a time, denials skipped). */
export function falseClaim(text: string, toolsUsed: ReadonlySet<string>): { action: string; note: string } | undefined {
  // Split after the punctuation, so a question keeps its "？" and isn't taken for a claim.
  const sentences = text.split(/(?<=[。！!？?\n；;])/).map((s) => s.trim()).filter(Boolean);
  const question = (s: string) => /[?？]$|(吗|嗎|呢|么|麼)[。.]?$/.test(s);
  for (const claim of CLAIMS) {
    if (claim.tool && toolsUsed.has(claim.tool)) continue;
    // A refusal ("这里发不出文件") is wrong exactly when it denies: those skip the denial filter.
    if (sentences.some((s) => claim.says(s) && (claim.refusal || !DENIES.test(s)) && !question(s))) return { action: claim.action, note: claim.note };
  }
  return undefined;
}

/**
 * A reply saying a picture was sent or is attached ("再发一张。", "照片如下", "图来了",
 * "Here's the photo"). Offers ("要我画一张吗？") and refusals ("发不了图") don't count.
 */
export function claimsImageSent(text: string): boolean {
  const t = text.trim();
  if (!t || /[?？]\s*$/.test(t)) return false;
  if (/(不能|没法|沒法|無法|无法|發不了|发不了|不會|不会|can'?t|cannot|unable|won'?t)/i.test(t)) return false;
  // A verb of sending + a picture word or measure word ("发一张", "传图", "贴照片"), or "照片如下" / "图来了".
  const zh = /(發|发|傳|传|貼|贴)(了|給你|给你|你)?((一|幾|几|兩|两|多)?(張|张|幅)|(圖|图|照片|圖片|图片|写真|寫真))|(照片|圖片|图片|圖|图|写真|寫真)(如下|來了|来了|在這|在这|在此|送上|奉上)/;
  const en = /\b(here('s| is| are)( a| the| some)? (photo|picture|image|pic)s?|i'?ve (sent|attached|posted) (a|the|some)? ?(photo|picture|image|pic)s?|sending (another|a|one more) (photo|picture|image|pic))\b/i;
  return zh.test(t) || en.test(t);
}

/** Sent when a reply only promised to look something up. */
export const FINISH_NOW =
  "(automatic note) Your last reply didn't answer: it was empty or only said you would check, but you can't send another message later. Do it now with your tools (search, read_link…) and give the result in this reply. If you can't find it, say what you found and what's missing.";

/** A lookup verb ("查", "核对", "調べ", "check"…). */
const LOOKUP = /查|搜|找|翻|挖|核|對一下|对一下|比對|比对|確認|确认|看看|試試|试试|研究|調べ|確認し|探し|検索|\b(check(ing)?|look(ing)? (it |that )?(up|into)|search(ing)?|verify(ing)?|find(ing)? out|dig(ging)? (in|into))\b/i;
/** Who promises, or "right now": first person, "hold on", or a Japanese polite future. */
const PROMISE = /我|咱|讓我|让我|等我|稍等|馬上|马上|這就|这就|現在|现在|正在|還在|还在|繼續|继续|接下來|接下来|ます|みます|ましょう|\b(let me|i'?ll|i will|i'?m going to|hold on|checking|searching|looking|digging)\b/i;
/** Not a promise: no need / don't, someone else should look, or the lookup already happened. */
const NOT_PROMISE = new RegExp(
  [
    "不用|不必|不需要|沒必要|没必要|(別|别)(?![的人處处家])|不要|自己|建議|建议|可以去",
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
