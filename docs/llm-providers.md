# 通用 LLM 服务商配置（DeepSeek / OpenAI / Gemini / 自定义）

费加罗的大脑可以选择**任何通用 LLM API**：DeepSeek、OpenAI、Google Gemini，或者任意
OpenAI 兼容的服务（Ollama、vLLM、LM Studio、公司网关、自建代理……）。

## 为什么需要你自己的 API key

费加罗**不转售、不中转、不提供实时模型服务**。所有模型请求都由你这台机器直接发往你选择的
服务商，因此：

- **成本是你的**：用量记在你自己的账号上，充多少用多少，我们不参与计费；
- **隐私是你的**：对话内容只经过「你的机器 → 你选的服务商」，不经过费加罗任何服务器；
- **可用性是你的**：你换 key、换服务商、切到本地模型都不需要等我们发版；
- **责任边界清晰**：key 只存在本机（`~/.config/figaro/config.json`，权限 `600`），
  换机器或删文件即失效，不会出现在我们的任何服务里。

API key 等同于账户余额，请像对待密码一样保管；建议在服务商后台设置用量上限。

## 推荐的三家（+ 语音所需）

| 服务商 | 协议 | 获取 key | 模型示例 | 说明 |
| --- | --- | --- | --- | --- |
| **DeepSeek** | OpenAI 兼容 | <https://platform.deepseek.com/api_keys> | `deepseek-chat`、`deepseek-reasoner` | 中文好、延迟低、便宜，默认推荐 |
| **OpenAI** | OpenAI 兼容 | <https://platform.openai.com/api-keys> | `gpt-4o-mini`、`gpt-4o` | 生态最全；需要海外支付方式 |
| **Google Gemini** | **原生**（非 OpenAI 兼容） | <https://aistudio.google.com/app/apikey> | `gemini-2.5-flash`、`gemini-2.5-pro` | 有免费额度；费加罗内置原生流式适配 |
| MiniMax（**声音**，不是大脑） | MiniMax TTS | <https://platform.minimaxi.com/user-center/basic-information/interface-key> | `speech-2.6-turbo` | 语音合成用的 key，和 LLM 是两回事 |

> 换服务商不需要重装：改 `llm.provider/baseUrl/model/apiKey` 四项即可。
> 模型下载（ASR/唤醒词）与 LLM 无关，见 [模型下载地区源](#附模型下载地区源)。

## 配置方式

配置文件：`~/.config/figaro/config.json`（`$XDG_CONFIG_HOME` 生效；权限必须是 `600`，
GUI 保存时会自动设好）。也可以走 GUI：**设置 → 模型 / 连接**，它写的就是下文的 `llm.*`。

### 1) DeepSeek（默认）

```json
{
  "llm": {
    "provider": "deepseek",
    "apiKey": "sk-你的-deepseek-key",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat"
  }
}
```

### 2) OpenAI

```json
{
  "llm": {
    "provider": "openai",
    "apiKey": "sk-你的-openai-key",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  }
}
```

`baseUrl` 要带上 `/v1`（客户端会拼 `${baseUrl}/chat/completions`）。

### 3) Google Gemini（原生协议）

```json
{
  "llm": {
    "provider": "gemini",
    "apiKey": "AIza你的-gemini-key",
    "baseUrl": "https://generativelanguage.googleapis.com",
    "model": "gemini-2.5-flash"
  }
}
```

- `baseUrl` 填到主机即可（带 `/v1beta` 也认）；模型名写 `gemini-2.5-flash` 或
  `models/gemini-2.5-flash` 都可以。
- Gemini 走的是原生 `streamGenerateContent?alt=sse`，费加罗会把它的
  `contents/parts/functionCall/functionResponse/usageMetadata` 转成内部统一结构，
  工具调用（本地 bash/read/web 等）在 Gemini 上同样可用；Gemini 的 `functionCall`
  以完整 part 返回（不做分片参数拼接），这一点与 OpenAI 的增量 tool_calls 不同。

### 4) 自定义 OpenAI 兼容（本地或自建）

```json
{
  "llm": {
    "provider": "custom",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "qwen3:8b"
  }
}
```

- 本地服务（Ollama / LM Studio / vLLM）通常不需要 key，可省略 `apiKey`；
- 允许的地址：**`https://` 任意域名，或 `http://127.0.0.1|localhost`**。
  `http://` 加局域网/公网地址会被拒绝（防 SSRF，避免把你机器当跳板）；
- 重定向只跟随**同一 origin** 的 307/308，不会把 key 转发到别的域；
- 也可以填公司网关 / 自建代理的完整地址（含 `/v1`）。

## 高级项（都可省略）

```json
{
  "llm": {
    "provider": "deepseek",
    "apiKey": "sk-...",
    "reasoningEffort": "none",
    "temperature": 0.6,
    "maxToolRounds": 24,
    "maxRetries": 1,
    "requestTimeoutMs": 180000,
    "requestOptions": {}
  }
}
```

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `reasoningEffort` | DeepSeek 用 `none` | 语音场景先答题再思考，首字延迟从 ~1.8s 降到 ~0.7s；`minimal`/`medium` 换回更多推理 |
| `temperature` | `0.6` | 回答发散程度 |
| `maxToolRounds` | `24` | 一次对话最多几轮工具调用 |
| `maxRetries` | `1` | 可重试错误（5xx/429/超时）的自动重试次数 |
| `requestTimeoutMs` | `180000` | 单次模型请求超时 |
| `requestOptions` | `{}` | 原样并入请求体（如 `max_tokens`、特定服务商字段） |

Gemini 的思考预算等原生参数请放进 `requestOptions`，例如
`{"requestOptions": {"generationConfig": {"thinkingConfig": {"thinkingBudget": 0}}}}`；
`reasoningEffort: "none"` 对 Gemini 等价于 `thinkingBudget: 0`。

## 环境变量（CI / 无 GUI / 临时覆盖）

| 变量 | 作用 |
| --- | --- |
| `FIGARO_LLM_PROVIDER` | 服务商（配置文件没写 `llm` 时生效） |
| `FIGARO_LLM_BASE_URL` / `FIGARO_LLM_MODEL` | 覆盖地址 / 模型 |
| `FIGARO_LLM_API_KEY` | 覆盖 key（优先级最高，和旧的 `FIGARO_DEEPSEEK_API_KEY` 一致） |
| `FIGARO_DEEPSEEK_API_KEY` / `DEEPSEEK_API_KEY` | 旧变量，仍然有效（喂给 DeepSeek 和 `llm.*`） |
| `FIGARO_OPENAI_API_KEY` / `OPENAI_API_KEY` | `provider: openai` 时的 key 兜底 |
| `FIGARO_GEMINI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `provider: gemini` 时的 key 兜底 |

## 旧配置完全兼容（0.x → 1.0）

老的 `deepseek.*` 配置**不用改**，升级后照常工作：

```json
{ "deepseek": { "apiKey": "sk-...", "model": "deepseek-flash" } }
```

`loadConfig()` 会用它派生 `llm.*`（provider=deepseek）。如果同时写了 `llm.*`，运行时**以
`llm` 为准**；`provider=deepseek` 且 `llm.apiKey` 为空时，会回退使用旧 `deepseek.apiKey`，
所以升级不会丢 key。`deepseek.maxToolRounds` / `maxRetries` / `temperature` /
`reasoningEffort` / `requestOptions` 这些旧调优项也继续生效。

## 隐私与安全

- **key 只在本机**：`~/.config/figaro/config.json`（权限 `600`，GUI 写入时强制）；
  仓库里的 `config/config.example.json` 只有占位符，`scripts/preflight.sh` 会检查真实 key 未入库。
- **key 不进日志/错误信息**：请求失败、超时、重试的报错都会脱敏；`figaro doctor`/`status`
  只显示是否配置或末四位提示。Gemini 的 key 在 URL 查询串里，任何打印/错误信息都会把
  `key=` 打码。
- **只发往你配置的地址**：https 任意域名 / http 仅回环；不跟随跨域重定向。
- **不读你的其他配置**：费加罗只读取 `llm.*`（以及兼容的 `deepseek.*`）和语音相关配置。
- 怀疑 key 泄漏就立刻去服务商后台吊销并换新，然后重新填一次。

## 测试连接

GUI：**设置 → 模型 / 连接 → 测试连接**。它会用当前已保存的配置（或你还没保存的草稿值）
发一次很轻的探测：

- OpenAI 兼容（DeepSeek/OpenAI/Custom）：`GET ${baseUrl}/models` + `Bearer`；
- Gemini：`GET ${baseUrl}/v1beta/models?pageSize=1&key=...`；
- 8 秒超时；成功/401/403/429/超时都会给出中文提示；key 不会出现在提示里。

命令行下没有 `figaro llm test`，可以用等价的 `curl` 自测，例如
`curl -sS -H "Authorization: Bearer $KEY" https://api.deepseek.com/models`。

## 常见问题

- **401 / 403**：key 错、过期、没权限，或 baseUrl 与服务商不匹配（OpenAI 要 `/v1`，
  Gemini 不用 `/v1`，DeepSeek 不用）。
- **429**：被限流/余额不足，稍后重试或换 key。
- **connect ECONNREFUSED / fetch failed**：地址或端口不对；本地模型服务没启动。
- **返回内容不是流式**：部分代理会忽略 `stream: true`，费加罗接受普通 JSON 响应。
- **Gemini 报 schema 错误**：费加罗已自动裁剪 Gemini 不支持的 JSON Schema 关键字
  （如 `additionalProperties`、`oneOf`），如果你的自建代理仍报错，先升级 v1.0。
- **想换回 DeepSeek**：把 `llm` 块删掉即可回到旧 `deepseek.*`/默认值。

## 附：模型下载地区源

ASR/唤醒词模型不是 LLM API，由 `scripts/fetch-models.sh` 下载。它会按地区选源：
中国大陆走国内镜像（`modelscope > hf-mirror > ghproxy`），港澳台/海外直连官方
（`github > hf`），可用 `--region mainland|hmt|overseas`、`FIGARO_REGION` 或 config 的
`models.region` 覆盖；`--probe` 只打印将用的源和 URL 并做小文件校验，不下载大模型。
详见脚本顶部说明。

相关文档：[RAG / 长期记忆](rag.md) · [语音交互](voice-interaction.md) · [发布清单](releasing.md)
