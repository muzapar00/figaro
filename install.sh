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

if [[ -d "$repo/settings" ]]; then
  echo "== settings app -> $qs_cfg-settings"
  mkdir -p "${qs_cfg}-settings"
  rsync -a --delete "$repo/settings/" "${qs_cfg}-settings/" --exclude test --exclude '*.sh'
  if [[ -f "$repo/systemd/figaro-settings.desktop" ]]; then
    mkdir -p "$HOME/.local/share/applications"
    install -Dm644 "$repo/systemd/figaro-settings.desktop" "$HOME/.local/share/applications/figaro-settings.desktop"
    echo "   desktop entry installed"

    # The brand icon is the assistant's speaking orb, rendered from the real
    # QML (assets/icons), installed into the hicolor theme the desktop reads.
    for size in 512 256 128 64 48 32; do
      install -Dm644 "$repo/assets/icons/figaro-$size.png" \
        "$HOME/.local/share/icons/hicolor/${size}x${size}/apps/figaro.png"
    done
    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
    update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
    echo "   icon installed (speaking orb, figaro.png)"
  fi
fi

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
