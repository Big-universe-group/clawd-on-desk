"use strict";

// Process port adapter for reasonix: Windows process-chain identity
// consumed by src/core/server/windows-process-metadata.js.

module.exports = {
  // Windows B1a process-chain walk opt-in: executable names that identify the agent.
  windowsProcessChain: Object.freeze({
    agentNames: Object.freeze(["reasonix.exe", "reasonix-desktop.exe", "reasonix-cli.exe"]),
  }),
};
