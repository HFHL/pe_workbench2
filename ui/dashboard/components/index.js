import { registerDashboardComponent } from "../registry.js";
import falsificationPanel from "./falsification-panel.js";
import sensitivityMatrix from "./sensitivity-matrix.js";
import valuationSummary from "./valuation-summary.js";
import versionChange from "./version-change.js";

let registered = false;

export function registerDashboardComponents() {
  if (registered) return;
  registered = true;
  registerDashboardComponent(valuationSummary);
  registerDashboardComponent(versionChange);
  registerDashboardComponent(sensitivityMatrix);
  registerDashboardComponent(falsificationPanel);
}

export {
  falsificationPanel,
  sensitivityMatrix,
  valuationSummary,
  versionChange,
};
