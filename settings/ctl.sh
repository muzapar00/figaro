#!/usr/bin/env bash
# Start/stop the Figaro settings GUI (macOS-style Quickshell panel).
#
#   settings/ctl.sh start            deploy + start against the production daemon
#   settings/ctl.sh restart          stop + deploy + start
#   settings/ctl.sh stop
#   settings/ctl.sh logs             tail of the GUI log
#   settings/ctl.sh install-desktop  install systemd/figaro-settings.desktop
#   settings/ctl.sh uninstall-desktop
#
# Development against the fake daemon (never touches the production socket):
#   FIGARO_SOCKET=/run/user/1000/figaro-settings-test/sock settings/ctl.sh restart
#
# Env:
#   FIGARO_SOCKET          unix socket the GUI connects to (default: production
#                          $XDG_RUNTIME_DIR/figaro/sock)
#   FIGARO_SETTINGS_GL=0   force the software Qt Quick backend; the default is
#                          OpenGL because QWaylandShmBackingStore segfaults with
#                          the software backend on this Qt/Wayland combo
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
config_name="figaro-settings"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/quickshell/$config_name"
runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
pidfile="$runtime/figaro-settings-ui.pid"
log="$runtime/figaro-settings-ui.log"
desktop_src="$repo/systemd/figaro-settings.desktop"
desktop_dest="${XDG_DATA_HOME:-$HOME/.local/share}/applications/figaro-settings.desktop"

export XDG_RUNTIME_DIR="$runtime"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export PATH="$HOME/.local/bin:$PATH"
# OpenGL is the default: the software rasterizer (QWaylandShmBackingStore)
# segfaults on this Qt/Wayland setup. Set FIGARO_SETTINGS_GL=0 to force software.
if [[ "${FIGARO_SETTINGS_GL:-1}" == "0" ]]; then
  export QT_QUICK_BACKEND=software
fi
# Passthrough: empty => the GUI falls back to the production socket.
export FIGARO_SOCKET="${FIGARO_SOCKET:-}"

qs_bin="$(command -v qs || echo "$HOME/.local/bin/qs")"

deploy() {
  mkdir -p "$dest"
  rsync -a --delete "$here"/ "$dest"/ \
    --exclude ctl.sh --exclude test --exclude '*.md'
}

stop() {
  if [[ -f "$pidfile" ]]; then
    local pid
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
  deploy
  mkdir -p "$runtime"
  setsid nohup "$qs_bin" --no-duplicate -c "$config_name" >"$log" 2>&1 </dev/null &
  echo $! >"$pidfile"
  sleep 1.8
  if ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "figaro-settings exited; log follows:" >&2
    cat "$log" >&2
    exit 1
  fi
  if grep -q "Configuration Loaded" "$log"; then
    echo "figaro-settings running (pid $(cat "$pidfile"))"
  else
    echo "figaro-settings started but 'Configuration Loaded' is missing; check $log" >&2
    exit 1
  fi
  echo "  config dir : $dest"
  echo "  socket     : ${FIGARO_SOCKET:-$runtime/figaro/sock} $([[ -n "$FIGARO_SOCKET" ]] && echo '(FIGARO_SOCKET override)')"
  echo "  log        : $log"
}

logs() {
  if [[ -f "$log" ]]; then tail -n "${2:-60}" "$log"; else echo "no log at $log" >&2; fi
}

install_desktop() {
  if [[ ! -f "$desktop_src" ]]; then
    echo "missing $desktop_src" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$desktop_dest")"
  install -m 644 "$desktop_src" "$desktop_dest"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$desktop_dest")" >/dev/null 2>&1 || true
  echo "installed $desktop_dest"
}

uninstall_desktop() {
  rm -f "$desktop_dest"
  echo "removed $desktop_dest"
}

case "${1:-restart}" in
  start) start ;;
  stop) stop; echo "figaro-settings stopped" ;;
  restart) stop; start ;;
  logs) logs "$@" ;;
  deploy) deploy; echo "deployed to $dest" ;;
  install-desktop) install_desktop ;;
  uninstall-desktop) uninstall_desktop ;;
  status)
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "running (pid $(cat "$pidfile"))"
    else
      echo "not running"
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 {start|stop|restart|logs|status|deploy|install-desktop|uninstall-desktop}" >&2
    exit 2
    ;;
esac
