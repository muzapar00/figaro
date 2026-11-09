# 安全说明

## 密钥怎么存

- 所有密钥只存在 `~/.config/figaro/config.json`（安装器/守护进程会把它设成 `600`）。
- 仓库里的 `config/config.example.json` 只有空字段；**不要把真实密钥写进仓库、issue、截图或日志**。
- `figaro doctor` 只打印掩码（如 `sk-…c6c6`），不打印全文。
- 设置 App 的 API Key 输入框只写不读：写入后立即清空，daemon 只回传 `***`。
- 环境变量 `FIGARO_DEEPSEEK_API_KEY` / `FIGARO_MINIMAX_API_KEY` 优先于配置文件（适合用密码管理器注入）。

## 权限与攻击面

- daemon 通过 `$XDG_RUNTIME_DIR/figaro/sock` 的 Unix socket 通信，权限随 `$XDG_RUNTIME_DIR`（仅本人可访问）。
- 浮层是 Wayland layer-shell 表面，不获取键盘焦点，点击区域只覆盖球体/胶囊。
- 语音识别、VAD、唤醒词全部本地运行；只有对话（DeepSeek）和语音合成（MiniMax）会联网。
- 工具调用（bash/文件/截图）是本机能力：任何能连上 socket 的本机进程都能让费加罗执行命令。
  它不是安全边界，别把 socket 暴露给不可信用户或网络。

## 报告漏洞

请**不要**公开提交 issue。发邮件到 mzpr00@163.com，写清：影响版本、复现步骤、
最小示例。会在 7 天内确认，修复后致谢（如你愿意）。
