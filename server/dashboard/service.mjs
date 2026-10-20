/**
 * Read-only investment dashboard projection.
 *
 * Inputs are the stored pe.tracking-result for one run, the immutable
 * analysis-state.json blob for that run, the target material's version history
 * and the monitor ledger. The service never calls a model, writes a file, or
 * mutates tracking/material rows. The same (project, tracking, run, version)
 * therefore produces a byte-identical DTO.
 */

import fs from "node:fs";
import path from "node:path";

import { TRACKING_RESULT } from "../../lib/contracts/tracking-result.mjs";
import { INVESTMENT_DASHBOARD } from "../../lib/dashboard/contract.mjs";
import { DASHBOARD_SCHEMA, DASHBOARD_SECTIONS } from "../../lib/dashboard/catalog.mjs";

const TZ = "Asia/Shanghai";
const TRACKING_STATUS_LABEL = {
  updated: "已更新",
  no_change: "无重大变化",
  needs_review: "等待确认",
  baseline: "首次基线",
  failed: "运行失败",
  unavailable: "无结果",
};
const CHECK_STATUS = {
  armed: ["监控中", "尚未达到预警或失效阈值。"],
  warning: ["预警", "已过预警阈值，但尚未触发失效条件。"],
  triggered: ["已触发", "失效条件已成立，需要按动作复核；Dashboard 不会自动执行。"],
  unknown: ["缺数据", "无法确认状态，不能视为正常。"],
  retired: ["已归档", "该条件不再监控。"],
};
const CHECK_STATUS_ORDER = ["triggered", "warning", "unknown", "armed", "retired"];
const THESIS_STATUS = new Set(["active", "weakened", "invalidated", "confirmed", "retired"]);

function text(value, max = 4000) {
  if (value === null || value === undefined) return "";
  return String(value).slice(0, Math.max(0, max));
}

function nullableText(value, max = 4000) {
  if (value === null || value === undefined || value === "") return null;
  return text(value, max);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function versionNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function validDateOnly(raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [year, month, day] = raw.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function iso(value, { allowDate = true } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const datePart = raw.slice(0, 10);
  if (!validDateOnly(datePart)) return null;
  if (raw.length === 10) return allowDate ? raw : null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function safeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function perShareUnit(unit) {
  return typeof unit === "string" && /(?:\/\s*股|per\s*share|share)/i.test(unit);
}

function trackingSourceRef({ trackingId, runId }) {
  return {
    kind: "run",
    label: `跟踪运行 ${runId}`,
    materialId: null,
    version: null,
    path: null,
    locator: runId,
    url: null,
    status: "ok",
    note: `tracking ${trackingId}`,
  };
}

function materialRef(material, version, { kind = "material", label, locator = null, note = null } = {}) {
  const versions = Array.isArray(material?.versions) ? material.versions : [];
  const wanted = versionNumber(version);
  const found = wanted ? versions.find((item) => item.v === wanted) : null;
  return {
    kind,
    label: text(label || material?.name || "材料", 1000),
    materialId: material?.id || null,
    version: wanted || null,
    path: nullableText(material?.relPath, 1000),
    locator: nullableText(locator, 1000),
    url: null,
    status: !material ? "missing" : (wanted ? (found ? "ok" : "broken") : "unverified"),
    note: note || (!material
      ? "材料不存在"
      : !wanted
        ? "来源未固定到某个材料版本"
        : found ? null : `版本 v${wanted} 不在材料历史中`),
  };
}

function externalRef(source) {
  const url = safeExternalUrl(source?.url);
  const label = text(source?.text || source?.query || source?.url || "外部来源", 1000);
  if (url) {
    return {
      kind: "external", label, materialId: null, version: null, path: null,
      locator: null, url, status: "ok", note: null,
    };
  }
  return {
    kind: "text", label, materialId: null, version: null, path: null,
    locator: null, url: null, status: "unverified",
    note: "来源没有可安全打开的 http/https 地址",
  };
}

function stateRef(material, version, relPath, status = "ok", note = null) {
  return {
    kind: "state",
    label: "analysis-state.json",
    materialId: material?.id || null,
    version: versionNumber(version),
    path: nullableText(relPath, 1000),
    locator: "analysis-state.json",
    url: null,
    status: !material ? "missing" : status,
    note,
  };
}

function readStateSnapshot(store, tracking, run) {
  const targetRel = tracking?.relPath || tracking?.targetPath || "";
  if (!targetRel) {
    return { state: null, ref: stateRef(null, null, "", "missing", "跟踪目标路径为空"), relPath: "", version: null };
  }
  const relPath = path.posix.join(path.posix.dirname(targetRel), "analysis-state.json");
  const material = store.findMaterialByPath(relPath);
  if (!material) {
    return {
      state: null,
      ref: stateRef(null, null, relPath, "missing", `未找到 ${relPath}`),
      relPath,
      version: null,
    };
  }

  const versions = Array.isArray(material.versions)
    ? [...material.versions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    : [];
  const runEnd = Date.parse(run?.ended_at || run?.started_at || "");
  const byRun = versions.find((item) => item.runId && item.runId === run?.id);
  const beforeEnd = Number.isFinite(runEnd)
    ? versions.find((item) => {
        const at = Date.parse(item.createdAt);
        return Number.isFinite(at) && at <= runEnd;
      })
    : null;
  const chosen = byRun || beforeEnd || null;

  if (!chosen) {
    return {
      state: null,
      ref: stateRef(material, null, relPath, "broken", "没有与该次运行对应的状态快照"),
      relPath,
      version: null,
    };
  }

  try {
    const raw = fs.readFileSync(store.blobPath(chosen.sha256), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return {
      state: parsed,
      ref: stateRef(material, chosen.v, relPath, "ok", null),
      relPath,
      version: chosen,
    };
  } catch (error) {
    return {
      state: null,
      ref: stateRef(material, chosen.v, relPath, "broken", `状态快照无法解析：${error.message}`),
      relPath,
      version: chosen,
    };
  }
}

function parseRunResult(run, warnings) {
  if (!run?.result_json) return null;
  let parsed;
  try {
    parsed = JSON.parse(run.result_json);
  } catch (error) {
    warnings.push(`运行结果 JSON 无法解析：${error.message}`);
    return null;
  }
  const checked = TRACKING_RESULT.validate(parsed, { allowLegacy: true });
  if (!checked.ok) {
    warnings.push(`运行结果不符合 pe.tracking-result@v1：${checked.errors
      .slice(0, 4)
      .map((item) => `${item.path} ${item.message}`)
      .join("; ")}`);
    return null;
  }
  return checked.value;
}

function latestRuns(store, trackingId) {
  const rows = store.listTrackingRuns(trackingId, 50);
  const latestResult = rows.find((row) => row.result_json) || null;
  const latest = rows[0] || null;
  return { rows, latestResult, latest };
}

function runOptions(rows, latestResultId) {
  return rows.map((row) => {
    const version = versionNumber(row.result_version);
    const label = [
      iso(row.started_at) || "未知时间",
      TRACKING_STATUS_LABEL[row.status] || row.status || "未知状态",
      version ? `v${version}` : "无新版本",
    ].join(" · ");
    return {
      runId: row.id,
      at: iso(row.ended_at || row.started_at),
      status: text(row.status, 100),
      label,
      hasResult: Boolean(row.result_json),
      isLatest: row.id === latestResultId,
    };
  });
}

function translateConfidence(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "high" || raw === "高") return "high";
  if (raw === "medium" || raw === "中") return "medium";
  if (raw === "low" || raw === "低") return "low";
  return null;
}

function baseValuation(state) {
  const valuations = Array.isArray(state?.valuations) ? state.valuations : [];
  return valuations
    .filter((item) => item && item.scenario === "base" && num(item.value) !== null)
    .sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")))[0] || null;
}

function runTargetOutput(result) {
  const outputs = Array.isArray(result?.writeback?.model?.outputs)
    ? result.writeback.model.outputs
    : [];
  return outputs
    .filter((item) => item && num(item.after) !== null && /目标价|target\s*price|\bTP\b/i.test(String(item.label || "")))
    .sort((a, b) => `${a.sheet}!${a.cell}`.localeCompare(`${b.sheet}!${b.cell}`))[0] || null;
}

function valuationSummary({ state, stateVersion, target, modelMaterial, run, result, fromVersion, toVersion, refs, warnings }) {
  const base = baseValuation(state);
  const runOutput = runTargetOutput(result);
  const stateTarget = num(base?.value);
  const runTarget = num(runOutput?.after);
  if (runTarget !== null && stateTarget !== null && Math.abs(runTarget - stateTarget) > 0.005) {
    warnings.push(
      `状态基准估值 ${stateTarget} 与本次运行输出 ${runTarget} 不一致；Dashboard 采用运行输出并可追溯到单元格。`,
    );
  }
  const targetPrice = runTarget !== null ? runTarget : stateTarget;
  const currentPrice = num(state?.market?.price);
  const unit = nullableText(base?.unit || state?.subject?.units, 100);
  // A model output does not make a total-value unit comparable to a per-share
  // market price. Only per-share units may feed the upside calculation.
  const priceUnit = perShareUnit(unit) ? unit : null;
  const canCompute = currentPrice !== null && targetPrice !== null && priceUnit && currentPrice !== 0;
  const upsidePercent = canCompute
    ? Math.round(((targetPrice - currentPrice) / currentPrice) * 10000) / 100
    : null;

  const unknowns = [];
  if (!state) unknowns.push("该次运行没有可读取的 analysis-state.json 快照。");
  if (currentPrice === null) unknowns.push("缺少 currentPrice（现价）；未知不会按 0 处理。");
  if (targetPrice === null) unknowns.push("缺少 targetPrice（目标价）；未从格式化字符串反推。");
  if (targetPrice !== null && !priceUnit) unknowns.push("估值单位不是每股口径，无法安全计算上行空间。");
  if (currentPrice !== null && targetPrice !== null && currentPrice === 0) unknowns.push("现价为 0，无法计算上行空间。");
  if (!base && !runOutput) unknowns.push("状态文件没有 base 情景估值。");
  if (unknowns.length && upsidePercent === null && canCompute === false) {
    // Keep the explicit reasons above; this branch is only documentation.
  }

  const rating = nullableText(state?.review?.rating || state?.rating, 100);
  if (!rating) unknowns.push("analysis-state.json 没有声明评级（rating）。");

  const sourceRefs = [...refs];
  if (runOutput) {
    const outputVersion = versionNumber(result?.writeback?.model?.version);
    const outputVersions = Array.isArray(modelMaterial?.versions) ? modelMaterial.versions : [];
    sourceRefs.unshift({
      kind: "workbook",
      label: `工作模型输出 · ${text(runOutput.label, 300)}`,
      materialId: modelMaterial?.id || null,
      version: outputVersion,
      path: nullableText(result?.writeback?.model?.file, 1000),
      locator: `${text(runOutput.sheet, 200)}!${text(runOutput.cell, 40)}`,
      url: null,
      status: modelMaterial && outputVersions.some((item) => item.v === outputVersion) ? "ok" : "broken",
      note: "数值来自该次运行写回后的模型输出，可定位到单元格",
    });
  }
  if (base) {
    sourceRefs.push({
      kind: "state",
      label: `基准估值 ${text(base.id, 200)}`,
      materialId: stateVersion?.ref?.materialId || null,
      version: stateVersion?.ref?.version || null,
      path: stateVersion?.ref?.path || null,
      locator: `valuations[${text(base.id, 200)}]`,
      url: null,
      status: stateVersion?.ref?.status === "ok" ? "ok" : "broken",
      note: "value / unit / as_of 直接取自状态文件",
    });
  }

  return {
    company: text(state?.subject?.company || target?.name || "未知公司", 1000),
    asOf: iso(base?.as_of || state?.subject?.valuation_date || run?.ended_at || run?.started_at),
    currency: /^[A-Z]{3}$/.test(String(state?.subject?.currency || ""))
      ? String(state.subject.currency)
      : null,
    valueUnit: unit,
    priceUnit,
    method: nullableText(base?.method || (runOutput ? `工作模型 · ${runOutput.label}` : null), 300),
    currentPrice,
    priceDate: iso(state?.market?.price_date || state?.subject?.market_price_date),
    targetPrice,
    upsidePercent,
    rating,
    confidence: translateConfidence(result?.confidence),
    baseCaseLabel: base
      ? `${text(base.id, 200)} · ${text(base.scenario, 100)} · ${text(base.method, 100)}`
      : (runOutput ? `工作模型输出 · ${text(runOutput.label, 300)}` : null),
    baseCaseId: base ? text(base.id, 200) : null,
    conclusion: text(result?.headline || result?.conclusion || "尚无估值结论", 4000),
    unknowns,
    sourceRefs,
  };
}

function versionChangeData({ state, run, result, target, fromVersion, toVersion, refs, warnings }) {
  const deltas = Array.isArray(result?.deltas) ? result.deltas : [];
  const thesisChanged = Array.isArray(result?.theses) && result.theses.some((item) => {
    if (["weakened", "invalidated", "retired"].includes(item.status)) return true;
    const change = String(item.change || "").trim();
    return Boolean(change && !/^(?:维持|不变|无变化|—)(?:[（(].*[）)])?$/.test(change));
  });
  const businessDelta = deltas.some((item) => String(item.from) !== String(item.to))
    || (Array.isArray(result?.modelChanges) && result.modelChanges.length > 0)
    || thesisChanged
    || Boolean(result?.judgment);
  // No result is not a failed run. Only an explicit failed run may say failure.
  const status = result?.status || (run?.status === "failed" ? "failed" : "unavailable");
  let changeKind = "none";
  if (status === "updated") changeKind = businessDelta ? "business" : "audit-only";
  else if (status === "needs_review") changeKind = "review";
  else if (status === "baseline") changeKind = "baseline";
  else if (status === "failed") changeKind = "failed";
  else if (status === "unavailable") changeKind = "unavailable";
  const auditNote = {
    business: "本次存在业务判断调整，见关键数字与调整原因。",
    "audit-only": "本次只产生了审计版本；写入跟踪记录不等于业务判断变化。",
    none: "本期无重大变化，未产生业务判断调整。",
    review: "结果等待人工确认；Dashboard 只读，不会自动执行审批。",
    baseline: "首次基线，没有上一版可比。",
    failed: "本次运行失败，未产生可比较的结论。",
    unavailable: "该次运行没有可用的结构化结果（尚未完成或结果不可读），不判定为业务变化。",
  }[changeKind];

  const from = versionNumber(fromVersion);
  const to = versionNumber(toVersion);
  const fromDate = (target?.versions || []).find((item) => item.v === from)?.createdAt || null;
  const toDate = (target?.versions || []).find((item) => item.v === to)?.createdAt || null;

  const writeback = result?.writeback || {};
  const writebackChanges = (Array.isArray(writeback.changes) ? writeback.changes : []).slice(0, 200).map((item) => ({
    where: text(item.where, 500),
    from: text(item.from, 500),
    to: text(item.to, 500),
    note: text(item.note, 1000),
  }));
  const modelOutputs = (Array.isArray(writeback?.model?.outputs) ? writeback.model.outputs : [])
    .slice(0, 100)
    .map((item) => ({
      label: text(item.label, 300),
      sheet: text(item.sheet, 200),
      cell: text(item.cell, 40),
      before: typeof item.before === "number" || typeof item.before === "string" || typeof item.before === "boolean" ? item.before : null,
      after: typeof item.after === "number" || typeof item.after === "string" || typeof item.after === "boolean" ? item.after : null,
    }));
  const fallbackOutputs = modelOutputs.length
    ? modelOutputs
    : (Array.isArray(result?.modelOutputs) ? result.modelOutputs : []).slice(0, 100).map((item) => ({
        label: text(item.label, 300),
        sheet: text(item.sheet, 200),
        cell: text(item.cell, 40),
        before: null,
        after: null,
      }));

  const gaps = Array.isArray(state?.gaps) ? state.gaps : [];
  const unverified = gaps.slice(0, 200).map((gap) => {
    const id = text(gap?.id, 100);
    const question = text(gap?.question, 2000);
    const impact = text(gap?.impact, 2000);
    return [id, question, impact].filter(Boolean).join("：");
  });

  return {
    fromVersion: from ? `v${from}` : "v?",
    toVersion: to ? `v${to}` : "v?",
    fromDate: iso(fromDate),
    toDate: iso(toDate),
    headline: text(result?.headline || (run ? "该次运行尚无结构化结果" : "尚无运行结果"), 4000),
    conclusion: text(result?.conclusion || "", 4000),
    status,
    statusLabel: TRACKING_STATUS_LABEL[status] || text(status, 100),
    changeKind,
    conclusionChanged: businessDelta,
    auditNote,
    deltas: deltas.slice(0, 200).map((item) => ({
      label: text(item.label, 500),
      from: text(item.from, 500),
      to: text(item.to, 500),
      note: text(item.note, 1000),
      tone: ["up", "down", "flat"].includes(item.tone) ? item.tone : "flat",
    })),
    reasons: (Array.isArray(result?.reasons) ? result.reasons : []).slice(0, 200).map((item) => ({
      tag: text(item.tag, 200),
      title: text(item.title, 1000),
      detail: text(item.detail, 4000),
      source: text(item.source, 1000),
      impact: text(item.impact, 1000),
    })),
    writeback: {
      mode: text(writeback.mode || "未写回", 300),
      version: text(writeback.version || "未产生新版本", 300),
      stats: text(writeback.stats || "", 300),
      note: text(writeback.note || "", 2000),
      backup: text(writeback.backup || "", 1000),
      changes: writebackChanges,
    },
    modelOutputs: fallbackOutputs,
    sources: (Array.isArray(result?.sources) ? result.sources : []).slice(0, 200).map((item) => ({
      label: text(item.label, 500),
      date: text(item.date, 80),
    })),
    notUsed: (Array.isArray(result?.notUsed) ? result.notUsed : []).slice(0, 200).map((item) => text(item, 2000)),
    unverified,
    sourceRefs: refs,
  };
}

function sensitivityData({ state, stateVersion, warnings }) {
  const allNumericValuations = (Array.isArray(state?.valuations) ? state.valuations : [])
    .filter((item) => item && num(item.value) !== null)
    .sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
  if (allNumericValuations.length > 200) {
    warnings.push(`情景估值共 ${allNumericValuations.length} 个，只展示前 200 个。`);
  }
  const valuations = allNumericValuations.slice(0, 200);
  const unknownValuations = (Array.isArray(state?.valuations) ? state.valuations : [])
    .filter((item) => item && num(item.value) === null);

  const scenarioOrder = ["bear", "base", "bull", "reverse"];
  const rawRows = [...new Set(valuations.map((item) => text(item.scenario || "—", 500)))]
    .sort((a, b) => {
      const ai = scenarioOrder.indexOf(a);
      const bi = scenarioOrder.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  const rawColumns = [...new Set(valuations.map((item) => text(item.method || "—", 500)))]
    .sort((a, b) => a.localeCompare(b));
  const rawUnits = [...new Set(valuations.map((item) => text(item.unit || "", 100)).filter(Boolean))];

  if (rawRows.length > 50 || rawColumns.length > 50) {
    warnings.push(`情景或估值方法超过 50 个，矩阵只展示前 50 行/列。`);
  }
  if (rawUnits.length > 20) {
    warnings.push(`估值单位超过 20 种，只展示前 20 种。`);
  }
  const rows = rawRows.slice(0, 50);
  const columns = rawColumns.slice(0, 50);
  const units = rawUnits.slice(0, 20);
  const cells = valuations.map((item) => {
    const isBase = item.scenario === "base";
    return {
      row: text(item.scenario || "—", 500),
      column: text(item.method || "—", 500),
      value: num(item.value),
      unit: text(item.unit || "", 100),
      valuationId: text(item.id || "", 200),
      isBaseCase: isBase,
      sourceRefs: [{
        kind: "state",
        label: `估值 ${text(item.id, 200)} · ${text(item.scenario, 100)} · ${text(item.method, 100)}`,
        materialId: stateVersion?.ref?.materialId || null,
        version: stateVersion?.ref?.version || null,
        path: stateVersion?.ref?.path || null,
        locator: `valuations[${text(item.id, 200)}].value`,
        url: null,
        status: stateVersion?.ref?.status === "ok" ? "ok" : "broken",
        note: "只展示状态文件中已经存在的数值，不在浏览器重算",
      }],
    };
  });

  const baseCell = cells.find((cell) => cell.isBaseCase) || null;
  const available = cells.length > 0;
  let emptyReason = null;
  if (!available) {
    emptyReason = !state
      ? "尚无敏感性数据：没有可读取的历史状态快照。"
      : "尚无敏感性数据：状态文件没有带数值的情景估值。";
  }
  for (const item of unknownValuations) {
    warnings.push(`估值 ${text(item.id, 100)} 的 value 为 null，未放入矩阵，也没有按 0 展示。`);
  }

  const tests = (Array.isArray(state?.sensitivities) ? state.sensitivities : []).slice(0, 100).map((item) => ({
    id: text(item.id, 200),
    method: text(item.method || "", 200),
    baseline: text(item.baseline || "", 1000),
    perturbation: text(item.perturbation || "", 1000),
    result: text(item.result || "", 2000),
    fixedConditions: text(item.fixed_conditions || item.fixedConditions || "", 2000),
    limitations: text(item.limitations || "", 2000),
    sourceRefs: [{
      kind: "state",
      label: `敏感性测试 ${text(item.id, 200)}`,
      materialId: stateVersion?.ref?.materialId || null,
      version: stateVersion?.ref?.version || null,
      path: stateVersion?.ref?.path || null,
      locator: `sensitivities[${text(item.id, 200)}]`,
      url: null,
      status: stateVersion?.ref?.status === "ok" ? "ok" : "broken",
      note: "已存在的敏感性测试文本，Dashboard 不重新计算",
    }],
  }));

  return {
    title: "情景估值矩阵（已有数据，只读）",
    available,
    emptyReason,
    rowAxis: { label: "情景", values: rows },
    columnAxis: { label: "估值方法", values: columns },
    cells,
    baseCase: baseCell ? {
      row: baseCell.row,
      column: baseCell.column,
      valuationId: baseCell.valuationId,
      label: `${baseCell.valuationId} · ${baseCell.row} · ${baseCell.column}`,
      value: baseCell.value,
      unit: baseCell.unit,
    } : null,
    valueUnit: units.length === 1 ? units[0] : (units.length ? "mixed" : ""),
    units,
    summary: baseCell
      ? `基准情景 ${baseCell.value} ${baseCell.unit || ""}（${baseCell.valuationId}），另有 ${Math.max(0, cells.length - 1)} 个已有情景单元。`
      : "",
    tests,
    unknowns: unknownValuations.slice(0, 100).map((item) => `估值 ${text(item.id, 100)} 的数值未知。`),
    sourceRefs: [stateVersion.ref],
  };
}

function falsificationData({ state, stateVersion, runRef, run, monitorItems, result, target, warnings }) {
  const thesisMap = new Map();
  for (const thesis of Array.isArray(state?.theses) ? state.theses : []) {
    if (!thesis?.id) continue;
    thesisMap.set(String(thesis.id), {
      id: text(thesis.id, 200),
      statement: text(thesis.statement || "", 4000),
      status: THESIS_STATUS.has(thesis.status) ? thesis.status : "retired",
    });
  }
  for (const thesis of Array.isArray(result?.theses) ? result.theses : []) {
    if (!thesis?.id || thesisMap.has(String(thesis.id))) continue;
    thesisMap.set(String(thesis.id), {
      id: text(thesis.id, 200),
      statement: text(thesis.statement || "", 4000),
      status: THESIS_STATUS.has(thesis.status) ? thesis.status : "retired",
    });
  }

  const merged = new Map();
  const upsert = (key, patch) => {
    const id = String(key || "").trim();
    if (!id) return;
    const prior = merged.get(id) || {};
    merged.set(id, { ...prior, ...patch, id });
  };

  for (const item of Array.isArray(state?.falsifiers) ? state.falsifiers : []) {
    if (!item?.id) continue;
    upsert(item.id, {
      falsifierId: text(item.id, 200),
      thesisId: text(item.thesis_id || item.thesisId || "", 200),
      metric: text(item.metric || "", 1000),
      operator: text(item.operator || "", 40),
      warning: text(item.warning || "", 1000),
      threshold: text(item.threshold || "", 1000),
      observed: text(item.observed || item.last_observed || "", 1000),
      status: CHECK_STATUS[item.status] ? item.status : "unknown",
      lastCheckedAt: iso(item.last_checked_at || item.lastCheckedAt),
      nextCheckAt: iso(item.next_check_at || item.nextCheckAt),
      action: text(item.action || "", 2000),
      source: item.source && typeof item.source === "object" ? item.source : { text: text(item.source || "", 1000) },
      stateLocator: `falsifiers[${text(item.id, 200)}]`,
      sourceRefs: [],
    });
  }

  for (const item of Array.isArray(monitorItems) ? monitorItems : []) {
    const key = item.falsifierId || item.id;
    const source = item.source && typeof item.source === "object" ? item.source : {};
    upsert(key, {
      id: text(key, 200),
      falsifierId: text(item.falsifierId || item.id || "", 200),
      thesisId: text(item.thesisId || "", 200),
      metric: text(item.metric || "", 1000),
      operator: text(item.operator || "", 40),
      warning: text(item.warning || "", 1000),
      threshold: text(item.threshold || "", 1000),
      observed: text(item.lastObserved || "", 1000),
      status: CHECK_STATUS[item.status] ? item.status : "unknown",
      lastCheckedAt: iso(item.lastCheckedAt),
      nextCheckAt: iso(item.nextCheckAt),
      action: text(item.action || "", 2000),
      source,
      monitorId: text(item.id, 200),
      monitorLocator: `monitor_items[${text(item.id, 200)}]`,
    });
  }

  for (const item of Array.isArray(result?.monitorChecks) ? result.monitorChecks : []) {
    const key = item.falsifier_id || item.id;
    const prior = merged.get(String(key));
    if (!prior) {
      upsert(key, {
        id: text(key, 200),
        falsifierId: text(item.falsifier_id || item.id || "", 200),
        thesisId: "",
        metric: text(item.note || "本次监测检查", 1000),
        operator: "",
        warning: "",
        threshold: "",
        observed: text(item.observed || "", 1000),
        status: CHECK_STATUS[item.status] ? item.status : "unknown",
        lastCheckedAt: iso(run?.ended_at || run?.started_at),
        nextCheckAt: null,
        action: "",
        source: {},
        sourceRefs: [],
      });
    } else {
      prior.observed = text(item.observed || prior.observed || "", 1000);
      prior.status = CHECK_STATUS[item.status] ? item.status : prior.status;
      prior.lastCheckedAt = iso(run?.ended_at || run?.started_at) || prior.lastCheckedAt;
      prior.checkNote = text(item.note || "", 1000);
    }
  }

  for (const item of Array.isArray(result?.invalidations) ? result.invalidations : []) {
    const key = item.id;
    if (!key || merged.has(String(key))) continue;
    upsert(key, {
      id: text(key, 200),
      falsifierId: text(key, 200),
      thesisId: text(item.thesis_id || "", 200),
      metric: text(item.condition || "失效条件", 1000),
      operator: "",
      warning: "",
      threshold: text(item.condition || "", 1000),
      observed: text(item.observed || "", 1000),
      status: item.triggered ? "triggered" : "unknown",
      lastCheckedAt: iso(run?.ended_at || run?.started_at),
      nextCheckAt: null,
      action: text(item.action || "", 2000),
      source: {},
      sourceRefs: [],
    });
  }

  const allChecks = [...merged.values()].map((item) => {
    const thesisId = text(item.thesisId || "", 200);
    const falsifierId = text(item.falsifierId || item.id, 200);
    const status = CHECK_STATUS[item.status] ? item.status : "unknown";
    const [statusLabel, statusMeaning] = CHECK_STATUS[status];
    const linkStatus = thesisId && thesisMap.has(thesisId) ? "linked" : "unbound";
    const refs = [];
    if (item.stateLocator) {
      refs.push({
        kind: "state",
        label: `失效条件 ${falsifierId}`,
        materialId: stateVersion.ref.materialId,
        version: stateVersion.ref.version,
        path: stateVersion.ref.path,
        locator: item.stateLocator,
        url: null,
        status: stateVersion.ref.status,
        note: null,
      });
    }
    if (item.monitorLocator) {
      refs.push({
        kind: "run",
        label: `监测项 ${text(item.monitorId || item.id, 200)}`,
        materialId: null,
        version: null,
        path: null,
        locator: item.monitorLocator,
        url: null,
        status: "ok",
        note: "监测台账（只读）",
      });
    }
    refs.push(runRef);
    if (item.source && (item.source.url || item.source.text || item.source.query)) {
      refs.push(externalRef(item.source));
    }
    return {
      id: text(item.id, 200),
      thesisId,
      falsifierId,
      metric: text(item.metric || "未说明指标", 1000),
      operator: text(item.operator || "", 40),
      warning: text(item.warning || "", 1000),
      threshold: text(item.threshold || "", 1000),
      observed: text(item.observed || "", 1000),
      status,
      statusLabel,
      statusMeaning,
      lastCheckedAt: iso(item.lastCheckedAt),
      nextCheckAt: iso(item.nextCheckAt),
      action: text(item.action || "", 2000),
      linkStatus,
      sourceRefs: refs.slice(0, 100),
    };
  }).sort((a, b) => {
    const order = CHECK_STATUS_ORDER.indexOf(a.status) - CHECK_STATUS_ORDER.indexOf(b.status);
    if (order) return order;
    const an = a.nextCheckAt ? Date.parse(a.nextCheckAt) : Number.MAX_SAFE_INTEGER;
    const bn = b.nextCheckAt ? Date.parse(b.nextCheckAt) : Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return a.id.localeCompare(b.id);
  });
  if (allChecks.length > 300) {
    warnings.push(`监测检查共 ${allChecks.length} 项，只展示前 300 项（已按状态排序）。`);
  }
  const checks = allChecks.slice(0, 300);

  const counts = { triggered: 0, warning: 0, unknown: 0, armed: 0, retired: 0 };
  for (const check of checks) counts[check.status] += 1;
  const unknowns = [];
  if (counts.unknown) unknowns.push(`${counts.unknown} 项监测状态为 unknown（缺数据），不能按正常状态展示。`);
  const unbound = checks.filter((check) => check.linkStatus === "unbound");
  if (unbound.length) unknowns.push(`${unbound.length} 项检查无法解析到已声明的观点或失效条件。`);
  if (counts.triggered) unknowns.push(`${counts.triggered} 项失效条件已触发，需要人工按动作复核。`);

  if (!checks.length) warnings.push("该跟踪没有已声明的失效条件或监测项。");

  const targetVersion = versionNumber(result?.target?.result_version)
    || versionNumber(result?.target?.base_version)
    || null;
  return {
    theses: [...thesisMap.values()].slice(0, 200),
    checks,
    counts,
    unknowns,
    sourceRefs: [stateVersion.ref, runRef, ...(target ? [materialRef(target, targetVersion, { label: `目标文件 ${target.name}` })] : [])],
  };
}

function validateDashboard(dto) {
  const checked = INVESTMENT_DASHBOARD.validate(dto);
  if (!checked.ok) {
    const detail = checked.errors.slice(0, 12).map((item) => `${item.path} ${item.message}`).join("; ");
    throw Object.assign(new Error(`dashboard response failed ${DASHBOARD_SCHEMA.name}@v${DASHBOARD_SCHEMA.version}: ${detail}`), {
      status: 500,
      code: "DASHBOARD_SCHEMA_INVALID",
    });
  }
  return checked.value;
}

export function createDashboardService({ store, root = "" }) {
  if (!store) throw new Error("createDashboardService requires a store");

  function build({ projectId, trackingId, runId = null, materialVersion = null }) {
    if (projectId && projectId !== store.projectId) {
      throw Object.assign(new Error("project mismatch"), { status: 404 });
    }
    const tracking = store.getTracking(trackingId);
    if (!tracking) throw Object.assign(new Error("tracking not found"), { status: 404 });
    const target = tracking.targetId ? store.getMaterial(tracking.targetId) : null;
    const { rows, latestResult, latest } = latestRuns(store, tracking.id);
    if (!rows.length) {
      // A tracking without a run still gets a valid, explicitly empty DTO.
    }

    const explicitRun = Boolean(runId);
    let run = null;
    if (runId) {
      run = rows.find((row) => row.id === runId) || null;
      if (!run) throw Object.assign(new Error("tracking run not found"), { status: 404 });
    } else {
      run = latestResult || latest || null;
    }

    const warnings = [];
    const result = run ? parseRunResult(run, warnings) : null;
    if (!run) warnings.push("该跟踪尚无运行记录，Dashboard 只显示空状态。");
    else if (!run.result_json) warnings.push("该次运行没有结构化结果，Dashboard 只显示空状态。");
    if (run && !result && run.result_json) warnings.push("该次运行结果无法使用，相关区块显示错误/空状态。");

    const isLatestResultRun = Boolean(run && latestResult && run.id === latestResult.id);
    const stateSnapshot = run
      ? readStateSnapshot(store, tracking, run)
      : { state: null, ref: stateRef(null, null, "", "missing", "没有运行记录"), relPath: "", version: null };
    if (!stateSnapshot.state) warnings.push(stateSnapshot.ref.note || "没有可读取的状态快照。");

    const targetVersions = Array.isArray(target?.versions) ? target.versions : [];
    const fromVersion = versionNumber(run?.base_version);
    const toVersion = versionNumber(run?.result_version) || fromVersion;
    let materialVersionOverride = null;
    if (materialVersion !== null && materialVersion !== undefined && String(materialVersion).trim() !== "") {
      const requested = versionNumber(materialVersion);
      if (!requested || !targetVersions.some((item) => item.v === requested)) {
        warnings.push(`请求的 materialVersion=${text(materialVersion, 40)} 不在目标材料版本历史中，已忽略。`);
      } else {
        materialVersionOverride = requested;
        if (toVersion && requested !== toVersion) {
          warnings.push(`请求的 materialVersion=v${requested} 与本次运行结果版本 v${toVersion} 不一致；来源标记采用 v${requested}，版本变化仍以运行记录为准。`);
        }
      }
    }
    const sourceMaterialVersion = materialVersionOverride || toVersion;

    const runRef = run
      ? trackingSourceRef({ trackingId: tracking.id, runId: run.id })
      : {
          kind: "run",
          label: "尚无运行记录",
          materialId: null,
          version: null,
          path: null,
          locator: null,
          url: null,
          status: "missing",
          note: "该跟踪尚无运行记录",
        };
    const fromRef = target ? materialRef(target, fromVersion, {
      label: `目标文件 ${target.name} · 变更前`,
      locator: target.relPath,
      note: "变更前版本",
    }) : stateRef(null, null, "", "missing", "目标材料不存在");
    const toRef = target ? materialRef(target, toVersion, {
      label: `目标文件 ${target.name} · 变更后`,
      locator: target.relPath,
      note: toVersion && fromVersion && toVersion === fromVersion ? "未产生新版本" : "变更后版本",
    }) : stateRef(null, null, "", "missing", "目标材料不存在");
    if (target && fromVersion && !targetVersions.some((item) => item.v === fromVersion)) {
      warnings.push(`变更前版本 v${fromVersion} 不在材料历史中，来源显示为断链。`);
    }
    if (target && toVersion && !targetVersions.some((item) => item.v === toVersion)) {
      warnings.push(`变更后版本 v${toVersion} 不在材料历史中，来源显示为断链。`);
    }

    const baseRefs = [
      stateSnapshot.ref,
      fromRef,
      toRef,
      runRef,
    ];

    const modelFile = result?.writeback?.model?.file;
    const modelMaterial = modelFile ? store.findMaterialByPath(modelFile) : null;
    const valuation = valuationSummary({
      state: stateSnapshot.state,
      stateVersion: stateSnapshot,
      target,
      modelMaterial,
      run,
      result,
      fromVersion,
      toVersion,
      refs: baseRefs,
      warnings,
    });
    const versionChange = versionChangeData({
      state: stateSnapshot.state,
      run,
      result,
      target,
      fromVersion,
      toVersion,
      refs: baseRefs,
      warnings,
    });
    const sensitivity = sensitivityData({
      state: stateSnapshot.state,
      stateVersion: stateSnapshot,
      warnings,
    });
    const falsification = falsificationData({
      state: stateSnapshot.state,
      stateVersion: stateSnapshot,
      runRef,
      run,
      monitorItems: isLatestResultRun ? store.listMonitorItems(tracking.id) : [],
      result,
      target,
      warnings,
    });

    const topRefs = [
      ...valuation.sourceRefs,
      ...versionChange.sourceRefs,
      ...sensitivity.sourceRefs,
      ...falsification.sourceRefs,
    ];
    const hasBrokenRef = topRefs.some((ref) => ref.status === "missing" || ref.status === "broken");
    const dataState = !run || !result
      ? "empty"
      : (!stateSnapshot.state || hasBrokenRef ? "partial" : "complete");

    const dto = {
      schema: { ...DASHBOARD_SCHEMA },
      projectId: store.projectId,
      asOf: iso(run?.ended_at || run?.started_at || stateSnapshot.state?.subject?.data_cutoff || targetVersions[0]?.createdAt),
      timezone: TZ,
      dataState,
      source: {
        trackingId: tracking.id,
        runId: run?.id || null,
        materialId: target?.id || null,
        materialVersion: sourceMaterialVersion || null,
      },
      // A fixed historical run must not change when newer runs are added. The
      // selector for a historical view only contains runs up to that run; the
      // "最新" control loads the latest result separately.
      runs: runOptions(
        explicitRun && run ? [run] : rows,
        explicitRun ? null : (latestResult?.id || null),
      ),
      warnings: [...new Set(warnings.map((item) => text(item, 4000)))].slice(0, 100),
      sections: [
        { type: DASHBOARD_SECTIONS[0].type, version: 1, data: valuation },
        { type: DASHBOARD_SECTIONS[1].type, version: 1, data: versionChange },
        { type: DASHBOARD_SECTIONS[2].type, version: 1, data: sensitivity },
        { type: DASHBOARD_SECTIONS[3].type, version: 1, data: falsification },
      ],
    };

    return validateDashboard(dto);
  }

  return { build };
}

export { validateDashboard };
