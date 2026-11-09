#!/usr/bin/env bash
# Dev harness: run the settings GUI straight from the repo (hot reload) against
# settings/test/fake-daemon.mjs. The production socket is never used.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$(dirname "$here")")"
settings="$repo/settings"
runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XDG_RUNTIME_DIR="$runtime"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export QT_QUICK_BACKEND=software
export PATH="$HOME/.local/bin:$PATH"
export FIGARO_SOCKET="${FIGARO_SOCKET:-$runtime/figaro-settings-test/sock}"
fake_pid="$runtime/figaro-settings-test/dev-fake.pid"
ui_pid="$runtime/figaro-settings-test/dev-ui.pid"
logdir="$runtime/figaro-settings-test"
mkdir -p "$logdir"

fake_start() {
  if [[ -f "$fake_pid" ]] && kill -0 "$(cat "$fake_pid")" 2>/dev/null; then return 0; fi
  setsid nohup node "$settings/test/fake-daemon.mjs" >"$logdir/fake.log" 2>&1 </dev/null &
  echo $! >"$fake_pid"
  for _ in $(seq 1 50); do [[ -S "$FIGARO_SOCKET" ]] && return 0; sleep 0.05; done
  echo "fake daemon did not come up; see $logdir/fake.log" >&2; return 1
}
fake_stop() {
  [[ -f "$fake_pid" ]] || return 0
  kill "$(cat "$fake_pid")" 2>/dev/null || true
  rm -f "$fake_pid"
}
ui_stop() {
  [[ -f "$ui_pid" ]] || return 0
  kill "$(cat "$ui_pid")" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$(cat "$ui_pid")" 2>/dev/null || break; sleep 0.05; done
  rm -f "$ui_pid"
}
ui_start() {
  ui_stop
  setsid nohup "$HOME/.local/bin/qs" -p "$settings" --no-duplicate >"$logdir/ui.log" 2>&1 </dev/null &
  echo $! >"$ui_pid"
  sleep 2.0
}
case "${1:-restart}" in
  fake-start) fake_start ;;
  fake-stop) fake_stop ;;
  start) fake_start; ui_start ;;
  stop) ui_stop ;;
  restart) fake_start; ui_start ;;
  logs) echo "--- fake ---"; cat "$logdir/fake.log" 2>/dev/null; echo "--- ui ---"; cat "$logdir/ui.log" 2>/dev/null ;;
  ui-logs) cat "$logdir/ui.log" 2>/dev/null ;;
  *) echo "usage: $0 {start|stop|restart|logs|fake-start|fake-stop|ui-logs}" >&2; exit 2 ;;
esac
