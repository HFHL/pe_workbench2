/**
 * Shared UI state.
 *
 * Reads go through getState(); writes should go through update()/actions. A set
 * trap still catches legacy direct assignments (and notifies subscribers) while
 * the old UI code is migrated, but modules should not rely on it.
 */

const target = {
  projects: [],
  project: { id: "product-eng", name: "Product Eng", note: "个人项目", accent: "slate" },
  activeSession: null,
  agentTransport: "legacy",
  filter: "all",
  pending: [],
  picked: new Set(),
  filesOpen: true,
  typing: false,
  openFileId: null,
  selectedVersion: null,
  openTaskId: null,
  files: [],
  tasks: [],
  sessions: [],
  notifications: [],
  approvals: [],
  messages: [],
  streaming: false,
  live: { text: "", tools: [], startedAt: 0 },
  es: null,
  globalEs: null,
  modelId: "deepseek-v4-pro",
  uploading: false,
  uploadTotal: 0,
  uploadIndex: 0,
};

const listeners = new Set();
let emitting = false;

function emit() {
  if (emitting) return;
  emitting = true;
  queueMicrotask(() => {
    emitting = false;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        /* a subscriber must not break rendering */
      }
    }
  });
}

export const state = new Proxy(target, {
  set(object, key, value) {
    if (Object.is(object[key], value)) return true;
    object[key] = value;
    emit();
    return true;
  },
  deleteProperty(object, key) {
    delete object[key];
    emit();
    return true;
  },
});

export const getState = () => state;

export function setState(patch = {}) {
  Object.assign(state, patch);
  return state;
}

export function update(mutator) {
  if (typeof mutator !== "function") throw new Error("update requires a function");
  mutator(state);
  emit();
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const selectors = {
  activeSession: () => state.sessions.find((session) => session.id === state.activeSession) || null,
  fileById: (id) => state.files.find((file) => file.id === id),
  taskById: (id) => state.tasks.find((task) => task.id === id),
  latest: (file) => file?.versions?.[0] || null,
  pendingApprovals: () => (state.approvals || []).filter((item) => item.status === "pending_approval"),
};

/**
 * Unified project-switch cleanup. Streams are closed by the caller before/after
 * this action; data belonging to the previous project is dropped here so a late
 * SSE event cannot repopulate the new project.
 */
export function resetForProject(project) {
  update((s) => {
    s.project = project;
    s.activeSession = null;
    s.sessions = [];
    s.messages = [];
    s.files = [];
    s.tasks = [];
    s.pending = [];
    s.picked = new Set();
    s.streaming = false;
    s.live = { text: "", tools: [], startedAt: 0 };
    s.notifications = [];
    s.approvals = [];
    s.filter = "all";
    s.openFileId = null;
    s.selectedVersion = null;
    s.openTaskId = null;
    s.typing = false;
  });
}
