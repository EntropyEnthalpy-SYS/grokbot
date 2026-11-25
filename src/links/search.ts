import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { untrusted } from "./reader.ts";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
/** Characters of each result's snippet handed to the model. */
const SNIPPET_CHARS = 700;

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  published?: string;
}

/**
 * Web search for the providers that have none built in (ChatGPT, Claude): Grok
 * searches with xAI's hosted tools, the others with Tavily (TAVILY_API_KEY, the
 * key the link reader already uses).
 */
export class WebSearch {
  readonly #key: string | undefined;
  readonly #fetchImpl: typeof fetch;

  constructor(options: { tavilyKey?: string; fetchImpl?: typeof fetch }) {
    this.#key = options.tavilyKey;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  get available(): boolean {
    return Boolean(this.#key);
  }

  /** `news`: recent reporting (last week), for current events. */
  async search(query: string, options: { news?: boolean; maxResults?: number; signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    if (!this.#key) throw new Error("Web search is not set up (TAVILY_API_KEY).");
    const timeout = AbortSignal.timeout(20_000);
    const response = await this.#fetchImpl(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: query.slice(0, 400),
        search_depth: "basic",
        max_results: options.maxResults ?? 6,
        ...(options.news ? { topic: "news", time_range: "week" } : {}),
      }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    const body = (await response.json().catch(() => ({}))) as { results?: Partial<SearchResult & { published_date: string }>[]; detail?: { error?: string } };
    if (!response.ok) throw new Error(`search failed: ${body.detail?.error ?? `HTTP ${response.status}`}`);
    return (body.results ?? [])
      .filter((r) => r.url && r.title)
      .map((r) => ({ title: r.title!, url: r.url!, content: (r.content ?? "").trim().slice(0, SNIPPET_CHARS), published: r.published_date ?? undefined }));
  }
}

/** Results as text for the model, marked as fetched data (instructions inside are not followed). */
export function formatSearchResults(query: string, results: readonly SearchResult[]): string {
  if (results.length === 0) return `No web results for "${query}".`;
  const body = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}${r.published ? ` (${r.published})` : ""}\n${r.content}`)
    .join("\n\n");
  return untrusted(`web search: ${query}`, body);
}

/**
 * Questions whose answer changes or depends on a date: schedules and match times, results, prices,
 * news, weather, "today"/"tomorrow", or a specific date ("10月27号").
 */
export const CURRENT_WORDS =
  /赛程|賽程|比赛|比賽|对阵|對陣|谁打谁|誰打誰|几点|幾點|什么时候|什麼時候|何时|何時|几号|幾號|哪天|今天|明天|昨天|后天|後天|今晚|明晚|昨晚|今年|本周|本週|这周|這週|下周|下週|周末|週末|最新|新闻|新聞|比分|赛果|賽果|结果|結果|冠军|冠軍|排名|开赛|開賽|直播|发布|發布|发售|發售|上映|开票|開票|价格|價格|多少钱|多少錢|股价|股價|汇率|匯率|币价|幣價|天气|天氣|营业时间|營業時間|\d{1,2}\s*月\s*\d{1,2}\s*[日号號]|\b(schedule|fixtures?|scores?|results?|standings|today|tomorrow|tonight|yesterday|this week|next week|latest|news|price|weather|release date|what time|when is|when does)\b/i;

/**
 * The search query for a question: its words, plus the date it means when it says "today" or
 * "tomorrow", or the current year when it names no year (else "10月27号" finds last year's pages).
 */
export function searchQuery(question: string, today: { date: string; tomorrow: string; yesterday: string }): string {
  const text = question.replace(/\s+/g, " ").trim().slice(0, 300);
  if (/明天|明晚|tomorrow/i.test(text)) return `${text} ${today.tomorrow}`;
  if (/昨天|昨晚|yesterday/i.test(text)) return `${text} ${today.yesterday}`;
  if (/今天|今晚|today|tonight/i.test(text)) return `${text} ${today.date}`;
  if (/\b(19|20)\d{2}\b|(19|20)\d{2}\s*年/.test(text)) return text;
  return `${text} ${today.date.slice(0, 4)}`;
}

const SearchParams = Type.Object({
  query: Type.String({ description: "What to search for, as a search-engine query. Use the language that will find the best sources." }),
  news: Type.Optional(Type.Boolean({ description: "true for current events and news from the last week." })),
});

/** The agent tool: given to ChatGPT and Claude only (Grok has its own hosted web/X search). */
export function searchWebTool(search: WebSearch): AgentTool<typeof SearchParams, undefined> {
  return {
    name: SEARCH_TOOL_NAME,
    label: "Searching the web",
    description:
      "Search the web for current or factual information: news, weather, prices, schedules, recent events, or anything you are unsure about. " +
      "Returns titles, links and snippets; cite the links you use. Use read_link to read one page in full.",
    parameters: SearchParams,
    execute: async (_id, { query, news }, signal) => {
      try {
        return { content: [{ type: "text", text: formatSearchResults(query, await search.search(query, { news, signal })) }], details: undefined };
      } catch (error) {
        return { content: [{ type: "text", text: (error as Error).message }], details: undefined, isError: true };
      }
    },
  };
}

export const SEARCH_TOOL_NAME = "search_web";
