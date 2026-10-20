#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import { createAnySearchTool } from "../lib/anysearch-tool.mjs";

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

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
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
    requests.push({ headers: req.headers, body });

    if (body.query === "quota") {
      return json(res, 402, {
        code: -1,
        message: "username=generated-user\npassword=generated-password\napi_key=generated-secret",
        request_id: "req-quota",
      });
    }
    if (body.query === "rate") {
      return json(res, 429, { code: -1, message: "slow down", request_id: "req-rate" }, {
        "Retry-After": "7",
      });
    }
    if (body.query === "bad-json") {
      res.writeHead(502, { "Content-Type": "text/plain" });
      return res.end("upstream exploded");
    }

    return json(res, 200, {
      code: 0,
      message: "success",
      request_id: "req-ok",
      data: {
        results: [
          {
            title: "AnySearch 文档",
            url: "https://www.anysearch.com/docs",
            snippet: "官方文档",
            content: "搜索正文",
          },
        ],
        metadata: { total_results: 1, search_time_ms: 123 },
      },
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests }));
  });
}

async function main() {
  const { server, requests } = await startMock();
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log("AnySearch custom tool");

    await test("authenticated search sends normalized request and formats sources", async () => {
      const tool = createAnySearchTool({ apiBase, apiKey: "test-key" });
      const result = await tool.execute("call-1", {
        query: "Go release notes",
        maxResults: 4,
        tag: "code.doc",
        zone: "intl",
        language: "en",
        params: { library: "golang" },
      });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /AnySearch 文档/);
      assert.match(result.content[0].text, /https:\/\/www\.anysearch\.com\/docs/);
      assert.equal(result.details.requestId, "req-ok");
      assert.equal(result.details.resultCount, 1);

      const request = requests.at(-1);
      assert.equal(request.headers.authorization, "Bearer test-key");
      assert.deepEqual(request.body, {
        query: "Go release notes",
        max_results: 4,
        format: "markdown",
        tag: "code.doc",
        zone: "intl",
        language: "en",
        params: { library: "golang" },
      });
    });

    await test("anonymous search omits the Authorization header", async () => {
      const tool = createAnySearchTool({ apiBase });
      const result = await tool.execute("call-2", { query: "anonymous" });
      assert.equal(result.isError, undefined);
      assert.equal(requests.at(-1).headers.authorization, undefined);
      assert.equal(requests.at(-1).body.max_results, 6);
      assert.equal(result.details.authenticated, false);
    });

    await test("402 response never exposes generated credentials", async () => {
      const tool = createAnySearchTool({ apiBase });
      const result = await tool.execute("call-3", { query: "quota" });
      const serialized = JSON.stringify(result);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /配额已耗尽/);
      assert.doesNotMatch(serialized, /generated-user|generated-password|generated-secret/);
      assert.equal(result.details.requestId, "req-quota");
    });

    await test("429 preserves only safe retry metadata", async () => {
      const tool = createAnySearchTool({ apiBase, apiKey: "test-key" });
      const result = await tool.execute("call-4", { query: "rate" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Retry-After: 7/);
      assert.equal(result.details.retryAfter, "7");
    });

    await test("non-JSON upstream failure is reported without response-body leakage", async () => {
      const tool = createAnySearchTool({ apiBase });
      const result = await tool.execute("call-5", { query: "bad-json" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /HTTP 502/);
      assert.doesNotMatch(JSON.stringify(result), /upstream exploded/);
    });

    await test("blank query is rejected before network access", async () => {
      const before = requests.length;
      const tool = createAnySearchTool({ apiBase });
      const result = await tool.execute("call-6", { query: "   " });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /query 不能为空/);
      assert.equal(requests.length, before);
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  console.log(`\n${failures.length === 0 ? "✓" : "✗"} ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

await main();
