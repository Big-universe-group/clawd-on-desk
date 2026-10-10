"use strict";

// Ingest port adapter for WorkBuddy.

const { isLocalIdleConversation } = require("../../../runtime/state/stale-cleanup");

module.exports = {
  // Stateful main-process runtime (session titles, archive retirement) owned by runtime-main.
  createMainRuntime(services) {
    return require("../main-runtime").createWorkBuddyMainRuntime(services);
  },

  // Outcome for a session past the idle-age cutoff, or null for the generic
  // rules. WorkBuddy emits Stop when a turn finishes (stored as idle) but never
  // emits SessionEnd, and archiving or deleting a conversation sends no event
  // either. On Windows agent_pid is the long-lived main process, so a live
  // process cannot vouch for an individual finished conversation forever —
  // apply the same configured idle cutoff used for Codex Desktop, ZCode, and
  // TraeCode. agent-exit still wins when WorkBuddy itself quits.
  staleIdleDecision(session) {
    return isLocalIdleConversation(session)
      ? { action: "delete", reason: "workbuddy-desktop-idle-timeout" }
      : null;
  },
};
