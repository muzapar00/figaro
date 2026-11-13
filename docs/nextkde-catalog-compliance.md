# Figaro × NextKDE appCatalog：合规审查与上架方案

调研对象：<https://github.com/NextKde/appCatalog>（2026-11-13 拉取 `main`），以及 NextKde/NextKde
的 `docs/app-store/SignedCatalog.md`、`docs/app-store/IndependentApps.md`、`NextKde/kos-apps`
的 `packaging/flatpak/` 参考实现。

> 本文只记录已核实的事实、明确标注的推断和未知项；结论跟着证据走。上架前每一项都要在
> 一次性 VM/容器里实际验证，不能拿本文代替验收。

## 1. 先说结论

**Figaro 现状不能直接提交 appCatalog。** 目录只实现 Flatpak 应用适配器，而 Figaro 目前是
「原生 systemd 用户服务 + 桌面浮层 + 本机 Node 工具」的系统级助手；要进目录必须另外做一个
**Flatpak 版**，这会改变运行模型并限制功能（见 §5）。在动手重写之前，应先确认两件事：

1. NextKDE 维护者是否接受「常驻后台 + 浮层 + 全局快捷键」这种形态的应用，以及它需要的权限；
2. Flatpak 沙箱内 Quickshell、麦克风、全局快捷键、后台存活、模型解码是否真的可用（未验证）。

## 2. 目录的硬性要求（事实）

| 要求 | 依据 | 对 Figaro 的含义 |
|---|---|---|
| 只收 Flatpak（`format: "flatpak"`，其他 adapter 未实现） | `appCatalog/build_catalog.py` 的 `load_apps()`；README | 不能提交 deb/rpm/AUR/native 包 |
| 应用必须发布一个**非 draft、非 prerelease** 的稳定 `vX.Y.Z` GitHub Release | `RELEASE-CONTRACT.md` | v1.0.0 已有，但没有 Flatpak 资产；需要新版本或补资产 |
| Release 里要有 `.flatpak` bundle + schema 2 的 release manifest（含 SHA-256、OSTree commit、ref、metadata、runtime、installedSize 等） | `RELEASE-CONTRACT.md` | 需要 `flatpak-builder` + `flatpak build-bundle` 产出 |
| bundle 不得内嵌在线 origin / runtime-repo URL | `docs/QtRuntime.md` | `flatpak build-bundle` 不能带 `--repo-url` |
| 运行时使用 `org.kde.Platform` / `org.kde.Sdk`，当前参考分支 6.11 | `docs/QtRuntime.md` | 本机已装 Platform 6.11，缺 SDK；Quickshell 需自行构建 |
| 目录条目 = `apps/<appId>.json` + `icons/<appId>.png` + `releases/<appId>.flatpak-release.json` | `docs/PinnedReleases.md` | 需要 appId、图标、原文 manifest |
| `appId` 必须形如至少三段反向域名，文件名必须等于 `<appId>.json`；`key` 为稳定小写标识 | `build_catalog.py` | 建议 `io.github.muzapar00.Figaro`（尚未向维护者确认） |
| 名称/简介必须有英文回退，支持 en / zh-CN / pt-BR 等 locale；纯文本、无 Markdown | `docs/Localization.md` | 我们已有中英，可补 pt-BR |
| 图标 PNG，≤1024×1024、≤512 KiB，建议 256×256 | `docs/PinnedReleases.md` | `assets/icons/figaro-256.png` 65 KiB，可用 |
| 目录不得携带任意命令/下载 URL | `build_catalog.py`、README | 安装只能走 Flatpak |
| 维护者审查 ownership、identity、permissions、Release 资产；在一次性 VM 测试安装/更新 | `MAINTAINING.md` | 权限说明必须能过审 |
| 官方目录的签名由维护者完成；应用开发者签名可选（`publisher`） | `RELEASE-CONTRACT.md`、`MAINTAINING.md` | 我们不需要自己的 catalog key（除非走第三方源） |
| 第三方源：同一格式，自己的签名 key + 唯一 `sourceId`，用户手动添加信任 | README「Third-party sources」、`MAINTAINING.md` | 可绕开官方 review，但仍是 Flatpak，且用户要手动加源 |

**权限先例（事实）**：已合并的 NkNotes PR #1 在说明里明确写了 “No broad host-filesystem
permission is requested”，只用 portal 做文件选择。这说明维护者会拿窄权限作为默认预期。

## 3. Flatpak 运行时的通用约束（与实现无关的事实）

- 沙箱内的应用不能管理系统级/用户级 systemd 服务；安装/卸载由 Flatpak 负责。
- 宿主文件访问默认不可见/不可写；要读用户文件得显式给 `--filesystem=...`，portal 是推荐路径。
- 要在宿主执行命令需要 `org.freedesktop.Flatpak` 的 `flatpak-spawn --host`，属于宽权限，
  与「窄权限」预期冲突。
- 麦克风/音频需要 `--socket=pulseaudio`（或等价 PulseAudio 兼容路径）；`parec`/`pw-cat`
  这类 CLI 不一定在 `org.kde.Platform` 里，可能要自带。
- 全局快捷键、截图、通知、后台自启可走 `org.freedesktop.portal.*`；KDE portal 对
  GlobalShortcuts / Background / Screenshot 的支持需要在目标会话实测。
- 常驻后台需要应用自己处理生命周期（Background portal + 单实例），目录不会替你安装自启。

## 4. Figaro 现状与差距（事实 + 工量判断）

| 项目 | 现状（证据） | Flatpak 上架影响 |
|---|---|---|
| 运行形态 | Node daemon + Quickshell overlay + Quickshell 设置窗口；systemd user units（`systemd/*.service.in`、`packaging/common/systemd-user/`） | systemd 不可用；需要把 daemon/overlay/settings 的启动、单实例、自启全部换成 Flatpak 内方案 |
| 设置/GUI | Quickshell QML（`settings/`、`qml/`），本机 `qs 0.3.2` | `org.kde.Platform` 不含 Quickshell，需要在 SDK 里构建并打包，QML 模块路径要改写 |
| 本机工具 | `bash` 工具 `spawn('bash', ['-c', ...])`；文件读写、screenshot、Home Assistant 等 | 沙箱内 bash 只能跑 bundle 内命令，不能操作宿主；除非降级工具或申请宽权限 |
| 麦克风/音频 | 用 `parec` 采集、`pw-cat`/PipeWire 播放，按当前本机路径找 CLI | 需要 bundle 音频 CLI 或用 portal/库替换，并验证 PulseAudio socket |
| 唤醒/热键 | 常驻 KWS + 全局快捷键（KDE portal / 原生） | 需要实测 sandbox 下 GlobalShortcuts portal 与常驻采集 |
| 浮层 | Quickshell layer-shell + 可选 KWin 液态玻璃 | layer-shell 走 Wayland socket，可能可用；KOS 玻璃在沙箱内没有，需退回半透明（已有回退） |
| 模型 | `models/` 约 539 MB（离线 ASR 两份 233+229 MB，KWS/VAD/speaker 等） | bundle 会很大（目录上限字段 2 GiB）；也可运行时下载，但首次离线不可用，需在 PR/说明里讲清 |
| Node | 需要 Node ≥ 22 + `sherpa-onnx-node` 原生模块 | Node 官方二进制/自建 Node 需进 bundle；原生模块与 SDK glibc/架构要实测 |
| RAG | 外部 Python LightRAG 服务（`docs/rag.md`） | Flatpak 版不能自动带起该服务；要么关闭 RAG，要么让用户单独安装原生服务 |
| 元数据 | 有 desktop entry 和图标，但**没有 AppStream metainfo** | Flatpak/商店审核通常需要 `metainfo.xml`，需补 |
| 隐私 | `docs/privacy.md`、无遥测、key 本机 600 | 对目录不是硬性要求，但应写进 PR 的权限/隐私说明 |
| 许可证 | GPL-3.0-or-later；Quickshell/Node/sherpa 等第三方许可需随 bundle 携带声明 | 需要 bundle 内 `THIRD_PARTY_NOTICES`/licenses |

**工量判断（推断）**：Flatpak 版不是加一个 manifest 就完了，至少要完成：
Quickshell + Node + 原生模块在 SDK 内构建；音频 CLI/portal 替换；启动/单实例/后台生命周期；
模型策略；权限收敛；AppStream/desktop/icon；release manifest 生成；CI 构建与 VM 验收；
catalog PR。属于「多阶段移植」，不是一两次提交。

## 5. 两条可选路线

### 路线 A：官方 appCatalog 的「受限 Flatpak 版」

保留：唤醒、ASR、LLM、TTS、浮层、设置、portal 截图/快捷键、Home Assistant、网络。
砍掉或降级：宿主 `bash` 工具、任意宿主文件读写、原生 systemd、本机 RAG 服务（或改成可选原生 sidecar）、
KWin 玻璃（退回半透明）。
权限只申请：wayland/ipc/dri、pulseaudio、network、portal（截图/快捷键/后台/通知）、必要时
窄范围 `xdg-*` 目录；不申请 `--filesystem=host` 和 `org.freedesktop.Flatpak`。

风险：维护者可能认为「常驻助手」不属于目录的 GUI 应用范围，或认为 portal 快捷键/后台自启
在目标桌面不可靠；功能与原生版不一致，需要明确标注「NextKDE/Flatpak 版」。

### 路线 B：第三方源（自己的签名目录）

同一套 Flatpak 版，但不需要官方 review；用户按 appCatalog README 的 third-party source 方式
手动添加 sourceId、仓库、公钥指纹。仍需自己维护签名 key、递增 sequence、30 天过期续签。

适合「先让愿意折腾的用户用上」，但门槛高、用户少，且不能解决 Flatpak 功能限制。

### 路线 C：不投商店，做原生 + NextKDE UI 集成

保留 deb/rpm/AUR 原生包和现有 systemd 模型；把设置窗口按 Kos.Ui 重写/适配（此前
`docs/nextkde-integration.md` 已调研）。这不是「上架」，但技术风险最低、功能完整。

### 路线 D：先问维护者，再决定

在 appCatalog 开 issue/discussion，附本文 §4 的架构事实，问：
1. 常驻后台 + 浮层 + 全局快捷键的助手类应用是否属于目录范围；
2. 若走 Flatpak，允许的权限边界（麦克风、portal、后台自启、模型下载）；
3. 是否接受「相比原生版功能受限」的 NextKDE 版。

成本最低、决策依据最强；在得到答复前不建议投入完整移植。

## 6. 若继续推进，需要补的合规清单

- [ ] 确认 appId（建议 `io.github.muzapar00.Figaro`）与 GitHub 仓库归属，检查与既有 ID 冲突。
- [ ] 应用内 AppStream metainfo（`<appId>.metainfo.xml`）+ desktop entry + 图标按 appId 命名。
- [ ] Flatpak manifest：`org.kde.Platform/Sdk//6.11`，Quickshell、Node、sherpa 原生模块、
     音频 CLI 的构建/打包；`flatpak build-bundle` 不带 origin/runtime URL。
- [ ] 权限清单与理由（逐项写进 PR）：音频、wayland、网络、portal、必要的窄目录；不出现
     host filesystem / flatpak-spawn。
- [ ] 首次启动/离线启动/升级/卸载保留数据/模型下载的 VM 验收记录。
- [ ] GitHub stable Release（新版本号）附带 `.flatpak`、release manifest、SHA-256、来源提交。
- [ ] catalog PR：`apps/<appId>.json`、`icons/<appId>.png`、`releases/<appId>.flatpak-release.json`，
      跑 `python3 build_catalog.py --check` 与 `python3 -m unittest discover -s tests`。
- [ ] catalog 本地化：名称/简介 en（必需）+ zh-CN + 可选 pt-BR；纯文本、长度限制。
- [ ] 第三方许可与隐私说明随包/PR 提供。

## 7. 本机环境核实（2026-11-13）

- `flatpak 1.18.4` 已安装；`org.kde.Platform/x86_64/6.11` 已安装（1.1 GB）。
- **缺** `flatpak-builder` 与 `org.kde.Sdk//6.11`；磁盘剩余约 190 GB。
- `qs 0.3.2` 可用；Node v24.22.2；`models/` 539 MB；`node_modules/` 33 MB。
- 尚无 Flatpak manifest、AppStream metainfo、Flatpak CI 产物；v1.0.0 Release 只有 deb/rpm/AUR。

## 8. 建议

先走 **路线 D**（1 个 issue 的成本，决定后面几天的方向），同时只做不承诺功能的
**可行性 spike**：在本机装 SDK + flatpak-builder，构建一个最小 Flatpak（Quickshell 窗口 +
Node 读一个本地配置），验证「能不能启动、能不能看到 Wayland 窗口」；麦克风/快捷键/后台
存活/模型解码再逐项验证。spike 通过且维护者认可后，再决定 A 还是 B，并按 §6 补齐全套合规。
