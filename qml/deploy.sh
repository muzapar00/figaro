#!/usr/bin/env bash
# Install the Figaro overlay into the Quickshell config directory and restart it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/quickshell/figaro"
mkdir -p "$dest"
rsync -a --delete "$here"/ "$dest"/ --exclude deploy.sh
echo "installed -> $dest"
if [[ "${1:-}" == "--no-restart" ]]; then exit 0; fi
export PATH="$HOME/.local/bin:$PATH"
qs -c figaro --no-duplicate >/dev/null 2>&1 &
sleep 1.2
pgrep -af "qs -c figaro" | head -3
