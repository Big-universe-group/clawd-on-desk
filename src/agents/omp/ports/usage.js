"use strict";

// Usage port adapter for omp: active quota source and/or the quota-strip
// icon key this agent supplies (src/quota/usage-collector.js,
// src/runtime/state/session-snapshot.js).

const { createOmpUsageSource } = require("../quota-source");

module.exports = {
  createQuotaSource: (deps) => createOmpUsageSource(deps),
};
