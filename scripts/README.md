# scripts

Live checks against the real services. Run them **on the server** with the bot's environment, for example:

```bash
cd /opt/grokbot && set -a && . /etc/grokbot.env && set +a
sudo -u grokbot -E env HOME=/var/lib/grokbot node scripts/probe.ts
```

| Script | What it checks | Sends Telegram messages? |
|---|---|---|
| `login.ts` | Grok device-code sign-in from the terminal | no |
| `probe.ts` | what this Grok login can do (routes, search) | no |
| `probe-providers.ts` | the provider chain; starts and cancels ChatGPT/Claude sign-ins | no |
| `probe-platforms.ts [url…]` | which social platforms parse and download right now | no |
| `probe-reminders.ts [chat]` | reminder parsing with Grok; optionally a real reminder | optional |
| `probe-memory.ts` | notes saved by the remember tool and used later | no |
| `probe-images.ts <chat>` | image creation and editing through the agent | yes |
| `probe-features.ts <group>` | ops runner, command menu, drafts, voice reply, poll, scheduled post, backup | yes (labelled 🧪) |
| `e2e-media.ts` | video and voice reading (YouTube, TikTok, X video, voice note) | no |
| `e2e-telegram-media.ts <chat>` | uploads test media, reads it back, deletes it | yes (deleted) |
| `backup-offsite.ts` | writes the nightly off-server copy (used by `deploy/grokbot-backup.sh`) | no |
| `showcase.ts <group>` · `showcase-social.ts` · `showcase-video.ts` | posts one example of each automatic card | yes |
