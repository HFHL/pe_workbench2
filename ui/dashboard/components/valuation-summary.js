import { esc } from "../../shared/escape.js";
import {
  confidenceLabel, fmtDate, fmtPercent, fmtPrice, sourceRefsHTML,
} from "../format.js";

const NULLABLE_NUMBER = (value) => value === null || (typeof value === "number" && Number.isFinite(value));

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default {
  type: "valuation-summary",
  version: 1,
  validate(data) {
    if (!isObject(data)) return "估值区块不是对象";
    if (typeof data.company !== "string") return "缺少 company";
    if (typeof data.conclusion !== "string") return "缺少 conclusion";
    for (const key of ["currentPrice", "targetPrice", "upsidePercent"]) {
      if (!NULLABLE_NUMBER(data[key])) return `${key} 必须是有限数字或 null（不能用字符串或 0 代替未知）`;
    }
    if (data.asOf !== null && typeof data.asOf !== "string") return "asOf 必须是日期字符串或 null";
    if (!Array.isArray(data.unknowns) || !Array.isArray(data.sourceRefs)) return "缺少 unknowns/sourceRefs";
    if (data.confidence !== null && !["high", "medium", "low"].includes(data.confidence)) return "confidence 非法";
    return "";
  },
  empty() {
    return false;
  },
  render(data) {
    const current = fmtPrice(data.currentPrice, data.priceUnit || data.currency);
    const target = fmtPrice(data.targetPrice, data.priceUnit || data.valueUnit);
    const upside = data.upsidePercent === null
      ? `<span class="dash-unknown">无法计算</span>`
      : `<span class="dash-upside ${data.upsidePercent > 0 ? "is-up" : data.upsidePercent < 0 ? "is-down" : ""}">${esc(fmtPercent(data.upsidePercent))}</span>`;
    const copy = [
      `${data.company}｜${data.asOf || "日期未知"}`,
      `现价 ${current}`,
      `目标价 ${target}`,
      `上行空间 ${data.upsidePercent === null ? "无法计算" : fmtPercent(data.upsidePercent)}`,
      `方法 ${data.method || "未声明"}｜币种 ${data.currency || "未声明"}｜单位 ${data.valueUnit || "未声明"}`,
    ].join("\n");
    return `<section class="dash-card dash-valuation" data-section="valuation-summary" aria-labelledby="dashValTitle">
      <div class="dash-card-head">
        <div>
          <div class="dash-eyebrow">01 · 估值结论</div>
          <h2 id="dashValTitle">${esc(data.company)}</h2>
          <p class="dash-sub">估值日 ${esc(fmtDate(data.asOf))} · 币种 <b>${esc(data.currency || "未声明")}</b> · 单位 <b>${esc(data.valueUnit || "未声明")}</b></p>
        </div>
        <button type="button" class="dash-copy" data-dash-copy="${esc(copy)}" aria-label="复制估值摘要">复制摘要</button>
      </div>
      <div class="dash-price-grid">
        <div class="dash-price-block">
          <span>现价</span>
          <strong>${esc(current)}</strong>
          <small>${data.priceDate ? `行情日 ${esc(fmtDate(data.priceDate))}` : "行情日期未知"}</small>
        </div>
        <div class="dash-arrow" aria-hidden="true">→</div>
        <div class="dash-price-block is-target">
          <span>目标价</span>
          <strong>${esc(target)}</strong>
          <small>${esc(data.baseCaseLabel || "基准情景未声明")}</small>
        </div>
        <div class="dash-upside-block">
          <span>上行空间</span>
          ${upside}
          <small>仅在现价与目标价同币种、同每股单位时计算</small>
        </div>
      </div>
      <dl class="dash-facts">
        <div><dt>估值方法</dt><dd>${esc(data.method || "未声明")}</dd></div>
        <div><dt>评级</dt><dd>${data.rating ? esc(data.rating) : '<span class="dash-unknown">未声明</span>'}</dd></div>
        <div><dt>置信度</dt><dd>${esc(confidenceLabel(data.confidence))}</dd></div>
        <div><dt>结论</dt><dd>${esc(data.conclusion)}</dd></div>
      </dl>
      ${data.unknowns.length ? `<div class="dash-note is-warn"><b>未知项</b><ul>${data.unknowns.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>` : ""}
      <div class="dash-sources"><span class="dash-label">来源与追溯</span>${sourceRefsHTML(data.sourceRefs)}</div>
    </section>`;
  },
};
