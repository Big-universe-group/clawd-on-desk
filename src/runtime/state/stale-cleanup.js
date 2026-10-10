"use strict";

const { callAgentPort } = require("../../core/ports/agent-ports");
const { isWslSourced } = require("../../core/server/remote-process-metadata");

const SESSION_STALE_MS = 600000;
const WORKING_STALE_MS = 300000;
const DETACHED_IDLE_STALE_MS = 30000;

function isWorkingLikeState(state) {
  return state === "working" || state === "juggling" || state === "thinking";
}

// A local, attached conversation that has settled to idle. Agents whose
// conversations share one long-lived app process (and emit no SessionEnd) opt
// into an idle-age cutoff for these through their ingest adapter.
function isLocalIdleConversation(session) {
  return !!session
    && !session.host
    && !session.headless
    && session.state === "idle";
}

function hasReplyableCompletionMapping(session, options) {
  if (typeof options.hasReplyableCompletionMapping !== "function") return false;
  try {
    return options.hasReplyableCompletionMapping(session) === true;
  } catch {
    return false;
  }
}

// Agent-specific working timeout (ingest port `staleWorkingTimeoutMs`); the
// generic timeout when the agent has no override for this session.
function resolveWorkingStaleMs(session, workingStaleMs, config) {
  const override = callAgentPort(
    session && session.agentId,
    "ingest",
    "staleWorkingTimeoutMs",
    [session, { workingStaleMs, staleConfig: config }],
    undefined
  );
  return Number.isFinite(override) ? override : workingStaleMs;
}

function getStaleSessionDecision(session, options = {}) {
  const now = options.now;
  const config = options.staleConfig || {};
  let sessionStaleMs = Number.isFinite(config.sessionStaleMs)
    ? config.sessionStaleMs
    : SESSION_STALE_MS;
  const genericWorkingStaleMs = Number.isFinite(config.workingStaleMs)
    ? config.workingStaleMs
    : WORKING_STALE_MS;
  const detachedIdleStaleMs = Number.isFinite(config.detachedIdleStaleMs)
    ? config.detachedIdleStaleMs
    : DETACHED_IDLE_STALE_MS;
  const workingStaleMs = resolveWorkingStaleMs(session, genericWorkingStaleMs, config);

  const isProcessAlive = options.isProcessAlive;
  // A WSL session's PIDs are Linux PIDs that can alias unrelated live processes
  // on this Windows host. Never probe them: treat the session as PID-unreachable
  // so it retires by idle age (`unreachable`) instead of by a bogus agent/source
  // exit. `wslDistro`/`host` are sticky on the session once set.
  const wslSourced = isWslSourced({ wslDistro: session.wslDistro, host: session.host });
  const pidReachable = wslSourced ? false : !!session.pidReachable;
  const livenessByPid = new Map();
  const isProcessAliveOnce = (pid) => {
    if (livenessByPid.has(pid)) return livenessByPid.get(pid);
    const alive = isProcessAlive(pid);
    livenessByPid.set(pid, alive);
    return alive;
  };
  const hasReachableAgentPid = !!(pidReachable && session.agentPid);
  const agentAlive = hasReachableAgentPid ? isProcessAliveOnce(session.agentPid) : null;

  if (hasReachableAgentPid && !agentAlive) {
    return { action: "delete", reason: "agent-exit" };
  }

  // GLOBAL reference time: the stale branches consume Math.max(updatedAt,
  // ackedAt) so a freshly-acked session restarts its idle countdown from the
  // ack instant instead of its (possibly ancient) last updatedAt.
  const referenceTs = Math.max(
    Number(session.updatedAt) || 0,
    Number(session.ackedAt) || 0
  );
  const age = now - referenceTs;

  // Agents whose conversations outlive any process signal (shared long-lived
  // app PIDs, no SessionEnd) decide the expired-idle outcome themselves
  // (ingest port `staleIdleDecision`); null falls through to the generic rules.
  if (sessionStaleMs > 0 && age > sessionStaleMs) {
    const agentDecision = callAgentPort(
      session.agentId,
      "ingest",
      "staleIdleDecision",
      [session, {
        hasReplyableCompletionMapping: () => hasReplyableCompletionMapping(session, options),
      }],
      null
    );
    if (agentDecision) return agentDecision;
  }

  // NOTE: requiresCompletionAck does NOT hold a session out of stale cleanup.
  // The completion notification (e.g. Telegram push) already fires once at the
  // completion instant, so an unacknowledged remote session has already been
  // surfaced — it does not need to linger past the user's configured session
  // timeout to be "seen". The `done` badge (deriveSessionBadge) keeps the
  // session visually distinct while it waits out the normal timeout, then it
  // deletes like any other idle remote session. With sessionStaleMs=0 the
  // session is kept forever, matching a normal idle session. agent-exit above
  // still wins (a dead process is dead).

  const deriveSessionBadge = options.deriveSessionBadge;
  const shouldAutoClearDetachedSession = options.shouldAutoClearDetachedSession;
  const badge = deriveSessionBadge(session);
  const autoClearDetached = shouldAutoClearDetachedSession(session, badge);
  if (autoClearDetached) {
    if (age > detachedIdleStaleMs) {
      return { action: "delete", reason: "detached-ended", badge };
    }
    return { action: null, snapshotRefreshNeeded: true };
  }

  // Active-turn silence and idle-card retention are separate clocks. Always
  // settle a working-like session through its effective working timeout first
  // and stamp that transition. Otherwise a 20-minute-old Codex turn can be
  // changed to idle with its old timestamp, then deleted immediately by the
  // ordinary 10-minute idle cutoff on the next sweep.
  //
  // With an age window enabled, only check source liveness after it elapses. A
  // source_pid frequently belongs to a per-event launcher rather than to the
  // session host — Windows Claude Code runs every hook through a throwaway
  // pwsh wrapper, so the pid shipped with an event is already gone when the
  // next sweep reads it. Probing it while the turn is still reporting deletes
  // the live session between events, and the following event recreates it.
  if (isWorkingLikeState(session.state)) {
    const workingWindowElapsed = workingStaleMs > 0 && age > workingStaleMs;
    // Zero disables age-based expiry, not process-death cleanup. In particular,
    // a local Codex session may have only a source PID when agent PID discovery
    // failed, so the earlier agent-exit check cannot retire it on its own.
    if (
      (workingStaleMs === 0 || workingWindowElapsed)
      && pidReachable && session.sourcePid
      && !agentAlive
      && !isProcessAliveOnce(session.sourcePid)
    ) {
      return { action: "delete", reason: "working-source-exit" };
    }
    if (workingWindowElapsed) {
      return { action: "idle", reason: "working-timeout", updateTimestamp: true };
    }
    return { action: null };
  }

  // sessionStaleMs === 0 disables the idle/non-working age cutoff entirely.
  if (sessionStaleMs > 0 && age > sessionStaleMs) {
    if (pidReachable && session.sourcePid) {
      // A per-event wrapper is weaker evidence than a reachable live agent.
      // The special per-conversation desktop cutoffs above still win; for
      // ordinary sessions, only fall back to source death when no live agent
      // process can vouch for the session.
      if (!agentAlive && !isProcessAliveOnce(session.sourcePid)) {
        return { action: "delete", reason: "source-exit" };
      }
      if (session.state !== "idle") {
        return { action: "idle", reason: "session-timeout", updateTimestamp: false };
      }
    } else if (!pidReachable) {
      return { action: "delete", reason: "unreachable" };
    } else {
      return { action: "delete", reason: "no-source" };
    }
  }

  return { action: null };
}

module.exports = {
  SESSION_STALE_MS,
  WORKING_STALE_MS,
  DETACHED_IDLE_STALE_MS,
  isWorkingLikeState,
  isLocalIdleConversation,
  getStaleSessionDecision,
};
