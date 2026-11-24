# Codex Standalone Web Search (`/alpha/search`) 协议与上游实现参考

本文档基于 `openai/codex`（`main` 分支）源码与实测结果整理，记录 `/alpha/search` 接口契约、`codex-rs` 客户端处理流程、网关实测边界行为，以及 `pi-sub2api`（`src/search/`）与上游的差异对照，供后续维护与重构参考。

---

## 1. 上游源码位置索引（`openai/codex`）

| 模块 | 上游路径 | 职责说明 |
|---|---|---|
| HTTP 端点调用 | `codex-rs/codex-api/src/endpoint/search.rs` | 定义相对路径 `"alpha/search"`，`POST` 发送 `SearchRequest` 并反序列化 `SearchResponse` |
| 协议数据结构 | `codex-rs/codex-api/src/search.rs` | 定义 `SearchRequest`、`SearchCommands`、`SearchQuery`、`SearchSettings`、`SearchResponse` 等全部 DTO 与 JSON Schema |
| 扩展注册与配置映射 | `codex-rs/ext/web-search/src/extension.rs` | 将用户配置（`WebSearchMode`、`WebSearchContextSize`、地域、域名白名单）映射为 `SearchSettings`，按模型能力开关学术搜索 |
| 工具执行器 | `codex-rs/ext/web-search/src/tool.rs` | 注册 `web.run` 工具、路由与重定向策略、组装请求体与请求头、发射 UI/遥测事件、封顶错误输出 |
| Schema 生成 | `codex-rs/ext/web-search/src/schema.rs` | 由 `SearchCommands` 生成 Draft 2019-09 JSON Schema（保留字段注释描述，不压缩），按需移除 `literature_search_query` |
| 会话上下文裁剪 | `codex-rs/ext/web-search/src/history.rs` | `recent_input()`：提取最近两轮可见用户文本与最多 1,000 tokens 助手文本注入 `SearchRequest.input` |
| 工具输出封装 | `codex-rs/ext/web-search/src/output.rs` | 将服务端 `response.output` 原样包装为模型的 `FunctionCallOutput`（不二次排版 `results`） |
| 模型调用规范提示词 | `codex-rs/ext/web-search/web_run_description.md` | 官方喂给模型的 `web.run` 工具完整说明（批量上限、`response_length` 规则、引用格式、`[wordlim]` 合规要求） |

---

## 2. HTTP 端点与请求头

- **Method & Path**：`POST <api_base>/alpha/search`
  - 在 OpenAI API / Sub2API 网关下对应 `POST /v1/alpha/search`；在 ChatGPT Backend 下对应 `POST /backend-api/alpha/search`（`endpoint/search.rs:28-30`, `tool.rs:121`）。
- **重定向安全策略**（`tool.rs:113-135`）：
  - 当存在账号路由头（`ACCOUNT_ROUTING_HEADER`）或策略要求拒绝重定向时，强制使用 `ClientRedirectPolicy::Reject`（对应 `fetch` 的 `redirect: "error"`），防止 `Authorization` 头在跨域重定向时泄露。
- **关键请求头**（`tool.rs:148-151, 218-230`）：
  - `Authorization: Bearer <token>`
  - `Content-Type: application/json`
  - `Originator: <thread_originator>`（如 `codex_cli_rs`）
  - `x-codex-turn-metadata: <json>`（可选，透传当前轮次元数据 `X_CODEX_TURN_METADATA_HEADER`）

---

## 3. 请求体（`SearchRequest`）完整参数说明

源码定义：`codex-rs/codex-api/src/search.rs:7-26`

```json
{
  "id": "session-uuid",
  "model": "gpt-6-luna",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "..." }]
    }
  ],
  "commands": {
    "search_query": [
      { "q": "OpenAI news", "recency": 7, "domains": ["openai.com"] }
    ]
  },
  "settings": {
    "search_context_size": "low",
    "allowed_callers": ["direct"],
    "external_web_access": false
  },
  "max_output_tokens": 10000
}
```

### 3.1 顶层字段

| 字段 | 类型 | 必填 | 上游处理方式与作用 |
|---|---|---|---|
| `id` | `string` | 是 | 会话级唯一 ID（`extension.rs:137` 取 `session_store.level_id()`）。**关键作用**：服务端用它维护会话内页面状态，使跨轮次的引用 ID（如 `turn0search0`、`turn1view0`）能被后续 `open` / `click` / `find` 解析。 |
| `model` | `string` | 是 | 当前轮次模型 ID（`tool.rs:139` 取 `call.model`）。 |
| `reasoning` | `Reasoning?` | 否 | 推理配置；上游 `tool.rs:140` 固定传 `None`（不序列化）。 |
| `input` | `string \| ResponseItem[]` | 否 | 搜索消歧上下文。上游 `history.rs:16-83` 提取**最近 2 条用户纯文本消息**及中间**最多 1,000 tokens 的助手纯文本回复**（剔除图片、工具调用记录、`<environment_context>` 及消息 `id`）。省略时服务端仅凭 `commands` 检索。 |
| `commands` | `SearchCommands` | 否 | 具体执行的检索或浏览指令集合（见 3.2）。 |
| `settings` | `SearchSettings` | 否 | 检索环境与过滤配置（见 3.3）。 |
| `max_output_tokens` | `u64?` | 否 | **全局上下文安全上限**。上游 `tool.rs:144-146` 传入 `call.truncation_policy.token_budget()`（通常为 `10,000` tokens 级别），仅作防上下文溢出兜底，**并非用于控制 `short/medium/long` 摘要长短**。若设得过小（如 750/1500），服务端会在拼接完富文本后直接硬截断字符串，导致断词、半截引用符以及多 query 后段结果被吞。 |

### 3.2 `commands`（`SearchCommands`）

源码定义：`search.rs:28-201`；使用规范：`web_run_description.md:5-23`

> 上游支持在单次请求中组合多种指令（如同时发 `search_query` + `find` + `finance`）。未使用的字段必须省略，不要传空数组 `[]` 或 `null`（`web_run_description.md:21`）。

| 字段 | 元素结构 | 说明与约束 |
|---|---|---|
| `search_query` | `SearchQuery[]` | 网页搜索。**每次调用最多 4 条**；若条数 `> 3`（即 4 条），`response_length` 必须为 `"medium"` 或 `"long"`（`web_run_description.md:22`）。误触发工具时上游建议发 `[{"q": ""}]`。 |
| `literature_search_query` | `SearchQuery[]` | 学术论文检索。仅当模型 `experimental_supported_tools` 包含 `"literature_search_query"` 时开放，否则客户端在 Schema 中移除该属性并在运行时拦截报错（`schema.rs:21-25`, `tool.rs:240-244`）。 |
| `image_query` | `SearchQuery[]` | 图片搜索。复用 `SearchQuery` 结构（实际仅 `q` 与 `domains` 有意义）。 |
| `open` | `{ ref_id: string, lineno?: u64 }[]` | 打开网页或跳转到指定行。`ref_id` 可传完整 `http(s)://` URL 或已有引用 ID（如 `turn0search0`、`turn1view0`）。 |
| `click` | `{ ref_id: string, id: u64 }[]` | 点击已打开页面中的编号链接 `【id†...】`。`ref_id` **必须是展示该编号链接的页面引用 ID**（如 `turn1view0` / `turn0fetch3`），不能传原始 URL，否则服务端返回 `Internal Error () ... Unable to resolve click call`。 |
| `find` | `{ ref_id: string, pattern: string }[]` | 页内文本查找。`ref_id` 支持页面引用 ID，**也支持直接传完整 URL**（无需先 `open`）。 |
| `screenshot` | `{ ref_id: string, pageno: u64 }[]` | PDF 页面截图（`pageno` 为 0 基页码）。 |
| `finance` | `{ ticker: string, type: "equity" \| "fund" \| "crypto" \| "index", market?: string }[]` | 金融行情查询（`market` 传 ISO 3166-1 alpha-3 国家码、`"OTC"`，加密货币传 `""`）。 |
| `weather` | `{ location: string, start?: string, duration?: u64 }[]` | 天气预报查询（`location` 格式 `"Country, Area, City"`，`start` 格式 `YYYY-MM-DD`，默认 7 天）。 |
| `sports` | `{ tool?: "sports", fn: "schedule" \| "standings", league: "nba" \| "wnba" \| "nfl" \| "nhl" \| "mlb" \| "epl" \| "ncaamb" \| "ncaawb" \| "ipl", team?: string, opponent?: string, date_from?: string, date_to?: string, num_games?: u64, locale?: string }[]` | 体育赛程与积分榜查询。 |
| `time` | `{ utc_offset: string }[]` | 指定时区当前时间查询（如 `"+03:00"`）。 |
| `response_length` | `"short" \| "medium" \| "long"` | 控制结果条数、摘录篇幅或页面视口。上游提示词建议用省略表示 `short`。Sub2API 上曾实测同一条查询省略时返回 11,042 字符，显式 `short` 返回 7,098 字符，因此需要稳定比较长度的调用应显式传 `short`。 |

#### `SearchQuery` 字段与网关实测规律（`search.rs:67-76`）

- `q: string`（必填）：查询词。
- `recency?: u64`：限定最近 N 天内发布的内容。
- `domains?: string[]`：限定站点域名白名单。
- **网关实测边界行为**：
  1. **`domains` 只接受裸域名**（如 `["reddit.com", "v2ex.com"]`），会自动包含子域名（如 `global.v2ex.com`、`old.reddit.com`）；若传入带路径的字符串（如 `["reddit.com/r/LocalLLaMA"]`）会直接返回 **0 结果**（`Empty search results`）。
  2. **单裸域名 vs 多域名**：单裸域名下 `q: "site:v2ex.com DeepSeek"` 与 `domains: ["v2ex.com"]` + `q: "DeepSeek"` 返回结果一致；但**多域名**过滤时，`domains: ["v2ex.com", "linux.do"]` 能同时召回两站，而 `q: "site:v2ex.com OR site:linux.do DeepSeek"` 容易漏站偏科。
  3. **不要使用带路径的 `site:domain/path`**：服务端不做严格 URL 路径前缀过滤（例如 `site:v2ex.com/t/` 仍返回 `/tag/`，`site:reddit.com/r/programming` 会漂移到其他版块），且容易劣化排序与新鲜度；与 `domains` 同时传也完全冗余。限定子版块/栏目的正确写法是 `domains: ["reddit.com"]` + `q: "r/LocalLLaMA <关键词>"`（或直接对版块 URL 调 `open`）。
  4. **多条 `search_query` 混排**：单次调用传入多条 query 时，服务端将所有命中合并为一个扁平文本流返回，**没有按 query 分组的分隔标题**；跨无关站点/主题合并查询容易互相挤占。

### 3.3 `settings`（`SearchSettings`）

源码定义：`search.rs:217-277`；组装逻辑：`extension.rs:50-85, 141-144`

| 字段 | 类型 | 上游默认/映射逻辑 |
|---|---|---|
| `external_web_access` | `boolean \| "cached" \| "indexed" \| "live"` | `Disabled \| Cached` → `false`；`Indexed` → `"indexed"`；`Live` → `true`（`extension.rs:79-85, 188-204`）。为兼容旧协议，`Cached` 和 `Live` 仍序列化为布尔值 `false` / `true`。 |
| `search_context_size` | `"low" \| "medium" \| "high"` | 上游未配置 `web_search_config.search_context_size` 时默认省略（`None`）；显式传 `"low"` 可采用服务端最紧凑的单条摘录粒度。 |
| `allowed_callers` | `("direct" \| "shell" \| "code_interpreter")[]` | 上游 `extension.rs:75` 默认传 `["direct"]`。 |
| `filters` | `{ allowed_domains?: string[], blocked_domains?: string[] }` | 会话级全局域名黑白名单（区别于单条 `SearchQuery.domains`）。 |
| `user_location` | `{ type: "approximate", country?, region?, city?, timezone? }` | 可选大致地理位置信息。 |
| `image_settings` | `{ max_results?: u64, caption?: boolean }` | 可选图片搜索条数上限与图注开关。 |

---

## 4. 响应体（`SearchResponse`）与 Codex 输出处理机制

源码定义：`search.rs:279-286`；输出处理：`tool.rs:165-206`, `output.rs:10-41`

```rust
pub struct SearchResponse {
    pub encrypted_output: Option<String>,
    pub output: String,
    /// Structured result DTOs are passed to clients out-of-band from `output`.
    /// Keep them opaque here so newer result variants remain forward-compatible.
    #[serde(default)]
    pub results: Option<Vec<JsonValue>>,
}
```

1. **1-Hop 富摘录设计（为什么 `short` 的输出依然很长）**
   - `/alpha/search` 的 `output` 不是传统 SERP 的“标题 + 一句话简介”，而是面向大模型的 **1-Hop 预抽取正文上下文**：每条命中包含 `标题 (URL)`、`[turnXsearchY]` / `[turnXredditY]` 引用 ID、`[wordlim: 200]`、`Published / Crawled` 时间戳，以及服务端提取的多段正文、论坛主题列表或 Reddit 主帖+多楼高赞评论。
   - 这样设计是为了让模型在大多数问题上**单次搜索即可直接作答**，无需再为每条链接串行发起多次页面抓取。
   - **上游从不把 `results` 二次拼装给模型**：`tool.rs:169-205` 中，`results` 仅作为带外数据（out-of-band DTO）用于统计载荷体积（`codex.web_search.results.payload_bytes`）和前端 UI 展示（`WebSearchEndEvent`），经常不含 `snippet`，搜图时甚至为空；送给模型的始终是原始 `response.output`（`output.rs:12-14`）。
2. **输出文本中的特殊编码格式**
   - **PUA 引用标记**：服务端文本中可能带有 `\uE200cite\uE202turn0search0\uE201` 形式的私有区字符引用。Codex 原生模型可直接识别；在多模型宿主（如 Pi）中转换为 `[turn0search0]` 并清理截断残留的 `[\uE200-\uE202]` 更通用。
   - **页面行号与编号链接**：`open` / `find` / `click` 渲染网页时，以 `L0:`、`L1:` 标注行号，以 `【17†链接标题†域名】` 标注可点击链接，分别对应后续 `open(lineno)` 与 `click(id=17)`。
   - **`[wordlim: N]` 版权合规标记**：指示回答模型对非 Reddit 单一来源的归纳词数不超过 `N`（默认 200 词）、逐字引用不超过 25 词（歌词 10 词）；Reddit 内容允许使用 `>` 块引用更长原文并附链接（`web_run_description.md:75-89`）。
3. **工具级错误处理（`tool.rs:49, 209-217`, `output.rs:15-18`）**
   - 请求报错时，客户端按 UTF-8 字符边界截断错误消息至最多 `1024` 字节（超出追加 `"… [truncated]"`），封装为 `FunctionCallOutputPayload { success: Some(false), .. }` 返回给模型，由模型决定重试或降级。

---

## 5. `pi-sub2api` 当前实现（`src/search/`）与上游差异对照

对应本地文件：`src/search/commands.ts`、`src/search/provider.ts`、`src/search/index.ts`、`src/search/history.ts`。移植基线为 [openai/codex@a0d5b0a](https://github.com/openai/codex/tree/a0d5b0a661db3b34cd87bdf1c93736b90fd3694b/codex-rs/ext/web-search)，工具描述、Apache-2.0 许可证及 NOTICE 收录于 `src/search/upstream/`。

| 维度 | 上游 `openai/codex` | `pi-sub2api` |
|---|---|---|
| 注册 | `web.run` | Pi 函数工具 `codex-web`，共用同一套命令参数，可组合操作 |
| 模型与预算 | 当前轮次模型和工具输出预算 | 网关 `search.model`，固定 `10,000` token 上限 |
| 长度 | 可选 `response_length`、可配置 `search_context_size` | `response_length` 按调用透传，未指定的长度和上下文大小均省略 |
| 批量查询 | 工具说明约定每次最多 4 条 `search_query`，4 条时选 `medium` 或 `long` | 沿用上游工具说明 |
| 学术搜索 | 按模型的 `experimental_supported_tools` 开关 | 按该提交的模型目录匹配配置的搜索模型，未知模型默认关闭 |
| 结果 | 文本 `output` 返回模型，`results` 作为事件数据 | 原始 `output` 进入 Pi `content`，`results` 进入 `details` |
| 对话上下文 | 自动传近期对话 | `search.includeRecentInput` 显式开启后传最近两条用户文本及其间和之后的助手文本，助手预算约 1,000 tokens |
