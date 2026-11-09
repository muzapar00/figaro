# Figaro 听觉模块（`src/voice/asr/`）

常驻麦克风监听 + 唤醒词「费加罗」+ 命令转写 + F5 长按。对外契约是
[`docs/ipc.md §2.1`](../../../docs/ipc.md)：

```js
createAsr({config, onWake, onLevel, onPartial, onFinal, onVadStart, onError})
  -> { start(), stop(), beginCapture(), endCapture(), capturing }
```

实现全部在本目录；不依赖 dsh 运行时，只依赖 `sherpa-onnx-node`（已装）与系统
`parec`（PipeWire/PulseAudio）。

## 数据流

```
parec ──16k mono s16le──► 常驻 KWS 关键词检测（听「费加罗」）
                              │ 命中
                              ▼
                          onWake() ──► beginCapture()   （daemon 不调也会自动开始）
                              │
        ┌─────────────────────┴──────────────────────┐
        ▼                                            ▼
  流式 ASR ──► onPartial（约 10 Hz）           Silero VAD 跟踪语音/静音
        │                                            │
        └──────────── silenceStopMs / maxCaptureMs ───┘
                              │
                     离线 ASR（paraformer，准确）
                              │  去掉开头的唤醒词
                              ▼
                          onFinal(text) ──► 回到常驻监听
```

- `onWake()` 触发后模块会在下一个 microtask 自动 `beginCapture()`（daemon 若在
  `onWake` 回调里同步调用 `beginCapture()` 则以 daemon 为准，不会重复进入）。
- 采集带 1.5 s 前导缓冲（pre-roll），所以「费加罗，现在几点」里的命令开头不会丢。
- 所有分段时间（`silenceStopMs` / `maxCaptureMs`）都按**采集音频时钟**计算，
  因此单元测试可以离线快速喂音频，行为与真机一致。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 契约入口 `createAsr()`；状态机、电平、pre-roll、F5 接线 |
| `sources.js` | `parec` 子进程采集（崩溃后指数退避重启）+ 测试用注入音源 |
| `kws.js` | sherpa-onnx `KeywordSpotter` 封装；从 `config.asr.wakeWords` 生成关键词文件 |
| `pinyin.js` | 唤醒词→拼音 token 映射、同音字归一、转写结果去掉唤醒词 |
| `recognizers.js` | 流式 transducer（partial）与离线 paraformer/sense-voice（final） |
| `vad.js` | Silero VAD（`models/vad/silero_vad.onnx`），缺模型时退化到能量 VAD |
| `capture.js` | 一句话采集状态机（VAD、静音结束、max/min、final 转写） |
| `dbus.js` | **零依赖手写 D-Bus 客户端**（SASL EXTERNAL + 完整类型编解码 + 信号） |
| `hotkey.js` | XDG `GlobalShortcuts` v2 绑定 F5 + 长按判定（`createLongPressDetector` 可单测） |

额外可选参数（不改变契约）：`source`（注入音源，测试用）、`hotkey:false`
（禁用 F5）、`onLog(msg)`（诊断日志）。额外只读属性：`state`、`modelInfo`、
`hotkeyState`（诊断/测试用）。

## 安装模型

```bash
./scripts/fetch-models.sh          # 可重跑、断点续传；ModelScope 优先，GitHub/HF 兜底
./scripts/fetch-models.sh --check  # 只校验
```

下载到仓库 `models/`（已 gitignore）：

| 目录 | 模型 | 体积 |
|---|---|---|
| `models/kws` | `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`（int8） | 10 MB |
| `models/asr-stream` | `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`（int8） | 25 MB |
| `models/asr-offline` | `sherpa-onnx-paraformer-zh-2023-09-14`（int8） | 243 MB |
| `models/vad` | `silero_vad.onnx` | 0.6 MB |

说明：ModelScope 只镜像了 KWS 的 epoch-12 导出，GitHub release 包里有更新的
epoch-99 导出。脚本默认 ModelScope 优先（国内快）；想让 KWS 用 epoch-99：

```bash
FIGARO_MIRROR=github ./scripts/fetch-models.sh --force --only=kws
```

两个导出都实测可用（见下表），模块会自动选择目录里可用的 epoch。

## 首次运行 F5：需要用户点一次「允许」

F5 走 XDG Desktop Portal 的 `org.freedesktop.portal.GlobalShortcuts` v2。
非沙箱应用必须先注册 app id，因此模块会自动：

1. 确保 `~/.local/share/applications/figaro.desktop` 存在（没有就写一个，
   这是 portal 识别 app id 的要求，用户级文件，不需要 sudo）；
2. 在 D-Bus 上调用 `org.freedesktop.host.portal.Registry.Register("figaro")`；
3. `CreateSession` + `BindShortcuts(figaro-talk, preferred_trigger=F5)`。

**然后 KDE 会弹一次对话框「Figaro 想要绑定快捷键」，用户点「允许/确定」即可**
（结果会写进 `~/.config/kglobalshortcutsrc`，以后不再弹）。

- 没确认/被拒绝时：`createAsr()` 的 `start()` **不会失败**（语音唤醒照常），
  只通过 `onError` 报一条可操作的错误；`hotkeyState.state` 为
  `awaiting-user` / `unavailable` / `denied`。
- 用户关掉了对话框后想重来：KDE 会把 action 记成"无按键"，需要先清掉：

  ```bash
  busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
    unregister ss figaro figaro-talk
  ```

  然后重启费加罗（或运行 `node scripts/asr-hotkey-test.mjs`）会再次弹窗。
- 想看 F5 实时事件：`node scripts/asr-hotkey-test.mjs`（长按 >260 ms 时打印
  `LONGPRESS`，松开打印 `RELEASE`）。
- 也可以在「系统设置 → 键盘 → 快捷键」里给 Figaro 手动指定按键。

## 配置项（`config.asr`，由 Lead 维护的 `src/config.js`）

| 配置 | 默认 | 行为 |
|---|---|---|
| `wakeWords` | `费加罗/菲加罗/飞加罗/figaro/费加` | 生成 KWS 关键词 + 转写后去掉开头唤醒词 |
| `kwsModelDir` / `streamingModelDir` / `offlineModelDir` | `models/kws` 等 | 相对仓库根目录（`config.paths.root`） |
| `device` | `default` | `parec --device=`；`default` 表示系统默认输入 |
| `silenceStopMs` | 900 | 说话结束后静音这么久 → 自动 `endCapture()` |
| `maxCaptureMs` | 15000 | 单次采集上限，兜底 |
| `minCaptureMs` | 350 | 更短的采集按空处理（F5 轻点一下不会误发） |
| `hotkey` | 见 `config.js` | 全局快捷键串（如 `CTRL+ALT+F5`、`F5`；空字符串 = 禁用），portal 格式由 `normalizeTrigger()` 规范化 |
| `longPressMs` | 260 | 按住超过该值才算长按（短按忽略） |
| `wakeCaptureFallbackMs` | 0 | >0 时唤醒后**等 daemon 调 `beginCapture()`**（daemon 先播「我在」）；超时兜底自己开始采集。daemon 当前配 1500 ms |

补充（F5/快捷键）：
- `normalizeTrigger()` 把 `ctrl+alt+f5` / `Ctrl+Alt+F5` / `Control+Alt+F5` 统一成
  `CTRL+ALT+F5`（顺序固定 CTRL+ALT+SHIFT+LOGO+KEY，`Meta/Super/Win→LOGO`）；
- 用户取消授权对话框时，模块不会一次失败就永久降级：**30 s 后重试，最多 2 次**，
  每次日志都提示"需要用户在弹窗点确定"；成功绑定后无需重启 daemon（`ShortcutsChanged`
  + 10 s `ListShortcuts` 轮询兜底）。
- 测试/嵌入时可传 `micGain:false` 避免自动校正动到系统混音器。

`onLevel` 每 50 ms 音频推一次 RMS（0..1，约 20 Hz）；`onPartial` 在采集期间
随流式识别结果更新（约 10 Hz，去重后）。

## 唤醒词实现与实测

KWS 模型是拼音建模单元的小 zipformer，关键词文件格式为
`<声母/韵母 token> @<显示文本>`，例如 `f èi j iā l uó @费加罗`。
`pinyin.js` 按 `wakeWords` 生成关键词，并额外生成**两字短前缀**
（`费加`、`菲加`）：实测只给三字全词时该模型对孤立短句只有 3/8 命中，
加上两字前缀后 8/8（epoch-12 与 epoch-99 都是 8/8），而误唤醒仍为 0。

实测（本机，合成音频，见 `scripts/asr-bench.mjs`）：

| 指标 | 结果 |
|---|---|
| 唤醒命中（8 条不同音色/语速/位置） | **8/8** |
| 唤醒延迟（播放开始→onWake，含 300 ms 前导静音） | min/median/max = 1936 / 2458 / 2516 ms |
| onWake→进入采集 | 约 1 ms（下一个 microtask） |
| 误唤醒（普通语句、真实麦克风 125 s、Chromium 音乐/视频 65 s、真人语音 600 s） | **0 次 / 13.2 分钟** |
| 转写正确率（5 条命令句，字符级） | **5/5 完全正确，平均 CER 0%** |
| 模型加载 + 启动 | 约 1.2 s |
| 常驻内存（单实例 RSS） | 约 540 MB（含 280 MB 模型 + onnxruntime） |

「费加罗」是中文拼音唤醒词；配置里的 `figaro` 英文写法**无法**被该 KWS 模型
编码（已跳过并记日志），中文发音的「费加罗」不受影响。

## 灵敏度、误唤醒与回声抑制

### 配置项（GUI 直接读写；默认值）

| 配置 | 默认 | 说明 |
|---|---|---|
| `asr.sensitivity` | `"low"` | `low \| medium \| high`，映射到 KWS 的 `keywordsScore` / `keywordsThreshold` |
| `asr.wakeCooldownMs` | `2500` | 两次唤醒的最小间隔；冷却期内的 KWS 命中直接忽略（debug 日志一行）。`endCapture()` 之后也会重新起算，避免"答完立刻又醒" |
| `asr.inputGainPercent` | `null` | `null`=自动校准；数字 = **raw ALSA 增益 0–63**（本机已知可用值 **45**）固定且不自动改。⚠️ 不是 amixer 百分比：`sset Capture 45%` 实际是 raw 28，所以 GUI 滑块请用 0–63 或按 `raw = round(% × 63 / 100)` 换算 |

灵敏度实测参数（本机，KWS epoch-99 int8）：

| 档位 | keywordsScore | keywordsThreshold |
|---|---|---|
| low（默认） | 0.75 | 0.55 |
| medium | 1.25 | 0.40 |
| high | 1.50 | 0.25 |

### 误唤醒专项实测（每档跑同一批负样本，41.8 分钟）

负样本 = 40 句近音干扰（费/非/飞/菲 + 加/家/佳/嘉 组合，如「非法加班」「费用加起来」
「咖啡加糖」「缴费加紧办理」）+ 10 分钟连续真人语音 + 真实 mic 10 分钟 + 扬声器
monitor 10 分钟（同一段真实使用环节的录音）。唤醒延迟按真机 100 ms 节奏回放测量。

| 档位 | 唤醒命中 | -12dB 静音命中 | 检测位置 | 真人语音 10min 误触发 | 近音 40 句 | TTS 回声录音 | 合计 |
|---|---|---|---|---|---|---|---|
| low | 8/8 | 8/8 | 848 ms | **0** | 3 | 8 | 11 / 41.8min |
| medium | 8/8 | 8/8 | 848 ms | **0** | 4 | 10 | 14 / 41.8min |
| high | 8/8 | 8/8 | 848 ms | **0** | 4 | 10 | 14 / 41.8min |

- 三档的唤醒延迟（模块 onWake，含 300 ms 前导静音）：min≈845 / median≈1225 / max≈2215 ms，
  档位之间无差别（检测都发生在「费加」说完时，约 0.85 s 音频位置）。
- 相对 high：**low 的实录音误唤醒从 14 降到 11（−21%），唤醒命中/延迟无损失**。
- **真人语音 10 分钟：三档都是 0 次误触发** —— 说明 KWS 对普通对话/口音并不敏感。
- 近音句（如「费用*加*起来」「咖啡*加*糖」）确实会命中两字短前缀 `费加/菲加`：low 比 high 少 1 次。
- **真实录音里的 8~10 次"误唤醒"全部是 Figaro 自己的 TTS 被麦克风录回去**（详见下节），不是灵敏度能解决的。

复测命令：

```bash
node scripts/gen-wake-negative-audio.mjs     # 生成 40 句近音负样本（TTS，需 key）
node scripts/asr-wake-sensitivity.mjs        # 三档 × (命中/静音/检测位置/各类误唤醒) 表
```

### 回声抑制（本次用户"一直被触发"的根因）

用真实 mic + 扬声器录了 10 分钟并定位每次 KWS 命中，**全部是 Figaro 自己播报的
TTS 被麦克风录回**，例如转写「费伽罗请指示」「费伽罗在的」「费伽罗把音量调到百分之」；
同一时刻的 speaker monitor 录音也命中同一段，证实是 Speaker→Mic 回授，不是环境噪声
或灵敏度问题。40 句近音语料 + 10 分钟真人语音是 0 次。

修复由 daemon 侧接线（brain 已完成并生产验证）：TTS/ack 播放期间调用

```js
asr.setMuted(true)      // 别名 asr.pauseListening()
asr.setMuted(false)     // 别名 asr.resumeListening()
```

`muted` 只暂停唤醒词监听；采集、电平、自测窗口都照常。另有内置兜底：
每次 `endCapture()` 后自动冷却 `wakeCooldownMs`，防止回复刚开始就再醒。
排障钩子：设置 `FIGARO_ASR_HIT_DUMP_DIR=/some/dir` 后，每次 KWS 命中会写一段
前 1.5 s 的 wav，下次再出现误唤醒可直接听/转写定位（默认关闭）。

### GUI 自测通道（docs/ipc.md §3.1；daemon 直接转发到这些方法）

```js
asr.startMicTest({ ms = 4000, onSample({rms, peak, level}), onEnd }); // 20Hz, 0..1
asr.stopMicTest();
asr.startAsrTest({ ms = 8000, onPartial(text), onResult({text, streamingText, ms, audioMs, offlineMs}), onError });
asr.stopAsrTest();
asr.armWakeTest({ ms = 15000, onScore({score, keyword}), onHit({score, latencyMs}), onEnd({hits, misses, falseAlarms, maxScore, ms}) });
asr.disarmWakeTest();
asr.applyRuntimeConfig({ sensitivity, wakeCooldownMs, inputGainPercent }) // -> {applied, restartRequired}
asr.setSensitivity('low'|'medium'|'high'); asr.setWakeCooldownMs(2500); asr.setInputGainPercent(40|null);
asr.sensitivity; asr.wakeCooldownMs; asr.inputGainPercent; asr.muted;
asr.micInfo;   // {available, gainPercent(raw 0-63), percent(amixer%), rms, peak, fixed, fixedPercent}
asr.lastFinalMs;
```

- `test.wake.arm` 窗口内命中**只走 onHit/onScore，不会回调 onWake/beginCapture**（单测覆盖）。
- `score` 是流式识别文本与唤醒词的相似度（0 / 0.33 / 0.67 / 1.0）——sherpa 的
  KWS 不暴露逐帧分数，这是 GUI 的实时反馈值，真正触发仍由 KWS 决定。
- `sensitivity` 热切换会重建 KWS（约 0.3 s 阻塞一次），其余项即时生效；
  `wakeWords` / `hotkey` / `silenceStopMs` 改动需重启 daemon。

## CPU 与内存（重要）

**坑：onnxruntime 的线程池在「持续推理但间隙很短」时自旋空转。** 常驻 KWS 每
100 ms 解一次，如果 `numThreads=2`，两个 ORT worker 线程会在两次 decode 之间
spin-wait，实测空闲 CPU **212% of one core**（daemon 里那 200% 就是这么来的）。
同一份代码 `numThreads=1` 时空闲只有 **2.7%**。所以本模块把**所有** ORT
session 默认设为 1 线程（单线程也够快：流式 RTF≈0.012，离线 paraformer
71–105 ms/句，KWS RTF≈0.01）。仅在明确知道后果时用环境变量覆盖：

```bash
FIGARO_ASR_KWS_THREADS=1      # 默认 1（>1 会空闲自旋！）
FIGARO_ASR_STREAM_THREADS=1   # 默认 1
FIGARO_ASR_OFFLINE_THREADS=1  # 默认 1（2 => 41-60ms/句，但会多 2 个线程）
```

**内存：离线模型 233 MB 懒加载。** 启动只加载 KWS(10MB)+streaming(25MB)+VAD；
首次 `beginCapture()` 时在 worker 线程上异步加载离线模型（`OfflineRecognizer.createAsync`，
约 0.58 s，与用户说话重叠，不阻塞 daemon 事件循环），`endCapture()` 里 await。
所以「只听唤醒词、还没唤醒过」时很轻：

| 状态 | CPU（空闲） | 线程 | RSS |
|---|---|---|---|
| 常驻监听、未唤醒过 | **3–7%** | 7 | **~166 MB** |
| 首次唤醒并转写过一句后 | **~0.1%** | 11 | ~570–630 MB（233MB 模型 + ORT arena 常驻） |
| 模型加载+启动耗时 | — | — | 约 0.6 s |

（daemon 侧实测：重启后 `top` 平均 9.7%、RSS ~600 MB，之前是 **200%+**。）

（实测环境：/usr/bin/node v22.22.1，真实 parec 麦克风，30s/20s 采样，
`/proc/self/stat` 计算；唤醒采集期间 CPU 会短暂升高，属正常。）

唤醒后 233MB 模型会一直常驻：sherpa-onnx-node 没有显式释放 session 的 API，
依赖 GC 释放 native 内存不可靠，因此不做「每轮卸载」。若想进一步省内存，
可在 `config` 里把 `offlineModelDir` 指向更小的模型（如 streaming-only 方案），
模块会自动只用流式结果做 final。

运行时基准是 **`/usr/bin/node` v22.22.1**（本机 daemon 统一用这个）；v24 上
也在同一套测试/bench 里验证过，行为一致。

## 降级矩阵

| 情况 | 行为 |
|---|---|
| `models/kws` 缺失/不完整 | `start()` 干净拒绝 + `onError(code=ASR_MODELS_MISSING)`；daemon 可继续跑（无语音） |
| 流式+离线模型都缺失 | `start()` 干净拒绝 + `onError` |
| 只有离线模型 / 只有流式模型 | 正常工作：没有 partial / 用流式结果兜底 final |
| `Silero VAD` 模型缺失 | 退化到自适应能量 VAD（安静房间可用） |
| 没有麦克风 / 没有 `parec` | `start()` 干净拒绝 + `onError(code=ASR_MIC_UNAVAILABLE)` |
| `parec` 中途崩溃 | 指数退避重启（300ms→3s，最多 6 次），仍失败则 `onError` + 状态 `failed` |
| D-Bus 会话总线/portal 不可用 | `start()` 照常成功（只剩语音唤醒），F5 报一条非致命 `onError` |
| 用户取消 portal 授权 | 同上（`hotkeyState.state='denied'`） |
| 用户长时间不说话 | 采集在 `max(silenceStopMs,1500)` 后自动结束，`onFinal('')` |
| 音频流中断 >1.5 s | 自动结束采集，回到监听（不会卡死） |

## 麦克风增益自动校正 + 电平看门狗（`mic-gain.js`）

本机 ALC897 的 `Capture` 混音器增益会跨会话保留，可能停在 63/63（+30 dB）。
此时麦克风输入严重过载/削波，KWS 听不出唤醒词（实测：增益 63 时环境 RMS 一度
到 5651，接近满量程；降到 45 后用户确认唤醒正常）。

`createAsr.start()` 后自动做一次校正（后台执行，不阻塞 start，不阻塞音频循环）：

1. `amixer -c 0 sget Capture` 读当前增益；
2. 用 300–500 ms 真实输入测 RMS/峰值（`peak > 0.9` 或 `RMS > 0.25` 视为过载；
   `RMS < 0.002` 视为几乎没有信号）；
3. 过载 → 按 45 → 38 → 30 → 24 逐档下调并复测（每次日志一行
   `[mic] capture gain 63->45 (RMS 5651->300)`）；几乎无信号 → 上调一档
   （上限 63、最多两步，且下限 20 不会把麦克风关掉）；
4. 幂等：已经在正常范围就只记一行 `[mic] capture gain ok at 45 (RMS …)`。

> 注：没有采用「RMS<0.005 就上调」的字面规则——安静房间在 45% 增益下
> RMS≈0.0026，会被误判成"太安静"从而不断上调、再次引入削波。因此上调阈值
> 取 0.002（接近数字静音），下调是主要方向。

运行期每 ~5 s 汇总一次电平（`observe()`）：

- 持续削波（>50% 采样过载）→ `onError({code:'MIC_CLIPPING'})` 一次（5 分钟冷却），
  并**自动下调一档增益**自愈；
- 连续 60 s 几乎无输入 → `onError({code:'MIC_SILENT'})` 一次；
- 两者都不会刷屏，也不影响语音链路。

没有任何 mixer / amixer 缺失时只 warn 一次并跳过，ASR 照常工作（单测覆盖）。

## 准确率（实测，2026-11）

评测集：
- **干净 TTS 通道**：`models/bench-audio`，44 句中文命令/问题（MiniMax `speech-02-turbo`
  16k 单声道，有真值），由 `scripts/gen-asr-bench-audio.mjs` 生成（gitignored）。
- **噪声通道**：把真实麦克风噪声（45% 增益下录的 10 s 环境/音乐声，RMS 3488）
  按 20/10/5 dB SNR 混进上面的句子。
- **真人语音**：sherpa-onnx 官方 16 句真人录音（含川渝/天津/河南口音），
  真值取自官方文档，`scripts/asr-human-bench.mjs`。

### 1) 模型 × 通道（归一化 CER，越低越好）

| 模型 | clean | SNR20 | SNR10 | SNR5 | 尾截断 200ms |
|---|---|---|---|---|---|
| paraformer-zh-2023-09-14 int8（现役） | 1.5% | 1.3% | 1.2% | 2.7% | 1.2% |
| SenseVoice-small int8 | 1.2% | 1.2% | 1.4% | 2.5% | 1.0% |
| paraformer-zh-int8-2025-10-07（川渝微调） | 2.3% | — | 3.1% | 4.4% | — |

### 2) 真人语音（16 句，含口音，最贴近真实用户）

| 模型 | CER | 中位延迟 |
|---|---|---|
| paraformer-zh-2023-09-14 int8（现役） | **6.47%** | 420 ms |
| SenseVoice-small int8 | 9.56% | 378 ms |
| paraformer-zh-int8-2025-10-07（川渝微调） | 6.09% | 351 ms |

> 2025 川渝模型在「它自己的官方测试集」上略好（6.09% vs 6.47%），但在 TTS
> 干净通道明显更差（2.3% vs 1.8%，存在测试集偏置风险），因此**不切换**。

### 3) 消融实验（都基于 paraformer 现役）

| 改动 | 效果 | 结论 |
|---|---|---|
| 解码前去掉首尾静音 | clean 1.79→1.79，SNR10 1.53→2.30，SNR5 3.58→4.35 | **不做**（会切掉弱音尾） |
| GTCRN 降噪后再识别 | SNR10 1.53→3.58，SNR5 3.58→6.39，SNR0 4.35→8.70 | **不做**（拟人化损伤语音，CER 翻倍） |
| 尾截断 200 ms | 1.5→1.2（几乎无感） | `silenceStopMs=900` 足够，**不调大**（调大只会增加延迟） |
| 流式 partial | RTF≈0.012，首 partial 0.5–0.8 s | 保留，不影响 final |
| 热词/上下文偏置 | paraformer/SenseVoice 在 sherpa-onnx 里**不支持** hotwords | 不启用；若将来需要，换 transducer 系模型 |
| 标点 | 现役 paraformer 无标点；SenseVoice 自带标点/ITN | 见下 |

### 4) 选定方案

- **final 继续用 paraformer-zh-2023-09-14 int8**（尺寸 243 MB，单线程 71–105 ms/句）。
  实人+噪声综合最稳，且没有切换风险。
- SenseVoice-small int8 作为**可选**（`./scripts/fetch-models.sh --only=sensevoice`）：
  TTS 干净通道略好、自带标点与 ITN，但真人带口音明显更差，默认不启用。
- 唤醒词不需要专门训练：KWS zipformer 3.3M + 两字前缀实测 8/8；
  识别准确率此前最大的问题不是模型，而是**麦克风增益 63 导致削波**（见上一节）。
- 不换更大模型（FireRedASR 等 1–2 GB、CPU RTF 高）在“桌面语音助手 + 噪声通道”
  场景收益不抵成本。

## 交互信号（docs/voice-interaction.md，方案 A 已实现）

ASR 侧向 daemon 提供 4 个交互信号，都是 addtive、旧调用方不受影响：

1. **热键短按 = 取消（Siri 点一下让它闭嘴）**
   `createAsr({ onTap })`：热键按下后**未达** `longPressMs`(260) 就松开 → `onTap()`，
   **不会**唤醒、不会开始采集；长按（≥`longPressMs`）仍是 `onWake()` + `beginCapture()`，
   松开 → `endCapture()`。tap 时若已有采集在跑，模块**不会自己结束它**（是否取消由 daemon 决定）。
2. **唤醒后 give-up（沉默退出）**
   `beginCapture()` 之后 `wakeGiveUpMs`（默认 5000）内 VAD 没检测到语音起点 →
   模块自动 `endCapture('give-up')`；传了 `onGiveUp` 时**只回调 `onGiveUp()`、不发 `onFinal`**，
   没传时保持旧行为（`onFinal('')`）。有语音则走正常 `silenceStopMs` 路径，二者不冲突；
   超过 `maxCaptureMs` 仍照常截断 finalize。`wakeGiveUpMs` 支持 `applyRuntimeConfig` /
   `setWakeGiveUpMs()` 热改。
3. **muted 期间插话检测（barge-in）**
   `setMuted(true)`（TTS/ack 播放中）只暂停唤醒词：不跑 KWS、不会唤醒、不会开始转写，
   但仍跑电平与轻量 Silero VAD；连续人声 ≥250 ms → `onUserSpeech()`（1 秒冷却，只发信号）。
   daemon 收到即可实现"播放中说话 → 停 TTS → ack → listening"。
4. `wakeGiveUpMs` 与既有 `sensitivity / wakeCooldownMs / inputGainPercent` 一样可热改：
   `applyRuntimeConfig({ wakeGiveUpMs })` → `{applied:['wakeGiveUpMs'], restartRequired:[]}`。

新增回调：`createAsr({ onTap, onGiveUp, onUserSpeech })`（都可选，不传则行为与旧版一致）。

## 插话打断（barge-in）的响度门槛与回声基线

旧实现只要 muted 期间连续 250 ms 人声就回调 `onUserSpeech`，结果 **TTS 自己的
扬声器回声**也会把回答掐掉（用户反馈"特别容易被打断"）。现在必须同时满足
"够响 + 明显高于播放回声 + 持续足够长"：

- `setMuted(true)` 后先用播放开始的 **300 ms** 麦克风电平测出回声基线
  （中位数方式；如果音频停滞最多等 1.6 s）；
- 普通 TTS 播放期：`rms > max(minRms, echoBaseline * echoFactor)`；
- 播唤醒应答（waking/ack）期：`rms > max(minRms * 1.3, echoBaseline * 2.5)`，更严格；
- "持续"= 累计超过阈值 **≥ minMs**（允许 ≤200 ms 的词间停顿，长停顿重新计数）；
- 触发后 1 s 冷却；muted 期间**不跑 KWS、不唤醒、不转写**，只回调一次 `onUserSpeech()`。

### 配置（`asr.bargeIn`，可热改）

| 字段 | 默认（config.js 建议值） | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 彻底关闭插话检测（`onUserSpeech` 永不回调） |
| `minRms` | **0.09** | 归一化 RMS 绝对下限（0..1） |
| `echoFactor` | **2.5** | 还要高于"播放期回声基线"的倍数 |
| `minMs` | **500** | 超过阈值需累计的时长 |

> 模块内置兜底就是上表数值（`BARGE_IN_DEFAULTS`）；`src/config.js` 目前仍是旧值
> （0.14/2.0），建议同步改成 0.09/2.5。当前用户 config 里 `bargeIn.enabled=false`
> （用户手动关掉了），修好后可从 GUI 重新打开。

热改：`applyRuntimeConfig({ bargeIn: { minRms, echoFactor, minMs, enabled } })`
或 `asr.setBargeIn({...})`；`modelInfo.bargeIn` / `modelInfo.bargeInStats`
（baseline/threshold/phase/fired）供 GUI/诊断。播放应答阶段更严格由模块自动判断
（`wakeCaptureFallbackMs` 窗口内视为 ack）；daemon 也可显式传
`asr.setMuted(true, { phase: 'ack' })`。

### 实测（本机，`scripts/asr-bargein-bench.mjs`）

**真实声学通道**：TTS 由 MiniMax 合成、经默认扬声器播放、用 parec 录麦克风
（扬声器→麦克风的真实回授；共 12.0 s 回声录音）。

| 条件 | mic RMS 均值 | 中位 | p95 | 最大 |
|---|---|---|---|---|
| 仅 TTS 回声（12.0 s，240 windows） | 0.0171 | 0.0147 | 0.0397 | 0.0795 |

**合成说话人（同一真实回声录音 + TTS 命令语音在采样域按目标 mic RMS 混音）**：
5 条不同命令句/档位，用推荐配置（minRms 0.09 / echoFactor 2.5 / minMs 500）跑真实检测器：

| 用户 mic RMS | 打断触发 | 说明 |
|---|---|---|
| 0.06 | 0/5 | 太轻（与回声同量级） |
| 0.08 | 2/5 | |
| 0.10 | 2/5 | |
| 0.12 | 3/5 | |
| **0.15** | **5/5** | 正常"盖过 TTS 说话"音量 |
| 0.20 | 5/5 | 明显提高音量 |

- **回声中误触发：0/12.0 s**；**ack 阶段回声误触发：0**；
- 旧默认（minRms 0.14 / echoFactor 2.0）在用户 mic RMS 0.15 时只有 **2/5** 触发
  （太钝），所以推荐放宽到 0.09/2.5；实测 `minRms=0.14` 全程回声也都是 0，
  但在 0.12–0.15 的"正常盖过"音量下不可靠。
- 参数候选表（回声中误触发全部为 0）：minRms 0.08/9/10/12/14 × echoFactor 2/2.5/3/4，
  只有 minRms ≤0.09 能在 0.15 mic RMS 达成 5/5。
- **说明**：真实用户说话无法由 agent 产生，上表"用户"是 TTS 语音经采样域混音
  （回声部分是真实录制的麦克风信号）；声学回声是真实的。若用户正常说话更轻
  （mic RMS <0.12），可把 `minRms` 再降到 0.07–0.08；若觉得仍容易被打断，可升到 0.11。

## 测试与工具

```bash
node --test 'tests/asr/*.test.js'   # 44 个测试，约 9 s，不需要麦克风
node scripts/asr-selftest.mjs       # 冒烟：唤醒/转写/不误唤醒
node scripts/asr-bench.mjs          # 验收指标（命中率/延迟/CER/误唤醒/内存）
node scripts/asr-bench.mjs --live=120   # 追加真实麦克风监听 120 s
node scripts/asr-hotkey-test.mjs    # F5 绑定与长按实时诊断
node scripts/gen-test-audio.mjs     # 重新生成 tests/asr/fixtures（MiniMax TTS，读配置密钥）
```

测试音频是 MiniMax TTS 合成的 16 kHz 单声道 WAV（已提交在
`tests/asr/fixtures/`，20 条）。密钥只从 `~/.config/figaro/config.json`
读取，绝不打印/写盘。

## 已知限制与风险

1. **F5 首次需要用户点一次弹窗**（KDE 安全设计，无法代替用户点）。未确认前
   只有语音唤醒；模块不会因此崩溃。
2. KWS 模型只支持**中文拼音**唤醒词；英文唤醒词需要换模型（如
   `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`）或改用 ASR 文本匹配。
3. 唤醒词含两字短前缀「费加」以保证召回；理论上以「费加…」开头的普通词可能
   误触发。13.2 分钟真实音频 + 7 条干扰句实测为 0 次；更长时间的数据集未测。
4. 合成音频的唤醒延迟数字包含 TTS 片段的前导静音，真实用户说话时感知更快；
   真人「说 10 次费加罗」需要用户配合，用 `scripts/asr-hotkey-test.mjs`
   或 `--live` 模式可复测。
5. 交付环境里 HuggingFace 直连返回 401（被网关拦截），下载脚本保留了 HF
   兜底分支但本机走 ModelScope/GitHub。
6. 反复 `start()/stop()` 会累计原生内存（sherpa-onnx 依赖 GC 释放），daemon
   应只创建一个 ASR 实例。
7. `parec` 与其它应用共享 PipeWire 输入（不会独占麦克风），`stop()` 会
   SIGTERM 并回收子进程（测试覆盖）。
