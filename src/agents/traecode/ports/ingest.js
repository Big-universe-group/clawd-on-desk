"use strict";

// Ingest port adapter for TraeCode.

const { isLocalIdleConversation } = require("../../../runtime/state/stale-cleanup");

module.exports = {
  // Outcome for a session past the idle-age cutoff, or null for the generic
  // rules. TraeCode conversations have no SessionEnd event and share the IDE's
  // long-lived process. A live IDE process therefore cannot keep an individual
  // closed conversation alive forever — apply the same configured idle cutoff
  // used for Codex Desktop and ZCode.
  staleIdleDecision(session) {
    return isLocalIdleConversation(session)
      ? { action: "delete", reason: "traecode-desktop-idle-timeout" }
      : null;
  },
};
