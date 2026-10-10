"use strict";

// Usage port adapter for claude-code: active quota source and/or the quota-strip
// icon key this agent supplies (src/quota/usage-collector.js,
// src/runtime/state/session-snapshot.js).

const { createClaudeOAuthSource } = require("../quota-source");

module.exports = {
  quotaIconKey: "claudeQuota",
  createQuotaSource: (deps) => createClaudeOAuthSource(deps),
};
