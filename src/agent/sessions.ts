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
    const toolsUsed = new Set<string>();
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_start" && event.message.role === "assistant") text = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
        handlers.onText?.(text);
      }
      if (event.type === "tool_execution_start") {
        toolsUsed.add(event.toolName);
        handlers.onTool?.(event.toolName);
      }
    });
    try {
      await agent.prompt(input.text, input.images);
      // The model is asked once more when its reply isn't a real answer:
      // - "我查一下。" and nothing else, or no text at all: the bot can't send a second message later;
      //   a turn whose tools did the work (a poll posted, an image made) may end without text, though;
      // - "再发一张。" when no picture was made: it claims something that didn't happen.
      const first = lastAssistant(agent.state.messages);
      const firstText = first ? assistantText(first).trim() : "";
      const unfinished = (!firstText && toolsUsed.size === 0) || isBarePromise(firstText);
      const claim = falseClaim(firstText, toolsUsed);
      if (first?.stopReason === "stop" && (unfinished || claim)) {
        await agent.prompt(claim ? claim.note : FINISH_NOW);
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


/** Sent when a reply said it posted a picture but none was made. */
export const NO_IMAGE_SENT =
  "(automatic note) Your reply says you sent a picture, but no picture was posted: pictures only appear when you call create_image. Either call create_image now (only for a drawing or illustration, never a fake photo of a real person), or say plainly that you can't post that picture, and give a search link instead if it helps.";

/** Things the bot can only do through a tool; saying it did them without the tool is a false claim. */
const CLAIMS: { action: string; tool?: string; says: (sentence: string) => boolean; note: string }[] = [
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
    action: "reminder",
    says: (s) => /((已|會|会|到時|到时|屆時|届时)(幫你|帮你|給你|给你)?(設|设|定)?(好)?(提醒|叫你)|提醒(已|設好|设好|定好))|\b(i'?ll remind|i will remind|reminder (is )?set|i'?ve set (a|the|your) reminder)\b/i.test(s),
    note: "(automatic note) Your reply says a reminder was set, but you can't set reminders in a reply: nothing was scheduled. Say so, and tell them to send: /remind <time> <what>, e.g. /remind 明天9点 开会.",
  },
];

/** "不會提醒", "can't remember", "没保存": a sentence that denies the action isn't a claim. */
const DENIES = /不|沒|没|無法|无法|未|別|别|can'?t|cannot|won'?t|didn'?t|not\b|unable/i;

/** The first action a reply claims to have done although its tool didn't run (one sentence at a time, denials skipped). */
export function falseClaim(text: string, toolsUsed: ReadonlySet<string>): { action: string; note: string } | undefined {
  // Split after the punctuation, so a question keeps its "？" and isn't taken for a claim.
  const sentences = text.split(/(?<=[。！!？?\n；;])/).map((s) => s.trim()).filter(Boolean);
  const question = (s: string) => /[?？]$|(吗|嗎|呢|么|麼)[。.]?$/.test(s);
  for (const claim of CLAIMS) {
    if (claim.tool && toolsUsed.has(claim.tool)) continue;
    if (sentences.some((s) => claim.says(s) && !DENIES.test(s) && !question(s))) return { action: claim.action, note: claim.note };
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
