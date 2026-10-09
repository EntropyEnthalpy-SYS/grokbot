import { InlineKeyboard, InputFile, type Bot, type Context } from "grammy";
import { unlink } from "node:fs/promises";
import { OPS_ACTIONS, type OpsAction, type OpsClient } from "../ops.ts";
import { COOKIE_PLATFORMS, type CookieStore } from "../links/cookies.ts";
import { PERMISSION_FLAGS, permissionIcons, type PermissionFlag, type PermissionStore } from "../permissions.ts";
import { LIMITS, USAGE_KINDS, type LimitName, type LimitStore, type MemberUsage, type UsageStore } from "../usage.ts";
import { CHAT_PROVIDER_IDS, CHAT_PROVIDERS, errorMessage, type AuthKind, type ChatProvider, type Grok } from "../grok/grok.ts";
import { formatUptime, type HealthMonitor } from "../health.ts";
import { formatLocalTime } from "../reminders.ts";
import { findTimeZone, formatLocalTime as formatInZone, timeZone, zoneLabel } from "../time.ts";
import { escapeAttr, escapeHtml } from "./format.ts";
import { GUIDE } from "./guide.ts";
import { LANGUAGES, LINK_MODES, type GroupStore } from "./groups.ts";

const MODELS_PER_PAGE = 8;

/** What the owner pastes back during a sign-in, per provider and kind; anything else is ordinary chat. */
const PASTE_LOOKS_RIGHT: Record<string, (text: string) => boolean> = {
  "openai:oauth": (t) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]\S*code=/.test(t),
  "anthropic:oauth": (t) => /^\S{10,}#\S+$/.test(t) || /^https?:\/\/\S*code=/.test(t),
  "anthropic:api_key": (t) => /^sk-ant-[\w-]{20,}$/.test(t),
};

const PASTE_STEPS: Record<string, string> = {
  "openai:oauth": "2. Approve. Your browser then lands on a page at <code>127.0.0.1</code> that doesn't load. That's expected.\n3. Copy that page's full address and send it to me here.",
  "anthropic:oauth": "2. Approve with your Claude Pro/Max account.\n3. Claude shows a code: copy it and send it to me here.",
};

export interface AdminDeps {
  ownerId: number;
  grok: Grok;
  groups: GroupStore;
  health?: HealthMonitor;
  /** Switching a group to strict deletes what was stored under normal mode. */
  onStrict: (chatId: number) => void;
  usage?: UsageStore;
  limits?: LimitStore;
  permissions?: PermissionStore;
  ops?: OpsClient;
  /** A database copy without logins; returns its path (deleted after sending). */
  backup?: () => string;
  /** Site cookies for Instagram, Threads, Zhihu… (read by the ParseHub helper). */
  cookies?: CookieStore;
}

const KIND_LABELS: Record<string, string> = { question: "❓", image: "🖼", tr: "🌐", voice_sec: "🎙 min", card: "🔗", tts: "🔊" };

/** "❓12 · 🖼3 · 🎙 min 4" */
export function formatCounts(counts: MemberUsage["counts"]): string {
  const parts = USAGE_KINDS.filter((k) => counts[k]).map((k) => {
    const value = k === "voice_sec" ? Math.round((counts[k] ?? 0) / 60) : Math.round(counts[k] ?? 0);
    return `${KIND_LABELS[k]}${k === "voice_sec" ? " " : ""}${value}`;
  });
  return parts.join(" · ") || "nothing yet";
}

/** Telegram's own contact picker: the owner chooses people instead of typing ids. */
const PICK_PEOPLE_REQUEST = 71;

const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

type Screen = { text: string; keyboard: InlineKeyboard };

/**
 * /admin: the owner's control panel inside the private chat. Inline buttons for
 * AI providers (sign in/out, order, models), per-group settings, status and the
 * live check. Nothing is exposed outside Telegram; only the owner's id passes.
 */
export function installAdmin(bot: Bot, deps: AdminDeps): void {
  const { ownerId, grok, groups, health } = deps;
  let loginAbort: AbortController | undefined;
  let pendingPaste: { resolve: (text: string) => void; accepts: (text: string) => boolean } | undefined;
  /** The owner's next private message answers a question from the panel (persona text). */
  let pendingInput: { resolve: (text: string) => void; secret?: boolean } | undefined;

  // While a ChatGPT sign-in waits for the callback address, the owner's next link is that address.
  bot.on("message:text", async (ctx, next) => {
    if (pendingInput && ctx.chat.type === "private" && ctx.from.id === ownerId) {
      const waiting = pendingInput;
      pendingInput = undefined;
      if (waiting.secret) await ctx.deleteMessage().catch(() => undefined);
      waiting.resolve(ctx.message.text.trim() === "/cancel" ? "" : ctx.message.text.trim());
      return;
    }
    if (!pendingPaste || ctx.chat.type !== "private" || ctx.from.id !== ownerId) return next();
    const text = ctx.message.text.trim();
    if (text === "/cancel") {
      loginAbort?.abort();
      return;
    }
    if (!pendingPaste.accepts(text)) return next();
    const waiting = pendingPaste;
    pendingPaste = undefined;
    // The address holds a one-time sign-in code: don't leave it in the chat.
    await ctx.deleteMessage().catch(() => undefined);
    waiting.resolve(text);
  });

  // ➕ Add people: the owner picked contacts with Telegram's user picker → they get private access.
  bot.on("message:users_shared", async (ctx) => {
    if (ctx.from.id !== ownerId || !deps.permissions || ctx.message.users_shared.request_id !== PICK_PEOPLE_REQUEST) return;
    const added = ctx.message.users_shared.users.filter((u) => u.user_id !== ownerId);
    for (const u of added) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.user_id);
      deps.permissions.set(u.user_id, "private", true, { name, username: u.username });
    }
    const names = added.map((u) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || u.user_id).join(", ");
    await ctx.reply(added.length ? `💬 Private access for: ${names}. They can message me now.` : "Nobody added.", {
      reply_markup: { remove_keyboard: true },
    });
    const screen = people();
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  });

  bot.command("admin", async (ctx) => {
    if (ctx.from?.id !== ownerId) return ctx.reply("Only the bot owner can do that.");
    if (ctx.chat.type !== "private") return ctx.reply("Open /admin in our private chat.");
    const screen = await home();
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard, link_preview_options: { is_disabled: true } });
  });

  bot.callbackQuery(/^adm:/, async (ctx) => {
    if (ctx.from.id !== ownerId || ctx.chat?.type !== "private") return ctx.answerCallbackQuery({ text: "Owner only." });
    const [, action = "home", a = "", b = ""] = ctx.callbackQuery.data.split(":");
    try {
      const screen = await handle(ctx, action, a, b);
      await ctx.answerCallbackQuery().catch(() => undefined);
      if (screen) {
        await ctx
          .editMessageText(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard, link_preview_options: { is_disabled: true } })
          .catch((error) => {
            if (!String(error).includes("message is not modified")) throw error;
          });
      }
    } catch (error) {
      await ctx.answerCallbackQuery({ text: `⚠️ ${errorMessage(error)}`.slice(0, 200), show_alert: true }).catch(() => undefined);
    }
  });

  async function handle(ctx: Context, action: string, a: string, b: string): Promise<Screen | undefined> {
    const provider = CHAT_PROVIDER_IDS.find((id) => id === a);
    switch (action) {
      case "home":
        return home();
      case "prov":
        return providers();
      case "up": {
        const chain = grok.chain;
        const at = chain.indexOf(provider!);
        if (at > 0) [chain[at - 1], chain[at]] = [chain[at]!, chain[at - 1]!];
        grok.chain = chain;
        return providers();
      }
      case "tog": {
        const chain = grok.chain;
        grok.chain = chain.includes(provider!) ? chain.filter((p) => p !== provider) : [...chain, provider!];
        return providers();
      }
      case "mod":
        return models(provider!, Number(b) || 0);
      case "set": {
        const id = grok.listProviderModels(provider!)[Number(b)];
        if (id) grok.setProviderModel(provider!, id);
        return providers();
      }
      case "in":
        void signIn(ctx, provider!, "oauth");
        return undefined;
      case "key":
        void signIn(ctx, provider!, "api_key");
        return undefined;
      case "out":
        return confirmSignOut(provider!);
      case "outy":
        await grok.logout(provider!);
        return providers();
      case "cancel":
        loginAbort?.abort();
        return undefined;
      case "grp":
        return groupList();
      case "g":
        return groupDetail(Number(a));
      case "gs":
        toggleGroup(Number(a), b);
        return groupDetail(Number(a));
      case "stat":
        return status();
      case "use":
        return usageScreen(Number(a) || 7);
      case "lim":
        return limitsScreen();
      case "ln":
        deps.limits?.nudge(a as LimitName, b === "+" ? 1 : -1);
        return limitsScreen();
      case "tr":
        deps.limits?.setTrusted(Number(a), !deps.limits.trusted().has(Number(a)));
        return limitsScreen();
      case "ops":
        return maintenance();
      case "op":
        if (a === "restart-bot") {
          return {
            text: "Restart the bot now? Answers in progress are cut off; it is back in about 5 seconds.",
            keyboard: new InlineKeyboard().text("🔄 Restart", "adm:opy:restart-bot").text("Cancel", "adm:ops"),
          };
        }
        void runOp(ctx, a as OpsAction);
        return undefined;
      case "opy":
        void runOp(ctx, a as OpsAction);
        return undefined;
      case "bak":
        void sendBackup(ctx);
        return undefined;
      case "guide":
        return guideIndex();
      case "gd":
        return guidePage(a);
      case "ck":
        return cookiesScreen();
      case "cks":
        void askCookie(ctx, a);
        return undefined;
      case "ckc":
        if (a in COOKIE_PLATFORMS) deps.cookies?.clear(a);
        return cookiesScreen();
      case "gp":
        void askPersona(ctx, Number(a));
        return undefined;
      case "gtz":
        void askTimeZone(ctx, Number(a));
        return undefined;
      case "perm":
        return people();
      case "pu":
        return person(Number(a));
      case "pf": {
        const flag = b as PermissionFlag;
        if (deps.permissions && flag in PERMISSION_FLAGS && Number(a) !== ownerId) deps.permissions.set(Number(a), flag, !deps.permissions.has(Number(a), flag));
        return person(Number(a));
      }
      case "prm":
        deps.permissions?.remove(Number(a));
        return people();
      case "padd":
        await ctx.reply("Tap the button below and choose the people (up to 10). They get 💬 private access; change the rest in 🔐 Permissions.", {
          reply_markup: {
            keyboard: [[{ text: "👤 Choose people", request_users: { request_id: PICK_PEOPLE_REQUEST, user_is_bot: false, max_quantity: 10, request_name: true, request_username: true } }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        });
        return undefined;
      case "req":
        return accessRequest(ctx, Number(a), b);
      case "gpc":
        groups.setPersona(Number(a), "");
        return groupDetail(Number(a));
      case "hl":
        return { text: await renderHealth(health), keyboard: new InlineKeyboard().text("🔄 Run again", "adm:hl").text("⬅️ Back", "adm:home") };
      default:
        return home();
    }
  }

  async function home(): Promise<Screen> {
    const lines = ["<b>⚙️ Bot admin</b>", ""];
    for (const p of grok.chain) {
      lines.push(`${(await grok.signedIn(p)) ? "✅" : "❌"} ${CHAT_PROVIDERS[p].name} · ${escapeHtml(grok.providerModelId(p))}`);
    }
    if (grok.chain.length > 1) lines.push(`Order: ${grok.chain.map((p) => CHAT_PROVIDERS[p].short).join(" → ")}`);
    lines.push(`👥 ${groups.list().length} group(s) enabled`);
    if (health) lines.push(`⏱ up ${formatUptime(Date.now() - health.startedAt)}`);
    const keyboard = new InlineKeyboard()
      .text("🤖 AI providers", "adm:prov")
      .text("👥 Groups", "adm:grp")
      .row()
      .text("📈 Usage", "adm:use:7")
      .text("⚖️ Limits", "adm:lim")
      .row()
      .text("📊 Status", "adm:stat")
      .text("🩺 Health", "adm:hl")
      .row()
      .text("🔐 Permissions", "adm:perm")
      .text("🛠 Maintenance", "adm:ops")
      .row()
      .text("📖 Guide", "adm:guide");
    return { text: lines.join("\n"), keyboard };
  }

  async function providers(): Promise<Screen> {
    const chain = grok.chain;
    const lines = [
      "<b>🤖 AI providers</b>",
      "Questions go to the first signed-in provider; if it fails (quota used up, login expired, outage) the next one answers.",
      "Search, voice transcripts and images always use Grok.",
      "",
    ];
    const keyboard = new InlineKeyboard();
    for (const p of CHAT_PROVIDER_IDS) {
      const kind = await grok.authKind(p);
      const signed = kind !== undefined;
      const at = chain.indexOf(p);
      const how = kind === "api_key" ? "✅ API key" : kind === "oauth" ? "✅ subscription" : "❌ signed out";
      lines.push(
        `${at >= 0 ? `<b>${at + 1}.</b>` : "–"} ${CHAT_PROVIDERS[p].name}: ${how} · <code>${escapeHtml(grok.providerModelId(p))}</code>${at < 0 ? " · not used" : ""}`,
      );
      const name = CHAT_PROVIDERS[p].short;
      if (signed) keyboard.text(`🚪 ${name}: sign out`, `adm:out:${p}`);
      else {
        keyboard.text(`🔑 ${name}: sign in`, `adm:in:${p}`);
        if (CHAT_PROVIDERS[p].apiKey) keyboard.text(`🗝 ${name}: API key`, `adm:key:${p}`);
      }
      keyboard.text(`🧠 Model`, `adm:mod:${p}:0`).row();
      keyboard.text(at >= 0 ? `⏸ Don't use ${name}` : `▶️ Use ${name}`, `adm:tog:${p}`);
      if (at > 0) keyboard.text(`⬆️ ${name} first`, `adm:up:${p}`);
      keyboard.row();
    }
    lines.push("", "Claude: sign in uses your Pro/Max limits; an API key uses the monthly API credits included with Max (link a Console org in claude.ai → Settings → Billing).");
    keyboard.text("⬅️ Back", "adm:home");
    return { text: lines.join("\n"), keyboard };
  }

  function models(p: ChatProvider, page: number): Screen {
    const ids = grok.listProviderModels(p);
    const current = grok.providerModelId(p);
    const pages = Math.max(1, Math.ceil(ids.length / MODELS_PER_PAGE));
    const start = Math.min(page, pages - 1) * MODELS_PER_PAGE;
    const keyboard = new InlineKeyboard();
    ids.slice(start, start + MODELS_PER_PAGE).forEach((id, i) => {
      keyboard.text(id === current ? `• ${id} •` : id, `adm:set:${p}:${start + i}`).row();
    });
    if (pages > 1) {
      if (page > 0) keyboard.text("◀️", `adm:mod:${p}:${page - 1}`);
      if (page < pages - 1) keyboard.text("▶️", `adm:mod:${p}:${page + 1}`);
      keyboard.row();
    }
    keyboard.text("⬅️ Back", "adm:prov");
    return { text: `<b>🧠 ${CHAT_PROVIDERS[p].name} model</b>\nNow: <code>${escapeHtml(current)}</code>${pages > 1 ? ` · page ${page + 1}/${pages}` : ""}`, keyboard };
  }

  function confirmSignOut(p: ChatProvider): Screen {
    return {
      text: `Sign out of <b>${CHAT_PROVIDERS[p].name}</b>? The stored login is deleted; you can sign in again any time.`,
      keyboard: new InlineKeyboard().text("🚪 Sign out", `adm:outy:${p}`).text("Cancel", "adm:prov"),
    };
  }

  async function signIn(ctx: Context, p: ChatProvider, kind: AuthKind): Promise<void> {
    loginAbort?.abort();
    const abort = new AbortController();
    loginAbort = abort;
    const name = CHAT_PROVIDERS[p].name;
    const cancel = new InlineKeyboard().text("✖️ Cancel sign-in", "adm:cancel");
    const accepts = PASTE_LOOKS_RIGHT[`${p}:${kind}`] ?? ((t: string) => /^\S{8,}$/.test(t));
    const waitForPaste = (signal?: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        pendingPaste = { resolve, accepts };
        const stop = () => {
          if (pendingPaste?.resolve === resolve) pendingPaste = undefined;
          reject(new Error("Sign-in cancelled."));
        };
        signal?.addEventListener("abort", stop, { once: true });
        abort.signal.addEventListener("abort", stop, { once: true });
      });
    try {
      await ctx.reply(`Signing in to ${name}…`);
      await grok.loginProvider(
        p,
        {
          onDeviceCode: async (code) => {
            const minutes = code.expiresInSeconds ? ` (expires in ${Math.round(code.expiresInSeconds / 60)} min)` : "";
            await ctx.reply(
              `<b>Approve in your browser</b>\n1. Open: ${escapeHtml(code.url)}\n2. Code: <code>${escapeHtml(code.userCode)}</code>${minutes}\nNever share this code.`,
              { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: cancel },
            );
          },
          onUrl: async (url, instructions) => {
            await ctx.reply(
              [
                `<b>Sign in to ${escapeHtml(name)}</b>`,
                `1. Open <a href="${escapeAttr(url)}">this sign-in link</a>.`,
                PASTE_STEPS[`${p}:oauth`] ?? `2. ${escapeHtml(instructions ?? "Approve, then send me what the page shows.")}`,
                "I delete what you send right away.",
              ].join("\n"),
              { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: cancel },
            );
          },
          onPaste: (_message, signal) => waitForPaste(signal),
          onSecret: async (_message, signal) => {
            await ctx.reply(
              p === "anthropic"
                ? "Send me your Anthropic API key (<code>sk-ant-…</code>). For Max's monthly credits, create it in the Console organization linked under claude.ai → Settings → Billing → API credits. I delete your message right away."
                : `Send me your ${escapeHtml(name)} API key. I delete your message right away.`,
              { parse_mode: "HTML", reply_markup: cancel },
            );
            return waitForPaste(signal);
          },
        },
        abort.signal,
        kind,
      );
      const test = await grok.testProvider(p).catch((error) => `test failed: ${errorMessage(error)}`);
      if (!grok.chain.includes(p)) grok.chain = [...grok.chain, p];
      await ctx.reply(`✅ ${name} signed in (${test}). It is #${grok.chain.indexOf(p) + 1} in the chain. /admin to change the order.`);
    } catch (error) {
      await ctx.reply(abort.signal.aborted ? "Sign-in cancelled." : `❌ ${name} sign-in failed: ${errorMessage(error)}`);
    } finally {
      if (loginAbort === abort) loginAbort = undefined;
      pendingPaste = undefined;
    }
  }

  function groupList(): Screen {
    const list = groups.list();
    const keyboard = new InlineKeyboard();
    for (const g of list) keyboard.text(g.title.slice(0, 40), `adm:g:${g.chatId}`).row();
    keyboard.text("⬅️ Back", "adm:home");
    return { text: list.length ? "<b>👥 Groups</b>\nChoose a group to change its settings." : "No groups yet. Add me to a group and send /enable there.", keyboard };
  }

  function groupDetail(chatId: number): Screen {
    const group = groups.list().find((g) => g.chatId === chatId);
    if (!group) return groupList();
    const on = (value: boolean) => (value ? "on" : "off");
    const keyboard = new InlineKeyboard()
      .text(`🔗 Links: ${groups.linkMode(chatId)}`, `adm:gs:${chatId}:links`)
      .text(`🔒 Privacy: ${groups.privacy(chatId)}`, `adm:gs:${chatId}:privacy`)
      .row()
      .text(`🌐 Language: ${groups.language(chatId)}`, `adm:gs:${chatId}:lang`)
      .text(`🎙 Voice: ${groups.voiceMode(chatId)}`, `adm:gs:${chatId}:voice`)
      .row()
      .text(`🧹 Tidy: ${on(groups.tidy(chatId))}`, `adm:gs:${chatId}:tidy`)
      .text(`🗑 Delete link msgs: ${on(groups.deleteLink(chatId))}`, `adm:gs:${chatId}:del`)
      .row()
      .text(`🔐 Who can use: ${groups.access(chatId) === "approved" ? "approved only" : "everyone"}`, `adm:gs:${chatId}:access`)
      .row()
      .text(`🔊 Voice replies: ${on(groups.voiceReply(chatId))}`, `adm:gs:${chatId}:vr`)
      .text(`✋ Confirm notes/polls: ${on(groups.confirmActions(chatId))}`, `adm:gs:${chatId}:confirm`)
      .row()
      .text(`🕒 Time zone: ${zoneLabel(groups.timeZone(chatId))}`, `adm:gtz:${chatId}`)
      .row()
      .text(groups.persona(chatId) ? "🎭 Change persona" : "🎭 Set persona", `adm:gp:${chatId}`);
    if (groups.persona(chatId)) keyboard.text("🎭 Clear", `adm:gpc:${chatId}`);
    keyboard.row().text("⬅️ Groups", "adm:grp");
    const persona = groups.persona(chatId);
    return {
      text: [
        `<b>${escapeHtml(group.title)}</b>`,
        "Tap a setting to change it. Strict privacy deletes the stored chat log and conversations.",
        `🎭 Persona: ${persona ? `<i>${escapeHtml(persona)}</i>` : "default"}`,
      ].join("\n"),
      keyboard,
    };
  }

  function toggleGroup(chatId: number, key: string): void {
    const cycle = <T extends string>(values: readonly T[], current: T) => values[(values.indexOf(current) + 1) % values.length]!;
    switch (key) {
      case "links":
        return groups.setLinkMode(chatId, cycle(LINK_MODES, groups.linkMode(chatId)));
      case "privacy": {
        const next = groups.privacy(chatId) === "strict" ? "normal" : "strict";
        groups.setPrivacy(chatId, next);
        if (next === "strict") deps.onStrict(chatId);
        return;
      }
      case "lang":
        return groups.setLanguage(chatId, cycle(Object.keys(LANGUAGES), groups.language(chatId)));
      case "voice":
        return groups.setVoiceMode(chatId, groups.voiceMode(chatId) === "auto" ? "off" : "auto");
      case "tidy":
        return groups.setTidy(chatId, !groups.tidy(chatId));
      case "del":
        return groups.setDeleteLink(chatId, !groups.deleteLink(chatId));
      case "vr":
        return groups.setVoiceReply(chatId, !groups.voiceReply(chatId));
      case "access":
        return groups.setAccess(chatId, groups.access(chatId) === "approved" ? "everyone" : "approved");
      case "confirm":
        return groups.setConfirmActions(chatId, !groups.confirmActions(chatId));
    }
  }

  function usageScreen(days: number): Screen {
    const keyboard = new InlineKeyboard()
      .text(days === 1 ? "• Today •" : "Today", "adm:use:1")
      .text(days === 7 ? "• 7 days •" : "7 days", "adm:use:7")
      .text(days === 30 ? "• 30 days •" : "30 days", "adm:use:30")
      .row()
      .text("⬅️ Back", "adm:home");
    if (!deps.usage) return { text: "Usage tracking is off.", keyboard };
    const span = days === 1 ? "today" : `last ${days} days`;
    const members = deps.usage.members(days);
    const lines = [`<b>📈 Usage, ${span}</b> (${zoneLabel()} days)`, ""];
    if (members.length === 0) lines.push("No usage yet.");
    for (const m of members.slice(0, 20)) lines.push(`<b>${escapeHtml(m.name || String(m.userId))}</b>: ${formatCounts(m.counts)}`);
    const providers = deps.usage.providers(days);
    if (providers.length) {
      lines.push("", "<b>AI providers</b> (requests · tokens in/out)");
      for (const p of providers) {
        const name = CHAT_PROVIDERS[p.provider as ChatProvider]?.short ?? p.provider;
        lines.push(`${escapeHtml(name)}: ${p.requests} · ${formatTokens(p.input)} / ${formatTokens(p.output)}`);
      }
    }
    lines.push("", "❓ questions · 🖼 images · 🌐 /tr · 🎙 voice minutes transcribed · 🔗 link/video cards · 🔊 voice replies");
    return { text: lines.join("\n"), keyboard };
  }

  function limitsScreen(): Screen {
    const keyboard = new InlineKeyboard();
    const lines = ["<b>⚖️ Limits</b>", "You and ⭐ trusted members are never limited.", ""];
    if (!deps.limits) return { text: "Limits are fixed.", keyboard: keyboard.text("⬅️ Back", "adm:home") };
    for (const name of Object.keys(LIMITS) as LimitName[]) {
      const value = deps.limits.get(name);
      lines.push(`${LIMITS[name].label}: <b>${value}</b>`);
      keyboard.text(`➖ ${LIMITS[name].short}`, `adm:ln:${name}:-`).text(`${value}`, `adm:lim`).text(`➕ ${LIMITS[name].short}`, `adm:ln:${name}:+`).row();
    }
    const trusted = deps.limits.trusted();
    const members = (deps.usage?.members(30) ?? []).filter((m) => m.userId !== ownerId);
    if (members.length) {
      lines.push("", "Tap a member to make them ⭐ trusted (no limits):");
      for (const m of members.slice(0, 12)) {
        keyboard.text(`${trusted.has(m.userId) ? "⭐" : "☆"} ${(m.name || String(m.userId)).slice(0, 24)}`, `adm:tr:${m.userId}`).row();
      }
    }
    keyboard.text("⬅️ Back", "adm:home");
    return { text: lines.join("\n"), keyboard };
  }

  function people(): Screen {
    const keyboard = new InlineKeyboard();
    if (!deps.permissions) return { text: "Permissions are not available.", keyboard: keyboard.text("⬅️ Back", "adm:home") };
    const known = new Map(deps.permissions.list().map((p) => [p.userId, p]));
    // Also offer people who used the bot lately, so they can be managed without adding them first.
    for (const m of deps.usage?.members(30) ?? []) {
      if (m.userId !== ownerId && !known.has(m.userId)) {
        known.set(m.userId, { userId: m.userId, name: m.name, private: false, approved: false, trusted: false, blocked: false });
      }
    }
    const lines = [
      "<b>🔐 Permissions</b>",
      ...Object.values(PERMISSION_FLAGS).map((f) => `${f.icon} <b>${f.label}</b>: ${f.help}`),
      "",
      "By default: only you chat privately; everyone in an enabled group may use the bot (set a group to “approved only” in 👥 Groups).",
      "",
    ];
    const list = [...known.values()].filter((p) => p.userId !== ownerId);
    if (list.length === 0) lines.push("Nobody yet. Add people with ➕, or they show up here once they use the bot.");
    for (const p of list.slice(0, 30)) {
      keyboard.text(`${permissionIcons(p)} ${(p.name || p.username || String(p.userId)).slice(0, 28)}`, `adm:pu:${p.userId}`).row();
    }
    keyboard.text("➕ Add people", "adm:padd").row().text("⬅️ Back", "adm:home");
    return { text: lines.join("\n"), keyboard };
  }

  function person(userId: number): Screen {
    if (!deps.permissions) return people();
    const p = deps.permissions.get(userId) ?? { userId, name: deps.usage?.members(30).find((m) => m.userId === userId)?.name ?? "", private: false, approved: false, trusted: false, blocked: false };
    const keyboard = new InlineKeyboard();
    for (const flag of Object.keys(PERMISSION_FLAGS) as PermissionFlag[]) {
      const f = PERMISSION_FLAGS[flag];
      keyboard.text(`${p[flag] ? "✔️" : "◻️"} ${f.icon} ${f.label}`, `adm:pf:${userId}:${flag}`).row();
    }
    keyboard.text("🗑 Reset to default", `adm:prm:${userId}`).row().text("⬅️ Permissions", "adm:perm");
    const used = deps.usage?.member(userId, 7).counts;
    return {
      text: [
        `<b>${escapeHtml(p.name || String(userId))}</b>${p.username ? ` @${escapeHtml(p.username)}` : ""} · id <code>${userId}</code>`,
        used ? `Last 7 days: ${formatCounts(used)}` : "",
        "Tap to turn a permission on or off. Blocking removes the others.",
      ]
        .filter(Boolean)
        .join("\n"),
      keyboard,
    };
  }

  /** The owner answered an access request (✅ Allow / ⛔ Block / Ignore). */
  async function accessRequest(ctx: Context, userId: number, answer: string): Promise<Screen> {
    const name = deps.permissions?.get(userId)?.name || String(userId);
    const done = (text: string) => ({ text, keyboard: new InlineKeyboard().text("🔐 Permissions", "adm:perm") });
    if (!deps.permissions || answer === "ignore") return done(`Ignored the request from ${escapeHtml(name)}.`);
    if (answer === "allow") {
      deps.permissions.set(userId, "private", true);
      await ctx.api.sendMessage(userId, "✅ You can chat with me now. Send me a question, a link, a photo or a voice message.").catch(() => undefined);
      return done(`✅ <b>${escapeHtml(name)}</b> may now chat with the bot privately.`);
    }
    deps.permissions.set(userId, "blocked", true);
    return done(`⛔ <b>${escapeHtml(name)}</b> is blocked; the bot ignores them everywhere.`);
  }

  function maintenance(): Screen {
    const keyboard = new InlineKeyboard();
    if (deps.ops) {
      const actions = Object.entries(OPS_ACTIONS) as [OpsAction, string][];
      actions.forEach(([action, label], i) => {
        keyboard.text(label, `adm:op:${action}`);
        if (i % 2 === 1) keyboard.row();
      });
      keyboard.row();
    }
    if (deps.backup) keyboard.text("💾 Backup (without logins)", "adm:bak").row();
    if (deps.cookies) keyboard.text("🍪 Site cookies (Instagram, Threads, Zhihu…)", "adm:ck").row();
    keyboard.text("⬅️ Back", "adm:home");
    return {
      text: [
        "<b>🛠 Maintenance</b>",
        "Runs on the server without SSH. Results arrive as a new message.",
        "• Update: yt-dlp and ParseHub (sites change often; also runs daily).",
        "• Restart helpers: link parser and the Taiwan tunnel.",
        "• Backup: the database without logins or API keys (those stay on the server).",
      ].join("\n"),
      keyboard,
    };
  }

  async function runOp(ctx: Context, action: OpsAction): Promise<void> {
    if (!deps.ops || !(action in OPS_ACTIONS)) return;
    await ctx.reply(`⏳ ${OPS_ACTIONS[action]}…`);
    if (action === "restart-bot") {
      // This process is about to be replaced; the new one reports the result on start.
      await deps.ops.request(action);
      return;
    }
    const result = await deps.ops.run(action, action === "update-tools" ? 10 * 60_000 : 60_000);
    if (!result) return void (await ctx.reply(`⚠️ ${OPS_ACTIONS[action]}: no answer from the server's ops runner (is grokbot-ops.path enabled?).`));
    await ctx.reply(`${result.ok ? "✅" : "❌"} <b>${escapeHtml(OPS_ACTIONS[action])}</b>\n<pre>${escapeHtml(result.output || "(no output)")}</pre>`, {
      parse_mode: "HTML",
    });
  }

  async function sendBackup(ctx: Context): Promise<void> {
    if (!deps.backup) return;
    const path = deps.backup();
    try {
      await ctx.replyWithDocument(new InputFile(path), {
        caption: "💾 Database backup: settings, notes, reminders, usage and group settings. Logins and API keys are not included.",
      });
    } finally {
      await unlink(path).catch(() => undefined);
    }
  }

  function guideIndex(): Screen {
    const keyboard = new InlineKeyboard();
    for (const page of GUIDE) keyboard.text(page.button, `adm:gd:${page.id}`).row();
    keyboard.text("⬅️ Back", "adm:home");
    return { text: "<b>📖 Guide</b>\nHow to use the bot, every command, and what the panel does. Members see the first two pages with /help.", keyboard };
  }

  function guidePage(id: string): Screen {
    const at = GUIDE.findIndex((p) => p.id === id);
    if (at < 0) return guideIndex();
    const keyboard = new InlineKeyboard();
    if (at > 0) keyboard.text(`◀️ ${GUIDE[at - 1]!.button}`, `adm:gd:${GUIDE[at - 1]!.id}`);
    if (at < GUIDE.length - 1) keyboard.text(`${GUIDE[at + 1]!.button} ▶️`, `adm:gd:${GUIDE[at + 1]!.id}`);
    keyboard.row().text("📖 Contents", "adm:guide").text("⬅️ Panel", "adm:home");
    return { text: GUIDE[at]!.html, keyboard };
  }

  function cookiesScreen(): Screen {
    const keyboard = new InlineKeyboard();
    if (!deps.cookies) return { text: "Cookies can't be set here.", keyboard: keyboard.text("⬅️ Back", "adm:ops") };
    const lines = [
      "<b>🍪 Site cookies</b>",
      "Some sites only show posts to logged-in visitors. Paste the cookie of an account logged in to that site and links work again.",
      "Use a spare account if you can: the site sees requests from the server under that account.",
      "",
    ];
    for (const [id, p] of Object.entries(COOKIE_PLATFORMS)) {
      const set = deps.cookies.has(id);
      lines.push(`${set ? "✅" : "–"} ${escapeHtml(p.name)}: ${p.why}`);
      keyboard.text(`${set ? "🔁 Replace" : "➕ Set"} ${p.name}`, `adm:cks:${id}`);
      if (set) keyboard.text("🗑", `adm:ckc:${id}`);
      keyboard.row();
    }
    keyboard.text("⬅️ Maintenance", "adm:ops");
    return { text: lines.join("\n"), keyboard };
  }

  async function askCookie(ctx: Context, platform: string): Promise<void> {
    const site = COOKIE_PLATFORMS[platform];
    if (!site || !deps.cookies) return;
    await ctx.reply(
      [
        `Send me the cookie for <b>${escapeHtml(site.name)}</b> in one message. I delete it from the chat right away.`,
        `How: log in to ${site.site} in a desktop browser → F12 → Network → reload → click any request to ${site.site} → copy the <code>cookie:</code> request header value.`,
        "/cancel to stop.",
      ].join("\n"),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    const text = await new Promise<string>((resolve) => (pendingInput = { resolve, secret: true }));
    if (!text) return void (await ctx.reply("Cookie unchanged."));
    try {
      deps.cookies.set(platform, text);
      await ctx.reply(`🍪 ${site.name} cookie saved. Links from ${site.site} use it from now on.`);
    } catch (error) {
      await ctx.reply(`❌ ${errorMessage(error)}`);
    }
  }

  async function askPersona(ctx: Context, chatId: number): Promise<void> {
    const group = groups.list().find((g) => g.chatId === chatId);
    if (!group) return;
    await ctx.reply(
      `Send me the persona for <b>${escapeHtml(group.title)}</b> in one message, e.g.\n<i>輕鬆幽默，用繁體中文，回答短一點，可以用表情符號。</i>\n\n/cancel to keep the current one.`,
      { parse_mode: "HTML" },
    );
    const text = await new Promise<string>((resolve) => (pendingInput = { resolve }));
    if (!text) return void (await ctx.reply("Persona unchanged."));
    groups.setPersona(chatId, text);
    await ctx.reply(`🎭 Persona for ${group.title} saved. It applies from the next question.`);
  }

  async function askTimeZone(ctx: Context, chatId: number): Promise<void> {
    const group = groups.list().find((g) => g.chatId === chatId);
    if (!group) return;
    await ctx.reply(
      `Send the time zone for <b>${escapeHtml(group.title)}</b> (now ${escapeHtml(groups.timeZone(chatId))}): an IANA name like <code>Europe/London</code>, a city like <code>Tokyo</code>, or <code>default</code> (${escapeHtml(timeZone())}).\n\n/cancel to keep it.`,
      { parse_mode: "HTML" },
    );
    const text = await new Promise<string>((resolve) => (pendingInput = { resolve }));
    if (!text) return void (await ctx.reply("Time zone unchanged."));
    const reset = /^(default|reset)$/i.test(text);
    const zone = reset ? timeZone() : findTimeZone(text);
    if (!zone) return void (await ctx.reply(`I don't know the time zone "${text}". Tap 🕒 Time zone again to retry.`));
    groups.setTimeZone(chatId, reset ? "" : zone);
    await ctx.reply(`🕒 ${group.title}: ${zone}, now ${formatInZone(Date.now(), zone)}. New reminders use it.`);
  }

  async function status(): Promise<Screen> {
    const lines = ["<b>📊 Status</b>"];
    for (const p of CHAT_PROVIDER_IDS) {
      const stats = grok.stats.get(p);
      const used = grok.chain.includes(p) ? `#${grok.chain.indexOf(p) + 1}` : "not used";
      lines.push(
        `${(await grok.signedIn(p)) ? "✅" : "❌"} ${CHAT_PROVIDERS[p].name} (${used}) · answers ${stats?.answers ?? 0}, failovers ${stats?.failovers ?? 0}`,
      );
      if (stats?.lastError) lines.push(`   last error: ${escapeHtml(stats.lastError)}`);
    }
    if (await grok.signedIn("xai")) {
      try {
        const quota = await grok.quota();
        const used = quota.usedPercent !== undefined ? `${quota.usedPercent.toFixed(1)}% used` : "usage not reported";
        lines.push(`SuperGrok quota: ${used}${quota.resetsAt ? `, resets ${formatLocalTime(Date.parse(quota.resetsAt))}` : ""}`);
      } catch (error) {
        lines.push(`SuperGrok quota: unavailable (${escapeHtml(errorMessage(error))})`);
      }
    }
    lines.push(`Web/X search: ${grok.hostedSearch ? "on" : "off"} · Grok route: ${grok.route}`);
    if (health) lines.push(`Up ${formatUptime(Date.now() - health.startedAt)} · errors (24 h): ${health.recentErrors().length}`);
    lines.push("", "Counts are since the last restart.");
    return { text: lines.join("\n"), keyboard: new InlineKeyboard().text("🔄 Refresh", "adm:stat").text("⬅️ Back", "adm:home") };
  }
}

/** The live check as an HTML message (used by /health and the admin panel). */
export async function renderHealth(health: HealthMonitor | undefined): Promise<string> {
  if (!health) return "Health checks are not running.";
  const results = await health.run({ force: true });
  const byName = new Map(results.map((r) => [r.name, r]));
  const lines = health.results().map((r) => {
    const fresh = byName.get(r.name) ?? r;
    return `${fresh.ok ? "✅" : "❌"} <b>${escapeHtml(fresh.name)}</b> ${escapeHtml(fresh.detail)} <i>${fresh.ms} ms</i>`;
  });
  const errors = health.recentErrors();
  const tail = errors.slice(-3).map((e) => `• ${formatLocalTime(e.at).slice(11)} ${escapeHtml(e.message)}`);
  return [
    `<b>Live check</b> · up ${formatUptime(Date.now() - health.startedAt)}`,
    ...lines,
    "",
    `Errors in the last 24 h: ${errors.length}`,
    ...tail,
    "",
    "Checks run every 5 min; I message you here when something breaks or recovers.",
  ].join("\n");
}
