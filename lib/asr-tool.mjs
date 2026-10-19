/**
 * Pi custom tool: asr_read.
 *
 * Audio is binary to the built-in `read` tool and the useful content lives in
 * the workbench's ASR cache, not in the file. This tool gives the agent the
 * transcript (or SRT / a compact summary) without exposing the remote URL or
 * the API key.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { workspaceRel } from "./workbook-tool.mjs";
import { extOf, isAsrExt } from "./asr-status.mjs";

const MODES = ["auto", "transcript", "srt", "summary"];
const MAX_CHARS = 60_000;

function clip(text, max) {
  const value = String(text || "");
  if (value.length <= max) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, max)}\n\n[已截断：全文 ${value.length} 字符，仅保留前 ${max} 字符]`,
    truncated: true,
  };
}

function summaryText(dto) {
  const lines = [
    `音频：${dto.name}`,
    `转写状态：${dto.label}（${dto.status}）`,
    `版本：v${dto.version} · 结果：${dto.chars.toLocaleString("en-US")} 字${dto.hasSrt ? " · 有 SRT" : ""}`,
  ];
  if (dto.detail) lines.push(`服务信息：${dto.detail}`);
  if (dto.error) lines.push(`错误：${dto.error}`);
  if (dto.content) {
    const preview = dto.content.replace(/\s+/g, " ").slice(0, 400);
    lines.push(`开头：${preview}${dto.content.length > 400 ? "…" : ""}`);
  }
  return lines.join("\n");
}

export function createAsrTool({ store, asr, workspace, onMaterial = () => {} }) {
  return {
    name: "asr_read",
    label: "读取音频转写",
    description:
      "读取当前项目里 .mp3 / .wav 音频的语音转写结果：默认返回全文，也可以只拿 SRT 字幕或转写状态摘要。" +
      "上传后的音频会自动在后台转写；转写未完成时返回当前状态，不要用 read 直接读音频二进制。",
    promptSnippet: "asr_read：读取音频的转写全文、SRT 或转写状态",
    promptGuidelines: [
      "读取 .mp3/.wav 时使用 asr_read；音频是二进制，read 读不到内容。",
      "转写未完成时，先告知用户当前状态与进度，不要猜测音频内容。",
      "引用转写内容时保留说话顺序；有 SRT 时可以引用时间码。",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "当前项目内的音频路径，例如 uploads/1700000000000-meeting.mp3",
      }),
      mode: Type.Optional(
        Type.Union(MODES.map((mode) => Type.Literal(mode)), {
          description: "auto=全文（默认）；transcript=全文；srt=字幕；summary=状态与开头",
        }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: MAX_CHARS,
          description: "输出字符上限，默认 30000",
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
            note: "音频读取",
            status: "draft",
          });
          onMaterial(material);
        }

        const ext = extOf(rel);
        if (!isAsrExt(ext)) {
          throw Object.assign(
            new Error(`asr_read 只支持 MP3 / WAV；当前是 .${ext || "?"}。其他音频格式仍可在预览中播放。`),
            { status: 422, code: "asr_unsupported" },
          );
        }
        if (!asr) {
          throw Object.assign(new Error("语音转写服务未启用（ASR=0）"), {
            status: 404,
            code: "asr_disabled",
          });
        }

        const dto = asr.get(material.id);
        if (dto.status !== "done") {
          const text = [
            `音频 \`${rel}\` 还没有可读的转写文本。`,
            `当前状态：${dto.label}（${dto.status}，${dto.progress}%）`,
            dto.error ? `错误：${dto.error}` : "",
            dto.active
              ? "后台仍在转写。请先回复用户当前进度；稍后再调用 asr_read 读取全文。"
              : dto.canStart
                ? "还没有开始转写。请在文件预览中点击“开始转写”，或在界面里重试。"
                : dto.configured
                  ? "当前无法开始转写。"
                  : "还没有配置 ASR_API_KEY，转写不可用。",
          ].filter(Boolean).join("\n");
          return {
            content: [{ type: "text", text }],
            details: {
              materialId: material.id,
              status: dto.status,
              progress: dto.progress,
              pending: dto.active,
              configured: dto.configured,
            },
          };
        }

        const mode = MODES.includes(params.mode) && params.mode !== "auto"
          ? params.mode
          : "transcript";
        const maxChars = Math.min(MAX_CHARS, Math.max(1000, Number(params.maxChars) || 30_000));
        let text;
        if (mode === "summary") {
          text = summaryText(dto);
        } else if (mode === "srt") {
          text = dto.srt || "这次转写没有生成 SRT 字幕。";
        } else {
          text = dto.content || "转写完成，但没有识别到文字。";
        }
        const clipped = clip(text, maxChars);
        return {
          content: [{ type: "text", text: clipped.text }],
          details: {
            materialId: material.id,
            status: dto.status,
            mode,
            chars: dto.chars,
            hasSrt: dto.hasSrt,
            truncated: clipped.truncated,
          },
        };
      } catch (error) {
        const message = error?.message || String(error);
        return {
          content: [{ type: "text", text: `asr_read 失败：${message}` }],
          details: { error: message, code: error?.code },
          isError: true,
        };
      }
    },
  };
}

export default createAsrTool;
