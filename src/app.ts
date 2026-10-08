import { ChatSessions } from "./agent/sessions.ts";
import { readLinkTool, watchVideoTool } from "./agent/tools.ts";
import { ImageStudio } from "./agent/images.ts";
import { MemoryStore } from "./memory.ts";
import { PollDesk } from "./agent/polls.ts";
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
import { VideoReader } from "./media/video.ts";
import { installAuthRetry } from "./net/authRetry.ts";
import { systemPromptFor, today } from "./prompt.ts";
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
  memory: MemoryStore;
  polls: PollDesk;
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
}): App {
  if (!authRetryInstalled) {
    installAuthRetry();
    authRetryInstalled = true;
  }
  const db = openDb(options.dataDir);
  const grok = new Grok({ db, credentials: new SqliteCredentialStore(db), defaultModel: options.defaultModel });
  const reader = new LinkReader({ db, tavilyKey: options.tavilyKey });
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
  const memory = new MemoryStore(db);
  const speakers = new Map<string, { userId?: number; userName: string }>();
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
      memory.tool(chatIdOf(key), () => speakers.get(key)),
      polls.tool(key),
    ],
    systemExtra: (key) => `\n${today()}` + personaBlock(groups, chatIdOf(key)) + memory.promptBlock(chatIdOf(key)),
  });
  return { db, grok, sessions, groups, reader, video, parsehub, images, memory, speakers, polls, limits };
}

/** The owner's style for a group, added to the system prompt of every request there. */
function personaBlock(groups: GroupStore, chatId: number): string {
  const persona = chatId < 0 ? groups.persona(chatId) : "";
  return persona ? `\n\nStyle the group owner set for you here (follow it unless it conflicts with the rules above):\n${persona}` : "";
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
