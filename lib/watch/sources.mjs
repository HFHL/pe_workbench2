/**
 * Watch source adapters: turn westock / AnySearch output into candidate events.
 *
 * Rule scan is deliberately dumb and cheap: fetch, parse, dedupe, rank. It does
 * not decide materiality — that is the LLM gate's job. Anything that cannot be
 * parsed into a title is dropped rather than guessed.
 */

import crypto from "node:crypto";

import { classifyHeadline } from "./brief.mjs";

const CATEGORY_WEIGHT = {
  财报: 5,
  公告: 4,
  监管: 4,
  行业数据: 3,
  评级: 1,
  其他: 0,
};

function clean(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pick(row, keys) {
  for (const key of keys) {
    const value = clean(row?.[key]);
    if (value) return value;
  }
  return "";
}

function stripPipes(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "");
}

export function parseMarkdownTable(text) {
  const lines = String(text || "").split("\n").filter((line) => line.trim().startsWith("|"));
  if (lines.length < 3) return [];
  const header = stripPipes(lines[0]).split("|").map((cell) => cell.trim());
  return lines.slice(2).map((line) => {
    const values = stripPipes(line).split("|").map((cell) => cell.trim());
    const row = {};
    header.forEach((key, index) => {
      if (key) row[key] = values[index] ?? "";
    });
    return row;
  }).filter((row) => pick(row, ["title", "标题", "公告标题", "新闻标题", "summary", "摘要"]));
}

export function parseAnySearchResults(text) {
  const raw = String(text || "");
  const chunks = raw.split(/\n(?=##\s+\d+\.\s)/).filter((chunk) => /^##\s+\d+\.\s/.test(chunk.trim()));
  return chunks.map((chunk) => {
    const title = chunk.match(/^##\s+\d+\.\s*(.+)$/m)?.[1]?.trim() || "";
    const url = chunk.match(/^来源：\s*(\S+)/m)?.[1]?.trim() || "";
    const snippet = chunk.match(/^摘要：\s*(.+)$/m)?.[1]?.trim() || "";
    return { title, url, snippet, content: chunk.replace(/^##\s+\d+\.\s*.+$/m, "").trim() };
  }).filter((item) => item.title || item.url);
}

export function domainOf(url) {
  try {
    return new URL(String(url || "")).hostname;
  } catch {
    return "";
  }
}

export function candidateHash({ adapter = "", kind = "", title = "", url = "" } = {}) {
  return crypto
    .createHash("sha256")
    .update([adapter, kind, clean(title), clean(url)].join("\u0001"))
    .digest("hex");
}

/**
 * Source plan for one watch. The rule scanner runs these in order; each task
 * maps to exactly one tool call.
 */
export function buildSourceTasks(brief) {
  const symbol = clean(brief?.queries?.westockSymbol);
  const queries = asArray(brief?.queries?.anysearch);
  const tasks = [];
  if (symbol) {
    tasks.push({ adapter: "westock", kind: "notice", args: ["notice", "list", symbol], sourceTier: 1 });
    tasks.push({ adapter: "westock", kind: "news", args: ["news", symbol], sourceTier: 3 });
  }
  // One search per scan keeps the API quota predictable; westock covers the
  // other two legs (notices + news). The brief's second query is used as the
  // fallback in deep checks, where the agent can decide to run it.
  if (queries[0]) {
    tasks.push({ adapter: "anysearch", kind: "search", query: queries[0], sourceTier: 3 });
  }
  return tasks;
}

export function candidatesFromWestock(rows, { kind = "news" } = {}) {
  return asArray(rows).map((row) => {
    const title = pick(row, ["title", "标题", "公告标题", "新闻标题", "summary", "摘要"]);
    if (!title) return null;
    const url = pick(row, ["url", "链接", "原文链接"]);
    const publishedAt = pick(row, ["time", "时间", "日期", "发布时间"]);
    return {
      adapter: kind === "notice" ? "westock-notice" : "westock-news",
      kind,
      title,
      url,
      snippet: pick(row, ["summary", "摘要", "content", "内容", "src", "来源"]),
      publishedAt,
      sourceTier: kind === "notice" ? 1 : 3,
      domain: domainOf(url) || "westock",
      raw: { id: pick(row, ["id", "代码"]), source: pick(row, ["src", "来源"]) },
    };
  }).filter(Boolean);
}

export function candidatesFromAnySearch(results, { query = "" } = {}) {
  return asArray(results).map((row) => {
    const title = clean(row?.title);
    if (!title) return null;
    return {
      adapter: "anysearch",
      kind: "search",
      title,
      url: clean(row?.url),
      snippet: clean(row?.snippet) || clean(row?.content).slice(0, 600),
      publishedAt: "",
      sourceTier: 3,
      domain: domainOf(row?.url),
      raw: { query },
    };
  }).filter(Boolean);
}

const NOISE_TITLE = /股票股价|实时行情|历史行情|走势图|行情中心|股吧|百科|资金流向|主力资金|龙虎榜|bookbuilding/i;
const INDUSTRY_TERMS = ["DRAM", "NAND", "HBM", "存储", "内存", "合约价", "ASP", "晶圆", "产能", "出口管制", "半导体"];
const ROUTINE_NOTICE = /公司章程|议事规则|管理制度|法律意见书|会议资料|核查意见|薪酬管理制度|对外担保管理制度|募集资金管理制度|董事和高级管理人员/i;

export function isRoutineOrNoise(title) {
  const text = String(title || "");
  return NOISE_TITLE.test(text) || ROUTINE_NOTICE.test(text);
}

export function rankCandidates(candidates, brief) {
  const topics = asArray(brief?.queries?.topics).map((item) => clean(item)).filter(Boolean);
  const company = clean(brief?.target?.company).split(/[（(]/)[0].trim().toLowerCase();
  const security = clean(brief?.target?.security).split(".")[0].trim().toLowerCase();
  const hasCompanyContext = Boolean(company || security);
  const merged = new Map();

  for (const candidate of asArray(candidates)) {
    const title = clean(candidate?.title);
    if (!title || isRoutineOrNoise(title)) continue;
    const text = `${title} ${candidate?.snippet || ""}`.toLowerCase();
    const headline = title.toLowerCase();
    const categories = classifyHeadline(title, candidate?.snippet);
    const topicHits = topics.filter((topic) => text.includes(topic));
    if (candidate?.adapter === "anysearch" && hasCompanyContext) {
      const related = (company && headline.includes(company)) || (security && headline.includes(security));
      const industry = INDUSTRY_TERMS.some((term) => headline.includes(term.toLowerCase()));
      if (!related && !industry) continue;
    }
    const categoryScore = Math.max(0, ...categories.map((name) => CATEGORY_WEIGHT[name] ?? 0));
    const tier = Number(candidate?.sourceTier) || 3;
    const tierScore = tier === 1 ? 2 : tier === 2 ? 1 : 0;
    const scored = {
      ...candidate,
      categories,
      topics: topicHits,
      score: categoryScore + topicHits.length * 2 + tierScore,
    };

    // Same story from different aggregators: keep one row, but merge the best
    // link + source tier + snippet so the log and the LLM see one candidate.
    const key = title.toLowerCase().replace(/[\s\-—_·:：,，.。!！?？()（）\[\]【】]/g, "");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, scored);
      continue;
    }
    existing.categories = [...new Set([...existing.categories, ...scored.categories])];
    existing.topics = [...new Set([...existing.topics, ...scored.topics])];
    existing.score = Math.max(existing.score, scored.score);
    existing.sourceTier = Math.min(Number(existing.sourceTier) || 3, tier);
    if (!existing.url && scored.url) {
      existing.url = scored.url;
      existing.domain = scored.domain || existing.domain;
      existing.adapter = scored.adapter;
      existing.kind = scored.kind;
    }
    if (!existing.snippet && scored.snippet) existing.snippet = scored.snippet;
    if (!existing.publishedAt && scored.publishedAt) existing.publishedAt = scored.publishedAt;
  }

  return [...merged.values()].sort((left, right) => right.score - left.score);
}

export function isFinancialDisclosure(title, body = "") {
  return classifyHeadline(title, body).includes("财报");
}
