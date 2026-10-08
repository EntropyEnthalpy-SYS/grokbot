import { resolve } from "node:path";

export interface Config {
  botToken: string;
  ownerId: number;
  dataDir: string;
  defaultModel: string;
  /** Optional; enables Tavily Extract for reading links (falls back to a direct fetch). */
  tavilyKey?: string;
  /** yt-dlp executable (default: "yt-dlp" on PATH). */
  ytdlpPath?: string;
  /** Proxy for yt-dlp, e.g. "socks5://user:pass@host:1080", for sites that block the server (Bilibili). */
  ytdlpProxy?: string;
  /** ParseHub helper (sidecar/parsehub_server.py), e.g. http://127.0.0.1:8765. */
  parsehubUrl?: string;
  /** Upload limit in MB; 50 for Telegram's hosted Bot API, up to 2000 with a local Bot API server. */
  maxUploadMb: number;
  /** Answer inline queries from anyone (default: owner only). */
  inlinePublic: boolean;
  /** Local Bot API server URL; when set, uploads and downloads go up to 2000 MB. */
  telegramApiRoot?: string;
  /** IANA time zone for reminders, usage days and displayed times (default Asia/Taipei). */
  timeZone: string;
  /** Translation/card language for new groups and private chats (default zh-tw). */
  defaultLanguage: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ownerId = Number(required(env, "OWNER_ID"));
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new Error("OWNER_ID must be your numeric Telegram user id (ask @userinfobot).");
  }
  return {
    botToken: required(env, "BOT_TOKEN"),
    ownerId,
    dataDir: resolve(env.DATA_DIR?.trim() || "./data"),
    defaultModel: env.GROK_MODEL?.trim() || "grok-4.7",
    tavilyKey: env.TAVILY_API_KEY?.trim() || undefined,
    ytdlpPath: env.YTDLP_PATH?.trim() || undefined,
    ytdlpProxy: env.YTDLP_PROXY?.trim() || undefined,
    parsehubUrl: env.PARSEHUB_URL?.trim() || undefined,
    maxUploadMb: Number(env.MAX_UPLOAD_MB?.trim() || (env.TELEGRAM_API_ROOT?.trim() ? 2000 : 50)) || 50,
    inlinePublic: /^(1|true|yes)$/i.test(env.INLINE_PUBLIC?.trim() ?? ""),
    telegramApiRoot: env.TELEGRAM_API_ROOT?.trim().replace(/\/$/, "") || undefined,
    timeZone: env.TIMEZONE?.trim() || "Asia/Taipei",
    defaultLanguage: env.DEFAULT_LANGUAGE?.trim().toLowerCase() || "zh-tw",
  };
}

/** Load `.env` from the working directory when present; real env vars win. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
