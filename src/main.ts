import { bilibiliDownloader, createApp } from "./app.ts";
import { loadConfig, loadDotEnv } from "./config.ts";
import { createBot, registerCommands, renderReminder } from "./telegram/bot.ts";
import { deliverDueReminders, ReminderStore } from "./reminders.ts";
import { diskCheck, HealthMonitor, memoryCheck, socksCheck, ytdlpAgeCheck, type Check } from "./health.ts";
import { run } from "./media/run.ts";
import { UsageStore } from "./usage.ts";
import { setTimeZone } from "./time.ts";
import { setDefaultLanguage } from "./lang.ts";
import { PermissionStore } from "./permissions.ts";
import { CookieStore } from "./links/cookies.ts";
import { backupWithoutSecrets, OpsClient } from "./ops.ts";
import { SCHEDULED_POST_PROMPT, type Reminder } from "./reminders.ts";
import { markdownToTelegramHtml, splitMarkdown, escapeHtml } from "./telegram/format.ts";
import { mkdirSync } from "node:fs";
import { removeOldFiles, removeStaleMedia } from "./media/cleanup.ts";
import { CardCache } from "./links/cardCache.ts";

loadDotEnv();
// A stray rejected promise (e.g. a Telegram send that failed) must be logged, not stop the bot.
process.on("unhandledRejection", (reason) => console.error("unhandled rejection:", reason));
const config = loadConfig();
setTimeZone(config.timeZone);
setDefaultLanguage(config.defaultLanguage);
const { db, grok, sessions, groups, reader, video, parsehub, images, memory, speakers, polls, limits } = createApp(config);
const cache = new CardCache(db);
const reminders = new ReminderStore(db);
const usage = new UsageStore(db);
grok.onUsage = (provider, input, output) => usage.recordTokens(provider, input, output);
const ops = new OpsClient(`${config.dataDir}/ops`);
const backupDir = `${config.dataDir}/backups`;
mkdirSync(backupDir, { recursive: true });

// Live checks of everything the bot depends on. Alerts go to the owner's private chat.
const checks: Check[] = [
  { name: "Telegram", everyMs: 60_000, run: async () => `@${(await bot.api.getMe()).username} via ${config.telegramApiRoot ? "local Bot API" : "cloud API"}` },
  {
    name: "Grok",
    everyMs: 15 * 60_000,
    run: async (signal) => {
      if (!(await grok.signedIn("xai"))) throw new Error("not logged in: send /login (search, voice and images need Grok)");
      const quota = await grok.quota(signal);
      return `logged in, ${grok.modelId}${quota.usedPercent !== undefined ? `, ${quota.usedPercent.toFixed(0)}% of quota used` : ""}`;
    },
  },
  {
    name: "Other AI providers",
    run: async () => {
      const others = grok.chain.filter((p) => p !== "xai");
      if (others.length === 0) return "none in the chain";
      const missing: string[] = [];
      for (const p of others) if (!(await grok.signedIn(p))) missing.push(p);
      if (missing.length) throw new Error(`in the chain but signed out: ${missing.join(", ")} (/admin → AI providers)`);
      return others.map((p) => `${p} ${grok.providerModelId(p)}`).join(", ");
    },
  },
  { name: "Disk", run: () => diskCheck(config.dataDir) },
  { name: "Memory", everyMs: 60_000, run: async () => memoryCheck() },
];
if (config.parsehubUrl) {
  checks.push({
    name: "ParseHub",
    run: async (signal) => {
      const response = await fetch(`${config.parsehubUrl}/health`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return "helper up";
    },
  });
}
if (config.ytdlpProxy?.startsWith("socks5")) checks.push({ name: "Tunnel (Bilibili)", run: (signal) => socksCheck(config.ytdlpProxy!, signal) });
checks.push({
  name: "yt-dlp",
  everyMs: 6 * 60 * 60_000,
  run: async (signal) => ytdlpAgeCheck((await run(config.ytdlpPath ?? "yt-dlp", ["--version"], { signal, timeoutMs: 15_000 })).stdout),
});
const health = new HealthMonitor({
  checks,
  notify: async (text) => void (await bot.api.sendMessage(config.ownerId, `🩺 ${text}`)),
  heartbeatPath: `${config.dataDir}/heartbeat.json`,
});

grok.onFailover = (from, to, error) => {
  console.warn(`${from} failed, ${to} answers instead: ${error}`);
  health.recordError(new Error(`${from} → ${to}: ${error}`));
};

const bot = createBot({
  token: config.botToken,
  ownerId: config.ownerId,
  grok,
  sessions,
  groups,
  reminders,
  images,
  memory,
  speakers,
  usage,
  limits,
  permissions: new PermissionStore(db),
  db,
  cookies: new CookieStore(`${config.dataDir}/parsehub-cookies.json`),
  polls,
  ops,
  backup: () => backupWithoutSecrets(db, backupDir),
  health,
  inlinePublic: config.inlinePublic,
  apiRoot: config.telegramApiRoot,
  links: {
    db,
    grok,
    reader,
    video,
    parsehub,
    cache,
    mediaDir: `${config.dataDir}/media`,
    downloaders: { bilibili: bilibiliDownloader({ ...config, maxBytes: config.maxUploadMb * 1024 * 1024 }) },
    uploadLimits: { photoBytes: 10 * 1024 * 1024, videoBytes: config.maxUploadMb * 1024 * 1024 },
  },
});

// The command menu is cosmetic; a network blip here must not stop the bot.
void (async () => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await registerCommands(bot);
      return;
    } catch (error) {
      console.warn(`setMyCommands failed (attempt ${attempt}): ${(error as Error).message.split("\n")[0]}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
    }
  }
})();
const housekeeping = () => {
  groups.prune();
  cache.prune();
  usage.prune();
  // Conversations with the bot expire like the group log.
  sessions.prune();
  void removeStaleMedia(`${config.dataDir}/media`, 60 * 60 * 1000);
  // Files the local Bot API server downloaded for us; they are only needed while processing.
  if (config.telegramApiRoot) void removeOldFiles(`${config.dataDir}/tgapi`, 24 * 60 * 60 * 1000);
};
housekeeping();
const pruneTimer = setInterval(housekeeping, 60 * 60 * 1000);
// Reminders: checked every 20 s; private chats (positive ids) are the owner's, groups must still be enabled.
let delivering = false;
const reminderTimer = setInterval(() => {
  if (delivering) return;
  delivering = true;
  deliverDueReminders(reminders, bot.api, (chatId) => chatId > 0 || groups.isEnabled(chatId), (r) => (r.ai ? writeScheduledPost(r) : renderReminder(r)))
    .catch((error) => console.error("reminders failed:", error))
    .finally(() => (delivering = false));
}, 20_000);

const shutdown = async (signal: string) => {
  console.log(`${signal} received, stopping`);
  clearInterval(pruneTimer);
  clearInterval(reminderTimer);
  health.stop();
  await bot.stop();
  db.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

console.log(
  `grokbot starting (model ${grok.modelId}, route ${grok.route}, logged in: ${await grok.isLoggedIn()}, ` +
    `link reader: ${reader.hasTavily ? "tavily" : "direct"}, parsehub: ${parsehub ? "on" : "off"}, ` +
    `telegram: ${config.telegramApiRoot ?? "cloud"}, max upload ${config.maxUploadMb} MB)`,
);
health.start();
// "Restart the bot" from /admin finishes after the old process is gone: report it from here.
void ops.leftovers().then(async (results) => {
  for (const r of results) {
    await bot.api
      .sendMessage(config.ownerId, `${r.ok ? "✅" : "❌"} ${r.action}: ${r.output}`.slice(0, 4000))
      .catch((error) => console.warn(`ops result not sent: ${(error as Error).message}`));
  }
});
await bot.start({
  allowed_updates: ["message", "inline_query", "my_chat_member", "callback_query", "stopped_message_generation"],
  onStart: (me) => console.log(`polling as @${me.username} (reads all group messages: ${me.can_read_all_group_messages})`),
});

/** /schedule: the bot writes the post at due time (with web search). Throws → retried each minute for an hour. */
async function writeScheduledPost(reminder: Reminder): Promise<string> {
  const now = Date.now();
  const answer = await grok.ask(SCHEDULED_POST_PROMPT(now), reminder.text, { search: true });
  // One message: the first ~3000 characters (HTML tags add a little; Telegram's limit is 4096).
  const body = splitMarkdown(answer, 3000)[0] ?? answer.slice(0, 3000);
  usage.record(reminder.chatId, { id: reminder.userId ?? undefined, name: reminder.userName }, "card");
  return `🗓 <b>${escapeHtml(reminder.text.slice(0, 200))}</b>\n\n${markdownToTelegramHtml(body)}`;
}
