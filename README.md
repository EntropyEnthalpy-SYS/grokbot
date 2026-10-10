# grokbot

A lightweight Telegram assistant for small groups and private chats that runs on **your AI subscription** — Grok (SuperGrok / X Premium), with ChatGPT Plus/Pro and Claude Pro/Max as optional fallbacks — instead of pay-per-token API keys.

It stays quiet unless asked: post a link and it shows what the link contains; mention it and it answers. Everything is managed from Telegram with `/admin`.

Plain TypeScript on Node 24 (no build step), [grammY](https://grammy.dev), [pi](https://github.com/earendil-works/pi) (`pi-ai` for logins and streaming, `pi-agent-core` for the agent loop) and one SQLite file.

## What it does

**In groups**
- **Answers when addressed**: @mention, a reply to the bot, or a message starting with “grok,”. Web and X search (also on ChatGPT/Claude, through Tavily), reading links, watching videos, seeing photos, reading documents (PDF, Word, PowerPoint, text; scanned PDFs as page images).
- **Link cards without commentary**: X posts (original media + translation), web pages, YouTube and other videos (the video itself with its title and description, no AI; a 📝 Summary button adds an AI summary on request), and Douyin, Xiaohongshu, Weibo, Bilibili, Kuaishou, Instagram, Facebook, Threads, Tieba, Douban… through [ParseHub](https://github.com/z-mio/ParseHub).
- **Voice**: transcripts (+ translation) of voice notes; questions asked by voice get a text and a voice-note answer.
- **`/tr`** translates a replied message, voice note, document or the text in a photo. **`/img`** or “grok, 畫…” creates or edits images (Grok Imagine).
- **Reminders** (`/remind`, “grok, 提醒我們…”) confirmed with the time understood, with edit, pause/resume and 💤 snooze; **scheduled posts** the bot writes itself (`/schedule 每天早上8點 台北天氣`); a **time zone per chat** (`/tz`).
- **Polls** (“grok, 開個投票…”) and **notes** it always remembers (`/lm`, “grok, 記住…”). In groups, ones the AI suggests wait for the asker's ✅, so a web page can't talk it into posting or saving something.
- **Privacy modes**: `strict` (default for new groups — nothing stored, each question answered on its own) or `normal` (7 days of context and memory).

**In private chats** (the owner, plus people the owner allows): the same assistant with its own conversation, streamed as a Telegram draft with a Stop button.

**For the owner — `/admin`**, an inline-button panel inside your private chat (with a 📖 Guide to every command):

| Screen | |
|---|---|
| 🤖 AI providers | Sign in to Grok / ChatGPT / Claude (or a Claude API key), order them, pick models. If the first fails before answering (quota, expired login, outage), the next answers. |
| 👥 Groups | Per group: link cards, privacy, language, voice, tidy, who may use the bot, persona, ✋ confirmations, 🕒 time zone. |
| 🔐 Permissions | Per person: 💬 private chat, ✅ approved (for “approved only” groups), ⭐ trusted (no limits), ⛔ blocked. Add people with Telegram's contact picker; strangers' access requests arrive with Allow/Block buttons. |
| 📈 Usage · ⚖️ Limits | Usage per member and per provider; adjustable per-member and per-group limits. |
| 📊 Status · 🩺 Health | Logins, quota, live checks of every dependency. |
| 🛠 Maintenance | Service status, recent errors, update yt-dlp/ParseHub, restart, backup (without logins) — no SSH needed. |

## Architecture

```
Telegram ⇄ Local Bot API server (optional, 2 GB files)
              │
          grokbot (Node)  ── pi-ai ──▶ xAI (chat, search, speech, images) · OpenAI · Anthropic
              │  SQLite: settings, notes, reminders, usage, permissions, credentials
              ├── ParseHub helper (Python, 127.0.0.1)  ── social media posts
              ├── yt-dlp + ffmpeg                       ── videos, subtitles, frames
              └── ops runner (root, fixed actions)      ── restart / update from /admin
watchdog timer: restarts stopped or hung services · sentinel on a 2nd server: alerts if the VPS is down
```

## Quick start (local)

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`). Turn **privacy mode off** (`/setprivacy` → Disable) so it can see links in groups, and enable **inline mode** (`/setinline`) if you want `@bot <link>`.
2. Get your numeric user id from @userinfobot.
3. `cp .env.example .env`, fill in `BOT_TOKEN` and `OWNER_ID`, then:

```bash
npm install
npm start
```

4. In a private chat with your bot: `/login` (Grok device-code sign-in), then `/admin`.
5. Add the bot to a group and send `/enable` there.

`ffmpeg` and `yt-dlp` are needed for videos and voice, `poppler-utils` (`pdftotext`) for PDFs; without them those features report an error and the rest works.

## Server deployment

`deploy/deploy.sh root@your-server` installs the bot, its helpers and systemd units (sandboxed bot user, daily yt-dlp/ParseHub updates, a watchdog, and the ops runner behind `/admin → Maintenance`). Optional: a local Bot API server for 2 GB files, a SOCKS tunnel for sites that block your server, and a watcher on a second server. See **[docs/deployment.md](docs/deployment.md)**.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example). Only `BOT_TOKEN` and `OWNER_ID` are required. `TIMEZONE` (default `Asia/Taipei`) sets the time zone for reminders and displayed times, and `DEFAULT_LANGUAGE` (default `zh-tw`) the translation language for new groups. Everything else (models, limits, groups, people) is changed at runtime in `/admin` and stored in SQLite.

## Data and privacy

- Stored: settings, notes, reminders, usage counts (no content), permissions, provider logins, the last 7 days of conversations with the bot in private chats and `normal` groups (older turns are dropped even while a chat stays active), and 7 days of group messages in `normal` groups. `strict` groups store neither. `/forget` deletes a chat's data; `/disable` removes a group.
- `strict` groups store no messages and send Grok only the question and the message it replies to.
- Backups from `/admin` exclude logins and API keys.
- Requests are sent with `store: false`. Check your provider's data settings (e.g. grok.com → Settings → Data Controls).

## About using subscriptions

grokbot signs in to Grok, ChatGPT and Claude the way their own CLI tools do. Each provider's terms decide what is allowed, and they change: as of October 2026, OpenAI officially supports ChatGPT plans in third-party tools, and Anthropic allows Claude plans in third-party apps (Max/Team plans also include API credits, usable with an API key). The bot does **not** rotate several accounts of one provider to get around limits. Using one subscription for a small group of friends is your decision and your responsibility.

## Development

```bash
npm run check       # typecheck + ~200 tests (needs ffmpeg)
```

- [docs/architecture.md](docs/architecture.md): how the code is organized.
- [scripts/README.md](scripts/README.md): live checks against the real services.
- [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md).

## Credits

[pi](https://github.com/earendil-works/pi) · [grammY](https://grammy.dev) · [ParseHub](https://github.com/z-mio/ParseHub) and the idea of [parse_hub_bot](https://github.com/z-mio/parse_hub_bot) · [yt-dlp](https://github.com/yt-dlp/yt-dlp) · [telegram-bot-api](https://github.com/tdlib/telegram-bot-api).

MIT License.
