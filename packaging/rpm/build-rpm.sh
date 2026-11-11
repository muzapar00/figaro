#!/usr/bin/env bash
# Local helper for the RPM build (the spec is the deliverable; this script is
# only convenience for a machine that has rpmbuild, e.g. the CI Fedora
# container). It never uses sudo.
#
#   packaging/rpm/build-rpm.sh            # auto: use tag v$(version) if present,
#                                         # otherwise the working tree
#   RPMBUILD_OPTS="--nodeps" packaging/rpm/build-rpm.sh
#
# Output: packaging/rpm/out/RPMS/<arch>/figaro-<version>-<release>*.rpm
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$repo/package.json" | head -n1)"
[[ -n "$version" ]] || { echo "[build-rpm] 无法从 package.json 读版本号" >&2; exit 1; }

if ! command -v rpmbuild >/dev/null 2>&1; then
  cat >&2 <<'EOF'
[build-rpm] 本机没有 rpmbuild，无法在本地验证 RPM。
            这是预期情况：RPM 构建在 CI 的 Fedora 容器里完成
            （.github/workflows/release.yml 的 rpm job）。
            在 Fedora/openSUSE 上安装 rpm-build 后可用本脚本。
EOF
  exit 2
fi

topdir="$here/out"
mkdir -p "$topdir"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
tarball="$topdir/SOURCES/figaro-$version.tar.gz"
tag="v$version"
if git -C "$repo" rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1; then
  echo "[build-rpm] 用 tag $tag 生成源码包" >&2
  git -C "$repo" archive --format=tar.gz --prefix="figaro-$version/" -o "$tarball" "$tag"
else
  echo "[build-rpm] 警告：没有 tag $tag，用工作树 HEAD 生成源码包（仅本地验证）" >&2
  git -C "$repo" archive --format=tar.gz --prefix="figaro-$version/" -o "$tarball" HEAD
fi
cp -f "$here/figaro.spec" "$topdir/SPECS/figaro.spec"

# shellcheck disable=SC2086  # RPMBUILD_OPTS is intentionally word-split
rpmbuild -ba \
  --define "_topdir $topdir" \
  --define "_sourcedir $topdir/SOURCES" \
  --define "_specdir $topdir/SPECS" \
  ${RPMBUILD_OPTS:-} \
  "$topdir/SPECS/figaro.spec"

rpm_path="$(find "$topdir/RPMS" -name '*.rpm' -type f | head -n1 || true)"
if [[ -z "$rpm_path" ]]; then
  echo "[build-rpm] ERROR: rpmbuild 没有产出 RPM" >&2
  exit 1
fi
echo "[build-rpm] 完成: $rpm_path"
if command -v rpm >/dev/null 2>&1; then
  echo "[build-rpm] === rpm -qp --requires / -qpl（前 40 行） ==="
  rpm -qp --requires "$rpm_path" || true
  rpm -qpl "$rpm_path" | head -40 || true
fi
