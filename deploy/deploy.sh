#!/usr/bin/env bash
# Deploy grokbot to a Debian/Ubuntu server over SSH.
# Usage: deploy/deploy.sh root@host [ssh options...]
# Installs code to /opt/grokbot, data in /var/lib/grokbot, config in /etc/grokbot.env.
# The service starts only once /etc/grokbot.env has BOT_TOKEN and OWNER_ID.
set -euo pipefail

target="${1:?usage: deploy/deploy.sh root@host [ssh options...]}"
shift
cd "$(dirname "$0")/.."

tar czf - --exclude=node_modules --exclude=data --exclude=.git --exclude=.env --exclude=.amp . |
  ssh "$@" "$target" 'cat > /tmp/grokbot.tgz'

ssh "$@" "$target" 'bash -s' <<'REMOTE'
set -euo pipefail
id grokbot >/dev/null 2>&1 || useradd --system --home-dir /var/lib/grokbot --shell /usr/sbin/nologin grokbot
install -d -o grokbot -g grokbot -m 700 /var/lib/grokbot
rm -rf /opt/grokbot.new && mkdir -p /opt/grokbot.new
tar xzf /tmp/grokbot.tgz -C /opt/grokbot.new && rm -f /tmp/grokbot.tgz
(cd /opt/grokbot.new && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
rm -rf /opt/grokbot.old
if [ -d /opt/grokbot ]; then mv /opt/grokbot /opt/grokbot.old; fi
mv /opt/grokbot.new /opt/grokbot
chown -R root:root /opt/grokbot

if [ ! -f /etc/grokbot.env ]; then
  printf 'BOT_TOKEN=\nOWNER_ID=\nDATA_DIR=/var/lib/grokbot\nGROK_MODEL=grok-4.7\n' > /etc/grokbot.env
fi
chown root:grokbot /etc/grokbot.env && chmod 640 /etc/grokbot.env

install -m 644 /opt/grokbot/deploy/grokbot.service /etc/systemd/system/grokbot.service

# PDF text (pdftotext) and scanned pages (pdftoppm) for document summaries.
command -v pdftotext >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq poppler-utils >/dev/null; }

# Fonts for X posts drawn as pictures (/xstyle picture): Noto Sans (Latin) and Noto Sans SC/TC (Chinese).
fonts=/usr/local/share/grokbot-fonts; install -d -m 755 "$fonts"
for f in NotoSans-Regular.ttf NotoSans-Bold.ttf; do
  [ -s "$fonts/$f" ] || curl -fsSL -o "$fonts/$f" "https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/$f" || echo "warning: font $f not downloaded"
done
for f in SC/NotoSansSC-Regular.otf SC/NotoSansSC-Bold.otf TC/NotoSansTC-Regular.otf; do
  [ -s "$fonts/${f#*/}" ] || curl -fsSL -o "$fonts/${f#*/}" "https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/$f" || echo "warning: font ${f#*/} not downloaded"
done
chmod 644 "$fonts"/* 2>/dev/null || true

# yt-dlp in its own venv (with curl_cffi for browser impersonation), updated daily.
if [ ! -x /opt/yt-dlp/bin/yt-dlp ]; then
  python3 -m venv /opt/yt-dlp
  /opt/yt-dlp/bin/pip install --quiet --upgrade pip "yt-dlp[default,curl-cffi]"
fi
install -m 644 /opt/grokbot/deploy/yt-dlp-update.service /etc/systemd/system/yt-dlp-update.service
install -m 644 /opt/grokbot/deploy/yt-dlp-update.timer /etc/systemd/system/yt-dlp-update.timer
grep -q '^YTDLP_PATH=' /etc/grokbot.env || echo 'YTDLP_PATH=/opt/yt-dlp/bin/yt-dlp' >> /etc/grokbot.env

# ParseHub helper (Douyin, Weibo, XHS, Kuaishou, Bilibili, Instagram, ...), updated with yt-dlp.
if [ ! -x /opt/parsehub/bin/python ] || ! /opt/parsehub/bin/python -c "import parsehub" 2>/dev/null; then
  python3 -m venv /opt/parsehub
  /opt/parsehub/bin/pip install --quiet --upgrade pip parsehub
fi
[ -f /etc/grokbot-parsehub.json ] || echo '{"platforms": {}}' > /etc/grokbot-parsehub.json
chown root:grokbot /etc/grokbot-parsehub.json && chmod 640 /etc/grokbot-parsehub.json
install -d -o grokbot -g grokbot -m 700 /var/lib/grokbot/media
grep -q '^PARSEHUB_URL=' /etc/grokbot.env || echo 'PARSEHUB_URL=http://127.0.0.1:8765' >> /etc/grokbot.env
install -m 644 /opt/grokbot/deploy/grokbot-parsehub.service /etc/systemd/system/grokbot-parsehub.service

# SOCKS tunnel to the Taiwan exit for Bilibili (only if configured in /etc/grokbot-tunnel/env).
if [ -f /etc/grokbot-tunnel/env ]; then
  install -m 644 /opt/grokbot/deploy/grokbot-tunnel.service /etc/systemd/system/grokbot-tunnel.service
fi

# Nightly off-server backup (only once deploy/deploy-backup.sh has set it up).
if [ -f /etc/grokbot-backup/env ]; then
  install -m 644 /opt/grokbot/deploy/grokbot-backup.service /etc/systemd/system/grokbot-backup.service
  install -m 644 /opt/grokbot/deploy/grokbot-backup.timer /etc/systemd/system/grokbot-backup.timer
fi

# Local Bot API server (only once it has been built and API credentials exist).
if [ -x /usr/local/bin/telegram-bot-api ] && grep -qE '^TELEGRAM_API_ID=[0-9]+' /etc/grokbot.env; then
  install -d -o grokbot -g grokbot -m 700 /var/lib/grokbot/tgapi /var/lib/grokbot/tgapi-tmp
  install -m 644 /opt/grokbot/deploy/telegram-bot-api.service /etc/systemd/system/telegram-bot-api.service
fi

# Watchdog: restarts hung or stopped services and alerts the owner (independent of the bot process).
install -m 644 /opt/grokbot/deploy/grokbot-watchdog.service /etc/systemd/system/grokbot-watchdog.service
install -m 644 /opt/grokbot/deploy/grokbot-watchdog.timer /etc/systemd/system/grokbot-watchdog.timer

# Owner actions from /admin (restart, update, logs): the bot drops a request file, a root unit runs a fixed list of actions.
install -d -o grokbot -g grokbot -m 700 /var/lib/grokbot/ops
install -m 644 /opt/grokbot/deploy/grokbot-ops.service /etc/systemd/system/grokbot-ops.service
install -m 644 /opt/grokbot/deploy/grokbot-ops.path /etc/systemd/system/grokbot-ops.path

systemctl daemon-reload
systemctl enable --now grokbot-ops.path >/dev/null 2>&1
systemctl enable --now grokbot-watchdog.timer >/dev/null 2>&1
systemctl enable --now yt-dlp-update.timer >/dev/null 2>&1
systemctl enable grokbot-parsehub >/dev/null 2>&1
systemctl restart grokbot-parsehub
if grep -qE '^BOT_TOKEN=.+' /etc/grokbot.env && grep -qE '^OWNER_ID=[0-9]+' /etc/grokbot.env; then
  systemctl enable grokbot >/dev/null 2>&1
  systemctl restart grokbot
  echo "grokbot restarted"
else
  echo "grokbot installed; fill BOT_TOKEN and OWNER_ID in /etc/grokbot.env to start it"
fi
REMOTE
