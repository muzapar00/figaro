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

if [[ -f "$pidfile" ]]; then
  kill "$(cat "$pidfile")" 2>/dev/null || true
  rm -f "$pidfile"
fi
sleep 0.2

if [[ "$state" == "off" ]]; then
  echo "fake daemon stopped"
  exit 0
fi

setsid nohup node "$here/fake-daemon.mjs" --state "$state" >/tmp/figaro-fake.log 2>&1 </dev/null &
echo $! >"$pidfile"
sleep 0.6
echo "fake daemon: $(cat /tmp/figaro-fake.log | head -2 | tr '\n' ' ')"
