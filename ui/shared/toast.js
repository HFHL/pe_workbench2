/** Transient status message. */

let toastTimer;
export function toast(text) {
  const element = document.querySelector("#toast");
  if (!element) return;
  element.textContent = text;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 1600);
}
