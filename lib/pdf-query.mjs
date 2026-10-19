/**
 * PDF text retrieval over the document produced by services/pdf/parse_pdf.py.
 *
 * Shape:
 *   doc.pages = [{ page, chars, images, scanned, paragraphs: [string], ... }]
 *   doc.headings = [{ page, text, level }]
 *   doc.outline = [{ title, page, level }]   (PDF bookmarks, often empty)
 *
 * Retrieval is lexical and explainable, mirroring workbook_query: CJK bigrams +
 * latin words, a required text hit, bounded snippets with page citations. No
 * embeddings, no cross-document state.
 */

const MAX_CHUNK = 700;
const CJK_RE = /[\u3400-\u9fff]/;
const STOP = new Set([
  "the", "and", "for", "with", "what", "which", "how", "this", "that", "from",
  "的", "是", "了", "吗", "呢", "在", "和", "与", "及", "对", "我", "你", "他",
]);

function str(value) {
  return typeof value === "string" ? value : "";
}

function pageCount(doc) {
  return Array.isArray(doc?.pages) ? doc.pages.length : 0;
}

/* ---------- page ranges ---------- */

/**
 * Parse "3" / "2-4" / "1,5-6" into a sorted unique list of page numbers.
 * Throws a 400-shaped error on malformed input so the tool can report it.
 */
export function parsePageSpec(value, total, { max = 40 } = {}) {
  const raw = str(value).trim();
  if (!raw) return [];
  const pages = new Set();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)\s*[-–—~]\s*(\d+)$/);
    if (range) {
      let start = Number(range[1]);
      let end = Number(range[2]);
      if (start > end) [start, end] = [end, start];
      if (start < 1) start = 1;
      if (end > total) end = total;
      for (let page = start; page <= end; page += 1) pages.add(page);
    } else if (/^\d+$/.test(token)) {
      const page = Number(token);
      if (page >= 1 && page <= total) pages.add(page);
    } else {
      throw Object.assign(new Error(`无法识别的页码：${token}（示例：3、2-4、1,5-6）`), {
        status: 400,
        code: "bad_page",
      });
    }
  }
  const sorted = [...pages].sort((a, b) => a - b);
  if (sorted.length > max) {
    throw Object.assign(new Error(`一次最多读取 ${max} 页，请拆成多次请求。`), {
      status: 400,
      code: "page_limit",
    });
  }
  return sorted;
}

/* ---------- tokenizing and chunking ---------- */

export function tokenize(query) {
  const text = str(query).toLowerCase().trim();
  const terms = new Map();
  const add = (term, weight) => {
    if (!term || STOP.has(term)) return;
    terms.set(term, Math.max(terms.get(term) || 0, weight));
  };

  for (const word of text.match(/[a-z0-9][a-z0-9+#./&_-]*/gi) || []) {
    if (word.length >= 2) add(word, word.length >= 4 ? 3 : 2);
  }
  for (const run of text.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length === 1) {
      add(run, 1);
      continue;
    }
    add(run, 4);
    for (let i = 0; i < run.length - 1; i += 1) add(run.slice(i, i + 2), 1.6);
  }
  return [...terms.entries()].map(([term, weight]) => ({ term, weight }));
}

function splitLong(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const out = [];
  let buf = "";
  for (const sentence of text.split(/(?<=[。！？!?；;\n])/)) {
    if (!sentence) continue;
    if (buf.length + sentence.length > MAX_CHUNK && buf) {
      out.push(buf);
      buf = sentence;
    } else {
      buf += sentence;
    }
  }
  if (buf) out.push(buf);
  return out;
}

const indexCache = new WeakMap();

export function buildIndex(doc) {
  if (indexCache.has(doc)) return indexCache.get(doc);
  const chunks = [];
  for (const page of doc?.pages || []) {
    let offset = 0;
    for (const paragraph of page.paragraphs || []) {
      for (const piece of splitLong(paragraph)) {
        chunks.push({ page: page.page, offset, text: piece, lower: piece.toLowerCase() });
        offset += piece.length;
      }
    }
  }
  const index = { chunks };
  indexCache.set(doc, index);
  return index;
}

function countOf(haystack, needle, cap = 4) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (count < cap) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function snippetOf(chunk, terms) {
  let at = -1;
  for (const { term } of terms) {
    const found = chunk.lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) at = 0;
  const start = Math.max(0, at - 60);
  const end = Math.min(chunk.text.length, at + 180);
  const body = chunk.text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < chunk.text.length ? "…" : ""}`;
}

/**
 * Score chunks against the query. Requires a real lexical hit: unlike the old
 * reference implementation there is no "basically anything positive" fallback.
 */
export function searchDoc(doc, query, { maxSnippets = 6, perPage = 3 } = {}) {
  const terms = tokenize(query);
  if (!terms.length) {
    throw Object.assign(new Error("检索词为空或只有停用词，请换一个更具体的关键词。"), {
      status: 400,
      code: "empty_query",
    });
  }
  const normalized = str(query).toLowerCase().replace(/\s+/g, "");
  const { chunks } = buildIndex(doc);
  const scored = [];

  for (const chunk of chunks) {
    let score = 0;
    let matched = 0;
    for (const { term, weight } of terms) {
      const count = countOf(chunk.lower, term);
      if (count) {
        matched += 1;
        score += weight * count;
      }
    }
    if (!matched) continue;
    const coverage = matched / terms.length;
    const phrase = normalized.length >= 2 && chunk.lower.replace(/\s+/g, "").includes(normalized);
    if (coverage < 0.34 && !phrase) continue;
    if (phrase) score += 6;
    scored.push({ chunk, score: score + coverage * 2, matched, phrase });
  }

  scored.sort((a, b) => b.score - a.score || a.chunk.page - b.chunk.page);
  const counts = new Map();
  const hits = [];
  for (const item of scored) {
    const used = counts.get(item.chunk.page) || 0;
    if (used >= perPage) continue;
    counts.set(item.chunk.page, used + 1);
    hits.push({
      page: item.chunk.page,
      score: Number(item.score.toFixed(2)),
      snippet: snippetOf(item.chunk, terms),
      matched: item.matched,
    });
    if (hits.length >= maxSnippets) break;
  }

  return {
    query: str(query).trim(),
    terms: terms.map((item) => item.term),
    hits,
    pages: [...new Set(hits.map((hit) => hit.page))].sort((a, b) => a - b),
    totalChunks: chunks.length,
  };
}

/* ---------- formatting ---------- */

function pageLabel(page) {
  return `p.${page}`;
}

function firstLine(pageDoc) {
  const paragraph = (pageDoc?.paragraphs || []).find((item) => item.trim());
  if (!paragraph) return "";
  const line = paragraph.replace(/\s+/g, " ").trim();
  return line.length > 46 ? `${line.slice(0, 46)}…` : line;
}

function truncate(text, max) {
  const value = str(text).replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function formatOutline(doc, { name = "" } = {}) {
  const total = pageCount(doc);
  const chars = Number(doc?.doc?.chars || 0);
  const lines = [];
  lines.push(`文件：${name || "PDF"}（${total} 页，${chars.toLocaleString("en-US")} 字）`);
  const parser = doc?.doc?.parser || doc?.parser;
  const version = doc?.doc?.version || doc?.version;
  if (parser) lines.push(`解析：${parser}${version ? ` v${version}` : ""}`);

  const scanned = Array.isArray(doc?.doc?.scannedPages) ? doc.doc.scannedPages : [];
  if (scanned.length) {
    const label = scanned.map((page) => pageLabel(page)).join("、");
    lines.push(`无文字页：${label}（图片页或扫描页，正文需要 OCR）`);
  }
  if (doc?.doc?.warning) lines.push(`提示：${doc.doc.warning}`);

  if (Array.isArray(doc?.outline) && doc.outline.length) {
    lines.push("", "目录：");
    for (const item of doc.outline.slice(0, 80)) {
      lines.push(`  ${pageLabel(item.page).padEnd(6)} ${"  ".repeat(Math.max(0, (item.level || 1) - 1))}${item.title}`);
    }
  }

  if (Array.isArray(doc?.headings) && doc.headings.length) {
    lines.push("", "章节（自动识别）：");
    for (const item of doc.headings.slice(0, 80)) {
      lines.push(`  ${pageLabel(item.page).padEnd(6)} ${"  ".repeat(Math.max(0, (item.level || 1) - 1))}${item.text}`);
    }
  }

  lines.push("", "页概览：");
  for (const page of doc?.pages || []) {
    const meta = page.scanned
      ? `无文字，${page.images || 0} 张图片`
      : `${Number(page.chars || 0).toLocaleString("en-US")} 字`;
    lines.push(`  ${pageLabel(page.page).padEnd(6)} ${meta.padEnd(12)} ${firstLine(page)}`);
  }

  lines.push(
    "",
    `读取正文：pdf_read(page="2-4")；检索：pdf_read(query="…")；查看表格：pdf_read(mode="tables", page="2-4")。`,
  );
  return { text: lines.join("\n"), pages: total, chars, scannedPages: scanned };
}

export function formatPages(doc, pages, { name = "", maxChars = 12000 } = {}) {
  const total = pageCount(doc);
  const requested = pages.length ? pages : [1];
  const lines = [];
  const included = [];
  let used = 0;
  let stoppedAt = null;

  lines.push(`文件：${name || "PDF"} · 共 ${total} 页 · 请求 ${requested.join(",")}`);

  for (const number of requested) {
    const page = (doc?.pages || []).find((item) => item.page === number);
    if (!page) continue;
    const body = page.scanned
      ? `[本页无可提取文字${page.images ? `，含 ${page.images} 张图片` : ""}；可能是扫描页或封面，需要 OCR]`
      : (page.paragraphs || []).join("\n\n");
    const block = `--- ${pageLabel(number)} ---\n${body}`;
    if (used + block.length > maxChars && included.length) {
      stoppedAt = number;
      break;
    }
    lines.push("", block);
    included.push(number);
    used += block.length;
    if (used >= maxChars) {
      const next = requested.find((item) => item > number);
      if (next) stoppedAt = next;
      break;
    }
  }

  if (stoppedAt) {
    const remaining = requested.filter((item) => item >= stoppedAt);
    const last = remaining[remaining.length - 1] ?? stoppedAt;
    lines.push(
      "",
      `[输出已截断：本次包含 ${included.map(pageLabel).join("、")}。继续用 page="${stoppedAt}${last !== stoppedAt ? `-${last}` : ""}" 读取剩余内容。]`,
    );
  }

  return { text: lines.join("\n"), pages: included, truncated: Boolean(stoppedAt) };
}

export function formatSearch(result, { name = "" } = {}) {
  const lines = [];
  if (!result.hits.length) {
    lines.push(
      `文件：${name || "PDF"}`,
      `没有找到与「${result.query}」匹配的段落。`,
      "可以换同义词、缩短关键词，或先用默认输出看章节结构。",
    );
    return { text: lines.join("\n"), hits: [] };
  }
  lines.push(
    `文件：${name || "PDF"}`,
    `检索「${result.query}」：命中 ${result.hits.length} 段（${result.pages.map(pageLabel).join("、")}）`,
    "",
  );
  for (const hit of result.hits) {
    lines.push(`[${pageLabel(hit.page)}] ${hit.snippet}`, "");
  }
  lines.push(`用 pdf_read(page="${result.pages[0]}-${result.pages[result.pages.length - 1]}") 读取上下文。`);
  return { text: lines.join("\n").trimEnd(), hits: result.hits };
}

export function formatTables(tables, { name = "", pages = [] } = {}) {
  const lines = [`文件：${name || "PDF"}${pages.length ? ` · 第 ${pages.join(",")} 页` : ""}`];
  if (!tables.length) {
    lines.push("这些页没有识别到表格。可以改用 page= 读取正文。");
    return { text: lines.join("\n"), tables: 0 };
  }
  for (const table of tables) {
    lines.push("", `--- ${pageLabel(table.page)} 表格 ${table.index}（${table.rows} 行 × ${table.cols} 列）---`);
    const header = table.data[0] || [];
    lines.push(`| ${header.map((cell) => truncate(cell, 40) || " ").join(" | ")} |`);
    lines.push(`| ${header.map(() => "---").join(" | ")} |`);
    for (const row of table.data.slice(1, 60)) {
      lines.push(`| ${row.map((cell) => truncate(cell, 40) || " ").join(" | ")} |`);
    }
    if (table.data.length > 61) lines.push(`… 其余 ${table.data.length - 61} 行已省略`);
  }
  return { text: lines.join("\n"), tables: tables.length };
}

export function summarizeDoc(doc) {
  const total = pageCount(doc);
  const chars = Number(doc?.doc?.chars || 0);
  return {
    pages: total,
    chars,
    scannedPages: doc?.doc?.scannedPages || [],
    headings: (doc?.headings || []).length,
    outline: (doc?.outline || []).length,
    parser: doc?.doc?.parser || doc?.parser || "",
    version: doc?.doc?.version || doc?.version || 0,
    warning: doc?.doc?.warning || "",
  };
}

export { CJK_RE };
