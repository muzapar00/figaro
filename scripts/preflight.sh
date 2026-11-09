#!/usr/bin/env bash
# Pre-release checks: everything that has to hold before a public push/tag.
# Read-only; exits non-zero when something would embarrass a release.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
fail=0
ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; fail=1; }
warn() { printf '  ! %s\n' "$1"; }

echo "== 1. licences / notices"
for f in LICENSE THIRD_PARTY_NOTICES.md SECURITY.md CONTRIBUTING.md README.md README.zh-CN.md; do
  [[ -f $f ]] && ok "$f" || bad "缺少 $f"
done
grep -q '"license": "GPL-3.0-or-later"' package.json && ok "package.json license" || bad "package.json 缺 license 字段"

# GitHub renders README.md as the landing page: it must be the English one.
if head -6 README.md | grep -q "Figaro · 费加罗"; then
  ok "README.md is the English landing page"
else
  bad "README.md should be the English landing page (Chinese lives in README.zh-CN.md)"
fi

echo "== 2. secrets"
if grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=models \
     -E 'sk-[A-Za-z0-9]{20,}' . 2>/dev/null | grep -vE 'sk-DOCTOR|sk-test|sk-…|placeholder|masked' | grep -q .; then
  bad "工作树疑似真实密钥（见上面 grep）"
else ok "工作树无真实密钥"; fi
if git log -p --all 2>/dev/null | grep -oE 'sk-[A-Za-z0-9]{24,}' | grep -vE '^sk-DOCTOR' | head -1 | grep -q .; then
  bad "git 历史疑似真实密钥"
else ok "git 历史无真实密钥"; fi
[[ -f config/config.json ]] && bad "config/config.json 出现在仓库（应只在本机 ~/.config）" || ok "仓库内无 config.json"

echo "== 3. machine-specific paths"
if grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=models --exclude=nextkde-integration.md \
     -E '/home/[a-z0-9_]+' . 2>/dev/null | grep -vE 'README.md:.*示例' | grep -q .; then
  bad "仍有写死的家目录路径"; grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=models \
     -E '/home/[a-z0-9_]+' . 2>/dev/null | grep -v nextkde-integration.md | head -5
else ok "无写死家目录"; fi
for f in systemd/figaro.service.in systemd/figaro-ui.service.in systemd/figaro-settings.desktop.in; do
  grep -q '@REPO@\|@NODE@\|@QS@' "$f" && ok "模板 $f" || bad "$f 不是模板"
done

echo "== 4. assets that must not ship"
[[ -d models ]] && find models -maxdepth 1 -name '*.onnx' | head -1 | grep -q . && \
  git ls-files models | grep -q . && bad "models/ 有文件被 git 跟踪" || ok "models 未入库"
git ls-files | grep -qE '(^|/)config/config\.json$' && bad "config.json 被跟踪" || ok "config.json 未跟踪"
[[ -f assets/icons/figaro-512.png && -f assets/sfx/listen-start.wav ]] && ok "图标/音效资源在" || bad "图标或音效资源缺失"

echo "== 5. tests"
if node --test "tests/**/*.test.js" >/tmp/figaro-preflight-tests.log 2>&1; then
  tail -3 /tmp/figaro-preflight-tests.log | grep -E '^# (tests|pass|fail)' | sed 's/^/  /'
  ok "测试全绿"
else
  bad "测试失败（见 /tmp/figaro-preflight-tests.log）"
fi

echo
if [[ $fail -eq 0 ]]; then echo "preflight: OK"; else echo "preflight: FAIL"; fi
exit $fail
