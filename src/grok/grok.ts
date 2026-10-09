import {
  createAssistantMessageEventStream,
  createModels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type CredentialStore,
  type ImageContent,
  type Message,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getSetting, setSetting, type Db } from "../db.ts";
import { SEARCH_TOOL_NAME } from "../links/search.ts";

const PROVIDER = "xai";

/**
 * Subscriptions that can answer chat. Grok also powers search, speech-to-text and
 * images, which stay on xAI.
 * - ChatGPT: OpenAI's official "Sign in with ChatGPT" plan sharing (pi is a launch partner).
 * - Claude: third-party apps may use Pro/Max limits again (support.claude.com article
 *   15036540, Oct 2026); Max and Team plans also include monthly API credits, used
 *   with an API key from the linked Console organization.
 * Gemini is not offered: Google suspended paid accounts used through third-party agents.
 */
export const CHAT_PROVIDERS = {
  xai: { name: "Grok (SuperGrok)", short: "Grok", apiKey: false },
  openai: { name: "ChatGPT (Plus/Pro)", short: "ChatGPT", apiKey: false },
  anthropic: { name: "Claude (Pro/Max)", short: "Claude", apiKey: true },
} as const;
export type ChatProvider = keyof typeof CHAT_PROVIDERS;
export const CHAT_PROVIDER_IDS = Object.keys(CHAT_PROVIDERS) as ChatProvider[];
const DEFAULT_PROVIDER_MODELS: Record<ChatProvider, string | undefined> = { xai: undefined, openai: "gpt-6-luna", anthropic: "claude-haiku-5-5" };
export type AuthKind = "oauth" | "api_key";

/** For login method choices (Claude): the bot can't receive a browser redirect, so it takes the copy-code way. */
export function chooseLoginMethod(options: readonly { id: string; label: string }[]): string {
  const headless = options.find((o) => /headless|copy|code|device/i.test(`${o.id} ${o.label}`));
  if (!headless) throw new Error(`This login offers no method the bot can use (${options.map((o) => o.label).join(", ")}).`);
  return headless.id;
}

/** How a login flow talks to the user (Telegram messages in the bot). */
export interface LoginUi {
  /** Device-code flows (Grok): open this URL and enter the code. */
  onDeviceCode?: (code: DeviceCode) => void | Promise<void>;
  /** Browser flows (ChatGPT): open this URL… */
  onUrl?: (url: string, instructions?: string) => void | Promise<void>;
  /** …then paste the address the browser ended on (or the code the page shows). */
  onPaste?: (message: string, signal?: AbortSignal) => Promise<string>;
  /** API-key setup: ask for the key. */
  onSecret?: (message: string, signal?: AbortSignal) => Promise<string>;
}

type Target = { provider: ChatProvider; model: Model<Api> };

/**
 * Where chat requests go after a subscription login.
 * - api:   xAI's developer API. pi-ai and Hermes use this.
 * - proxy: the Grok subscription proxy. OpenClaw uses this with Grok-CLI headers.
 *   Some SuperGrok tiers are refused by `api` but accepted here.
 */
export type Route = "api" | "proxy";
export const ROUTES: readonly Route[] = ["api", "proxy"];
export const PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const BILLING_URL = `${PROXY_BASE_URL}/billing?format=credits`;
const CLIENT_VERSION = "0.1.0";

export interface DeviceCode {
  url: string;
  userCode: string;
  expiresInSeconds?: number;
}

export interface ProbeResult {
  route: Route;
  ok: boolean;
  detail: string;
  usedSearch?: boolean;
}

/** Told to ChatGPT/Claude when they have no web search (no Tavily key, or /search off): don't guess current facts. */
export const NO_SEARCH_NOTE =
  "\n\nYou have no live web search right now. For current information (news, weather, prices, schedules, recent events), say plainly that you can't look it up at the moment instead of guessing.";

const IMAGE_MODEL = "grok-imagine-image-2.0";
const STT_URL = "https://api.x.ai/v1/stt";
const TTS_URL = "https://api.x.ai/v1/tts";

export interface Transcription {
  text: string;
  /** BCP-47 code detected by xAI, e.g. "en", "zh". */
  language?: string;
  duration?: number;
  words: { text: string; start: number; end: number }[];
}

export interface Quota {
  plan?: string;
  usedPercent?: number;
  window?: string;
  resetsAt?: string;
}

export class Grok {
  readonly #db: Db;
  readonly #credentials: CredentialStore;
  readonly #defaultModel: string;
  readonly models: MutableModels;

  constructor(options: { db: Db; credentials: CredentialStore; defaultModel: string }) {
    this.#db = options.db;
    this.#credentials = options.credentials;
    this.#defaultModel = options.defaultModel;
    this.models = createModels({ credentials: options.credentials });
    this.models.setProvider(xaiProvider());
    this.models.setProvider(openaiProvider());
    this.models.setProvider(anthropicProvider());
  }

  /** Providers that answer chat, in order: the first signed-in one answers, the next take over when it fails. */
  get chain(): ChatProvider[] {
    try {
      const value = JSON.parse(getSetting(this.#db, "chain") ?? "[]") as unknown;
      const ids = Array.isArray(value) ? value.filter((id): id is ChatProvider => CHAT_PROVIDER_IDS.includes(id)) : [];
      return ids.length ? [...new Set(ids)] : ["xai"];
    } catch {
      return ["xai"];
    }
  }

  set chain(ids: ChatProvider[]) {
    const clean = [...new Set(ids.filter((id) => CHAT_PROVIDER_IDS.includes(id)))];
    if (clean.length === 0) throw new Error("Keep at least one provider in the chain.");
    setSetting(this.#db, "chain", JSON.stringify(clean));
  }

  providerModelId(provider: ChatProvider): string {
    if (provider === "xai") return this.modelId;
    return getSetting(this.#db, `model.${provider}`) ?? DEFAULT_PROVIDER_MODELS[provider]!;
  }

  setProviderModel(provider: ChatProvider, id: string): void {
    if (provider === "xai") {
      this.modelId = id;
      return;
    }
    if (!this.models.getModel(provider, id)) throw new Error(`Unknown model: ${id}`);
    setSetting(this.#db, `model.${provider}`, id);
  }

  listProviderModels(provider: ChatProvider): string[] {
    const ids = this.models.getModels(provider).map((model) => model.id);
    // ChatGPT: current chat models only (the catalog also lists old and special-purpose ones).
    if (provider === "openai") return ids.filter((id) => /^(gpt-(5\.[4-9]|6)|gpt-daybreak)/.test(id));
    if (provider === "anthropic") return ids.filter((id) => /^claude-(haiku-5|sonnet-5|opus-5|fable)/.test(id));
    return ids;
  }

  /** How a provider is connected: a subscription login, an API key, or not at all. */
  async authKind(provider: ChatProvider): Promise<AuthKind | undefined> {
    const type = (await this.#credentials.read(provider))?.type;
    return type === "oauth" || type === "api_key" ? type : undefined;
  }

  async signedIn(provider: ChatProvider): Promise<boolean> {
    return (await this.authKind(provider)) !== undefined;
  }

  /** Signed-in providers of the chain, in order, with their models. */
  async targets(): Promise<Target[]> {
    const targets: Target[] = [];
    for (const provider of this.chain) {
      if (!(await this.signedIn(provider))) continue;
      const model = provider === "xai" ? this.model() : this.models.getModel(provider, this.providerModelId(provider));
      if (model) targets.push({ provider, model });
    }
    return targets;
  }

  /** Which provider answered how often since start, and how often one failed over to the next. */
  readonly stats = new Map<ChatProvider, { answers: number; failovers: number; lastError?: string }>();
  /** Called with each provider answer's token usage (for /admin → Usage). */
  onUsage: (provider: ChatProvider, input: number, output: number) => void = () => undefined;
  /** Called when a provider failed and the next one in the chain takes over. */
  onFailover: (from: ChatProvider, to: ChatProvider, error: string) => void = () => undefined;
  /**
   * Web search for providers without built-in search (ChatGPT, Claude) in one-shot requests
   * such as scheduled posts: returns results as text for the prompt. Unset = no search for them.
   */
  webSearch: ((query: string, signal?: AbortSignal) => Promise<string>) | undefined;

  #count(provider: ChatProvider, field: "answers" | "failovers", error?: string): void {
    const entry = this.stats.get(provider) ?? { answers: 0, failovers: 0 };
    entry[field]++;
    if (error) entry.lastError = error.slice(0, 200);
    this.stats.set(provider, entry);
  }

  #stream(target: Target, context: Parameters<StreamFn>[1], options: Parameters<StreamFn>[2]): AssistantMessageEventStream {
    const stream =
      target.provider === "xai"
        ? withoutServerSideToolCalls(
            this.models.streamSimple(
              target.model,
              searchToolsFor("xai", context, this.hostedSearch),
              this.#requestOptions(target.model, options, this.route, this.hostedSearch),
            ),
          )
        : this.models.streamSimple(target.model, searchToolsFor(target.provider, context, this.hostedSearch), options);
    void stream.result().then(
      (message) => this.onUsage(target.provider, message.usage?.input ?? 0, message.usage?.output ?? 0),
      () => undefined,
    );
    return stream;
  }

  /** Text to speech with xAI (works with the subscription login). Returns MP3 audio. */
  async speak(text: string, options: { voice?: string; language?: string; signal?: AbortSignal } = {}): Promise<Buffer> {
    const auth = await this.models.getAuth(PROVIDER);
    const token = auth?.auth.apiKey;
    if (!token) throw new Error("Not logged in to Grok. Use /login first.");
    const timeout = AbortSignal.timeout(60_000);
    const response = await fetch(TTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text, voice_id: options.voice ?? "eve", language: options.language ?? "auto" }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`text-to-speech HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
    return Buffer.from(await response.arrayBuffer());
  }

  get route(): Route {
    const value = getSetting(this.#db, "route");
    return value === "proxy" ? "proxy" : "api";
  }

  set route(route: Route) {
    setSetting(this.#db, "route", route);
  }

  get hostedSearch(): boolean {
    return getSetting(this.#db, "hosted_search") !== "off";
  }

  set hostedSearch(enabled: boolean) {
    setSetting(this.#db, "hosted_search", enabled ? "on" : "off");
  }

  get modelId(): string {
    return getSetting(this.#db, "model") ?? this.#defaultModel;
  }

  set modelId(id: string) {
    if (!this.models.getModel(PROVIDER, id)) throw new Error(`Unknown model: ${id}`);
    setSetting(this.#db, "model", id);
  }

  listModelIds(): string[] {
    return this.models.getModels(PROVIDER).map((model) => model.id);
  }

  /** The current model, pointed at the current route. */
  model(id: string = this.modelId, route: Route = this.route): Model<Api> {
    const model = this.models.getModel(PROVIDER, id);
    if (!model) throw new Error(`Unknown model: ${id}. Try /model to list models.`);
    return route === "proxy" ? { ...model, baseUrl: PROXY_BASE_URL } : model;
  }

  /**
   * Stream function for pi-agent-core: adds route headers and hosted search
   * tools, and hides xAI's server-side tool calls from the agent loop.
   */
  readonly streamFn: StreamFn = (_model, context, options) => {
    const out = createAssistantMessageEventStream();
    void this.targets()
      .then((targets) => {
        if (targets.length === 0) {
          out.push({ type: "error", reason: "error", error: failureMessage(this.model(), "Not logged in to any AI provider. Use /admin or /login.") });
          out.end();
          return;
        }
        return pipeWithFailover(out, targets, (target) => this.#stream(target, context, options), {
          signal: options?.signal,
          onAnswer: (target) => this.#count(target.provider, "answers"),
          onFailover: (from, to, error) => {
            this.#count(from.provider, "failovers", error);
            this.onFailover(from.provider, to.provider, error);
          },
        });
      })
      .catch((error: unknown) => {
        out.push({ type: "error", reason: "error", error: failureMessage(this.model(), errorMessage(error)) });
        out.end();
      });
    return out;
  };

  /** Whether any provider in the chain is signed in (chat works). xAI-only features check signedIn("xai"). */
  async isLoggedIn(): Promise<boolean> {
    return (await this.targets()).length > 0;
  }

  /** Device-code login to Grok. Resolves once the user approved; the credential is saved by pi-ai. */
  async login(onDeviceCode: (code: DeviceCode) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
    await this.loginProvider("xai", { onDeviceCode }, signal);
  }

  /** Sign in to a chat provider's subscription; the credential is stored like Grok's. */
  async loginProvider(provider: ChatProvider, ui: LoginUi, signal?: AbortSignal, kind: AuthKind = "oauth"): Promise<void> {
    const show = (task: () => void | Promise<void>) =>
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => console.warn(`could not show the login step: ${(error as Error).message}`));
    await this.models.login(
      provider,
      kind,
      {
        signal,
        prompt: async (prompt) => {
          if (prompt.type === "manual_code" && ui.onPaste) return ui.onPaste(prompt.message, prompt.signal);
          if (prompt.type === "secret" && ui.onSecret) return ui.onSecret(prompt.message, prompt.signal);
          if (prompt.type === "select") return chooseLoginMethod(prompt.options);
          throw new Error(`This login needs input the bot can't ask for (${prompt.type}).`);
        },
        notify: (event) => {
          if (event.type === "device_code" && ui.onDeviceCode) {
            show(() => ui.onDeviceCode!({ url: event.verificationUri, userCode: event.userCode, expiresInSeconds: event.expiresInSeconds }));
          }
          if (event.type === "auth_url" && ui.onUrl) show(() => ui.onUrl!(event.url, event.instructions));
        },
      },
      { getDeviceId: () => this.#deviceId() },
    );
  }

  /** One stable id for this bot installation (OpenAI asks for it at sign-in). */
  #deviceId(): string {
    let id = getSetting(this.#db, "device_id");
    if (!id) {
      id = randomUUID();
      setSetting(this.#db, "device_id", id);
    }
    return id;
  }

  async logout(provider: ChatProvider = "xai"): Promise<void> {
    await this.models.logout(provider);
  }

  /** One tiny request to one provider, to check a fresh sign-in works. */
  async testProvider(provider: ChatProvider, signal?: AbortSignal): Promise<string> {
    const model = provider === "xai" ? this.model() : this.models.getModel(provider, this.providerModelId(provider));
    if (!model) throw new Error(`Unknown model ${this.providerModelId(provider)}`);
    const options = provider === "xai" ? this.#requestOptions(model, { signal }, this.route, false) : { signal };
    const reply = await this.models.completeSimple(model, { messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }] }, options);
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
    return `${model.id}: ${assistantText(reply).trim().slice(0, 40)}`;
  }

  /** One-shot question outside any chat session (link summaries). Throws on Grok errors. */
  async ask(
    system: string,
    prompt: string,
    options: { search?: boolean; images?: ImageContent[]; signal?: AbortSignal } = {},
  ): Promise<string> {
    const content = options.images?.length ? [{ type: "text" as const, text: prompt }, ...options.images] : prompt;
    const context = { systemPrompt: system, messages: [{ role: "user" as const, content, timestamp: Date.now() }] };
    const targets = await this.targets();
    if (targets.length === 0) throw new Error("Not logged in to any AI provider. Use /admin or /login.");
    let lastError = "";
    // Searched once, the first time a provider without built-in search needs it.
    let searched: Promise<string | undefined> | undefined;
    for (const [index, target] of targets.entries()) {
      const { provider, model } = target;
      let requestContext = context;
      let requestOptions: SimpleStreamOptions = { signal: options.signal, reasoning: "low" };
      if (provider === "xai") {
        // Grok searches the web and X itself (hosted tools).
        requestOptions = this.#requestOptions(model, requestOptions, this.route, options.search ?? false);
      } else if (options.search) {
        // ChatGPT/Claude: search first and hand them the results.
        searched ??= this.webSearch
          ? this.webSearch(prompt, options.signal).catch((error: unknown) => {
              console.warn(`web search for ${provider} failed: ${errorMessage(error)}`);
              return undefined;
            })
          : Promise.resolve(undefined);
        const results = await searched;
        requestContext = results
          ? { ...context, messages: [{ ...context.messages[0]!, content: withText(content, `\n\nWeb search results, fetched just now:\n${results}`) }] }
          : { ...context, systemPrompt: system + NO_SEARCH_NOTE };
      }
      const reply = stripServerSideToolCalls(await this.models.completeSimple(model, requestContext, requestOptions));
      this.onUsage(provider, reply.usage?.input ?? 0, reply.usage?.output ?? 0);
      const text = assistantText(reply).trim();
      if (reply.stopReason !== "error" && reply.stopReason !== "aborted" && text) {
        this.#count(provider, "answers");
        return text;
      }
      lastError = reply.errorMessage ?? (text ? reply.stopReason : `${CHAT_PROVIDERS[provider].short} returned an empty answer`);
      const next = targets[index + 1];
      if (reply.stopReason === "aborted" || options.signal?.aborted || !next) break;
      this.#count(provider, "failovers", lastError);
      this.onFailover(provider, next.provider, lastError);
    }
    throw new Error(lastError);
  }

  /**
   * Speech to text with xAI's batch STT (`POST /v1/stt`), authorized with the
   * subscription login. Accepts ogg/opus (Telegram voice), mp3, m4a, mp4, wav…
   */
  async transcribe(audio: Blob, filename: string, options: { language?: string; signal?: AbortSignal } = {}): Promise<Transcription> {
    const auth = await this.models.getAuth(PROVIDER);
    const token = auth?.auth.apiKey;
    if (!token) throw new Error("Not logged in. Use /login first.");
    const form = new FormData();
    form.append("model", "grok-voice-transcribe-2.0");
    if (options.language) form.append("language", options.language);
    form.append("file", audio, filename); // must be the last field
    const timeout = AbortSignal.timeout(20 * 60_000); // up to ~3 h of audio
    const response = await fetch(STT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    const body = (await response.json().catch(() => ({}))) as Partial<Transcription> & { error?: unknown; code?: unknown };
    if (!response.ok) throw new Error(`speech-to-text HTTP ${response.status}: ${String(body.error ?? body.code ?? "")}`.trim());
    return { text: String(body.text ?? "").trim(), language: body.language, duration: body.duration, words: body.words ?? [] };
  }

  /**
   * Grok Imagine: a new image from a prompt, or an edit of up to 5 source images.
   * Uses the same subscription login as chat (verified on the VPS: generation and edits return 200).
   */
  async createImage(options: { prompt: string; sources?: ImageContent[]; aspectRatio?: string; signal?: AbortSignal }): Promise<Buffer> {
    const auth = await this.models.getAuth(PROVIDER);
    const token = auth?.auth.apiKey;
    if (!token) throw new Error("Not logged in. Use /login first.");
    const sources = (options.sources ?? []).slice(0, 5).map((image) => ({ type: "image_url", url: `data:${image.mimeType};base64,${image.data}` }));
    const body: Record<string, unknown> = { model: IMAGE_MODEL, prompt: options.prompt, response_format: "b64_json" };
    if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;
    if (sources.length === 1) body.image = sources[0];
    if (sources.length > 1) body.images = sources;
    const timeout = AbortSignal.timeout(180_000);
    const response = await fetch(`https://api.x.ai/v1/images/${sources.length ? "edits" : "generations"}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    const result = (await response.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; error?: unknown; code?: unknown };
    if (!response.ok) throw new Error(`image HTTP ${response.status}: ${String(result.error ?? result.code ?? "")}`.trim());
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error("The image was blocked by xAI's content moderation or came back empty.");
    return Buffer.from(b64, "base64");
  }

  /** Send one tiny request through a route to see whether this account may use it. */
  async probe(route: Route, options: { search?: boolean; signal?: AbortSignal } = {}): Promise<ProbeResult> {
    const model = this.model(this.modelId, route);
    let usedSearch = false;
    const prompt = options.search
      ? "Search the web: what is today's date and one top news headline? Answer in one short line."
      : "Reply with exactly: OK";
    try {
      const reply = await this.models.completeSimple(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        {
          ...this.#requestOptions(model, { signal: options.signal }, route, options.search ?? false),
          onProviderStreamEvent: (data) => {
            const type = (data as { type?: unknown; item?: { type?: unknown } } | null)?.item?.type;
            if (typeof type === "string" && type.includes("search")) usedSearch = true;
          },
        },
      );
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        return { route, ok: false, detail: reply.errorMessage ?? reply.stopReason, usedSearch };
      }
      return { route, ok: true, detail: assistantText(reply).slice(0, 200), usedSearch };
    } catch (error) {
      return { route, ok: false, detail: errorMessage(error), usedSearch };
    }
  }

  /** Probe both routes, keep the first that works (api preferred). */
  async selectRoute(signal?: AbortSignal): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    for (const route of ROUTES) {
      const result = await this.probe(route, { signal });
      results.push(result);
      if (result.ok) {
        this.route = route;
        break;
      }
    }
    return results;
  }

  /** SuperGrok quota from the subscription proxy's billing endpoint (same call OpenClaw makes). */
  async quota(signal?: AbortSignal): Promise<Quota> {
    const auth = await this.models.getAuth(PROVIDER);
    const token = auth?.auth.apiKey;
    if (!token) throw new Error("Not logged in. Use /login first.");
    const response = await fetch(BILLING_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "x-grok-client-mode": "cli",
        "x-grok-client-version": "1.0.4",
      },
      signal,
    });
    if (!response.ok) throw new Error(`billing endpoint returned HTTP ${response.status}`);
    return parseQuota(await response.json());
  }

  #requestOptions(
    model: Model<Api>,
    options: SimpleStreamOptions | undefined,
    route: Route,
    search: boolean,
  ): SimpleStreamOptions {
    const userOnPayload = options?.onPayload;
    return {
      ...options,
      headers: { ...options?.headers, ...(route === "proxy" ? proxyHeaders(model.id) : {}) },
      onPayload: async (payload, requestModel) => {
        const replaced = (await userOnPayload?.(payload, requestModel)) ?? payload;
        return search ? withHostedSearch(replaced) : replaced;
      },
    };
  }
}

/**
 * Which search a provider gets in a chat request. pi-ai carries the prompt and tool
 * declarations in the transcript's system messages (toolsAdded / toolsRemoved).
 * Grok uses its hosted web/X search, so our search_web tool is removed for it;
 * ChatGPT/Claude keep search_web while search is on. A non-Grok provider that ends up
 * without search is told not to guess current facts.
 */
export function searchToolsFor<C extends { messages: readonly Message[] }>(provider: ChatProvider, context: C, searchOn: boolean): C {
  const drop = provider === "xai" || !searchOn;
  let declared = false;
  const messages = context.messages.map((message) => {
    if (message.role !== "system") return message;
    if (message.toolsAdded?.some((t) => t.name === SEARCH_TOOL_NAME)) declared = true;
    if (message.toolsRemoved?.some((t) => t.name === SEARCH_TOOL_NAME)) declared = false;
    if (!drop) return message;
    const { toolsAdded, toolsRemoved, ...rest } = message;
    const added = toolsAdded?.filter((t) => t.name !== SEARCH_TOOL_NAME);
    const removed = toolsRemoved?.filter((t) => t.name !== SEARCH_TOOL_NAME);
    return { ...rest, ...(added ? { toolsAdded: added } : {}), ...(removed ? { toolsRemoved: removed } : {}) };
  });
  const hasSearch = declared && !drop;
  if (provider !== "xai" && !hasSearch) {
    const first = messages[0];
    if (first?.role === "system") {
      const content = typeof first.content === "string" ? first.content + NO_SEARCH_NOTE : [...first.content, { type: "text" as const, text: NO_SEARCH_NOTE }];
      messages[0] = { ...first, content };
    }
  }
  return { ...context, messages };
}

/** Append text to a user message's content (a string, or text plus images). */
function withText(content: string | ({ type: "text"; text: string } | ImageContent)[], extra: string): string | ({ type: "text"; text: string } | ImageContent)[] {
  if (typeof content === "string") return content + extra;
  return [...content, { type: "text", text: extra }];
}

/** Headers the subscription proxy expects (mirrors OpenClaw's extensions/xai/stream.ts). */
export function proxyHeaders(modelId: string): Record<string, string> {
  return {
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": CLIENT_VERSION,
    "x-grok-model-override": modelId,
  };
}

/** Add xAI's server-side web_search and x_search tools to a Responses API payload. */
export function withHostedSearch(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as { tools?: unknown };
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const present = new Set(tools.map((tool) => (tool as { type?: unknown }).type));
  const added = ["web_search", "x_search"].filter((type) => !present.has(type)).map((type) => ({ type }));
  return { ...body, tools: [...tools, ...added] };
}

/**
 * xAI runs web_search / x_search on its servers but still reports each step in
 * the stream as a `custom_tool_call` item (id `ctc_…`), which pi-ai turns into
 * an ordinary toolCall block. The answer text arrives in the same response.
 * Left alone, pi-agent-core would try to run e.g. `x_keyword_search` locally,
 * fail with "tool not found", and re-ask Grok, replacing the real answer.
 * Our own tools are plain function tools (`fc_…` ids), so they are kept.
 */
export function isServerSideToolCall(block: AssistantMessage["content"][number]): boolean {
  return block.type === "toolCall" && /\|ctc_/.test(block.id);
}

export function stripServerSideToolCalls(message: AssistantMessage): AssistantMessage {
  const content = message.content.filter((block) => !isServerSideToolCall(block));
  if (content.length === message.content.length) return message;
  const clientCallsLeft = content.some((block) => block.type === "toolCall");
  const stopReason = message.stopReason === "toolUse" && !clientCallsLeft ? "stop" : message.stopReason;
  return { ...message, content, stopReason };
}

/** Forward a stream unchanged except for the final message, which loses server-side tool calls. */
export function withoutServerSideToolCalls(source: AssistantMessageEventStream): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    let finished = false;
    for await (const event of source) {
      if (event.type === "done") {
        const message = stripServerSideToolCalls(event.message);
        out.push({ type: "done", reason: message.stopReason as typeof event.reason, message });
        finished = true;
      } else {
        out.push(event);
        if (event.type === "error") finished = true;
      }
    }
    out.end(finished ? undefined : stripServerSideToolCalls(await source.result()));
  })();
  return out;
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The billing schema is undocumented; read the fields OpenClaw reads, wherever they are nested. */
export function parseQuota(body: unknown): Quota {
  const find = (key: string): unknown => findKey(body, key);
  const value = (node: unknown): number | undefined => {
    const raw = node && typeof node === "object" ? (node as { val?: unknown }).val : node;
    const num = typeof raw === "string" ? Number(raw) : raw;
    return typeof num === "number" && Number.isFinite(num) ? num : undefined;
  };
  let usedPercent = value(find("creditUsagePercent"));
  const used = value(find("used"));
  const limit = value(find("monthlyLimit"));
  if (usedPercent === undefined && used !== undefined && limit) usedPercent = (used / limit) * 100;
  const period = find("currentPeriod") as { type?: unknown; end?: unknown } | undefined;
  const periodType = typeof period?.type === "string" ? period.type : "";
  const resetsAt = period?.end ?? find("billingPeriodEnd");
  const plan = find("subscription_tier");
  return {
    plan: typeof plan === "string" ? plan : undefined,
    usedPercent,
    window: periodType.endsWith("WEEKLY") ? "weekly" : periodType.endsWith("MONTHLY") ? "monthly" : undefined,
    resetsAt: typeof resetsAt === "string" ? resetsAt : undefined,
  };
}

function findKey(node: unknown, key: string, depth = 0): unknown {
  if (!node || typeof node !== "object" || depth > 5) return undefined;
  if (key in node) return (node as Record<string, unknown>)[key];
  for (const child of Object.values(node)) {
    const found = findKey(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** An error reply shaped like a model answer, for failures before any provider was reached. */
function failureMessage(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

/**
 * Stream the first target's answer into `out`. When a target fails before any
 * output reached the user (only its "start" event so far), the next one answers
 * instead; once text, thinking or a tool call has been forwarded, the answer
 * stays with that target, errors included.
 */
export async function pipeWithFailover<T>(
  out: AssistantMessageEventStream,
  targets: readonly T[],
  open: (target: T) => AssistantMessageEventStream,
  hooks: { signal?: AbortSignal; onAnswer?: (target: T) => void; onFailover?: (from: T, to: T, error: string) => void } = {},
): Promise<void> {
  for (const [index, target] of targets.entries()) {
    const next = targets[index + 1];
    const held: AssistantMessageEvent[] = [];
    let committed = false;
    let failed: string | undefined;
    for await (const event of open(target)) {
      if (committed) {
        out.push(event);
        continue;
      }
      if (event.type === "error" && event.reason === "error" && next !== undefined && !hooks.signal?.aborted) {
        failed = event.error.errorMessage ?? "error";
        break;
      }
      held.push(event);
      if (event.type !== "start") {
        committed = true;
        for (const e of held) out.push(e);
      }
    }
    if (failed !== undefined && next !== undefined) {
      hooks.onFailover?.(target, next, failed);
      continue;
    }
    if (!committed) for (const e of held) out.push(e);
    hooks.onAnswer?.(target);
    out.end();
    return;
  }
}
