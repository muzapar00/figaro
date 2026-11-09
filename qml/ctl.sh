#!/usr/bin/env bash
# Start/stop the Figaro overlay without pattern-matching process names on the
# command line (pkill -f patterns happily match the caller's own cmdline).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/quickshell/figaro"
pidfile="/tmp/figaro-ui.pid"
log="/tmp/figaro-ui.log"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export PATH="$HOME/.local/bin:$PATH"
# Same software backend as the systemd unit: GL contexts can fail to allocate on
# this machine while the local LLM holds almost all of the VRAM.
export QT_QUICK_BACKEND=software
# Forward a dev socket to the overlay when the caller set one.
export FIGARO_SOCKET="${FIGARO_SOCKET:-}"

stop() {
  if [[ -f "$pidfile" ]]; then
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.05; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

start() {
  rsync -a --delete "$here"/ "$dest"/ --exclude ctl.sh --exclude test
  setsid nohup qs -c figaro >"$log" 2>&1 </dev/null &
  echo $! >"$pidfile"
  sleep 1.6
  if ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "overlay exited; log follows:" >&2
    cat "$log" >&2
    exit 1
  fi
}

logs() { cat "$log"; }

case "${1:-restart}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start; echo "overlay pid $(cat "$pidfile")" ;;
  logs) logs ;;
  *) echo "usage: $0 {start|stop|restart|logs}" >&2; exit 2 ;;
esac
