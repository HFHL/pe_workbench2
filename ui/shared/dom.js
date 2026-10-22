/** DOM lookup, escaping, icons and small formatting helpers. */

export { esc } from "./escape.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const win = $("#window");
export const overlay = $("#overlay");
export const taskOverlay = $("#taskOverlay");
export const projectOverlay = $("#projectOverlay");
export const threadEl = $("#thread");
export const fileListEl = $("#fileList");
export const attachmentsEl = $("#attachments");
export const inputEl = $("#input");
export const sendBtn = $("#sendBtn");
export const fileInput = $("#fileInput");

export const icon = (name, size = 16) =>
  `<svg class="i" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const HERO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 740">
<rect width="1200" height="740" fill="#F4F1EA"/>
<rect x="72" y="56" width="96" height="12" rx="6" fill="#DCD6C9"/>
<rect x="72" y="112" width="520" height="44" rx="8" fill="#E2DCCE"/>
<rect x="72" y="170" width="360" height="14" rx="7" fill="#DCD6C9"/>
<rect x="72" y="198" width="286" height="14" rx="7" fill="#E5E0D4"/>
<rect x="72" y="254" width="124" height="40" rx="6" fill="#1B1B19"/>
<rect x="208" y="254" width="124" height="40" rx="6" fill="none" stroke="#CBC4B4" stroke-width="1.5"/>
<rect x="748" y="96" width="380" height="318" rx="10" fill="#E9E3D6"/>
<circle cx="938" cy="255" r="86" fill="#F4F1EA"/>
<path d="M756 470h364M756 500h248" stroke="#DCD6C9" stroke-width="10" stroke-linecap="round"/>
<rect x="72" y="396" width="1056" height="1" fill="#D9D3C5"/>
<g fill="#E9E3D6"><rect x="72" y="444" width="330" height="218" rx="8"/><rect x="426" y="444" width="330" height="218" rx="8"/><rect x="780" y="444" width="348" height="218" rx="8"/></g>
<g fill="#F4F1EA"><rect x="96" y="470" width="52" height="52" rx="8"/><rect x="450" y="470" width="52" height="52" rx="8"/><rect x="804" y="470" width="52" height="52" rx="8"/><rect x="96" y="548" width="220" height="12" rx="6"/><rect x="450" y="548" width="220" height="12" rx="6"/><rect x="804" y="548" width="236" height="12" rx="6"/><rect x="96" y="574" width="150" height="12" rx="6"/><rect x="450" y="574" width="150" height="12" rx="6"/><rect x="804" y="574" width="168" height="12" rx="6"/></g>
</svg>`;
export const HERO_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(HERO)}`;

export const KINDS = {
  md: { icon: "file-text", tint: "blue", label: "Markdown" },
  markdown: { icon: "file-text", tint: "blue", label: "Markdown" },
  html: { icon: "code", tint: "yellow", label: "HTML" },
  txt: { icon: "file-text", tint: "blue", label: "文本" },
  pdf: { icon: "file-text", tint: "red", label: "PDF" },
  doc: { icon: "file-text", tint: "blue", label: "Word" },
  docx: { icon: "file-text", tint: "blue", label: "Word" },
  csv: { icon: "grid", tint: "green", label: "CSV" },
  xlsx: { icon: "grid", tint: "green", label: "Excel" },
  xlsm: { icon: "grid", tint: "green", label: "Excel (宏)" },
  xltx: { icon: "grid", tint: "green", label: "Excel 模板" },
  xltm: { icon: "grid", tint: "green", label: "Excel 模板" },
  xls: { icon: "grid", tint: "green", label: "Excel (旧版)" },
  json: { icon: "code", tint: "yellow", label: "JSON" },
  mp3: { icon: "audio", tint: "violet", label: "MP3 音频" },
  wav: { icon: "audio", tint: "violet", label: "WAV 音频" },
  m4a: { icon: "audio", tint: "violet", label: "M4A 音频" },
  aac: { icon: "audio", tint: "violet", label: "AAC 音频" },
  flac: { icon: "audio", tint: "violet", label: "FLAC 音频" },
  ogg: { icon: "audio", tint: "violet", label: "OGG 音频" },
  opus: { icon: "audio", tint: "violet", label: "OPUS 音频" },
  png: { icon: "file-image", tint: "blue", label: "PNG 图像" },
  jpg: { icon: "file-image", tint: "blue", label: "JPEG 图像" },
  jpeg: { icon: "file-image", tint: "blue", label: "JPEG 图像" },
  webp: { icon: "file-image", tint: "blue", label: "WebP 图像" },
  svg: { icon: "file-image", tint: "blue", label: "SVG" },
};
export const KIND_FALLBACK = { icon: "file-text", tint: "yellow", label: "文件" };
export const kindOf = (name) => KINDS[(name.split(".").pop() || "").toLowerCase()] || KIND_FALLBACK;
export const extOf = (name) => (name.split(".").pop() || "").toLowerCase();
export const AUDIO_PREVIEW = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"]);
export const RICH_PREVIEW = new Set(["md", "markdown", "xlsx", "xlsm", "xltx", "xltm", "pdf", ...AUDIO_PREVIEW]);
export const EXCEL_PREVIEW = new Set(["xlsx", "xlsm", "xltx", "xltm"]);
export const MAX_XLSX_FREEZE_ROWS = 8;
export const MAX_XLSX_FREEZE_COLS = 8;
export const XLSX_ZOOM_STEPS = [0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export const STATUS = {
  final: { label: "已定稿", tone: "ok" },
  live: { label: "更新中", tone: "live" },
  draft: { label: "草稿", tone: "warn" },
  synced: { label: "已同步", tone: "ok" },
  stale: { label: "待同步", tone: "warn" },
};
export const SOURCE = { upload: "本地上传", agent: "Workbench", task: "计划任务", import: "导入" };

export let uid = 0;
export const nextId = () => `f${Date.now().toString(36)}${(uid++).toString(36)}`;
export const nowHM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const formatSize = (bytes) => {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
export const shortTime = (at) => (at.includes(" ") ? at.split(" ").pop() : at);
export const formatInt = (value) => (Number.isFinite(value) ? value.toLocaleString("en-US") : "—");
export const isNarrow = () => window.matchMedia("(max-width: 980px)").matches;
