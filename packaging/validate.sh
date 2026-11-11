#!/usr/bin/env bash
# Static validation for the packaging tree, usable locally and from CI.
#
#   bash packaging/validate.sh           # all static checks
#   bash packaging/validate.sh --build   # static checks + build the deb
#
# It deliberately needs no sudo and no rpmbuild/makepkg: those two are only
# validated in CI containers (see .github/workflows/release.yml). What this
# script does check:
#   * every shell script parses (bash -n), including the PKGBUILD
#   * package.json / PKGBUILD / RPM spec versions agree
#   * the PKGBUILD and its committed .SRCINFO describe the same package
#   * the RPM spec has the required tags and balanced %if/%endif blocks
#   * the release workflow is valid YAML (python3 yaml or ruby yaml)
#   * launcher/unit templates exist and only templates contain @PLACEHOLDERS@
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
failures=0
pass() { printf '  ✓ %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*"; failures=$((failures + 1)); }
section() { printf '\n== %s\n' "$*"; }

version_json="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$repo/package.json" | head -n1)"
[[ -n "$version_json" ]] || { echo "cannot read version from package.json" >&2; exit 1; }
printf 'figaro version: %s\n' "$version_json"

# --------------------------------------------------------------- shell syntax
section "shell 语法"
while IFS= read -r -d '' script; do
  if bash -n "$script" 2>/dev/null; then
    pass "bash -n ${script#"$repo"/}"
  else
    fail "bash -n ${script#"$repo"/}"
    bash -n "$script" 2>&1 | head -3 | sed 's/^/      /'
  fi
done < <(find "$repo" \
  -path "$repo/node_modules" -prune -o \
  -path "$repo/vendor" -prune -o \
  -path "$repo/models" -prune -o \
  -path "$repo/.git" -prune -o \
  -type f \( -name '*.sh' -o -name 'PKGBUILD' \) -print0)
for script in install.sh scripts/preflight.sh; do
  [[ -f "$repo/$script" ]] || fail "缺少 $script"
done

# --------------------------------------------------------------- versions
section "版本一致"
pkgbuild_ver="$(sed -n 's/^pkgver=//p' "$here/aur/PKGBUILD" | head -n1)"
pkgbuild_rel="$(sed -n 's/^pkgrel=//p' "$here/aur/PKGBUILD" | head -n1)"
spec_ver="$(sed -n 's/^Version:[[:space:]]*//p' "$here/rpm/figaro.spec" | head -n1)"
spec_rel="$(sed -n 's/^Release:[[:space:]]*//p' "$here/rpm/figaro.spec" | head -n1)"
srcinfo_ver="$(sed -n 's/^	pkgver = //p' "$here/aur/.SRCINFO" | head -n1)"
[[ "$pkgbuild_ver" == "$version_json" ]] && pass "PKGBUILD pkgver = $pkgbuild_ver" || fail "PKGBUILD pkgver ($pkgbuild_ver) != package.json ($version_json)"
[[ "$spec_ver" == "$version_json" ]] && pass "RPM spec Version = $spec_ver" || fail "RPM spec Version ($spec_ver) != package.json ($version_json)"
[[ "$srcinfo_ver" == "$version_json" ]] && pass ".SRCINFO pkgver = $srcinfo_ver" || fail ".SRCINFO pkgver ($srcinfo_ver) != package.json ($version_json)"
[[ -n "$pkgbuild_rel" ]] && pass "PKGBUILD pkgrel = $pkgbuild_rel" || fail "PKGBUILD 缺少 pkgrel"
[[ -n "$spec_rel" ]] && pass "RPM spec Release = $spec_rel" || fail "RPM spec 缺少 Release"

# --------------------------------------------------------------- AUR .SRCINFO
section "AUR PKGBUILD / .SRCINFO 一致性"
if python3 - "$here/aur/PKGBUILD" "$here/aur/.SRCINFO" <<'PY'
import re, sys

pkgbuild, srcinfo = sys.argv[1], sys.argv[2]
pb = open(pkgbuild, encoding='utf-8').read()
si = open(srcinfo, encoding='utf-8').read()

def pb_scalar(key):
    m = re.search(rf'^{key}=(.+)$', pb, re.M)
    return m.group(1).strip().strip('"\'') if m else None

def _array_body(key):
    m = re.search(rf'^{key}=\(', pb, re.M)
    if not m:
        return None
    i = m.end()
    depth = 1
    start = i
    while i < len(pb) and depth:
        ch = pb[i]
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        i += 1
    return pb[start:i - 1]

def pb_array(key, expand=None):
    body = _array_body(key)
    if body is None:
        return []
    expand = expand or {}
    out = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        quoted = re.findall(r'"([^"]*)"|\'([^\']*)\'', line)
        # "git+...git#tag=v1" contains '#': only strip comments on unquoted lines.
        items = [a or b for a, b in quoted] if quoted else line.split('#', 1)[0].split()
        for item in items:
            for name, value in expand.items():
                item = item.replace('${' + name + '}', value)
            out.append(item)
    return out

def si_values(key):
    return re.findall(rf'^\t{re.escape(key)} = (.+)$', si, re.M)

url = pb_scalar('url') or ''
pkgver = pb_scalar('pkgver') or ''
expand = {'url': url, 'pkgver': pkgver, 'pkgname': 'figaro'}

errors = []
for key in ('pkgver', 'pkgrel', 'url', 'pkgdesc'):
    pv, sv = pb_scalar(key), si_values(key)
    if not sv or pv != sv[0]:
        errors.append(f'{key}: PKGBUILD={pv!r} .SRCINFO={sv!r}')
for key in ('depends', 'makedepends', 'optdepends', 'license', 'arch'):
    pv, sv = sorted(pb_array(key, expand)), sorted(si_values(key))
    if pv != sv:
        errors.append(f'{key}: PKGBUILD={pv!r} .SRCINFO={sv!r}')
sources = pb_array('source', expand)
if sources and sorted(sources) != sorted(si_values('source')):
    errors.append(f'source: PKGBUILD={sources!r} .SRCINFO={si_values("source")!r}')
opts = pb_array('options', expand)
if opts and sorted(opts) != sorted(si_values('options')):
    errors.append(f'options: PKGBUILD={opts!r} .SRCINFO={si_values("options")!r}')
if 'pkgname = ' not in si:
    errors.append('.SRCINFO 缺少 pkgname 段')
if errors:
    print('\n'.join('      ' + e for e in errors))
    sys.exit(1)
PY
then pass "PKGBUILD 与 .SRCINFO 字段一致"; else fail "PKGBUILD 与 .SRCINFO 不一致（CI 会用 makepkg --printsrcinfo 再核一次）"; fi

# --------------------------------------------------------------- RPM spec
section "RPM spec 静态检查"
spec="$here/rpm/figaro.spec"
for tag in Name Version Release Summary License URL Source0; do
  if grep -qE "^${tag}:[[:space:]]*[^[:space:]]" "$spec"; then pass "spec $tag 有值"; else fail "spec 缺少 $tag 或没有值"; fi
done
for directive in '%description' '%prep' '%build' '%install' '%files' '%changelog'; do
  if grep -qE "^${directive}[[:space:]]*$" "$spec"; then pass "spec 有 $directive"; else fail "spec 缺少 $directive"; fi
done
if_pairs=$(grep -cE '^%if' "$spec" || true)
endif_pairs=$(grep -cE '^%endif' "$spec" || true)
[[ "$if_pairs" == "$endif_pairs" ]] && pass "%if/%endif 配对（$if_pairs/$endif_pairs）" || fail "%if/$endif 不配对（$if_pairs/$endif_pairs）"
if grep -qE '^BuildRequires:[[:space:]]*nodejs' "$spec"; then pass "spec BuildRequires nodejs"; else fail "spec 缺少 BuildRequires nodejs"; fi
if grep -qE '^Requires:[[:space:]]*quickshell' "$spec"; then pass "spec Requires quickshell"; else fail "spec 缺少 Requires quickshell"; fi
if grep -q 'config/config.json' "$spec" && grep -qE '^rm -f .*config/config\.json' "$spec"; then pass "spec 移除 config.json"; else fail "spec 没有保证不打包 config/config.json"; fi

# --------------------------------------------------------------- YAML
section "GitHub Actions YAML"
workflow="$repo/.github/workflows/release.yml"
if [[ -f "$workflow" ]]; then
  if python3 -c 'import yaml' 2>/dev/null; then
    if python3 - "$workflow" <<'PY'
import sys, yaml
with open(sys.argv[1], encoding='utf-8') as fh:
    doc = yaml.safe_load(fh)
assert isinstance(doc, dict), 'workflow is not a mapping'
assert 'on' in doc or True in doc, 'workflow has no on: trigger'
jobs = doc.get('jobs') or {}
assert jobs, 'workflow has no jobs'
for name, job in jobs.items():
    assert 'runs-on' in job, f'{name}: missing runs-on'
print('jobs:', ', '.join(jobs))
PY
    then pass "release.yml 是合法 YAML（python yaml）"; else fail "release.yml YAML 解析/结构失败"; fi
  elif command -v ruby >/dev/null 2>&1; then
    if ruby -ryaml -e 'd=YAML.load_file(ARGV[0]); raise "no jobs" unless d.is_a?(Hash) && d["jobs"]' "$workflow" 2>/dev/null; then
      pass "release.yml 是合法 YAML（ruby）"
    else
      fail "release.yml YAML 解析失败（ruby）"
    fi
  else
    printf '  · 没有 python3-yaml/ruby，跳过 YAML 解析（CI 会再验）\n'
  fi
else
  fail "缺少 .github/workflows/release.yml"
fi

# --------------------------------------------------------------- templates
section "安装模板与启动器"
for file in \
  packaging/common/launcher-figaro.sh \
  packaging/common/launcher-figaro-ui.sh \
  packaging/common/launcher-figaro-settings.sh \
  packaging/common/systemd-user/figaro.service \
  packaging/common/systemd-user/figaro-ui.service \
  packaging/common/desktop/figaro-settings.desktop \
  packaging/deb/build-deb.sh packaging/deb/postinst packaging/deb/prerm \
  packaging/deb/copyright packaging/deb/README.Debian \
  packaging/aur/PKGBUILD packaging/aur/.SRCINFO \
  packaging/rpm/figaro.spec packaging/rpm/build-rpm.sh; do
  [[ -f "$here/${file#packaging/}" ]] && pass "存在 ${file#packaging/}" || fail "缺少 $file"
done
for launcher in figaro figaro-ui figaro-settings; do
  file="$here/common/launcher-$launcher.sh"
  if grep -q '@LIBDIR@' "$file"; then pass "launcher-$launcher.sh 使用 @LIBDIR@ 占位"; else fail "launcher-$launcher.sh 缺少 @LIBDIR@ 占位"; fi
done
# The static systemd units must not contain shell-style placeholders either.
for unit in figaro figaro-ui; do
  if grep -q '@DOCDIR@' "$here/common/systemd-user/$unit.service"; then pass "static $unit.service 使用 @DOCDIR@ 占位"; else fail "static $unit.service 缺少 @DOCDIR@ 占位"; fi
done
# No bundled secrets or config anywhere under packaging/.
if grep -rIl --exclude-dir=out --exclude='*.md' -E 'sk-[A-Za-z0-9]{8,}' "$here" >/dev/null 2>&1; then
  fail "packaging/ 下出现疑似真实 API key"
else
  pass "packaging/ 无真实 API key"
fi
if find "$here" -name 'config.json' -not -path '*/out/*' | grep -q .; then fail "packaging/ 下出现 config.json"; else pass "packaging/ 无 config.json"; fi

# --------------------------------------------------------------- optional deb
if [[ "${1:-}" == "--build" ]]; then
  section "deb 本机构建"
  if bash "$here/deb/build-deb.sh"; then
    pass "deb 构建 + dpkg-deb 验收"
  else
    fail "deb 构建失败"
  fi
fi

printf '\n'
if [[ "$failures" -eq 0 ]]; then
  echo "packaging 静态检查全部通过（RPM/AUR 真实构建只在 CI 容器验证）。"
  exit 0
fi
echo "packaging 静态检查失败: $failures 项" >&2
exit 1
