# 唤醒与终止：交互状态机

目标：不管用户从哪条路进来、想在哪一步停下，行为都必须是确定的、可解释的、可打断的。
参照 Siri 的几条硬规则：

1. **任何时刻都能打断**：说话中、思考中、播放中，新唤醒或"取消"永远优先，绝不排队。
2. **不阻塞**：打断要立刻停（TTS 停声、LLM 请求 abort），不做完再停。
3. **不自我触发**：助手自己发声期间不监听唤醒词（已经实现，见 `fix(daemon): stop the wake word from hearing Figaro's own voice`）。
4. **沉默就退出**：唤醒后用户没说话，等一小会儿自己退出，不追问、不报错。
5. **一次只做一件事**：任何时刻只有一个 turn；新 turn 开始时旧 turn 必须被 abort。

## 状态

```
idle ──wake──► waking(ack) ──► listening ──speechEnd──► finalizing ──► thinking ──► speaking ──► idle
  ▲                │                │                       │                │             │
  └────────────────┴──cancel/giveUp─┴───────────────────────┴────cancel─────┴──cancel─────┘
```

- `waking`：播唤醒应答（预合成缓存），最长 `tts.ack.timeoutMs`（800ms）。
- `listening`：VAD + 转写；`wakeGiveUpMs`（默认 5000）内没有任何语音 → 静默回 idle。
- `finalizing`：等离线模型出最终文本（一般 <150ms）。
- `thinking`：DeepSeek 工具循环。
- `speaking`：TTS 播放（含多句排队）。

## 唤醒路径（4 条，行为一致）

| 来源 | 触发 | 说明 |
|---|---|---|
| 语音唤醒词 | KWS 命中（灵敏度 low/medium/high + 冷却 `wakeCooldownMs`） | 最常用 |
| 热键 | `asr.hotkey`（当前 F9）**长按 ≥ `longPressMs`** | push-to-talk |
| 界面 | 点桌面球体（idle 状态时） | 等同唤醒 |
| 文本 | `ask` / UI 输入框 | 跳过 listening，直接 thinking |

共同规则：
- 唤醒时若已有 turn 在跑 → **abort 旧 turn**
- 唤醒时若 TTS 正在说话 → **立刻 stop TTS**（barge-in）
- 唤醒应答只在"语音/热键/界面"这 3 条路播；文本 `ask` 不播
- `waking` 期间再次唤醒 → 忽略（防抖），但"用户已经开始说话"则**立刻停 ack 进 listening**
- 唤醒词在 TTS 发声期间被 mute，不自我触发；`ui`/`hotkey` 唤醒不受 mute 限制（主动打断用）

## 唤醒应答（ack）

唤醒后先在 `waking` 状态播一句短的应答，让用户立刻知道"它醒了"，然后马上进入 listening。

- **短语**：默认 10 句（`tts.ack.phrases`）：
  `我在`、`在的`、`你好`、`嘿`、`有何贵干`、`来了`、`听着呢`、`请讲`、`久等了`、`你说`。
  全部是口语短句、不带标点——TTS 会把问号/句号读成额外停顿或语气，`有何贵干？` 的问号反而不自然。
- **随机且不重复**：每次唤醒随机挑一句；`tts.ack.avoidRepeat`（默认 `true`）保证不会连续两次同一句，
  否则用户会以为只有一句（之前 3 句时听到两次"在的"就是这么来的）。
- **预合成缓存**：daemon 启动后在后台按 **最多 3 路并发**（`tts.ack.synthConcurrency`，默认 3，范围 1–5）
  用 TTS 模块的 `synthesize()` 预合成全部短语，音频进内存；唤醒时直接 `playPcm()`，实测唤醒→首声
  中位 ~196ms（冷启动也一样，不走网络）。
  实测：3 句串行 ~2.0s → 10 句 3 路并发 ~1.9s（单句 MiniMax 往返 ~0.45–0.55s）。
  个别短语合成失败只 warn 并跳过（用剩下的句子），全部失败才降级为"唤醒后立刻 listening、不播应答"。
- **超时/降级**：唤醒→首声超过 `tts.ack.timeoutMs`（默认 800ms）或合成不可用时，直接进入 listening，
  不阻塞、不报错；唤醒词监听在 ack 播放期间保持 mute（回声抑制）。

## 终止路径（必须全部实现）

| 场景 | 触发 | 期望行为 |
|---|---|---|
| 说话结束 | VAD 静音 `silenceStopMs`(900) | finalize → thinking |
| 用户不说话 | 唤醒后 `wakeGiveUpMs`(5000) 无语音 | 静默回 idle（不播任何声音、不报错） |
| 说得太久 | `maxCaptureMs`(15000) | 截断并照常 finalize |
| 显式取消（语音） | 转写命中取消词：取消/算了/别说了/停下/停止/不用了/退出 | 不调 LLM，直接回 idle；正在播就停声 |
| 显式取消（界面） | 点球体（非 idle 状态）/ 再点麦克风 | 立即 stop TTS + abort LLM → idle |
| 显式取消（热键） | **短按** F9（< `longPressMs`，不同于长按唤醒） | 同"显式取消"；Siri 的"点一下让它闭嘴" |
| 打断重问 | 任意状态下再次唤醒 | abort 旧的、开新的（见上） |
| 说话中想插话 | TTS 播放期间检测到用户开口（VAD onset，KWS 仍 mute） | 立刻 stop TTS → waking(ack) → listening |
| 模型/网络出错 | `onError` | 日志 + 回 idle；已经播的部分停掉；不崩 |
| TTS 失败 | `onError` | 文本回复照常显示，静默回 idle |
| 播放自然结束 | `flush()` resolve | 回 idle（可选 follow-up 窗口，见下） |
| 服务重启 | systemd restart | 客户端重连；状态回 idle |

## 回答问题后的等待窗口（waiting）

`interaction.followUpWindowMs`（用户要求设为 **7000**，0 = 关闭）。

回复播完后**不再立刻消失**：状态进入 `waiting`，字幕先收回（胶囊塌回球），球以倾听的蓝色
安静停留在屏幕顶部。这段时间：

- **不录音、不转写**（避免把环境音当指令）；
- 只监测麦克风电平：超过 `followUpMinRms`（默认 0.10）并持续 `followUpMinMs`（默认 250ms）
  的真人才算"继续说话"，此时**不播 ack**、直接进入 listening；
- 唤醒词在这个窗口里仍然有效（走正常 ack 流程）；
- 窗口内没有达到门槛的声音 → 7 秒后静默回 idle，球沿进入的同一路径上收消失。

小声说话（约 <0.05）、键盘声、音乐背景（约 0.01–0.03）都低于门槛，不会触发。

## 打断的"硬"要求

- `cancel` 必须在 **100ms 内**让声音停止（TTS `stop()` 实测 1.9–2.0ms）并 abort LLM（AbortSignal）。
- `cancel` 后不得发出 `reply` 事件（UI 不应显示已取消的回答）。
- `cancel` 后必须保证唤醒监听恢复（`setMuted(false)` 幂等），否则助手会"聋掉"。
- 任何路径（含异常）结束 turn 都必须回 `idle` 并把 `muted` 复位——用 finally/统一收尾，不靠每个分支自觉。

## 配置项（新增）

```jsonc
{
  "asr": {
    "longPressMs": 260,        // 长按阈值：达到=唤醒，未达=短按取消
    "silenceStopMs": 3000,     // 多久静音算一句结束（900ms 会打断说话人）
    "wakeGiveUpMs": 7000,      // 唤醒后多久没说话就退出
    "wakeCooldownMs": 2500     // 两次唤醒最小间隔
  },
  "interaction": {
    "cancelPhrases": ["取消","算了","别说了","停下","停止","不用了","退出"],
    "followUpWindowMs": 0      // 0 = 关闭连续对话
  }
}
```


## 声纹：只认你的声音（可选）

唤醒词是"声音的模式"，所以音乐里出现近似发音也可能触发。声纹校验解决"是谁说的"：

```bash
figaro enroll-voice            # 录 3 句（每句 3 秒），写入 ~/.config/figaro/speaker-profile.json
systemctl --user restart figaro
figaro status                  # 看「声纹: 就绪（阈值 0.65，已过滤 N 次非本人唤醒）」
```

- 实现：sherpa-onnx 的 CAM++ 说话人嵌入模型（`models/speaker/…onnx`，
  `scripts/fetch-models.sh --only=speaker` 下载），本地计算余弦相似度，不联网。
- 校验时机：KWS 命中后，用**包含唤醒词的 pre-roll（~1.5s）**做声纹比对；不通过就
  当作没听见——**不播应答、不开麦、不进 thinking**，零打扰。
- 热键 F9 不受声纹限制（按键本身就是你）。
- 降级：`asr.speaker.enabled=false`、没录过声纹、模型缺失时，全部退回"只认唤醒词"，
  不会因为声纹把助手变成聋子。
- 调参：`asr.speaker.threshold`（默认 0.65；同一人自相似度实测约 0.85–0.95，
  不同人约 0.2–0.45）。如果自己的声音被误拒，先降到 0.55 再试；误唤醒仍多就升到 0.72。
- 隐私：声纹档案在 `~/.config/figaro/`（0600），不进仓库、不进日志、不上传。

## 验收清单（每条都要有测试）

1. 4 条唤醒路径都进 listening，且都会 abort 正在跑的 turn。
2. waking 期间用户说话 → ack 立刻停 → listening。
3. listening 5s 无语音 → 静默 idle（无 ack、无 error）。
4. 语音说"取消" → 不产生 LLM 调用；thinking 中说 → 立即 abort；speaking 中说 → 立刻停声。
5. 短按热键 → 取消；长按热键 → 唤醒（两个方向都要测）。
6. speaking 期间检测到用户开口 → barge-in（停 TTS → ack → listening）。
7. 任意取消/异常路径后：`state=idle`、`muted=false`、唤醒监听仍在（用 `diagnostics` 断言）。
8. `followUpWindowMs>0` 时：回复后直接说话可进 listening；超时回 idle。
9. 声纹：本人唤醒通过；他人/音乐唤醒被拒且不播应答；模型缺失/未注册时退回纯唤醒词。
