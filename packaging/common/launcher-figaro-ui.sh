#!/bin/sh
# /usr/bin/figaro-ui — packaged launcher for the Quickshell overlay.
#
# The GUI half of a packaged install lives behind this launcher so the static
# unit in /usr/lib/systemd/user carries no machine-specific path and no
# hard-coded KDE assumption:
#   * it discovers WAYLAND_DISPLAY (not always wayland-0: sway uses wayland-1);
#   * it finds qs via FIGARO_QS, $PATH or ~/.local/bin;
#   * it imports KOS's compositor-glass module only when it is installed — on
#     every other desktop the QML overlay falls back to its translucent fill.
set -e

FIGARO_LIBDIR="@LIBDIR@"

if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export XDG_RUNTIME_DIR
fi

if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -d "${XDG_RUNTIME_DIR:-}" ]; then
  for socket in "$XDG_RUNTIME_DIR"/wayland-[0-9]*; do
    [ -S "$socket" ] || continue
    WAYLAND_DISPLAY="${socket##*/}"
    export WAYLAND_DISPLAY
    break
  done
fi
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
  WAYLAND_DISPLAY="wayland-0"
  export WAYLAND_DISPLAY
fi

if [ -d "${HOME:-/nonexistent}/.config/quickshell/kos" ]; then
  QML2_IMPORT_PATH="${HOME}/.config/quickshell/kos${QML2_IMPORT_PATH:+:$QML2_IMPORT_PATH}"
  export QML2_IMPORT_PATH
fi
# A half-written QML file from a deploy must not kill the running shell; deploys
# restart the unit instead. Cap the glibc malloc arenas (52 threads x arenas
# inflate RSS on the overlay).
export QS_DISABLE_FILE_WATCHER=1
export MALLOC_ARENA_MAX=2

QS="${FIGARO_QS:-}"
if [ -z "$QS" ]; then
  QS="$(command -v qs 2>/dev/null || true)"
fi
if [ -z "$QS" ] && [ -x "${HOME:-/nonexistent}/.local/bin/qs" ]; then
  QS="${HOME}/.local/bin/qs"
fi
if [ -z "$QS" ]; then
  echo "figaro-ui: 找不到 Quickshell（qs）。安装 quickshell 后重试，或设置 FIGARO_QS 指向 qs。" >&2
  echo "           overlay 不支持 GNOME Wayland / X11，见 @DOCDIR@/platform-support.md" >&2
  exit 127
fi

exec "$QS" --no-duplicate -c figaro
