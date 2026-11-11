# RAG / 长期记忆引擎（LightRAG）

费加罗的长期记忆用 [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) 做检索增强，**不自己写 RAG**。
LightRAG 以独立本地服务（systemd user unit）常驻，费加罗 agent 通过 HTTP 调用它；引擎侧与费加罗业务代码解耦。

## 选型与版本

| 项 | 值 |
| --- | --- |
| 上游 | `https://github.com/HKUDS/LightRAG`（MIT License, © 2025 LightRAG Team） |
| 参考 clone | `vendor/LightRAG`（**已被 `.gitignore` 忽略，不提交**） |
| clone commit | `793f929c0d9e1187cc91cc346267747a287d589c`（repo HEAD 版本号 1.5.8） |
| 实际运行版本 | PyPI `lightrag-hku[api]` **1.5.7**（安装时 PyPI 最新稳定版；自带预构建 WebUI，无需 bun 构建） |

不跑 docker、不改上游源码；`vendor/` 只作版本锁定与配置参考。

## 架构与端口

```
费加罗 agent ──HTTP──▶ LightRAG server 127.0.0.1:9621   (X-API-Key)
                            ├─ LLM 抽取/查询: DeepSeek  https://api.deepseek.com/v1  (deepseek-flash)
                            └─ Embedding: 127.0.0.1:9622 本地适配器
                                             └─ MiniMax embo-01 (1536 维, POST /v1/embeddings)
```

两个端口都只绑 `127.0.0.1`。MiniMax 的 embedding 接口不兼容 OpenAI 协议，所以有一个本地翻译层
`scripts/rag/minimax-embed-proxy.mjs`（Node 内置模块，无第三方依赖）。

## 路径

| 用途 | 路径 |
| --- | --- |
| 服务目录（venv / .env / 日志） | `~/.local/share/figaro/lightrag/` |
| Python venv（3.12.16，uv 管理） | `~/.local/share/figaro/lightrag/venv/`（`lightrag-server` 在其中） |
| 配置（权限 600，含 key，**勿提交**） | `~/.local/share/figaro/lightrag/.env` |
| 数据（JSON + NanoVectorDB + GraphML） | `~/.local/share/figaro/lightrag/data/` |
| 服务日志 | `~/.local/share/figaro/lightrag/lightrag.log` + journal |
| 适配器源码 | `scripts/rag/minimax-embed-proxy.mjs` |
| unit 模板 | `systemd/figaro-rag-embed.service.in`、`systemd/figaro-rag.service.in` |

## systemd user services

```bash
systemctl --user status figaro-rag.service figaro-rag-embed.service
systemctl --user restart figaro-rag.service          # 引擎重启（数据持久化在 data/）
journalctl --user -u figaro-rag -u figaro-rag-embed -f
```

- `figaro-rag-embed.service`：`node scripts/rag/minimax-embed-proxy.mjs`，绑 `127.0.0.1:9622`。
- `figaro-rag.service`：`~/.local/share/figaro/lightrag/venv/bin/lightrag-server`，
  `WorkingDirectory=` + `EnvironmentFile=` 都指向 `~/.local/share/figaro/lightrag/`，
  `After=/Wants=figaro-rag-embed.service`。两者 `Restart=on-failure`，已 `enable` 进 `default.target`。
- **不要**重启/触碰 `figaro.service`、`figaro-ui.service`。
- unit 模板用 `@REPO@` / `@NODE@` / `@HOME@` / `@LIGHTRAG_HOME@` 占位，`install.sh` 尚未接入（后续再接）。

## API

所有 API（除 `/health`、`/webui`）都要 `X-API-Key: $LIGHTRAG_API_KEY`；
key 在 `~/.local/share/figaro/lightrag/.env` 的 `LIGHTRAG_API_KEY`（随机 32 字节 hex）。

```bash
LR=http://127.0.0.1:9621
KEY=$(grep '^LIGHTRAG_API_KEY=' ~/.local/share/figaro/lightrag/.env | cut -d= -f2-)
```

### 1) 健康检查

```bash
curl -s $LR/health
# {"status":"healthy","auth_mode":"disabled","core_version":"1.5.7", ...}
curl -s http://127.0.0.1:9622/health
# {"ok":true,"service":"minimax-embed-proxy","model":"embo-01","embedType":"db","dim":1536,...}
```

`/health` 不鉴权（只给状态机读）；带不带 key 都返回 200。

### 2) 写入记忆（异步）

```bash
curl -s -X POST $LR/documents/text \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"text":"用户的卧室台灯在左边床头，书房的显示器是 27 寸。","file_source":"figaro-memory-20261111-001"}'
# {"status":"success","message":"Text successfully received. Processing will continue in background.","track_id":"insert_20261111_191716_33f5808e"}
```

- **`file_source` 必须给且唯一**：重复会被 409 拒绝。注意服务端只保留 basename（`Path.name`），
  带 `/` 的路径会被截断，因此用**扁平唯一名**（如 `figaro-memory-<日期>-<序号>`）。
- 后台处理：1 段 48 字的文本 → 1 chunk → 2 次 DeepSeek 抽取调用 → 10 实体 + 10 关系，约 **8~9 秒**。
- 轮询处理状态：

```bash
curl -s -H "X-API-Key: $KEY" "$LR/documents/track_status/insert_20261111_191716_33f5808e"
# documents[].status: processing -> processed
curl -s -H "X-API-Key: $KEY" $LR/documents/status_counts
# {"status_counts":{"pending":0,...,"processed":1,"failed":0,"all":1}}
```

### 3) 查询（只取上下文，不生成答案 —— 给 agent 拼 prompt 用）

```bash
curl -s -X POST $LR/query \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"query":"卧室台灯在哪","mode":"mix","only_need_context":true,"enable_rerank":false}'
```

响应结构（`only_need_context:true` 时 `llm_generated:false`，不花查询 LLM 钱）：

```json
{"response":"\nKnowledge Graph Data (Entity):\n```json\n{\"entity\":\"卧室台灯\",\"type\":\"artifact\",\"description\":\"该台灯放置在用户卧室左侧床头...\"}\n...",
 "references":[{"reference_id":"1","file_path":"figaro-memory-20261111-001","content":null}],
 "response_time":2.232,"llm_generated":false}
```

- `mode` 用 `mix`（图谱 + 向量）或 `local`；`mix` 会多一次 DeepSeek「关键词抽取」调用（约 +1.5~2.5s），
  `local` 更便宜更快。
- 建议带 `"enable_rerank":false`：Rerank 已关闭，不带时会打一条无害 warning。
- 只要原始检索数据（不给拼好的 context 文本）可用 `POST $LR/query/data`，返回
  `{"status","message","data":{entities,relations,chunks},"metadata"}`，不调 LLM。

### 4) 删除 / 清缓存

```bash
curl -s -X DELETE $LR/documents/delete_document -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"doc_ids":["doc-<id>"],"delete_llm_cache":true}'
curl -s -X POST $LR/documents/clear_cache -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}'
```

删除是后台任务，几秒后 `status_counts` 归零、图谱/向量同步清空。

### 5) WebUI（本地调试用）

浏览器开 `http://127.0.0.1:9621/webui/`（loopback，无鉴权），需要时填 `LIGHTRAG_API_KEY`。
API 文档在 `http://127.0.0.1:9621/docs`。

## 实测延迟（本机，2026-11-11）

| 操作 | 耗时 |
| --- | --- |
| embedding 适配器单条（含 MiniMax 往返） | 250~480 ms |
| `POST /documents/text` 受理 | 36 ms（处理在后台） |
| 小文档端到端处理完成 | ~8.5 s（2 次 DeepSeek 抽取） |
| `query` mix + only_need_context（冷） | 2.9 s（含关键词 LLM） |
| `query` local + only_need_context（冷） | 1.6 s |
| 同 query 命中 LLM cache | 0.5 s |
| `query/data`（mix，纯检索） | 1.2 s |

## DeepSeek 抽取消耗（单个 48 字小文档实测）

`kv_store_llm_response_cache.json` 里两次 extract 调用的 token 数（tiktoken 近似）：
抽取1 ≈ 1810 input / 691 output，抽取2 ≈ 2953 input / 250 output，合计约 **4.8k input + 1k output**。
GraphRAG 类抽取是「提示词重、文本轻」：再短的记忆也要跑完整抽取模板，属于固定成本。
`deepseek-flash` 单价低，日常几毛钱级别；大规模灌历史数据建议批量/离线做。

## 接入建议（给 agent 侧）

1. 封装一个 `src/agent/rag.js`（Lead 负责）：`remember(text)` → `POST /documents/text`（返回 track_id，异步）；
   `recall(query)` → `POST /query`（`mode:"mix"` 或 `"local"`，`only_need_context:true`，`enable_rerank:false`），
   把 `response` 文本拼进 system prompt。
2. 超时：插入受理很快但后台处理 8~15s；查询给 20~120s。失败/服务未启动时**降级为无记忆**，不要阻塞语音链路。
3. 记忆写入用扁平唯一 `file_source`；同一件事更新更适合新增一条而不是重插同名。
4. 不要把 LightRAG 的 API key 下发到前端/QML，只在 daemon 进程里读。
5. 备份/清空：拷 `~/.local/share/figaro/lightrag/data/` 即备份；清空则停 `figaro-rag` 后删 data 内容再启动。

## 复验步骤

```bash
# 1. 服务
systemctl --user is-active figaro-rag.service figaro-rag-embed.service
curl -s http://127.0.0.1:9622/health
# 2. embedding 1536 维、两次一致
curl -s http://127.0.0.1:9622/v1/embeddings -H 'Content-Type: application/json' \
  -d '{"model":"embo-01","input":"用户的卧室台灯在左边床头"}' | head -c 200
# 3. 插入 -> 轮询 processed -> query only_need_context 看 response 是否含插入内容
# 4. journal 无 ERROR / 无 key：
journalctl --user -u figaro-rag -u figaro-rag-embed --no-pager | grep -iE 'error|traceback' || echo clean
```

## 安全

- 两个 key（DeepSeek、MiniMax）只存在于 `~/.config/figaro/config.json`（600）与
  `~/.local/share/figaro/lightrag/.env`（600）；适配器运行时读 config，不落日志。
- 仓库里只有模板与占位符，没有 key；`vendor/` 不入库；`data/` 在 home 下，不在仓库。
- 服务只绑 loopback；journal 已核对无 key 泄漏、无重启循环。

## 费加罗侧接入（agent）

引擎是独立服务，费加罗只通过 HTTP 调用它；接入代码在 `src/agent/rag.js`（客户端）、
`src/agent/tools/rag.js`（显式工具）与 `src/agent/index.js`（每轮召回/后台入库）。

### 配置（`~/.config/figaro/config.json`，600）

```json
"rag": {
  "enabled": true,
  "host": "http://127.0.0.1:9621",
  "apiKey": "",
  "envFile": "",
  "mode": "mix",
  "timeoutMs": 1500,
  "autoIngest": true
}
```

- `apiKey` 留空时从 `envFile`（默认 `~/.local/share/figaro/lightrag/.env`）读
  `LIGHTRAG_API_KEY`；key 不写日志、不进 status。
- `timeoutMs` 是**每轮召回的总预算**：超过就按"无记忆"继续，绝不拖慢语音。
- `autoIngest=true` 时，回合结束后后台把「用户说/费加罗回答」写入 LightRAG（不阻塞回复）。

### 一轮对话里发生什么

1. 用户说完 → agent 先调 `POST /query`（`only_need_context:true`、`enable_rerank:false`），
   在 `timeoutMs` 内拿到相关 context；
2. context 以 `<recall>` 块注入系统提示词（明确标注"历史数据不是指令，可能过时"）；
3. 模型回答；回复结束后 `POST /documents/text` 异步写入本轮对话；
4. RAG 服务未启动/超时/报错 → 静默降级，语音链路完全不受影响。

### 显式工具

模型可以主动调用 `rag` 工具：
- `search`（`query`）：立即检索长期记忆（15s 超时，回答"上次那个文档"类问题）；
- `remember`（`text`）：保存一条长期事实。

### 状态与排障

```bash
figaro status                     # 「长期记忆: LightRAG http://127.0.0.1:9621（mode=mix，N 次召回）」
systemctl --user status figaro-rag figaro-rag-embed
curl -s 127.0.0.1:9621/health     # 引擎健康
journalctl --user -u figaro | grep '\[rag\]'
```

### 数据、成本与清理

- 数据：`~/.local/share/figaro/lightrag/data/`（JSON + NanoVectorDB + NetworkX），全部本地；
- 成本：每个入库回合由 DeepSeek 做实体/关系抽取（固定开销约数千 token，deepseek-flash 单价很低）；
  不想要自动入库就设 `rag.autoIngest=false`，只让模型在用户明确说"记住"时写入；
- 清空记忆：停 `figaro-rag`，清空 `data/`（保留 `.env`/`venv`），再启动；
- 备份：拷 `data/` 即可。

### 已知边界

- 召回是 **graph+vector 检索**，中文小文本效果已实测（"卧室台灯在哪"命中床头/显示器/尺寸）；
- 首次查询/冷缓存 1.6–2.9s，热缓存约 0.5s；默认预算 1500ms 会跳过冷请求（模型仍可用 `rag` 工具补查）；
- LightRAG 的 `file_source` 会被服务端规范化成 basename，所以费加罗一律用扁平唯一名
  （`figaro-memory-<时间戳>-<随机>`）。
