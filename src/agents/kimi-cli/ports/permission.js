"use strict";

// Permission port adapter for Kimi CLI.

module.exports = {
  // Releases state-side permission holds (passive-notification holds) when the
  // agent's permission bubbles are dismissed; truthy when anything was released.
  releaseStatePermissionHolds(stateRuntime) {
    if (!stateRuntime || typeof stateRuntime.disposeAllKimiPermissionState !== "function") return false;
    return stateRuntime.disposeAllKimiPermissionState();
  },
};
