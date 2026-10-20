/**
 * Fixed dashboard component catalog.
 *
 * A component declares type, version, validate, render, empty and error. The
 * registry never accepts a component from payload data; only modules imported
 * at build time can register one.
 */

import { esc, safeText } from "../shared/escape.js";

const registry = new Map();
const keyOf = (type, version) => `${type}@${Number(version)}`;

export function registerDashboardComponent(component) {
  if (!component || !component.type) throw new Error("dashboard component requires type");
  const version = Number(component.version || 1);
  for (const method of ["validate", "render", "empty"]) {
    if (typeof component[method] !== "function") {
      throw new Error(`dashboard component ${component.type} requires ${method}`);
    }
  }
  const entry = Object.freeze({ ...component, version });
  registry.set(keyOf(component.type, version), entry);
  return entry;
}

export function getDashboardComponent(type, version = 1) {
  return registry.get(keyOf(type, version)) || null;
}

export function componentErrorHTML(message, { title = "无法渲染这个区块" } = {}) {
  return `<section class="dash-card dash-error" role="alert">
    <div class="dash-eyebrow">组件错误</div>
    <h2>${esc(title)}</h2>
    <p>${esc(safeText(message, 600))}</p>
  </section>`;
}

export function renderDashboardSection(section) {
  if (!section || typeof section !== "object") return componentErrorHTML("缺少区块对象");
  const component = getDashboardComponent(section.type, section.version);
  if (!component) {
    return componentErrorHTML(
      `未知的 Dashboard 组件或版本：${String(section.type)}@${String(section.version)}。不会 fallback 为任意 HTML。`,
      { title: "未知组件 / 版本" },
    );
  }
  let problem;
  try {
    problem = component.validate(section.data);
  } catch (error) {
    problem = error.message || String(error);
  }
  if (problem) return componentErrorHTML(problem, { title: `${section.type} 数据不完整` });
  try {
    if (component.empty(section.data)) {
      return typeof component.emptyHTML === "function"
        ? component.emptyHTML(section.data)
        : `<section class="dash-card dash-empty"><h2>${esc(section.type)}</h2><p>暂无可展示的数据。</p></section>`;
    }
    return component.render(section.data, { section });
  } catch (error) {
    return componentErrorHTML(error.message || String(error), { title: `${section.type} 渲染失败` });
  }
}

export function validateDashboardDto(dto) {
  if (!dto || typeof dto !== "object") return "响应不是对象";
  if (dto.schema?.name !== "pe.investment-dashboard" || Number(dto.schema?.version) !== 1) {
    return "不是受支持的 pe.investment-dashboard@v1 响应";
  }
  if (!Array.isArray(dto.sections) || dto.sections.length !== 4) return "sections 必须是固定的四个区块";
  const expected = ["valuation-summary", "version-change", "sensitivity-matrix", "falsification-panel"];
  const seen = new Set();
  for (const [index, section] of dto.sections.entries()) {
    const component = getDashboardComponent(section?.type, section?.version);
    if (!component) return `未知组件或版本：${String(section?.type)}@${String(section?.version)}`;
    if (seen.has(section.type)) return `重复的区块：${section.type}`;
    if (section.type !== expected[index]) return `区块顺序不正确：第 ${index + 1} 个应为 ${expected[index]}`;
    seen.add(section.type);
  }
  return "";
}

export function renderDashboardSections(dto) {
  const problem = validateDashboardDto(dto);
  if (problem) return componentErrorHTML(problem, { title: "Dashboard 响应被拒绝" });
  return dto.sections.map(renderDashboardSection).join("");
}
