/** Dashboard display helpers. Data stays numeric until this layer. */

import { esc, safeUrl } from "../shared/escape.js";

const DATE = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const DATETIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const NUMBER = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

export function fmtDate(value, { time = false } = {}) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return (time ? DATETIME : DATE).format(date);
}

export function fmtNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? NUMBER.format(value) : "未知";
}

export function fmtPrice(value, unit) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "未知";
  return `${NUMBER.format(value)}${unit ? ` ${unit}` : ""}`;
}

export function fmtPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "无法计算";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

export function fmtScalar(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return NUMBER.format(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

export function confidenceLabel(value) {
  return { high: "高", medium: "中", low: "低" }[value] || "未声明";
}

export function sourceRefHTML(ref, { label = null } = {}) {
  const title = [ref.label, ref.path, ref.locator].filter(Boolean).join(" · ");
  const shown = esc(label || ref.label || "来源");
  const locator = ref.locator ? `<span class="dash-src-locator">${esc(ref.locator)}</span>` : "";
  const version = ref.version ? `<span class="dash-src-ver">v${esc(ref.version)}</span>` : "";
  if (ref.status !== "ok") {
    const label = { broken: "断链", missing: "缺失", unverified: "未验证" }[ref.status] || "未验证";
    const tone = ref.status === "broken" ? "is-broken" : ref.status === "missing" ? "is-missing" : "is-unverified";
    return `<span class="dash-src ${tone}" title="${esc(title)}">${shown}${version}${locator}<b>${esc(label)}</b></span>`;
  }
  if (ref.url) {
    const href = safeUrl(ref.url);
    if (href && href !== "#") {
      return `<a class="dash-src" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${shown}${version}${locator}<span aria-hidden="true">↗</span></a>`;
    }
  }
  if (ref.materialId) {
    return `<button type="button" class="dash-src" title="${esc(title)}" data-dash-material="${esc(ref.materialId)}" data-dash-version="${esc(ref.version ?? "")}" data-dash-locator="${esc(ref.locator ?? "")}" aria-label="打开来源：${esc(ref.label)}">${shown}${version}${locator}</button>`;
  }
  return `<span class="dash-src is-text" title="${esc(title)}">${shown}${version}${locator}</span>`;
}

export function sourceRefsHTML(refs, { limit = 6 } = {}) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return `<p class="dash-muted">没有可追溯的来源引用。</p>`;
  const rest = list.length - limit;
  return `<div class="dash-src-row">${list.slice(0, limit).map((ref) => sourceRefHTML(ref)).join("")}${rest > 0 ? `<span class="dash-src is-text">还有 ${esc(String(rest))} 个来源未展开</span>` : ""}</div>`;
}

export function statusTone(status) {
  return ["triggered", "failed"].includes(status)
    ? "danger"
    : ["warning", "needs_review", "unknown", "partial"].includes(status)
      ? "warn"
      : status === "retired"
        ? "muted"
        : "ok";
}
