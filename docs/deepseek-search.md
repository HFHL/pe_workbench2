# DeepSeek 搜索 / 抓取 API 实测

> 状态：可行性验证（2026-10-27）。官方文档：<https://api-docs.deepseek.com/zh-cn/guides/search/>
> 测试脚本：`scripts/test-deepseek-search.mjs`（`npm run test:deepseek-search`），走真实 API，不 mock。

## 1. 接口

| API | Endpoint | 说明 |
|---|---|---|
| Search | `POST https://api.deepseek.com/v1/tools/search` | 自研搜索引擎，返回结构化结果 |
| Fetch | `POST https://api.deepseek.com/v1/tools/fetch` | 抓单个网页，返回 Markdown |

两者都用 DeepSeek API Key：`Authorization: Bearer <key>` + `Content-Type: application/json`。

**Search 请求字段**：`query`（1–128 字符）、`count`（1–50，默认 10）、`ori_question`（原始问题）、`localization`（本地化 IP）、`need_content`（是否返回正文，默认 false）。

**搜索语法**：`site:`（多个用空格 + `OR`）、`-site:`、`-词`、`-"短语"`、`"精确短语"`、`lang:zh,en`、`after:2026-10-01`、`before:2026-06-01`。

**结果字段**：`rerank_score`（0–3，≥1.5 为优质）、`title`、`url`、`snippet`（100–200 字）、`summary`（600–800 字）、`content`（正文，`need_content=true` 时）、`site_name`、`site_icon`、`date`（ISO）、`authority`。

**Fetch 请求字段**：`url`（≤8192，http/https，不能带账号密码）；响应 `title` + Markdown `content`。错误为 OpenAI 兼容格式；403 安全拒绝、404 抓不到正文、429 QPS。

## 2. 实测结果

测试环境：本机 DNS 为 fake-IP（`198.18.0.0/15`），`web_fetch` 会 SSRF 拦截；DeepSeek 是服务端抓取，不受影响。

| 场景 | 结果 |
|---|---|
| 最新新闻（`after:` 最近 7 天） | ✅ 5/5 条在窗口内，最新 1 天前，约 600ms |
| 同日新闻（`after:2026-10-26`） | ✅ 可返回 10-26/10-27 的 RTHK、星岛、证券时报等 |
| `site:bloomberg.com OR site:reuters.com CXMT` | ✅ 8 条全部命中两站（首轮 Bloomberg 7 / Reuters 1），无转载站混入 |
| `need_content=true` | ✅ 3/3 条带正文，最长约 3KB |
| Fetch Bloomberg 文章 | ✅ 200，但只有 0.6–0.8KB（付费墙截断，仅导语） |
| Fetch Reuters 文章（搜索返回的 URL） | ✅ 200，约 11KB 正文 |
| Fetch Reuters canonical URL | ❌ 404（搜索引擎返回的 URL 带 `/<hash>/` 前缀，需用搜索给的链接） |
| Fetch `bloomberg.com/asia` | ⚠️ 200，但只有 196B 导航壳；栏目页不是文章列表，要拿具体文章 URL |

对盯盘最有价值的三点：

1. **`site:` 是严格约束**（AnySearch 只是弱提示，会混入 facebook / x / tradingview）；
2. **返回结构化 `date` / `authority` / `rerank_score` / `summary`**，不用再从 markdown 里正则抠日期；
3. **Fetch 能读 Reuters 全文**（用搜索结果里的改写 URL），而 `web_fetch` 直连会被 DataDome 401；Bloomberg 通常只放出导语。

## 3. 用法

```bash
# 默认：新闻 + 站内搜索 + 正文 + Fetch
npm run test:deepseek-search

# 自定义标的和新闻词
npm run test:deepseek-search -- --query "长鑫存储 CXMT" --news "存储芯片 合约价" --count 8

# 只看搜索，不测 Fetch
npm run test:deepseek-search -- --skip-fetch

# 打印站内搜索原始 JSON
npm run test:deepseek-search -- --json
```

Key 读取顺序：环境变量 `DEEPSEEK_API_KEY` → `.env.local`。可选 `DEEPSEEK_API_BASE`。

脚本输出：每条结果的日期、距今天数、`authority`、`rerank_score`、站点、标题、链接；末尾汇总通过/失败项。硬失败（无结果、`site:` 越界、正文为空、Bloomberg 抓取失败）退出码为 1。

## 4. 与 AnySearch 的差异

| 维度 | DeepSeek Search | AnySearch |
|---|---|---|
| `site:` | 严格 | 弱约束，需域名过滤 |
| 日期 | 结构化 `date` | 正文尾部 `date:` 文本，需解析 |
| 权威度 | `authority` + `rerank_score` | 无 |
| 正文 | `need_content` 返回 `content` | 返回 `content` |
| 抓原文 | `/v1/tools/fetch`，可读 Reuters 全文；Bloomberg 通常只到导语 | 依赖 `web_fetch`，两家均被拦 |
| 鉴权 | DeepSeek Key（与模型同一个） | `ANYSEARCH_API_KEY` |

## 5. 已接入「盯」

- 工具：`deepseek_search` / `deepseek_fetch`（`lib/deepseek-search-tool.mjs`），随 `DEEPSEEK_API_KEY` 自动注册；`DEEPSEEK_SEARCH=0` 关闭。
- 扫描：`buildSourceTasks()` 首选 `deepseek-search`，自动带 `after:<上次扫描日或 dataCutoff>`；过滤后 0 条或调用失败才跑 `anysearch-primary` 兜底，通用 AnySearch 查询保留。
- 排序：主来源仍按 S2 + 5 分权重，`rerank_score` 再折算 0–6 分；域名过滤不变。
- 研判：prompt 优先 `deepseek_fetch` 打开原文（Reuters 用搜索返回的链接），`web_fetch` 只作兜底；只拿到导语/摘要时不能判 `material=true`。
- 回归：`npm run test:watch`（含 DeepSeek 命中与 AnySearch 兜底两条路径）、`npm run test:deepseek-tool`（mock）、`npm run test:deepseek-search`（真实 API）。
