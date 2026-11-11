#!/usr/bin/env bash
# Install or update Figaro from a git checkout.
#
# This is a thin wrapper around `figaro install-user`, which owns every
# per-user artefact: the Quickshell config directories, the rendered systemd
# user units, the config scaffold and the desktop entry/icon. The deb, rpm and
# AUR packages call the very same command after their system-wide install, so a
# git checkout and a packaged install end up in the same state.
#
# It never uses sudo (the services are user units) and never overwrites an
# existing ~/.config/figaro/config.json or its API keys.
#
#   ./install.sh                 # install/update and start the services
#   ./install.sh --no-start      # write units, do not start them now
#   ./install.sh --no-ui         # text/voice only; leave the overlay alone
#   ./install.sh --models-dir=~/.local/share/figaro/models
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node="${FIGARO_NODE:-$(command -v node || echo /usr/bin/node)}"

echo "== figaro: installing from $repo (node: $node)"

if [[ ! -d "$repo/node_modules" ]]; then
  echo "== npm install"
  ( cd "$repo" && npm install --no-audit --no-fund )
fi

"$node" "$repo/bin/figaro" install-user "$@"

echo "== status"
systemctl --user --no-pager --lines=0 status figaro.service figaro-ui.service 2>/dev/null || true
echo
echo "ask:   figaro ask \"现在几点？用 bash 看一下\""
echo "watch: journalctl --user -u figaro -f"
