"use strict";

// ── Active usage aggregation for the quota ring ──
//
// When the quota ring master switch (sessionHudShowQuota) is on, Clawd asks
// each ENABLED agent's own CLI/login for current usage and merges it into
// the account-quota store's local source, next to the passive sources
// (statusline, rollout JSONL, Kimi, Remote SSH). See src/usage-sources/*.
//
// Policy:
// - Gates are re-read at admission AND right before commit: turning the ring
//   or an agent off while a request is in flight must not write its result.
// - No periodic polling. Refreshes are event-driven (startup, pet click,
//   Dashboard open, Settings "refresh now", gate turned on), and each source
//   is throttled independently: ≥5 min between attempts (forced: ≥60 s),
//   one in flight at a time, and a 429 backoff window.
// - Interactive triggers may read the macOS Keychain (claude-oauth); a
//   source that is only waiting for that interaction is not throttled for
//   the next interactive request.
// - Status details are short English diagnostics; tokens and response bodies
//   never reach logs, status, or persistence.

const { createClaudeOAuthSource } = require("./sources/claude-oauth");
const { createCodexAppServerSource } = require("./sources/codex-app-server");
const { createOmpUsageSource } = require("./sources/omp-usage");

const SOURCE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const FORCE_MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
const RESULT_STATES = new Set([
  "ok",
  "unavailable",
  "needs-login",
  "waiting-interaction",
  "rate-limited",
  "error",
]);

function createDefaultSources(deps) {
  return [
    createClaudeOAuthSource(deps),
    createCodexAppServerSource(deps),
    createOmpUsageSource(deps),
  ];
}

function createUsageCollector(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const logWarn = typeof deps.logWarn === "function" ? deps.logWarn : () => {};
  const isMasterEnabled = typeof deps.isMasterEnabled === "function"
    ? deps.isMasterEnabled
    : () => false;
  const isAgentEnabled = typeof deps.isAgentEnabled === "function"
    ? deps.isAgentEnabled
    : () => false;
  const updateAccountQuota = typeof deps.updateAccountQuota === "function"
    ? deps.updateAccountQuota
    : () => false;
  const sources = Array.isArray(deps.sources) ? deps.sources : createDefaultSources(deps);
  const entries = new Map(sources.map((source) => [source.id, {
    source,
    state: null,
    detail: null,
    providers: [],
    lastAttemptAt: null,
    lastSuccessAt: null,
    retryAt: null,
    inFlight: null,
    // Last successfully committed quotas, kept so a provider-wide clear that
    // cannot tell sources apart can be undone for this collector's data.
    lastQuotas: null,
  }]));
  const abortController = new AbortController();
  let disposed = false;

  function gatedIn(entry) {
    return !disposed && isMasterEnabled() === true && isAgentEnabled(entry.source.agentId) === true;
  }

  function admissible(entry, { interactive, force }, nowMs) {
    if (entry.retryAt !== null && entry.retryAt > nowMs) return false;
    if (entry.lastAttemptAt === null) return true;
    if (interactive && entry.state === "waiting-interaction") return true;
    const minInterval = force ? FORCE_MIN_INTERVAL_MS : SOURCE_MIN_INTERVAL_MS;
    return nowMs - entry.lastAttemptAt >= minInterval;
  }

  function applyResult(entry, rawResult) {
    const result = rawResult && RESULT_STATES.has(rawResult.state)
      ? rawResult
      : { state: "error", detail: "Unexpected source result" };
    const finishedAt = now();
    if (result.state === "ok") {
      const quotas = result.quotas && typeof result.quotas === "object" ? result.quotas : null;
      if (quotas) updateAccountQuota(null, quotas);
      entry.lastQuotas = quotas;
      entry.state = "ok";
      entry.detail = null;
      entry.providers = Array.isArray(result.providers) ? result.providers.slice() : [];
      entry.lastSuccessAt = finishedAt;
      entry.retryAt = null;
      return;
    }
    entry.state = result.state;
    entry.detail = typeof result.detail === "string" ? result.detail : null;
    entry.retryAt = result.state === "rate-limited"
      ? (Number.isFinite(result.retryAt) && result.retryAt > finishedAt
        ? result.retryAt
        : finishedAt + DEFAULT_RATE_LIMIT_BACKOFF_MS)
      : null;
  }

  async function runEntry(entry, interactive, trigger) {
    entry.lastAttemptAt = now();
    let result;
    try {
      result = await entry.source.run({ interactive, trigger, signal: abortController.signal });
    } catch (err) {
      logWarn(`Clawd: usage source ${entry.source.id} failed:`, err && err.message);
      result = { state: "error", detail: "Unexpected source failure" };
    }
    // Commit-time re-check: the user may have turned the ring or the agent
    // off while the request was in flight.
    if (!gatedIn(entry)) return;
    applyResult(entry, result);
  }

  function requestRefresh(options = {}) {
    const interactive = options.interactive === true;
    const force = options.force === true;
    const trigger = typeof options.trigger === "string" ? options.trigger : "unspecified";
    if (disposed || isMasterEnabled() !== true) return Promise.resolve(getStatus());
    const pending = [];
    const nowMs = now();
    for (const entry of entries.values()) {
      if (!gatedIn(entry)) continue;
      if (entry.inFlight) {
        // Single flight: join the running request instead of starting another.
        pending.push(entry.inFlight);
        continue;
      }
      if (!admissible(entry, { interactive, force }, nowMs)) continue;
      entry.inFlight = runEntry(entry, interactive, trigger).finally(() => {
        entry.inFlight = null;
      });
      pending.push(entry.inFlight);
    }
    return Promise.all(pending).then(() => getStatus());
  }

  function getStatus() {
    const master = !disposed && isMasterEnabled() === true;
    return Array.from(entries.values()).map((entry) => {
      let state;
      if (!master) state = "off";
      else if (isAgentEnabled(entry.source.agentId) !== true) state = "agent-disabled";
      else if (entry.lastAttemptAt === null) state = "idle";
      else state = entry.state || "idle";
      return {
        id: entry.source.id,
        agentId: entry.source.agentId,
        state,
        lastSuccessAt: entry.lastSuccessAt,
        lastAttemptAt: entry.lastAttemptAt,
        detail: state === entry.state ? entry.detail : null,
        providers: entry.providers.slice(),
      };
    });
  }

  // The Claude statusline authority clear (server.js / state.js) wipes the
  // local claudeQuota without knowing who wrote it. What this collector
  // fetched from the login API / omp is still valid, so put it back instead
  // of leaving the coin empty until the next throttled refresh. Buckets keep
  // their original capturedAt and resetAt, so nothing looks fresher than it is
  // and windows that reset meanwhile are rejected by the store.
  function recommitProvider(providerKey) {
    if (disposed || isMasterEnabled() !== true) return false;
    let changed = false;
    for (const entry of entries.values()) {
      const group = entry.lastQuotas && entry.lastQuotas[providerKey];
      if (!group || !gatedIn(entry)) continue;
      if (updateAccountQuota(null, { [providerKey]: group })) changed = true;
    }
    return changed;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    abortController.abort();
  }

  return { requestRefresh, getStatus, recommitProvider, dispose };
}

module.exports = {
  createUsageCollector,
  SOURCE_MIN_INTERVAL_MS,
  FORCE_MIN_INTERVAL_MS,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
};
