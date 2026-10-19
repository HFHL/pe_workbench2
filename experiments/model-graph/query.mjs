#!/usr/bin/env node
/**
 * Feasibility probe: retrieve a small subgraph instead of a whole workbook.
 *
 * Usage:
 *   node query.mjs <graph.json> "2026 收入" [--max-cells 40] [--format json|md]
 *
 * Improvements over the reference query (lib/document-query.ts):
 *   - Chinese is tokenised into bigrams instead of being dropped by length > 2.
 *   - A small bilingual synonym table bridges 收入/revenue, 毛利率/gross margin...
 *   - A result must have a textual hit; there is no silent "score by heuristic"
 *     fallback returning arbitrary terminal cells.
 *   - Results are expanded upstream/downstream and capped by cells and chars.
 */

import fs from "node:fs";

const SYNONYMS = {
  收入: ["revenue", "sales", "turnover", "营收", "营业额"],
  营收: ["revenue", "sales", "turnover", "收入"],
  营业额: ["revenue", "sales", "turnover"],
  毛利: ["gross profit", "gross margin", "毛利"],
  净利: ["net profit", "net income", "净利润"],
  净利润: ["net profit", "net income", "net income"],
  利润: ["profit", "earnings", "income"],
  利润率: ["margin", "profitability"],
  现金流: ["cash flow", "cashflow"],
  自由现金流: ["free cash flow", "fcf"],
  经营现金流: ["operating cash flow", "cfo", "cash flow from operations"],
  资本开支: ["capex", "capital expenditure", "capital expenditures"],
  估值: ["valuation", "ev", "p/e", "pe"],
  市盈率: ["p/e", "pe", "price to earnings"],
  市净率: ["p/b", "pb", "price to book"],
  股息: ["dividend", "dps"],
  负债: ["debt", "liabilities", "borrowings"],
  净资产: ["net assets", "equity", "book value"],
  增长: ["growth", "cagr", "yoy"],
  销量: ["volume", "sales volume", "units"],
  单价: ["asp", "price", "average selling price"],
  成本: ["cost", "cogs", "cost of sales"],
  费用: ["expense", "opex", "sg&a"],
  税率: ["tax rate", "tax"],
  折现: ["discount", "wacc"],
  永续: ["terminal", "perpetuity"],
  回报: ["return", "roe", "roic"],
  毛利率: ["gross margin", "gross profit margin", "margin"],
  息税前利润: ["ebit", "operating profit"],
  息税折旧摊销前利润: ["ebitda"],
};

const STOP = new Set(["the", "and", "for", "with", "what", "which", "how", "的", "是", "了", "吗", "呢", "在"]);

function isPeriod(token) {
  return /^\d{4}$/.test(token) || /^\d{1,2}q\d{2,4}$/i.test(token) || /^\d{4}e$/i.test(token);
}

function tokenize(query) {
  const raw = String(query || "").toLowerCase().match(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?|q\d|[\u4e00-\u9fff]+/g) || [];
  const weights = new Map();

  const add = (token, weight) => {
    if (!token || STOP.has(token)) return;
    weights.set(token, Math.max(weights.get(token) || 0, weight));
  };

  for (const token of raw) {
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      if (token.length >= 2) {
        add(token, 1);
        for (let i = 0; i + 2 <= token.length; i++) add(token.slice(i, i + 2), 0.8);
      }
    } else {
      add(token, 1);
    }
    for (const alt of SYNONYMS[token] || []) add(alt.toLowerCase(), 0.7);
    if (/^[a-z]+$/.test(token) && token.length > 3) add(token.replace(/s$/, ""), 1);
  }

  return [...weights]
    .filter(([token]) => token.length > 1 || /^\d+$/.test(token))
    .map(([token, weight]) => ({ token, weight }));
}

function loadGraph(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const cells = new Map();
  for (const [id, formula, value, row, col, rowLabel, colLabel] of doc.cells) {
    const [sheet, coord] = id.split("!", 2);
    cells.set(id, { id, sheet, coord, formula, value, row, col, rowLabel, colLabel });
  }
  const upstream = new Map();
  const downstream = new Map();
  for (const [from, to] of doc.edges) {
    if (!cells.has(from) || !cells.has(to)) continue;
    if (!upstream.has(to)) upstream.set(to, []);
    upstream.get(to).push(from);
    if (!downstream.has(from)) downstream.set(from, []);
    downstream.get(from).push(to);
  }
  return { doc, cells, upstream, downstream };
}

function hit(haystack, needle) {
  return typeof haystack === "string" && haystack.toLowerCase().includes(needle);
}

function ratioRow(label) {
  return /^(as\s*%|%\s*of|yoy|growth|diff|change|margin|as % of|as %)/i.test(label || "");
}

function sheetWeight(sheet) {
  const name = String(sheet || "").toLowerCase();
  if (/product|segment|quarterly|chart|old|export|raw|data|check|template/.test(name)) return -2;
  if (/consolidated|summary|dcf|valuation|results|multiples|^is$|^bs$|^cf$|p&l/.test(name)) return 3;
  return 0;
}

function scoreCell(cell, tokens, queryHasRatio, queryHasValuation, periodTokens, downstream) {
  let score = 0;
  let textHit = false;
  const matched = [];

  for (const { token, weight } of tokens) {
    const row = hit(cell.rowLabel, token);
    const col = hit(cell.colLabel, token);
    if (row) matched.push(`row:${token}`);
    if (col) matched.push(`col:${token}`);

    let local = 0;
    if (row) local += (cell.rowLabel.toLowerCase() === token ? 12 : 8) * weight;
    if (col) local += (cell.colLabel.toLowerCase() === token ? 8 : 5) * weight;
    if (row && col) local *= 0.6; // do not double count "Sales / Sales"
    if ((row || col) && hit(cell.sheet, token)) {
      local += 3 * weight;
      matched.push(`sheet:${token}`);
    }
    if (cell.formula && hit(cell.formula, token)) {
      local += 1 * weight;
      matched.push(`formula:${token}`);
    }
    if (row || col) textHit = true;
    score += local;
  }

  if (!textHit) return null;

  const periodHit = periodTokens.some(
    (token) => hit(cell.colLabel, token) || hit(cell.rowLabel, token),
  );
  if (periodHit) score += 6;

  if (!queryHasRatio && ratioRow(cell.rowLabel)) score -= 5;
  if (!queryHasRatio && /%|yoy|growth|diff|change|ratio|gearing/i.test(cell.rowLabel || "")) score -= 5;
  if (!queryHasValuation && /\//.test(cell.rowLabel || "")) score -= 4;
  if (/^(group|total|consolidated|overall)\b/i.test(cell.rowLabel || "")) score += 3;
  score += sheetWeight(cell.sheet);
  if (cell.formula && (downstream.get(cell.id) || []).length === 0) score += 2;

  return { score: Math.max(0, score), matched };
}

function directCell(graph, query) {
  const match = String(query).match(/(?:^|\s)((?:[^!\s]+)!)?\$?([A-Za-z]{1,3})\$?(\d+)(?:\s|$)/);
  if (!match) return null;
  const sheet = match[1] ? match[1].replace(/!$/, "") : null;
  const coord = `${match[2].toUpperCase()}${match[3]}`;
  for (const cell of graph.cells.values()) {
    if (cell.coord !== coord) continue;
    if (sheet && cell.sheet.toLowerCase() !== sheet.toLowerCase()) continue;
    return cell;
  }
  return null;
}

export function queryGraph(graph, query, options = {}) {
  const maxCells = options.maxCells || 40;
  const maxChars = options.maxChars || 9000;
  const tokens = tokenize(query);
  const periodTokens = tokens.filter(({ token }) => isPeriod(token)).map(({ token }) => token);
  const queryHasRatio = tokens.some(({ token }) => /%|yoy|growth|margin|ratio|率/.test(token));
  const queryHasValuation = tokens.some(({ token }) =>
    /^(valuation|multiple|ev|p\/e|pe|估值|市盈率)$/.test(token),
  );
  const direct = directCell(graph, query);

  const scored = [];
  for (const cell of graph.cells.values()) {
    if (direct && cell !== direct) continue;
    const result = direct
      ? { score: 100, matched: ["direct"] }
      : scoreCell(cell, tokens, queryHasRatio, queryHasValuation, periodTokens, graph.downstream);
    if (result) scored.push({ cell, ...result });
  }
  scored.sort((a, b) => b.score - a.score);

  // Explicit sheet query ("DCF") is a legitimate request: return that sheet's
  // output cells instead of pretending nothing matched.
  if (!scored.length && !direct) {
    const wanted = String(query).trim().toLowerCase();
    const sheet = graph.doc.sheets.find((item) => item.name.toLowerCase() === wanted);
    if (sheet) {
      for (const cell of graph.cells.values()) {
        if (cell.sheet !== sheet.name || !cell.formula) continue;
        if ((graph.downstream.get(cell.id) || []).length > 0) continue;
        scored.push({ cell, score: 5, matched: ["sheet"] });
      }
    }
  }

  const seeds = scored.slice(0, direct ? 1 : 12);
  const selected = new Map();
  const queue = [];
  for (const seed of seeds) {
    selected.set(seed.cell.id, { cell: seed.cell, score: seed.score, distance: 0, via: "seed" });
    queue.push({ id: seed.cell.id, distance: 0 });
  }

  while (queue.length && selected.size < maxCells) {
    const { id, distance } = queue.shift();
    if (distance >= 2) continue;
    const up = (graph.upstream.get(id) || []).slice(0, 3);
    const down = (graph.downstream.get(id) || []).slice(0, 2);
    for (const [dir, list] of [["up", up], ["down", down]]) {
      for (const next of list) {
        if (selected.size >= maxCells) break;
        if (selected.has(next)) continue;
        const nextCell = graph.cells.get(next);
        // Skip unlabeled helper cells (date serials, flags); they add noise
        // without helping a human or the model answer the question.
        if (!nextCell.rowLabel && !nextCell.colLabel && !nextCell.formula) continue;
        selected.set(next, {
          cell: graph.cells.get(next),
          score: 0,
          distance: distance + 1,
          via: dir,
        });
        queue.push({ id: next, distance: distance + 1 });
      }
    }
  }

  const rows = [...selected.values()]
    .sort((a, b) => b.score - a.score || a.distance - b.distance)
    .map((item) => {
      const cell = item.cell;
      return {
        id: cell.id,
        label: [cell.rowLabel, cell.colLabel].filter(Boolean).join(" / "),
        formula: cell.formula ? cell.formula.slice(0, 300) : null,
        value: cell.value,
        sheet: cell.sheet,
        coord: cell.coord,
        distance: item.distance,
        via: item.via,
        score: item.score,
        upstream: (graph.upstream.get(cell.id) || []).length,
        downstream: (graph.downstream.get(cell.id) || []).length,
      };
    });

  // Cap by characters as well as by cell count.
  const kept = [];
  let chars = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (kept.length && chars + size > maxChars) break;
    kept.push(row);
    chars += size;
  }

  return {
    query,
    tokens,
    matchedCells: scored.length,
    seeds: seeds.map((s) => s.cell.id),
    returned: kept.length,
    cells: kept,
    stats: graph.doc.stats,
    sheets: graph.doc.sheets.map((s) => ({
      name: s.name,
      formulas: s.formulaCount,
      rows: s.rows,
      cols: s.cols,
    })),
  };
}

function toMarkdown(result) {
  const lines = [];
  lines.push(`**查询**: ${result.query}`);
  lines.push(`命中 ${result.matchedCells} 个单元格，返回相关子图 ${result.returned} 个。`);
  if (!result.matchedCells) {
    lines.push("没有匹配到任何标签/表名/公式，请换一个关键词或给出 Sheet!A1。");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("| 单元格 | 标签 | 公式 | 值 |");
  lines.push("| --- | --- | --- | --- |");
  for (const cell of result.cells) {
    const value = typeof cell.value === "number" ? Number(cell.value.toFixed(4)) : cell.value;
    lines.push(
      `| ${cell.id} | ${cell.label || "—"} | ${cell.formula || "输入"} | ${value ?? "—"} |`,
    );
  }
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  const query = args[1];
  if (!file || !query) {
    console.error('usage: node query.mjs <graph.json> "query" [--max-cells 40] [--format json|md]');
    process.exit(1);
  }
  const maxCellsIndex = args.indexOf("--max-cells");
  const maxCells = maxCellsIndex > -1 ? Number(args[maxCellsIndex + 1]) : 40;
  const formatIndex = args.indexOf("--format");
  const format = formatIndex > -1 ? args[formatIndex + 1] : "json";

  const graph = loadGraph(file);
  const result = queryGraph(graph, query, { maxCells });
  console.log(format === "md" ? toMarkdown(result) : JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
