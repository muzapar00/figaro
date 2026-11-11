#!/bin/sh
# /usr/bin/figaro-settings — packaged launcher for the settings/self-test panel.
#
# This is also the first-run entry point: if the per-user install has not been
# done yet (no QML in ~/.config/quickshell/figaro-settings or no
# ~/.config/figaro/config.json), it runs `figaro install-user` for the user
# first. That registers the systemd user units, creates the config scaffold and
# copies the QML — all without root. Opening the app from the menu therefore
# completes the install the same way the postinst message tells users to.
set -e

FIGARO_LIBDIR="@LIBDIR@"
FIGARO_PACKAGED=1
export FIGARO_PACKAGED

if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export XDG_RUNTIME_DIR
fi

# ---- first-run per-user install -------------------------------------------
if [ ! -f "${HOME:-/nonexistent}/.config/quickshell/figaro-settings/qmldir" ] || [ ! -f "${HOME:-/nonexistent}/.config/figaro/config.json" ]; then
  if [ -x "$FIGARO_LIBDIR/bin/figaro" ]; then
    if [ -n "${FIGARO_NODE:-}" ]; then
      node_bin="$FIGARO_NODE"
    elif [ -x /usr/bin/node ]; then
      node_bin=/usr/bin/node
    else
      node_bin="$(command -v node 2>/dev/null || true)"
    fi
    # Best effort: the window still opens if this fails; the user then gets the
    # explicit instructions from `figaro install-user`.
    if [ -n "$node_bin" ]; then
      "$node_bin" "$FIGARO_LIBDIR/bin/figaro" install-user >/dev/null 2>&1 || true
    fi
  fi
fi

# ---- Quickshell discovery -------------------------------------------------
QS="${FIGARO_QS:-}"
if [ -z "$QS" ]; then
  QS="$(command -v qs 2>/dev/null || true)"
fi
if [ -z "$QS" ] && [ -x "${HOME:-/nonexistent}/.local/bin/qs" ]; then
  QS="${HOME}/.local/bin/qs"
fi
if [ -z "$QS" ]; then
  echo "figaro-settings: 找不到 Quickshell（qs），无法打开设置面板。安装 quickshell 后重试。" >&2
  exit 127
fi

# The settings window draws its own macOS-style title bar (traffic lights), so
# KWin's server-side decoration is turned off for it by the KWin rule that
# install-user mirrors into ~/.config/kwinrulesrc.
export FIGARO_SETTINGS_GL=1
exec "$QS" --no-duplicate -c figaro-settings
