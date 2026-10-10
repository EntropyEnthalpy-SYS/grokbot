# Deploying on a server

Tested on Debian 13 with systemd. You need root SSH access, Node 24, Python 3, `ffmpeg` and `curl` on the server (`deploy.sh` installs `poppler-utils` for PDFs if it is missing).

## 1. Install

From your machine:

```bash
deploy/deploy.sh root@your-server            # add ssh options after the host, e.g. -i ~/.ssh/key
```

This copies the code to `/opt/grokbot` (owned by root), creates the `grokbot` system user and `/var/lib/grokbot` (data, mode 700), installs yt-dlp and ParseHub in their own virtualenvs, and installs the systemd units. Run it again to update; it restarts the bot.

Then on the server:

```bash
nano /etc/grokbot.env            # BOT_TOKEN and OWNER_ID at least (see .env.example)
systemctl restart grokbot
journalctl -u grokbot -f         # "polling as @yourbot" means it's up
```

Open a private chat with the bot and send `/login`, then `/admin`.

## 2. What runs

| Unit | Runs as | What it does |
|---|---|---|
| `grokbot.service` | grokbot | The bot. `ProtectSystem=strict`, writes only `/var/lib/grokbot`, `MemoryMax=1G`. |
| `grokbot-parsehub.service` | grokbot | ParseHub helper on `127.0.0.1:8765`. Outbound private, link-local and CGNAT addresses are blocked (`IPAddressDeny`), so share-link redirects can't reach internal services. |
| `yt-dlp-update.timer` | root | Daily `pip install --upgrade` of yt-dlp and ParseHub, then restarts the helper. |
| `grokbot-watchdog.timer` | root | Every 2 min: restarts stopped services, restarts the bot if its heartbeat (`/var/lib/grokbot/heartbeat.json`) is older than 5 min, alerts the owner when something changes. |
| `grokbot-ops.path` | root | Runs `deploy/grokbot-ops.sh` when the bot drops a request from `/admin → 🛠 Maintenance`. Only a fixed list of actions exists; requests are read and results written as `grokbot`, never as root. |

## 3. Optional: big files (local Bot API server)

Telegram's hosted Bot API lets bots download 20 MB and upload 50 MB. A [local Bot API server](https://github.com/tdlib/telegram-bot-api) raises both to 2000 MB.

1. Build it on the server ([build instructions](https://tdlib.github.io/telegram-bot-api/build.html)) and install the binary as `/usr/local/bin/telegram-bot-api`.
2. Create an app at [my.telegram.org/apps](https://my.telegram.org/apps) and put `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in `/etc/grokbot.env`.
3. On the server: `/opt/grokbot/deploy/use-local-bot-api.sh`. It starts `telegram-bot-api.service` on `127.0.0.1:8081`, logs the bot out of Telegram's cloud server, and sets `TELEGRAM_API_ROOT`. `--undo` goes back.

## 4. Optional: sites that block your server

Some sites (Bilibili, for example) refuse data-center IPs. Route them through a second machine with an SSH SOCKS tunnel:

1. On the second machine, create a user whose `authorized_keys` entry only allows port forwarding (`restrict,port-forwarding`).
2. On the bot server, put the private key in `/etc/grokbot-tunnel/id_ed25519`, the host key in `/etc/grokbot-tunnel/known_hosts`, and `TUNNEL_HOST=user@second-machine` in `/etc/grokbot-tunnel/env`, then run `deploy.sh` again. It installs `grokbot-tunnel.service` (SOCKS on `127.0.0.1:1080`).
3. Use it: `YTDLP_PROXY=socks5://127.0.0.1:1080` in `/etc/grokbot.env`, and for ParseHub in `/etc/grokbot-parsehub.json`:
   ```json
   { "platforms": { "bilibili": { "proxy": "socks5://127.0.0.1:1080" } } }
   ```

## 5. Optional: alerts when the whole server is down

Nothing on a dead server can warn you. `deploy/deploy-sentinel.sh` installs a small watcher on a second server that reads the bot's heartbeat over SSH every 2 minutes and messages you through a separate alert-only bot if the server is unreachable (or the bot silent) for 8 minutes:

```bash
# create an alert bot with @BotFather and send it /start first
ALERT_BOT_TOKEN=… OWNER_ID=… deploy/deploy-sentinel.sh root@second-server root@bot-server
```

Its SSH key on the bot server may only print the heartbeat (`restrict,command=…`). Put the same `ALERT_BOT_TOKEN` in `/etc/grokbot.env` and the watchdog also uses it when the main bot can't send.

## 6. Logins, cookies and backups

- **AI providers**: `/login` (Grok) or `/admin → 🤖 AI providers` (Grok, ChatGPT, Claude). Logins live in the SQLite database.
- **Site cookies** for Instagram, Threads and Zhihu: `/admin → 🛠 Maintenance → 🍪 Site cookies` (stored in `/var/lib/grokbot/parsehub-cookies.json`, mode 600).
- **Backups**: `/admin → 🛠 Maintenance → 💾 Backup` sends you the database without logins and API keys. For a full backup, copy `/var/lib/grokbot/grokbot.db` yourself.

## 7. Optional: nightly backup to a second server

```bash
deploy/deploy-backup.sh root@second-server root@bot-server
```

Every night at 04:00 Taipei time the bot server copies the database to the second server, without logins, API keys, conversations, the group log or cached pages (so stored messages still disappear after 7 days). The second server keeps the newest 14 copies in `/var/lib/grokbot-backup/backups/`. The key used for this can only hand over one SQLite file there: no shell, no reading files back. `/health` shows when the last copy arrived and alerts if it fails.

## 8. Moving to a new server

1. On the new server: Node 24, `deploy/deploy.sh`, and (if used) the local Bot API binary, `/etc/grokbot-tunnel/` and `/etc/grokbot-parsehub.json`.
2. On the old server: stop and disable `grokbot`, `grokbot-watchdog.timer` and `grokbot-ops.path` (the watchdog would restart the bot), then call `close` on the local Bot API server so the bot can log in elsewhere, and stop `telegram-bot-api`.
3. Copy `/etc/grokbot.env` and `/var/lib/grokbot/grokbot.db` (with the service stopped) to the new server, run `deploy/deploy.sh` again, and enable `grokbot-watchdog.timer`.
4. Point the sentinel and the backup at the new server (`deploy/deploy-sentinel.sh`, `deploy/deploy-backup.sh`).
