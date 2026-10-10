#!/bin/bash
# Set up the nightly off-server backup.
# Usage: deploy/deploy-backup.sh <backup server ssh target> <bot server ssh target> [extra ssh options...]
#   e.g. deploy/deploy-backup.sh root@backup.example.com root@bot.example.com -i ~/.ssh/id_ed25519 -o BatchMode=yes
# On the backup server: a `grokbot-backup` user whose only key runs deploy/backup-receive.sh.
# On the bot server: that key, the backup server's host key, and the nightly timer.
set -euo pipefail
BACKUP=$1; VPS=$2; shift 2
here=$(cd "$(dirname "$0")" && pwd)
host=${BACKUP#*@}

ssh "$@" "$VPS" 'install -d -m 700 /etc/grokbot-backup && { [ -f /etc/grokbot-backup/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C "grokbot-backup@$(hostname)" -f /etc/grokbot-backup/id_ed25519; }'
pubkey=$(ssh "$@" "$VPS" 'cat /etc/grokbot-backup/id_ed25519.pub')

scp -q "$@" "$here/backup-receive.sh" "$BACKUP:/tmp/grokbot-backup-receive"
ssh "$@" "$BACKUP" "set -e
id grokbot-backup >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/grokbot-backup --shell /bin/sh grokbot-backup
install -m 755 /tmp/grokbot-backup-receive /usr/local/bin/grokbot-backup-receive && rm -f /tmp/grokbot-backup-receive
install -d -m 700 -o grokbot-backup -g grokbot-backup /var/lib/grokbot-backup/.ssh /var/lib/grokbot-backup/backups
echo 'restrict,command=\"/usr/local/bin/grokbot-backup-receive\" $pubkey' > /var/lib/grokbot-backup/.ssh/authorized_keys
chown grokbot-backup:grokbot-backup /var/lib/grokbot-backup/.ssh/authorized_keys && chmod 600 /var/lib/grokbot-backup/.ssh/authorized_keys"

# Trust the backup server's host key we already trust here.
ssh-keygen -F "$host" | grep -v '^#' | ssh "$@" "$VPS" 'cat > /etc/grokbot-backup/known_hosts'
echo "BACKUP_TARGET=grokbot-backup@$host" | ssh "$@" "$VPS" 'cat > /etc/grokbot-backup/env'
ssh "$@" "$VPS" 'install -m 644 /opt/grokbot/deploy/grokbot-backup.service /opt/grokbot/deploy/grokbot-backup.timer /etc/systemd/system/ &&
  systemctl daemon-reload && systemctl enable --now grokbot-backup.timer >/dev/null 2>&1 && bash /opt/grokbot/deploy/grokbot-backup.sh && cat /var/lib/grokbot/backup-status.json'
