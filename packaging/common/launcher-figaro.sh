#!/bin/sh
# /usr/bin/figaro — packaged launcher.
#
# The package keeps the real program tree in @LIBDIR@ (below /usr, read-only),
# so this wrapper only has to find a Node runtime at run time and point the CLI
# at that tree. Nothing here may contain a build-host path: the path is filled
# in from @LIBDIR@ when the package is built.
#
# It also exports FIGARO_QS (so `figaro settings` finds Quickshell even when qs
# lives in ~/.local/bin instead of $PATH) and FIGARO_PACKAGED (so
# `figaro install-user` knows the system tree is read-only and keeps models and
# user units under $HOME).
set -e

FIGARO_LIBDIR="@LIBDIR@"
FIGARO_PACKAGED=1
export FIGARO_PACKAGED

# XDG_RUNTIME_DIR is normally set by pam_systemd for the graphical session; a
# plain TTY/SSH shell may lack it and the CLI would then use /tmp for the socket.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export XDG_RUNTIME_DIR
fi

if [ -z "${FIGARO_QS:-}" ]; then
  for candidate in "$(command -v qs 2>/dev/null || true)" "${HOME:-/nonexistent}/.local/bin/qs" /usr/bin/qs; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      FIGARO_QS="$candidate"
      export FIGARO_QS
      break
    fi
  done
fi

if [ -n "${FIGARO_NODE:-}" ]; then
  NODE_BIN="$FIGARO_NODE"
elif [ -x /usr/bin/node ]; then
  NODE_BIN=/usr/bin/node
else
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "figaro: 找不到 Node.js（应作为依赖安装 nodejs；或设置 FIGARO_NODE 指向 node）" >&2
  exit 127
fi

exec "$NODE_BIN" "$FIGARO_LIBDIR/bin/figaro" "$@"
