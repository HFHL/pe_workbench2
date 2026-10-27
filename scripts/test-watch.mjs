#!/usr/bin/env node
/**
 * 「盯」self-test: brief extraction, finding contract, source parsing and one
 * end-to-end service run with a deterministic stub session.
 *
 * No network, no model, no real data/.
 *
 *   node scripts/test-watch.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../store.mjs";
import {
  buildWatchBrief,
  briefHighlights,
  companyAliases,
  validateWatchBrief,
} from "../lib/watch/brief.mjs";
import {
  findingToMessage,
  normalizeFinding,
  silentCheckText,
  validateFinding,
} from "../lib/watch/contract.mjs";
import {
  buildPrimaryWebQuery,
  buildSourceTasks,
  candidateHash,
  candidatesFromAnySearch,
  candidatesFromDeepSeek,
  candidatesFromWestock,
  isPrimaryWebDomain,
  parseAnySearchResults,
  parseMarkdownTable,
  rankCandidates,
} from "../lib/watch/sources.mjs";
import { computeNextDeepCheck, createWatchService } from "../server/watch/service.mjs";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const STATE = {
  schema_version: "2.0",
  framework_id: "IF-TEST-CXMT",
  revision: 3,
  subject: {
    company: "长鑫科技（CXMT，688825.SH）",
    security: "688825.SH",
    currency: "RMB",
    units: "百万元",
    model_as_of: "2026-09-04",
    valuation_date: "2026-09-04",
    market_price_date: "2026-10-23",
    data_cutoff: "2026-10-23",
    model_file: "uploads/model.xlsx",
    horizon: "2027 目标价",
  },
  assumptions: [
    { id: "A2", statement: "目标 P/E 12×" },
    { id: "A4", statement: "2030E 毛利率 60%" },
  ],
  theses: [
    { id: "T1", statement: "量价齐升", status: "active", confidence: "medium" },
    { id: "T2", statement: "利润率抬升", status: "active", confidence: "medium" },
  ],
  sensitivities: [
    {
      id: "S1",
      method: "model_input",
      assumption_ids: ["A2"],
      baseline: "12× → 62 元",
      perturbation: "目标 P/E 12→15 / 8",
      result: "62 → 77 / 41 元（+24%/-34%）",
      affects: ["T1"],
    },
    {
      id: "S2",
      method: "model_input",
      assumption_ids: ["A4"],
      baseline: "毛利率 60% → 62 元",
      perturbation: "毛利率 60%±10pp",
      result: "62 → 51 / 74 元（-18%/+19%）",
      affects: ["T2"],
    },
  ],
  valuations: [
    { id: "V1", scenario: "base", value: 62, unit: "元/股", formula: "7.4 × 12 ÷ 1.127^3" },
    { id: "V2", scenario: "bull", value: 116, unit: "元/股" },
    { id: "V3", scenario: "bear", value: 40, unit: "元/股" },
  ],
  falsifiers: [
    {
      id: "F3",
      thesis_id: "T2",
      metric: "毛利率",
      threshold: "跌破 60%",
      warning: "连续两季低于 60%",
      source: "季报",
      frequency: "quarterly",
      status: "armed",
      action: "下调毛利率并重算 V1",
    },
    {
      id: "F1",
      thesis_id: "T1",
      metric: "HBM 收入占比",
      threshold: "2027 未达 10%",
      source: "季报 / TrendForce",
      frequency: "quarterly",
      status: "armed",
      action: "下调 T1",
    },
  ],
  market: { price: 42.85, price_date: "2026-10-23" },
};

console.log("brief 抽取");
{
  const brief = buildWatchBrief({
    state: STATE,
    reportPath: "exports/demo/投资框架报告.md",
    reportVersion: 3,
    statePath: "exports/demo/analysis-state.json",
    modelPath: "uploads/model.xlsx",
    now: new Date("2026-10-25T09:00:00+08:00"),
  });
  check("公司/证券", brief.target.company.includes("长鑫") && brief.target.security === "688825.SH");
  check("基准确认 62", brief.valuation.base?.value === 62);
  check("敏感性按影响排序", brief.topSensitivities[0]?.id === "S1" && brief.topSensitivities[0]?.impactPercent === 34,
    JSON.stringify(brief.topSensitivities.map((item) => [item.id, item.impactPercent])));
  check("S2 影响解析为 19%", brief.topSensitivities.find((item) => item.id === "S2")?.impactPercent === 19);
  check("敏感性 driver 可读", brief.topSensitivities.find((item) => item.id === "S2")?.driver === "2030E 毛利率 60%",
    brief.topSensitivities.find((item) => item.id === "S2")?.driver);
  check("检索词带证券代码", brief.queries.anysearch[0]?.includes("688825.SH"));
  check("检索词不混入假设 ID", !brief.queries.topics.includes("A2") && !brief.queries.topics.includes("A4"),
    JSON.stringify(brief.queries.topics));
  check("西股代码归一", brief.queries.westockSymbol === "sh688825");
  check("失效边界非空", brief.invalidation.boundaries.length >= 3);
  check("brief 校验通过", validateWatchBrief(brief).length === 0, validateWatchBrief(brief).join("; "));
  check("状态条 highlights", briefHighlights(brief).length >= 2);

  // Primary web sources: Bloomberg / Reuters are searched first, by English alias.
  check("解析公司别名", brief.target.aliases.includes("CXMT") && brief.target.aliases.includes("688825.SH"),
    JSON.stringify(brief.target.aliases));
  check("剥离“原/现”前缀",
    companyAliases("长鑫科技（原长鑫存储，CXMT，688825.SH）").includes("长鑫存储"),
    JSON.stringify(companyAliases("长鑫科技（原长鑫存储，CXMT，688825.SH）")));
  const primaryQuery = buildPrimaryWebQuery(brief);
  check("主来源检索词带 site 限定",
    primaryQuery.includes("site:bloomberg.com") && primaryQuery.includes("site:reuters.com"),
    primaryQuery);
  check("主来源检索词用英文别名", primaryQuery.includes("CXMT") && !primaryQuery.includes("688825.SH"),
    primaryQuery);
  check("无括号时别名回退为空", companyAliases("贵州茅台").length === 0, JSON.stringify(companyAliases("贵州茅台")));
  check("主域名判定", isPrimaryWebDomain("www.bloomberg.com") && isPrimaryWebDomain("reuters.com")
    && !isPrimaryWebDomain("bloomberg.com.evil.test"));

  const tasks = buildSourceTasks(brief, { after: "2026-10-23T09:00:00.000Z", deepseek: true });
  const deepseekTask = tasks.find((task) => task.adapter === "deepseek-search");
  const primaryTask = tasks.find((task) => task.adapter === "anysearch-primary");
  check("扫描任务首选 DeepSeek", Boolean(deepseekTask), JSON.stringify(tasks.map((task) => task.adapter)));
  check("DeepSeek 任务带 after 时间窗", deepseekTask?.query.includes("after:2026-10-23"), deepseekTask?.query);
  check("主来源任务限定两个域名", deepseekTask?.domains?.length === 2 && deepseekTask?.sourceTier === 2);
  check("AnySearch 主来源标记为兜底", primaryTask?.fallback === true && !primaryTask?.query.includes("after:"),
    JSON.stringify(primaryTask));
  check("DeepSeek 排在兜底和通用搜索前",
    tasks.findIndex((task) => task.adapter === "deepseek-search")
      < tasks.findIndex((task) => task.adapter === "anysearch-primary")
      && tasks.findIndex((task) => task.adapter === "anysearch-primary")
      < tasks.findIndex((task) => task.adapter === "anysearch"));
  const legacyTasks = buildSourceTasks(brief, { deepseek: false });
  check("DeepSeek 关闭时不出现兜底标记",
    !legacyTasks.some((task) => task.adapter === "deepseek-search")
      && legacyTasks.some((task) => task.adapter === "anysearch-primary" && !task.fallback));

  const longBrief = {
    ...brief,
    target: {
      ...brief.target,
      aliases: ["A".repeat(60), "B".repeat(60), "C".repeat(60)],
    },
  };
  const longTask = buildSourceTasks(longBrief, { after: "2026-10-23", deepseek: true })
    .find((task) => task.adapter === "deepseek-search");
  check("DeepSeek 检索词不超过 128 字符且保留 after",
    longTask.query.length <= 128 && longTask.query.includes("after:2026-10-23"),
    `${longTask.query.length}: ${longTask.query}`);
}

console.log("finding 契约");
{
  const good = normalizeFinding({
    material: true,
    severity: "warning",
    headline: "F3 触发：Q3 毛利率 57%",
    summary: "毛利率跌破 60%，S2 下沿对应目标价 51 元。",
    affected: [
      { kind: "falsifier", id: "F3", note: "跌破阈值" },
      { kind: "sensitivity", id: "S2", note: "毛利率 -3pp" },
    ],
    impact: { label: "目标价", from: "62 元", to: "51 元", delta: "-18%", direction: "down" },
    evidence: [{ title: "三季报", url: "https://example.com/report", source: "公司公告", sourceTier: 1 }],
    confidence: "high",
    materialReason: "直接触发 F3，并落在 S2 的下沿",
    suggestedAction: "人工复核 F3 后重算 S2",
    checked: ["三季报", "毛利率"],
  }, { watchId: "w1", checkId: "c1" });
  check("规范 finding 通过", validateFinding(good).length === 0, validateFinding(good).join("; "));
  check("finding 带链接", good.evidence[0].url.startsWith("https://"));
  const message = findingToMessage(good, { watchId: "w1", checkId: "c1" });
  check("finding 转消息", message?.kind === "finding" && message?.citations.length === 1);

  const noLink = normalizeFinding({ ...good, evidence: [] }, { watchId: "w1" });
  check("重大发现缺链接被拦下", validateFinding(noLink).some((error) => error.includes("链接")));
  const badUrl = normalizeFinding({ ...good, evidence: [{ title: "x", url: "javascript:alert(1)" }] }, { watchId: "w1" });
  check("非 http 链接被丢弃", badUrl.evidence.length === 0);

  const silent = normalizeFinding({ material: false, materialReason: "没有新增披露", checked: ["公告", "新闻"] }, { watchId: "w1" });
  check("沉默不产生消息", findingToMessage(silent) === null);
  check("沉默状态文案", silentCheckText(silent).length > 0);
}

console.log("来源解析与排序");
{
  const table = `| 标题 | 时间 | 摘要 | 链接 |
|---|---|---|---|
| 三季报：毛利率 57% | 2026-10-24 | 毛利率低于预期 | https://example.com/a |
| 董事会决议 | 2026-10-24 | 日常公告 | https://example.com/c |`;
  const rows = parseMarkdownTable(table);
  check("解析 westock 表格", rows.length === 2 && rows[0]["标题"].includes("三季报"));
  const westock = candidatesFromWestock(rows, { kind: "notice" });
  check("公告 tier=1", westock[0].sourceTier === 1);

  const anyText = `## 1. 长鑫科技三季报毛利率
来源：https://example.com/b
摘要：毛利率 57%，低于 60% 阈值
## 2. 行业评论
来源：https://example.com/d
摘要：一般评论`;
  const anyRows = parseAnySearchResults(anyText);
  check("解析 AnySearch", anyRows.length === 2 && anyRows[0].url === "https://example.com/b");
  const datedRows = parseAnySearchResults(`## 1. CXMT profit
来源：https://www.bloomberg.com/news/a
摘要：profit surge
date: Oct 13, 2026`);
  check("解析 AnySearch 发布日期", datedRows[0]?.publishedAt === "2026-10-13", datedRows[0]?.publishedAt);
  const dupRows = parseAnySearchResults(`## 1. CXMT profit
来源：https://www.bloomberg.com/news/a
摘要：profit surge
## 1. CXMT profit

**URL**: https://www.bloomberg.com/news/a
profit surge body date: Oct 13, 2026`);
  check("合并摘要块与正文块", dupRows.length === 1 && dupRows[0].publishedAt === "2026-10-13"
    && dupRows[0].url.includes("bloomberg.com"), JSON.stringify(dupRows));
  const candidates = [...westock, ...candidatesFromAnySearch(anyRows)];
  const ranked = rankCandidates(candidates, { queries: { topics: ["毛利率"] } });
  check("财报/公告排在评论前", ranked[0].title.includes("三季报"), JSON.stringify(ranked.map((item) => [item.title, item.score])));
  check("去重", rankCandidates([...candidates, ...candidates], { queries: { topics: [] } }).length === candidates.length);
  check("稳定 hash", candidateHash({ adapter: "x", title: "a", url: "b" }) === candidateHash({ adapter: "x", title: "a", url: "b" }));
  const routine = rankCandidates([{ title: "长鑫科技：关于修订《公司章程》并办理工商变更登记的公告", url: "", snippet: "" }], { queries: { topics: [] } });
  check("例行公告被过滤", routine.length === 0);
  const quotePage = rankCandidates([{ title: "长鑫科技(688825)股票股价, 实时行情, 走势图", url: "", snippet: "" }], { queries: { topics: [] } });
  check("行情页被过滤", quotePage.length === 0);
  const context = { target: { company: "长鑫科技（CXMT，688825.SH）", security: "688825.SH" }, queries: { topics: ["毛利率"] } };
  const unrelated = rankCandidates([{ adapter: "anysearch", title: "小摩：国有内银第三季料再录强劲业绩", url: "https://example.com/x", snippet: "" }], context);
  check("无关新闻被过滤", unrelated.length === 0);
  const industry = rankCandidates([{ adapter: "anysearch", title: "DRAM 合约价连续两季环比转负", url: "https://example.com/y", snippet: "" }], context);
  check("行业新闻保留", industry.length === 1);

  // Bloomberg / Reuters: alias-only English headline must survive the relevance
  // filter, and a primary-domain link must outrank the same story on a repost.
  const primaryContext = {
    target: { company: "长鑫科技（CXMT，688825.SH）", aliases: ["CXMT", "长鑫存储"], security: "688825.SH" },
    queries: { topics: ["毛利率"] },
  };
  const english = rankCandidates([{
    adapter: "anysearch-primary",
    title: "China's CXMT Swings to Profit After Memory Chip Prices Surge",
    url: "https://www.bloomberg.com/news/articles/2026-10-16/cxmt-profit",
    snippet: "",
    sourceTier: 2,
  }], primaryContext);
  check("英文标题按别名保留", english.length === 1 && english[0].primary === true, JSON.stringify(english));
  const repost = rankCandidates([{
    adapter: "anysearch",
    title: "China's CXMT Swings to Profit After Memory Chip Prices Surge",
    url: "https://www.facebook.com/repost",
    snippet: "",
  }], primaryContext);
  check("主来源分数更高", Boolean(english[0] && repost[0] && english[0].score > repost[0].score),
    `${english[0]?.score} vs ${repost[0]?.score}`);

  const mixed = [
    { title: "CXMT profit", url: "https://www.bloomberg.com/news/a" },
    { title: "CXMT repost", url: "https://www.facebook.com/x" },
    { title: "CXMT wire", url: "https://www.reuters.com/world/b" },
  ];
  const filtered = candidatesFromAnySearch(mixed, {
    domains: ["bloomberg.com", "reuters.com"],
    sourceTier: 2,
    adapter: "anysearch-primary",
  });
  check("主来源结果按域名过滤", filtered.length === 2 && filtered.every((item) => item.sourceTier === 2),
    JSON.stringify(filtered.map((item) => item.domain)));
  check("主来源与通用搜索共享 hash",
    candidateHash({ adapter: "anysearch-primary", title: "a", url: "b" })
      === candidateHash({ adapter: "anysearch", title: "a", url: "b" }));
  check("DeepSeek 与兜底共享 hash",
    candidateHash({ adapter: "deepseek-search", title: "a", url: "b" })
      === candidateHash({ adapter: "anysearch-primary", title: "a", url: "b" }));

  // DeepSeek results: structured date/rerank, strict domain filter.
  const deepseekRows = [
    {
      title: "China's CXMT Swings to Profit After Memory Chip Prices Surge",
      url: "https://www.bloomberg.com/news/articles/2026-10-16/cxmt-profit",
      summary: "CXMT turned profitable as memory prices surged.",
      date: "2026-10-15T16:00:00+00:00",
      authority: 4,
      rerankScore: 2.4,
      siteName: "Bloomberg.com",
    },
    {
      title: "CXMT profit repost",
      url: "https://www.facebook.com/repost",
      summary: "same story, reposted",
      date: "2026-10-15T16:00:00+00:00",
      authority: 1,
      rerankScore: 0.5,
    },
  ];
  const deepseekCandidates = candidatesFromDeepSeek(deepseekRows, {
    domains: ["bloomberg.com", "reuters.com"],
    sourceTier: 2,
  });
  check("DeepSeek 结果按域名过滤", deepseekCandidates.length === 1
    && deepseekCandidates[0].domain === "www.bloomberg.com", JSON.stringify(deepseekCandidates));
  check("DeepSeek 日期转为本地日期",
    ["2026-10-15", "2026-10-16"].includes(deepseekCandidates[0]?.publishedAt),
    deepseekCandidates[0]?.publishedAt);
  check("DeepSeek 用 summary 作摘要", deepseekCandidates[0]?.snippet.includes("turned profitable"));
  check("DeepSeek 保留 rerank/authority",
    deepseekCandidates[0]?.rerankScore === 2.4 && deepseekCandidates[0]?.authority === 4);
  const reranked = rankCandidates([{
    adapter: "deepseek-search",
    title: "CXMT profit",
    url: "https://www.bloomberg.com/news/a",
    rerankScore: 3,
    sourceTier: 2,
  }], primaryContext)[0];
  const plain = rankCandidates([{
    adapter: "deepseek-search",
    title: "CXMT profit",
    url: "https://www.bloomberg.com/news/a",
    rerankScore: 0,
    sourceTier: 2,
  }], primaryContext)[0];
  check("DeepSeek 相关度参与排序", reranked.score - plain.score === 6, `${reranked.score} vs ${plain.score}`);
}

console.log("深度复核时间");
{
  const from = new Date();
  const next = new Date(computeNextDeepCheck("18:30", from));
  const diff = next.getTime() - from.getTime();
  check("下次深度复核在未来 24h 内", diff > 0 && diff <= 25 * 60 * 60 * 1000, String(diff));
}

console.log("service 端到端（stub session / stub tools）");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-watch-"));
  const workspace = path.join(root, "projects", "test");
  fs.mkdirSync(path.join(workspace, "exports", "demo"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "exports", "demo", "投资框架报告.md"), "# 投资框架报告\n\n## 五、敏感性\n\n## 六、失效条件\n");
  fs.writeFileSync(path.join(workspace, "exports", "demo", "analysis-state.json"), JSON.stringify(STATE, null, 2));
  fs.writeFileSync(path.join(workspace, "uploads", "model.xlsx"), "fake-xlsx");

  const store = await openStore({ root, workspace, projectId: "test", projectName: "Test", seed: false });
  store.indexFile("exports/demo/投资框架报告.md", { kind: "output" });
  store.indexFile("exports/demo/analysis-state.json", { kind: "output" });
  store.indexFile("uploads/model.xlsx", { kind: "input" });

  const ctx = { id: "test", name: "Test", root: workspace, store, tools: [] };
  const events = [];
  const bus = { broadcastGlobal: (payload, projectId) => events.push({ payload, projectId }) };
  const projectManager = { list: () => [ctx] };

  const finding = {
    material: true,
    severity: "warning",
    headline: "F3 触发：Q3 毛利率 57%",
    summary: "毛利率跌破 60%，S2 下沿对应目标价 51 元。",
    affected: [
      { kind: "falsifier", id: "F3", note: "跌破阈值" },
      { kind: "sensitivity", id: "S2", note: "毛利率 -3pp" },
    ],
    impact: { label: "目标价", from: "62 元", to: "51 元", delta: "-18%", direction: "down" },
    evidence: [{ title: "三季报", url: "https://example.com/report", source: "公司公告", sourceTier: 1 }],
    confidence: "high",
    materialReason: "直接触发 F3，并落在 S2 的下沿",
    suggestedAction: "人工复核 F3 后重算 S2",
    checked: ["三季报", "毛利率"],
    reportVersion: 3,
  };

  let sessionsCreated = 0;
  let materialMode = true;
  const sessions = {
    async createEntry({ ctx: entryCtx }) {
      sessionsCreated += 1;
      const session = {
        sessionId: `sess_${sessionsCreated}`,
        sessionName: "",
        messages: [],
        listeners: new Set(),
        setSessionName(name) { this.sessionName = name; },
        subscribe(listener) {
          this.listeners.add(listener);
          return () => this.listeners.delete(listener);
        },
        abort() {},
        emit(event) {
          for (const listener of [...this.listeners]) listener(event);
        },
        async prompt(text) {
          const match = text.match(/把结果写到 `([^`]+)`/);
          if (match) {
            const abs = path.join(entryCtx.root, match[1]);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, JSON.stringify(materialMode
              ? finding
              : { material: false, materialReason: "没有新增披露", checked: ["公告", "新闻"] }));
            this.messages.push({ role: "assistant", content: [{ type: "text", text: "检查完成" }] });
            this.emit({
              type: "tool_execution_start",
              toolCallId: "tool-1",
              toolName: "web_fetch",
              args: { url: "https://example.com/report" },
            });
            this.emit({
              type: "tool_execution_end",
              toolCallId: "tool-1",
              toolName: "web_fetch",
              result: { content: [{ type: "text", text: "三季报正文：毛利率 57%" }] },
            });
          } else {
            this.messages.push({ role: "assistant", content: [{ type: "text", text: "**现在一切安好。** 最近一次检查没有重大变化。" }] });
          }
          setTimeout(() => {
            for (const listener of [...this.listeners]) listener({ type: "agent_settled" });
          }, 5);
        },
      };
      return { id: session.sessionId, session, ctx: entryCtx };
    },
    async ensureEntry() { return null; },
  };

  const toolText = {
    westock: `| 标题 | 时间 | 摘要 | 链接 |
|---|---|---|---|
| 三季报：毛利率 57% | 2026-10-24 | 毛利率低于预期 | https://example.com/a |`,
    anysearch: `## 1. 长鑫科技三季报毛利率
来源：https://example.com/b
摘要：毛利率 57%，低于 60% 阈值`,
    primary: `## 1. China's CXMT Swings to Profit After Memory Chip Prices Surge
来源：https://www.bloomberg.com/news/articles/2026-10-16/cxmt-profit
摘要：CXMT turned profitable as memory prices surged
## 2. CXMT profit repost
来源：https://www.facebook.com/repost/1
摘要：same story, reposted`,
  };
  let deepseekMode = "ok";
  ctx.tools = [
    { name: "westock_query", execute: async () => ({ content: [{ type: "text", text: toolText.westock }] }) },
    {
      name: "deepseek_search",
      execute: async () => {
        if (deepseekMode === "empty") {
          return { content: [{ type: "text", text: "DeepSeek 搜索没有返回匹配结果。" }], details: { results: [] } };
        }
        return {
          content: [{ type: "text", text: "## 1. China's CXMT Swings to Profit\n来源：https://www.bloomberg.com/news/articles/2026-10-16/cxmt-profit" }],
          details: {
            results: [
              {
                title: "China's CXMT Swings to Profit After Memory Chip Prices Surge",
                url: "https://www.bloomberg.com/news/articles/2026-10-16/cxmt-profit",
                summary: "CXMT turned profitable as memory prices surged.",
                date: "2026-10-15T16:00:00+00:00",
                authority: 4,
                rerankScore: 2.4,
                siteName: "Bloomberg.com",
              },
              {
                title: "CXMT profit repost",
                url: "https://www.facebook.com/repost/1",
                summary: "same story, reposted",
                date: "2026-10-15T16:00:00+00:00",
                authority: 1,
                rerankScore: 0.5,
              },
            ],
          },
        };
      },
    },
    {
      name: "anysearch_search",
      execute: async (_id, params) => ({
        content: [{
          type: "text",
          text: String(params?.query || "").includes("site:bloomberg.com") ? toolText.primary : toolText.anysearch,
        }],
      }),
    },
  ];

  const service = createWatchService({
    config: { watchMaxRuntimeMs: 2000, watchAskTimeoutMs: 2000, deepseekSearch: true },
    bus,
    projectManager,
    sessions,
    logger: { warn() {}, log() {} },
  });

  const overview = service.overview(ctx);
  check("未开启时能识别目标", overview.watch === null && overview.detection?.found === true);
  check("识别到 2 条敏感性", overview.detection?.sensitivities === 2, JSON.stringify(overview.detection?.sensitivities));
  check("未开启时不带 state 原文", !overview.detection?.state);

  const created = await service.createWatch(ctx, { intervalMinutes: 30, deepCheckTime: "18:30" });
  check("创建 watch", created.created === true && Boolean(created.watch?.id));
  check("创建后 brief 有基准", created.watch?.brief?.valuation?.base?.value === 62);
  check("欢迎消息存在", store.listWatchMessages({ watchId: created.watch.id }).length === 1);

  const scan = await service.scan(ctx, created.watch.id);
  check("规则扫描入库", scan.added >= 2, JSON.stringify(scan));
  check("候选事件可查", store.listWatchEvents({ watchId: created.watch.id }).length >= 2);
  const scanLogs = store.listWatchLogs({ watchId: created.watch.id, runId: scan.runId });
  check("扫描日志含来源", scanLogs.some((log) => log.kind === "source" && log.payload.ok === true), JSON.stringify(scanLogs.map((log) => log.kind)));
  check("扫描日志含 DeepSeek 主来源", scanLogs.some((log) => log.kind === "source"
    && log.payload.adapter === "deepseek-search"
    && log.payload.primary === true
    && log.payload.count === 1), JSON.stringify(scanLogs.filter((log) => log.kind === "source").map((log) => log.payload)));
  check("DeepSeek 命中时不走兜底", scan.fallbackUsed === false
    && !scanLogs.some((log) => log.kind === "source" && log.payload.fallback === true),
    JSON.stringify(scan));
  const scannedEvents = store.listWatchEvents({ watchId: created.watch.id });
  check("Bloomberg 候选入库", scannedEvents.some((event) => String(event.domain || "").endsWith("bloomberg.com")),
    JSON.stringify(scannedEvents.map((event) => [event.title, event.domain])));
  check("主来源候选不入库 Facebook",
    !scannedEvents.some((event) => String(event.domain || "").includes("facebook") && event.adapter === "anysearch-primary"),
    JSON.stringify(scannedEvents.map((event) => [event.title, event.domain])));
  check("扫描日志含候选", scanLogs.some((log) => log.kind === "candidate" && log.payload.title), JSON.stringify(scanLogs.map((log) => log.kind)));
  check("扫描日志含结束", scanLogs.some((log) => log.kind === "run_end" && log.payload.status === "watching"));
  check("日志裁剪可用", store.pruneWatchLogs(created.watch.id, 200) >= 0);

  // Fallback path: DeepSeek returns zero in-domain hits -> AnySearch takes over.
  deepseekMode = "empty";
  const fallbackScan = await service.scan(ctx, created.watch.id);
  check("DeepSeek 无结果时启用 AnySearch 兜底", fallbackScan.fallbackUsed === true, JSON.stringify(fallbackScan));
  const fallbackLogs = store.listWatchLogs({ watchId: created.watch.id, runId: fallbackScan.runId });
  check("兜底来源写入审计日志", fallbackLogs.some((log) => log.kind === "source"
    && log.payload.adapter === "anysearch-primary"
    && log.payload.fallback === true));
  deepseekMode = "ok";

  const result = await service.runCheck(ctx, created.watch.id, { trigger: "scan", force: true });
  check("LLM 研判产出 finding", result.material === true && Boolean(result.message?.id), JSON.stringify(result));
  check("finding 进对话", store.listWatchMessages({ watchId: created.watch.id }).some((message) => message.kind === "finding"));
  check("候选标记为已用", store.listWatchEvents({ watchId: created.watch.id }).length === 0);
  check("检查记录为 finding", store.listWatchChecks(created.watch.id)[0]?.status === "finding");
  check("watch 计数更新", store.getWatch(created.watch.id).counts.findings === 1);
  check("SSE 广播 watch.message", events.some((event) => event.payload.type === "watch.message"));
  const gateLogs = store.listWatchLogs({ watchId: created.watch.id, runId: result.checkId });
  check("研判日志含工具", gateLogs.some((log) => log.kind === "tool_end" && log.payload.detail.includes("example.com")),
    JSON.stringify(gateLogs.map((log) => log.kind)));
  check("研判日志含判断", gateLogs.some((log) => log.kind === "judgment" && log.payload.material === true));
  check("研判日志含结束", gateLogs.some((log) => log.kind === "run_end" && log.payload.status === "finding"));

  // Silent path: a second check with no material finding must not add messages.
  const before = store.listWatchMessages({ watchId: created.watch.id }).length;
  materialMode = false;
  const silent = await service.runCheck(ctx, created.watch.id, { trigger: "deep", force: true });
  const after = store.listWatchMessages({ watchId: created.watch.id }).length;
  check("深度复核可静默", silent.material === false, JSON.stringify(silent));
  const silentLogs = store.listWatchLogs({ watchId: created.watch.id, runId: silent.checkId });
  check("静默也写判断日志", silentLogs.some((log) => log.kind === "judgment" && log.payload.material === false));
  check("静默也写结束日志", silentLogs.some((log) => log.kind === "run_end" && log.payload.status === "silent"));

  const asked = await service.ask(ctx, created.watch.id, "现在怎么样？");
  check("追问立即入列", asked.message?.role === "user");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const messages = store.listWatchMessages({ watchId: created.watch.id });
  check("追问有回答", messages.some((message) => message.kind === "answer" && message.body.includes("一切安好")),
    JSON.stringify(messages.map((message) => [message.role, message.kind])));
  check("对话会话已绑定", Boolean(store.getWatch(created.watch.id).sessionId));

  const updated = await service.updateWatch(ctx, created.watch.id, { enabled: false });
  check("暂停盯盘", updated?.enabled === false && updated?.status === "paused");
  const removed = await service.deleteWatch(ctx, created.watch.id);
  check("删除盯盘", removed === true && store.getCurrentWatch() === null);
  check("删除后消息级联清理", store.listWatchMessages({ watchId: created.watch.id }).length === 0);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
