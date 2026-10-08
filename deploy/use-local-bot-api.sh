#!/usr/bin/env bash
# Run ON THE SERVER as root, once telegram-bot-api is built and installed.
# Moves grokbot from Telegram's cloud Bot API (20 MB down / 50 MB up) to the
# local Bot API server (2000 MB both ways).
#   deploy/use-local-bot-api.sh          switch to the local server
#   deploy/use-local-bot-api.sh --undo   go back to the cloud (wait 10 min after the last switch)
set -euo pipefail
set -a; . /etc/grokbot.env; set +a

if [ "${1:-}" = "--undo" ]; then
  systemctl stop grokbot
  curl -fsS "http://127.0.0.1:8081/bot${BOT_TOKEN}/logOut" >/dev/null || true
  systemctl disable --now telegram-bot-api >/dev/null 2>&1 || true
  sed -i '/^TELEGRAM_API_ROOT=/d' /etc/grokbot.env
  systemctl start grokbot
  echo "back on the cloud Bot API"
  exit 0
fi

[ -x /usr/local/bin/telegram-bot-api ] || { echo "telegram-bot-api is not built yet"; exit 1; }
[ -n "${TELEGRAM_API_ID:-}" ] && [ -n "${TELEGRAM_API_HASH:-}" ] || { echo "TELEGRAM_API_ID/HASH missing in /etc/grokbot.env"; exit 1; }

install -d -o grokbot -g grokbot -m 700 /var/lib/grokbot/tgapi /var/lib/grokbot/tgapi-tmp
install -m 644 /opt/grokbot/deploy/telegram-bot-api.service /etc/systemd/system/telegram-bot-api.service
systemctl daemon-reload
systemctl enable --now telegram-bot-api >/dev/null
for i in $(seq 1 20); do curl -fsS -o /dev/null "http://127.0.0.1:8081/bot${BOT_TOKEN}/getMe" 2>/dev/null && break; sleep 1; done

systemctl stop grokbot
# Release the bot from the cloud server (required before using a local one).
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/logOut" | grep -q '"ok":true' || echo "warning: cloud logOut failed (already logged out?)"
grep -q '^TELEGRAM_API_ROOT=' /etc/grokbot.env || echo 'TELEGRAM_API_ROOT=http://127.0.0.1:8081' >> /etc/grokbot.env
systemctl start grokbot
sleep 4
curl -fsS "http://127.0.0.1:8081/bot${BOT_TOKEN}/getMe" | grep -o '"username":"[^"]*"'
journalctl -u grokbot --since "-10s" --no-pager -o cat | tail -2
