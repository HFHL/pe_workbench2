/**
 * pe.investment-dashboard v1 fixed section catalog.
 *
 * The model never chooses a section type. v1 has exactly these four sections
 * and each one has exactly one supported component version.
 */

export const DASHBOARD_SCHEMA = Object.freeze({
  name: "pe.investment-dashboard",
  version: 1,
});

export const DASHBOARD_SECTIONS = Object.freeze([
  Object.freeze({ type: "valuation-summary", version: 1, label: "估值结论" }),
  Object.freeze({ type: "version-change", version: 1, label: "版本变化" }),
  Object.freeze({ type: "sensitivity-matrix", version: 1, label: "敏感性" }),
  Object.freeze({ type: "falsification-panel", version: 1, label: "推翻条件" }),
]);

export const DASHBOARD_SECTION_TYPES = Object.freeze(
  DASHBOARD_SECTIONS.map((section) => section.type),
);

export function dashboardSectionSpec(type, version = 1) {
  return DASHBOARD_SECTIONS.find(
    (section) => section.type === type && section.version === Number(version),
  ) || null;
}
