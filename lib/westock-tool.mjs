/**
 * Pi custom tool: westock_query.
 *
 * Wraps the WeStock CLI with execFile (no shell, no string interpolation) so
 * the agent can query market data from the sandboxed Workbench runtime. The
 * CLI returns Markdown tables; this tool passes that text through unchanged.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 120_000;

function resolveBinary(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`WESTOCK_BIN 指向的文件不存在：${explicit}`);
    }
    return explicit;
  }
  const home = process.env.HOME || os.homedir();
  const candidates = [
    process.env.WESTOCK_BIN,
    path.join(home, ".local", "bin", "westock"),
    "/opt/homebrew/bin/westock",
    "/usr/local/bin/westock",
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      "未找到 westock CLI。请先安装（scripts/setup.sh、setup.ps1 或 setup.cjs），或用 WESTOCK_BIN 指定路径。",
    );
  }
  return found;
}

function normalizedArgs(raw) {
  const args = (Array.isArray(raw) ? raw : [])
    .map((value) => String(value))
    .filter((value) => value.length > 0);
  if (args.length === 0) {
    throw new Error("args 不能为空；第一个元素是 westock 子命令，例如 [\"quote\",\"sh600519\"]");
  }
  if (args.length > 24) {
    throw new Error("args 最多 24 项");
  }
  if (args.some((value) => value.includes("\u0000"))) {
    throw new Error("args 含非法字符");
  }
  // Allow callers that accidentally include the program name.
  if (args[0] === "westock") args.shift();
  const helpLike = new Set(["--help", "-h", "--version", "-v"]);
  if (args.length === 0 || (args[0].startsWith("-") && !helpLike.has(args[0]))) {
    throw new Error("args 第一项必须是 westock 子命令（或 --help/--version），不能是其它选项");
  }
  return args;
}

function clipped(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[输出已截断：原长 ${text.length} 字符，仅保留前 ${MAX_OUTPUT_CHARS} 字符]`,
    truncated: true,
  };
}

export function createWestockTool({ workspace, bin } = {}) {
  let binary;
  let binaryError;
  try {
    binary = resolveBinary(bin);
  } catch (error) {
    binaryError = error.message;
  }

  return {
    name: "westock_query",
    label: "查询金融市场数据",
    description:
      "调用 WeStock CLI 查询结构化金融数据：A/港/美/日韩股行情、K 线、财报、研报、新闻、公告、股东、分红、ETF、指数、板块、期货、外汇、可转债、资金流、龙虎榜和宏观数据。" +
      "args 直接传给 westock 子命令，不经过 shell；返回 CLI 的 Markdown 表格原文。",
    promptSnippet: "westock_query：查询行情、财报、研报、公告、资金和宏观数据",
    promptGuidelines: [
      "查询金融数据时优先使用 westock_query，不要用 web_search、HTTP 直连或训练数据替代。",
      "args 是字符串数组，第一项为子命令：[\"quote\",\"sh600519\"]、[\"finance\",\"sh600519,sz000651\",\"--limit\",\"4\"]。",
      "股票代码必须带市场前缀（sh/sz/bj/hk/us/t/ks/kq/fu/fx/pt）；多股批量把代码用逗号放在同一个参数里。",
      "工具返回的是 Markdown 表格原文；聊天回复遵守工作台格式（不使用表格），需要完整表格时写入 exports/。",
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 24,
        description:
          "westock 子命令及参数，例如 [\"quote\",\"sh600519\"] 或 [\"finance\",\"sh600519,sz000651\",\"--limit\",\"4\"]",
      }),
      timeoutMs: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: MAX_TIMEOUT_MS,
          description: "超时毫秒，默认 30000，最大 60000",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const started = Date.now();
      let args;
      try {
        if (!binary) throw new Error(binaryError || "westock CLI 不可用");
        args = normalizedArgs(params?.args);
      } catch (error) {
        return {
          content: [{ type: "text", text: `westock_query 失败：${error.message}` }],
          details: { error: error.message },
          isError: true,
        };
      }

      const timeoutMs = Math.min(
        Math.max(Number(params?.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS,
      );

      try {
        const { stdout = "", stderr = "" } = await execFileAsync(binary, args, {
          cwd: workspace,
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            PATH: `${path.dirname(binary)}:${process.env.PATH || ""}`,
            NO_COLOR: "1",
          },
        });
        const raw = stdout.trim();
        const err = stderr.trim();
        const { text, truncated } = clipped(
          [raw || "westock 返回空结果。", err ? `\n\n[stderr]\n${err}` : ""].join(""),
        );
        return {
          content: [{ type: "text", text }],
          details: {
            args,
            bin: binary,
            durationMs: Date.now() - started,
            truncated,
          },
        };
      } catch (error) {
        const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
        const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
        const reason = error?.killed
          ? `westock 执行超时（${timeoutMs}ms）`
          : stderr || error?.message || String(error);
        const { text } = clipped(
          [`westock_query 失败：${reason}`, stdout ? `\n\n[stdout]\n${stdout}` : ""].join(""),
        );
        return {
          content: [{ type: "text", text }],
          details: {
            args,
            bin: binary,
            durationMs: Date.now() - started,
            code: error?.code,
            signal: error?.signal,
            killed: Boolean(error?.killed),
          },
          isError: true,
        };
      }
    },
  };
}

export default createWestockTool;
