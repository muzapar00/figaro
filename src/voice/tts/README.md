# Figaro 嗓子 — MiniMax 流式 TTS + 低延迟 PCM 播放

契约见 `docs/ipc.md` §2.2。本目录由 `figaro-voice` 负责，写作用域 `src/voice/tts/**`、`tests/tts/**`。

```js
import { createTts } from './src/voice/tts/index.js';

const tts = createTts({ config, onLevel, onState, onError });
tts.speak('第一句。');       // 追加到播放队列，立即 resolve（不阻塞 daemon 继续吐字）
tts.speak('第二句。');       // 生成过程中可继续追加，不丢句
await tts.flush();           // 等队列真正播完
tts.stop();                  // 打断：杀播放进程 + 清队列/网络缓冲 + 断 WSS
tts.speaking;                // 是否正在出声

// 唤醒应答 / 预合成缓存（可选，给 brain 用）
await tts.playPcm(cachedPcm, { rate: 32000, channels: 1 });  // 播已合成 PCM，同一播放器/sink，可被 stop()
const { pcm } = await tts.synthesize('在的，请说。');          // 只合成不播放，用于启动时缓存
```

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | `createTts()`：队列、流水线、状态机、打断/重连/RPM 限流、统计 |
| `minimax-client.js` | MiniMax `wss://.../ws/v1/t2a_v2` 协议客户端（task_start → task_started → task_continue → task_continued → task_finished） |
| `player.js` | 原始 PCM → `pw-cat`/`aplay` 子进程；播放节拍 RMS；SIGKILL 打断 |
| `split.js` | 可追加的句子切分器（流式，不丢字） |
| `clean.js` | markdown / 代码块 / URL / emoji / 括号注释清洗 |
| `sink.js` | 输出设备（PipeWire/PulseAudio sink）探测、`config.tts.sink` 解析、失败回退 |
| `pcm.js` | `playPcm()` 的 PCM 归一化（s16/float、stereo→mono、重采样到播放器格式） |

## 关键设计

- **原始 PCM 直通播放**：请求 `audio_setting = {format:"pcm", sample_rate:32000, channel:1}`，
  服务端返回 hex 编码的 16-bit LE 裸 PCM；收到即写进 `pw-cat` 的 stdin，**首包即出声**，不做解码。
- **一句一个 `task_continue`，流水线窗口 3**：`maxInFlight` 条句子可以同时在合成。
  实测单句合成只需 ~0.31–0.38s，而一句音频约 1.5–3s，所以下一句的音频总在上一句播完之前就绪，
  句子之间**没有进程重启、没有解码等待**，衔接是连续的 PCM 流。
- **一个 turn 一个长驻播放进程**：队列播完后按估算的播放尾音等待（`playbackTailMs`），
  然后 `idle`，播放进程再暖留 `playerKeepAliveMs` 才关闭；下一句在暖留期内到达就复用同一进程。
- **打断是真打断**：`stop()` 同步执行 —— 代际号 +1（所有旧异步回调失效）、`SIGKILL` 播放进程、
  `terminate()` WSS、清队列/flush 等待者。实测同步部分 **1.9–2.0ms**，播放进程 SIGKILL 后 **5–6ms** 退出。
- **重连**：连接意外断开时重连一次，并重发“还没出过声”的句子；拿到音频后重连预算复位；
  连续失败 → `onError` + fail-fast，不会无限重试。
- **RPM 保护**：MiniMax `t2a_v2` 限速 **20 RPM（付费）/10 RPM（免费）**，而本模块一句一个请求。
  默认 `rpmLimit=18` 会在窗口内排队等待而不是撞 1002 报错；收到 1002/1039 会冷却 10s 再重试。
- **电平**：`onLevel(rms01)` 取原始归一化 RMS（0..1，语音通常在 0.02~0.2），
  按**播放时间轴**以 `levelSliceMs=64ms`（≈15.6Hz）推送，而不是收到网络包的速度。
- **指定输出设备**：不依赖系统默认 sink。`config.tts.sink` 支持完整 sink 名或唯一子串
  （如 `"hdmi"`），启动时解析并打一行 `[tts] playing to <sink>`；找不到就 warn 一次并回退系统默认。
  原因：本机默认 sink 可能指向被 Auto-Mute 关掉的前面板模拟输出，而房间里响的是 HDMI 显示器扬声器。
- **唤醒应答缓存**：`playPcm(buf)` 把预合成 PCM 直接灌进同一个播放器（同 sink、同 onLevel/onState、
  同样被 `stop()` 打断），`synthesize(text)` 只合成不播放，用于启动时预热"在的/请说"这类应答。

## 配置（读取 `config.minimax` / `config.tts`）

| 键 | 默认 | 说明 |
|---|---|---|
| `minimax.apiKey` | — | `sk-api-...`，只从 config/env 读，不落日志 |
| `minimax.wsUrl` | `wss://api.minimax.cn/ws/v1/t2a_v2` | |
| `minimax.model` | `speech-2.6-turbo` | 见下方选型结论 |
| `minimax.voiceId` | `male-qn-jingying` | 见下方选型结论 |
| `minimax.speed` / `volume` / `pitch` | `1.0` / `1.0` / `0` | 透传 `voice_setting` |
| `minimax.endpointTimeoutMs` | 8000 | WS 建连/握手超时 |
| `tts.maxInFlight` | 3 | 同时在合成的句子数（流水线窗口） |
| `tts.maxBufferChars` | 220 | 单句最大字符数（`config.js` 默认值） |
| `tts.minSentencesBeforeStart` | 1 | 攒几句再开口；`flush()` 会强制立即开始 |
| `tts.playbackTailMs` | 150 | 播放尾音余量（估算播放结束后再转 idle） |
| `tts.playerKeepAliveMs` | 2500 | 播完后播放进程暖留时间 |
| `tts.playerLatencyMs` | 40 | `pw-cat --latency` |
| `tts.playerCommand` | 自动探测 | 覆盖播放命令（数组），如 `["pw-cat", ...]`；测试用文件 sink |
| `tts.levelSliceMs` | 64 | 电平推送周期 |
| `tts.wsIdleCloseMs` | 90000 | 空闲多久后优雅 `task_finish` + 关闭 WSS |
| `tts.requestTimeoutMs` | 20000 | 单次 `task_continue` 无响应超时 |
| `tts.maxReconnects` | 1 | 连续断线重试预算 |
| `tts.rpmLimit` | 18 | 主动限速（0 关闭） |
| `tts.sink` | `""` | 输出设备（PipeWire/PulseAudio sink 名，可写唯一子串如 `"hdmi"`）；空 = 系统默认 |

> 以上 `tts.*` 额外键都是可选增强；不配置时用内置默认值，`src/config.js` 不需要改。

## 输出设备（config.tts.sink）

```jsonc
// ~/.config/figaro/config.json
{ "tts": { "sink": "alsa_output.pci-0000_01_00.1.hdmi-stereo" } }  // 或更短的 "hdmi"
```

启动（`createTts()`）时解析一次，标准错误打一行（systemd/journal 可见）：

```
[tts] playing to alsa_output.pci-0000_01_00.1.hdmi-stereo
[tts] playing to alsa_output.pci-0000_01_00.1.hdmi-stereo (resolved from "hdmi")
[tts] playing to default sink (alsa_output.pci-0000_01_00.1.hdmi-stereo)
[tts] sink "xxx" not found (available: ...); falling back to default sink (...)
```

规则：`""` → 系统默认（但日志里打印解析到的默认名，方便排查）；完整名精确匹配；
唯一子串匹配（不区分大小写）；找不到/多处匹配/查询失败 → 一次 warn + 回退默认（查询失败时信任配置值）。
解析结果暴露在 `tts.stats.audioSink` / `audioSinkName` / `sinkStatus`。
播放命令自动带 `pw-cat --target=<sink>`；`tts.playerCommand` 覆盖时由覆盖命令自己负责路由。
探测耗时约 10ms（`pactl list short sinks` + `pactl get-default-sink`），只在 `createTts()` 时做一次。

## 唤醒应答：playPcm() / synthesize()

```js
// 启动时把应答语料预合成（不播放），缓存 PCM
const { pcm, sampleRate, durationMs } = await tts.synthesize('在的，请说。');

// 唤醒瞬间直接播，无需再等 TTS 网络
const res = await tts.playPcm(pcm, { rate: sampleRate, channels: 1 });
```

- `playPcm(data, {rate, channels})`：`data` 可为 s16le `Buffer`（交错）、`Int16Array`、
  或 `Float32Array`/`number[]`（[-1,1]）；会自动 downmix 成 mono、重采样到播放器采样率；
  返回 Promise，在**这段音频播完**时 resolve（`{bytes, durationMs, completed}`），被 `stop()` 打断时
  `completed:false` 立即 resolve。
- 与 `speak()` 队列的关系：**同一个播放器、同一条 PCM 流，立即写入，不是混音、不是独立队列。**
  空闲时调用就是"马上播"；若 TTS 正好在出声，这段音频会接在已经写进 sink 的音频之后
  （所以它适合唤醒应答/提示音，不要在长篇回复中途当"插播"用）。
- `stop()` 同样立即杀播放进程，`playPcm` 的 Promise 跟着 resolve，`speaking` 转 false；
  `flush()` 也会等 `playPcm` 的音频播完。
- 走同一套 `onLevel`（播放节拍 RMS）和 `onState('speaking'|'idle')`。
- `synthesize(text, {model, voiceId})`：清洗+切句后用独立的短连接逐句合成，收集 PCM 返回
  `{pcm, sampleRate, durationMs, sentences, ms, ttfbMs}`；**不播放、不改 speaking 状态**；
  计入 RPM 限速。文本为空/只有 markdown 时返回空 PCM 且不发请求；无 API key 时 reject。
- 快捷验证：`node tests/tts/smoke.mjs --pcm=/tmp/silence300.pcm --sink=hdmi --runs=3`
  （用一段静音 PCM 验证路由与延迟，不吵人）。

## 实测（2026-11-09，本机 Node 24.22.2 / PipeWire 1.6.2 / api.minimax.cn）

测试语料为 12–16 字中文短句（bench，每组合 3 次取中位数）与 72 字回复（preview）。
`首字延迟` 分两层：**协议 TTFB** = `task_continue` 发出→第一段 PCM 到达；
**端到端** = `speak()` 调用→第一段 PCM 写进播放进程（含建连/播放器启动）。

| 指标 | 实测 |
|---|---|
| WS 建连 + `task_started` 握手 | 130–157ms（中位 145ms） |
| 协议 TTFB `task_continue`→首包（2.6-turbo） | **中位 208ms**（15 次组合） |
| 协议 TTFB（2.8-turbo / 02-turbo） | 212ms / 243ms |
| 单句合成耗时 gen（send→is_final，2.6-turbo） | 中位 347ms（区间 308–379） |
| gen（2.8-turbo / 02-turbo） | 364ms / 413ms |
| 端到端首字：`speak()`→首段 PCM（2.6-turbo+male-qn-jingying，真机 pw-cat 播放） | **中位 208ms**（5 次；冷启含建连 706ms，暖连接中位 202ms） |
| 同上，2.8-turbo 对照 | 中位 225.5ms（8 次；冷启 397–407ms，暖 213ms） |
| 请求→首段 PCM（模块内测量，2.6-turbo） | 中位 204ms（2.8-turbo：218ms） |
| 可闻首字估算 | 首段 PCM + TTS 前导静音（实测 164ms）+ 设备缓冲 40ms ≈ **0.42–0.45s** |
| `stop()` 同步耗时 | **1.9–2.0ms**（清队列+杀播放进程+断 WSS） |
| `SIGKILL`→pw-cat 进程退出 | **5–6ms** |
| 打断后残留音频/电平 | 0（单元测试断言 sink 冻结、无迟到 onLevel），无残留进程 |
| `createTts()` 启动（含 sink 探测） | ~10ms（探测本身 ~10.7ms） |
| `playPcm()` 调用→PCM 进播放进程（真机 pw-cat，hdmi sink） | 冷 **14ms** / 热 **0–1ms**；300ms 缓存音频 300ms 播完，wall 450–466ms |
| 真机静音验证（300ms 静音 PCM → HDMI sink） | `pw-cat --target=alsa_output...hdmi-stereo` 正常退出 0，无残留进程；`[tts] playing to ...` 日志正确；bogus sink 走 warn+默认回退 |
| **实际路由验证**（播 2s 静音时 `pactl list short sink-inputs`） | `tts.sink="hdmi"` → sink-input 挂到 **index 78 alsa_output...hdmi-stereo**；`tts.sink=""` → 挂到 index 56 analog-stereo（正是房间没声音的那块） |
| 长文本完整性 | 8 句一次说：8 条 `task_continue` 顺序正确、sink 字节逐字节符合；72 字回复经本地 paraformer 回读，4/5 音色 CER=0.0%、qingse 1.5%（仅「加/伽」同音字） |

音色/模型对比（中位数，3 次 × 5 音色；`字/s` 由合成音频时长与字符数算出，反映语速）：

| model | voice | TTFB(ms) | gen(ms) | 字/s |
|---|---|---|---|---|
| speech-2.6-turbo | male-qn-jingying | 208 | 315 | 5.72 |
| speech-2.6-turbo | male-qn-qingse | 196 | 347 | 4.99 |
| speech-2.6-turbo | Chinese (Mandarin)_Gentleman | 233 | 352 | 5.45 |
| speech-2.6-turbo | Chinese (Mandarin)_Radio_Host | 189 | 308 | 5.82 |
| speech-2.6-turbo | Chinese (Mandarin)_Male_Announcer | 239 | 379 | 4.66 |
| speech-2.8-turbo | male-qn-jingying | 192 | 338 | 5.62 |
| speech-2.8-turbo | male-qn-qingse | 207 | 364 | 4.53 |
| speech-2.8-turbo | Chinese (Mandarin)_Gentleman | 223 | 418 | 5.55 |
| speech-2.8-turbo | Chinese (Mandarin)_Radio_Host | 218 | 379 | 5.3 |
| speech-2.8-turbo | Chinese (Mandarin)_Male_Announcer | 212 | 364 | 5.21 |
| speech-02-turbo | male-qn-jingying | 264 | 413 | 5.62 |
| speech-02-turbo | male-qn-qingse | 231 | 402 | 5.3 |
| speech-02-turbo | Chinese (Mandarin)_Gentleman | 243 | 421 | 5.55 |
| speech-02-turbo | Chinese (Mandarin)_Radio_Host | 256 | 412 | 5.45 |
| speech-02-turbo | Chinese (Mandarin)_Male_Announcer | 238 | 519 | 4.6 |

模型汇总：2.6-turbo = TTFB 208ms / gen 347ms；2.8-turbo = 212ms / 364ms；02-turbo = 243ms / 413ms。
音色汇总（跨 3 模型）：jingying 208ms/338ms、qingse 207/364、Gentleman 233/418、Radio_Host 218/379、Announcer 238/379。

**试听文件**（`tests/tts/out/`，git-ignored）：同一句 13 字的 15 个组合
`<model>__<voice>.wav`，以及 72 字回复的 5 个 `preview__*.wav`（2.6 与 2.8 同音色可直接 A/B）。

## 音色/模型选型建议

**推荐（保持现有默认值）：`speech-2.6-turbo` + `male-qn-jingying`。**
- 速度全面最快：所有 15 个（模型×音色）组合里，2.6-turbo 的协议 TTFB 中位 208ms、gen 中位 347ms；
  同音色下比 2.8-turbo 快 4ms（首包）/17ms（整句合成），真机端到端首字中位 **208ms vs 225.5ms**。
- 音色 `male-qn-jingying`（精英青年）跨模型综合最快（TTFB 208ms / gen 338ms），
  语速 5.62 字/s，F0 中位实测 108–154Hz（随模型/语句波动，成年男声区间），成熟不油腻。
- 2.6-turbo 是官方定位「更快更优惠，更适用于语音聊天和数字人场景」的模型；价格与 2.8 相同（2.00 元/万字符）。
- 当前 `src/config.js` 与 `~/.config/figaro/config.json` 里的默认值就是这一组，**无需改配置**。

**备选（若人耳更喜欢新一代音色）：`speech-2.8-turbo` + `male-qn-jingying`。**
代价：端到端首字 +~17ms（仍 <250ms），同文本语速慢约 15%（72 字：13.3s → 15.5s），人耳可能更「从容」。
换法只是一行 config：`minimax.model = "speech-2.8-turbo"`。

其他可用男声（全部实测可用、无权限问题）：
- `Chinese (Mandarin)_Gentleman`（温润男声）：F0 最低 ~108Hz，韵律变化最小（8.4 半音），最沉稳；
- `Chinese (Mandarin)_Radio_Host`（电台男主播）：F0 变化最大（10.4–12.3 半音）、字速最快 5.82 字/s，播报感；
- `Chinese (Mandarin)_Male_Announcer`（播报男声）：语速最慢（4.66 字/s），新闻腔；
- `male-qn-qingse`（青涩青年）：语速偏慢（4.99 字/s）、音调更高。
自然度无法自动量化，最终请用人耳听 `tests/tts/out/preview__*.wav` 决定。

## 测试

```bash
# 单元测试（不联网、不出声、不花额度；文件 sink 假播放）
node --test tests/tts/*.test.js

# 真机 smoke：真合成 + 真播放，打印首字延迟与 sink（默认 5 次；--no-play 静音）
node tests/tts/smoke.mjs --runs=5
node tests/tts/smoke.mjs --runs=5 --sink=hdmi                  # 指定输出设备
node tests/tts/smoke.mjs --pcm=tests/tts/out/ack.pcm --sink=hdmi --runs=3  # 静音验证 playPcm 路由
node tests/tts/smoke.mjs --no-play --text="费加罗，你好。" --capture=tests/tts/out/smoke.wav

# 音色/模型对比（会消耗 API 额度；默认 5 个男声 × 3 个 turbo 模型 × 3 次，带 RPM 限速）
node tests/tts/bench-voice.mjs
```

`tests/tts/out/` 已被 `.gitignore` 忽略（试听 wav / bench JSON 不进仓库）。

## 已知限制 / 风险

- **RPM 20**：一句一个 `task_continue`，所以一篇 20 句的长回复会顶满一分钟配额。
  模块有主动限速（排队等窗口，不报错），但极端长回复可能出现句间等待。
  若 daemon 愿意牺牲一点首字延迟，可以把相邻几句合并成一个 `task_continue` 来省 RPM。
- **首字延迟包含 TTS 的前导静音**：同一句的音频开头实测有 100–164ms 静音（最短样本 107ms，
  smoke 抓到的样本 164ms），所以「首包到达」到「真正听见人声」还有 ~0.1–0.2s，再加 PipeWire 40ms 缓冲。
  没有裁剪前导静音（怕切到气声/辅音）。
- **只有 PCM 路径**：服务端若忽略 `format:"pcm"` 返回 mp3，本模块不会自动解码（实测没有发生）。
- `speak()` 的 Promise 在**入队后**立即 resolve，不代表播完；等播完请用 `flush()`。
- `stop()` 会断开 WSS；下一次 `speak()` 需要重新建连（~150ms），换来的是打断后服务端不会继续烧合成。
- 电平是原始 RMS（不放大），UI 侧需要按需缩放。
- `pw-cat` 对不存在的 `--target` **不会报错**（实测 exit 0），所以 sink 校验只能在启动时用
  `pactl` 做；运行中 sink 消失/切换（拔显示器、切默认设备）时首次异常会 warn 一次并回退默认 sink。
- 运行中会话中途用户改了系统默认 sink：已配置了 `tts.sink` 的不受影响（推荐显式配置）；
  没配置的目标是"系统默认"，是否跟随切换取决于 PipeWire/pw-cat 自身行为。
- `playPcm` 不混音、不排队：适合唤醒应答/提示音，不要拿它在长回复中途插播。
- 自然度无法自动量化：本目录只提供客观时延/语速数据 + WAV 试听文件，最终音色由人耳和 Lead 定。
