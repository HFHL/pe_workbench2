/**
 * Canonical ASR (speech-to-text) vocabulary.
 *
 * The server is the single source of truth for status labels, tones and
 * progress. Every surface (file card, dialog metadata, audio preview, SSE and
 * the agent tool) reads the same DTO, so the wording never drifts between
 * places. The browser keeps only a tiny fallback map for defensive rendering.
 */

/** Audio formats the preview can play in the browser. */
export const AUDIO_EXTS = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
]);

/** Formats accepted by the 17zhiling ASR endpoint (mp3 / wav only). */
export const ASR_EXTS = new Set(["mp3", "wav"]);

export const ASR_STATES = Object.freeze({
  idle: {
    label: "未转写",
    tone: "neutral",
    progress: 0,
    active: false,
    terminal: false,
    hint: "还没有开始转写。",
  },
  queued: {
    label: "排队中",
    tone: "live",
    progress: 8,
    active: true,
    terminal: false,
    hint: "已进入后台队列，马上开始。",
  },
  preparing: {
    label: "准备中",
    tone: "live",
    progress: 14,
    active: true,
    terminal: false,
    hint: "正在读取音频并申请上传地址。",
  },
  uploading: {
    label: "上传音频",
    tone: "live",
    progress: 28,
    active: true,
    terminal: false,
    hint: "正在把音频上传到转写服务。",
  },
  submitting: {
    label: "提交任务",
    tone: "live",
    progress: 44,
    active: true,
    terminal: false,
    hint: "正在向转写服务提交任务。",
  },
  waiting: {
    label: "等待处理",
    tone: "live",
    progress: 55,
    active: true,
    terminal: false,
    hint: "任务已提交，等待转写服务开始处理。",
  },
  processing: {
    label: "转写中",
    tone: "live",
    progress: 72,
    active: true,
    terminal: false,
    hint: "正在识别语音，通常需要几十秒到几分钟。",
  },
  done: {
    label: "已转写",
    tone: "ok",
    progress: 100,
    active: false,
    terminal: true,
    hint: "转写完成。",
  },
  failed: {
    label: "转写失败",
    tone: "bad",
    progress: 100,
    active: false,
    terminal: true,
    hint: "转写失败，可以重试。",
  },
  unconfigured: {
    label: "未配置密钥",
    tone: "warn",
    progress: 0,
    active: false,
    terminal: false,
    hint: "需要在 .env.local 配置 ASR_API_KEY。",
  },
  paused: {
    label: "已暂停",
    tone: "warn",
    progress: 0,
    active: false,
    terminal: false,
    hint: "轮询已暂停，恢复后会继续查询原任务。",
  },
  unsupported: {
    label: "不支持转写",
    tone: "neutral",
    progress: 0,
    active: false,
    terminal: true,
    hint: "ASR 接口只支持 MP3 / WAV；其它音频仍可播放。",
  },
  disabled: {
    label: "转写未启用",
    tone: "neutral",
    progress: 0,
    active: false,
    terminal: true,
    hint: "服务端关闭了语音转写（ASR=0）。",
  },
});

export function extOf(value) {
  return (String(value || "").split(".").pop() || "").toLowerCase();
}

export function isAudioExt(ext) {
  return AUDIO_EXTS.has(String(ext || "").toLowerCase());
}

export function isAsrExt(ext) {
  return ASR_EXTS.has(String(ext || "").toLowerCase());
}

export function asrMeta(status) {
  return ASR_STATES[status] || ASR_STATES.idle;
}

/**
 * Normalize a DB row (snake_case) into the public, camelCase ASR DTO.
 * `content` is intentionally omitted here: list endpoints and SSE should stay
 * small. Use `content: true` only for the per-version transcript endpoint.
 */
export function asrDto(row, { configured = false, supported = true, content = false } = {}) {
  const state = asrMeta(row?.status || (supported ? (configured ? "idle" : "unconfigured") : "unsupported"));
  const text = row?.content || "";
  const srt = row?.srt_content || "";
  const dto = {
    provider: "17zhiling",
    supported,
    configured,
    status: supported ? (row?.status || (configured ? "idle" : "unconfigured")) : "unsupported",
    label: state.label,
    tone: state.tone,
    progress: state.progress,
    active: state.active,
    terminal: state.terminal,
    hint: state.hint,
    version: row?.version ?? null,
    sha256: row?.blob_sha256 || null,
    taskId: row?.task_id || null,
    detail: row?.detail || null,
    error: row?.error || null,
    chars: [...text].length,
    hasContent: text.length > 0,
    hasSrt: srt.length > 0,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
    submittedAt: row?.submitted_at || null,
    finishedAt: row?.finished_at || null,
    nextPollAt: row?.next_poll_at || null,
    canStart: supported && (configured ? ["idle", "unconfigured", "failed", "paused"].includes(dtoStatus(row, supported, configured)) : false),
    canRetry: supported && configured && ["failed", "paused"].includes(dtoStatus(row, supported, configured)),
  };
  if (content) {
    dto.content = text;
    dto.srt = srt;
  }
  return dto;
}

function dtoStatus(row, supported, configured) {
  if (!supported) return "unsupported";
  return row?.status || (configured ? "idle" : "unconfigured");
}

export default {
  AUDIO_EXTS,
  ASR_EXTS,
  ASR_STATES,
  extOf,
  isAudioExt,
  isAsrExt,
  asrMeta,
  asrDto,
};
