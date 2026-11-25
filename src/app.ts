import { ChatSessions } from "./agent/sessions.ts";
import { FileDesk } from "./agent/files.ts";
import { CodeDesk, CodeRunner } from "./agent/sandbox.ts";
import { ServerDesk } from "./servers.ts";
import { groupChatTool, readLinkTool, searchChatTool, watchVideoTool } from "./agent/tools.ts";
import { ImageStudio } from "./agent/images.ts";
import { MemoryStore } from "./memory.ts";
import { PollDesk } from "./agent/polls.ts";
import { ActionDesk, confirmerFor } from "./agent/actions.ts";
import { LimitStore } from "./usage.ts";
import { openDb, type Db } from "./db.ts";
import { SqliteCredentialStore } from "./grok/credentialStore.ts";
import { Grok } from "./grok/grok.ts";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ParseHubClient, type PhDownload, type PhPost } from "./links/parsehub.ts";
import { downloadBilibili } from "./media/bilibili.ts";
import { LinkReader } from "./links/reader.ts";
import { browserRenderer } from "./links/browser.ts";
import { CURRENT_WORDS, formatSearchResults, searchQuery, searchWebTool, WebSearch } from "./links/search.ts";
import { VideoReader } from "./media/video.ts";
import { installAuthRetry } from "./net/authRetry.ts";
import { systemPromptFor, today } from "./prompt.ts";
import { addLocalDays, localDay } from "./time.ts";
import { GroupStore } from "./telegram/groups.ts";

/** Bilibili: video info through the tunnel, video data straight from Bilibili's CDN. */
export function bilibiliDownloader(options: { dataDir: string; ytdlpPath?: string; ytdlpProxy?: string; maxBytes: number }) {
  return async (url: string, post: PhPost): Promise<PhDownload> => {
    const dir = join(options.dataDir, "media", randomUUID());
    try {
      const video = await downloadBilibili(url, { ytdlp: options.ytdlpPath ?? "yt-dlp", proxy: options.ytdlpProxy, dir, maxBytes: options.maxBytes });
      return { post, dir, files: [{ kind: "video", ...video }] };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  };
}

export interface App {
  db: Db;
  grok: Grok;
  sessions: ChatSessions;
  groups: GroupStore;
  reader: LinkReader;
  video: VideoReader;
  parsehub?: ParseHubClient;
  images: ImageStudio;
  files: FileDesk;
  /** run_code: Python in a locked box (when bubblewrap and the Python environment are installed). */
  code: CodeDesk;
  /** The owner's servers, worked on over SSH from the owner's private chat. */
  servers: ServerDesk;
  memory: MemoryStore;
  polls: PollDesk;
  /** AI-suggested notes and polls waiting for a person's ✅ (groups with confirmations on). */
  actions: ActionDesk;
  limits: LimitStore;
  /** Who is asking in each running answer (set by the bot), for tools that record the author. */
  speakers: Map<string, { userId?: number; userName: string }>;
}

let authRetryInstalled = false;

/** Wire the database, Grok client, link and video readers, and chat sessions. Shared by the bot and the CLI scripts. */
export function createApp(options: {
  dataDir: string;
  defaultModel: string;
  tavilyKey?: string;
  ytdlpPath?: string;
  ytdlpProxy?: string;
  parsehubUrl?: string;
  mediaDir?: string;
  /** Python environment for run_code (default /opt/pysandbox). */
  sandboxVenv?: string;
  /** The browser reader's socket (default /run/grokbot-browser/browser.sock; unused when it isn't running). */
  browserSocket?: string;
  fontDir?: string;
  /** The owner: server_run is offered only in their private chat. */
  ownerId?: number;
}): App {
  if (!authRetryInstalled) {
    installAuthRetry();
    authRetryInstalled = true;
  }
  const db = openDb(options.dataDir);
  const grok = new Grok({ db, credentials: new SqliteCredentialStore(db), defaultModel: options.defaultModel });
  const reader = new LinkReader({ db, tavilyKey: options.tavilyKey, browser: browserRenderer(options.browserSocket ?? "/run/grokbot-browser/browser.sock") });
  // ChatGPT and Claude have no built-in web search: they search with Tavily (Grok uses xAI's own).
  const search = new WebSearch({ tavilyKey: options.tavilyKey });
  if (search.available) grok.webSearch = async (query, signal) => formatSearchResults(query, await search.search(query, { signal }));
  const video = new VideoReader({
    db,
    transcribe: (audio, name, opts) => grok.transcribe(audio, name, opts),
    ytdlp: options.ytdlpPath,
    proxy: options.ytdlpProxy,
  });
  const groups = new GroupStore(db);
  const limits = new LimitStore(db);
  const images = new ImageStudio((request) => grok.createImage(request), () => limits.get("imagesPerUserDay"));
  const polls = new PollDesk();
  const files = new FileDesk();
  const servers = new ServerDesk(db, options.dataDir);
  const code = new CodeDesk(
    new CodeRunner({ venv: options.sandboxVenv ?? "/opt/pysandbox", workRoot: join(options.dataDir, "sandbox"), fontDir: options.fontDir }),
  );
  const memory = new MemoryStore(db);
  const speakers = new Map<string, { userId?: number; userName: string }>();
  const actions = new ActionDesk();
  // Tools that change the chat (notes, polls) ask first in groups with ✋ confirmations on.
  const confirmFor = (key: string) => confirmerFor({ actions, confirmActions: (chatId) => groups.confirmActions(chatId), speakers }, key);
  const parsehub = options.parsehubUrl
    ? new ParseHubClient({ baseUrl: options.parsehubUrl, mediaRoot: options.mediaDir ?? `${options.dataDir}/media` })
    : undefined;
  const sessions = new ChatSessions({
    db,
    grok,
    systemPrompt: (key) => systemPromptFor(key),
    // Subtitle language for videos: the group's /lang; in private chat, the original language.
    tools: (key) => [
      readLinkTool(reader, parsehub),
      watchVideoTool(video, () => preferredLanguage(groups, key), parsehub),
      images.tool(key),
      memory.tool(chatIdOf(key), () => speakers.get(key), confirmFor(key)),
      ...(search.available ? [searchWebTool(search)] : []),
      // Focused groups: the chat only when Grok decides a question needs it.
      ...(groups.privacy(chatIdOf(key)) === "focused" ? [groupChatTool(groups, chatIdOf(key), threadOf(key), () => groups.list().find((g) => g.chatId === chatIdOf(key))?.title)] : []),
      // Groups that keep their chat: earlier messages on request, only the matching ones.
      ...(chatIdOf(key) < 0 && groups.privacy(chatIdOf(key)) !== "strict" ? [searchChatTool(groups, chatIdOf(key), () => groups.timeZone(chatIdOf(key)))] : []),
    ],
    // Offered only when a question needs them: fewer tools per request keep ordinary answers fast.
    toolSets: (key) => [
      { name: "files", about: "send_file: send a text file you write (Markdown, code, config, CSV, Word); Excel files and charts come from run_code instead", when: FILE_WORDS, tools: [files.tool(key)] },
      { name: "poll", about: "create_poll: post a Telegram poll in this chat", when: POLL_WORDS, tools: [polls.tool(key, confirmFor(key))] },
      ...(code.available
        ? [{ name: "code", about: "run_code: run Python for exact math, statistics, data files (CSV/Excel) and charts", when: CODE_WORDS, tools: [code.tool(key)] }]
        : []),
      // The owner's private chat, or a server's topic (where every question is about that server).
      ...((options.ownerId !== undefined && key === `tg:${options.ownerId}`) || servers.forKey(key)
        ? [{ name: "server", about: "server_run: run shell commands on the owner's servers over SSH (check, diagnose, fix)", when: servers.forKey(key) ? /[\s\S]/ : SERVER_WORDS, tools: [servers.tool(key)] }]
        : []),
    ],
    // Schedules, prices, news…: results from several sites come with the question, so the answer starts from them.
    prefetch: search.available
      ? async (question, key, signal) => {
          if (!grok.hostedSearch || !CURRENT_WORDS.test(question) || /https?:\/\//.test(question)) return undefined;
          const zone = groups.timeZone(chatIdOf(key));
          const now = Date.now();
          const query = searchQuery(question, {
            date: localDay(now, zone),
            tomorrow: localDay(addLocalDays(now, 1, zone), zone),
            yesterday: localDay(addLocalDays(now, -1, zone), zone),
          });
          const results = await search.search(query, { maxResults: 8, signal });
          return results.length ? formatSearchResults(query, results) : undefined;
        }
      : undefined,
    systemExtra: (key) =>
      `\n${today(new Date(), groups.timeZone(chatIdOf(key)))}` + scriptBlock(groups, chatIdOf(key)) + personaBlock(groups, chatIdOf(key)) + memory.promptBlock(chatIdOf(key), speakers.get(key)) + servers.promptBlock(key),
  });
  return { db, grok, sessions, groups, reader, video, parsehub, images, files, code, servers, memory, speakers, polls, actions, limits };
}

/** Questions that want a file or a poll load those tools up front (the model can still load them itself). */
const FILE_WORDS = /文件|檔案|档案|附件|下载|下載|导出|導出|匯出|\.(md|csv|docx|txt|json|ya?ml|sh|py)\b|\b(file|download|export|markdown)\b/i;
const POLL_WORDS = /投票|表决|表決|\b(poll|vote)\b/i;
/** The owner talking about their servers. */
const SERVER_WORDS =
  /服务器|服務器|伺服器|主机|主機|\bvps\b|\bserver|\bssh\b|磁盘|磁碟|硬盘|硬碟|内存|記憶體|\bcpu\b|负载|負載|\bnginx\b|\bdocker\b|systemctl|日志|日誌|\blogs?\b|重启|重啟|\brestart\b|进程|進程|端口|\bport\b|防火墙|防火牆|证书|證書|\b(disk|memory|uptime|service)\b/i;

/** Math, statistics, data files and charts (not "画一张图", which is create_image). */
const CODE_WORDS =
  /计算|計算|算一下|算算|算出|统计|統計|平均|中位数|中位數|方差|标准差|標準差|概率|機率|几率|復利|复利|回归|迴歸|图表|圖表|折线图|折線圖|柱状图|柱狀圖|饼图|圓餅圖|曲线图|曲線圖|表格|excel|xlsx|csv|python|代码|代碼|\b(calculate|compute|statistics|average|median|chart|plot|graph|regression|spreadsheet)\b/i;

/** The group's Chinese script (/lang zh-cn or zh-tw): cards use it, so answers in Chinese should too. */
function scriptBlock(groups: GroupStore, chatId: number): string {
  if (!(chatId < 0)) return "";
  const lang = groups.language(chatId);
  if (lang === "zh-cn") return "\n- This group uses Simplified Chinese: when you answer in Chinese, write Simplified characters (简体).";
  if (lang === "zh-tw") return "\n- This group uses Traditional Chinese: when you answer in Chinese, write Traditional characters (繁體).";
  return "";
}

/** The owner's style for a group, added to the system prompt of every request there. */
function personaBlock(groups: GroupStore, chatId: number): string {
  const persona = chatId < 0 ? groups.persona(chatId) : "";
  return persona ? `\n\nStyle the group owner set for you here (follow it unless it conflicts with the rules above):\n${persona}` : "";
}

/** "tg:-123:topic:5" (or with ":q77" after it) → 5; 0 outside forum topics. */
function threadOf(chatKey: string): number {
  return Number(chatKey.match(/:topic:(\d+)/)?.[1] ?? 0);
}

/** "tg:-123:topic:5" or "tg:-123:q77" → -123. */
export function chatIdOf(chatKey: string): number {
  return Number(chatKey.match(/^tg:(-?\d+)/)?.[1]);
}

function preferredLanguage(groups: GroupStore, chatKey: string): string | undefined {
  const chatId = chatIdOf(chatKey);
  if (!(chatId < 0)) return undefined;
  const lang = groups.language(chatId);
  return lang === "off" ? undefined : lang;
}
