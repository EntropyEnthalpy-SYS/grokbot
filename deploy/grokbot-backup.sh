#!/bin/bash
# Nightly off-server backup, run by grokbot-backup.timer (as root).
# Makes a copy of the database without logins, API keys or message history (scripts/backup-offsite.ts),
# sends it to the backup server, deletes it here, and records the result for /health.
# The SSH key may only hand over one file there (deploy/backup-receive.sh as a forced command).
set -uo pipefail
. /etc/grokbot-backup/env            # BACKUP_TARGET, e.g. grokbot-backup@backup.example.com
DATA_DIR=$(. /etc/grokbot.env; echo "${DATA_DIR:-/var/lib/grokbot}")
STATUS="$DATA_DIR/backup-status.json"

status() { # ok(true|false) detail
  printf '{"at":%s,"ok":%s,"detail":%s}\n' "$(($(date +%s) * 1000))" "$1" "$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()[:200]))')" > "$STATUS.tmp"
  chown grokbot:grokbot "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}

file=$(cd /opt/grokbot && runuser -u grokbot -- env HOME="$DATA_DIR" DATA_DIR="$DATA_DIR" node scripts/backup-offsite.ts 2>&1 | tail -1)
if [ ! -f "$file" ]; then status false "backup copy failed: $file"; exit 1; fi
size=$(stat -c %s "$file")
reply=$(ssh -i /etc/grokbot-backup/id_ed25519 -o UserKnownHostsFile=/etc/grokbot-backup/known_hosts -o StrictHostKeyChecking=yes \
  -o BatchMode=yes -o ConnectTimeout=20 "$BACKUP_TARGET" < "$file" 2>&1 | tail -1)
code=$?
rm -f "$file"
if [ $code -ne 0 ] || [[ "$reply" != stored* ]]; then status false "sending failed: $reply"; exit 1; fi
status true "$((size / 1024)) KB copied to ${BACKUP_TARGET#*@} ($reply)"
