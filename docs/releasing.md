# 发布清单

仓库：<https://github.com/muzapar00/figaro>（GPL-3.0-or-later）

## 一次发布要做的事

1. **自检**
   ```bash
   bash scripts/preflight.sh      # 协议文件、密钥、机器路径、模型未入库、测试
   figaro doctor                  # 本机运行状态（有 ✗ 先修）
   ```
2. **双语 README**：`README.md`（English，GitHub 首页默认渲染它）与 `README.zh-CN.md`（中文）内容同步，语言切换链接都在顶部。
3. **版本号**：`package.json` 的 `version` 与 `CHANGELOG.md` 顶部一致；
   `systemd` 模板与 `README` 里的版本引用若出现也同步。
4. **提交**（提交信息用 `feat(scope): …`，正文英文，勿加 AI 署名）：
   ```bash
   git add -A && git commit -m "release: vX.Y.Z"
   ```
5. **打 tag 并推送**：
   ```bash
   git tag -a vX.Y.Z -m "费加罗 vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```
6. **GitHub Release**：从 tag 生成，标题 `费加罗 vX.Y.Z`，正文用 CHANGELOG 该版本段落；
   附加：`docs/images/hero.jpg` 与 `settings-grid.jpg` 作为 Release 图片，说明"模型需运行 `scripts/fetch-models.sh`"。
7. **发布后**：在 README 徽章处确认 tests/版本号；新 issue 模板可选。

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

## v1.0.0 起：Linux 打包与发布附件

v1.0.0 开始，Release 除源码外还提供 deb / rpm / AUR 打包资产，由 GitHub Actions 在 tag 上自动构建
（见 `.github/workflows/release.yml`）。发布前确认：

1. `package.json` 版本 = 1.0.0，`CHANGELOG.md` 有 v1.0.0 段落；
2. `bash scripts/preflight.sh` OK，全量测试绿；
3. 本地至少构建一次 deb（`packaging/deb/build-deb.sh`）并检查 `dpkg-deb -c` 布局；
4. CI 的 deb/rpm/AUR 三个 job 全绿（rpmbuild / makepkg 只在容器里验证）；
5. 安装包内**不含** `models/`、`config.json`、家目录路径、API key；
6. Release 正文用 `docs/v1.0.0-release-notes.md`，附件含 `figaro_1.0.0_amd64.deb`、
   `figaro-1.0.0-*.rpm`、`PKGBUILD`/`.SRCINFO`（或 AUR 源码包）；
7. 发布后回查 AUR 版本、README 徽章、Release 可下载。

打包目录约定：

```
packaging/
  common/        共享的安装布局/文件清单
  deb/           build-deb.sh + DEBIAN 控制文件
  rpm/           figaro.spec
  aur/           PKGBUILD / .SRCINFO
  validate.sh    本机可跑的静态校验（bash -n / YAML / 布局）
```

用户级安装：deb/rpm 只装系统文件；用户首次运行 `figaro install-user`（或设置 GUI 引导）完成
QML、systemd user units、desktop、config 脚手架的安装。源码安装仍用 `./install.sh`。
