"use strict";

// Process port adapter for codebuddy: Windows process-chain identity
// consumed by src/core/server/windows-process-metadata.js.

module.exports = {
  // Windows B1a process-chain walk opt-in. The CodeBuddy app is both its own
  // terminal and its own editor label in the ancestry walk.
  windowsProcessChain: Object.freeze({
    agentNames: Object.freeze(["codebuddy.exe"]),
    extraTerminals: Object.freeze(["codebuddy.exe"]),
    extraEditors: Object.freeze({ "codebuddy.exe": "codebuddy" }),
  }),
};
