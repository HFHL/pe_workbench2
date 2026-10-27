/**
 * Watch brief: the compact, machine-readable focus of one "盯" session.
 *
 * The brief is a projection of analysis-state.json (the fact source) plus the
 * report/model identity. It answers one question for the watcher: "which two
 * or three inputs decide this valuation, and what would make it wrong?"
 *
 * Pure module: no I/O, no time except the injected `now`. Server, UI and tests
 * share the same rules.
 */

export const WATCH_BRIEF_SCHEMA = "pe.watch.brief/v1";

const KEYWORD_LIBRARY = [
  "毛利率", "净利率", "营业利润率", "目标 P/E", "P/E", "PE", "COE", "折现率", "WACC",
  "产能", "kwpm", "HBM", "ASP", "合约价", "价格", "资本开支", "capex", "收入", "营收",
  "EPS", "汇率", "税率", "OPEX", "市场份额", "出货量", "供需", "库存", "出口管制",
];

const CATEGORY_RULES = [
  ["财报", /财报|年报|半年报|季报|业绩预告|业绩快报|年度报告|季度报告/i],
  ["公告", /公告|披露|重大合同|中标|投产|扩产|股东|增持|减持|回购|分红/i],
  ["监管", /监管|出口管制|制裁|禁令|MATCH|BIS|反倾销|关税|许可/i],
  ["行业数据", /价格|合约价|ASP|供需|库存|产能|出货|TrendForce|集邦|DRAM|NAND/i],
  ["评级", /评级|目标价|上调|下调|买入|增持|研报/i],
];

function clean(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function clampText(value, limit = 120) {
  const text = clean(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  return [...new Set(values.map((item) => clean(item)).filter(Boolean))];
}

/**
 * Split "长鑫科技（原长鑫存储，CXMT，688825.SH）" into usable aliases. Bloomberg
 * and Reuters cover Chinese issuers under their English short names (CXMT,
 * CATL, …), so the alias is what makes a site-scoped search work.
 */
export function companyAliases(company) {
  const raw = clean(company);
  const inside = [...raw.matchAll(/[（(]([^）)]*)[）)]/g)].map((match) => match[1]);
  const aliases = inside
    .flatMap((chunk) => chunk.split(/[，,、/;；|]/))
    .map((item) => item.replace(/^(原|现|现名|曾用名|简称|英文名?|中文名?)\s*[:：]?\s*/, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 40);
  return uniq(aliases).slice(0, 8);
}

function keywordsOf(...texts) {
  const haystack = texts.map((text) => clean(text)).join(" ");
  if (!haystack) return [];
  return KEYWORD_LIBRARY.filter((keyword) => haystack.includes(keyword));
}

function firstClause(value) {
  return clean(value).split(/[（(]/)[0].split(/[：:，,；;]/)[0].trim();
}

function impactPercent(text, baseValue) {
  const raw = clean(text);
  if (!raw) return 0;
  // Only signed percentages count as an impact. Unsigned percentages are
  // usually the perturbation itself (e.g. "毛利率 50%→70%"), not the result.
  const signed = [...raw.matchAll(/([+-]\d+(?:\.\d+)?)\s*%/g)]
    .map((match) => Math.abs(Number(match[1])))
    .filter((value) => Number.isFinite(value));
  if (signed.length) return Math.max(...signed);

  const base = Number(baseValue);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const arrow = raw.split(/→|->/);
  if (arrow.length < 2) return 0;
  const numbers = [...arrow.slice(1).join(" ").matchAll(/(\d+(?:\.\d+)?)\s*元/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!numbers.length) return 0;
  return Math.max(...numbers.map((value) => Math.abs(value - base) / base * 100));
}

export function westockSymbol(security) {
  const raw = clean(security);
  if (!raw) return "";
  if (/^(sh|sz|bj|hk|us|t|ks|kq|fu|fx|pt)/i.test(raw)) return raw.toLowerCase();
  const match = raw.match(/^(\d{6})\.(SS|SH|SZ|BJ)$/i);
  if (!match) return raw;
  const suffix = match[2].toUpperCase();
  const prefix = suffix === "SZ" || suffix === "BJ" ? suffix.toLowerCase() : "sh";
  return `${prefix}${match[1]}`;
}

export function classifyHeadline(title, body = "") {
  const text = `${clean(title)} ${clean(body)}`;
  const hits = CATEGORY_RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return hits.length ? hits : ["其他"];
}

function normalizeValuation(raw, index) {
  const value = Number(raw?.value);
  return {
    id: clean(raw?.id, `V${index + 1}`),
    scenario: clean(raw?.scenario, "base"),
    method: clampText(raw?.method, 160),
    asOf: clean(raw?.as_of),
    value: Number.isFinite(value) ? value : null,
    unit: clean(raw?.unit),
    formula: clampText(raw?.formula, 220),
    limitations: clampText(raw?.limitations, 220),
  };
}

function normalizeSensitivity(raw, index, { assumptions, baseValue }) {
  const assumptionIds = uniq(asArray(raw?.assumption_ids));
  const assumption = assumptionIds
    .map((id) => assumptions.find((item) => clean(item?.id) === id))
    .find(Boolean);
  const driver = firstClause(assumption?.statement)
    || firstClause(raw?.perturbation)
    || firstClause(raw?.baseline)
    || `敏感性 ${clean(raw?.id, `S${index + 1}`)}`;
  const impact = Number(impactPercent(`${raw?.result || ""} ${raw?.perturbation || ""}`, baseValue).toFixed(1));
  return {
    id: clean(raw?.id, `S${index + 1}`),
    method: clean(raw?.method, "model_input"),
    driver: clampText(driver, 48),
    assumptionIds,
    baseline: clampText(raw?.baseline, 240),
    perturbation: clampText(raw?.perturbation, 240),
    result: clampText(raw?.result, 240),
    affects: uniq(asArray(raw?.affects)),
    limitations: clampText(raw?.limitations, 220),
    impactPercent: impact,
    keywords: uniq(keywordsOf(driver, raw?.perturbation, raw?.result, assumption?.statement)),
  };
}

function normalizeFalsifier(raw, index) {
  return {
    id: clean(raw?.id, `F${index + 1}`),
    thesisId: clean(raw?.thesis_id),
    metric: clampText(raw?.metric || raw?.statement, 80),
    threshold: clampText(raw?.threshold, 180),
    warning: clampText(raw?.warning, 180),
    source: clampText(raw?.source, 160),
    frequency: clean(raw?.frequency, "monthly"),
    status: clean(raw?.status, "armed"),
    lastObserved: clampText(raw?.last_observed ?? raw?.observed, 160),
    lastCheckedAt: clean(raw?.last_checked_at),
    nextCheckAt: clean(raw?.next_check_at),
    action: clampText(raw?.action, 180),
    keywords: uniq(keywordsOf(raw?.metric, raw?.threshold, raw?.warning)),
  };
}

function normalizeThesis(raw, index) {
  return {
    id: clean(raw?.id, `T${index + 1}`),
    statement: clampText(raw?.statement, 220),
    status: clean(raw?.status, "active"),
    confidence: clean(raw?.confidence, "medium"),
    confidenceReason: clampText(raw?.confidence_reason, 200),
  };
}

/**
 * Build the watch brief. `state` is the parsed analysis-state.json; the caller
 * supplies report/model identity so the brief can be invalidated when either
 * changes.
 */
export function buildWatchBrief({
  state,
  reportPath = "",
  reportVersion = null,
  statePath = "",
  stateRevision = null,
  stateVersion = null,
  modelPath = "",
  modelVersion = null,
  now = new Date(),
} = {}) {
  if (!state || typeof state !== "object") {
    throw Object.assign(new Error("analysis-state.json 不是对象"), { status: 400 });
  }
  const subject = state.subject && typeof state.subject === "object" ? state.subject : {};
  const company = clean(subject.company) || clean(state.framework_id) || "未命名标的";
  const security = clean(subject.security);
  const symbol = westockSymbol(security);

  const assumptions = asArray(state.assumptions);
  const valuations = asArray(state.valuations).map(normalizeValuation);
  const base = valuations.find((item) => item.scenario === "base") || valuations[0] || null;
  const baseValue = base?.value ?? null;

  const sensitivities = asArray(state.sensitivities)
    .map((raw, index) => normalizeSensitivity(raw, index, { assumptions, baseValue }))
    .sort((left, right) => right.impactPercent - left.impactPercent)
    .map((item, index) => ({ ...item, priority: index + 1 }));

  const falsifiers = asArray(state.falsifiers).map(normalizeFalsifier);
  const theses = asArray(state.theses).map(normalizeThesis);

  const topSensitivities = sensitivities.filter((item) => item.priority <= 3);
  const topics = uniq([
    ...topSensitivities.flatMap((item) => item.keywords),
    ...falsifiers.flatMap((item) => item.keywords),
  ]).slice(0, 8);

  const reportLine = reportVersion ? `${reportPath}（v${reportVersion}）` : reportPath;
  const companyShort = company.split(/[（(]/)[0].trim() || company;
  const aliases = companyAliases(company);
  const queryBase = [companyShort, security].filter(Boolean).join(" ");
  const anysearchQueries = uniq([
    `${queryBase} 公告 财报 业绩预告 ${topics.slice(0, 4).join(" ")}`.trim(),
    `${queryBase} ${topics.slice(0, 5).join(" ")} 最新 披露`.trim(),
  ]);

  const invalidationLogic = falsifiers.map((item) => {
    const threshold = item.threshold ? `（${item.threshold}）` : "";
    const action = item.action ? `→ ${item.action}` : "";
    return clampText(`${item.id} ${item.metric}${threshold} ${action}`, 240);
  });
  const failureBoundaries = uniq([
    ...valuations.map((item) => `${item.id}/${item.scenario} ${item.value ?? "—"} ${item.unit}`),
    ...falsifiers
      .filter((item) => /跌破|低于|转负|>|高度|大于/.test(item.threshold))
      .map((item) => `${item.id} ${item.metric} ${item.threshold}`),
  ]).slice(0, 8);

  const warnings = [];
  if (!base) warnings.push("analysis-state.json 里没有估值（valuations）");
  if (!topSensitivities.length) warnings.push("没有敏感性分析（sensitivities），盯盘只能按失效条件检查");
  if (!falsifiers.length) warnings.push("没有失效条件（falsifiers）");
  if (!modelPath) warnings.push("没有找到估值模型文件");
  if (!reportPath) warnings.push("没有找到报告文件");

  return {
    schema: WATCH_BRIEF_SCHEMA,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    target: {
      company,
      aliases,
      security,
      symbol,
      currency: clean(subject.currency),
      units: clean(subject.units),
      horizon: clampText(subject.horizon, 200),
      valuationDate: clean(subject.valuation_date || subject.model_as_of),
      marketPriceDate: clean(subject.market_price_date),
      actualsThrough: clean(subject.actuals_through),
      forecastStart: clean(subject.forecast_start),
      dataCutoff: clean(subject.data_cutoff),
      frameworkId: clean(state.framework_id),
      revision: state.revision ?? stateRevision ?? null,
      reportPath,
      reportVersion,
      reportLine,
      statePath,
      stateRevision,
      stateVersion,
      modelPath,
      modelVersion,
    },
    valuation: {
      base,
      bull: valuations.find((item) => item.scenario === "bull") || null,
      bear: valuations.find((item) => item.scenario === "bear") || null,
      all: valuations,
      market: state.market && typeof state.market === "object"
        ? {
            price: state.market.price ?? null,
            priceDate: clean(state.market.price_date || subject.market_price_date),
            note: clampText(state.market.note, 200),
          }
        : null,
    },
    sensitivities,
    topSensitivities,
    falsifiers,
    theses,
    invalidation: { logic: invalidationLogic, boundaries: failureBoundaries },
    queries: {
      anysearch: anysearchQueries.filter((item) => item.length > 4),
      westockSymbol: symbol,
      topics,
    },
    materiality: {
      categories: CATEGORY_RULES.map(([name]) => name),
      rules: [
        "只有直接影响 top 敏感性输入、或触发/接近失效条件的信息才算重大。",
        "来源要可核验：tier 1-2 优先；tier 3 需两个独立来源或与公告互证。",
        "必须至少给出一个可点击链接（公告/财报/新闻原文）；没有链接不报。",
        "单日价格波动、一般行业评论、重复报道、纯观点文章不算重大。",
      ],
      ignored: [
        "没有新增信息量的重复报道 / 同一研报的多家转载",
        "与敏感性变量和失效条件都无关的行业新闻",
        "无法核验的传闻与论坛内容",
        "只影响短期情绪、不改变任何输入取值的信息",
      ],
    },
    warnings,
  };
}

export function validateWatchBrief(brief) {
  const errors = [];
  if (!brief || typeof brief !== "object") return ["brief 不是对象"];
  if (brief.schema !== WATCH_BRIEF_SCHEMA) errors.push("brief schema 不匹配");
  if (!clean(brief.target?.company)) errors.push("brief 缺少公司名");
  if (!brief.valuation?.base) errors.push("brief 缺少基准估值");
  if (!asArray(brief.sensitivities).length && !asArray(brief.falsifiers).length) {
    errors.push("brief 既没有敏感性也没有失效条件");
  }
  return errors;
}

/** Short labels for the status strip and the message header. */
export function briefHighlights(brief) {
  if (!brief) return [];
  const base = brief.valuation?.base;
  const items = [];
  if (base) {
    items.push({
      kind: "valuation",
      label: `${base.id} ${base.scenario}`,
      value: `${base.value ?? "—"} ${base.unit || ""}`.trim(),
    });
  }
  for (const sensitivity of asArray(brief.topSensitivities).slice(0, 2)) {
    items.push({
      kind: "sensitivity",
      label: `${sensitivity.id} ${sensitivity.driver}`,
      value: sensitivity.impactPercent ? `±${sensitivity.impactPercent}%` : "",
    });
  }
  return items;
}

/** The materiality categories a watcher is allowed to surface. */
export function classifyMaterialityCategory(title, body = "") {
  return classifyHeadline(title, body);
}
