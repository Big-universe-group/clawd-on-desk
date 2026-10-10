"use strict";

// Usage port adapter for codex: active quota source and/or the quota-strip
// icon key this agent supplies (src/quota/usage-collector.js,
// src/runtime/state/session-snapshot.js).

const { createCodexAppServerSource } = require("../quota-source");

module.exports = {
  quotaIconKey: "codexQuota",
  createQuotaSource: (deps) => createCodexAppServerSource(deps),
};
