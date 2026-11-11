# Figaro packaging

One program tree, one user-level install command, three package formats.
Everything here is built from the tagged release tree; nothing downloads or
bundles the speech models and no config/API key is ever packaged.

| 路径 | 说明 |
|---|---|
| `deb/build-deb.sh` | 本机构建 `out/figaro_<version>_<arch>.deb`（`dpkg-deb --build --root-owner-group`，临时目录，无 sudo），随后用 `dpkg-deb -I/-c` 验收：必需文件、控制字段、无构建机家目录路径、无 `models/`、无 `config/config.json` |
| `deb/{postinst,prerm}` | 只刷新图标/desktop 缓存并打印「运行 `figaro install-user`」；用户服务不由 root 安装/启动 |
| `deb/{copyright,README.Debian}` | Debian 版权（DEP-5）与安装/卸载说明 |
| `common/launcher-*.sh` | `/usr/bin/{figaro,figaro-ui,figaro-settings}` 模板：运行时找 node/qs，`@LIBDIR@`/`@DOCDIR@` 由各包构建时替换，因此包内没有构建机路径 |
| `common/systemd-user/*.service` | 机器无关的静态 user units（`/usr/lib/systemd/user`）；真正的用户级 units 由 `figaro install-user` 按当前会话渲染到 `~/.config/systemd/user` |
| `common/desktop/figaro-settings.desktop` | 系统级桌面入口（`Exec=/usr/bin/figaro-settings`，首次启动会补做用户级安装） |
| `aur/{PKGBUILD,.SRCINFO}` | AUR：`source=git+…#tag=v$pkgver`；`.SRCINFO` 必须与 `makepkg --printsrcinfo` 一致 |
| `rpm/figaro.spec` | Fedora/openSUSE 通用 spec；`rpm/build-rpm.sh` 用 `git archive` 从 tag 生成源码包后调用 `rpmbuild` |
| `validate.sh` | 本地与 CI 的静态检查（见下） |
| `../.github/workflows/release.yml` | tag `v*`：测试 → deb / rpm / AUR 构建 → GitHub Release assets + SHA256SUMS |

## 本机可验证 / 只在 CI 验证

- **本机验证**（Ubuntu 26.04, node 24, 无 sudo）：
  - `bash packaging/deb/build-deb.sh`：生成 `figaro_1.0.0_amd64.deb`，`dpkg-deb -I/-c` 通过；
  - `bash packaging/validate.sh`：shell 语法、版本一致、PKGBUILD↔`.SRCINFO`、
    RPM spec 结构、release.yml YAML、启动器占位符；
  - `node --test tests/agent/*.test.js`、`node --test tests/cli/doctor.test.js`；
  - 从 deb 解包到临时目录，用假 `HOME` 跑 `figaro install-user`（包布局语义）。
- **只在 CI 验证**：`rpmbuild -ba`（Fedora 容器）、`makepkg --printsrcinfo` + `makepkg -f
  --nodeps`（Arch 容器）、`lintian`/`namcap`（informational）、软链 Release 上传。
  本机没有 `rpmbuild`/`makepkg`，按任务约定如实标注，不伪造本地通过。

## 本地命令

```bash
# deb（推荐先跑这个）
bash packaging/deb/build-deb.sh
dpkg-deb -c packaging/deb/out/figaro_1.0.0_amd64.deb | head
dpkg-deb -I packaging/deb/out/figaro_1.0.0_amd64.deb

# 静态校验（CI 的 test job 也跑它）
bash packaging/validate.sh
bash packaging/validate.sh --build      # 静态校验 + deb 构建

# RPM / AUR（有 rpmbuild / makepkg 的机器上）
bash packaging/rpm/build-rpm.sh
cd packaging/aur && makepkg --printsrcinfo > .SRCINFO && makepkg -f
```

## 安装后的用户级步骤（deb/rpm/AUR 都一样）

```bash
figaro install-user        # QML、systemd user units、config 脚手架、桌面图标（幂等）
# 或直接点应用菜单里的「费加罗」：首次启动自动完成并打开设置面板
figaro doctor
```

`install-user` 绝不覆盖已有的 `~/.config/figaro/config.json`；包布局下
（`/usr/lib/figaro` 只读）模型目录固定为 `~/.local/share/figaro/models`，
并写进配置脚手架的 `asr.kwsModelDir` 等绝对路径。模型由
`scripts/fetch-models.sh` 在运行时下载（地区镜像由 llm-region 负责）。
