# 费加罗 Figaro

系统级的语音智能助手：DeepSeek 当大脑、本地 ASR 当耳朵、MiniMax 当嗓子，桌面底部一个 Siri 风格的球体当脸。
**不依赖 dsh 运行**——它自己就是一个独立的 Node 守护进程。

```
你 ──说话/按F5──► 唤醒词 KWS + 流式中文 ASR ──文字──► DeepSeek 工具循环（bash/文件/搜索/网页）
                                                              │
桌面球体+波形 ◄── 状态与电平 ◄── IPC ◄── daemon ──句子流式──► MiniMax t2a_v2 ──PCM──► PipeWire
```

![倾听态](docs/images/listening.png)

## 组成

| 部件 | 位置 | 说明 |
|---|---|---|
| 大脑 | `src/agent/` | DeepSeek `/chat/completions` SSE 流式 + tool_calls 循环；提示词与工具说明从本机 dsh 源码搬用并改写成口语场景 |
| 工具 | `src/agent/tools/` | bash（120s 超时/进程组 kill/尾部截断）、read、write/edit（原子写）、glob、grep、web_search、web_fetch |
| 守护进程 | `src/daemon.js` + `bin/figaro` | 状态机、IPC（`docs/ipc.md`）、边想边说、打断、单实例保护 |
| 耳朵 | `src/voice/asr/` | sherpa-onnx 常驻唤醒词 + 流式/离线中文识别 + VAD 断句；F5 长按走 XDG portal GlobalShortcuts |
| 嗓子 | `src/voice/tts/` | MiniMax `t2a_v2` WebSocket 流式，32k PCM 直喂 `pw-cat`，首字 ≈0.42s，可打断 |
| 脸 | `qml/` | 独立 Quickshell 实例（`qs -c figaro`）：极光球体 shader + Siri 波形（`siriwave` iOS9 曲线算法的 QML 移植） |

## 安装

```bash
./install.sh          # 装 QML overlay、systemd user units（figaro.service / figaro-ui.service）
```

先决条件：
- `~/.config/figaro/config.json`（600 权限，模板见 `config/config.example.json`）填 DeepSeek 与 MiniMax 的 key；
- `npm install`（`sherpa-onnx-node`、`ws`）；
- 模型：`bash scripts/fetch-models.sh`（KWS 4.9M / 流式 ASR 25M / 离线 ASR 233M / VAD 636K，落到 `models/`，不入库）。

## 用法

```bash
figaro ask "现在几点？用 bash 看一下"     # 一问一答（默认不出声）
figaro ask "讲个笑话" --speak            # 出声
figaro say "你好，我是费加罗"             # 只朗读
figaro status                           # 状态/模型/语音能力/最近错误
journalctl --user -u figaro -f          # 看日志
```

语音：
- **长按 F5 ≥0.26s** 说话，松开结束（push-to-talk）；
- 或者直接说 **「费加罗」** 唤醒，然后说你的问题，静音 0.9s 自动结束；
- 点一下桌面上的球体可以打断它。

F5 绑定失败时：`~/.config/kglobalshortcutsrc` 里的 `[figaro] figaro-talk` 会被 KDE 持久化；删除该段并在
`systemctl --user restart figaro-ui` 后重新授权即可。hotkey 模块支持**运行中自动恢复**（监听 portal
`ShortcutsChanged` + 10s 轮询），授权后无需重启。

## 实测数字（本机 i7-14700KF / RTX 5070 Ti / PipeWire）

| 指标 | 数值 |
|---|---|
| TTS 首字延迟（speak→首段 PCM，真机） | 中位 **208ms**（可闻首字 ≈0.42–0.45s） |
| 语音回合：wake→listening | **0.23s** |
| 语音回合：说话结束→thinking | ≈1.5s（静音判停 0.9s） |
| TTS 打断 `stop()` | 同步 1.9–2.0ms，播放进程退出 5–6ms |
| 长文本不丢句 | 72 字回复本地 ASR 回读 CER 0.0%（4/5 音色） |
| overlay 空闲开销 | 0% CPU / ~39MB（窗口隐藏时不渲染，shader 与波形停止） |
| 单测 | **130 pass / 0 fail**（`/usr/bin/node` v22.22.1，`npm test`） |

## 已知限制

- MiniMax `t2a_v2` 限速 20 RPM，而本设计一句一请求；模块内建 18 RPM 自排队 + 1002 冷却重试。
- 唤醒词常驻监听的 CPU 成本见 `docs/asr-cost.md`（待 figaro-ears 优化后补实测）。
- `web_search` 无 API key，走 Bing HTML + DDG 兜底，可能被反爬限流（失败会如实说没搜到）。
- 唤醒词是中文「费加罗/菲加罗/飞加罗/figaro」，误唤醒率与播放音乐时的表现见 `tests/asr/` 的实测记录。
- 只实现了 PCM 播放路径（服务端确认按 pcm 返回），没有 mp3 解码回退。

## 设计约束

- 不 import 任何 `@deepseek-ai/dsh` 包：提示词/工具 schema 是搬用重写，运行时零依赖关系。
- 密钥只从 `~/.config/figaro/config.json`（600）读，仓库和日志里不出现。
- ASR、TTS 任一模块缺失时 daemon 只 warn 降级，纯文本 `ask` 仍然可用（便于无麦机器/CI）。
- 第三方：`qml/THIRD_PARTY_NOTICES.md`（siriwave MIT）。
