#!/usr/bin/env bash
# Raise/activate a window by title or class substring (KDE Plasma / KWin Wayland).
# Usage: raise-window.sh <pattern> [outMostRecent]
# Prints "raised: <caption>" on success, "not found: <pattern>" otherwise.
set -u

pattern="${1:-}"
if [ -z "$pattern" ]; then
  echo "usage: raise-window.sh <pattern>" >&2
  exit 2
fi

tmp_js="$(mktemp /tmp/raise-win-XXXXXX.js)"
trap 'rm -f "$tmp_js"' EXIT

cat >"$tmp_js" <<EOF
const pat = $(printf '%s' "$pattern" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))');
const list = workspace.windowList ? workspace.windowList() : workspace.clientList();
let hit = null;
for (const c of list) {
  const cap = (c.caption || "") + "|" + (c.resourceClass || "") + "|" + (c.resourceName || "");
  if (cap.toLowerCase().indexOf(pat.toLowerCase()) !== -1) { hit = c; break; }
}
if (hit) {
  hit.minimized = false;
  workspace.activeWindow = hit;
  print("raised: " + hit.caption);
} else {
  print("not found: " + pat);
}
EOF

id="$(gdbus call --session --dest org.kde.KWin --object-path /Scripting \
      --method org.kde.kwin.Scripting.loadScript "$tmp_js" | tr -dc '0-9')"
gdbus call --session --dest org.kde.KWin --object-path /Scripting \
      --method org.kde.kwin.Scripting.start >/dev/null
sleep 0.6
gdbus call --session --dest org.kde.KWin --object-path "/Scripting/Script$id" \
      --method org.kde.kwin.Script.run >/dev/null 2>&1
sleep 0.4
# KWin prints the result to the journal
journalctl --user --since "10 seconds ago" --no-pager 2>/dev/null \
  | grep -E 'js: (raised|not found):' | tail -1 | sed 's/.*js: //'
