# 参与贡献

## 开发约定

- 运行时：Node ≥ 22（`/usr/bin/node` 实测 v22），依赖 `npm install`。
- 测试：`node --test "tests/**/*.test.js"` 必须全绿；`figaro doctor` 应无 ✗。
- 提交信息：`feat(scope): …` / `fix(scope): …` / `docs: …` / `chore: …`，正文用英文，简洁说明"为什么"。
- 不要提交：`~/.config/figaro/config.json`、任何密钥、`models/` 下的模型文件、`node_modules/`。
- 界面改动请附截图；行为改动请附实测数字（延迟、命中率、CPU 等）。

## 许可与签署

本项目以 **GPL-3.0-or-later** 发布（见 `LICENSE`）。提交代码即表示你同意以同一许可证授权你的贡献。
请在每个提交信息末尾加签名（Developer Certificate of Origin）：

```
Signed-off-by: Your Name <you@example.com>
```

用 `git commit -s` 自动添加。**不要在提交里添加 AI 署名或生成器标记。**

> 维护者保留在必要时引入轻量 CLA 的权利（为了未来能提供商业授权例外）；引入前会在
> `CONTRIBUTING.md` 与 issue 中公开说明，已合并的 DCO 贡献不受追溯影响。

## 目录

| 路径 | 内容 |
|---|---|
| `src/daemon.js` | 状态机、唤醒/取消/等待窗口、IPC 服务 |
| `src/agent/` | DeepSeek 流式客户端、工具循环、系统提示词、工具实现 |
| `src/voice/asr/` | 常驻唤醒词（中英双语 KWS）、VAD、离线/流式识别、热键 |
| `src/voice/tts/` | MiniMax 流式合成、PCM 播放、音色与 sink 解析 |
| `src/voice/sfx/` | UI 音效播放（短音，不抢语音） |
| `qml/figaro/` | 浮层（球/胶囊/线、液态玻璃、字幕） |
| `settings/` | 设置与自测 GUI（Quickshell） |
| `docs/` | IPC 契约、语音交互状态机、动效规则、NextKDE 移植计划 |
