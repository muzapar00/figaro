# 与 NextKDE 的关系：调研结论与移植计划

调研对象：`https://github.com/NextKde/nextkdeAppDemo`（2026-11-09 克隆 `--depth 1` 阅读）。

## 它是什么（事实）

| 事实 | 依据 |
|---|---|
| 它是**可移植 Qt Quick 组件库 + 示例应用**，不是"应用商店/加载器" | `README.md`：Reusable Qt Quick liquid components, an interactive component Gallery, and a complete sidebar layout demo |
| 组件本体在 `shared/qml`，导出为静态 QML 模块 `Kos.Ui`（CMake 目标 `Kos::Ui` / `Kos::UiPlugin`） | `docs/Architecture.md` 的 Source boundaries 表；`CMakeLists.txt` |
| demo 宿主用 Quickshell 开普通窗口：`qs -p demo/gallery.qml` 等 | `README.md`「Open a demo」 |
| 组件**禁止**依赖 Quickshell / KWin / Wayland 协议 / NextKde 服务；Quickshell 只允许出现在 demo 宿主 | `AGENTS.md`、`docs/Architecture.md` |
| 不用 KWin 模糊，视觉靠烘焙 shader + QML 多层模糊；shader 需要 GPU 后端 | `README.md`「The visual components use QML and baked shaders… do not request KWin blur」 |
| 运行依赖：Quickshell、Qt Quick + Controls、Qt5Compat.GraphicalEffects、Qt SVG；**Qt 6.8+** | `README.md` |
| 有一个完整的原生示例应用 `examples/native-notes`（C++ + QML + i18n + 测试） | `examples/native-notes/` |
| 没有 CI；"source release"≠运行时/GPU 验收 | `docs/Architecture.md` 的 Change and verification policy |

## 结论（推断）

**这个仓库不是"装载费加罗"的地方，而是 NextKDE 应用的 UI 标准件与应用骨架。** 更准确的说法是：

- **适合搬进去的**：费加罗的**设置/控制窗口**（以及将来可能的托盘/面板小部件）——用 `Kos.Ui` 的 `SettingsGroup`/`SettingsItem` 等组件重写，作为 NextKDE 生态里的一个普通应用（`qs -p <path>` 或 native-notes 那样的应用）。
- **不适合搬进去的**：费加罗的**后台大脑**（Node daemon、DeepSeek 工具循环）和**桌面浮层**（Quickshell layer-shell + KWin 液态玻璃）。它们本质上是"跨应用的桌面代理"，不是可移植组件；而且该仓库明确禁止组件依赖 KWin/Wayland 协议。
- 因此目标形态应是：**NextKDE 应用（可移植设置/控制 UI） ↔ IPC ↔ Figaro daemon（每台机器本地运行）**。daemon 作为 sidecar 存在，UI 可以在任何有 Quickshell + Qt 的桌面上跑。

## 我们当前离"任何 Quickshell 设备都能跑"的差距（事实 + 处理）

| 差距 | 现状 | 处理 |
|---|---|---|
| KOS 液态玻璃是硬依赖 | 之前 `FigaroCapsule.qml` 直接 `import Kos.SurfaceShape`，没有该插件的机器整个 overlay 加载失败 | **已修**：抽到 `qml/figaro/FigaroGlass.qml`，用 `Loader` 加载；缺失时只打一行日志并退回半透明底色（真机验证过两种情形） |
| 设置窗口重复标题栏 | 应用自绘 macOS 红黄绿 + KWin 系统装饰 | 已用 KWin 规则解决（KDE 上）；非 KDE 桌面无系统装饰时天然只有一套，规则文件留在 `~/.config/kwinrulesrc` 不影响别的桌面 |
| systemd 用户服务与绝对路径 | unit 里 `ExecStart=/home/mzpr00/.local/bin/qs`、`%h/.config/quickshell/kos` | 安装脚本里应生成 unit（用 `%h` 而不是写死用户名）；`QML2_IMPORT_PATH` 缺失已无害 |
| 麦克风增益写死 ALSA card 0 | `amixer -c 0`（这台机器） | 需要按 `pactl`/`arecord -l` 自动发现，或允许 `asr.alsaCard` 配置覆盖 |
| Node 运行时 | 需要 Node ≥22（sherpa-onnx-node 是 linux-x64 原生模块） | NextKDE 机器上不一定有；安装脚本要检查并给出提示，或打包 |
| 网络依赖 | DeepSeek（对话）+ MiniMax（语音）需要 key | 与 NextKDE 无关，属于费加罗自身服务 |
| 视觉风格 | 我们的设置窗口是自绘 macOS 风，不是 `Kos.Ui` | 二期移植时用 `Kos.Ui` 重写设置页即可；组件库要求"不要为 demo 另造实现"，我们应直接消费 `shared/qml` |

## 建议的移植路径（分阶段）

1. **阶段一（现在可做）**：保证费加罗本身可移植——玻璃可选（已做）、路径去硬编码、`qs -p` 可直接跑设置窗口。
2. **阶段二**：在费加罗仓库里加 `nextkde/` 目录：一个 `settings.qml`（`qs -p` 入口）+ `Kos/Ui` 源映射，用 `Kos.Ui` 组件重写外观/API/识别/诊断页；保持现有自绘版本作为 `kde` 风格可选。
3. **阶段三**：把 `nextkde/` 作为示例应用提交给上游（类似 `examples/native-notes`），同时把"可选合成器玻璃适配器"作为独立可选模块（不放进可移植组件）。
4. **阶段四**：daemon 以 D-Bus/本地 socket 暴露，UI 只依赖 IPC；这样 NextKDE 应用与费加罗 daemon 可独立打包。

## 未知/待确认

- NextKDE 上游是否希望接收"应用示例"还是只收组件改动（`AGENTS.md` 说"App business logic 归应用自己"）。
- 他们的 `Kos.Ui` 版本策略：应用要 pin 具体 release commit，我们移植时要固定版本。
- 非 KDE Wayland 合成器上没有 KWin 液态玻璃，胶囊观感会退化为半透明底——是否需要给移植版单独做一套"无 KWin"材质（组件库的 shader 材质可以复用）。
