"use strict";

// Qoder main-process ingest runtime: resolves local session titles from the
// transcript and keeps hook-provided titles authoritative. Instantiated once
// per src/agents/runtime-main.js through the Qoder ingest port
// (ports/ingest.js createMainRuntime).

const { createQoderSessionTitleTracker, QODER_TITLE_EVENTS } = require("./session-title");

const AGENT_ID = "qoder";

// `services` is the runtime-main kernel surface (see codex/main-runtime.js).
// `options` may inject qoderSessionTitleTracker.
function createQoderMainRuntime(services) {
  const { options, getStateRuntime, isAgentEnabled, isDisposed } = services;
  const qoderSessionTitleTracker = options.qoderSessionTitleTracker
    || createQoderSessionTitleTracker();

  function localQoderSession(sessionId) {
    if (isDisposed() || !isAgentEnabled(AGENT_ID)) return null;
    const state = getStateRuntime();
    const session = state && state.sessions && state.sessions.get(sessionId);
    return session && session.agentId === AGENT_ID
      && (session.profileId || "local") === "local"
      && !session.host && !session.wslDistro ? session : null;
  }

  function noteQoderExternalTitle(sessionId, title) {
    const session = localQoderSession(sessionId);
    if (!session || !title) return;
    qoderSessionTitleTracker.noteExternalTitle(session.rawSessionId || sessionId, title);
  }

  function enrichQoderSessionTitle(sessionId, event, opts) {
    if (opts.agentId !== AGENT_ID || (opts.profileId || "local") !== "local"
      || opts.host || opts.wslDistro) return;
    const session = localQoderSession(sessionId);
    const rawSessionId = (session && session.rawSessionId) || opts.rawSessionId || sessionId;
    // A new lifecycle must invalidate work from an earlier --resume of this id.
    if (event === "SessionStart" || event === "SessionEnd") {
      qoderSessionTitleTracker.clear(rawSessionId, { preserveExternalTitle: event === "SessionStart" });
    }
    if (event === "SessionEnd") return;
    if (!session) return;
    if (opts.sessionTitle) {
      noteQoderExternalTitle(sessionId, opts.sessionTitle);
      return;
    }
    if (!QODER_TITLE_EVENTS.has(event) || !session.transcriptPath) return;
    const transcriptPath = session.transcriptPath;
    // Lifecycle acceptance is already complete. This result only annotates a
    // surviving local session and must not refresh activity or replay an event.
    qoderSessionTitleTracker.resolve({ event, sessionId: rawSessionId, transcriptPath }).then((title) => {
      const live = localQoderSession(sessionId);
      if (!title || !live || live.transcriptPath !== transcriptPath
        || qoderSessionTitleTracker.getTitle(rawSessionId) !== title) return;
      const state = getStateRuntime();
      if (state && typeof state.updateSessionMetadata === "function") {
        state.updateSessionMetadata(sessionId, { sessionTitle: title });
      }
    }).catch(() => {});
  }

  function clearTracker() {
    if (qoderSessionTitleTracker && typeof qoderSessionTitleTracker.clear === "function") {
      qoderSessionTitleTracker.clear();
    }
  }

  return {
    onSessionUpdated(sessionId, state, event, opts = {}) {
      enrichQoderSessionTitle(sessionId, event, opts);
    },
    // An accepted metadata update may carry a hook-provided title.
    onSessionMetadataUpdated(sessionId, opts = {}) {
      noteQoderExternalTitle(sessionId, opts.sessionTitle);
    },
    clearSessions: clearTracker,
    dispose: clearTracker,
  };
}

module.exports = { createQoderMainRuntime };
