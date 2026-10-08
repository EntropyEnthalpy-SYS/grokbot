#!/bin/bash
# grokbot ops runner (root), started by grokbot-ops.path whenever the bot drops a
# request file. Only the actions below exist; anything else is refused. This lets
# the owner restart or update things from /admin without SSH, while the bot
# itself stays unprivileged.
#
# The request folder belongs to the grokbot user, so root never opens, writes or
# chowns anything in it: requests are read and results written as grokbot
# (setpriv), and only regular files are accepted. A symlink or FIFO planted there
# therefore can't make root touch other files.
set -u
DIR=/var/lib/grokbot/ops
AS_BOT=(setpriv --reuid=grokbot --regid=grokbot --clear-groups --)
shopt -s nullglob
redact() { sed -E 's/[0-9]{6,}:[A-Za-z0-9_-]{30,}/<token>/g; s/(sk-ant-|sk-)[A-Za-z0-9_-]{10,}/<key>/g'; }

read_action() {
  "${AS_BOT[@]}" python3 -c '
import json, os, stat, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
if not stat.S_ISREG(os.fstat(fd).st_mode): sys.exit(1)
with os.fdopen(fd) as f: print(json.loads(f.read(4096)).get("action", ""))' "$1" 2>/dev/null
}

write_result() {
  "${AS_BOT[@]}" python3 - "$DIR/result-$1.json" "$2" "$3" "$4" <<'PY'
import json, os, sys, time
path, action, ok, out = sys.argv[1:5]
tmp = f"{path}.{os.getpid()}.tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"action": action, "ok": ok == "1", "output": out[-3500:], "finishedAt": int(time.time() * 1000)}, f)
os.replace(tmp, path)
PY
}

for req in "$DIR"/request-*.json; do
  id=$(basename "$req" .json); id=${id#request-}
  action=$(read_action "$req" || true)
  "${AS_BOT[@]}" rm -f -- "$req"
  [[ "$id" =~ ^[a-z0-9]{6,40}$ ]] || continue
  ok=1
  case "$action" in
    restart-bot)
      systemctl restart grokbot 2>&1 || ok=0
      out="grokbot restarted ($(systemctl is-active grokbot))";;
    restart-helpers)
      out=""
      for u in grokbot-parsehub grokbot-tunnel; do
        [ -f "/etc/systemd/system/$u.service" ] || continue
        if systemctl restart "$u" 2>/dev/null; then out+="$u: $(systemctl is-active "$u")"$'\n'
        else ok=0; out+="$u: restart failed"$'\n'; fi
      done;;
    update-tools)
      systemctl start yt-dlp-update.service 2>&1 || ok=0
      out="yt-dlp $(/opt/yt-dlp/bin/yt-dlp --version 2>/dev/null), parsehub $(/opt/parsehub/bin/pip show parsehub 2>/dev/null | sed -n 's/^Version: //p') ($(systemctl show yt-dlp-update.service -p Result --value))";;
    logs)
      out=$(journalctl -u grokbot -u grokbot-parsehub -u telegram-bot-api -u grokbot-tunnel --since "-6h" --no-pager -o short-iso 2>/dev/null \
        | grep -aiE "error|fail|warn|exception|denied" | grep -avE "^\S+ \S+ \S+: \s+at " | tail -25 | cut -c1-220 | redact);
      [ -n "$out" ] || out="No errors or warnings in the last 6 hours.";;
    status)
      out=$(for u in grokbot grokbot-parsehub telegram-bot-api grokbot-tunnel grokbot-watchdog.timer yt-dlp-update.timer; do
        echo "$u: $(systemctl is-active "$u" 2>/dev/null)"; done; df -h /var/lib/grokbot | tail -1 | awk '{print "disk: "$4" free of "$2}'; free -m | awk 'NR==2{print "memory: "$7" MB available of "$2" MB"}');;
    *) ok=0; out="unknown action: $action";;
  esac
  write_result "$id" "$action" "$ok" "$out"
done
