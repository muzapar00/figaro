# Figaro architecture & integration contract

Figaro = 系统级独立语音智能体。**不依赖 dsh 运行时**：独立 Node.js 进程 + 自己的工具实现，
提示词与工具列表从本机 dsh 源码搬用改写（见 `## 6`）。

```
┌──────────────────────────── figaro.service (Node 24, systemd --user) ────────────────────────────┐
│                                                                                                 │
│  bin/figaro ──► src/daemon.js  状态机: idle → listening → thinking → speaking → idle            │
│                  │                                                                              │
│                  ├── agent loop (src/agent/)         DeepSeek /chat/completions + tools          │
│                  ├── ASR module (src/voice/asr/)     mic → VAD/KWS 唤醒 → 转写                   │
│                  ├── TTS module (src/voice/tts/)     MiniMax WS 流式 PCM → pw-cat 播放            │
│                  └── IPC server (src/ipc.js)  ──────► unix socket，UI/CLI 订阅事件                │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                  ▲
                              ┌───────────────────┴────────────────────┐
                              │ qs -c figaro  (Quickshell overlay,      │
                              │ Lead 负责) Siri 风格动画                │
                              └────────────────────────────────────────┘
```

运行环境事实（已核实）：
- `/usr/bin/node` v24.22.2；ESM；依赖仅 `ws`、`sherpa-onnx-node`。
- PipeWire 1.6.2（pulse 兼容），默认输入 `alsa_input.pci-0000_00_1f.3.analog-stereo`，
  `parec` / `pactl` / `pw-cat` / `ffmpeg` 可用。
- RTX 5070 Ti 16G / i7-14700KF 28 线程。
- sudo 需要交互密码 ⇒ **不要**依赖修改 `/dev/input` 权限；全局快捷键走 XDG portal。
- `org.freedesktop.portal.GlobalShortcuts` version=2 可用（有 Activated/Deactivated 信号）。

## 1. 文件与写作用域（禁止跨界）

| 归属 | 路径 | 负责人 |
|---|---|---|
| 契约/基础 | `docs/ipc.md`, `src/ipc.js`, `src/config.js`, `package.json` | **Lead** |
| 大脑 | `src/daemon.js`, `src/agent/**`, `bin/figaro`, `systemd/**`, `tests/agent/**` | teammate A `figaro-brain` |
| 听觉 | `src/voice/asr/**`, `models/**`, `scripts/fetch-models.sh`, `tests/asr/**` | teammate B `figaro-ears` |
| 嗓子 | `src/voice/tts/**`, `tests/tts/**` | teammate C `figaro-voice` |
| 动画 | `qml/**`, `config/config.json`（最后集成时） | **Lead** |

`package.json` 由 Lead 维护；需要新依赖时在回报里说明，由 Lead 添加。

## 2. 进程内模块契约

### 2.1 ASR（B 实现，A 调用）

`src/voice/asr/index.js`

```js
export function createAsr({
  config,                    // loadConfig() 结果
  onWake,                    // () => void          唤醒词 / 长按开始
  onLevel,                   // (rms01:number) => void  0..1，10~20Hz
  onPartial,                 // (text:string) => void   实时转写（可空实现）
  onFinal,                   // (text:string) => void   一句/一段话的最终转写
  onVadStart,                // () => void             检测到用户开始说话
  onError,                   // (err:Error) => void
}) : {
  start(): Promise<void>;    // 起麦克风 + 常驻唤醒词监听
  stop(): Promise<void>;
  beginCapture(): void;      // 进入命令采集（唤醒后 / F5 按下）
  endCapture(): void;        // 结束采集 → 触发 onFinal
  get capturing(): boolean;
}
```

行为要求：
- 常驻监听时**只在检测到唤醒词**才 `onWake()`；不得把普通对话误唤醒（要有误唤醒率实测数据）。
- `beginCapture()` 后开始转写，静音 `config.asr.silenceStopMs` 后自动 `endCapture()`
  （即 `onFinal` 由模块自己触发，daemon 不必计时）。
- F5 长按（`config.asr.hotkey`，`longPressMs`）：“按下→hold 达阈值”算唤醒 + `beginCapture()`，
  松开 → `endCapture()`。长按由 `src/voice/asr/hotkey.js` 实现，同属 B。
- 麦克风不可用/模型缺失时必须 `onError` 且不抛未捕获异常——daemon 要能在没有麦克风的机器上跑。

### 2.2 TTS（C 实现，A 调用）

`src/voice/tts/index.js`

```js
export function createTts({
  config,
  onLevel,                   // (rms01:number) => void  播放时电平（UI 波形）
  onState,                   // ('idle'|'speaking') => void
  onError,
}) : {
  speak(text: string): Promise<void>;  // 追加到播放队列（文本流式追加是合法的）
  flush(): Promise<void>;              // 等队列播完
  stop(): void;                        // 打断（barge-in），清空队列与缓冲区
  get speaking(): boolean;
}
```

行为要求：
- MiniMax 同步语音合成 WebSocket：`config.minimax.wsUrl`，Bearer API key。
- 请求 `format:"pcm"`、`sample_rate:32000`、`channel:1`（16-bit LE 原始 PCM），
  **边收边播**（首包即出声，不等整句合成完）。播放用 `pw-cat`/`paplay` 子进程喂 PCM。
- 长文本按句切分，句子间无缝衔接，不重复不丢字。
- 自动清洗 TTS 不友好的内容：markdown 标记、代码块、URL、emoji。
- 必须给出实测：**首字延迟**（请求→第一声）、语速/自然度试听样本、男声候选对比。
- 生成过程中 `speak()` 可被再次调用（流式追加），不得丢句。

### 2.3 Agent 大脑（A 实现）

`src/agent/index.js` 导出 `createAgent({config, onTextDelta, onToolEvent, onState})`
→ `{ async run({text, signal}) => {text, usage} , reset() }`。

- DeepSeek `POST {baseUrl}/chat/completions`，`tools` = 见第 6 节的搬运清单。
- 工具调用循环：模型返回 `tool_calls` → 本地执行 → `role:"tool"` 回填 → 继续，直到无工具调用。
- `onTextDelta(delta)` 流式吐字（`stream:true`），daemon 用它边出字边喂 TTS（边想边说）。
- 工具事件 `onToolEvent({name, status:'start'|'end', summary})` 供 UI 显示"正在…"。
- 会话记忆：daemon 侧保留上下文（默认 20 轮），`run()` 连续对话；`reset()` 清空。
- 超时/网络错误要降级：报 `onError`，不崩进程。

## 3. IPC 线协议（unix socket，NDJSON）

路径：`config.ui.socket` = `$XDG_RUNTIME_DIR/figaro/sock`（无 XDG 时 `/tmp/figaro/sock`），
目录 0700。一行一个 JSON。

**客户端 → daemon**

| 消息 | 字段 | 说明 |
|---|---|---|
| `{type:"ask"}` | `text:string`, `speak?:bool`(默认 true), `session?:string` | 直接提问（CLI/UI 输入框） |
| `{type:"cancel"}` | — | 打断当前思考/说话 |
| `{type:"wake"}` | — | 等价唤醒（UI 点击麦克风） |
| `{type:"listen_begin"}` / `{type:"listen_end"}` | — | 手动按住说话 |
| `{type:"subscribe"}` | — | 之后收所有事件（UI 必须发一次）。**daemon 必须立即回一帧当前 `state`**（若有 partial / 正在跑的工具也一并 replay），否则中途连入的 UI 会停在 idle |
| `{type:"ping"}` | — | 健康检查 |

**daemon → 客户端**

| 消息 | 字段 | 说明 |
|---|---|---|
| `{type:"state"}` | `state:"idle"\|"waking"\|"listening"\|"finalizing"\|"thinking"\|"speaking"` | 状态机唯一真源。`waking`=正在播唤醒应答，`finalizing`=等待离线模型出最终文本 |
| `{type:"level"}` | `value:0..1` | 电平，listening/speaking 时 10~20Hz |
| `{type:"partial"}` | `text` | 思考中：已生成的回复文本；倾听中：ASR 中间结果 |
| `{type:"reply"}` | `text`, `requestId?` | 一轮结束的完整回复 |
| `{type:"tool"}` | `name`, `status:"start"\|"end"`, `summary?` | 工具调用进度（UI 可显示小字） |
| `{type:"error"}` | `message` | 非致命错误 |
| `{type:"pong"}` | — | 心跳回包 |

`ask` 可以先回 `{type:"ack", requestId}`（可选，UI 不要依赖）。

实现事实（验收时确认）：
- 取消/打断时 daemon 不发 `reply`，直接回 `idle`；新 `ask` 会 abort 旧 turn。
- `level` 不 replay（下一秒就有新值，UI 不要依赖）。
- 音频链路：ASR/TTS 任一模块缺失时 daemon 只 warn 降级，纯文本 `ask` 仍可用。


## 3.1 设置/测试扩展（GUI 用，additive）

GUI（`qs -c figaro-settings`）与诊断脚本通过同一 socket 使用以下消息。**旧客户端不受影响**。

**客户端 → daemon**

| 消息 | 字段 | 说明 |
|---|---|---|
| `{type:"config.get"}` | `id?` | 回 `{type:"config", id, config}`（脱敏：不进 keys） |
| `{type:"config.set"}` | `id?`, `patch` | 深合并写入 `~/.config/figaro/config.json`（600），回 `{type:"config", ...}`；`patch` 里的敏感字段不落盘回显 |
| `{type:"test.mic.start"}` | `id?`, `ms?`（默认 4000） | 开始按 20Hz 推 `{type:"mic", rms, peak, level}`，结束推 `{type:"mic.end"}` |
| `{type:"test.mic.stop"}` | `id?` | 提前结束 |
| `{type:"test.asr.start"}` / `{type:"test.asr.stop"}` | `id?` | 单独测一次"录音→转写"：过程中推 `partial`，结束推 `{type:"test.asr.result", id, text, streamingText, ms, audioMs}`（两个模型都给，便于对比） |
| `{type:"test.wake.arm"}` | `id?`, `ms?`（默认 15000） | 进入唤醒测试窗口：KWS 每帧最高分按 `{type:"wake.score", score, keyword}` 推送（最多 10Hz），命中推 `{type:"wake.hit", score, latencyMs}`；窗口结束推 `{type:"test.wake.end", hits, misses, falseAlarms}` |
| `{type:"test.tts"}` | `id?`, `text`, `voiceId?` | 直接用当前 TTS 试听一段（走同一 sink/音色），回 `{type:"test.tts.result", id, ms, ok}` |
| `{type:"service.restart"}` | `id?` | 重启守护进程（GUI 按钮用；daemon 先回 ack 再 exec 自身或退出由 systemd 拉起） |
| `{type:"diagnostics"}` | `id?` | 回 `{type:"diagnostics", id, configPath, version, uptimeMs, asr, tts, ack, mic:{gainPercent, rms, peak}, latency:{...}, recentErrors[]}` |

**daemon → 客户端**：`config`、`mic`、`mic.end`、`test.asr.result`、`wake.score`、`wake.hit`、`test.wake.end`、`test.tts.result`、`diagnostics`（字段如上）。

**配置项新增（GUI 直接读写）**
- `asr.sensitivity`: `"low" | "medium" | "high"`（映射 KWS 的 `keywordsScore`/`keywordsThreshold`：low=更不容易误触发）
- `asr.wakeCooldownMs`: 两次唤醒之间的最小间隔（默认 2500）
- `asr.inputGainPercent`: 显式麦克风增益（`null`=允许自动校准；数字=固定值，不自动改）
- `tts.ack.*`（已有）、`tts.sink`（已有）

## 4. 系统集成（Lead + A 共同）

- systemd user unit：`figaro.service`（`ExecStart=/usr/bin/node <repo>/bin/figaro daemon`，
  `Restart=on-failure`，`Environment=HOME=…`，`WantedBy=default.target`）。
  **A 负责写 unit 文件并安装到 `~/.config/systemd/user/`，Lead 验收。**
- CLI：`figaro ask "…"` / `figaro say "…"` / `figaro status` / `figaro daemon`。
- UI overlay：`qs -c figaro` 独立 Quickshell 实例，读 `~/.config/quickshell/figaro/`。
  Lead 负责，A 不需要改 UI。

## 5. 验收（每部分必须给证据）

全部要求"跑过、看输出"，不接受"应该可以"：
- A：`figaro ask "现在几点，用 bash 看一下"` 端到端有回复且真的调用了工具；连续两轮记得上下文；
  工具报错不崩；`systemctl --user status figaro` active。
- B：唤醒实测表（10 次"费加罗"命中多少 / 播放音乐时 10 分钟误唤醒几次）；F5 长按实测；
  无麦克风降级。
- C：首字延迟（≥5 次取中位数）、试听文件路径、与 `speech-02-turbo`/`speech-2.6-turbo`/`speech-2.8-turbo` 对比结论。

## 6. 从本机 dsh 源码搬用的材料（A 必读）

dsh 安装位置：`/home/mzpr00/node-v24.22.2-linux-x64/lib/node_modules/@deepseek-ai/dsh/`
（其 `node_modules/@deepseek-ai/` 下是各插件包）。

| 要搬的东西 | 位置 |
|---|---|
| 系统提示词 | `@deepseek-ai/dsh-system-prompt/lib/index.js`（找 `You are an AI agent powered by DeepSeek Harness`） |
| bash 工具 | `@deepseek-ai/dsh-tool-bash`, `dsh-bash-local` |
| 文件读写编辑/搜索 | `@deepseek-ai/dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-str-replace-editor`, `dsh-fs-local` |
| web 工具 | `@deepseek-ai/dsh-client-ui-settings-web-search` 附近 / provider 里找 `web_search`、`web_fetch` 的 schema |
| 展示/提问工具 | `@deepseek-ai/dsh-tool-present`, `dsh-tool-ask-user` |
| 工具 schema 总览 | 各 `dsh-tool-*/lib/index.js` 里的 `inputSchema` / `parameters` |

搬运原则：**行为等价、实现自写**，按费加罗场景裁剪（保留 bash/read/write/edit/glob/grep/
web_search/web_fetch；语音场景下回复要口语化、简短——系统提示词里追加口语化约束）。

## 7. 安全

- 密钥只进 `~/.config/figaro/config.json`（chmod 600），**不得**写进仓库、日志、commit。
- 工具执行策略：bash 默认允许（用户是机主），但要有超时（默认 120s）与输出截断。
- 打断（barge-in）必须真的停：TTS `stop()` → 停播放 + 清队列。
