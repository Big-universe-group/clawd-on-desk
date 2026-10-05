"use strict";

const {
  RING_PROVIDERS,
  extraProviderEntries,
  selectExtraRingLimits,
  formatWindowLabel,
  formatExtraWindowLabel,
  listQuotaRingProviders,
  providerHasDrawableQuota,
} = require("./quota-ring-geometry");

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const KIMI_STALE_AFTER_MS = 7 * 60 * 1000;
const BALANCE_SYMBOLS = Object.freeze({ usd: "$", cny: "¥", eur: "€" });

function formatBalanceAmount(remaining, unit) {
  const value = Number(remaining);
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const compact = (number, suffix) => `${(Math.round(number * 10) / 10).toFixed(1).replace(/\.0$/, "")}${suffix}`;
  let digits;
  if (abs >= 1e6) digits = compact(abs / 1e6, "M");
  else if (abs >= 1000) digits = compact(abs / 1000, "k");
  else digits = abs.toFixed(2);
  const sign = value < 0 ? "-" : "";
  const key = typeof unit === "string" ? unit.toLowerCase() : "";
  if (BALANCE_SYMBOLS[key]) return `${sign}${BALANCE_SYMBOLS[key]}${digits}`;
  if (!key || key === "credits") return `${sign}${digits} cr`;
  return `${sign}${digits} ${unit}`;
}

function isExpiredWindow(bucket, now) {
  return bucket.expired === true || (Number.isFinite(bucket.resetAt) && bucket.resetAt <= now);
}

function fixedWindowCandidate(provider, fields, providerKey, now, ring, displayMode) {
  const group = provider && provider.group;
  if (!group) return null;
  const providerSeenAt = Number(provider.lastSeenAt);
  const updatedAt = Number(provider.updatedAt);
  const fallbackSeenAt = Number.isFinite(providerSeenAt) ? providerSeenAt : updatedAt;
  const staleAfterMs = providerKey === "kimiQuota" ? KIMI_STALE_AFTER_MS : DEFAULT_STALE_AFTER_MS;
  let selected = null;
  for (const field of fields) {
    const bucket = group[field];
    if (!bucket || typeof bucket !== "object") continue;
    const expired = isExpiredWindow(bucket, now);
    const used = expired ? 0 : Math.max(0, Math.min(100, Number(bucket.usedPercent) || 0));
    const bucketSeenAt = Number(bucket.lastSeenAt);
    const seenAt = Number.isFinite(bucketSeenAt) ? bucketSeenAt : fallbackSeenAt;
    const stale = Number.isFinite(seenAt) && now - seenAt > staleAfterMs;
    const candidate = { bucket, expired, used, stale };
    if (!selected
      || (selected.expired && !candidate.expired)
      || (selected.expired === candidate.expired && selected.stale && !candidate.stale)
      || (selected.expired === candidate.expired && selected.stale === candidate.stale && candidate.used > selected.used)) {
      selected = candidate;
    }
  }
  if (!selected) return null;
  const fallback = ring === "inner" ? "7d" : "5h";
  const label = formatWindowLabel(selected.bucket.windowMinutes, fallback);
  const used = selected.expired ? 0 : selected.used;
  const percent = displayMode === "remaining" ? 100 - used : used;
  return `${label} ${Math.round(percent)}%`;
}

function formatExtraWindow(limit, now, displayMode) {
  const expired = isExpiredWindow(limit, now);
  const used = expired ? 0 : Math.max(0, Math.min(100, Number(limit.usedPercent) || 0));
  const percent = displayMode === "remaining" ? 100 - used : used;
  return `${formatExtraWindowLabel(limit)} ${Math.round(percent)}%`;
}

// Longest first, like the HUD row: a window without a fixed length (a month)
// sorts ahead of everything, and a balance standing in for it leads the line.
function extraWindowSpan(limit) {
  const minutes = Number(limit.windowMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : Infinity;
}

function buildQuotaTrayLines(snapshot, options = {}) {
  const sources = snapshot && Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [];
  if (!sources.length) return [];
  const displayMode = options.displayMode === "remaining" ? "remaining" : "used";
  const hiddenProviders = options.hiddenProviders;
  const visibleKeys = new Set(
    listQuotaRingProviders(snapshot, hiddenProviders)
      .filter((provider) => !provider.hidden)
      .map((provider) => provider.key)
  );
  const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
  const lines = [];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const hostSuffix = typeof source.host === "string" && source.host ? ` (${source.host})` : "";
    for (const definition of RING_PROVIDERS) {
      if (!visibleKeys.has(definition.key) || !providerHasDrawableQuota(source, definition)) continue;
      const provider = source[definition.key];
      const windows = [];
      const inner = fixedWindowCandidate(provider, definition.inner, definition.key, now, "inner", displayMode);
      const outer = fixedWindowCandidate(provider, definition.outer, definition.key, now, "outer", displayMode);
      if (inner) windows.push(inner);
      if (outer) windows.push(outer);
      if (windows.length) lines.push(`${definition.label}${hostSuffix}  ${windows.join(" · ")}`);
    }
    for (const entry of extraProviderEntries(source)) {
      if (!visibleKeys.has(entry.key)) continue;
      const selected = selectExtraRingLimits(entry.provider.limits);
      if (!selected) continue;
      if (selected.outer || selected.inner) {
        const parts = [];
        const third = selected.third;
        if (third && third.kind === "balance") parts.push(formatBalanceAmount(third.remaining, third.unit));
        const windows = [selected.outer, selected.inner, third && third.kind === "window" ? third : null]
          .filter(Boolean)
          .sort((a, b) => extraWindowSpan(b) - extraWindowSpan(a));
        for (const limit of windows) parts.push(formatExtraWindow(limit, now, displayMode));
        lines.push(`${entry.label}${hostSuffix}  ${parts.join(" · ")}`);
      } else if (selected.balance) {
        lines.push(`${entry.label}${hostSuffix}  ${formatBalanceAmount(selected.balance.remaining, selected.balance.unit)}`);
      }
    }
  }
  return lines;
}

function createQuotaTrayRefreshScheduler(options = {}) {
  const isEnabled = typeof options.isEnabled === "function" ? options.isEnabled : () => false;
  const refresh = typeof options.refresh === "function" ? options.refresh : () => {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const scheduleTimeout = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const cancelTimeout = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 0
    ? options.intervalMs
    : 30 * 1000;
  let lastRefreshAt = -Infinity;
  let pendingTimer = null;

  function clearPending() {
    if (pendingTimer !== null) cancelTimeout(pendingTimer);
    pendingTimer = null;
  }

  function run(force) {
    clearPending();
    if (!force && !isEnabled()) return false;
    lastRefreshAt = now();
    refresh();
    return true;
  }

  function request() {
    if (!isEnabled()) return false;
    if (pendingTimer !== null) return false;
    const delay = Math.max(0, intervalMs - (now() - lastRefreshAt));
    if (delay === 0) return run(false);
    pendingTimer = scheduleTimeout(() => {
      pendingTimer = null;
      run(false);
    }, delay);
    if (pendingTimer && typeof pendingTimer.unref === "function") pendingTimer.unref();
    return true;
  }

  return {
    request,
    refreshNow: () => run(true),
    cancel: clearPending,
  };
}

module.exports = {
  buildQuotaTrayLines,
  createQuotaTrayRefreshScheduler,
};
