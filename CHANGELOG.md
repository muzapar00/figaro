# Changelog

## v1.0.0（2026-11-11）

第一个正式版：面向普通用户的 Linux 桌面语音助手。发布物包含源码、deb/AUR/rpm 安装包，
设置界面三语、新手引导、通用 LLM、按地区选择的模型下载，以及独立的隐私说明。

### 三语 GUI 与引导
- 设置窗口与新手引导支持**简体中文 / 繁體中文 / English**（672 条键，默认跟随系统语言，
  设置里可切换，无需重启；繁中使用台湾用语）。
- 新手引导重做为 9 步大字流程：费加罗是什么 → 隐私 → 语言 → 地区 → 长期记忆（默认关闭，
  含数据流说明）→ LLM 服务 → 语音服务 → 麦克风/F9/声纹自检 → 完成总结。
- 服务商引导卡片：DeepSeek / OpenAI / Gemini / MiniMax，附官方取 key 链接、"推荐服务商"小字
  与 ⓘ 说明（不提供托管服务、key 只存本机 600、可选本地 OpenAI 兼容端点）。

### 通用 LLM API
- 新增 `llm.provider`：DeepSeek / OpenAI / Gemini / Custom（OpenAI 兼容，含 Ollama/vLLM）；
  OpenAI 兼容与 Gemini 原生流式、工具调用都可用；旧 `deepseek.*` 配置自动兼容。
- 设置里可切换 provider/baseUrl/model/key 并测试连接（`llm.test`，key 不回显、错误脱敏）；
  SSRF 防护（仅 https 或回环 http）、重定向限制、401/5xx/429/超时语义统一。

### 按地区的模型下载
- `scripts/fetch-models.sh --region=mainland|hmt|overseas|auto`：
  中国大陆自动国内源（ModelScope / hf-mirror / ghproxy，失败自动回退）；
  中国港澳台与海外走官方源；`auto` 只按 locale/时区猜且提示可覆盖。
- `--probe` 打印最终目录、地区、源顺序与每个 artifact 的 URL 并做小文件校验；
  `--models-dir/FIGARO_MODELS_DIR` 支持包安装到 `~/.local/share/figaro/models`。

### Linux 打包与兼容性
- 新增 deb / AUR / rpm 打包（`packaging/`）与 CI release workflow（tag v* 自动构建并上传）；
  包内不含模型、config 或 key；首次启动由 `figaro install-user` / GUI 引导完成用户级安装。
- `figaro install-user`：幂等安装 QML、systemd user units、desktop、图标，缺配置时生成脚手架，
  **绝不覆盖已有 config/key**。
- 平台兼容：KDE Plasma 6 Wayland 正式支持；非 KDE 跳过 KOS 玻璃、半透明回退；
  截图回退链 spectacle → grim → portal → gnome-screenshot → scrot；`figaro doctor` 增加
  OS/桌面/layer-shell/portal/PipeWire/截图后端检查（矩阵见 `docs/platform-support.md`）。
- systemd units 去掉 KDE/wayland-0 写死，install-user 按当前会话渲染。

### 隐私与自由
- 新增 `docs/privacy.md`：数据流向、长期记忆的数据披露、key 存储、数据删除方法；无遥测/账号/托管服务。
- 长期记忆（LightRAG，MIT）自动入库默认关闭；开启前明确说明会发送文本给 LLM/Embedding 服务商。
- 依赖与模型许可补入 `THIRD_PARTY_NOTICES.md`。


### 唤醒/倾听审计修复

- 声纹阈值以 config 为准（此前档案里记录的旧阈值会覆盖用户在设置里改的值）；
  声纹分数/拒绝原因接入 daemon 日志，`figaro status` 显示上次 score，便于诊断「叫不醒」。
- 声纹门与二次唤醒校验不再互斥：开启 `asr.verifyWake` 时，校验通过后仍会做声纹确认
  （此前开启二次校验会静默跳过声纹）。
- TTS/应答音（“我在”）不再进入 pre-roll：此前播放期间麦克风仍往 pre-roll 里塞音频，
  导致刚说完话后唤醒时声纹看到的是助手自己的声音（实测余弦 0.09），常被误拒。
- 唤醒灵敏度热切换会保留英文唤醒词（此前 rebuild 丢掉 `wakeWordsEn`，英文唤醒失效）。
- 声纹模型在启动后预热，首次唤醒不再因加载 ONNX 阻塞约 350ms。
- 被声纹拒绝后只保留约 800ms 的重试窗口（此前会把 2.5s 冷却全部吃掉，本人被误拒后不能马上重试）。
- ack 回声剥离收紧：只有「采集与应答音重叠」且「采集开头就检测到语音」时才剥离开头的
  「我在/在的」，避免把「我在客厅把灯关掉」这类正常命令误剥。
- ASR 报错时会停掉当前采集，避免错误 settle 之后来迟的 final 又开一个回合。

### 语音交互
- 说一句话后要**静音 3 秒**才算说完（原来 900ms 会在句子中间就切走）；单次采集上限 30 秒，
  唤醒后不说话的超时放宽到 7 秒。
- **声纹唤醒**：`figaro enroll-voice` 录 3 句你的声音，之后唤醒会用 CAM++ 说话人嵌入
  比对（本地计算，不联网）。放歌/电视里的近似发音会被挡掉，不播应答、不开麦；
  没录声纹或模型缺失时自动退回只认唤醒词，热键 F9 不受声纹限制。
  档案在 `~/.config/figaro/speaker-profile.json`（0600，不进仓库）。
- `figaro enroll-voice`：本地录 3 句生成声纹档案；电平门槛降到 0.0025，小增益麦克风也能录。

### 设置面板
- 唤醒页新增「声纹」卡片：开关、相似度阈值滑块（0.35–0.90，config 优先）、状态徽章
  （就绪/未注册/模型缺失/关闭）、上次 score/检测/过滤计数，以及「重新录制声纹」命令弹窗。
- 连接页新增「家庭中枢 Home Assistant」卡片：`home.haUrl` / `home.haToken`（只写不读、
  掩码不覆盖）/ `home.defaultRoom`，并有「测试连接」（`home.test` IPC，200/401/超时三种中文结果，
  令牌不回显不进日志）。
- 设置窗口默认改用 OpenGL Qt 后端（当前 Qt/Wayland 的软件后端会段错误，基线同样崩）。

### 长期记忆 / RAG（LightRAG）
- 新增本地长期记忆服务：[LightRAG](https://github.com/HKUDS/LightRAG)（**MIT**，`vendor/LightRAG`
  只作版本锁定、不入库），独立 systemd user 服务，只绑 `127.0.0.1:9621`；
  embedding 走 `scripts/rag/minimax-embed-proxy.mjs`（MiniMax `embo-01`，1536 维）→
  `127.0.0.1:9622`，LLM 抽取/查询用 DeepSeek。见 `docs/rag.md`。
- 费加罗侧：每轮开始有预算地召回相关记忆并注入 system prompt；回复结束后**异步**把对话
  写入长期记忆；服务不可用/超时则静默降级为"无记忆"，绝不阻塞语音。可用 `rag` 工具
  显式 `search` / `remember`；配置 `rag.enabled/host/timeoutMs/autoIngest/mode`。
- 安装脚本在有 LightRAG venv 时自动渲染并启用 `figaro-rag{,-embed}.service`。

### 智能家居
- 新增可选 `home` 工具：通过本地 Home Assistant 控制灯（开关/亮度/色温/状态），
  配置 `home.haUrl`/`home.haToken` 后才会注册给模型；未配置时模型看不到。
- 修复 screenshot/view_image 的参数 schema 被二次转换后传给模型的问题（dsh 风格）。
- 已跑通真实设备：Home Assistant Core（venv）+ 官方 Xiaomi Home 集成（米家 OAuth 登录），
  台灯实体接入；`figaro ask "把台灯调到30%"` 实测成功（有/无“台灯 Pro”同名设备时按前缀优先消歧，
  离线的灯不再出现在候选里）。

## 0.1.0 — 初始发布

第一个可用版本：一个常驻 Linux 桌面的语音助手。

### 交互
- 中英双语唤醒词（费加罗 / figaro / hey figaro），同一套 KWS 模型。
- 唤醒应答 10 句随机、不连续重复；应答开播的同时就开麦（比"应答播完再听"快约 0.7s）。
- Siri 式状态机：唤醒、倾听、收尾、思考、回答、回答后等待 7 秒、退下/取消。
- 回答播完不消失，等 7 秒；只有响度 ≥0.012 且持续 180ms 的真人声音才算追问（实测底噪 0.0023）。
- 说「退下/休息吧/没事了」先把话说完再退；说「取消/算了/别说了」立即停；点球或短按热键也能打断。
- 插话打断需响度门槛 + 回声基线，避免被自己的声音打断。

### 语音
- 本地常驻唤醒词 + VAD + 流式/离线识别（sherpa-onnx），语音识别不联网。
- MiniMax 流式男声（逐句合成、边说边播），可换音色与语速。
- 5 个短 UI 音效（65–200ms，比语音低 4–6dB，独立进程，不打断语音）。

### 大脑与工具
- DeepSeek 流式对话 + 工具循环；提示词为语音场景重写（默认一句话回答）。
- 工具：bash、读写/编辑文件、glob、grep、网页搜索/抓取、截屏、看图。
- 本机文件与命令可组合使用；工具失败会如实说明。

### 界面
- Quickshell 浮层：倾听为球、回答为带字幕的胶囊、可选"始终球"或"一条线"、可整体缩放、可关动画。
- KDE 上通过 KOS/KWin 绘制真实液态玻璃；没有该插件时自动退回半透明底。
- macOS 风格设置面板：外观、连接（API Key 只写不读）、交互、唤醒、麦克风、语音、识别、诊断，
  外加五步引导测试向导；改动大多热生效。
- 应用图标 = 真实渲染的说话态光球。

### 工程
- `figaro doctor` 一键体检（服务/IPC/密钥掩码/模型/麦克风/音频出口/热键/桌面/资源）。
- `figaro status`、`figaro talk`、`figaro settings`；NDJSON socket IPC。
- 安装脚本按当前机器渲染 systemd unit 与桌面条目，仓库可放在任意路径。
- 测试 316 项全绿；发布前自检 `scripts/preflight.sh`。
- 许可：GPL-3.0-or-later。
