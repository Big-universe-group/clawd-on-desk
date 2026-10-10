"use strict";

// WorkBuddy main-process ingest runtime: local session-title tracker and the
// archive/delete retirement (#655) that gates late lifecycle hooks.
// Instantiated once per src/agents/runtime-main.js through the WorkBuddy
// ingest port (ports/ingest.js createMainRuntime).

const { createWorkBuddySessionTitleTracker } = require("./session-title");

const AGENT_ID = "workbuddy";
const MAX_RETIRED_WORKBUDDY_SESSIONS = 256;

// `services` is the runtime-main kernel surface (see codex/main-runtime.js).
// `options` may inject workBuddySessionTitleTracker or
// workBuddySessionTitleOptions.
function createWorkBuddyMainRuntime(services) {
  const { options, debugLog, getStateRuntime, isAgentEnabled, isDisposed } = services;

  // ── Local WorkBuddy archive/delete retirement (#655) ────────────────────
  // WorkBuddy changes a conversation's lifecycle only in workbuddy.db, without
  // sending any hook, so a finished card would otherwise linger until the idle
  // timeout. The title observer spots that and hands the session here; late
  // lifecycle hooks are then re-checked against the database so an unarchived
  // chat can rebuild its card. Only local WorkBuddy is ever matched.
  // raw session id -> the home whose database decided the lifecycle, so a late
  // hook without a transcript path re-reads the same database.
  const retiredWorkBuddySessions = new Map();

  // The scope that decides whether an event belongs to a local WorkBuddy
  // conversation. Like localWorkBuddySession, it honors the fields the stored
  // session already carries (host / wslDistro / headless are sticky in state),
  // so a later event that omits them still resolves to the same scope.
  function workBuddyEventScope(sessionId, opts) {
    const state = getStateRuntime();
    const session = state && state.sessions && typeof state.sessions.get === "function"
      ? state.sessions.get(sessionId)
      : null;
    return {
      agentId: (opts && opts.agentId) || (session && session.agentId) || null,
      profileId: (opts && opts.profileId) || (session && session.profileId) || "local",
      host: (opts && opts.host) || (session && session.host) || null,
      wslDistro: (opts && opts.wslDistro) || (session && session.wslDistro) || null,
      headless: (opts && opts.headless === true) || !!(session && session.headless === true),
    };
  }

  function isLocalWorkBuddyScope(scope) {
    return !!(
      scope
      && scope.agentId === AGENT_ID
      && (scope.profileId || "local") === "local"
      && !scope.host
      && !scope.wslDistro
      && !scope.headless
    );
  }

  function rememberRetiredWorkBuddy(rawSessionId, lifecycleHome) {
    if (typeof rawSessionId !== "string" || !rawSessionId) return;
    retiredWorkBuddySessions.delete(rawSessionId);
    retiredWorkBuddySessions.set(rawSessionId, typeof lifecycleHome === "string" && lifecycleHome ? lifecycleHome : null);
    while (retiredWorkBuddySessions.size > MAX_RETIRED_WORKBUDDY_SESSIONS) {
      retiredWorkBuddySessions.delete(retiredWorkBuddySessions.keys().next().value);
    }
  }

  function clearRetiredWorkBuddySessions() {
    retiredWorkBuddySessions.clear();
  }

  function handleWorkBuddyRetired({ sessionId, rawSessionId, lifecycleHome } = {}) {
    rememberRetiredWorkBuddy(rawSessionId, lifecycleHome);
    const state = getStateRuntime();
    if (state && typeof state.dismissSession === "function" && sessionId) {
      state.dismissSession(sessionId);
    }
    debugLog(`workbuddy-archive retire sid=${String(rawSessionId || sessionId || "-").replace(/[\r\n]/g, "_")}`);
  }

  function shouldSuppressRetiredWorkBuddy(sessionId, rawSessionId, opts) {
    if (!isLocalWorkBuddyScope(workBuddyEventScope(sessionId, opts))) return false;
    const raw = typeof rawSessionId === "string" && rawSessionId ? rawSessionId : null;
    if (!raw || !retiredWorkBuddySessions.has(raw)) return false;
    let archived = null;
    if (workBuddySessionTitleTracker && typeof workBuddySessionTitleTracker.readArchived === "function") {
      try {
        archived = workBuddySessionTitleTracker.readArchived({
          rawSessionId: raw,
          cwd: opts && opts.cwd,
          transcriptPath: opts && opts.transcriptPath,
          lifecycleHome: retiredWorkBuddySessions.get(raw),
        });
      } catch {
        archived = null;
      }
    }
    // Still archived/deleted: drop the hook. Unarchived or unreadable: stop
    // suppressing so a revived conversation can rebuild its card.
    if (archived === true) return true;
    retiredWorkBuddySessions.delete(raw);
    return false;
  }

  function localWorkBuddySession(sessionId) {
    if (isDisposed() || !isAgentEnabled(AGENT_ID)) return null;
    const state = getStateRuntime();
    const session = state && state.sessions && state.sessions.get(sessionId);
    return session && session.agentId === AGENT_ID && (session.profileId || "local") === "local"
      && !session.host && !session.wslDistro && !session.headless ? session : null;
  }

  const workBuddySessionTitleTracker = options.workBuddySessionTitleTracker
    || createWorkBuddySessionTitleTracker({
      ...options.workBuddySessionTitleOptions,
      getSession: localWorkBuddySession,
      onRetired: handleWorkBuddyRetired,
      updateTitle(sessionId, title) {
        const state = getStateRuntime();
        if (state && typeof state.updateSessionMetadata === "function") {
          state.updateSessionMetadata(sessionId, { sessionTitle: title, expectedAgentId: AGENT_ID });
        }
      },
    });

  function enrichWorkBuddySessionTitle(sessionId, event, opts) {
    if (opts.agentId !== AGENT_ID || (opts.profileId || "local") !== "local"
      || opts.host || opts.wslDistro || opts.headless) return;
    if (event === "SessionEnd") {
      workBuddySessionTitleTracker.clear(sessionId);
      return;
    }
    const session = localWorkBuddySession(sessionId);
    if (!session) return;
    const input = {
      sessionId,
      rawSessionId: session.rawSessionId || opts.rawSessionId || sessionId,
      cwd: session.cwd,
      transcriptPath: session.transcriptPath || null,
    };
    if (event === "SessionStart") {
      // WorkBuddy 5.6.x emits a SessionStart on every turn (source=resume).
      workBuddySessionTitleTracker.beginTurn(input);
      return;
    }
    workBuddySessionTitleTracker.track(input);
  }

  function resetTracking() {
    workBuddySessionTitleTracker.clear();
    clearRetiredWorkBuddySessions();
  }

  return {
    // A locally archived/deleted WorkBuddy conversation emits no hook, but a
    // late one may still arrive; re-read workbuddy.db and only drop it while
    // the row is still archived/deleted.
    admitSessionUpdate(sessionId, state, event, opts = {}) {
      return !shouldSuppressRetiredWorkBuddy(
        sessionId,
        opts && opts.rawSessionId ? opts.rawSessionId : sessionId,
        opts,
      );
    },
    onSessionUpdated(sessionId, state, event, opts = {}) {
      enrichWorkBuddySessionTitle(sessionId, event, opts);
    },
    clearSessions: resetTracking,
    dispose: resetTracking,
    api: {
      getWorkBuddySessionTitleTracker: () => workBuddySessionTitleTracker,
    },
  };
}

module.exports = { createWorkBuddyMainRuntime };
