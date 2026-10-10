"use strict";

// Active multi-provider usage via `omp usage --json --redact`.
//
// OMP already aggregates every provider the user logged into (Claude,
// Codex, DeepSeek, Command Code, OpenCode Go, …) into one UsageReport. Clawd
// maps it onto the account-quota contract: anthropic → claudeQuota,
// openai-codex → codexQuota, everything else → extraQuota[providerId].
// Privacy: only ids, labels, percentages, windows and balances are carried
// over; metadata, raw payloads, resetCredits, emails and account ids are
// never read into the mapped result (and stdout is never logged).

const { spawn: defaultSpawn } = require("child_process");

const { resolveCliBinary, spawnCli } = require("../../quota/cli-binary");

const SOURCE_ID = "omp-usage";
const AGENT_ID = "omp";
const OMP_USAGE_ARGS = ["usage", "--json", "--redact"];
const OMP_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const LONG_WINDOW_MINUTES = 24 * 60;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const BALANCE_CURRENCY_RE = /:balance:([A-Za-z]{3})$/;

const OMP_PROVIDER_LABELS = Object.freeze({
  anthropic: "Claude",
  "openai-codex": "Codex",
  deepseek: "DeepSeek",
  commandcode: "Command Code",
  "opencode-go": "OpenCode Go",
  zai: "Z.ai",
  "minimax-code": "MiniMax",
  "kimi-code": "Kimi Code",
  "github-copilot": "Copilot",
  "google-antigravity": "Antigravity",
  "google-gemini-cli": "Gemini",
  cursor: "Cursor",
  "xai-oauth": "xAI",
  "alibaba-token-plan": "Alibaba",
  "cline-pass": "Cline",
  devin: "Devin",
  synthetic: "Synthetic",
  umans: "Umans",
  "ollama-cloud": "Ollama Cloud",
  "factory-droid": "Factory",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerLabel(providerId) {
  return OMP_PROVIDER_LABELS[providerId] || providerId;
}

function isTierScoped(limit) {
  return isPlainObject(limit.scope) && typeof limit.scope.tier === "string" && limit.scope.tier !== "";
}

// One OMP limit → { kind: "window", usedPercent, windowMinutes?, resetAt? }
// | { kind: "balance", remaining, unit } | null (dropped).
function classifyOmpLimit(limit) {
  if (!isPlainObject(limit) || !isPlainObject(limit.amount)) return null;
  const amount = limit.amount;
  const window = isPlainObject(limit.window) ? limit.window : null;
  const usedFraction = finite(amount.usedFraction);
  if (usedFraction !== null) {
    const resetAt = window ? finite(window.resetsAt) : null;
    const used = finite(amount.used);
    const usedIsZero = used !== null ? used === 0 : usedFraction === 0;
    // Zero used and no reset instant usually carries no information: OMP's
    // statusline placeholders and percent-only windows look like this. A
    // window with a real capacity (a positive non-percent `limit`, e.g.
    // Command Code's 14-credit 5h window) is different: no reset yet just
    // means the window has not started, so it is genuinely 0% used.
    const capacity = finite(amount.limit);
    const hasRealCapacity = capacity !== null && capacity > 0 && amount.unit !== "percent";
    if (usedIsZero && resetAt === null && !hasRealCapacity) return null;
    const out = {
      kind: "window",
      usedPercent: Math.max(0, Math.min(100, Math.round(usedFraction * 100))),
    };
    const durationMs = window ? finite(window.durationMs) : null;
    if (durationMs !== null && durationMs > 0) out.windowMinutes = Math.round(durationMs / 60000);
    if (resetAt !== null) out.resetAt = resetAt;
    return out;
  }
  const remaining = finite(amount.remaining);
  if (remaining === null) return null;
  const id = typeof limit.id === "string" ? limit.id : "";
  const currency = BALANCE_CURRENCY_RE.exec(id);
  let unit;
  if (currency) unit = currency[1].toLowerCase();
  else if (amount.unit === "usd") unit = "usd";
  else unit = typeof amount.unit === "string" && amount.unit ? amount.unit : "credits";
  return { kind: "balance", remaining, unit };
}

function toQuotaBucket(classified, capturedAt) {
  const bucket = { usedPercent: classified.usedPercent, capturedAt };
  if (classified.windowMinutes) bucket.windowMinutes = classified.windowMinutes;
  if (classified.resetAt !== undefined) bucket.resetAt = classified.resetAt;
  return bucket;
}

function mapAnthropic(report, capturedAt) {
  const group = {};
  for (const limit of report.limits) {
    if (!isPlainObject(limit) || isTierScoped(limit)) continue;
    const field = limit.id === "anthropic:5h"
      ? "claudeFiveHour"
      : (limit.id === "anthropic:7d" ? "claudeWeekly" : null);
    if (!field || group[field]) continue;
    const classified = classifyOmpLimit(limit);
    if (!classified || classified.kind !== "window") continue;
    if (!classified.windowMinutes) classified.windowMinutes = field === "claudeFiveHour" ? 300 : 10080;
    group[field] = toQuotaBucket(classified, capturedAt);
  }
  return Object.keys(group).length ? group : null;
}

function mapOpenAiCodex(report, capturedAt) {
  const group = {};
  for (const limit of report.limits) {
    if (!isPlainObject(limit) || isTierScoped(limit)) continue;
    const classified = classifyOmpLimit(limit);
    if (!classified || classified.kind !== "window" || !classified.windowMinutes) continue;
    const field = classified.windowMinutes >= LONG_WINDOW_MINUTES ? "codexWeekly" : "codexFiveHour";
    if (group[field]) continue;
    group[field] = toQuotaBucket(classified, capturedAt);
  }
  return Object.keys(group).length ? group : null;
}

function mapExtraProvider(report, providerId, capturedAt) {
  const limits = [];
  for (const limit of report.limits) {
    // Tier-scoped entries are per-tier views (OMP's statusline placeholder is
    // one), not account limits — same rule as the Claude/Codex mappings.
    if (!isPlainObject(limit) || isTierScoped(limit)) continue;
    const classified = classifyOmpLimit(limit);
    if (!classified) continue;
    const id = typeof limit.id === "string" ? limit.id : "";
    if (!id) continue;
    limits.push({
      id,
      label: typeof limit.label === "string" ? limit.label : id,
      ...classified,
    });
  }
  return limits.length ? { label: providerLabel(providerId), capturedAt, limits } : null;
}

// UsageReport → { quotas, providers } where providers are display labels.
// Multiple reports for one provider (multi-account) keep the first.
function mapOmpUsageReport(report, nowMs = Date.now()) {
  if (!isPlainObject(report) || !Array.isArray(report.reports)) return null;
  const quotas = {};
  const providers = [];
  const seen = new Set();
  const generatedAt = finite(report.generatedAt);
  for (const entry of report.reports) {
    if (!isPlainObject(entry) || !Array.isArray(entry.limits)) continue;
    const providerId = typeof entry.provider === "string" ? entry.provider.trim().toLowerCase() : "";
    if (!PROVIDER_ID_RE.test(providerId) || seen.has(providerId)) continue;
    seen.add(providerId);
    const capturedAt = finite(entry.fetchedAt) ?? generatedAt ?? nowMs;
    if (providerId === "anthropic") {
      const group = mapAnthropic(entry, capturedAt);
      if (group) {
        quotas.claudeQuota = group;
        providers.push(providerLabel(providerId));
      }
      continue;
    }
    if (providerId === "openai-codex") {
      const group = mapOpenAiCodex(entry, capturedAt);
      if (group) {
        quotas.codexQuota = group;
        providers.push(providerLabel(providerId));
      }
      continue;
    }
    const extra = mapExtraProvider(entry, providerId, capturedAt);
    if (!extra) continue;
    if (!quotas.extraQuota) quotas.extraQuota = {};
    quotas.extraQuota[providerId] = extra;
    providers.push(extra.label);
  }
  return { quotas, providers };
}

// `omp` may print a warning line before the JSON document; fall back to the
// outermost object span.
function parseOmpUsageOutput(stdout) {
  if (typeof stdout !== "string" || !stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch {}
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Resolves { kind: "ok", stdout } | { kind: "exit", code } | { kind: "timeout" }
// | { kind: "spawn-error" } | { kind: "too-large" } | { kind: "aborted" }.
function collectChildOutput(child, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : OMP_TIMEOUT_MS;
  const signal = options.signal;
  return new Promise((resolve) => {
    let settled = false;
    const chunks = [];
    let size = 0;
    const kill = () => {
      try { child.kill(); } catch {}
    };
    const finish = (outcome, killNow) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      if (killNow) kill();
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: "aborted" }, true);
    const timer = setTimeout(() => finish({ kind: "timeout" }, true), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_STDOUT_BYTES) {
        finish({ kind: "too-large" }, true);
        return;
      }
      chunks.push(buffer);
    });
    if (child.stderr) child.stderr.on("data", () => {});
    try { child.stdin.end(); } catch {}
    child.on("error", () => finish({ kind: "spawn-error" }, true));
    child.on("close", (code) => {
      if (code === 0) finish({ kind: "ok", stdout: Buffer.concat(chunks).toString("utf8") }, false);
      else finish({ kind: "exit", code }, false);
    });
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function outputToResult(outcome, nowMs) {
  switch (outcome.kind) {
    case "ok": {
      const parsed = parseOmpUsageOutput(outcome.stdout);
      const mapped = parsed ? mapOmpUsageReport(parsed, nowMs) : null;
      if (!mapped) return { state: "error", detail: "Unrecognized omp usage output" };
      if (!mapped.providers.length) {
        return { state: "unavailable", detail: "omp reported no usage providers" };
      }
      return { state: "ok", quotas: mapped.quotas, providers: mapped.providers };
    }
    case "timeout":
      return { state: "error", detail: "omp usage timed out" };
    case "spawn-error":
      return { state: "error", detail: "Could not start omp" };
    case "too-large":
      return { state: "error", detail: "omp usage output too large" };
    case "aborted":
      return { state: "error", detail: "Refresh cancelled" };
    default:
      return { state: "error", detail: `omp usage exited (code ${outcome.code === null || outcome.code === undefined ? "unknown" : outcome.code})` };
  }
}

function createOmpUsageSource(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const spawn = deps.spawn || defaultSpawn;
  const resolveBinary = typeof deps.resolveBinary === "function"
    ? deps.resolveBinary
    : (name) => resolveCliBinary(name, deps);

  async function run({ signal } = {}) {
    const bin = resolveBinary("omp");
    if (!bin) return { state: "unavailable", detail: "omp CLI not found" };
    let child;
    try {
      child = spawnCli(spawn, bin, OMP_USAGE_ARGS, deps);
    } catch {
      return { state: "error", detail: "Could not start omp" };
    }
    const outcome = await collectChildOutput(child, { timeoutMs: deps.timeoutMs, signal });
    return outputToResult(outcome, now());
  }

  return { id: SOURCE_ID, agentId: AGENT_ID, run };
}

module.exports = {
  OMP_USAGE_ARGS,
  OMP_TIMEOUT_MS,
  OMP_PROVIDER_LABELS,
  classifyOmpLimit,
  mapOmpUsageReport,
  parseOmpUsageOutput,
  collectChildOutput,
  outputToResult,
  createOmpUsageSource,
};
