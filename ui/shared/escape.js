/** Text and URL safety shared by every renderer. No HTML is accepted. */

export function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

/**
 * Only internal absolute paths and explicit http(s) URLs are allowed. Anything
 * else becomes a non-navigable "#".
 */
export function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "#";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch {
    /* not a URL */
  }
  return "#";
}

export function safeText(value, max = 400) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
