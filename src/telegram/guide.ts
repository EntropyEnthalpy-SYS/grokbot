/**
 * The user guide, shown in /admin → 📖 Guide (all pages) and by /help (the
 * pages for members). One source, so the help never drifts from the panel.
 * Telegram HTML; every page stays well under the 4096-character limit.
 */
export interface GuidePage {
  id: string;
  /** Button label in the guide's index. */
  button: string;
  html: string;
}

const TALK = `<b>💬 Talking to the bot</b>
In a group it stays quiet until addressed: <b>@mention</b> it, <b>reply</b> to one of its messages, or start with <b>grok,</b>

• <code>grok, 台北明天天氣？</code> → answer with web/X search
• reply to a link: <code>grok, 重點是什麼？</code> → reads the link
• reply to a photo/video: <code>grok, 這是哪裡？</code> → looks at it
• reply to a PDF/Word/PowerPoint file: <code>grok, 總結</code> → reads it (in private chat, just send the file)
• <code>grok, 畫一隻戴太空頭盔的柴犬</code> → creates an image
• reply to a photo: <code>grok, 改成吉卜力風格</code> → edits it
• <code>grok, 提醒我們週五晚上8點開會</code> → reminder
• <code>grok, 記住小明吃素</code> → a note it always remembers
• <code>grok, 開個投票：晚餐吃什麼 拉麵/火鍋/壽司</code> → a poll
  In groups, notes and polls first appear as a preview: the person who asked taps ✅ (or ✖️).
• a voice message starting with “grok, …” → answer in text and voice

Automatic: posted links show what they contain (no comments), voice notes get a transcript. Video links show the video and its title, web links the page title and first lines, with no AI. Tap <b>📝</b> under a card for an AI summary (counts as a question), <b>▶️</b>/<b>🔗</b> to open the original. No cards for t.me links, adult sites or a link reposted within 6 hours.

Replying to one of its <b>answers</b> continues the conversation. Replies to its cards, transcripts, reminders or notices, and reactions like 哈哈 / 6 / 👍, are left alone: add <b>grok,</b> to ask about them.`;

const EVERYONE = `<b>⌨️ Commands for everyone</b>
• <code>/tr</code> (reply to text, voice, a photo or a document) → translation; <code>/tr en 你好</code> for given text
• <code>/img a cat astronaut</code> → image; as a reply to a photo it edits that photo
• <code>/remind 明天9點 交報告</code> → reminder, confirmed with the time it understood · <code>/reminders</code> lists · <code>/unremind 3</code> cancels
• <code>/remind edit 3 改到9點</code> · <code>/remind pause 3</code> · <code>/remind resume 3</code>; a due reminder has 💤 snooze buttons
• <code>/tz</code> → this chat's time zone (owner changes it in groups: <code>/tz Europe/London</code>)
• <code>/lm</code> notes: <code>/lm add 小明吃素</code> · <code>/lm del 2</code>
• <code>/stats</code> → your usage and what's left of your limits
• <code>/help</code> → this help

In groups, info commands like /stats, /lm and /reminders can be sent privately from the / menu: only you see them and the answer.`;

const OWNER_GROUP = `<b>👑 Owner commands in a group</b>
• <code>/enable</code> · <code>/disable</code> → bot on/off here (new groups start strict)
• <code>/privacy strict</code> · <code>normal</code> → strict stores nothing; normal keeps 7 days of context
• <code>/links auto</code> · <code>mention</code> · <code>off</code> → link cards always / when asked / never
• <code>/platforms off douyin weibo</code> → cards off per platform (<code>/platforms</code> lists; <code>upload</code> = uploaded videos)
• <code>/lang zh-tw</code> → zh-tw · zh-cn · en · ja · ko · off
• <code>/xstyle picture</code> · <code>text</code> → X posts drawn like on X, or as text
• <code>/tz Asia/Tokyo</code> · <code>/tz default</code> → time zone for reminders and the time the AI is told
• <code>/voice auto</code> · <code>off</code> → automatic voice transcripts
• <code>/tidy on</code> · <code>off</code> → setting replies disappear after 2 min
• <code>/deletelink on</code> · <code>off</code> → remove link-only messages after their card (bot must be admin)
• <code>/schedule 每天早上8點 台北天氣和新聞</code> → a post the bot writes itself (you and ⭐ trusted)
• <code>/new</code> · <code>/stop</code> → reset the conversation · stop running answers
• <code>/forget</code> → delete everything the bot stored for this chat

Most of these are also buttons in 👥 Groups.`;

const OWNER_PRIVATE = `<b>🔑 Owner commands in private chat</b>
• <code>/admin</code> → this panel
• <code>/login</code> · <code>/logout</code> → Grok sign-in (ChatGPT/Claude: 🤖 AI providers)
• <code>/status</code> → logins, models, SuperGrok quota
• <code>/health</code> → live check of the bot and its services
• <code>/model grok-4.7</code> → switch the Grok model (<code>/model</code> lists)
• <code>/search on</code> · <code>off</code> → web search (Grok: its own web/X search; ChatGPT/Claude: Tavily)
• <code>/route</code> → advanced; only if Grok returns 403
• <code>/new</code> · <code>/stop</code> · <code>/forget</code> → also work for anyone in their own private chat`;

const PANEL = `<b>🗂 The panel</b>
• 🤖 <b>AI providers</b>: sign in to Grok / ChatGPT / Claude, order them, pick models
• 👥 <b>Groups</b>: links · privacy · language · voice · tidy · who can use it · persona · voice replies · ✋ confirm notes/polls · 🕒 time zone · 🔞 adult links · 𝕏 X post style
• 📈 <b>Usage</b>: who used what (today / 7 / 30 days), tokens per provider
• ⚖️ <b>Limits</b>: ➖/➕ per limit, ⭐ trusted members
• 🔐 <b>Permissions</b>: per person 💬 private chat · ✅ approved · ⭐ trusted · ⛔ blocked; ➕ add people
• 📊 <b>Status</b> · 🩺 <b>Health</b>
• 🛠 <b>Maintenance</b>: status · recent errors · update · restart · 💾 backup · 🍪 site cookies`;

const TASKS = `<b>🧭 Common tasks</b>
• <b>A friend wants to chat privately</b> → 🔐 Permissions → ➕ Add people, or tap ✅ Allow on their access request
• <b>The group is too noisy</b> → <code>/links mention</code> in the group, or 👥 Groups
• <b>Someone uses it too much</b> → ⚖️ Limits, or ⛔ block in 🔐 Permissions
• <b>Only some members should use it</b> → 👥 Groups → 🔐 Who can use: approved only, then ✅ approve them in 🔐 Permissions
• <b>Grok quota ran out</b> → 🤖 AI providers: sign in to ChatGPT or Claude as a fallback
• <b>Instagram / Threads / Zhihu links fail</b> → 🛠 Maintenance → 🍪 Site cookies
• <b>Something seems broken</b> → 🩺 Health, then 🛠 Maintenance → Recent errors or Restart
• <b>Clear what the bot remembers</b> → <code>/forget</code> in that chat`;

export const GUIDE: readonly GuidePage[] = [
  { id: "talk", button: "💬 Talking to the bot", html: TALK },
  { id: "everyone", button: "⌨️ Commands for everyone", html: EVERYONE },
  { id: "group", button: "👑 Owner: group commands", html: OWNER_GROUP },
  { id: "private", button: "🔑 Owner: private commands", html: OWNER_PRIVATE },
  { id: "panel", button: "🗂 The panel", html: PANEL },
  { id: "tasks", button: "🧭 Common tasks", html: TASKS },
];

/** /help for group members and people with private access: how to talk to it, and their commands. */
export const MEMBER_HELP = `${TALK}\n\n${EVERYONE}`;

/** /help for the owner in private chat. */
export const OWNER_HELP = `<b>Grok bot</b>: you're the owner.
Open <code>/admin</code> → 📖 <b>Guide</b> for the full tutorial: talking to the bot, every command, the panel and common tasks.`;
