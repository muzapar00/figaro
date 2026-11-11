# Third-party notices

费加罗（Figaro）以 GPL-3.0-or-later 发布（见 `LICENSE`）。下面是它复用、链接或依赖的第三方作品，
以及各自的要求。发布二进制或源码时必须保留本文件。

## 运行时依赖（用户自行安装，不随仓库分发）

| 组件 | 版本/来源 | 许可 | 说明 |
|---|---|---|---|
| Quickshell | 0.3.x，https://github.com/quickshell-mirror/quickshell | **LGPL-3.0** | 浮层与设置窗口的宿主。我们分发的是独立 QML 配置（独立程序），不是 Quickshell 的衍生作品，因此本仓库可按 GPL-3 许可；用户可自行替换/升级 Quickshell 二进制。 |
| Qt 6 | qt.io | LGPL-3.0 / GPL-3.0（双许可） | 由 Quickshell 链接。 |
| PipeWire / wireplumber | 系统包 | MIT | 音频播放（`pw-cat`）。 |
| KDE Plasma / KWin | 系统包 | GPL/LGPL | 可选：液态玻璃由 KWin 的 KOS 插件绘制，缺失时自动退化（见 `qml/figaro/FigaroGlass.qml`）。 |

## 随仓库分发的第三方代码

| 作品 | 文件 | 许可 |
|---|---|---|
| siriwave（Siri 波形算法） | `qml/figaro/SiriWave.qml`（从 TypeScript 重实现为 QML Canvas） | **MIT**，Copyright (c) 2020 Flavio Maria De Stefano — 完整声明见 `qml/THIRD_PARTY_NOTICES.md` |
| Apple Intelligence animation | 仅作视觉参考（`qml/figaro/shaders/`），**未复制代码** | — |
| 音效 | `assets/sfx/*.wav` 由本仓库 `assets/sfx/generate.py` 合成 | 同本仓库（GPL-3.0-or-later） |
| 图标 | `assets/icons/*.png` 由本仓库 QML 渲染生成 | 同本仓库（GPL-3.0-or-later） |

## npm 依赖（`npm install` 时获取）

| 包 | 版本 | 许可 |
|---|---|---|
| `ws` | 8.x | MIT |
| `sherpa-onnx-node` | 1.13.x | Apache-2.0 |

## 模型（不随仓库分发，由 `scripts/fetch-models.sh` 下载）

| 模型 | 用途 | 许可 |
|---|---|---|
| `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` | 中英双语唤醒词 | Apache-2.0（k2-fsa/sherpa-onnx 发布页） |
| `sherpa-onnx-paraformer-zh-*`（离线识别） | 语音转写 | Apache-2.0（同上，请以下载页为准） |
| `sherpa-onnx-streaming-zipformer-*`（流式识别） | 实时 partial | Apache-2.0（同上） |

## 网络服务（不是依赖，但用户必须知道）

- **DeepSeek API**（对话/工具调用）与 **MiniMax TTS**（语音合成）是第三方商业服务，
  用户需自备 API Key 并遵守各自的服务条款。本仓库不包含、也不分发这两个服务的任何内容；
  费加罗的语音识别完全在本地运行，不需要联网或 Key。

## 长期记忆 / RAG（v1.0 起）

| 作品 | 方式 | 许可 | 说明 |
|---|---|---|---|
| [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | 独立本地服务（systemd user unit），通过 HTTP 调用；**不随本仓库分发** | **MIT** | `docs/rag.md`。源码 clone 在 `vendor/LightRAG`（gitignore，不提交）；运行时由 `lightrag-hku` PyPI 包提供 |
| MiniMax `embo-01` embedding | 用户自己的 MiniMax API key 调用；本地适配器 `scripts/rag/minimax-embed-proxy.mjs` 由本仓库编写 | 同本仓库（GPL-3.0-or-later） | 适配器只做协议转换，不含第三方代码 |

## 模型文件（运行时由 `scripts/fetch-models.sh` 下载，不随仓库/安装包分发）

| 模型 | 用途 | 上游许可（下载时以官方为准） |
|---|---|---|
| sherpa-onnx KWS zipformer (zh-en) | 唤醒词 | Apache-2.0（icefall / k2-fsa） |
| sherpa-onnx paraformer / streaming zipformer | 语音识别 | Apache-2.0 / FunASR 上游许可 |
| silero_vad.onnx | VAD | MIT |
| CAM++ speaker embedding（3D-Speaker） | 声纹 | Apache-2.0（3D-Speaker 上游） |

安装包与仓库**不包含**模型文件：容量与许可都由上游决定，首次安装/引导时按地区选择下载源
（`docs/llm-providers.md` 与 `scripts/fetch-models.sh --help`）。
