import { esc } from "../../shared/escape.js";
import { fmtDate, fmtScalar, sourceRefsHTML } from "../format.js";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default {
  type: "version-change",
  version: 1,
  validate(data) {
    if (!isObject(data)) return "版本区块不是对象";
    for (const key of ["fromVersion", "toVersion", "headline", "status", "statusLabel", "changeKind", "auditNote"]) {
      if (typeof data[key] !== "string") return `缺少 ${key}`;
    }
    if (!["updated", "no_change", "needs_review", "baseline", "failed", "unavailable"].includes(data.status)) return "status 非法";
    if (!["business", "audit-only", "none", "review", "baseline", "failed", "unavailable"].includes(data.changeKind)) return "changeKind 非法";
    if (typeof data.conclusionChanged !== "boolean") return "conclusionChanged 必须是布尔值";
    for (const key of ["deltas", "reasons", "sources", "notUsed", "unverified", "sourceRefs", "modelOutputs"]) {
      if (!Array.isArray(data[key])) return `缺少 ${key}`;
    }
    if (!isObject(data.writeback) || !Array.isArray(data.writeback.changes)) return "缺少 writeback.changes";
    return "";
  },
  empty() {
    return false;
  },
  render(data) {
    const tone = data.changeKind === "business" ? "ok" : data.changeKind === "failed" ? "danger" : data.changeKind === "audit-only" || data.changeKind === "review" ? "warn" : "muted";
    const deltaRows = data.deltas.slice(0, 8).map((item) => `<tr>
      <th scope="row">${esc(item.label)}</th>
      <td class="dash-old">${esc(item.from)}</td>
      <td class="dash-arrow-cell" aria-hidden="true">→</td>
      <td class="dash-new">${esc(item.to)}</td>
      <td class="dash-delta-note ${esc(item.tone)}">${esc(item.note)}</td>
    </tr>`).join("");
    const extraDeltas = data.deltas.length > 8
      ? `<p class="dash-more-note">另有 ${data.deltas.length - 8} 项数字变化未展开；请打开来源版本核对。</p>`
      : "";
    const reasons = data.reasons.length
      ? `<details class="dash-details" ${data.reasons.length <= 3 ? "open" : ""}>
          <summary>调整原因与影响链 <span>${data.reasons.length} 条</span></summary>
          <ol class="dash-reasons">${data.reasons.map((reason) => `<li>
            <div class="dash-reason-head"><span class="dash-tag">${esc(reason.tag)}</span><strong>${esc(reason.title)}</strong></div>
            <p>${esc(reason.detail)}</p>
            <div class="dash-reason-foot"><span>来源：${esc(reason.source)}</span><span>影响：${esc(reason.impact)}</span></div>
          </li>`).join("")}</ol>
        </details>`
      : `<p class="dash-muted">本次没有记录调整原因。</p>`;
    const writebackChanges = data.writeback.changes.length
      ? `<details class="dash-details"><summary>写回位置 <span>${data.writeback.changes.length} 处</span></summary>
          <div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>位置</th><th>原值</th><th>新值</th><th>说明</th></tr></thead>
          <tbody>${data.writeback.changes.map((change) => `<tr><td class="dash-mono">${esc(change.where)}</td><td>${esc(change.from)}</td><td><strong>${esc(change.to)}</strong></td><td>${esc(change.note)}</td></tr>`).join("")}</tbody></table></div>
        </details>`
      : "";
    const modelOutputs = data.modelOutputs.length
      ? `<details class="dash-details"><summary>模型输出单元格 <span>${data.modelOutputs.length} 个</span></summary>
          <ul class="dash-outputs">${data.modelOutputs.map((output) => `<li><span class="dash-mono">${esc(output.sheet)}!${esc(output.cell)}</span><strong>${esc(output.label)}</strong><span>${esc(fmtScalar(output.before))} → ${esc(fmtScalar(output.after))}</span></li>`).join("")}</ul>
        </details>`
      : "";
    const sources = data.sources.length
      ? `<div class="dash-src-row">${data.sources.slice(0, 8).map((source) => `<span class="dash-src is-text">${esc(source.label)}<em>${esc(source.date)}</em></span>`).join("")}</div>${data.sources.length > 8 ? `<p class="dash-more-note">另有 ${data.sources.length - 8} 个来源未展开。</p>` : ""}`
      : `<p class="dash-muted">本次没有记录数据来源。</p>`;
    const pending = [
      data.notUsed.length ? `<div class="dash-note"><b>未使用</b><ul>${data.notUsed.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>` : "",
      data.unverified.length ? `<div class="dash-note is-warn"><b>未验证 / 缺口</b><ul>${data.unverified.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>` : "",
    ].join("");
    return `<section class="dash-card dash-version" data-section="version-change" aria-labelledby="dashVerTitle">
      <div class="dash-card-head">
        <div>
          <div class="dash-eyebrow">02 · 版本变化</div>
          <h2 id="dashVerTitle">${esc(data.fromVersion)} → ${esc(data.toVersion)}</h2>
          <p class="dash-sub">${esc(fmtDate(data.fromDate))} → ${esc(fmtDate(data.toDate))} · 状态 <b>${esc(data.statusLabel)}</b></p>
        </div>
        <span class="dash-badge ${tone}">${esc(data.statusLabel)}</span>
      </div>
      <div class="dash-change-verdict ${tone}">
        <strong>${verdictText(data)}</strong>
        <p>${esc(data.auditNote)}</p>
      </div>
      <p class="dash-headline">${esc(data.headline)}</p>
      <div class="dash-block">
        <h3>关键数字旧值 → 新值</h3>
        ${data.deltas.length
          ? `<div class="dash-table-wrap"><table class="dash-table dash-delta-table"><thead><tr><th>指标</th><th>旧值</th><th></th><th>新值</th><th>说明</th></tr></thead><tbody>${deltaRows}</tbody></table></div>${extraDeltas}`
          : `<p class="dash-muted">本次没有记录关键数字变化。</p>`}
      </div>
      <div class="dash-block"><h3>调整原因</h3>${reasons}</div>
      <div class="dash-block"><h3>写回位置</h3>
        <div class="dash-writeback">
          <div><span>模式</span><strong>${esc(data.writeback.mode)}</strong></div>
          <div><span>版本</span><strong>${esc(data.writeback.version)}</strong></div>
          <div><span>统计</span><strong>${esc(data.writeback.stats || "—")}</strong></div>
          ${data.writeback.backup ? `<div><span>备份</span><strong class="dash-mono">${esc(data.writeback.backup)}</strong></div>` : ""}
        </div>
        ${data.writeback.note ? `<p class="dash-note-text">${esc(data.writeback.note)}</p>` : ""}
        ${writebackChanges}${modelOutputs}
      </div>
      <div class="dash-block"><h3>来源</h3>${sources}</div>
      <div class="dash-block"><h3>未使用与未验证</h3>${pending || `<p class="dash-muted">没有声明未使用或未验证项。</p>`}</div>
      <div class="dash-sources"><span class="dash-label">版本与运行追溯</span>${sourceRefsHTML(data.sourceRefs, { limit: 8 })}</div>
    </section>`;
  },
};

function verdictText(data) {
  if (data.changeKind === "unavailable") return "无结果，未产生可比较结论";
  if (data.changeKind === "failed") return "运行失败，未产生可比较结论";
  if (data.conclusionChanged) return "结论有实质变化";
  if (data.changeKind === "audit-only") return "仅审计版本，不是业务判断变化";
  return "结论无业务变化";
}
