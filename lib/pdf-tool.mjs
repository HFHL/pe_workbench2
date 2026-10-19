/**
 * Pi custom tool: pdf_read.
 *
 * A PDF is binary to the built-in `read` tool, so the agent gets 50 KB of
 * mojibake instead of prose. This tool mirrors workbook_query: default call
 * returns the document map, then the agent reads page ranges or searches.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { workspaceRel } from "./workbook-tool.mjs";

const MODES = ["auto", "outline", "pages", "search", "tables"];

export function createPdfTool({ store, pdfs, workspace, onMaterial = () => {} }) {
  return {
    name: "pdf_read",
    label: "读取 PDF",
    description:
      "读取当前项目里的 PDF（.pdf）：默认返回页数、章节和每页摘要；可用 page 读指定页正文，或用 query 检索并返回带页码的片段。" +
      "适用于访谈纪要、研报、公告、招股书、合同等。不要用 read 直接读 PDF，也不要临时写 python。",
    promptSnippet: "pdf_read：读取 PDF 的章节、指定页正文或检索片段（带页码）",
    promptGuidelines: [
      "读取 .pdf 时使用 pdf_read：先不传参数拿到章节与页概览，再用 page 或 query 精读，避免一次读完整份文档。",
      "引用 PDF 内容时标注页码（p.N），不要把检索片段当成完整上下文。",
      "遇到无文字页（scanned）说明是图片/扫描页，pdf_read 读不到正文，应告知用户需要 OCR。",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "当前项目内的 .pdf 路径，例如 uploads/1700000000000-report.pdf",
      }),
      query: Type.Optional(
        Type.String({
          description: "在 PDF 中检索的关键词或短语，例如“HBM4 带宽”“毛利率”“风险因素”",
        }),
      ),
      page: Type.Optional(
        Type.String({
          description: '页码或范围，例如 "3"、"2-4"、"1,5-6"；配合 mode="pages" 或 "tables" 使用',
        }),
      ),
      mode: Type.Optional(
        Type.Union(MODES.map((mode) => Type.Literal(mode)), {
          description:
            "outline=章节与页概览（默认）；pages=读正文；search=检索；tables=提取表格（需 page）；auto=按参数推断",
        }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: 40000,
          description: "pages 模式的输出字符上限，默认 12000",
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
            note: "PDF 读取",
            status: "draft",
          });
          onMaterial(material);
        }

        const mode = resolveMode(params);
        const pageSpec = typeof params.page === "string" ? params.page.trim() : "";
        let result;
        if (mode === "outline") {
          result = await pdfs.outline(material.id);
        } else if (mode === "search") {
          if (!String(params.query || "").trim()) {
            throw Object.assign(new Error("search 模式需要 query"), { status: 400, code: "query_required" });
          }
          result = await pdfs.search(material.id, params.query, {
            maxSnippets: 6,
          });
        } else if (mode === "tables") {
          if (!pageSpec) {
            throw Object.assign(new Error("tables 模式需要 page，例如 2-4"), {
              status: 400,
              code: "page_required",
            });
          }
          result = await pdfs.tables(material.id, pageSpec);
        } else {
          result = await pdfs.readPages(material.id, pageSpec, {
            maxChars: params.maxChars,
          });
        }

        return {
          content: [{ type: "text", text: result.text }],
          details: {
            materialId: material.id,
            sha256: result.sha256,
            mode,
            pages: result.pages ?? result.requested ?? [],
            hits: result.hits?.length ?? 0,
            truncated: !!result.truncated,
          },
        };
      } catch (error) {
        const message = error?.message || String(error);
        return {
          content: [{ type: "text", text: `pdf_read 失败：${message}` }],
          details: { error: message, code: error?.code },
          isError: true,
        };
      }
    },
  };
}

function resolveMode(params) {
  if (params.mode && params.mode !== "auto") return params.mode;
  if (String(params.query || "").trim()) return "search";
  if (String(params.page || "").trim()) return "pages";
  return "outline";
}

export default createPdfTool;
