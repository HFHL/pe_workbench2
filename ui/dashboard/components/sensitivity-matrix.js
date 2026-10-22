import { esc } from "../../shared/escape.js";
import { fmtNumber, sourceRefsHTML } from "../format.js";

const SCENARIO = { bear: "悲观", base: "基准", bull: "乐观", reverse: "反推" };

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export default {
  type: "sensitivity-matrix",
  version: 1,
  validate(data) {
    if (!isObject(data)) return "敏感性区块不是对象";
    if (typeof data.title !== "string" || typeof data.available !== "boolean") return "缺少 title/available";
    if (!isObject(data.rowAxis) || !Array.isArray(data.rowAxis.values)) return "缺少 rowAxis";
    if (!isObject(data.columnAxis) || !Array.isArray(data.columnAxis.values)) return "缺少 columnAxis";
    if (!Array.isArray(data.cells) || !Array.isArray(data.tests) || !Array.isArray(data.sourceRefs)) return "缺少 cells/tests/sourceRefs";
    for (const cell of data.cells) {
      if (!isObject(cell) || typeof cell.row !== "string" || typeof cell.column !== "string") return "cell 缺少行列";
      if (cell.value !== null && (typeof cell.value !== "number" || !Number.isFinite(cell.value))) return "cell.value 必须是数字或 null";
      if (typeof cell.unit !== "string") return "cell.unit 必须是字符串";
    }
    if (data.baseCase !== null && (!isObject(data.baseCase) || typeof data.baseCase.value !== "number")) return "baseCase 非法";
    if (data.available && !data.cells.length) return "available=true 但没有 cells";
    return "";
  },
  empty(data) {
    return !data.available || !data.cells.length;
  },
  emptyHTML(data) {
    return `<section class="dash-card dash-sensitivity is-empty" data-section="sensitivity-matrix" aria-labelledby="dashSensTitle">
      <div class="dash-eyebrow">03 · 敏感性</div>
      <h2 id="dashSensTitle">尚无敏感性数据</h2>
      <p>${esc(data.emptyReason || "状态文件没有带数值的情景估值。没有生成虚构矩阵，也没有调用模型补齐。")}</p>
      ${data.tests.length ? `<details class="dash-details"><summary>已有敏感性测试 <span>${data.tests.length} 条</span></summary>${testsHTML(data.tests)}</details>` : ""}
      <div class="dash-sources"><span class="dash-label">来源与追溯</span>${sourceRefsHTML(data.sourceRefs)}</div>
    </section>`;
  },
  render(data) {
    const cellMap = new Map(data.cells.map((cell) => [`${cell.row}\u0000${cell.column}`, cell]));
    const head = data.columnAxis.values.map((column) => `<th scope="col">${esc(column)}</th>`).join("");
    const rows = data.rowAxis.values.map((row) => `<tr>
      <th scope="row">${esc(SCENARIO[row] || row)}<small>${esc(row)}</small></th>
      ${data.columnAxis.values.map((column) => {
        const cell = cellMap.get(`${row}\u0000${column}`);
        if (!cell) return `<td class="dash-empty-cell" aria-label="没有这个情景与方法的数据">—</td>`;
        return `<td class="${cell.isBaseCase ? "is-base" : ""}">
          <span class="dash-cell-value">${esc(fmtNumber(cell.value))}</span>
          <span class="dash-cell-unit">${esc(cell.unit || "单位未声明")}</span>
          ${cell.isBaseCase ? '<span class="dash-base-tag">基准</span>' : ""}
          ${cell.sourceRefs.length ? `<span class="dash-cell-src">${sourceRefsHTML(cell.sourceRefs, { limit: 1 })}</span>` : ""}
        </td>`;
      }).join("")}
    </tr>`).join("");
    return `<section class="dash-card dash-sensitivity" data-section="sensitivity-matrix" aria-labelledby="dashSensTitle">
      <div class="dash-card-head">
        <div>
          <div class="dash-eyebrow">03 · 敏感性</div>
          <h2 id="dashSensTitle">${esc(data.title)}</h2>
          <p class="dash-sub">输出单位 <b>${esc(data.valueUnit === "mixed" ? "混合单位（逐格标注）" : data.valueUnit || "未声明")}</b> · 只展示状态文件中已有的数值</p>
        </div>
        <span class="dash-badge muted">只读</span>
      </div>
      <p class="dash-headline">${esc(data.summary || "已有情景估值如下。")}</p>
      <div class="dash-matrix-wrap">
        <table class="dash-matrix">
          <caption>行：${esc(data.rowAxis.label)}；列：${esc(data.columnAxis.label)}。基准情景同时用“基准”文字标注。</caption>
          <thead><tr><th scope="col">${esc(data.rowAxis.label)} \ ${esc(data.columnAxis.label)}</th>${head}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${data.tests.length ? `<details class="dash-details"><summary>已有敏感性测试 <span>${data.tests.length} 条</span></summary>${testsHTML(data.tests)}</details>` : ""}
      ${data.unknowns.length ? `<div class="dash-note is-warn"><b>未放入矩阵</b><ul>${data.unknowns.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>` : ""}
      <div class="dash-sources"><span class="dash-label">来源与追溯</span>${sourceRefsHTML(data.sourceRefs)}</div>
    </section>`;
  },
};

function testsHTML(tests) {
  return `<div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>ID</th><th>方法</th><th>基线</th><th>扰动</th><th>结果</th><th>固定条件</th><th>限制</th></tr></thead><tbody>
    ${tests.map((test) => `<tr>
      <td class="dash-mono">${esc(test.id)}</td>
      <td>${esc(test.method)}</td>
      <td>${esc(test.baseline)}</td>
      <td>${esc(test.perturbation)}</td>
      <td>${esc(test.result)}</td>
      <td>${esc(test.fixedConditions)}</td>
      <td>${esc(test.limitations)}</td>
    </tr>`).join("")}
  </tbody></table></div>`;
}
