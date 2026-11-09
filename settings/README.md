# 费加罗设置 / 自测面板（`qs -c figaro-settings`）

macOS 系统设置风格的独立 Quickshell 窗口，既是设置面板，也是**误唤醒/环境音/麦克风/识别**
的完整自测工具。七页：概览、唤醒、交互、麦克风、语音、识别、诊断。

```
settings/
├── shell.qml              # Quickshell 入口：FloatingWindow + IpcHandler 自测钩子
├── App.qml                # 标题栏 + sidebar + 七页堆栈
├── Theme.qml / Ipc.qml    # 单例：macOS 深色主题 / NDJSON IPC 客户端（docs/ipc.md §3+§3.1）
├── components/            # 自绘控件：Toggle/Slider/Segmented/电平条/下拉/卡片/交通灯…
├── pages/                 # 七个分区（交互 = barge-in / 等待窗口 / 退下·取消短语）
├── kwin-noborder.js       # 运行时 KWin 脚本：去掉服务端标题栏（否则会和 macOS 标题栏重复）
├── ctl.sh                 # start/stop/restart/logs/deploy/install-desktop
└── test/
    ├── fake-daemon.mjs    # 假 daemon：实现 §3.1 全部消息（默认 socket 在 figaro-settings-test/）
    ├── legacy-daemon.mjs  # 只有 §3 的旧 daemon：验证“当前 daemon 不支持此功能”降级
    ├── protocol-smoke.mjs # 线协议 16 项冒烟测试
    ├── dev.sh             # 开发：假 daemon + 仓库内直跑 GUI（热重载）
    ├── shoot.sh           # 自测证据：逐页截图 + 断言 + 导出 CSV/JSON 副本
    └── out/               # 截图、status.json、导出文件副本（提交里的验收证据）
```

## 启动

```bash
# 生产 daemon（默认 $XDG_RUNTIME_DIR/figaro/sock）
settings/ctl.sh restart

# 接假 daemon 演示（绝不碰生产 socket）
node settings/test/fake-daemon.mjs &
FIGARO_SOCKET=/run/user/1000/figaro-settings-test/sock settings/ctl.sh restart

# 装桌面入口（Exec 为 `env QT_QUICK_BACKEND=software ~/.local/bin/qs -c figaro-settings`）
settings/ctl.sh install-desktop
```

GUI 只读取 `FIGARO_SOCKET` 环境变量决定连接目标，默认生产 socket。

## 自测 / 证据

```bash
# 开发：假 daemon + 从仓库直接跑（改 QML 会热重载）
settings/test/dev.sh restart

# 线协议冒烟
XDG_RUNTIME_DIR=/run/user/1000 node settings/test/protocol-smoke.mjs

# 一键截图 + 断言（把截图和导出文件写进 settings/test/out/）
FIGARO_SETTINGS_IPC=config settings/test/shoot.sh
```

`shoot.sh` 会驱动 GUI 做：唤醒测试（KWS 分数/命中/延迟）、环境音抑制统计（误唤醒表格 +
CSV）、麦克风实时电平与底噪测量、TTS 首字延迟、识别流式 partial vs final 与字级正确率、
诊断 JSON 导出、复制日志；以及 task-8 新增的打断/等待窗口/退下·取消短语/中英唤醒词/音色
写回验证（截图 10–15，断言新字段真的写进 daemon 的 config.json 并被诊断接口回读）。
最后断言状态并打印 PASS/FAIL；也可以用 `qs ipc call figaro-settings writeB64 <path> <base64-json>`
单独写一个字段。

## 与 daemon 的兼容

- 全部读写走 `docs/ipc.md` §3.1；`config.set` 只写 daemon 白名单里的键。
- 每条请求带 deadline：daemon 不认该消息时超时 → 标记 `unsupported`，页面显示
  “当前 daemon 不支持此功能”，绝不挂起（用 `legacy-daemon.mjs` 验证）。
- 真 daemon 已实现的 `diagnostics` 字段（`asr.modelInfo`、`latency.ttsRequestToFirstAudioMs`、
  `recentErrors[].at`、`tts.sinks[{name,description,isDefault,isCurrent}]` 等）与假 daemon 双兼容。

## 新增配置项与热生效矩阵（task-8）

设置面板新增：**交互**页（打断 `asr.bargeIn.*`、回答后等待 `interaction.*`、退下/取消短语）、
唤醒页的中英双语唤醒词编辑（`asr.wakeWords` / `asr.wakeWordsEn`）与灵敏度实测标注、
语音页的音色下拉（`tts.voiceId`）。每个控件改动都会立即 `config.set` 写回，并在控件旁显示
“已生效 / 已写入·需重启 daemon / daemon 未开放此配置（白名单缺失）”。

| 字段 | GUI 控件 | 写入后实际效果 | 说明 |
|---|---|---|---|
| `asr.sensitivity` | 唤醒页 Segmented | **已生效（热）** | daemon `ASR_HOT_PATHS` 重建 KWS |
| `asr.wakeCooldownMs` | 唤醒页滑块 | **已生效（热）** | 同上 |
| `asr.inputGainPercent` | 麦克风页滑块/校准 | **已生效（热）** | 同上 |
| `tts.voiceId` / `tts.speed` / `tts.sink` / `tts.model` | 语音页下拉/滑块 | **已生效（热）** | daemon 重建 TTS 连接 |
| `tts.ack.*` | 语音页 | **已生效（热）** | daemon 重建 ack 缓存 |
| `asr.bargeIn.enabled/minRms/echoFactor/minMs` | 交互页 | **需重启 daemon** | ASR 模块已有 `applyRuntimeConfig({bargeIn})` 热切换，但 daemon 没接线 |
| `interaction.followUpWindowMs/followUpMinRms/followUpMinMs` | 交互页 | **需重启 daemon** | daemon 启动时读成常量 |
| `interaction.dismissPhrases/cancelPhrases` | 交互页 chips | **需重启 daemon** | 同上 |
| `asr.wakeWords` / `asr.wakeWordsEn` | 唤醒页 chips | **需重启 daemon** | KWS 关键词文件在模块启动时生成 |
| `asr.enabled` | 唤醒页开关 | **需重启 daemon** | 设计如此 |

**daemon 侧缺口（不在本 GUI 写作用域，需 Lead/figaro-brain 处理）**
1. `src/agent/settings.js` 的 `ALLOWED_CONFIG_PATHS` 缺：`asr.bargeIn.enabled|minRms|echoFactor|minMs`、
   `asr.wakeWordsEn`、`interaction.followUpWindowMs|followUpMinRms|followUpMinMs|dismissPhrases|cancelPhrases`。
   在此之前真 daemon 会拒绝写入（GUI 显示红字“daemon 未开放此配置”，用户配置不会被改）；假 daemon 已接受并验证全链路。
2. `src/config.js` 的 `DEFAULTS` 缺 `asr.wakeWordsEn`（ASR 模块有 `['figaro','hey figaro']` 兜底，但示例配置里看不到）。
3. 若要真正热生效：把 `bargeIn.*` 加进 `ASR_HOT_PATHS` 并在 `applyAsrRuntime` 里映射到
   `asr.applyRuntimeConfig({bargeIn:{...}})`；`interaction.*` 需要 daemon 提供运行时 setter（或明确保持重启生效）。

## 待 Lead 集成（install.sh）

1. 部署：`rsync -a --delete settings/ ~/.config/quickshell/figaro-settings/ --exclude ctl.sh --exclude test --exclude '*.md'`
   （或直接 `settings/ctl.sh deploy`）。
2. 桌面入口：`install -m 644 systemd/figaro-settings.desktop ~/.local/share/applications/figaro-settings.desktop`
   （或 `settings/ctl.sh install-desktop`）。
3. 可选：给设置面板加 systemd user unit（`ExecStart=…/qs --no-duplicate -c figaro-settings`，
   `Environment=QT_QUICK_BACKEND=software`），需要常驻时再装；当前按需启动即可。
4. KWin 标题栏：GUI 启动时会通过 `qdbus6 org.kde.KWin /Scripting` 加载 `kwin-noborder.js`
   去掉服务端装饰（运行时脚本，不落盘、不改用户配置；`FIGARO_SETTINGS_NOBORDER=0` 可关闭）。
   若目标环境禁用 KWin 脚本，窗口会保留原生标题栏，功能不受影响。
