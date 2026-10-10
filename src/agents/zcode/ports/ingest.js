"use strict";

// Ingest port adapter for ZCode.

const { isLocalIdleConversation } = require("../../../runtime/state/stale-cleanup");

module.exports = {
  // Outcome for a session past the idle-age cutoff, or null for the generic
  // rules. ZCode desktop conversations have no SessionEnd event and can share
  // the app's long-lived app-server PID. Once source_pid is correctly anchored
  // to ZCode.exe, process liveness alone cannot retire an individual closed
  // conversation, so apply the same configured idle cutoff as Codex Desktop.
  staleIdleDecision(session) {
    return isLocalIdleConversation(session)
      ? { action: "delete", reason: "zcode-desktop-idle-timeout" }
      : null;
  },
};
