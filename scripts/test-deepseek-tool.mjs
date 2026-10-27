#!/usr/bin/env node
/**
 * Mock tests for deepseek_search / deepseek_fetch (no network, no key).
 *
 *   node scripts/test-deepseek-tool.mjs
 */

import assert from "node:assert/strict";
import http from "node:http";
import { createDeepSeekFetchTool, createDeepSeekSearchTool } from "../lib/deepseek-search-tool.mjs";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message.split("\n")[0]}`);
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function startMock() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.url === "/v1/tools/search") {
      if (body.query === "unauthorized") return json(res, 401, { error: { message: "invalid api key", code: "invalid_request_error" } });
      if (body.query === "broke") return json(res, 402, { error: { message: "insufficient balance", code: "insufficient_balance" } });
      if (body.query === "empty") return json(res, 200, { results: [] });
      return json(res, 200, {
        results: [
          {
            rerank_score: 2.4,
            title: "CXMT swings to profit",
            url: "https://www.bloomberg.com/news/articles/x",
            snippet: "short",
            summary: "long summary",
            content: "full body",
            site_name: "Bloomberg.com",
            date: "2026-10-15T16:00:00+00:00",
            authority: 4,
          },
          {
            title: "Second result",
            url: "https://www.reuters.com/world/y",
            summary: "another summary",
          },
        ],
      });
    }
    if (req.url === "/v1/tools/fetch") {
      if (body.url.includes("blocked")) return json(res, 404, { error: { message: "failed to fetch URL", code: "invalid_request_error" } });
      if (body.url.includes("blank")) return json(res, 200, { title: "", content: "" });
      return json(res, 200, { title: "Article title", content: "A".repeat(5000) });
    }
    return json(res, 404, { error: { message: "not found" } });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests })));
}

async function main() {
  const { server, requests } = await startMock();
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log("DeepSeek search / fetch tool");

    await test("search sends auth + normalized body and returns structured details", async () => {
      const tool = createDeepSeekSearchTool({ apiBase, apiKey: "test-key" });
      const result = await tool.execute("call-1", {
        query: "site:bloomberg.com CXMT",
        count: 2,
        needContent: true,
        oriQuestion: "CXMT 最近怎么样？",
      });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /CXMT swings to profit/);
      assert.match(result.content[0].text, /来源：https:\/\/www\.bloomberg\.com/);
      assert.match(result.content[0].text, /相关度 2\.40/);
      assert.equal(result.details.resultCount, 2);
      assert.equal(result.details.results[0].rerankScore, 2.4);
      assert.equal(result.details.results[0].authority, 4);
      assert.equal(result.details.results[0].siteName, "Bloomberg.com");
      assert.equal(result.details.results[0].date, "2026-10-15T16:00:00+00:00");
      assert.equal(result.details.results[1].rerankScore, null);

      const request = requests.at(-1);
      assert.equal(request.headers.authorization, "Bearer test-key");
      assert.deepEqual(request.body, {
        query: "site:bloomberg.com CXMT",
        count: 2,
        need_content: true,
        ori_question: "CXMT 最近怎么样？",
      });
    });

    await test("count is clamped to the API range", async () => {
      const tool = createDeepSeekSearchTool({ apiBase, apiKey: "test-key" });
      await tool.execute("call-2", { query: "clamp", count: 999 });
      assert.equal(requests.at(-1).body.count, 50);
      await tool.execute("call-3", { query: "clamp", count: 0 });
      assert.equal(requests.at(-1).body.count, 10);
    });

    await test("empty result set is a normal response", async () => {
      const tool = createDeepSeekSearchTool({ apiBase, apiKey: "test-key" });
      const result = await tool.execute("call-4", { query: "empty" });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /没有返回匹配结果/);
      assert.equal(result.details.resultCount, 0);
    });

    await test("401 and 402 surface friendly errors", async () => {
      const tool = createDeepSeekSearchTool({ apiBase, apiKey: "test-key" });
      const unauthorized = await tool.execute("call-5", { query: "unauthorized" });
      assert.equal(unauthorized.isError, true);
      assert.match(unauthorized.content[0].text, /API Key 缺失或无效/);
      const broke = await tool.execute("call-6", { query: "broke" });
      assert.equal(broke.isError, true);
      assert.match(broke.content[0].text, /余额不足/);
      assert.doesNotMatch(JSON.stringify(broke), /test-key/);
    });

    await test("missing key and oversized query are rejected before network", async () => {
      const before = requests.length;
      const noKey = createDeepSeekSearchTool({ apiBase });
      const keyResult = await noKey.execute("call-7", { query: "x" });
      assert.equal(keyResult.isError, true);
      assert.match(keyResult.content[0].text, /DEEPSEEK_API_KEY/);
      const tool = createDeepSeekSearchTool({ apiBase, apiKey: "test-key" });
      const longResult = await tool.execute("call-8", { query: "x".repeat(129) });
      assert.equal(longResult.isError, true);
      assert.equal(requests.length, before);
    });

    await test("fetch returns markdown body and truncates safely", async () => {
      const tool = createDeepSeekFetchTool({ apiBase, apiKey: "test-key" });
      const result = await tool.execute("call-9", { url: "https://www.example.com/a", maxChars: 2000 });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /^# Article title/);
      assert.equal(result.details.chars, 5000);
      assert.equal(result.details.truncated, true);
      assert.match(result.content[0].text, /输出已截断/);
    });

    await test("fetch rejects non-http and credential URLs", async () => {
      const before = requests.length;
      const tool = createDeepSeekFetchTool({ apiBase, apiKey: "test-key" });
      for (const url of ["file:///etc/passwd", "https://user:pass@example.com/a", "not a url"]) {
        const result = await tool.execute("call-10", { url });
        assert.equal(result.isError, true, url);
      }
      assert.equal(requests.length, before);
    });

    await test("fetch 404 explains blocking without leaking internals", async () => {
      const tool = createDeepSeekFetchTool({ apiBase, apiKey: "test-key" });
      const result = await tool.execute("call-11", { url: "https://www.reuters.com/blocked" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /反爬\/付费墙/);
    });

    await test("fetch empty content is an error", async () => {
      const tool = createDeepSeekFetchTool({ apiBase, apiKey: "test-key" });
      const result = await tool.execute("call-12", { url: "https://www.example.com/blank" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /没有可提取的正文/);
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  console.log(`\n${failures.length === 0 ? "✓" : "✗"} ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

await main();
