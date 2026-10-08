# How the code is organized

Plain TypeScript run directly by Node 24 (type stripping, no build). Entry point: `src/main.ts`.

```
src/
  main.ts            start-up: config, stores, health checks, timers, polling
  app.ts             wiring shared by the bot and the scripts (DB, Grok, readers, sessions, tools)
  config.ts          environment variables → Config
  db.ts              SQLite schema and migrations (one file in DATA_DIR)
  time.ts · lang.ts  the bot's time zone (TIMEZONE) and default language

  grok/              AI providers
    grok.ts          sign-in, provider chain with failover, ask/stream, speech, images, quota
    credentialStore.ts  logins in SQLite (refreshes serialized per provider)
  agent/             the conversation agent (pi-agent-core)
    sessions.ts      one agent per chat; history in SQLite; notes/persona/date added per request
    tools.ts         read_link, watch_video
    images.ts · polls.ts   create_image, create_poll tools
  links/             link cards: detection, safe fetching, X posts, ParseHub, video cards, cache, cookies
  media/             yt-dlp/ffmpeg: video reading, subtitles, Bilibili, text-to-speech conversion
  telegram/          everything Telegram
    bot.ts           handlers: access, groups, private chat, commands, link cards, voice
    admin.ts         /admin panel (inline buttons)
    guide.ts         the guide shown in /admin and by /help
    groups.ts        group settings and the (normal-privacy) chat log
    streamer.ts      streaming replies (edits in groups, drafts in private)
    format.ts        Markdown → Telegram HTML, splitting long messages
    deleteQueue.ts · rateLimit.ts · media.ts · inline.ts
  memory.ts · reminders.ts · usage.ts · permissions.ts · health.ts · ops.ts
                     notes, reminders/scheduled posts, usage and limits, people, health checks, ops runner client

sidecar/parsehub_server.py   ParseHub wrapped as a localhost HTTP helper
deploy/                      deploy script, systemd units, watchdog, ops runner, sentinel
scripts/                     live checks against the real services (see scripts/README.md)
test/                        node:test suites
```

## Request flow in a group

```
message ─▶ access (permissions, enabled group, approved-only) ─▶ log (normal privacy only)
        ─▶ ephemeral/tidy handling for commands
        ─▶ addressed to the bot?  ── yes ─▶ limits ─▶ agent turn (provider chain, tools) ─▶ streamed reply
                                   └─ no ─▶ voice note? link? video? ─▶ automatic card (rate-limited)
```

Everything the owner changes at runtime (providers, models, limits, group settings, people) lives in SQLite; only secrets and paths come from the environment.
