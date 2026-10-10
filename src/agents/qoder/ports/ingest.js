"use strict";

// Ingest port adapter for Qoder.

module.exports = {
  // Stateful main-process runtime (session-title tracking) owned by runtime-main.
  createMainRuntime(services) {
    return require("../main-runtime").createQoderMainRuntime(services);
  },
};
