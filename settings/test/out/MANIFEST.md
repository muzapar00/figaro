# 验收证据清单（settings/test/out）

生成方式（假 daemon，测试 socket，绝不碰生产 socket；task-8 新字段的写回也由同一脚本验证）：

> 新增控件验收：`10`–`15` 来自 `shoot.sh` 的 task-8 段落，run 时会通过 `act interaction-demo`
> / `act wake-demo` / `act voice-demo` 和 `writeB64` 把新字段写进假 daemon 的 config.json，
> 再用 22 条断言检查「GUI 快照 / 每字段状态 / daemon 回读 / config.json」四处一致
> （见 shoot.sh 输出 `[shoot] task-8 new config fields`）。真 daemon 的缺口证据见 `16`–`18`。

```bash
node settings/test/fake-daemon.mjs &                 # 默认 /run/user/1000/figaro-settings-test/sock
FIGARO_SOCKET=/run/user/1000/figaro-settings-test/sock settings/ctl.sh restart
XDG_RUNTIME_DIR=/run/user/1000 node settings/test/protocol-smoke.mjs
FIGARO_SETTINGS_IPC=config settings/test/shoot.sh
```

## 截图（六分区 + 测试态 + 真 daemon + 旧 daemon 降级）

| 文件 | 分区 | 证明 |
|---|---|---|
| `1-overview.png` | 概览 | 服务状态/模型/语音能力/四项延迟/版本，接假 daemon 时 diagnostics 全量 |
| `2-wake-settings.png` | 唤醒 | 总开关、灵敏度 low/medium/high、防抖冷却、唤醒词、热键、重绑入口 |
| `2b-wake-test-running.png` | 唤醒测试 | KWS 分数条在动、测试倒计时、命中/延迟/最高分实时更新 |
| `2c-wake-test-result.png` | 唤醒测试 | 15 秒窗口结束后的命中统计 |
| `2d-wake-test-stats.png` | 唤醒测试 | 统计行特写：命中次数 / 平均命中延迟 / 最高分 / 漏检 |
| `3-ambient-test-table.png` | 环境音抑制测试 | 播放背景音期间的误唤醒统计表（时间/分数/KWS 命中/误触发/延迟）+ 误唤醒率 |
| `4-mic-settings.png` | 麦克风 | 设备、0–100% 增益滑块、自动校准、恢复自动 |
| `4b-mic-level-live.png` | 麦克风 | 20Hz 电平条实时跳动（40+ 帧）、RMS/PEAK 数值、峰值标记 |
| `4c-mic-noise-floor.png` | 麦克风 | 静音 3 秒底噪测量结果 + 建议增益（可一键应用） |
| `5-voice-tts.png` | 语音 | 输出 sink 下拉（含“默认/当前”标记）、试听首字延迟 188–297ms、语速、应答短语 |
| `6-asr-streaming.png` | 识别 | 流式 partial 逐条出现（10 条）、录音中状态 |
| `6b-asr-result.png` | 识别 | 流式最终文本 vs 离线最终转写、字级正确率 100% / 94.7%、音频时长/耗时/实时率 |
| `7-diagnostics.png` | 诊断 | config/socket/sink 路径、重启按钮（二次确认）、复制日志、导出 JSON |
| `7b-diagnostics-capabilities.png` | 诊断 | §3.1 能力探测表 + 最近错误 + 已导出路径 |
| `8-real-overview.png` | 真 daemon | 生产 socket（`/run/user/1000/figaro/sock`）连上，真实版本/运行时长/能力 |
| `8b-real-voice-sinks.png` | 真 daemon | 真 daemon 的 `diagnostics.tts.sinks`（pactl 枚举）填充下拉 |
| `8c-real-wake.png` | 真 daemon | 从真实 `config.json` 读到的灵敏度/冷却/唤醒词/热键 |
| `8d-real-diagnostics.png` | 真 daemon | 真实 configPath、journalctl 日志、版本/运行时长 |
| `8e-real-capabilities.png` | 真 daemon | 真 daemon 上 config.get/set/diagnostics 已支持，未测试项标注“未探测” |
| `9-legacy-overview.png` | 旧 daemon | 只有 §3 的 daemon：概览显示“不支持 diagnostics”降级说明，不崩溃 |
| `9b-legacy-wake-unsupported.png` | 旧 daemon | 唤醒页显示“当前 daemon 不支持此功能（test.wake.arm 未响应）”，按钮复位 |
| `9c-legacy-mic-unsupported.png` | 旧 daemon | 麦克风页同样降级（test.mic.start 未响应），无卡死 |
| `9d-legacy-interaction.png` | 旧 daemon（task-8） | 交互页在只有 §3 的 daemon 上照常渲染（显示默认值），不崩溃 |
| `9e-legacy-write-unsupported.png` | 旧 daemon（task-8） | 对旧 daemon 写 `asr.bargeIn.minRms`：3 秒无响应后红字「config.set 未响应（daemon 可能不支持写入）」，不挂起 |
| `10-interaction-bargein.png` | 交互（task-8） | 打断 barge-in：开关 + minRms/echoFactor/minMs 滑块（带实测参考刻度），每个控件旁显示写回状态；底部是 daemon 回读的有效值 |
| `11-interaction-followup.png` | 交互（task-8） | 回答后等待：0/3/5/7/10 秒 Segmented（当前 7000ms）+ followUpMinRms/MinMs 滑块 + 写回状态 |
| `12-interaction-phrases.png` | 交互（task-8） | 退下短语 / 取消短语 chips 增删（含新增「告退」），恢复默认 + 写回状态 |
| `13-wake-sensitivity.png` | 唤醒（task-8） | 灵敏度三档旁标注实测数字（中文 8/8、英文 20/20、近音 2/40、误唤醒 3/15.2min）与延迟，热改显示「已生效」 |
| `14-wake-words.png` | 唤醒（task-8） | 中英双语唤醒词 chips 编辑 + 英文唤醒开关 + 当前模型 `zh-en-3M-2025-12-20` 说明 + 写回状态 |
| `15-voice-timbre.png` | 语音（task-8） | 音色下拉（5 个实测男声候选）+ 试听当前音色 + 首字延迟实测范围；改动显示「已生效」（热生效） |
| `16-real-daemon-forbidden.png` | 真 daemon（task-8） | 对真 daemon 写 `asr.bargeIn.minRms`：daemon 白名单未开放 → 红字「daemon 未开放此配置」，用户 config.json 未被修改（md5 前后一致） |
| `17-real-daemon-forbidden-followup.png` | 真 daemon（task-8） | 对真 daemon 写 `interaction.followUpMinRms`：同样被白名单拒绝，界面如实显示缺口 |
| `18-real-daemon-forbidden-phrases.png` | 真 daemon（task-8） | 对真 daemon 写 `interaction.dismissPhrases`：同样被白名单拒绝，展示真实配置值 |
| `19-real-daemon-applied.png` | 真 daemon（task-8） | 对真 daemon 写白名单内的热字段 `asr.wakeCooldownMs`（写入同值 2500，不改变行为）：GUI 显示「已生效」，daemon 回读 2500，`~/.config/figaro/config.json` 由 daemon 原子写回 |

## 数据/日志

| 文件 | 说明 |
|---|---|
| `status.json` | shoot.sh 收尾时的 GUI 全量状态快照（唤醒分数样本数、命中、环境音行数、麦克风样本、TTS ms、ASR partial/结果/正确率、导出路径，以及 task-8 的 interaction 快照 / `fieldStatus` 每字段写回状态 / `daemonDiagnostics` 回读） |
| `diagnostics-export.json` | GUI「导出诊断报告」实际写出的文件副本（来自 `~/figaro-diagnostics-<ts>.json`） |
| `ambient-export.csv` | GUI「导出 CSV」实际写出的环境音误唤醒表格副本（来自 `~/figaro-ambient-<ts>.csv`） |
| `protocol-smoke.log` | 假 daemon 的 §3+§3.1 线协议冒烟：16/16 通过 |
| `gui-startup.log` | `settings/ctl.sh restart` 的启动日志：含 `Configuration Loaded`，**0 条 QML ERROR/TypeError** |
| `legacy-daemon.log` | 旧 daemon 日志：可见它忽略了 config.get/diagnostics/test.* 消息（GUI 据此降级） |
