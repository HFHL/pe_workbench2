#!/usr/bin/env node
/**
 * DeepSeek Search / Fetch API live smoke test.
 *
 * Docs: https://api-docs.deepseek.com/zh-cn/guides/search/
 *
 *   POST https://api.deepseek.com/v1/tools/search
 *   POST https://api.deepseek.com/v1/tools/fetch
 *
 * This script hits the real API (no mocks) and answers three questions:
 *   1. can it return fresh web results (dates / after: operator)?
 *   2. can it search specific sites (site:bloomberg.com OR site:reuters.com)?
 *   3. can it read the article body (Fetch), including paywalled sites?
 *
 * Usage:
 *   node scripts/test-deepseek-search.mjs
 *   node scripts/test-deepseek-search.mjs --query "长鑫科技 CXMT" --count 8
 *   node scripts/test-deepseek-search.mjs --news "存储芯片 合约价" --json
 *   node scripts/test-deepseek-search.mjs --skip-fetch
 *
 * Key: DEEPSEEK_API_KEY from env or .env.local. Optional: DEEPSEEK_API_BASE.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadEnvFile(file, env = process.env) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, value] = match;
      if (!env[key]) env[key] = value.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* optional */
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = next;
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
loadEnvFile(path.join(ROOT, ".env.local"));

const BASE = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const COUNT = Math.max(1, Math.min(50, Number(args.count) || 5));
const SITE_QUERY = String(args.query || "CXMT").trim();
const NEWS_QUERY = String(args.news || "半导体 存储芯片 最新消息").trim();
const SKIP_FETCH = Boolean(args["skip-fetch"]);
const PRINT_JSON = Boolean(args.json);

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function info(message) {
  console.log(`  info ${message}`);
}

function isoDay(date) {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function lagDays(iso) {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isBloombergOrReuters(url) {
  const host = domainOf(url);
  return host === "bloomberg.com" || host.endsWith(".bloomberg.com")
    || host === "reuters.com" || host.endsWith(".reuters.com");
}

async function call(pathname, body, timeoutMs = 90_000) {
  const started = Date.now();
  const response = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json, text, ms: Date.now() - started };
}

function errorMessage(result) {
  return result.json?.error?.message || result.text.slice(0, 300) || `HTTP ${result.status}`;
}

async function search(query, { count = COUNT, needContent = false, oriQuestion = "" } = {}) {
  const body = { query, count, need_content: needContent };
  if (oriQuestion) body.ori_question = oriQuestion;
  const result = await call("/v1/tools/search", body);
  if (!result.ok) throw new Error(`Search HTTP ${result.status}: ${errorMessage(result)}`);
  const results = Array.isArray(result.json?.results) ? result.json.results : [];
  return { results, ms: result.ms, raw: result.json };
}

async function fetchPage(url) {
  const result = await call("/v1/tools/fetch", { url }, 120_000);
  return { ...result, title: result.json?.title || "", content: result.json?.content || "" };
}

function printResults(results, { showContent = false } = {}) {
  for (const item of results) {
    const lag = lagDays(item.date);
    const fresh = lag === null ? "?" : `${lag}d`;
    const content = String(item.content || "").length;
    console.log(
      `       ${String(item.date || "?").slice(0, 10)} (${fresh}) · A${item.authority ?? "?"}`
      + ` · R${Number(item.rerank_score || 0).toFixed(2)} · ${item.site_name || domainOf(item.url)}`
      + (showContent ? ` · content ${content}B` : "")
      + `\n       ${item.title}\n       ${item.url}`,
    );
  }
}

async function main() {
  console.log("DeepSeek Search / Fetch · live smoke test");
  console.log(`base: ${BASE} · count: ${COUNT} · site query: ${SITE_QUERY} · news query: ${NEWS_QUERY}`);

  if (!API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY（环境变量或 .env.local）。");
    process.exit(2);
  }
  console.log(`key: ****${API_KEY.slice(-4)}`);

  /* 1. 最新新闻：after: 限定 + ori_question */
  console.log("\n[1] 最新新闻（after: 最近 7 天）");
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const cutoffDay = isoDay(cutoff);
  let news = [];
  try {
    const response = await search(`${NEWS_QUERY} after:${cutoffDay}`, {
      count: COUNT,
      oriQuestion: "最近有什么重要的新闻？请按时间从新到旧整理。",
    });
    news = response.results;
    console.log(`  ${news.length} 条 · ${response.ms}ms`);
    printResults(news);
    check("新闻搜索返回结果", news.length > 0);
    const dated = news.filter((item) => item.date);
    const newest = dated
      .map((item) => Date.parse(item.date))
      .filter(Number.isFinite)
      .sort((left, right) => right - left)[0];
    const newestLag = Number.isFinite(newest) ? Math.floor((Date.now() - newest) / 86_400_000) : null;
    check("结果足够新（≤7 天）", newestLag !== null && newestLag <= 7, newestLag === null ? "无日期" : `最新 ${newestLag} 天前`);
    const tooOld = dated.filter((item) => lagDays(item.date) > 8);
    info(`after:${cutoffDay} 之后的结果 ${dated.length - tooOld.length}/${dated.length} 条`);
  } catch (error) {
    check("新闻搜索请求成功", false, error.message);
  }

  /* 2. 站内搜索：Bloomberg / Reuters */
  console.log("\n[2] 站内搜索（Bloomberg / Reuters）");
  const siteQuery = `site:bloomberg.com OR site:reuters.com ${SITE_QUERY}`;
  let siteResults = [];
  try {
    const response = await search(siteQuery, { count: COUNT });
    siteResults = response.results;
    console.log(`  ${siteResults.length} 条 · ${response.ms}ms`);
    printResults(siteResults);
    check("站内搜索返回结果", siteResults.length > 0);
    const outside = siteResults.filter((item) => !isBloombergOrReuters(item.url));
    check("site: 操作符生效（全部命中两站）", outside.length === 0,
      outside.map((item) => domainOf(item.url)).join(", "));
    const byDomain = {
      bloomberg: siteResults.filter((item) => domainOf(item.url).endsWith("bloomberg.com")).length,
      reuters: siteResults.filter((item) => domainOf(item.url).endsWith("reuters.com")).length,
    };
    info(`分布：Bloomberg ${byDomain.bloomberg} · Reuters ${byDomain.reuters}`);
  } catch (error) {
    check("站内搜索请求成功", false, error.message);
  }

  /* 3. 正文：need_content */
  console.log("\n[3] 搜索正文（need_content=true）");
  try {
    const response = await search(`${NEWS_QUERY} after:${cutoffDay}`, { count: Math.min(3, COUNT), needContent: true });
    const withContent = response.results.filter((item) => String(item.content || "").length >= 200);
    const longest = response.results.reduce((max, item) => Math.max(max, String(item.content || "").length), 0);
    check("至少一条结果带正文", withContent.length > 0, `${withContent.length}/${response.results.length} 条，最长 ${longest}B`);
    if (withContent[0]) {
      info(`示例：${withContent[0].title}`);
      info(`正文开头：${String(withContent[0].content).replace(/\s+/g, " ").slice(0, 120)}…`);
    }
  } catch (error) {
    check("正文搜索请求成功", false, error.message);
  }

  /* 4. Fetch：优先 Bloomberg 文章，再看 Reuters 是否可读 */
  if (!SKIP_FETCH) {
    console.log("\n[4] Fetch 正文");
    const bloombergUrl = siteResults
      .map((item) => item.url)
      .find((url) => domainOf(url).endsWith("bloomberg.com") && /\/news\/articles\//.test(url))
      || siteResults.map((item) => item.url).find((url) => domainOf(url).endsWith("bloomberg.com"));
    if (bloombergUrl) {
      try {
        const page = await fetchPage(bloombergUrl);
        const length = page.content.length;
        check("Bloomberg 正文可抓取", page.ok && length >= 300, `HTTP ${page.status} · ${length}B · ${page.title.slice(0, 60)}`);
        if (length) info(`开头：${page.content.replace(/\s+/g, " ").slice(0, 140)}…`);
        if (length < 1500) info("正文偏短：多半是付费墙只放出导语（Bloomberg 常见），不能当全文用");
      } catch (error) {
        check("Bloomberg 正文可抓取", false, error.message);
      }
    } else {
      info("本轮站内搜索没有 Bloomberg 文章链接，跳过 Bloomberg Fetch");
    }

    const reutersUrl = siteResults.map((item) => item.url).find((url) => domainOf(url).endsWith("reuters.com"));
    if (reutersUrl) {
      try {
        const page = await fetchPage(reutersUrl);
        if (page.ok && page.content.length >= 300) {
          check("Reuters 正文可抓取", true, `HTTP ${page.status} · ${page.content.length}B`);
        } else {
          info(`Reuters 被目标站拦截（HTTP ${page.status}）：搜索可用，正文不可读`);
        }
      } catch (error) {
        info(`Reuters 被目标站拦截：${error.message}`);
      }
    }

    const asia = await fetchPage("https://www.bloomberg.com/asia");
    info(`Bloomberg /asia：HTTP ${asia.status} · ${asia.content.length}B · 标题「${asia.title}」`
      + (asia.content.length < 300 ? "（栏目页只返回导航壳，不是文章列表）" : ""));
  }

  console.log("\n[5] 结论");
  for (const item of checks) console.log(`  ${item.ok ? "✓" : "✗"} ${item.name}`);
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${failed.length ? "✗" : "✓"} ${checks.length - failed.length} passed, ${failed.length} failed`);

  if (PRINT_JSON) {
    console.log("\n--- raw ---");
    console.log(JSON.stringify({ siteQuery, siteResults }, null, 2));
  }

  if (failed.length) process.exit(1);
}

await main();
