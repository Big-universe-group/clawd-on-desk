"use strict";

// Main-process agent runtime owner. Agent-neutral: per-agent behavior (local
// log monitors, session-title trackers, official-hook arbitration, archive
// retirement, permission holds) lives in each agent's port adapters. Agents
// providing the ingest hook `createMainRuntime(services)` get one stateful
// runtime here; its optional lifecycle methods are called below and its
// `api` methods are exposed on the returned object.

const { callAgentPort, listAgentPorts } = require("../core/ports/agent-ports");

function createAgentRuntimeMain(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : console.warn;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const getServer = options.getServer || (() => null);
  const getStateRuntime = options.getStateRuntime || (() => null);
  const getPermissionRuntime = options.getPermissionRuntime || (() => null);
  const isAgentEnabled = options.isAgentEnabled || (() => true);
  const updateSession = options.updateSession || (() => {});
  const captureGhosttyTerminalId = options.captureGhosttyTerminalId || null;

  let disposed = false;
  const services = Object.freeze({
    options,
    now,
    logWarn,
    debugLog,
    getStateRuntime,
    getPermissionRuntime,
    isAgentEnabled,
    updateSession,
    isDisposed: () => disposed,
  });

  // agentId -> runtime, in agent-id order (listAgentPorts is sorted), which is
  // also the order every lifecycle fan-out below runs in.
  const agentRuntimes = new Map();
  for (const { agentId, adapter } of listAgentPorts("ingest")) {
    if (typeof adapter.createMainRuntime !== "function") continue;
    const runtime = adapter.createMainRuntime(services);
    if (runtime) agentRuntimes.set(agentId, runtime);
  }

  function callAgentRuntime(agentId, method, args = []) {
    const runtime = agentRuntimes.get(agentId);
    if (runtime && typeof runtime[method] === "function") runtime[method](...args);
  }

  function eachAgentRuntime(method, args) {
    for (const runtime of agentRuntimes.values()) {
      if (typeof runtime[method] === "function") runtime[method](...args);
    }
  }

  function updateSessionFromServer(sessionId, state, event, opts = {}) {
    // Each agent runtime gates only its own sessions (e.g. late hooks for a
    // locally archived conversation, fenced official turns).
    for (const runtime of agentRuntimes.values()) {
      if (typeof runtime.admitSessionUpdate !== "function") continue;
      if (runtime.admitSessionUpdate(sessionId, state, event, opts) === false) return false;
    }
    const result = updateSession(sessionId, state, event, opts);
    maybeCaptureGhosttyTerminalId(sessionId, event, opts);
    eachAgentRuntime("onSessionUpdated", [sessionId, state, event, opts]);
    return result;
  }

  function updateSessionMetadataFromServer(sessionId, opts = {}) {
    const state = getStateRuntime();
    const accepted = !!(state && typeof state.updateSessionMetadata === "function"
      && state.updateSessionMetadata(sessionId, opts));
    if (accepted) eachAgentRuntime("onSessionMetadataUpdated", [sessionId, opts]);
    return accepted;
  }

  function maybeCaptureGhosttyTerminalId(sessionId, event, opts = {}) {
    if (typeof captureGhosttyTerminalId !== "function") return false;
    if (!sessionId || opts.host || opts.ghosttyTerminalId || !opts.sourcePid || !opts.cwd) return false;
    if (event !== "SessionStart" && event !== "UserPromptSubmit") return false;
    return captureGhosttyTerminalId({ sourcePid: opts.sourcePid, cwd: opts.cwd }, (terminalId) => {
      if (!terminalId) return;
      const state = getStateRuntime();
      if (!state || typeof state.updateSessionFocusMetadata !== "function") return;
      state.updateSessionFocusMetadata(String(sessionId), {
        sourcePid: opts.sourcePid,
        ghosttyTerminalId: terminalId,
      });
    });
  }

  function startMonitorForAgent(agentId) {
    // Caller (Settings pre-commit enable/install, or startup) has already
    // decided to start; re-reading the persisted gate here races the settings
    // store write. Match the existing monitor.start() semantics.
    if (disposed) return;
    callAgentRuntime(agentId, "startMonitor");
  }

  function stopMonitorForAgent(agentId) {
    callAgentRuntime(agentId, "stopMonitor");
  }

  function callServer(method, ...args) {
    const server = getServer();
    return server && typeof server[method] === "function" ? server[method](...args) : false;
  }

  function syncIntegrationForAgent(agentId, optionsArg) {
    return callServer("syncIntegrationForAgent", agentId, optionsArg);
  }

  function repairIntegrationForAgent(agentId, optionsArg) {
    return callServer("repairIntegrationForAgent", agentId, optionsArg);
  }

  function stopIntegrationForAgent(agentId) {
    return callServer("stopIntegrationForAgent", agentId);
  }

  function uninstallIntegrationForAgent(agentId) {
    return callServer("uninstallIntegrationForAgent", agentId);
  }

  function clearSessionsByAgent(agentId) {
    callAgentRuntime(agentId, "clearSessions");
    const state = getStateRuntime();
    return state && typeof state.clearSessionsByAgent === "function"
      ? state.clearSessionsByAgent(agentId)
      : 0;
  }

  function dismissPermissionsByAgent(agentId, options) {
    const perm = getPermissionRuntime();
    const state = getStateRuntime();
    const removed = perm && typeof perm.dismissPermissionsByAgent === "function"
      ? perm.dismissPermissionsByAgent(agentId, options)
      : 0;
    // Some agents keep a state-side permission hold for passive notifications;
    // when an agent is disabled, dismissing the bubble must release that hold too.
    const released = state
      ? callAgentPort(agentId, "permission", "releaseStatePermissionHolds", [state], false)
      : false;
    if (released && typeof state.resolveDisplayState === "function" && typeof state.setState === "function") {
      const resolved = state.resolveDisplayState();
      state.setState(resolved, state.getSvgOverride ? state.getSvgOverride(resolved) : undefined);
    }
    return removed;
  }

  function cleanup() {
    disposed = true;
    eachAgentRuntime("dispose", []);
  }

  const publicApi = {
    startMonitorForAgent,
    stopMonitorForAgent,
    syncIntegrationForAgent,
    repairIntegrationForAgent,
    stopIntegrationForAgent,
    uninstallIntegrationForAgent,
    clearSessionsByAgent,
    dismissPermissionsByAgent,
    updateSessionFromServer,
    updateSessionMetadataFromServer,
    cleanup,
  };
  // Agent runtimes contribute their own public methods (e.g. the Codex log
  // monitor entry points main.js and the server ctx call by name).
  for (const [agentId, runtime] of agentRuntimes) {
    const api = runtime.api && typeof runtime.api === "object" ? runtime.api : null;
    if (!api) continue;
    for (const [name, fn] of Object.entries(api)) {
      if (Object.prototype.hasOwnProperty.call(publicApi, name)) {
        throw new Error(`agent runtime "${agentId}" redefines runtime-main method "${name}"`);
      }
      publicApi[name] = fn;
    }
  }
  return publicApi;
}

module.exports = createAgentRuntimeMain;
