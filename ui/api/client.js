/** HTTP client. Every project-data request carries its project id. */

import { getState } from "../state/store.js";

export function withProject(url) {
  const id = getState().project?.id;
  if (!id) return url;
  return `${url}${url.includes("?") ? "&" : "?"}project=${encodeURIComponent(id)}`;
}

export async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(withProject(pathname), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || res.statusText || "request failed");
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", withProject("/api/upload"));
    xhr.timeout = 15 * 60 * 1000;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    let lastPct = -1;
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !event.total) return;
      const fraction = event.loaded / event.total;
      const pct = Math.round(fraction * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      onProgress?.(fraction);
    });
    xhr.addEventListener("load", () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `上传失败（HTTP ${xhr.status}）`));
    });
    xhr.addEventListener("error", () => reject(new Error("网络错误，上传中断")));
    xhr.addEventListener("timeout", () => reject(new Error("上传超时")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消")));
    xhr.send(file);
  });
}
