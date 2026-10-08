#!/bin/bash
# Install the sentinel on a second server and authorize it on the bot's VPS.
# Usage: deploy/deploy-sentinel.sh <sentinel ssh target> <bot VPS ssh target> [extra ssh options...]
#   e.g. deploy/deploy-sentinel.sh root@watcher.example.com root@bot.example.com -i ~/.ssh/id_ed25519 -o BatchMode=yes
# The first run needs ALERT_BOT_TOKEN and OWNER_ID in the environment (stored in /etc/grokbot-sentinel/env).
set -euo pipefail
SENTINEL=$1; VPS=$2; shift 2
here=$(cd "$(dirname "$0")" && pwd)

ssh "$@" "$SENTINEL" 'install -d -m 755 /opt/grokbot-sentinel && install -d -m 700 /etc/grokbot-sentinel'
scp -q "$@" "$here/sentinel/grokbot-sentinel.sh" "$here/sentinel/grokbot-sentinel.service" "$here/sentinel/grokbot-sentinel.timer" "$SENTINEL:/opt/grokbot-sentinel/"
if [ -n "${ALERT_BOT_TOKEN:-}" ]; then
  printf 'ALERT_BOT_TOKEN=%s\nOWNER_ID=%s\nTARGET=%s\n' "$ALERT_BOT_TOKEN" "$OWNER_ID" "$VPS" | ssh "$@" "$SENTINEL" 'umask 077; cat > /etc/grokbot-sentinel/env'
fi
pubkey=$(ssh "$@" "$SENTINEL" '[ -f /etc/grokbot-sentinel/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C "grokbot-sentinel@$(hostname)" -f /etc/grokbot-sentinel/id_ed25519; cat /etc/grokbot-sentinel/id_ed25519.pub')

# On the VPS the key may only print the heartbeat: no shell, no forwarding.
line="restrict,command=\"cat /var/lib/grokbot/heartbeat.json\" $pubkey"
ssh "$@" "$VPS" "grep -qF '${pubkey#* }' /root/.ssh/authorized_keys 2>/dev/null || echo '$line' >> /root/.ssh/authorized_keys"
# Trust the VPS host key we already trust here, instead of trusting whatever answers first.
host=${VPS#*@}
ssh-keygen -F "$host" | grep -v '^#' | ssh "$@" "$SENTINEL" 'cat > /etc/grokbot-sentinel/known_hosts'

ssh "$@" "$SENTINEL" 'install -m 644 /opt/grokbot-sentinel/grokbot-sentinel.service /opt/grokbot-sentinel/grokbot-sentinel.timer /etc/systemd/system/ &&
  systemctl daemon-reload && systemctl enable --now grokbot-sentinel.timer >/dev/null 2>&1 && bash /opt/grokbot-sentinel/grokbot-sentinel.sh'
