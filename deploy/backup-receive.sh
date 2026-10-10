#!/bin/bash
# On the backup server: the forced command of the bot's backup key. Stores the database copy
# arriving on stdin as backups/grokbot-YYYY-MM-DD.db and keeps the newest KEEP of them.
# The key can do nothing else: no shell, no forwarding, no reading files back.
set -euo pipefail
DIR=${BACKUP_DIR:-$HOME/backups}
KEEP=14
MAX_BYTES=$((500 * 1024 * 1024))
mkdir -p -m 700 "$DIR"
tmp=$(mktemp "$DIR/.incoming.XXXXXX")
trap 'rm -f "$tmp"' EXIT
head -c $((MAX_BYTES + 1)) > "$tmp"
size=$(stat -c %s "$tmp")
if [ "$size" -gt "$MAX_BYTES" ] || [ "$size" -lt 1024 ]; then echo "refused: $size bytes"; exit 1; fi
# Only SQLite files are kept.
if [ "$(head -c 15 "$tmp")" != "SQLite format 3" ]; then echo "refused: not a database"; exit 1; fi
name="grokbot-$(date -u +%Y-%m-%d).db"
chmod 600 "$tmp" && mv "$tmp" "$DIR/$name"
ls -1t "$DIR"/grokbot-*.db | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "stored $name, $(ls -1 "$DIR"/grokbot-*.db | wc -l) kept"
