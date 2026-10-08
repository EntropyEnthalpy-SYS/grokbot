#!/bin/bash
# grokbot watchdog, run every 2 minutes by grokbot-watchdog.timer (as root).
# Works even when the bot itself is stuck: restarts what is down or hung and
# messages the owner through the local Bot API server when the situation changes.
#   --test   send a test alert and exit
set -u
. /etc/grokbot.env
DATA_DIR=${DATA_DIR:-/var/lib/grokbot}
STATE_DIR=/var/lib/grokbot-watchdog
HEARTBEAT="$DATA_DIR/heartbeat.json"
HEARTBEAT_MAX_AGE=300   # the bot writes it every minute
mkdir -p "$STATE_DIR"

send() {
  local api="${TELEGRAM_API_ROOT:-}"
  # The bot is logged out of the cloud Bot API once it uses a local server, so alerts go through that server.
  if [ -z "$api" ]; then api="https://api.telegram.org"; fi
  if [ -n "${TELEGRAM_API_ROOT:-}" ] && ! systemctl is-active --quiet telegram-bot-api; then
    systemctl restart telegram-bot-api; sleep 5
  fi
  local attempt
  for attempt in 1 2 3; do
    curl -sS -m 30 -o /dev/null --fail "$api/bot$BOT_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$OWNER_ID" --data-urlencode "text=$1" && return 0
    sleep 10
  done
  # Fallback: the separate alert bot (cloud API), if configured. The main bot must not use the cloud API.
  if [ -n "${ALERT_BOT_TOKEN:-}" ] && curl -sS -m 30 -o /dev/null --fail "https://api.telegram.org/bot$ALERT_BOT_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$OWNER_ID" --data-urlencode "text=$1"; then
    return 0
  fi
  echo "alert not sent after 3 attempts: $1"
  return 1
}

if [ "${1:-}" = "--test" ]; then send "🐕 grokbot watchdog test: alerts reach you."; exit 0; fi

problems=()
for unit in telegram-bot-api grokbot-tunnel grokbot-parsehub grokbot; do
  [ -f "/etc/systemd/system/$unit.service" ] || continue
  if ! systemctl is-active --quiet "$unit"; then
    problems+=("$unit was $(systemctl is-active "$unit"); restarted it")
    systemctl reset-failed "$unit" 2>/dev/null
    systemctl restart "$unit"
  fi
done

# Running but hung (event loop stuck, polling dead): the heartbeat stops changing.
if systemctl is-active --quiet grokbot; then
  started=$(date -d "$(systemctl show grokbot -p ActiveEnterTimestamp --value)" +%s 2>/dev/null || echo 0)
  beat=$(stat -c %Y "$HEARTBEAT" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ $((now - started)) -gt $HEARTBEAT_MAX_AGE ] && [ $((now - beat)) -gt $HEARTBEAT_MAX_AGE ]; then
    problems+=("bot heartbeat is $((now - beat)) s old (hung?); restarted grokbot")
    systemctl restart grokbot
  fi
fi

# yt-dlp/ParseHub updates keep video sites working.
if [ -f /etc/systemd/system/yt-dlp-update.service ] && [ "$(systemctl show yt-dlp-update.service -p Result --value)" != "success" ]; then
  problems+=("daily yt-dlp update failed: journalctl -u yt-dlp-update")
fi

usage=$(df --output=pcent "$DATA_DIR" | tail -1 | tr -dc 0-9)
[ "${usage:-0}" -ge 95 ] && problems+=("disk ${usage}% full")

# Alert only when the situation changes (and remind once a day while it lasts).
current=$(printf '%s\n' "${problems[@]+"${problems[@]}"}")
previous=$(cat "$STATE_DIR/problems" 2>/dev/null || true)
last_sent=$(stat -c %Y "$STATE_DIR/sent" 2>/dev/null || echo 0)
if [ -n "$current" ]; then
  if [ "$current" != "$previous" ] || [ $(( $(date +%s) - last_sent )) -gt 86400 ]; then
    send "🐕 grokbot watchdog on $(hostname):
$(printf '• %s\n' "${problems[@]}")"
    touch "$STATE_DIR/sent"
  fi
elif [ -n "$previous" ]; then
  send "🐕 grokbot watchdog: all good again."
fi
printf '%s' "$current" > "$STATE_DIR/problems"
