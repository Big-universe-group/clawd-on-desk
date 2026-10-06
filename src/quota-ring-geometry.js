"use strict";

// Provider → candidate bucket fields for the two plan windows (outer = short,
// inner = long). Antigravity can report Gemini and Claude/GPT quotas; each
// window selects the most constrained candidate while Dashboard keeps detail.
// Mirrors quota-ring-renderer.js (the Session HUD's quota section) and
// supplies labels for Settings.
const RING_PROVIDERS = [
  {
    key: "antigravityQuota",
    label: "Antigravity",
    outer: ["geminiFiveHour", "thirdPartyFiveHour"],
    inner: ["geminiWeekly", "thirdPartyWeekly"],
  },
  { key: "claudeQuota", label: "Claude", outer: ["claudeFiveHour"], inner: ["claudeWeekly"] },
  { key: "codexQuota", label: "Codex", outer: ["codexFiveHour"], inner: ["codexWeekly"] },
  { key: "kimiQuota", label: "Kimi", outer: ["kimiFiveHour"], inner: ["kimiWeekly"] },
];

// Quota section of the Session HUD: one 26px row per provider, at most six
// rows (five providers plus a "+N" row past that). The box grows to at least
// QUOTA_MIN_WIDTH while it carries quota, and further to the widest row's
// estimate (estimateQuotaSectionWidth) so labels never truncate.
const QUOTA_ROW_HEIGHT = 26;
const QUOTA_MAX_ROWS = 6;
const QUOTA_MIN_WIDTH = 280;
// Row width model, CSS px at text scale 1, measured from the HUD's system
// font (session-hud.html): 20 row padding + 16 glyph + two 8px gaps around
// the identity, 8px between values. A window value is "7d(5d12h) 100%": its
// label in 12px bold (~8px/char), a countdown of at most "(5d12h)" in 10px
// (~40px) and " 100%" (~39px). Balances take at most ~9 bold chars.
const QUOTA_ROW_CHROME_WIDTH = 20 + 16 + 8 + 8;
const QUOTA_VALUE_GAP = 8;
const QUOTA_CHAR_WIDTH = 8;
const QUOTA_WIDE_CHAR_WIDTH = 13;
const QUOTA_WINDOW_FIXED_WIDTH = 40 + 39;
const QUOTA_BALANCE_WIDTH = 9 * QUOTA_CHAR_WIDTH;
const EXTRA_HIDDEN_PREFIX = "extra:";
const EXTRA_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

function providerHasDrawableQuota(source, def) {
  const entry = source && source[def.key];
  const group = entry && entry.group;
  if (!group) return false;
  return [...def.outer, ...def.inner].some((field) =>
    group[field] && typeof group[field] === "object");
}

function hiddenProviderSet(hiddenProviders) {
  if (!Array.isArray(hiddenProviders)) return null;
  const hidden = hiddenProviders.filter((key) => typeof key === "string" && key);
  return hidden.length ? new Set(hidden) : null;
}

function isProviderDrawn(source, def, hidden) {
  return !(hidden && hidden.has(def.key)) && providerHasDrawableQuota(source, def);
}

function extraHiddenKey(providerId) {
  return `${EXTRA_HIDDEN_PREFIX}${providerId}`;
}

function isExtraWindowLimit(limit) {
  return !!limit && typeof limit === "object" && limit.kind === "window"
    && Number.isFinite(Number(limit.usedPercent));
}

function isExtraBalanceLimit(limit) {
  return !!limit && typeof limit === "object" && limit.kind === "balance"
    && typeof limit.remaining === "number" && Number.isFinite(limit.remaining);
}

function extraProviderLabel(providerId, provider) {
  return typeof provider.label === "string" && provider.label ? provider.label : providerId;
}

function compareExtraEntries(a, b) {
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function extraProviderEntries(source) {
  const extra = source && source.extraQuota;
  if (!extra || typeof extra !== "object") return [];
  const entries = [];
  for (const [id, provider] of Object.entries(extra)) {
    if (!EXTRA_PROVIDER_ID_RE.test(id) || !provider || typeof provider !== "object") continue;
    const limits = Array.isArray(provider.limits) ? provider.limits : [];
    if (!limits.some((limit) => isExtraWindowLimit(limit) || isExtraBalanceLimit(limit))) continue;
    entries.push({ id, key: extraHiddenKey(id), label: extraProviderLabel(id, provider), provider });
  }
  entries.sort(compareExtraEntries);
  return entries;
}

// A PLAN row shows up to three values: `outer` (the shortest sub-day window),
// `inner` (the weekly — or first — day-plus window) and `third`: the longest
// window still left (a calendar month has no fixed length, so it counts as
// longest) or, when no window is left, the provider's balance. Balance-only
// providers keep the `balance` shape.
function selectExtraRingLimits(limits) {
  const list = Array.isArray(limits) ? limits : [];
  const windows = list.filter(isExtraWindowLimit);
  const balance = list.find(isExtraBalanceLimit) || null;
  if (!windows.length) {
    return balance ? { outer: null, inner: null, third: null, balance } : null;
  }
  const minutesOf = (limit) => {
    const minutes = Number(limit.windowMinutes);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  };
  let outer = null;
  for (const limit of windows) {
    const minutes = minutesOf(limit);
    if (minutes === null || minutes >= DAY_MINUTES) continue;
    if (!outer || minutes < minutesOf(outer)) outer = limit;
  }
  if (!outer) outer = windows[0];
  const long = windows.filter((limit) => limit !== outer
    && minutesOf(limit) !== null && minutesOf(limit) >= DAY_MINUTES);
  const inner = long.find((limit) => minutesOf(limit) === WEEK_MINUTES) || long[0] || null;
  const span = (limit) => minutesOf(limit) ?? Infinity;
  let third = null;
  for (const limit of windows) {
    if (limit === outer || limit === inner) continue;
    if (!third || span(limit) > span(third)) third = limit;
  }
  return { outer, inner, third: third || balance, balance: null };
}

function countQuotaCoins(snapshot, showQuota, hiddenProviders) {
  if (showQuota === false) return 0;
  const sources = snapshot && Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [];
  const hidden = hiddenProviderSet(hiddenProviders);
  let count = 0;
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const def of RING_PROVIDERS) {
      if (isProviderDrawn(source, def, hidden)) count += 1;
    }
    for (const entry of extraProviderEntries(source)) {
      if (!(hidden && hidden.has(entry.key))) count += 1;
    }
  }
  return count;
}

function listQuotaRingProviders(snapshot, hiddenProviders) {
  const sources = (snapshot && Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [])
    .filter((source) => source && typeof source === "object");
  const hidden = hiddenProviderSet(hiddenProviders);
  const seen = [];
  for (const def of RING_PROVIDERS) {
    if (!sources.some((source) => providerHasDrawableQuota(source, def))) continue;
    seen.push({ key: def.key, label: def.label, hidden: !!(hidden && hidden.has(def.key)) });
  }
  const extras = new Map();
  for (const source of sources) {
    for (const entry of extraProviderEntries(source)) {
      if (!extras.has(entry.key)) extras.set(entry.key, entry);
    }
  }
  for (const entry of [...extras.values()].sort(compareExtraEntries)) {
    seen.push({ key: entry.key, label: entry.label, hidden: !!(hidden && hidden.has(entry.key)) });
  }
  return seen;
}

function formatWindowLabel(windowMinutes, fallbackLabel) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel;
  if (minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

// Compact label for an extra-provider window: its duration when it has one
// ("5h", "7d"), otherwise a short form of the reporter's label — a calendar
// month becomes "1mo", and a trailing " limit" is dropped.
function formatExtraWindowLabel(limit) {
  const raw = limit && typeof limit.label === "string" ? limit.label.trim() : "";
  const minutes = Number(limit && limit.windowMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return formatWindowLabel(minutes, raw);
  if (/month/i.test(raw)) return "1mo";
  return raw.replace(/\s+limit$/i, "") || raw;
}

function quotaSeverity(usedPercent) {
  const p = Number(usedPercent);
  if (!Number.isFinite(p)) return "ok";
  if (p > 85) return "hot";
  if (p >= 60) return "warn";
  return "ok";
}

// Visible rows for `providerCount` drawable providers: all of them up to the
// cap, otherwise the cap with its last row given to a "+N" overflow entry.
function computeQuotaSectionLayout(providerCount) {
  const total = Math.max(0, Math.floor(Number(providerCount) || 0));
  return {
    visibleRows: Math.min(total, QUOTA_MAX_ROWS),
    overflow: total > QUOTA_MAX_ROWS ? total - (QUOTA_MAX_ROWS - 1) : 0,
  };
}

function estimateTextWidth(text) {
  let width = 0;
  for (const ch of String(text || "")) {
    width += ch.codePointAt(0) >= 0x2e80 ? QUOTA_WIDE_CHAR_WIDTH : QUOTA_CHAR_WIDTH;
  }
  return width;
}

function estimateWindowWidth(label) {
  return estimateTextWidth(label) + QUOTA_WINDOW_FIXED_WIDTH;
}

function estimateRowWidth(label, host, valueWidths) {
  if (!valueWidths.length) return 0;
  const identity = estimateTextWidth(label) + (host ? estimateTextWidth(` · ${host}`) : 0);
  const values = valueWidths.reduce((sum, width) => sum + width, 0)
    + QUOTA_VALUE_GAP * (valueWidths.length - 1);
  return QUOTA_ROW_CHROME_WIDTH + identity + values;
}

function ringProviderValueWidths(group, def) {
  const widths = [];
  for (const fields of [def.inner, def.outer]) {
    const field = fields.find((name) => group[name] && typeof group[name] === "object");
    if (!field) continue;
    const fallback = fields === def.inner ? "7d" : "5h";
    widths.push(estimateWindowWidth(formatWindowLabel(group[field].windowMinutes, fallback)));
  }
  return widths;
}

function extraProviderValueWidths(provider) {
  const selected = selectExtraRingLimits(provider.limits);
  if (!selected) return [];
  if (selected.balance) return [QUOTA_BALANCE_WIDTH];
  const widths = [];
  for (const limit of [selected.third, selected.inner, selected.outer]) {
    if (!limit) continue;
    widths.push(isExtraBalanceLimit(limit)
      ? QUOTA_BALANCE_WIDTH
      : estimateWindowWidth(formatExtraWindowLabel(limit)));
  }
  return widths;
}

// Row width (CSS px, text scale 1) the widest visible quota row needs to show
// its label and every "label(countdown) percent" value without truncation;
// 0 when no row is drawn. Walks providers in the renderer's row order and
// stops at the rows that fit before a "+N" overflow row.
function estimateQuotaSectionWidth(snapshot, showQuota, hiddenProviders) {
  const layout = computeQuotaSectionLayout(countQuotaCoins(snapshot, showQuota, hiddenProviders));
  const rowLimit = layout.overflow > 0 ? layout.visibleRows - 1 : layout.visibleRows;
  if (rowLimit <= 0) return 0;
  const sources = snapshot && Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [];
  const hidden = hiddenProviderSet(hiddenProviders);
  let rows = 0;
  let widest = 0;
  const take = (width) => {
    rows += 1;
    widest = Math.max(widest, width);
    return rows >= rowLimit;
  };
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const host = typeof source.host === "string" && source.host ? source.host : null;
    for (const def of RING_PROVIDERS) {
      if (!isProviderDrawn(source, def, hidden)) continue;
      const width = estimateRowWidth(def.label, host, ringProviderValueWidths(source[def.key].group, def));
      if (take(width)) return Math.ceil(widest);
    }
    for (const entry of extraProviderEntries(source)) {
      if (hidden && hidden.has(entry.key)) continue;
      if (take(estimateRowWidth(entry.label, host, extraProviderValueWidths(entry.provider)))) return Math.ceil(widest);
    }
  }
  return Math.ceil(widest);
}

module.exports = {
  RING_PROVIDERS,
  countQuotaCoins,
  listQuotaRingProviders,
  formatWindowLabel,
  formatExtraWindowLabel,
  quotaSeverity,
  computeQuotaSectionLayout,
  estimateQuotaSectionWidth,
  providerHasDrawableQuota,
  extraProviderEntries,
  selectExtraRingLimits,
  extraHiddenKey,
  constants: {
    QUOTA_ROW_HEIGHT,
    QUOTA_MAX_ROWS,
    QUOTA_MIN_WIDTH,
  },
};
