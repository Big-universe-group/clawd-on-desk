"use strict";

// Ingest port adapter for OpenCode.

const { isWorkingLikeState } = require("../../../runtime/state/stale-cleanup");

// Minimum silence allowance for a local OpenCode tool call.
const LOCAL_WORKING_STALE_FLOOR_MS = 20 * 60 * 1000;

module.exports = {
  LOCAL_WORKING_STALE_FLOOR_MS,

  // Working-state silence timeout for this session, or undefined for the
  // generic one. OpenCode tools can run silently for many minutes (for
  // example, a long shell command). Keep the same bounded stale guard used for
  // local Codex instead of letting the generic five-minute working timeout
  // release the sleep blocker during a legitimate tool call.
  staleWorkingTimeoutMs(session, { workingStaleMs, staleConfig } = {}) {
    if (!session || session.host || session.headless || !isWorkingLikeState(session.state)) {
      return undefined;
    }
    const config = staleConfig || {};
    const floor = (
      Number.isFinite(config.opencodeLocalWorkingStaleFloorMs)
      && config.opencodeLocalWorkingStaleFloorMs > 0
    )
      ? config.opencodeLocalWorkingStaleFloorMs
      : LOCAL_WORKING_STALE_FLOOR_MS;
    return Math.max(workingStaleMs, floor);
  },
};
