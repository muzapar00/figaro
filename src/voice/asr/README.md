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
| `hotkey` | `F5` | 空字符串 = 禁用 F5，只剩语音唤醒 |
| `longPressMs` | 260 | 按住超过该值才算长按（短按忽略） |

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
