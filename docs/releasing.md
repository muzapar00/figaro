# 发布清单

仓库：<https://github.com/muzapar00/figaro>（GPL-3.0-or-later）

## 一次发布要做的事

1. **自检**
   ```bash
   bash scripts/preflight.sh      # 协议文件、密钥、机器路径、模型未入库、测试
   figaro doctor                  # 本机运行状态（有 ✗ 先修）
   ```
2. **版本号**：`package.json` 的 `version` 与 `CHANGELOG.md` 顶部一致；
   `systemd` 模板与 `README` 里的版本引用若出现也同步。
3. **提交**（提交信息用 `feat(scope): …`，正文英文，勿加 AI 署名）：
   ```bash
   git add -A && git commit -m "release: vX.Y.Z"
   ```
4. **打 tag 并推送**：
   ```bash
   git tag -a vX.Y.Z -m "费加罗 vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```
5. **GitHub Release**：从 tag 生成，标题 `费加罗 vX.Y.Z`，正文用 CHANGELOG 该版本段落；
   附加：`docs/images/hero.jpg` 与 `settings-grid.jpg` 作为 Release 图片，说明"模型需运行 `scripts/fetch-models.sh`"。
6. **发布后**：在 README 徽章处确认 tests/版本号；新 issue 模板可选。

## 首次推送到 GitHub

```bash
# 已配置好远端与身份（muzapar00 <mzpr00@163.com>）
git push -u origin main
```

仓库名若不用 `figaro`，先改远端：`git remote set-url origin https://github.com/muzapar00/<name>.git`，
并同步 `package.json`（homepage/repository/bugs）、README 的 clone 地址、`docs/releasing.md`。

## 不要提交的东西

`config/config.json`（真实密钥）、`models/`（模型）、`node_modules/`、`settings/test/out/*.log|json|csv`
（含本机路径，由 `settings/test/shoot.sh` 本地生成；截图可以提交）。
