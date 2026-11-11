# 平台支持矩阵 / Platform support

Figaro 1.0.0 · 最后更新 2026-11-11

Figaro 的 UI 是 [Quickshell](https://github.com/quickshell-mirror/quickshell) 写的 **Wayland overlay**
（`wlr-layer-shell` 表面），守护进程本身只是 Node。因此「能不能用」分三层：

1. **语音 + CLI**（守护进程、唤醒词、ASR、DeepSeek、TTS）：只要 Linux + PipeWire + Node 就能用；
2. **overlay / 设置面板**：需要 Quickshell 和 `wlr-layer-shell`；
3. **桌面特效与集成**（KWin 液态玻璃、KWin 无边框规则、全局热键 portal、截图后端）：按桌面逐项降级。

本文件是 `figaro doctor`、deb/rpm/AUR 包说明和 `packaging/` 的共同参考。

---

## 1. 支持等级

| 桌面 / 会话 | 等级 | 语音+CLI | overlay | 液态玻璃 | 截图工具 | 全局热键 |
|---|---|---|---|---|---|---|
| **KDE Plasma 6 Wayland**（Kubuntu / KDE neon / Arch KDE） | ✅ **正式支持** | ✅ | ✅ | ✅（装了 KOS 才有真玻璃，否则半透明） | spectacle → portal | ✅ portal（XDG GlobalShortcuts）+ KDE 快捷键 |
| **Hyprland** | 🟡 社区可跑，待测试 | ✅ | ✅（layer-shell） | ❌ 半透明回退 | grim → portal | ✅ portal（需 portal-hyprland / xdg-desktop-portal-hyprland） |
| **sway** | 🟡 社区可跑，待测试 | ✅ | ✅（layer-shell） | ❌ 半透明回退 | grim → portal | 🟡 portal 取决于 xdg-desktop-portal-wlr 版本 |
| 其他 wlroots 合成器（niri / river / wayfire / labwc） | 🟡 未测试 | ✅ | 预期 ✅ | ❌ 半透明回退 | grim → portal | 🟡 取决于 portal 后端 |
| **GNOME Wayland** | ❌ **不支持 overlay** | ✅ | ❌ Mutter 没有 `wlr-layer-shell` | — | portal / gnome-screenshot | ✅ portal（GNOME 的实现） |
| **X11**（任意桌面） | ❌ **不支持 overlay** | ✅ | ❌ Quickshell 仅 Wayland | — | portal / scrot | 🟡 取决于 portal |
| Flatpak / AppImage / Snap | ❌ 不推荐（见 §6） | — | — | — | — | — |

「语音+CLI」= `figaro ask/say/talk/status/doctor/enroll-voice`，以及 `systemd --user` 的 `figaro.service`。
只需要 Node ≥ 22、PipeWire（`parec`/`pw-cat`）和一份 `~/.config/figaro/config.json`。

---

## 2. 各层依赖与回退

| 能力 | KDE | 非 KDE Wayland | GNOME Wayland | 缺失时 |
|---|---|---|---|---|
| overlay 表面 | layer-shell（KWin） | layer-shell（wlroots） | ❌ | `figaro-ui.service` 不启用；语音/CLI 照常 |
| 液态玻璃 | KOS `Kos.SurfaceShape` | 自动跳过 KOS Loader | 同左 | `FigaroCapsule` 用半透明背景；**这不是错误**，`figaro doctor` 只报「未安装」信息项 |
| 设置窗口无边框 | KWin 规则（`~/.config/kwinrulesrc`） | 不需要 | 不需要 | 多一条系统标题栏，仅外观 |
| 截图后端 | spectacle（优先） | grim → xdg-desktop-portal | portal → gnome-screenshot | `figaro doctor` 会给出对应安装命令 |
| 全局热键 | XDG GlobalShortcuts portal | 同左 | 同左 | 语音唤醒仍可用；`figaro doctor` 检查绑定 |
| 桌面入口/图标 | hicolor + `.desktop` | 同左 | 同左 | 可手动 `figaro settings` / `figaro install-user` |
| 长期记忆 RAG（可选） | LightRAG 本地服务 | 同左 | 同左 | 自动降级为无记忆对话 |

截图后端顺序（`src/agent/tools/screen.js`）：`spectacle` → `grim` → `xdg-desktop-portal`
（通过 `gdbus` 调用 Screenshot，Wayland 通用）→ `gnome-screenshot` → `scrot`。
最终失败会给出中文错误、已尝试的后端列表和当前桌面的安装建议。

---

## 3. 安装方式支持状态

| 方式 | 状态 | 本机验证 | CI 验证 | 备注 |
|---|---|---|---|---|
| **deb**（Ubuntu 26.04 / Kubuntu / KDE neon，amd64） | ✅ 可构建 | ✅ `packaging/deb/build-deb.sh` + `dpkg-deb -c`（Ubuntu 26.04, node 24） | ✅ ubuntu-latest 构建 | `quickshell` 不在 Ubuntu 官方源，放 `Recommends`；其余依赖见 `dpkg-deb -I` |
| **AUR**（Arch，x86_64） | ✅ 包资产已随 release | ⚠️ 本机无 `makepkg`，只做静态检查 | ✅ Arch 容器 `makepkg --printsrcinfo` + `makepkg -f --nodeps` | **尚未推送到 AUR**（需维护者账号）；可下载 release 里的 `*.pkg.tar.zst`/`PKGBUILD`；`quickshell` 来自 AUR；模型运行时下载 |
| **rpm**（Fedora / openSUSE Tumbleweed，x86_64） | ✅ spec 就绪 | ⚠️ 本机无 `rpmbuild`，只做静态检查 | ✅ Fedora 容器 `rpmbuild -ba --nodeps` | `quickshell` 不在 Fedora/SUSE 官方源，安装时需自行提供 |
| 源码 checkout + `./install.sh` | ✅ 正式支持 | ✅ | ✅ 测试套件 | 即 `npm install` + `figaro install-user` |
| Flatpak / AppImage / Snap | ❌ 不推荐 | — | — | 见 §6 |

所有安装方式共用同一套用户级安装逻辑：**`figaro install-user`**（deb/rpm 之后运行，
或点应用菜单「费加罗」首次启动自动完成）。系统包只装 `/usr` 下的程序树；
QML 在 `~/.config/quickshell/`、units 在 `~/.config/systemd/user/`、模型在
`~/.local/share/figaro/models/`，都由普通用户写入，**不需要 sudo**。

包布局（deb：`/usr/lib/figaro`；rpm：`%{_libdir}/figaro`，即 Fedora 的 `/usr/lib64/figaro`）：

```
/usr/bin/{figaro,figaro-ui,figaro-settings}          启动器（运行时找 node/qs，无构建机路径）
/usr/lib{,64}/figaro/{bin,src,node_modules,scripts,qml,settings,systemd,assets,config,package.json}
/usr/lib/systemd/user/{figaro,figaro-ui}.service     机器无关的静态 units
/usr/share/applications/figaro-settings.desktop
/usr/share/icons/hicolor/<size>x<size>/apps/figaro.png
/usr/share/doc/figaro/...
```

**不捆绑**：模型（`scripts/fetch-models.sh` 按地区镜像运行时下载，见 llm-region 说明）、
任何 API key、真实 `config.json`。

---

## 4. 依赖（按发行版）

运行时：

- Node.js ≥ 22（`nodejs`）
- PipeWire（`pipewire` + `pipewire-pulse`/`wireplumber`，提供 `parec`、`pactl`、`pw-cat`）
- `xdg-desktop-portal` + 桌面后端（`xdg-desktop-portal-kde` / `-wlr` / `-hyprland` / `-gnome`）
- Quickshell（`qs`）：KDE 用户可从 AUR/发行版包、或 [quickshell](https://github.com/quickshell-mirror/quickshell) 自行构建
- 可选：`spectacle`（KDE 截图）、`grim`（wlroots 截图）、`ffmpeg`（`view_image`）、
  `curl`+`tar`+`bzip2`（下载模型）、`python`（可选 LightRAG 记忆服务）

常用安装命令：

```bash
# Debian/Ubuntu（deb 会带起大部分依赖）
sudo apt install nodejs pipewire xdg-desktop-portal xdg-desktop-portal-kde spectacle ffmpeg
# Arch
sudo pacman -S nodejs pipewire xdg-desktop-portal xdg-desktop-portal-kde spectacle ffmpeg
yay -S quickshell   # 或 quickshell-git
# Fedora
sudo dnf install nodejs pipewire xdg-desktop-portal xdg-desktop-portal-kde spectacle ffmpeg-free
```

`figaro doctor` 会逐项检查 OS/桌面/会话类型/layer-shell/Quickshell/portal/PipeWire/
模型目录/截图后端，并打印可复制的安装命令。

---

## 5. 在非 KDE 桌面上的测试步骤

想在 Hyprland / sway 上验证（欢迎回报结果）：

```bash
# 1. 先只用语音 + CLI（与桌面无关）
git clone https://github.com/muzapar00/figaro.git && cd figaro
npm install && bash scripts/fetch-models.sh
./install.sh --no-ui          # 只装 daemon，不启用 overlay
figaro doctor                 # 看「桌面能力」组：layer-shell 应显示可用（wlroots）
figaro ask "现在几点？用 bash 看一下"

# 2. 再试 overlay
figaro install-user           # 不带 --no-ui；会渲染并启用 figaro-ui.service
journalctl --user -u figaro-ui -n 50 --no-pager
# 期望日志: [figaro] desktop=Hyprland session=wayland glass=translucent-fallback

# 3. 检查回退
figaro ask "看一下我的屏幕"    # 截图应走 grim 或 portal；doctor 会列出后端
systemctl --user status figaro figaro-ui
```

已知差异（预期行为，不是 bug）：

- 没有 KOS：`figaro doctor` 的「液态玻璃」是 `·` 信息项，overlay 半透明；
- 没有 KWin：不会装 KWin 无边框规则，设置窗口有系统标题栏；
- GNOME：`layer-shell` 与 overlay 会报 ✗/!；用 `./install.sh --no-ui` 或
  `systemctl --user disable --now figaro-ui` 关掉 overlay，语音/CLI 照常；
- X11：overlay 无法显示（Quickshell 仅 Wayland），截图走 portal/scrot。

回报问题时请附：发行版与版本、`echo "$XDG_SESSION_TYPE $XDG_CURRENT_DESKTOP"`、
`figaro doctor --json` 的「桌面能力」段（不含密钥）、`journalctl --user -u figaro-ui -n 80`。

---

## 6. 为什么不做 Flatpak / AppImage / Snap

不是「以后再说」，是这套程序模型与沙箱/便携格式冲突：

- **系统级工具**：Figaro 的 agent 工具要读写用户文件、跑 `bash`、截屏、控制音频。
  Flatpak/Snap 的沙箱把这些限制在沙箱内，工具会「看起来坏了」；要在宿主机执行必须
  开大量 portal/权限，等于放弃沙箱的意义。
- **systemd user units**：`figaro.service` / `figaro-ui.service` 是用户级 systemd 服务，
  Flatpak/Snap 不能可靠地安装并管理它们（Snap 需要 snapd 接口，Flatpak 需要
  `--user` 额外机制）；AppImage 根本没有安装步骤。
- **Quickshell + layer-shell**：overlay 需要与合成器直接交互。沙箱内的 Quickshell 拿不到
  宿主合成器的 layer-shell 表面；打包 Quickshell 及其 QML 依赖会显著放大体积与 ABI 风险。
- **用户级 QML/config**：`~/.config/quickshell/figaro*` 与 `~/.config/figaro/config.json`
  必须由真实用户目录提供，`figaro install-user` 才能在升级时同步；三种格式都不擅长这件事。
- **原生 Node 依赖**：`sherpa-onnx-node` 带按平台编译的 `.node`/`.so`（bundled
  onnxruntime），Flatpak 还需要为 runtime 内的 glibc/libstdc++ 重新验证 ABI。

推荐路径就是 §3 的四种：**deb / AUR / rpm / 源码**。若需要「免安装试用」，
用源码 checkout（`npm install` 即可，不需要 root），或在容器里跑 CLI 部分。

---

## 7. 打包相关文件

| 文件 | 用途 |
|---|---|
| `packaging/deb/build-deb.sh` | 本机构建 `out/figaro_<version>_<arch>.deb` 并用 `dpkg-deb -I/-c` 验收 |
| `packaging/deb/{postinst,prerm,copyright,README.Debian}` | Debian 维护者脚本与文档 |
| `packaging/aur/{PKGBUILD,.SRCINFO}` | AUR 包（git tag v1.0.0 源） |
| `packaging/rpm/{figaro.spec,build-rpm.sh}` | Fedora/openSUSE spec 与本地助手 |
| `packaging/common/**` | 三种包共用的启动器、静态 units、desktop 模板 |
| `packaging/validate.sh` | 本地/CI 静态校验（版本一致、`.SRCINFO` 一致、spec 结构、YAML、启动器占位符） |
| `.github/workflows/release.yml` | tag `v*` 触发：deb / rpm / AUR 构建 + Release assets |
