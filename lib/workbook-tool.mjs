/**
 * Pi custom tool: workbook_query.
 *
 * Kept outside server.mjs so the tool can be tested directly and reused by a
 * future RPC surface.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

export function workspaceRel(workspace, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("path is required"), { status: 400 });
  }
  let candidate = value.trim();
  // Tolerate the root label the model saw in older prompts.
  for (const prefix of ["agent-workspace/", "agent-workspace\\"]) {
    if (candidate.startsWith(prefix)) candidate = candidate.slice(prefix.length);
  }
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(workspace, candidate);
  if (absolute !== workspace && !absolute.startsWith(workspace + path.sep)) {
    throw Object.assign(new Error("path must stay inside the current project"), { status: 403 });
  }
  const rel = path.relative(workspace, absolute).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) {
    throw Object.assign(new Error("path must stay inside the current project"), { status: 403 });
  }
  return rel;
}

export function createWorkbookTool({ store, workbooks, workspace, onMaterial = () => {} }) {
  return {
    name: "workbook_query",
    label: "查询 Excel 模型",
    description:
      "查询当前项目里的 Excel 模型（.xlsx/.xlsm）：按中文或英文关键词、年份，或 Sheet!A1 返回相关单元格、公式、缓存值和上下游依赖。" +
      "只返回相关子图，不返回整表。问收入、毛利率、EBITDA、FCF、WACC、某年假设或“这个数从哪来”时优先使用。",
    promptSnippet: "workbook_query：查询 Excel 模型的单元格、公式和上下游依赖",
    promptGuidelines: [
      "查询 .xlsx/.xlsm 时优先用 workbook_query，不要用 read 直接读二进制，也不要临时写 python。",
      "结果里的数值是工作簿缓存值；回答时给出 Sheet!A1 引用，并提醒用户以 Excel 重算为准。",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "当前项目内的 .xlsx/.xlsm 路径，例如 uploads/foo.xlsx",
      }),
      query: Type.String({
        description: "中文/英文关键词、年份，或 Sheet!A1；例如“2026 收入”“毛利率”“DCF!D5”",
      }),
      maxCells: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 120,
          description: "返回的相关单元格上限，默认 40",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const rel = workspaceRel(workspace, params.path);
        let material = store.findMaterialByPath(rel);
        if (!material) {
          const absolute = path.join(workspace, rel);
          if (!fs.existsSync(absolute)) {
            throw Object.assign(new Error(`文件不存在：${rel}`), { status: 404 });
          }
          material = store.indexFile(rel, {
            source: "agent",
            author: "Workbench",
            note: "模型查询",
            status: "draft",
          });
          onMaterial(material);
        }

        const result = await workbooks.queryMaterial(material.id, params.query, {
          maxCells: params.maxCells,
        });
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            materialId: material.id,
            sha256: result.sha256,
            matchedCells: result.matchedCells,
            returned: result.returned,
          },
        };
      } catch (error) {
        const message = error?.message || String(error);
        return {
          content: [{ type: "text", text: `workbook_query 失败：${message}` }],
          details: { error: message, code: error?.code },
          isError: true,
        };
      }
    },
  };
}

export default createWorkbookTool;
