"use strict";

// Process port adapter for cursor-agent: Windows process-chain identity
// consumed by src/core/server/windows-process-metadata.js.

module.exports = {
  // Windows B1a process-chain walk opt-in. Cursor's editor label is an
  // adapter-owned constant, not ancestry output, so it is kept even when the
  // authoritative walk finds no editor.
  windowsProcessChain: Object.freeze({
    agentNames: Object.freeze(["cursor.exe"]),
    extraTerminals: Object.freeze(["cursor.exe"]),
    editorFallback: "cursor",
  }),
};
