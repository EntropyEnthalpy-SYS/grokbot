#!/bin/bash
# grokbot sentinel: runs on a SECOND server every 2 minutes (grokbot-sentinel.timer).
# Covers what nothing on the bot's VPS can report: the whole VPS being down.
# It reads the bot's heartbeat over SSH (a key that may only run that one command)
# and alerts the owner through a separate alert bot on Telegram's cloud API.
#   --test   send a test alert and exit
set -u
. /etc/grokbot-sentinel/env            # ALERT_BOT_TOKEN, OWNER_ID, TARGET (root@host)
TARGET=${SENTINEL_TARGET_OVERRIDE:-$TARGET}   # for testing an outage
DOWN_AFTER_MIN=${DOWN_AFTER_MIN:-8}    # tolerate reboots and short network blips
STALE_SECONDS=600                      # the bot writes its heartbeat every minute
STATE=/var/lib/grokbot-sentinel
mkdir -p "$STATE"

send() {
  local attempt
  for attempt in 1 2 3; do
    curl -sS -m 30 --fail -o /dev/null "https://api.telegram.org/bot$ALERT_BOT_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$OWNER_ID" --data-urlencode "text=$1" && return 0
    sleep 10
  done
  echo "alert not sent: $1"
  return 1
}

if [ "${1:-}" = "--test" ]; then send "🛰 the alert bot test: the watcher on $(hostname) can reach you."; exit 0; fi

problem=""
if out=$(ssh -n -i /etc/grokbot-sentinel/id_ed25519 -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=10 \
    -o UserKnownHostsFile=/etc/grokbot-sentinel/known_hosts -o StrictHostKeyChecking=yes "$TARGET" heartbeat 2>&1); then
  age=$(python3 -c 'import json, sys, time; print(int(time.time() - json.loads(sys.stdin.read())["at"] / 1000))' <<<"$out" 2>/dev/null) || age=""
  if [ -z "$age" ]; then
    problem="the VPS is up but the bot's heartbeat can't be read (bot never started?)"
  elif [ "$age" -gt "$STALE_SECONDS" ]; then
    problem="the VPS is up but the bot has been silent for $((age / 60)) min (watchdog restarts aren't helping)"
  fi
else
  problem="VPS ${TARGET#*@} is unreachable ($(tail -1 <<<"$out" | cut -c1-120))"
fi

now=$(date +%s)
if [ -n "$problem" ]; then
  [ -f "$STATE/down_since" ] || echo "$now" > "$STATE/down_since"
  down=$(( (now - $(cat "$STATE/down_since")) / 60 ))
  if [ ! -f "$STATE/alerted" ]; then
    [ "$down" -ge "$DOWN_AFTER_MIN" ] && send "🛰 grokbot is DOWN for $down min: $problem" && touch "$STATE/alerted"
  elif [ $((now - $(stat -c %Y "$STATE/alerted"))) -gt 86400 ]; then
    send "🛰 grokbot is still down ($((down / 60)) h): $problem" && touch "$STATE/alerted"
  fi
  echo "problem: $problem (for $down min)"
else
  if [ -f "$STATE/alerted" ]; then
    send "🛰 grokbot is back up (was down $(( (now - $(cat "$STATE/down_since")) / 60 )) min)."
  fi
  rm -f "$STATE/down_since" "$STATE/alerted"
  echo "ok: heartbeat ${age}s old"
fi
