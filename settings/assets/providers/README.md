# 服务商 Logo 来源与商标声明

本目录的 SVG 用于设置窗口里「推荐服务商」按钮的标识，**只表示“跳转到该服务商”**，
不表示费加罗与这些公司存在合作、背书或从属关系。

| 文件 | 来源 | 许可 | 备注 |
|---|---|---|---|
| `deepseek.svg` | [Simple Icons](https://simpleicons.org/) `deepseek`（`https://cdn.simpleicons.org/deepseek/white`） | CC0 1.0 | DeepSeek 商标归杭州深度求索人工智能基础技术研究有限公司所有 |
| `googlegemini.svg` | Simple Icons `googlegemini`（`https://cdn.simpleicons.org/googlegemini/white`） | CC0 1.0 | Google Gemini 是 Google LLC 的商标 |
| `minimax.svg` | Simple Icons `minimax`（`https://cdn.simpleicons.org/minimax/white`） | CC0 1.0 | MiniMax 商标归其各自权利人所有 |

- OpenAI：Simple Icons 当前未提供 `openai` 图标（CDN 返回 404），因此按照产品要求使用
  **文字圆标 "O"**（`MProviderButton` 的 fallback），不使用官方 Logo；OpenAI 商标归 OpenAI 所有。
- 所有 logo 均在构建/运行前离线放好（`settings/assets/providers/*.svg`），设置窗口运行时不联网。
- 若商标权利人要求，删除对应文件即可；`MProviderButton` 会自动退化为文字圆标，功能不受影响。
