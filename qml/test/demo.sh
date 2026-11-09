#!/usr/bin/env bash
# (Re)start the fake daemon in a fixed state and restart the overlay.
# Kept in a script so the caller's command line never contains a process name
# that a pkill pattern would also match.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state="${1:-listening}"
pidfile="/tmp/figaro-fake.pid"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

# Ask any live instance to shut down before replacing it, so a stale process
# cannot unlink the new instance's socket file on its way out.
node -e '
const net = require("node:net");
const p = process.env.XDG_RUNTIME_DIR + "/figaro/sock";
const s = net.createConnection(p);
s.on("connect", () => { s.write(JSON.stringify({ type: "quit" }) + "\n"); setTimeout(() => { s.end(); process.exit(0); }, 120); });
s.on("error", () => process.exit(0));
setTimeout(() => process.exit(0), 400);
' 2>/dev/null || true
if [[ -f "$pidfile" ]]; then
  kill "$(cat "$pidfile")" 2>/dev/null || true
  rm -f "$pidfile"
fi
sleep 0.3

if [[ "$state" == "off" ]]; then
  echo "fake daemon stopped"
  exit 0
fi

setsid nohup node "$here/fake-daemon.mjs" --state "$state" >/tmp/figaro-fake.log 2>&1 </dev/null &
echo $! >"$pidfile"
sleep 0.6
echo "fake daemon: $(cat /tmp/figaro-fake.log | head -2 | tr '\n' ' ')"
