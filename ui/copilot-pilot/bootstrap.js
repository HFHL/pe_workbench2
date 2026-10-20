/**
 * Pilot entry: installs the CopilotKit client over the existing workbench UI.
 *
 * The bundle is loaded only when `?agentTransport=copilotkit` or
 * `COPILOTKIT_CORE_EXPERIMENT=1` is set. It reuses the native modules for
 * state, rendering and the HTTP client; only @copilotkit/core is bundled.
 */

import { state } from "../state/store.js";
import { runtime } from "../runtime.js";
import { CopilotPilotClient } from "./client.js";

export const TRANSPORT = "copilotkit";

let controller = null;
let networkHandlers = null;

export function install() {
  if (controller) return controller;
  controller = new CopilotPilotClient();
  networkHandlers = {
    offline: () => controller?.handleOffline(),
    online: () => controller?.handleOnline(),
  };
  window.addEventListener("offline", networkHandlers.offline);
  window.addEventListener("online", networkHandlers.online);
  runtime.pilot = controller;
  window.__copilotPilot = controller;
  window.__peAgentTransport = TRANSPORT;
  document.documentElement.dataset.agentTransport = TRANSPORT;
  return controller;
}

export function uninstall() {
  if (!controller) return;
  controller.resetForProject();
  runtime.pilot = null;
  window.__copilotPilot = null;
  if (networkHandlers) {
    window.removeEventListener("offline", networkHandlers.offline);
    window.removeEventListener("online", networkHandlers.online);
    networkHandlers = null;
  }
  state.agentTransport = "legacy";
  delete window.__peAgentTransport;
  delete document.documentElement.dataset.agentTransport;
  controller = null;
}
