#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import { createWebFetchTool } from "../lib/web-fetch-tool.mjs";

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

// GBK fixture: <meta charset="gbk"> + article about 格力电器. Node cannot
// encode GBK, so the bytes were generated with `iconv -f UTF-8 -t GBK`.
const GBK_PAGE = Buffer.from(
  "PCFkb2N0eXBlIGh0bWw+PGh0bWw+PGhlYWQ+PG1ldGEgY2hhcnNldD0iZ2JrIj48dGl0bGU+uPHBprXnxve5q7jmPC90aXRsZT48L2hlYWQ+PGJvZHk+PG5hdj7K19KzILL6xrcgwarPtTwvbmF2PjxhcnRpY2xlPjxoMT7Dq8D7wsrM4cn9PC9oMT48cD65q8u+w6vA+8LKzOHJ/dbBIDMwJSWjrNb30qrAtNfUsvrGt73hubm4xMnG0+vUrbLEwc+827jxu9jC5KGjPC9wPjxwPrfnz9XM4cq+o7rQ6Mfzsru8sNSkxtqhozwvcD48L2FydGljbGU+PGZvb3Rlcj6w5sioy/nT0DwvZm9vdGVyPjwvYm9keT48L2h0bWw+",
  "base64",
);

const ARTICLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>测试文章 · 示例站点</title>
  <meta name="description" content="这是一篇用于测试的示例文章摘要。">
  <meta property="article:published_time" content="2026-10-18T09:30:00+08:00">
  <script>window.tracker = "should-not-appear";</script>
  <style>.nav { display: none; }</style>
</head>
<body>
  <nav><a href="/">首页</a><a href="/about">关于我们</a>导航菜单不应出现</nav>
  <header><h1 class="site">示例站点</h1></header>
  <main>
    <article>
      <h1>长鑫存储的毛利率变化</h1>
      <p>这是正文第一段，包含 <strong>关键结论</strong>：毛利率提升来自产品结构改善。</p>
      <p>这是正文第二段，包含 <a href="/source">引用来源</a> 与价格数据。</p>
      <ul><li>要点一：DRAM 价格回升</li><li>要点二：HBM 占比提升</li></ul>
    </article>
  </main>
  <aside>侧边栏推荐不应出现</aside>
  <footer>版权所有不应出现</footer>
</body>
</html>`;

const LONG_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>长页面</title></head><body><main>
<h1>长页面</h1>
<p>第一段：${"公司概况与主营业务介绍。".repeat(60)}</p>
<p>第二段：${"行业需求与竞争格局分析。".repeat(60)}</p>
<p>第三段：风险提示：需求不及预期、原材料价格波动、汇率变化均可能影响毛利率。${"需要持续跟踪。".repeat(30)}</p>
</main></body></html>`;

function startMock() {
  const routes = new Map();
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    const route = routes.get(pathname);
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    route(req, res);
  });

  routes.set("/article", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ARTICLE_HTML);
  });

  routes.set("/gbk", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(GBK_PAGE);
  });

  routes.set("/long", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LONG_HTML);
  });

  routes.set("/json", (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
  });

  routes.set("/pdf", (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/pdf" });
    res.end("%PDF-1.4 fake");
  });

  routes.set("/empty", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body><script>only()</script></body></html>");
  });

  routes.set("/redirect", (_req, res) => {
    res.writeHead(302, { Location: "/article" });
    res.end();
  });

  routes.set("/redirect-ftp", (_req, res) => {
    res.writeHead(302, { Location: "ftp://example.com/file" });
    res.end();
  });

  routes.set("/slow", (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><p>late</p></body></html>");
    }, 2500);
  });

  routes.set("/huge", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": "5000000",
    });
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, routes }));
  });
}

async function main() {
  const { server, routes } = await startMock();
  const base = `http://127.0.0.1:${server.address().port}`;
  const tool = createWebFetchTool({ allowPrivate: true });
  const strict = createWebFetchTool();

  try {
    console.log("web_fetch custom tool");

    await test("extracts article text and strips navigation, scripts and footer", async () => {
      const result = await tool.execute("call-1", { url: `${base}/article` });
      assert.equal(result.isError, undefined);
      const text = result.content[0].text;
      assert.match(text, /^# 长鑫存储的毛利率变化/m);
      assert.match(text, /这是正文第一段/);
      assert.match(text, /关键结论/);
      assert.match(text, /- 要点一：DRAM 价格回升/);
      assert.match(text, /来源：http:\/\/127\.0\.0\.1:\d+\/article/);
      assert.match(text, /HTTP 200/);
      assert.match(text, /发布时间：2026-10-18T09:30:00\+08:00/);
      assert.match(text, /页面摘要：这是一篇用于测试的示例文章摘要。/);
      assert.doesNotMatch(text, /导航菜单不应出现/);
      assert.doesNotMatch(text, /should-not-appear/);
      assert.doesNotMatch(text, /侧边栏推荐不应出现/);
      assert.doesNotMatch(text, /版权所有不应出现/);
      assert.equal(result.details.status, 200);
      assert.equal(result.details.charset, "utf-8");
    });

    await test("follows relative redirects and reports the final URL", async () => {
      const result = await tool.execute("call-2", { url: `${base}/redirect` });
      assert.equal(result.isError, undefined);
      const text = result.content[0].text;
      assert.match(text, /来源：http:\/\/127\.0\.0\.1:\d+\/article/);
      assert.match(text, /原始链接：http:\/\/127\.0\.0\.1:\d+\/redirect/);
      assert.equal(result.details.finalUrl, `${base}/article`);
    });

    await test("blocks loopback targets by default (SSRF guard)", async () => {
      const result = await strict.execute("call-3", { url: `${base}/article` });
      assert.equal(result.isError, true);
      assert.equal(result.details.error, "private_address");
      assert.match(result.content[0].text, /拒绝访问内网或回环地址/);
    });

    await test("blocks IPv4-mapped IPv6 and packed IPv4 loopback forms", async () => {
      for (const url of ["http://[::1]/", "http://[::ffff:7f00:1]/", "http://2130706433/"]) {
        const result = await strict.execute("call-3b", { url });
        assert.equal(result.isError, true, url);
        assert.equal(result.details.error, "private_address", url);
      }
    });

    await test("decodes GBK pages using the meta charset", async () => {
      const result = await tool.execute("call-4", { url: `${base}/gbk` });
      assert.equal(result.isError, undefined);
      const text = result.content[0].text;
      assert.match(text, /^# 格力电器公告/m);
      assert.match(text, /毛利率提升/);
      assert.match(text, /30%/);
      assert.equal(result.details.charset, "gbk");
    });

    await test("query returns only related paragraphs", async () => {
      const result = await tool.execute("call-5", { url: `${base}/long`, query: "风险提示" });
      assert.equal(result.isError, undefined);
      const text = result.content[0].text;
      assert.match(text, /最相关的段落/);
      assert.match(text, /风险提示：需求不及预期/);
      assert.doesNotMatch(text, /第一段/);
      assert.doesNotMatch(text, /第二段/);
      assert.equal(result.details.focused, true);
    });

    await test("truncates long output and marks it", async () => {
      const result = await tool.execute("call-6", { url: `${base}/long`, maxChars: 1000 });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.truncated, true);
      assert.match(result.content[0].text, /内容已截断/);
    });

    await test("pretty-prints JSON bodies", async () => {
      const result = await tool.execute("call-7", { url: `${base}/json` });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /"ok": true/);
      assert.match(result.content[0].text, /"items": \[/);
    });

    await test("rejects PDF links with a clear next step", async () => {
      const result = await tool.execute("call-8", { url: `${base}/pdf` });
      assert.equal(result.isError, true);
      assert.equal(result.details.error, "pdf_not_supported");
      assert.match(result.content[0].text, /pdf_read/);
    });

    await test("reports empty JS-rendered pages instead of inventing text", async () => {
      const result = await tool.execute("call-9", { url: `${base}/empty` });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /没有可提取的正文/);
    });

    await test("rejects non-http schemes and embedded credentials", async () => {
      const ftp = await tool.execute("call-10", { url: "ftp://example.com/file" });
      assert.equal(ftp.details.error, "unsupported_protocol");
      const credentials = await tool.execute("call-11", { url: "http://user:pass@example.com/" });
      assert.equal(credentials.details.error, "credentials_not_allowed");
    });

    await test("re-checks redirect targets and rejects non-http hops", async () => {
      const result = await tool.execute("call-12", { url: `${base}/redirect-ftp` });
      assert.equal(result.isError, true);
      assert.equal(result.details.error, "unsupported_protocol");
    });

    await test("maps 404 to not_found", async () => {
      const result = await tool.execute("call-13", { url: `${base}/missing` });
      assert.equal(result.isError, true);
      assert.equal(result.details.error, "not_found");
      assert.equal(result.details.status, 404);
    });

    await test("rejects responses above the size cap", async () => {
      const result = await tool.execute("call-14", { url: `${base}/huge` });
      assert.equal(result.isError, true);
      assert.equal(result.details.error, "too_large");
    });

    await test("times out slow pages", async () => {
      const result = await tool.execute("call-15", { url: `${base}/slow`, timeoutMs: 1000 });
      assert.equal(result.isError, true);
      assert.equal(result.details.error, "timeout");
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
