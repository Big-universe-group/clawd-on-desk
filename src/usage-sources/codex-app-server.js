"use strict";

// Active Codex subscription rate limits via the installed CLI's app-server.
//
// `codex app-server` speaks newline-delimited JSON-RPC on stdio. The session
// is the minimum the protocol requires: initialize → initialized →
// account/rateLimits/read, then stdin EOF (the server exits on it; it does
// not start MCP servers). The CLI owns its own login; Clawd never reads its
// tokens. Responses are mapped onto the rollout `rate_limits` shape and routed
// by the same resolveCodexRateLimitReport the passive JSONL path uses, so
// generic Codex and Spark quotas stay isolated exactly as before.

const { spawn: defaultSpawn } = require("child_process");

const { resolveCodexRateLimitReport } = require("../../hooks/codex-rate-limits");
const { resolveCliBinary, spawnCli } = require("./cli-binary");

const SOURCE_ID = "codex-app-server";
const AGENT_ID = "codex";
const CODEX_APP_SERVER_ARGS = ["app-server"];
const CODEX_TIMEOUT_MS = 20_000;
// After stdin EOF the server exits on its own; force it if it lingers.
const EXIT_GRACE_MS = 2_000;
const MAX_LINE_BYTES = 1024 * 1024;
const INITIALIZE_ID = 1;
const RATE_LIMITS_ID = 2;
const PROVIDER_LABELS = { codexQuota: "Codex", codexSparkQuota: "Codex Spark" };

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// RateLimitWindow { usedPercent, windowDurationMins|null, resetsAt|null (unix s) }
// → rollout { used_percent, window_minutes?, resets_at? }. Null fields are
// omitted, not zeroed: a zero resets_at would read as "already reset".
function toSnakeWindow(window) {
  if (!isPlainObject(window)) return null;
  const usedPercent = finite(window.usedPercent);
  if (usedPercent === null) return null;
  const out = { used_percent: usedPercent };
  const windowMinutes = finite(window.windowDurationMins);
  if (windowMinutes !== null && windowMinutes > 0) out.window_minutes = windowMinutes;
  const resetsAt = finite(window.resetsAt);
  if (resetsAt !== null && resetsAt > 0) out.resets_at = resetsAt;
  return out;
}

function toSnakeSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return null;
  const out = {};
  if (typeof snapshot.limitId === "string") out.limit_id = snapshot.limitId;
  if (typeof snapshot.limitName === "string") out.limit_name = snapshot.limitName;
  const primary = toSnakeWindow(snapshot.primary);
  const secondary = toSnakeWindow(snapshot.secondary);
  if (primary) out.primary = primary;
  if (secondary) out.secondary = secondary;
  return primary || secondary ? out : null;
}

// GetAccountRateLimitsResponse → { quotas, providers } | null.
// rateLimitsByLimitId (multi-bucket) is preferred; the single rateLimits view
// is the backward-compatible fallback.
function mapCodexRateLimitsResponse(result, nowMs) {
  if (!isPlainObject(result)) return null;
  const snapshots = isPlainObject(result.rateLimitsByLimitId)
    ? Object.values(result.rateLimitsByLimitId)
    : [result.rateLimits];
  const quotas = {};
  for (const snapshot of snapshots) {
    const rateLimits = toSnakeSnapshot(snapshot);
    if (!rateLimits) continue;
    const report = resolveCodexRateLimitReport({ rate_limits: rateLimits }, { nowMs, capturedAt: nowMs });
    if (!report || quotas[report.providerKey]) continue;
    quotas[report.providerKey] = report.quota;
  }
  const providerKeys = Object.keys(quotas);
  if (!providerKeys.length) return null;
  return { quotas, providers: providerKeys.map((key) => PROVIDER_LABELS[key] || key) };
}

function classifyRpcError(error) {
  const message = isPlainObject(error) && typeof error.message === "string" ? error.message : "";
  if (/chatgpt authentication required/i.test(message)) {
    return { state: "needs-login", detail: "ChatGPT login required" };
  }
  const code = isPlainObject(error) && Number.isFinite(error.code) ? error.code : "unknown";
  return { state: "error", detail: `Codex rate limit read failed (code ${code})` };
}

// Runs one JSON-RPC session against an already-spawned child. Resolves to
// { kind: "result", result } | { kind: "rpc-error", error } | { kind: "timeout" }
// | { kind: "spawn-error" } | { kind: "exit", code } | { kind: "aborted" }.
function runAppServerSession(child, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : CODEX_TIMEOUT_MS;
  const clientVersion = typeof options.clientVersion === "string" && options.clientVersion
    ? options.clientVersion
    : "unknown";
  const signal = options.signal;
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let exitTimer = null;
    const write = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {}
    };
    const kill = () => {
      try { child.kill(); } catch {}
    };
    const finish = (outcome, { killNow = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      try { child.stdin.end(); } catch {}
      if (killNow) {
        kill();
      } else {
        exitTimer = setTimeout(kill, EXIT_GRACE_MS);
        if (typeof exitTimer.unref === "function") exitTimer.unref();
      }
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: "aborted" }, { killNow: true });
    const timer = setTimeout(() => finish({ kind: "timeout" }, { killNow: true }), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const handleMessage = (message) => {
      if (!isPlainObject(message) || !Object.prototype.hasOwnProperty.call(message, "id")) return;
      if (message.id === INITIALIZE_ID) {
        if (message.error) {
          finish({ kind: "rpc-error", error: message.error });
          return;
        }
        write({ jsonrpc: "2.0", method: "initialized" });
        write({ jsonrpc: "2.0", id: RATE_LIMITS_ID, method: "account/rateLimits/read" });
        return;
      }
      if (message.id === RATE_LIMITS_ID) {
        finish(message.error
          ? { kind: "rpc-error", error: message.error }
          : { kind: "result", result: message.result });
      }
      // Notifications (configWarning, remoteControl/status/changed, …) and
      // other ids are ignored.
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let message = null;
          try { message = JSON.parse(line); } catch {}
          handleMessage(message);
          if (settled) return;
        }
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_BYTES) finish({ kind: "exit", code: null }, { killNow: true });
    });
    // stderr is drained (a full pipe would block the child) but never logged.
    if (child.stderr) child.stderr.on("data", () => {});
    if (child.stdin && typeof child.stdin.on === "function") child.stdin.on("error", () => {});
    child.on("error", () => finish({ kind: "spawn-error" }, { killNow: true }));
    child.on("exit", (code) => {
      clearTimeout(exitTimer);
      finish({ kind: "exit", code });
    });
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    write({
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
      method: "initialize",
      params: { clientInfo: { name: "clawd-on-desk", version: clientVersion } },
    });
  });
}

function sessionOutcomeToResult(outcome, nowMs) {
  switch (outcome.kind) {
    case "result": {
      const mapped = mapCodexRateLimitsResponse(outcome.result, nowMs);
      return mapped
        ? { state: "ok", quotas: mapped.quotas, providers: mapped.providers }
        : { state: "error", detail: "Codex returned no usable rate limits" };
    }
    case "rpc-error":
      return classifyRpcError(outcome.error);
    case "timeout":
      return { state: "error", detail: "Codex app-server timed out" };
    case "spawn-error":
      return { state: "error", detail: "Could not start codex app-server" };
    case "aborted":
      return { state: "error", detail: "Refresh cancelled" };
    default:
      return { state: "error", detail: `codex app-server exited (code ${outcome.code === null || outcome.code === undefined ? "unknown" : outcome.code})` };
  }
}

function createCodexAppServerSource(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const spawn = deps.spawn || defaultSpawn;
  const resolveBinary = typeof deps.resolveBinary === "function"
    ? deps.resolveBinary
    : (name) => resolveCliBinary(name, deps);

  async function run({ signal } = {}) {
    const bin = resolveBinary("codex");
    if (!bin) return { state: "unavailable", detail: "codex CLI not found" };
    let child;
    try {
      child = spawnCli(spawn, bin, CODEX_APP_SERVER_ARGS, deps);
    } catch {
      return { state: "error", detail: "Could not start codex app-server" };
    }
    const outcome = await runAppServerSession(child, {
      timeoutMs: deps.timeoutMs,
      clientVersion: deps.appVersion,
      signal,
    });
    return sessionOutcomeToResult(outcome, now());
  }

  return { id: SOURCE_ID, agentId: AGENT_ID, run };
}

module.exports = {
  CODEX_APP_SERVER_ARGS,
  CODEX_TIMEOUT_MS,
  toSnakeSnapshot,
  mapCodexRateLimitsResponse,
  classifyRpcError,
  runAppServerSession,
  sessionOutcomeToResult,
  createCodexAppServerSource,
};
