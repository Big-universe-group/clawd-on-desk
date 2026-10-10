"use strict";

// Process port adapter for codex: Windows process-chain identity and
// process-metadata preferences consumed by src/core/server/windows-process-metadata.js
// and src/core/server/route-state.js.

const { isCodexDesktopOriginator } = require("../../../../hooks/codex/codex-originator");

module.exports = {
  // Windows B1a process-chain walk opt-in: executable names that identify the agent.
  windowsProcessChain: Object.freeze({
    agentNames: Object.freeze(["codex.exe"]),
  }),
  // Codex Desktop multiplexes threads through one app process, so the focus
  // source is the agent process itself rather than the terminal ancestor.
  preferAgentPidInProcessChain: ({ codexOriginator } = {}) => isCodexDesktopOriginator(codexOriginator),
  // An authoritative SessionStart samples the foreground terminal window the
  // same way a prompt submit does.
  samplesTerminalOnSessionStart: true,
};
