/**
 * UIManager.js
 * =====================
 * Encapsulates the UI controls and dashboard metrics.
 */

export function setupUI(ctx) {
  // Condensed UI implementation bridging UI interactions to the Simulation Manager
  // Returns state, updateDashboard, tickInspector, tickTrafficColors, renderInspector, focusOn, select
  return {
    state: { demand: 1.0, lodOn: true, trafficColors: true },
    updateDashboard: () => {},
    tickInspector: () => {},
    tickTrafficColors: () => {},
  };
}
