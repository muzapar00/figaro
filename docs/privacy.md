# 隐私说明（Figaro v1.0）

费加罗是一个**完全由你掌握**的本地语音助手：我们（项目作者）没有任何服务器、账号体系或遥测，
也无法看到你的语音、对话、API key、长期记忆或屏幕内容。下面逐项说明数据流向，以及你可以怎样关掉/删除它。

## 一句话版本

- 唤醒词检测、语音识别、声纹、屏幕读取、工具执行：**全部在本机**；
- 只有「转写后的文字」会离开你的电脑，而且只发送给**你自己配置的服务商**（LLM / TTS）；
- 长期记忆（LightRAG）默认**不自动入库**；开启后内容会经你配置的 LLM/Embedding 服务商处理；
- API key 只存在本机 `~/.config/figaro/config.json`（权限 600），不会上传给我们；
- 没有任何统计、崩溃上报、使用数据回传、广告或账号绑定。

## 数据流向明细

| 环节 | 数据 | 去向 | 能否关闭 |
|---|---|---|---|
| 唤醒 | 麦克风音频 | 本机 KWS（sherpa-onnx） | `asr.enabled=false` 关闭语音 |
| 声纹 | 唤醒前 1.5s 音频 | 本机 CAM++ 模型，只生成向量存本机 | `asr.speaker.enabled=false` |
| 语音识别 | 麦克风音频 | 本机 ASR（sherpa-onnx） | 同上 |
| 回答 | 转写文本 + 会话上下文 + 工具结果 | 你配置的 LLM（默认 DeepSeek；可改 OpenAI / Gemini / 本地 OpenAI 兼容端点） | 断开/更换服务商；或改用本地模型端点 |
| 朗读 | 待朗读文本 | 你配置的 TTS（默认 MiniMax） | `tts.enabled=false` 只用文字 |
| 长期记忆（自动入库，默认关闭） | 「用户说/费加罗回答」文本 | 本地 LightRAG 服务；其入库时把文本交给**你配置的 LLM（抽取）和 Embedding（默认 MiniMax embo-01）** | `rag.autoIngest=false`（默认）；或整体 `rag.enabled=false` |
| 长期记忆（说"记住"） | 你要求记住的文本 | 同上，仅在明确要求时写入 | 不主动说"记住"即可 |
| 网页/文件工具 | 你要求查询的 URL/文件内容 | 对应网站/本机；结果进入 LLM 上下文 | 不使用 web/文件工具 |
| 屏幕 | 截图 | 本机；只在需要看图时作为图片发给 LLM | 不使用截图 |
| 更新检查 | 无 | — | 没有自动更新/检查 |

## 长期记忆的特别说明（重要）

LightRAG 的索引流程包含「实体/关系抽取」和「向量化」，这两步需要调用 LLM 与 Embedding 服务商。
因此**开启长期记忆后，被索引的对话文本会发送给你配置的 LLM 与 Embedding 服务商**（默认 DeepSeek / MiniMax）。
v1.0 的默认是 `rag.autoIngest=false`：只有你主动说「记住…」或调用 `rag` 工具时才会写入。
你可以在引导设置里打开自动记忆（会先展示这段说明），也可以随时关闭并删除：

```bash
systemctl --user stop figaro-rag
rm -rf ~/.local/share/figaro/lightrag/data/*   # 知识图谱/向量数据
systemctl --user start figaro-rag
```

## API key 与账号

- key 只写在 `~/.config/figaro/config.json`（600）和 LightRAG 的 `~/.local/share/figaro/lightrag/.env`（600）；
- 设置界面读取时只显示掩码/占位，不回显明文；
- key 只用于向你选择的服务商发起请求，我们不参与、不转发、不记录；
- 不同服务商对你发送的内容有自己的隐私政策，请按需选择（也可以填本地模型端点，做到完全离线）。

## 本机数据位置与删除

| 数据 | 位置 | 删除 |
|---|---|---|
| 配置与 API key | `~/.config/figaro/config.json` | 删除文件 |
| 声纹档案 | `~/.config/figaro/speaker-profile.json` | `rm` 后重新运行即无档案 |
| 长期记忆 | `~/.local/share/figaro/lightrag/data/` | 停服务后清空目录 |
| RAG 配置/key | `~/.local/share/figaro/lightrag/.env` | 删除 |
| 模型文件 | `~/Projects/figaro/models/` 或安装目录 | 删除后重跑 `scripts/fetch-models.sh` |
| 日志 | `journalctl --user -u figaro*` | `journalctl --user --rotate` / 按 journald 策略 |
| 截图/临时文件 | `/tmp/figaro-*` | 系统重启自动清理 |

## 自由与开源

- 代码以 **GPL-3.0-or-later** 发布：你可以阅读、修改、再分发，不存在供应商锁定；
- 服务商可替换：LLM 支持 DeepSeek / OpenAI / Gemini / 任意 OpenAI 兼容端点（含本地 Ollama/vLLM）；
  TTS 与 Embedding 也可以换成自建服务；
- 不依赖我们的任何在线服务，项目停止维护也不会让你的设备变砖。

## 我们能承诺与不能承诺的

**能承诺**：项目代码中没有遥测/统计/上报逻辑（可自行审计 `src/`）；没有收集账号；没有隐藏的云依赖。
**不能承诺**：你选择的服务商如何存储/使用你发送的文本，由他们的隐私政策决定；请自行评估并选择可信服务商或本地模型。
