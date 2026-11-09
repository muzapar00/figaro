# 费加罗设置 / 自测面板（`qs -c figaro-settings`）

macOS 系统设置风格的独立 Quickshell 窗口，既是设置面板，也是**误唤醒/环境音/麦克风/识别**
的完整自测工具。六页：概览、唤醒、麦克风、语音、识别、诊断。

```
settings/
├── shell.qml              # Quickshell 入口：FloatingWindow + IpcHandler 自测钩子
├── App.qml                # 标题栏 + sidebar + 六页堆栈
├── Theme.qml / Ipc.qml    # 单例：macOS 深色主题 / NDJSON IPC 客户端（docs/ipc.md §3+§3.1）
├── components/            # 自绘控件：Toggle/Slider/Segmented/电平条/下拉/卡片/交通灯…
├── pages/                 # 六个分区
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
诊断 JSON 导出、复制日志；最后断言状态并打印 PASS/FAIL。

## 与 daemon 的兼容

- 全部读写走 `docs/ipc.md` §3.1；`config.set` 只写 daemon 白名单里的键。
- 每条请求带 deadline：daemon 不认该消息时超时 → 标记 `unsupported`，页面显示
  “当前 daemon 不支持此功能”，绝不挂起（用 `legacy-daemon.mjs` 验证）。
- 真 daemon 已实现的 `diagnostics` 字段（`asr.modelInfo`、`latency.ttsRequestToFirstAudioMs`、
  `recentErrors[].at`、`tts.sinks[{name,description,isDefault,isCurrent}]` 等）与假 daemon 双兼容。

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
