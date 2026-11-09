#!/usr/bin/env bash
# Install Figaro: overlay QML, systemd user units, and the config scaffold.
#
# Does not touch secrets: ~/.config/figaro/config.json must exist already
# (see config/config.example.json) and is never overwritten here.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
qs_cfg="${XDG_CONFIG_HOME:-$HOME/.config}/quickshell/figaro"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
node="${FIGARO_NODE:-/usr/bin/node}"

echo "== figaro: installing from $repo (node: $node)"

if [[ ! -f "$HOME/.config/figaro/config.json" ]]; then
  echo "!! ~/.config/figaro/config.json is missing." >&2
  echo "   Create it from config/config.example.json and set the API keys." >&2
  exit 1
fi

if [[ ! -d "$repo/node_modules" ]]; then
  echo "== npm install"
  ( cd "$repo" && npm install --no-audit --no-fund )
fi

echo "== overlay -> $qs_cfg"
mkdir -p "$qs_cfg"
rsync -a --delete "$repo/qml/" "$qs_cfg/" --exclude test --exclude ctl.sh

echo "== systemd units"
mkdir -p "$unit_dir"
ln -sfn "$repo/systemd/figaro.service" "$unit_dir/figaro.service"
ln -sfn "$repo/systemd/figaro-ui.service" "$unit_dir/figaro-ui.service"
systemctl --user daemon-reload
systemctl --user enable --now figaro.service
systemctl --user enable --now figaro-ui.service

echo "== status"
systemctl --user --no-pager --lines=0 status figaro.service figaro-ui.service || true
echo
echo "ask:   $node $repo/bin/figaro ask \"现在几点？用 bash 看一下\""
echo "watch: journalctl --user -u figaro -f"
