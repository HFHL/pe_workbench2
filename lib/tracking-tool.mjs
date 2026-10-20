/**
 * Pi custom tool: create_tracking.
 *
 * Lets the user create a durable tracking task in natural language. The agent
 * parses "每周一 9 点" into the schedule fields and calls this tool; the host
 * validates the target, creates the tracking row, and activates monitor items
 * when the framework has an analysis-state.json.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  deriveMonitorPlan,
  normalizeMonitorItem,
  validateMonitorPlan,
} from "./monitoring.mjs";
import {
  TRACKING_TEMPLATES,
  normalizeSchedule,
  templateForFile,
} from "./tracking.mjs";

function normalizeTargetPath(workspace, input) {
  let value = String(input || "").trim().replace(/\\/g, "/");
  if (!value) return "";
  if (path.isAbsolute(value)) {
    const relative = path.relative(workspace, value).split(path.sep).join("/");
    return relative.startsWith("..") ? "" : relative;
  }
  const projectPrefix = `projects/${path.basename(workspace)}/`;
  if (value.startsWith(projectPrefix)) value = value.slice(projectPrefix.length);
  return value.replace(/^\.\//, "").replace(/^\/+/, "");
}

function failure(text) {
  return { content: [{ type: "text", text: `create_tracking 失败：${text}` }], isError: true };
}

function readState(workspace, relPath) {
  const stateRel = path.posix.join(path.posix.dirname(relPath), "analysis-state.json");
  const absolute = path.join(workspace, stateRel);
  if (!fs.existsSync(absolute)) return { stateRel, state: null };
  try {
    return { stateRel, state: JSON.parse(fs.readFileSync(absolute, "utf8")) };
  } catch {
    return { stateRel, state: null, error: "analysis-state.json 无法解析" };
  }
}

function westockSymbol(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(sh|sz|bj|hk|us|t|ks|kq|fu|fx|pt)/i.test(raw)) return raw.toLowerCase();
  const match = raw.match(/^(\d{6})\.(SS|SH|SZ|BJ)$/i);
  if (!match) return raw;
  const suffix = match[2].toUpperCase();
  const prefix = suffix === "SZ" || suffix === "BJ" ? suffix.toLowerCase() : "sh";
  return `${prefix}${match[1]}`;
}

export function createTrackingTool({
  store,
  workspace,
  onTracking = () => {},
  onMonitors = () => {},
} = {}) {
  return {
    name: "create_tracking",
    label: "建立跟踪任务",
    description:
      "为一个已存在的产出文件建立定时跟踪任务，并在有 analysis-state.json 时激活监测项。只有当用户明确要求“建立跟踪/定时跟踪/盯住这份报告”时才调用；信息不全时先问清楚目标文件和频率。",
    promptSnippet: "create_tracking：用自然语言建立定时跟踪任务",
    promptGuidelines: [
      "用户说“建立跟踪/每天看/每周盯/自动更新这份报告”时使用 create_tracking。",
      "targetPath 用项目内相对路径，例如 exports/investment-model/xxx/投资框架报告.md。",
      "频率从用户话里解析：每天/每周一/每月 1 日 + 时间；没说时间默认 09:00，没说频率默认每周一。",
      "有 analysis-state.json 时 activateMonitors=true，会自动把 falsifiers 变成监测项并建立来源轮询。",
      "建立后告诉用户下次运行时间、监测项数量和如何暂停。不要声称已经运行过一次。",
    ],
    parameters: Type.Object({
      targetPath: Type.String({
        description: "项目内的目标文件相对路径，如 exports/.../投资框架报告.md",
      }),
      freq: Type.Optional(Type.Union([
        Type.Literal("daily"),
        Type.Literal("weekly"),
        Type.Literal("monthly"),
      ], { description: "频率；默认 weekly" })),
      time: Type.Optional(Type.String({
        pattern: "^\\d{2}:\\d{2}$",
        description: "本地时间 HH:mm，默认 09:00",
      })),
      weekday: Type.Optional(Type.Number({
        minimum: 1,
        maximum: 7,
        description: "每周几，1=周一 … 7=周日；仅 freq=weekly 时使用",
      })),
      day: Type.Optional(Type.Number({
        minimum: 1,
        maximum: 28,
        description: "每月几号；仅 freq=monthly 时使用",
      })),
      template: Type.Optional(Type.Union([
        Type.Literal("framework"),
        Type.Literal("model"),
        Type.Literal("generic"),
      ], { description: "更新模板；默认按文件扩展名匹配" })),
      activateMonitors: Type.Optional(Type.Boolean({
        description: "是否把 analysis-state.json 里的 falsifiers 激活成监测项，默认 true",
      })),
      name: Type.Optional(Type.String({ description: "跟踪名称，默认用文件名" })),
    }),
    execute: async (_toolCallId, params = {}) => {
      const rel = normalizeTargetPath(workspace, params.targetPath);
      if (!rel) return failure("targetPath 不能为空，且必须在当前项目内");
      const target = store.findMaterialByPath(rel);
      if (!target) {
        return failure(`找不到文件 ${rel}；请确认它已经在右栏资料中（可以先上传或让 Agent 写入）`);
      }
      const existing = store.findTrackingByTarget(target.id);
      if (existing) {
        const dto = store.getTracking(existing.id);
        return {
          content: [{
            type: "text",
            text: `这个文件已经有跟踪了：${dto.targetName} · ${dto.scheduleLabel} · 下次 ${dto.nextRunLabel || "—"}（id ${dto.id}）。如需调整，请在跟踪详情里改时间，或先删除旧跟踪。`,
          }],
          details: { existing: dto },
        };
      }

      const templateId = TRACKING_TEMPLATES[params.template] ? params.template : templateForFile(target.name);
      if (TRACKING_TEMPLATES[templateId].writeMode === "in_place" && !rel.startsWith("exports/")) {
        return failure("原位更新只能跟踪 exports/ 下的产出文件；uploads/ 和 inputs/ 是只读的");
      }

      const schedule = normalizeSchedule({
        freq: params.freq || "weekly",
        time: params.time || "09:00",
        weekday: params.weekday || 1,
        day: params.day || 1,
      });
      let tracking;
      try {
        tracking = store.createTracking({
          targetId: target.id,
          templateId,
          ...schedule,
          name: String(params.name || "").trim() || undefined,
        });
      } catch (error) {
        return failure(error.message || "无法创建跟踪");
      }
      onTracking(tracking);

      const monitorNotes = [];
      if (params.activateMonitors !== false) {
        const { stateRel, state, error } = readState(workspace, rel);
        if (error) {
          monitorNotes.push(`未激活监测项：${error}`);
        } else if (!state) {
          monitorNotes.push(`没有 ${stateRel}，只建立定时更新，不激活逐条监测`);
        } else {
          const plan = deriveMonitorPlan(state, {
            trackingId: tracking.id,
            targetPath: rel,
            now: new Date(),
          });
          const items = plan.items.map((item, index) => normalizeMonitorItem(item, {
            index,
            trackingId: tracking.id,
          }));
          const errors = validateMonitorPlan({ items });
          if (errors.length) {
            monitorNotes.push(`监测方案校验失败：${errors.slice(0, 3).join("；")}`);
          } else if (items.length) {
            const saved = store.replaceMonitorItems(tracking.id, items);
            onMonitors(tracking.id, saved);
            monitorNotes.push(`已激活 ${saved.length} 个监测项`);
            const company = state?.subject?.company || "";
            const security = state?.subject?.security || "";
            const query = [company, security, "公告 财报 新闻 行业"].filter(Boolean).join(" ").trim();
            const bindings = [];
            if (query) {
              bindings.push({
                adapter: "anysearch",
                query,
                sourceTier: 3,
                intervalMinutes: 360,
                nextPollAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
              });
            }
            const westock = westockSymbol(security);
            if (westock) {
              bindings.push({
                adapter: "westock",
                query: westock,
                sourceTier: 1,
                intervalMinutes: 720,
                nextPollAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              });
            }
            if (bindings.length) store.replaceSourceBindings(tracking.id, bindings);
          } else {
            monitorNotes.push("analysis-state.json 里没有可激活的 falsifiers");
          }
        }
      }

      const dto = store.getTracking(tracking.id);
      const lines = [
        `已建立跟踪：${dto.targetName}`,
        `频率：${dto.scheduleLabel}`,
        `下次运行：${dto.nextRunLabel || "—"}`,
        `模板：${templateId}`,
        ...monitorNotes,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { tracking: dto },
      };
    },
  };
}

export default createTrackingTool;
