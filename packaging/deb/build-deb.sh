#!/usr/bin/env bash
# Build the Debian package for Figaro.
#
#   ./packaging/deb/build-deb.sh
#   FIGARO_DEB_ARCH=amd64 ./packaging/deb/build-deb.sh
#   KEEP_STAGING=1 ./packaging/deb/build-deb.sh     # keep the staging tree
#
# Runs entirely as the invoking user: no sudo, no dpkg -i, no sudo systemctl.
# Produces out/figaro_<version>_<arch>.deb and validates it with dpkg-deb:
# control fields, file list, no build-host home path, no models and no secrets.
#
# Layout:
#   /usr/lib/figaro/{bin,src,node_modules,package.json,package-lock.json,
#                    scripts,qml,settings,systemd,config/config.example.json,assets}
#   /usr/bin/{figaro,figaro-ui,figaro-settings}      launchers (no host paths)
#   /usr/lib/systemd/user/{figaro,figaro-ui}.service  static, machine-independent
#   /usr/share/applications/figaro-settings.desktop
#   /usr/share/icons/hicolor/<size>x<size>/apps/figaro.png
#   /usr/share/doc/figaro/...
#
# Models are deliberately NOT bundled (scripts/fetch-models.sh downloads them per
# region at run time) and neither is any API key or config.json.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$repo/package.json" | head -n1)"
if [[ -z "$version" ]]; then
  echo "[build-deb] ERROR: 无法从 $repo/package.json 读出版本号" >&2
  exit 1
fi
pkg="figaro"
arch="${FIGARO_DEB_ARCH:-$(dpkg --print-architecture 2>/dev/null || echo amd64)}"
libdir="/usr/lib/${pkg}"
docdir="/usr/share/doc/${pkg}"
out="$here/out"
debname="${pkg}_${version}_${arch}.deb"

log() { printf '[build-deb] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"; }

need dpkg-deb
need tar
need find
need sed
need grep

staging="$(mktemp -d "${TMPDIR:-/tmp}/figaro-deb-staging.XXXXXX")"
cleanup() {
  if [[ "${KEEP_STAGING:-0}" == "1" ]]; then
    log "staging kept at $staging"
    return
  fi
  rm -rf "$staging"
}
trap cleanup EXIT
root="$staging/root"
mkdir -p "$root/DEBIAN"

# ------------------------------------------------------------------ payload --
log "版本 $version · 架构 $arch · 目标 $libdir"

# copy_tree <repo-relative-src> <dest> [tar args...]
copy_tree() {
  local src="$repo/$1" dst="$2"
  shift 2
  [[ -d "$src" ]] || die "缺少目录: $src"
  mkdir -p "$dst"
  ( cd "$src" && tar -cf - "$@" . ) | ( cd "$dst" && tar -xf - )
}

copy_tree bin "$root$libdir/bin"
copy_tree src "$root$libdir/src"
copy_tree scripts "$root$libdir/scripts"
# QML: only runtime files; test harness / deploy helpers stay in the checkout.
copy_tree qml "$root$libdir/qml" --exclude='./test' --exclude='./ctl.sh' --exclude='./deploy.sh'
# Settings panel: no test harness, screenshots or shell helpers.
copy_tree settings "$root$libdir/settings" --exclude='./test' --exclude='*.sh'
copy_tree systemd "$root$libdir/systemd"
copy_tree assets "$root$libdir/assets"
install -Dm644 "$repo/package.json" "$root$libdir/package.json"
install -Dm644 "$repo/package-lock.json" "$root$libdir/package-lock.json"
install -Dm644 "$repo/config/config.example.json" "$root$libdir/config/config.example.json"
install -Dm755 "$repo/bin/figaro" "$root$libdir/bin/figaro"

# Node production dependencies: take the checkout's production modules, or
# install them from the lockfile when the builder has no node_modules yet.
if [[ -f "$repo/node_modules/ws/package.json" && -f "$repo/node_modules/sherpa-onnx-node/package.json" ]]; then
  log "node_modules: 使用 checkout 里的生产依赖"
  mkdir -p "$root$libdir/node_modules"
  ( cd "$repo" && tar -cf - \
      node_modules/ws \
      node_modules/sherpa-onnx-node \
      node_modules/sherpa-onnx-linux-x64 \
      | tar -xf - -C "$root$libdir" )
  # Defensive: if the platform package name ever changes, fail loudly rather
  # than shipping a deb whose ASR cannot load.
  [[ -f "$root$libdir/node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node" ]] \
    || die "node_modules/sherpa-onnx-linux-x64 缺少原生模块（npm install 不完整？）"
else
  need npm
  log "node_modules: 缺失，执行受控的 npm ci --omit=dev（需要网络）"
  work="$staging/npm"
  mkdir -p "$work"
  install -m644 "$repo/package.json" "$work/package.json"
  install -m644 "$repo/package-lock.json" "$work/package-lock.json"
  ( cd "$work" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --allow-remote=all ) || die "npm ci 失败"
  mkdir -p "$root$libdir/node_modules"
  ( cd "$work" && tar -cf - node_modules ) | ( cd "$root$libdir" && tar -xf - )
fi

# --------------------------------------------------------------- launchers --
render() { # render <src> <dst> <mode>
  sed -e "s|@LIBDIR@|$libdir|g" -e "s|@DOCDIR@|$docdir|g" "$1" > "$2"
  chmod "$3" "$2"
}
mkdir -p "$root/usr/bin"
render "$here/../common/launcher-figaro.sh" "$root/usr/bin/figaro" 755
render "$here/../common/launcher-figaro-ui.sh" "$root/usr/bin/figaro-ui" 755
render "$here/../common/launcher-figaro-settings.sh" "$root/usr/bin/figaro-settings" 755

# ------------------------------------------------- systemd / desktop / icons --
mkdir -p "$root/usr/lib/systemd/user"
sed -e "s|@DOCDIR@|$docdir|g" "$here/../common/systemd-user/figaro.service" > "$root/usr/lib/systemd/user/figaro.service"
sed -e "s|@DOCDIR@|$docdir|g" "$here/../common/systemd-user/figaro-ui.service" > "$root/usr/lib/systemd/user/figaro-ui.service"
chmod 644 "$root/usr/lib/systemd/user/"*.service

install -Dm644 "$here/../common/desktop/figaro-settings.desktop" "$root/usr/share/applications/figaro-settings.desktop"
for size in 512 256 128 64 48 32; do
  icon="$repo/assets/icons/figaro-$size.png"
  [[ -f "$icon" ]] || continue
  install -Dm644 "$icon" "$root/usr/share/icons/hicolor/${size}x${size}/apps/figaro.png"
done

# --------------------------------------------------------------------- docs --
mkdir -p "$root$docdir"
install -m644 "$repo/LICENSE" "$root$docdir/LICENSE"
install -m644 "$repo/THIRD_PARTY_NOTICES.md" "$root$docdir/THIRD_PARTY_NOTICES.md"
for doc in README.md README.zh-CN.md CHANGELOG.md; do
  [[ -f "$repo/$doc" ]] && install -m644 "$repo/$doc" "$root$docdir/$doc"
done
# Curated runtime documentation. Development/planning documents
# (releasing.md, nextkde-integration.md, acceptance notes) stay in the repo: they
# contain maintainer-specific paths and would only bloat the package.
for md in platform-support.md ipc.md motion.md privacy.md rag.md voice-interaction.md smarthome-integration.md; do
  [[ -f "$repo/docs/$md" ]] && install -m644 "$repo/docs/$md" "$root$docdir/$md"
done
install -m644 "$here/copyright" "$root$docdir/copyright"
install -m644 "$here/README.Debian" "$root$docdir/README.Debian"

# --------------------------------------------------------------- DEBIAN ------
installed_size="$(du -sk "$root/usr" | cut -f1)"
cat > "$root/DEBIAN/control" <<EOF
Package: $pkg
Version: $version
Architecture: $arch
Maintainer: muzapar00 <mzpr00@163.com>
Installed-Size: $installed_size
Depends: nodejs (>= 22.0.0), libc6, libstdc++6, libgcc-s1
Recommends: pipewire, wireplumber, xdg-desktop-portal,
 xdg-desktop-portal-kde | xdg-desktop-portal-wlr | xdg-desktop-portal-gnome,
 quickshell
Suggests: spectacle, ffmpeg, grim, curl, tar, bzip2, python3
Section: sound
Priority: optional
Homepage: https://github.com/muzapar00/figaro
Description: system-level voice assistant for the Linux desktop
 Figaro is a background voice assistant for Wayland desktops: a local
 bilingual wake word (Chinese + English), local speech recognition, a
 DeepSeek agent with local tools (files, bash, screen, web) and MiniMax
 streaming speech output.
 .
 This package installs the program tree, launchers, machine-independent
 systemd user units, the desktop entry and the icons. The user services and
 the per-user Quickshell/QML installation are created by running
 "figaro install-user" as your normal user (the postinst prints how).
 .
 The speech models are not bundled; scripts/fetch-models.sh downloads them
 at run time (region-aware mirrors) into the user's data directory.
EOF

install -m755 "$here/postinst" "$root/DEBIAN/postinst"
install -m755 "$here/prerm" "$root/DEBIAN/prerm"

# md5sums: Debian policy wants them; dpkg-deb does not generate them itself.
if command -v md5sum >/dev/null 2>&1; then
  ( cd "$root" && find . -path ./DEBIAN -prune -o -type f -printf '%P\n' | LC_ALL=C sort | while IFS= read -r file; do
      md5sum "$file" | sed 's|  \./|  |'
    done > DEBIAN/md5sums )
fi

# Normalize permissions: everything root-owned 644/755 in the archive.
find "$root" -type d -exec chmod 755 {} +
find "$root" -type f -exec chmod 644 {} +
chmod 755 "$root/usr/bin/figaro" "$root/usr/bin/figaro-ui" "$root/usr/bin/figaro-settings" \
  "$root$libdir/bin/figaro" "$root/DEBIAN/postinst" "$root/DEBIAN/prerm"
# Executable model helper scripts keep their +x bits.
find "$root$libdir/scripts" -type f -name '*.sh' -exec chmod 755 {} +
[[ -d "$root$libdir/qml" ]] && find "$root$libdir/qml" -type f -name '*.sh' -exec chmod 755 {} +
chmod 755 "$root$libdir"/scripts/rag/*.mjs 2>/dev/null || true

# ------------------------------------------------------------------- build ---
mkdir -p "$out"
rm -f "$out/$debname"
log "打包（临时目录，无 sudo）"
if command -v fakeroot >/dev/null 2>&1; then
  fakeroot dpkg-deb --build --root-owner-group "$root" "$out/$debname" >/dev/null
else
  dpkg-deb --build --root-owner-group "$root" "$out/$debname" >/dev/null
fi

# --------------------------------------------------------------- validation --
log "验收: dpkg-deb -I / -c"
dpkg-deb -I "$out/$debname" >/dev/null || die "control 读取失败"
# Cache the file list once: piping `dpkg-deb -c` into `grep -q` closes the pipe
# early, which makes dpkg-deb's tar child die with EPIPE under `set -o pipefail`.
contents="$staging/contents.txt"
dpkg-deb -c "$out/$debname" > "$contents"
file_count="$(wc -l < "$contents")"
require_path() {
  grep -qE "\./$1\$" "$contents" || die "包里缺少 $1"
}
for required in \
  "usr/bin/figaro" "usr/bin/figaro-ui" "usr/bin/figaro-settings" \
  "usr/lib/systemd/user/figaro.service" "usr/lib/systemd/user/figaro-ui.service" \
  "usr/lib/figaro/bin/figaro" "usr/lib/figaro/src/doctor.js" \
  "usr/lib/figaro/package.json" "usr/lib/figaro/node_modules/sherpa-onnx-node/package.json" \
  "usr/lib/figaro/qml/figaro/FigaroOverlay.qml" \
  "usr/lib/figaro/systemd/figaro.service.in" \
  "usr/lib/figaro/config/config.example.json" \
  "usr/share/applications/figaro-settings.desktop" \
  "usr/share/doc/figaro/copyright"; do
  require_path "$required"
done

# Never ship models, a real config.json or a bundled API key.
if grep -qE '\./usr/lib/figaro/(models/|config/config\.json$)' "$contents"; then
  die "包内出现了 models/ 或 config/config.json（不应捆绑模型/密钥）"
fi

# No build-host paths: the units and launchers are templates expanded at
# run time, so $HOME or the builder's checkout must not appear anywhere in the
# text files of the package.
host_hits="$staging/host-hits.txt"
: > "$host_hits"
while IFS= read -r -d '' file; do
  if grep -Iq . "$file" 2>/dev/null; then
    if grep -qF -- "$HOME" "$file" 2>/dev/null; then
      printf '%s: contains $HOME (%s)\n' "$file" "$HOME" >> "$host_hits"
    fi
    if [[ -n "${repo:-}" ]] && grep -qF -- "$repo" "$file" 2>/dev/null; then
      printf '%s: contains checkout path %s\n' "$file" "$repo" >> "$host_hits"
    fi
    if grep -qF -- "@LIBDIR@" "$file" 2>/dev/null || grep -qF -- "@DOCDIR@" "$file" 2>/dev/null; then
      printf '%s: unexpanded @LIBDIR@/@DOCDIR@ placeholder\n' "$file" >> "$host_hits"
    fi
  fi
done < <(find "$root" -type f -print0)
if [[ -s "$host_hits" ]]; then
  cat "$host_hits" >&2 || true
  die "包内出现构建机路径或未展开的占位符（见上）"
fi

sha256="$(sha256sum "$out/$debname" | cut -d' ' -f1)"
printf '%s  %s\n' "$sha256" "$debname" > "$out/$debname.sha256"
size_human="$(du -h "$out/$debname" | cut -f1)"

cat <<EOF
[build-deb] 完成: $out/$debname
[build-deb]   sha256: $sha256
[build-deb]   文件数: $file_count · 安装后大小: ${installed_size} KiB · 包大小: $size_human
[build-deb]   模型不捆绑（运行时 scripts/fetch-models.sh）；config.example 只是模板
[build-deb] 安装: sudo apt install "$out/$debname"    # 之后以桌面用户运行: figaro install-user
EOF

if command -v lintian >/dev/null 2>&1; then
  log "lintian（非致命）"
  lintian --no-tag-display-limit "$out/$debname" || log "lintian 报告了问题，见上（不阻止构建）"
else
  log "lintian 未安装，跳过 Debian 策略检查（CI 里可选安装）"
fi
