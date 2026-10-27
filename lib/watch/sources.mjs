/**
 * Watch source adapters: turn westock / AnySearch output into candidate events.
 *
 * Rule scan is deliberately dumb and cheap: fetch, parse, dedupe, rank. It does
 * not decide materiality — that is the LLM gate's job. Anything that cannot be
 * parsed into a title is dropped rather than guessed.
 */

import crypto from "node:crypto";

import { classifyHeadline, companyAliases } from "./brief.mjs";

/**
 * Bloomberg and Reuters are the primary web sources for a watch: site-scoped
 * searches are run against them first, results are filtered to these domains,
 * and survivors get a ranking boost (S2 instead of S3).
 */
export const PRIMARY_WEB_DOMAINS = Object.freeze(["bloomberg.com", "reuters.com"]);
const PRIMARY_DOMAIN_BOOST = 5;

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

function normalizePublishedAt(chunk) {
  const matches = [...String(chunk).matchAll(/\bdate:\s*([^\n]{2,40})/gi)];
  const raw = matches.length ? matches[matches.length - 1][1].trim() : "";
  if (!raw) return "";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw;
  const date = new Date(parsed);
  // Keep the day the source printed; do not shift it through UTC.
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseAnySearchResults(text) {
  const raw = String(text || "");
  const chunks = raw.split(/\n(?=##\s+\d+\.\s)/).filter((chunk) => /^##\s+\d+\.\s/.test(chunk.trim()));
  const merged = new Map();
  for (const chunk of chunks) {
    const title = chunk.match(/^##\s+\d+\.\s*(.+)$/m)?.[1]?.trim() || "";
    // The tool prints each hit twice: a summary block (来源：) and a body block
    // (**URL**:). Merge them so the URL and the published date end up together.
    const url = chunk.match(/^来源：\s*(\S+)/m)?.[1]?.trim()
      || chunk.match(/^\*\*URL\*\*:\s*(\S+)/m)?.[1]?.trim()
      || "";
    const snippet = chunk.match(/^摘要：\s*(.+)$/m)?.[1]?.trim() || "";
    const content = chunk.replace(/^##\s+\d+\.\s*.+$/m, "").trim();
    const publishedAt = normalizePublishedAt(chunk);
    const key = title.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { title, url, snippet, publishedAt, content });
      continue;
    }
    if (!existing.url && url) existing.url = url;
    if (!existing.snippet && snippet) existing.snippet = snippet;
    if (!existing.publishedAt && publishedAt) existing.publishedAt = publishedAt;
    if (content.length > existing.content.length) existing.content = content;
  }
  return [...merged.values()].filter((item) => item.title || item.url);
}

export function domainOf(url) {
  try {
    return new URL(String(url || "")).hostname;
  } catch {
    return "";
  }
}

export function candidateHash({ adapter = "", kind = "", title = "", url = "" } = {}) {
  // The same article can surface from DeepSeek (primary), its AnySearch
  // fallback, or the generic search; normalize all web-search adapters so it
  // dedupes to one watch_event. Non-search adapters keep their own namespace.
  const hashAdapter = ["anysearch", "anysearch-primary", "deepseek-search"].includes(adapter)
    ? "anysearch"
    : adapter;
  return crypto
    .createHash("sha256")
    .update([hashAdapter, kind, clean(title), clean(url)].join("\u0001"))
    .digest("hex");
}

export function isPrimaryWebDomain(domain) {
  const host = String(domain || "").toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  return PRIMARY_WEB_DOMAINS.some((domainName) => host === domainName || host.endsWith(`.${domainName}`));
}

/** "site:bloomberg.com OR site:reuters.com CXMT" — English aliases first. */
const PRIMARY_QUERY_PREFIX = "site:bloomberg.com OR site:reuters.com ";

export function buildPrimaryWebQuery(brief) {
  const target = brief?.target || {};
  const aliases = asArray(target.aliases).length ? asArray(target.aliases) : companyAliases(target.company);
  const company = clean(target.company).split(/[（(]/)[0].trim();
  const latin = aliases
    .map((alias) => clean(alias))
    .filter((alias) => /[a-z]/i.test(alias) && !/^\d{6}(\.\w+)?$/i.test(alias));
  const terms = (latin.length ? latin : [company]).filter(Boolean).slice(0, 3);
  if (!terms.length) return "";
  return `${PRIMARY_QUERY_PREFIX}${terms.join(" ")}`;
}

/**
 * Source plan for one watch. The rule scanner runs these in order; each task
 * maps to exactly one tool call.
 *
 * DeepSeek Search is the primary web source. Its site: operator is strict and
 * results carry structured dates; when it returns nothing (or is disabled),
 * the AnySearch task marked `fallback` is used instead. The generic AnySearch
 * query keeps domestic recall.
 */
export function buildSourceTasks(brief, { after = "", deepseek = true } = {}) {
  const symbol = clean(brief?.queries?.westockSymbol);
  const queries = asArray(brief?.queries?.anysearch);
  const primaryQuery = buildPrimaryWebQuery(brief);
  const cutoff = clean(after || brief?.target?.dataCutoff).slice(0, 10);
  const tasks = [];
  if (symbol) {
    tasks.push({ adapter: "westock", kind: "notice", args: ["notice", "list", symbol], sourceTier: 1 });
    tasks.push({ adapter: "westock", kind: "news", args: ["news", symbol], sourceTier: 3 });
  }
  if (primaryQuery && deepseek) {
    // DeepSeek rejects queries over 128 characters; keep the site prefix and
    // the after: window intact, trim the term list instead.
    const terms = primaryQuery.startsWith(PRIMARY_QUERY_PREFIX)
      ? primaryQuery.slice(PRIMARY_QUERY_PREFIX.length)
      : primaryQuery;
    const suffix = cutoff ? ` after:${cutoff}` : "";
    const room = Math.max(16, 128 - PRIMARY_QUERY_PREFIX.length - suffix.length);
    const fitted = terms.length > room ? terms.slice(0, room).replace(/\s+\S*$/, "").trim() : terms;
    tasks.push({
      adapter: "deepseek-search",
      kind: "search",
      query: fitted ? `${PRIMARY_QUERY_PREFIX}${fitted}${suffix}` : primaryQuery,
      sourceTier: 2,
      maxResults: 8,
      domains: PRIMARY_WEB_DOMAINS,
    });
    // Only runs when the DeepSeek task is unavailable or returns no in-domain hit.
    tasks.push({
      adapter: "anysearch-primary",
      kind: "search",
      query: primaryQuery,
      sourceTier: 2,
      maxResults: 8,
      domains: PRIMARY_WEB_DOMAINS,
      fallback: true,
    });
  } else if (primaryQuery) {
    tasks.push({
      adapter: "anysearch-primary",
      kind: "search",
      query: primaryQuery,
      sourceTier: 2,
      maxResults: 8,
      domains: PRIMARY_WEB_DOMAINS,
    });
  }
  // Generic search keeps domestic recall. One query per scan keeps the API
  // quota predictable; the brief's second query is left for deep checks, where
  // the agent can decide to run it.
  if (queries[0]) {
    tasks.push({ adapter: "anysearch", kind: "search", query: queries[0], sourceTier: 3, maxResults: 6 });
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

export function candidatesFromAnySearch(results, {
  query = "",
  sourceTier = 3,
  adapter = "anysearch",
  domains = null,
} = {}) {
  const allow = asArray(domains).map((domain) => String(domain).toLowerCase());
  return asArray(results).map((row) => {
    const title = clean(row?.title);
    if (!title) return null;
    const url = clean(row?.url);
    const domain = domainOf(url);
    if (allow.length && !allow.some((name) => domain === name || domain.endsWith(`.${name}`))) {
      return null;
    }
    return {
      adapter,
      kind: "search",
      title,
      url,
      snippet: clean(row?.snippet) || clean(row?.content).slice(0, 600),
      publishedAt: clean(row?.publishedAt),
      sourceTier,
      domain,
      raw: { query, primary: Boolean(allow.length) },
    };
  }).filter(Boolean);
}

function localDateOf(value) {
  const raw = clean(value);
  if (!raw) return "";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw.slice(0, 10);
  const date = new Date(parsed);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function candidatesFromDeepSeek(results, {
  query = "",
  sourceTier = 2,
  adapter = "deepseek-search",
  domains = null,
} = {}) {
  const allow = asArray(domains).map((domain) => String(domain).toLowerCase());
  return asArray(results).map((row) => {
    const title = clean(row?.title);
    if (!title) return null;
    const url = clean(row?.url);
    const domain = domainOf(url);
    if (allow.length && !allow.some((name) => domain === name || domain.endsWith(`.${name}`))) {
      return null;
    }
    const rerankScore = Number(row?.rerankScore);
    const authority = Number(row?.authority);
    return {
      adapter,
      kind: "search",
      title,
      url,
      snippet: clean(row?.summary) || clean(row?.snippet) || clean(row?.content).slice(0, 600),
      publishedAt: localDateOf(row?.date),
      sourceTier,
      domain,
      rerankScore: Number.isFinite(rerankScore) ? rerankScore : 0,
      authority: Number.isFinite(authority) ? authority : 0,
      raw: { query, primary: Boolean(allow.length), siteName: clean(row?.siteName) },
    };
  }).filter(Boolean);
}

const NOISE_TITLE = /股票股价|实时行情|历史行情|走势图|行情中心|股吧|百科|资金流向|主力资金|龙虎榜|bookbuilding|profile and biography|stock price quote|stock quote|company profile|trending news, latest updates|^invest in /i;
const INDUSTRY_TERMS = [
  "DRAM", "NAND", "HBM", "存储", "内存", "合约价", "ASP", "晶圆", "产能", "出口管制", "半导体",
  // English coverage (Bloomberg / Reuters) uses these instead of Chinese terms.
  "memory", "chip", "semiconductor", "wafer", "foundry",
];
const ROUTINE_NOTICE = /公司章程|议事规则|管理制度|法律意见书|会议资料|核查意见|薪酬管理制度|对外担保管理制度|募集资金管理制度|董事和高级管理人员/i;

export function isRoutineOrNoise(title) {
  const text = String(title || "");
  return NOISE_TITLE.test(text) || ROUTINE_NOTICE.test(text);
}

export function rankCandidates(candidates, brief) {
  const topics = asArray(brief?.queries?.topics).map((item) => clean(item)).filter(Boolean);
  const company = clean(brief?.target?.company).split(/[（(]/)[0].trim().toLowerCase();
  const security = clean(brief?.target?.security).split(".")[0].trim().toLowerCase();
  const aliases = asArray(brief?.target?.aliases)
    .map((alias) => clean(alias).toLowerCase())
    .filter(Boolean);
  const hasCompanyContext = Boolean(company || security || aliases.length);
  const merged = new Map();

  for (const candidate of asArray(candidates)) {
    const title = clean(candidate?.title);
    if (!title || isRoutineOrNoise(title)) continue;
    const text = `${title} ${candidate?.snippet || ""}`.toLowerCase();
    const headline = title.toLowerCase();
    const categories = classifyHeadline(title, candidate?.snippet);
    const topicHits = topics.filter((topic) => text.includes(topic));
    const primary = isPrimaryWebDomain(candidate?.domain || domainOf(candidate?.url));
    if (String(candidate?.adapter || "").startsWith("anysearch") && hasCompanyContext) {
      const related = (company && headline.includes(company))
        || (security && headline.includes(security))
        || aliases.some((alias) => headline.includes(alias));
      const industry = INDUSTRY_TERMS.some((term) => headline.includes(term.toLowerCase()));
      if (!related && !industry) continue;
    }
    const categoryScore = Math.max(0, ...categories.map((name) => CATEGORY_WEIGHT[name] ?? 0));
    const tier = primary ? 2 : Number(candidate?.sourceTier) || 3;
    const tierScore = tier === 1 ? 2 : tier === 2 ? 1 : 0;
    // DeepSeek returns a 0–3 relevance score; let quality break ties inside the
    // primary bucket without overpowering category weight.
    const rerank = Math.min(3, Math.max(0, Number(candidate?.rerankScore) || 0));
    const scored = {
      ...candidate,
      sourceTier: tier,
      primary,
      categories,
      topics: topicHits,
      score: categoryScore + topicHits.length * 2 + tierScore + (primary ? PRIMARY_DOMAIN_BOOST : 0) + Math.round(rerank * 2),
    };

    // Same story from different aggregators: keep one row, but merge the best
    // link + source tier + snippet so the log and the LLM see one candidate.
    const key = title.toLowerCase().replace(/[\s\-—_·:：,，.。!！?？()（）\[\]【】]/g, "");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, scored);
      continue;
    }
    const wasPrimary = Boolean(existing.primary);
    existing.categories = [...new Set([...existing.categories, ...scored.categories])];
    existing.topics = [...new Set([...existing.topics, ...scored.topics])];
    existing.score = Math.max(existing.score, scored.score);
    existing.sourceTier = Math.min(Number(existing.sourceTier) || 3, tier);
    existing.primary = Boolean(wasPrimary || scored.primary);
    // Prefer the primary-source URL when the same story also came from a repost.
    if ((!existing.url || (scored.primary && !wasPrimary)) && scored.url) {
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
