# 费加罗设置 / 自测面板（`qs -c figaro-settings`）

macOS 系统设置风格的独立 Quickshell 窗口，既是设置面板，也是**误唤醒/环境音/麦克风/识别**
的完整自测工具。常用页只保留 5 个（概览、新手引导、模型服务、外观、连接），其余 6 个（唤醒、
交互、麦克风、语音、识别、诊断）收进侧边栏「高级」折叠组；界面支持简体中文 / 繁體中文 / English
三语，默认跟随系统 locale。

```
settings/
├── shell.qml              # Quickshell 入口：FloatingWindow + IpcHandler 自测钩子
├── App.qml                # 标题栏 + sidebar + 页面堆栈（5 常用 + 6 高级）
├── Theme.qml / Ipc.qml    # 单例：macOS 深色主题 / NDJSON IPC 客户端（docs/ipc.md §3+§3.1）
├── I18n.qml / i18n/       # 三语单例 + en.js / zh-TW.js 词表（source-string 键，672 条）
├── components/            # 自绘控件：Toggle/Slider/Segmented/电平条/下拉/卡片/交通灯/信息弹窗…
├── pages/                 # 11 个分区（新手引导 / 模型服务 / 外观 / 连接 / 唤醒 / 交互 / 麦克风 / 语音 / 识别 / 诊断 / 概览）
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
诊断 JSON 导出、复制日志；task-8 的打断/等待窗口/短语/中英唤醒词/音色写回；task-12 的
外观四字段、两个 API Key（占位值）、ASR 模型路径、音效音量，以及**完整的 9 步新手引导**
（截图 20–31，断言向导 5/5 通过）。最后断言状态并打印 PASS/FAIL；也可以用
`qs ipc call figaro-settings writeB64 <path> <base64-json>` 单独写一个字段。

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
| `asr.bargeIn.enabled/minRms/echoFactor/minMs` | 交互页 | **已生效（热）** | daemon 已接线 ASR `applyRuntimeConfig({bargeIn})` |
| `interaction.followUpWindowMs/followUpMinRms/followUpMinMs` | 交互页 | **已生效（热）** | daemon 改成运行时重读，日志打 `interaction settings reloaded (...)` |
| `interaction.dismissPhrases/cancelPhrases` | 交互页 chips | **已生效（热）** | 同上 |
| `asr.wakeWords` / `asr.wakeWordsEn` | 唤醒页 chips | **需重启 daemon** | KWS 关键词文件在模块启动时生成 |
| `asr.enabled` | 唤醒页开关 | **需重启 daemon** | 设计如此 |

**daemon 侧状态（2026-11-09 已补齐并部署，已验证）**
- `ALLOWED_CONFIG_PATHS` 已包含 `asr.bargeIn.*`、`asr.wakeWordsEn`、`asr.verifyWake.enabled`、`interaction.*`；
  其中 `bargeIn.*` 走 ASR 热切换、`interaction.*` 运行时重读，真 daemon 写入返回 `applied`、`restartRequired: []`。
- 仍按“需重启 daemon”呈现的：`asr.wakeWords`、`asr.wakeWordsEn`（要重建 KWS 关键词表）、`asr.enabled`（设计如此）。
- 可选后续：`asr.verifyWake.enabled`（两段式唤醒校验）已进白名单且 ASR 模块支持热切换，但 GUI 还没做控件，
  需要时可加一个唤醒页开关；daemon 若要热生效需把它加进 `ASR_HOT_PATHS`。
- 真机验证记录：`settings/test/out/16`–`19-real-daemon-applied*.png` + `real-daemon-hot-apply.log`（写入均为用户当前值，config md5 前后一致）。

## task-12：外观 / 连接 / 模型路径 / 声音 / 引导向导（二期）

新增页面与能力：
- **外观**（`ui.scale` 0.5–2.0 滑块 + `ui.shape` 三种形状 + `ui.motion` 动画开关 +
  `ui.windowButtonSize` 12/16/20）：热生效，daemon 会广播 `{type:"ui", ...}`，设置窗口的
  交通灯也立刻跟着变；默认 16px（旧版 12px）。
- **连接**（`deepseek.apiKey` / `minimax.apiKey`）：`MTextField` 密码模式，**只写不读**，
  输入框保存后立即清空；config.get 只回传 `***`，因此界面只显示“已保存（掩码）/未设置”，
  绝不显示完整 key。带二次确认的“重启服务”按钮。
- **识别页模型路径**（`asr.modelDir`）：默认仓库自带中英双语模型，可填绝对路径并做
  encoder/decoder/joiner/tokens 轻量校验；写入后需重启 daemon。
- **音效**（`sfx.enabled` / `sfx.volume`）：语音页新增开关 + 0–1 音量滑块（默认 0.35），
  说明“音效比语音低 4–6 dB，不会盖住说话”。
- **新手引导**（概览页有入口）：v1.0 已升级为 9 步大字版（认识费加罗 / 隐私 / 语言 / 地区 /
  长期记忆 / 模型服务 / 语音服务 / 自检 / 完成），详见下一节。
- **简化界面**：侧边栏只保留 4 个常用页，其余 6 页在「高级」折叠组；唤醒页的热键/防抖、
  Mic 页的底噪测量、语音页的语速/唤醒应答都收进「高级」折叠卡片。

### task-12 字段热生效矩阵（真 daemon 实测见 `test/out/real-daemon-task12.log`）

| 字段 | 结果 |
|---|---|
| `ui.scale` / `ui.shape` / `ui.motion` / `ui.windowButtonSize` | **applied（热）**，并收到 `{type:"ui"}` 广播 |
| `deepseek.apiKey` | 当前 daemon 返回 **applied**（agent 每次请求读配置） |
| `minimax.apiKey` | TTS 可重建时 applied，重建失败时 restartRequired（临时 daemon `--no-tts` 实测 restartRequired） |
| `asr.modelDir` | **restartRequired**（要重启 daemon 重新加载 KWS 模型） |
| `sfx.enabled` / `sfx.volume` | 白名单已放行，但当前 daemon 的 applyConfigPatch **没有给 sfx 归类**（applied/restart 都为空）→ GUI 如实显示“已写入 · 未报告生效”，待 daemon 补重建音效模块 |

### 仍缺的 daemon 能力（task-12 报告）
1. `sfx.*` 需要 daemon 在 `applyConfigPatch` 里重建 sfx 模块并返回 `applied`（现在返回空列表）。
2. API Key 状态：`config.get` 对所有 secret 一律回 `***`，GUI 无法区分“已设置/未设置”，
   也拿不到尾号；建议 daemon 增加 `hasDeepseekKey`/`hasMinimaxKey` 布尔或尾号掩码。
3. （可选）`ui.scale` 文档范围 0.5–2.0；GUI 已按此范围实现。

## 声纹门控 + 家庭中枢 Home Assistant（三期）

### 唤醒页「声纹」卡片（`asr.speaker.*`）
- 开关写 `asr.speaker.enabled`、阈值滑块 0.35–0.90（步进 0.01，写入时由 settings 服务校验 0–1）
  写 `asr.speaker.threshold`；两项目前都按 **restartRequired** 处理（daemon 启动时加载 CAM++ 模型/档案）。
- 状态徽章 + 计数读 daemon diagnostics 的 `asr.speaker`（`ready / not-enrolled / model-missing / disabled`），
  显示「上次 score · 已检测 N 次 · 已过滤 N 次」；没有该字段的旧 daemon 显示「未提供」并降级。
- 「重新录制声纹」弹窗显示 `figaro enroll-voice`（设置窗口不能直接驱动录音），可一键复制
  （`wl-copy`，失败回退 `xclip`）；说明安静环境录 3 句、录完自动启用。

### 连接页「家庭中枢 Home Assistant」卡片（`home.*`）
- 字段：`home.haUrl`（地址，可省略 `http://`）、`home.haToken`（密码框，只写不读；`***` 不覆盖原值，
  只有用户输入新值才写）、`home.defaultRoom`（可选）。
- 保存沿用 `MApplyStatus`/`fieldStatus`；由于 daemon 只在启动时注册 home 工具，保存后统一提示
  「已保存，重启费加罗后生效」（settings 服务对 daemon 未归类的路径补 restartRequired）。
- 「测试连接」通过 settings 服务新增的 `home.test` 消息：Node 内置 `fetch` 请求 `${haUrl}/api/`，
  `Authorization: Bearer <token>`，4 秒超时；200→「已连接 Home Assistant」，401/403→「令牌无效」，
  其它/网络错误→「连不上 <url>」。**token 不写日志、不回显、不进截图/status 快照**；
  未填写新 token 时 daemon 用 config 里的已保存 token（GUI 传 `***` 视为“用已保存的”）。
- 单测：`tests/agent/settings.test.js` 覆盖 home.test 200/401/超时、stored-token 回退、
  home.* 写入掩码+需重启、声纹阈值写入/越界拒绝、`normalizeHaUrl`。

### 截图（`test/out/`）
`38-wake-speaker.png`（关闭态）、`39-wake-speaker-on.png`（开启+0.72+就绪徽章）、
`40-wake-enroll-dialog.png`（录制命令弹窗）、`41-api-home.png`（HA 卡片已保存/需重启）、
`42-api-home-test-ok.png`、`43-api-home-test-401.png`（两种连接测试结果）。

### 已知环境问题（与本次改动无关）
当前会话里 Qt **software** 后端启动 Quickshell 会段错误（`QWaylandShmBackingStore` 双绘制，
未修改的 HEAD 基线同样崩），因此 `settings/test/dev.sh` 新增 `FIGARO_SETTINGS_GL=1` 走 GPU；
`ctl.sh` 仍保留 `FIGARO_SETTINGS_GL=1` 开关。部署桌面入口默认 software，需要 Lead 决定是否切默认。

## v1.0：三语 i18n / 新手引导 / 服务商引导 / 通用 LLM（task-13）

### 三语界面（zh-CN / zh-TW / en）
- `I18n.qml` 单例 + `i18n/en.js`、`i18n/zh-TW.js` 词表，键是 **zh-CN 源字符串**（gettext 风格）：
  QML 里写 `I18n.t("唤醒")`，运行时按当前语言查表，查不到回退源串。
- 语言来源：`LC_ALL`→`LC_MESSAGES`→`LANG`→`LANGUAGE`；含 `hant`/`_tw`/`_hk`/`_mo` → zh-TW，
  含 `en`（词边界）→ en，否则 zh-CN。用户可在「外观 → 语言」或新手引导第 3 步切换，选择写入
  `~/.config/figaro/settings-ui.json`，重启设置窗口后保留（**不写 daemon config**）。
- 现有 672 条键三语齐全；`settings/test/shoot.sh` 会断言：每个 QML 源串在 en/tw 都有条目、
  en 不含中文、zh-TW 不含大陆用语（设置/麦克风/语音/连接/唤醒/保存/默认…）、QML 里没有
  未包 `I18n.t()` 的用户可见中文（配置数据值如唤醒词除外）。
- 新增字符串流程：QML 里先写中文源串并用 `I18n.t("…")` 包起来，然后在 `i18n/en.js` /
  `i18n/zh-TW.js` 里各补一条；繁中不要直接简繁转换（用台湾用语：設定/麥克風/語音/連線/喚醒/
  聲紋/儲存/預設…）。

### 新手引导（9 步，可逐步跳过）
1. 认识费加罗（大字说明 + 为什么需要你自己的 API Key）；2. 隐私（本地唤醒/识别、无遥测、Key 只
在本机 600、长记忆目录可删）；3. 语言；4. 地区（中国大陆 / 中国港澳台 / 海外及其他 →
写 `models.region = mainland|hmt|overseas`，影响脚本下载模型的镜像）；5. **长期记忆**（默认关闭，
开关写 `rag.autoIngest`，ⓘ 说明对话摘要会发给所选 LLM/Embedding 服务商、我们没有服务器、数据
在本机）；6. 模型服务（选 DeepSeek/OpenAI/Gemini/Custom + 填 Key，可稍后；写 `llm.*`）；
7. 语音服务（MiniMax Key，可稍后，写 `minimax.apiKey` 兼容旧键）；8. 自检（3 秒麦克风底噪 +
F9/声纹状态，可跳过）；9. 完成总结（语言/地区/记忆/模型/语音/自检一览 + 重来/进入）。

### 服务商引导（紧凑按钮，v1.0 发布前简化）
- 「模型服务」页：一行紧凑按钮 **DeepSeek / OpenAI / Google Gemini**（logo + 名字），点一下直接
  打开官方取 Key 页面：[DeepSeek](https://platform.deepseek.com/api_keys)、
  [OpenAI](https://platform.openai.com/api-keys)、[Gemini](https://aistudio.google.com/app/apikey)；
  旁边的小字为用户原话：**「我们推荐以下服务商，如果您支持开源，请选择中国的深度求索」**
  （en/zh-TW 见 i18n 词表）；Custom 仍可填本地/第三方 OpenAI 兼容端点（如 Ollama / vLLM）。
- 「语音」页：MiniMax 紧凑按钮（logo + 名字，链接
  [MiniMax 控制台](https://platform.minimaxi.com/user-center/basic-information/interface-key)）+ 小 ⓘ。
- 只保留一个小 ⓘ，弹窗内容不变：**我们无法直接提供高质量实时的 LLM/TTS 服务，需要你自己向
  服务商申请 API Key；Key 只保存在本机（config.json 权限 600）、不上传、不写日志；这些是推荐
  服务商，非唯一选择；Custom 可填本地/第三方 OpenAI 兼容端点**。
- Logo：Simple Icons 白色 SVG，离线放在 `settings/assets/providers/`（运行时不联网）；`openai`
  在 Simple Icons 为 404，按产品要求退化为文字圆标 "O"。尺寸 16px、按钮高 28px（`MProviderButton`）。
  来源与商标归属见 `settings/assets/providers/README.md`（CC0 资产；商标归各自公司；仅用于跳转，
  不表示合作/背书；权利人要求时可删除对应文件，自动退化文字圆标）。

### 通用 LLM 设置（模型服务页）
- 字段：provider（DeepSeek/OpenAI/Gemini/Custom OpenAI 兼容）、baseUrl、model、apiKey（密码框，
  只写不读，`***` 不覆盖原值）；高级折叠：reasoningEffort、temperature。写 `config.llm.*`，
  旧 `deepseek.*` 保持不动（后端会自动派生/回退旧 key）。
- 「测试连接」走 daemon 的 `llm.test` IPC（GUI 不直接发网络请求）：settings.js 动态导入
  `src/agent/llm.js` 的 `testLlmConnection({config, llm, timeoutMs})`，支持**未保存草稿**
  （provider/baseUrl/model/apiKey overlay）；返回 `{ok, provider, baseUrl, model, status,
  message, latencyMs, apiKeyConfigured}`，key 绝不回显/写日志（错误串里的 sk- 也会被打码）。
  daemon 未加载新版 settings.js 时，GUI 会显示"尚未提供 LLM 连接测试"。
  与后端已对齐并端到端验证（真实 `testLlmConnection` + 本地 mock）：OpenAI 兼容探测
  `GET ${baseUrl}/models` + Bearer，Gemini 探测 `GET ${baseUrl}/v1beta/models?pageSize=1&key=…`，
  默认 8s 超时；custom 的 `/models` 404 视为"服务可达"（Ollama/LM Studio 常见）；401/403/429/5xx/
  超时为 ok:false + 中文 message，均不含 key（Gemini URL key 已打码）；`llm` 草稿覆盖不修改已保存
  config，GUI 传 `***` 时 daemon 用已保存 key；custom 允许无 key（本地服务），其余三家缺 key 直接失败。
- 与后端约定：`llm.provider: deepseek|openai|gemini|custom`、`llm.baseUrl/model/apiKey`、
  可选 `reasoningEffort/temperature/maxToolRounds/maxRetries/requestTimeoutMs/requestOptions`；
  `models.region: mainland|hmt|overseas`（不写=auto）；`rag.autoIngest` 默认 false。
- settings.js 白名单新增 `llm.provider/baseUrl/model/apiKey/reasoningEffort/temperature`、
  `models.region`、`rag.autoIngest`；`llm.apiKey` 加入 SECRET_PATHS（config.get 掩码）。

### 验收截图（`test/out/`）
`26-wizard-welcome`…`35-wizard-summary`（9 步引导）、`46-i18n-en-overview` / `47-i18n-en-wizard`
/ `48-i18n-tw-overview` / `49-i18n-tw-wake`（三语切换）、`50-llm-top` / `51-llm-test-ok` /
`52-llm-providers` / `53-llm-provider-info`（LLM 页 + 推荐服务商 + ⓘ 弹窗）、
`54-voice-minimax-provider` / `55-minimax-info`（语音页 MiniMax 入口）、
`56-provider-buttons-zh` / `57-provider-buttons-en` / `58-provider-buttons-zh-tw`（紧凑按钮三语）、
`59-voice-minimax-button`（语音页紧凑按钮）、`60-provider-info-dialog`（单 ⓘ 弹窗）。

### 已知环境问题
Qt **software** 后端在本会话里启动 Quickshell 会段错误（`QWaylandShmBackingStore` 双绘制，
未修改的 HEAD 基线同样崩），所以 `settings/test/dev.sh` 支持 `FIGARO_SETTINGS_GL=1`；部署窗口
用 GL 启动，`ctl.sh` 仍保留 software 默认，需 Lead 决定是否切换桌面入口默认后端。

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
