"use strict";

// Quota section of the Session HUD (session-hud.html). Loaded as a classic
// script beside session-hud-renderer.js, so everything stays inside this IIFE
// and only `ClawdHudQuota` is shared: the session renderer hands it the
// container and the snapshot's `quota` payload on every render.
(function initHudQuota(root) {
const DEFAULT_QUOTA_STALE_AFTER_MS = 5 * 60 * 1000;
const PROVIDER_STALE_AFTER_MS = Object.freeze({ kimiQuota: 7 * 60 * 1000 });
const EXTRA_HIDDEN_PREFIX = "extra:";
const EXTRA_PALETTE_KEY = "extraQuota";
const EXTRA_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const WARN_AT = 60;
const HOT_AT = 85;

// Mirrors RING_PROVIDERS in quota-ring-geometry.js; the renderer runs in a
// browser context and cannot require that CommonJS module.
const RING_PROVIDERS = [
  {
    key: "antigravityQuota",
    label: "Antigravity",
    outer: [
      { field: "geminiFiveHour", fallback: "5h" },
      { field: "thirdPartyFiveHour", fallback: "5h" },
    ],
    inner: [
      { field: "geminiWeekly", fallback: "7d" },
      { field: "thirdPartyWeekly", fallback: "7d" },
    ],
  },
  { key: "claudeQuota", label: "Claude", outer: [{ field: "claudeFiveHour", fallback: "5h" }], inner: [{ field: "claudeWeekly", fallback: "7d" }] },
  { key: "codexQuota", label: "Codex", outer: [{ field: "codexFiveHour", fallback: "5h" }], inner: [{ field: "codexWeekly", fallback: "7d" }] },
  { key: "kimiQuota", label: "Kimi", outer: [{ field: "kimiFiveHour", fallback: "5h" }], inner: [{ field: "kimiWeekly", fallback: "7d" }] },
];

function isExtraWindowLimit(limit) {
  return !!limit && typeof limit === "object" && limit.kind === "window"
    && Number.isFinite(Number(limit.usedPercent));
}

function isExtraBalanceLimit(limit) {
  return !!limit && typeof limit === "object" && limit.kind === "balance"
    && typeof limit.remaining === "number" && Number.isFinite(limit.remaining);
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
    const label = typeof provider.label === "string" && provider.label ? provider.label : id;
    entries.push({ id, key: `${EXTRA_HIDDEN_PREFIX}${id}`, label, provider });
  }
  entries.sort(compareExtraEntries);
  return entries;
}

function extraWindowMinutes(limit) {
  const minutes = Number(limit && limit.windowMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

// Mirrors selectExtraRingLimits in quota-ring-geometry.js: `outer` (shortest
// sub-day window), `inner` (weekly or first day-plus window) and `third` (the
// longest window left — an unknown-length calendar month counts as longest —
// else the balance). Balance-only providers keep the `balance` shape.
function selectExtraRingLimits(limits) {
  const list = Array.isArray(limits) ? limits : [];
  const windows = list.filter(isExtraWindowLimit);
  const balance = list.find(isExtraBalanceLimit) || null;
  if (!windows.length) {
    return balance ? { outer: null, inner: null, third: null, balance } : null;
  }
  let outer = null;
  for (const limit of windows) {
    const minutes = extraWindowMinutes(limit);
    if (minutes === null || minutes >= DAY_MINUTES) continue;
    if (!outer || minutes < extraWindowMinutes(outer)) outer = limit;
  }
  if (!outer) outer = windows[0];
  const long = windows.filter((limit) => limit !== outer
    && extraWindowMinutes(limit) !== null && extraWindowMinutes(limit) >= DAY_MINUTES);
  const inner = long.find((limit) => extraWindowMinutes(limit) === WEEK_MINUTES) || long[0] || null;
  const span = (limit) => extraWindowMinutes(limit) ?? Infinity;
  let third = null;
  for (const limit of windows) {
    if (limit === outer || limit === inner) continue;
    if (!third || span(limit) > span(third)) third = limit;
  }
  return { outer, inner, third: third || balance, balance: null };
}

const BALANCE_SYMBOLS = Object.freeze({ usd: "$", cny: "¥", eur: "€" });

function formatBalanceAmount(remaining, unit) {
  const value = Number(remaining);
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const compact = (n, suffix) => `${(Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "")}${suffix}`;
  let digits;
  if (abs >= 1_000_000) digits = compact(abs / 1_000_000, "M");
  else if (abs >= 1_000) digits = compact(abs / 1_000, "k");
  else digits = abs.toFixed(2);
  const sign = value < 0 ? "-" : "";
  const key = typeof unit === "string" ? unit.toLowerCase() : "";
  if (BALANCE_SYMBOLS[key]) return `${sign}${BALANCE_SYMBOLS[key]}${digits}`;
  const suffix = key === "credits" ? "cr" : (typeof unit === "string" && unit ? unit : "");
  return `${sign}${digits}${suffix ? ` ${suffix}` : ""}`;
}

function glyphLetter(label) {
  const match = typeof label === "string" ? label.trim().match(/[\p{L}\p{N}]/u) : null;
  return match ? match[0].toUpperCase() : "?";
}

const EMPTY_PAYLOAD = Object.freeze({
  accountQuota: [],
  quotaAgentIcons: {},
  displayMode: "used",
  hiddenQuotaProviders: [],
  visibleRows: 0,
  overflow: 0,
});
let payload = EMPTY_PAYLOAD;
let clusterEl = null;

function normalizePayload(next) {
  if (!next || typeof next !== "object") return EMPTY_PAYLOAD;
  return {
    accountQuota: Array.isArray(next.accountQuota) ? next.accountQuota : [],
    quotaAgentIcons: next.quotaAgentIcons || {},
    displayMode: next.displayMode === "remaining" ? "remaining" : "used",
    hiddenQuotaProviders: Array.isArray(next.hiddenQuotaProviders) ? next.hiddenQuotaProviders : [],
    visibleRows: Number.isInteger(next.visibleRows) ? next.visibleRows : 0,
    overflow: Number.isInteger(next.overflow) ? next.overflow : 0,
  };
}

function quotaDisplayMode() {
  return payload && payload.displayMode === "remaining" ? "remaining" : "used";
}

function quotaDisplayPercent(usedPercent) {
  const used = Math.max(0, Math.min(100, Number(usedPercent) || 0));
  return quotaDisplayMode() === "remaining" ? 100 - used : used;
}

function formatWindowLabel(windowMinutes, fallbackLabel) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel;
  if (minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

// Mirrors formatExtraWindowLabel in quota-ring-geometry.js.
function formatExtraWindowLabel(limit) {
  const raw = limit && typeof limit.label === "string" ? limit.label.trim() : "";
  const minutes = Number(limit && limit.windowMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return formatWindowLabel(minutes, raw);
  if (/month/i.test(raw)) return "1mo";
  return raw.replace(/\s+limit$/i, "") || raw;
}

function severityClass(usedPercent) {
  const p = Number(usedPercent);
  if (!Number.isFinite(p)) return "sev-ok";
  if (p > HOT_AT) return "sev-hot";
  if (p >= WARN_AT) return "sev-warn";
  return "sev-ok";
}

function staleAfterMs(providerKey) {
  return PROVIDER_STALE_AFTER_MS[providerKey] || DEFAULT_QUOTA_STALE_AFTER_MS;
}

function liveBucket(group, field, now) {
  const bucket = group && group[field];
  if (!bucket || typeof bucket !== "object") return null;
  if (bucket.expired === true || (Number.isFinite(bucket.resetAt) && bucket.resetAt <= now)) {
    return { ...bucket, usedPercent: 0, expired: true };
  }
  return bucket;
}

function providerSeenAt(provider) {
  const lastSeenAt = Number(provider && provider.lastSeenAt);
  if (Number.isFinite(lastSeenAt)) return lastSeenAt;
  const updatedAt = Number(provider && provider.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : null;
}

function providerHasDrawableQuota(source, def) {
  const provider = source && source[def.key];
  const group = provider && provider.group;
  if (!group) return false;
  return [...def.outer, ...def.inner].some((candidate) =>
    group[candidate.field] && typeof group[candidate.field] === "object");
}

function selectWindow(group, candidates, now, ring, providerSeenAtValue, providerKey) {
  let selected = null;
  for (const candidate of candidates) {
    const bucket = liveBucket(group, candidate.field, now);
    if (!bucket) continue;
    const reset = bucket.expired === true;
    const pct = Math.max(0, Math.min(100, Number(bucket.usedPercent) || 0));
    const bucketSeenAt = Number(bucket.lastSeenAt);
    const seenAt = Number.isFinite(bucketSeenAt) ? bucketSeenAt : providerSeenAtValue;
    const stale = Number.isFinite(seenAt) && now - seenAt > staleAfterMs(providerKey);
    if (!selected
        || (selected.reset && !reset)
        || (selected.reset === reset && selected.stale && !stale)
        || (selected.reset === reset && selected.stale === stale && pct > selected.pct)) {
      selected = { bucket, candidate, reset, pct, stale, seenAt };
    }
  }
  if (!selected) return null;
  return {
    pct: selected.pct,
    label: formatWindowLabel(selected.bucket.windowMinutes, selected.candidate.fallback),
    reset: selected.reset,
    resetAt: selected.bucket.resetAt,
    ring,
    field: selected.candidate.field,
    windowMinutes: selected.bucket.windowMinutes,
    stale: selected.stale,
    seenAt: selected.seenAt,
  };
}

function sourceIdentity(source) {
  return {
    host: typeof source.host === "string" && source.host ? source.host : null,
    sourceKey: source.sourceKey === undefined ? null : source.sourceKey,
  };
}

// `third` is an extra provider's third window, drawn first (longest) in the
// long-window hue.
function assembleWindowRow(identity, outer, inner, third = null) {
  const windows = [];
  if (outer) windows.push(outer);
  if (inner) windows.push(inner);
  if (third) windows.push(third);
  const stale = windows.every((item) => item.stale);
  return { ...identity, kind: "window", windows, state: windows.every((item) => item.reset) ? "reset" : stale ? "stale" : "live" };
}

function buildProviderRow(source, def, now) {
  const provider = source[def.key];
  const group = provider && provider.group;
  if (!group) return null;
  const seenAt = providerSeenAt(provider);
  const outer = selectWindow(group, def.outer, now, "outer", seenAt, def.key);
  const inner = selectWindow(group, def.inner, now, "inner", seenAt, def.key);
  if (!outer && !inner) return null;
  return assembleWindowRow({
    providerKey: def.key,
    paletteKey: def.key,
    label: def.label,
    ...sourceIdentity(source),
    glyphUrl: payload.quotaAgentIcons && payload.quotaAgentIcons[def.key],
    glyphLetter: null,
  }, outer, inner);
}

function extraWindow(limit, ring, now, seenAt, slot = ring) {
  const resetAt = Number(limit.resetAt);
  const reset = limit.expired === true || (Number.isFinite(resetAt) && resetAt <= now);
  const pct = reset ? 0 : Math.max(0, Math.min(100, Number(limit.usedPercent) || 0));
  const limitSeenAt = Number(limit.lastSeenAt);
  const observedAt = Number.isFinite(limitSeenAt) ? limitSeenAt : seenAt;
  const stale = Number.isFinite(observedAt) && now - observedAt > staleAfterMs(EXTRA_PALETTE_KEY);
  return {
    pct,
    label: formatExtraWindowLabel(limit),
    slot,
    reset,
    resetAt: Number.isFinite(resetAt) ? resetAt : undefined,
    ring,
    field: typeof limit.id === "string" ? limit.id : "",
    windowMinutes: limit.windowMinutes,
    stale,
    seenAt: observedAt,
  };
}

function buildExtraProviderRow(source, entry, now) {
  const selected = selectExtraRingLimits(entry.provider.limits);
  if (!selected) return null;
  const seenAt = providerSeenAt(entry.provider);
  const identity = {
    providerKey: entry.key,
    paletteKey: EXTRA_PALETTE_KEY,
    label: entry.label,
    ...sourceIdentity(source),
    glyphUrl: null,
    glyphLetter: glyphLetter(entry.label),
  };
  if (selected.balance) {
    const stale = Number.isFinite(seenAt) && now - seenAt > staleAfterMs(EXTRA_PALETTE_KEY);
    return {
      ...identity,
      kind: "balance",
      windows: [],
      balance: { remaining: selected.balance.remaining, unit: selected.balance.unit,
        text: formatBalanceAmount(selected.balance.remaining, selected.balance.unit) },
      state: stale ? "stale" : "live",
    };
  }
  const third = selected.third;
  const thirdWindow = third && third.kind === "window"
    ? extraWindow(third, "inner", now, seenAt, "third")
    : null;
  // A balance beside window limits stands in for the long (monthly) slot.
  const balance = third && third.kind === "balance"
    ? { remaining: third.remaining, unit: third.unit, text: formatBalanceAmount(third.remaining, third.unit) }
    : null;
  const outerMinutes = extraWindowMinutes(selected.outer);
  const row = !selected.inner && outerMinutes !== null && outerMinutes >= DAY_MINUTES
    ? assembleWindowRow(identity, null, extraWindow(selected.outer, "inner", now, seenAt), thirdWindow)
    : assembleWindowRow(identity,
      extraWindow(selected.outer, "outer", now, seenAt),
      selected.inner ? extraWindow(selected.inner, "inner", now, seenAt) : null,
      thirdWindow);
  return balance ? { ...row, balance } : row;
}

function hiddenProviderSet() {
  const hidden = Array.isArray(payload.hiddenQuotaProviders) ? payload.hiddenQuotaProviders : [];
  const keys = hidden.filter((key) => typeof key === "string" && key);
  return keys.length ? new Set(keys) : null;
}

function collectQuotaRows(now = Date.now()) {
  const sources = Array.isArray(payload.accountQuota) ? payload.accountQuota : [];
  const hidden = hiddenProviderSet();
  const isHidden = (key) => !!(hidden && hidden.has(key));
  const rows = [];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const def of RING_PROVIDERS) {
      if (isHidden(def.key) || !providerHasDrawableQuota(source, def)) continue;
      const model = buildProviderRow(source, def, now);
      if (model) rows.push(model);
    }
    for (const entry of extraProviderEntries(source)) {
      if (isHidden(entry.key)) continue;
      const model = buildExtraProviderRow(source, entry, now);
      if (model) rows.push(model);
    }
  }
  return rows;
}

function createElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function attachDashboardClick(row) {
  row.addEventListener("click", () => window.sessionHudAPI.openDashboard());
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      window.sessionHudAPI.openDashboard();
    }
  });
}

// The quota section is a table: every row places its values in shared
// columns, longest window first — `long` (a third/monthly window or a
// balance), `week` (the inner ring) and `short` (the outer ring) — so a 7d
// value lines up under every other row's 7d even when a row lacks a column.
// quota-ring-geometry.js mirrors this mapping for the width estimate.
function valueColumn(item) {
  if (item.slot === "third") return "long";
  return item.ring === "inner" ? "week" : "short";
}

function identityClasses(model, window, column = valueColumn(window)) {
  const severity = window.reset ? "sev-reset" : severityClass(window.pct);
  return `quota-value pv-${model.paletteKey} rg-${window.ring} ${severity} quota-col-${column}`;
}

function displayedWindowPercent(item) {
  if (item.reset) return quotaDisplayMode() === "remaining" ? 100 : 0;
  return Math.round(quotaDisplayPercent(item.pct));
}

// Time left until a window resets, in at most two units so it fits inside the
// window's parentheses on the one quota line: "3d4h", "12d", "2h13m", "13h",
// "45m". Minutes round up so a live window never reads "0m" and the text
// changes on the same minute boundary the fingerprint re-renders on.
function formatResetCountdown(resetAt, now) {
  const ms = Number(resetAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / DAY_MINUTES);
  const hours = Math.floor((totalMinutes % DAY_MINUTES) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return days < 10 && hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return hours < 10 && minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

// One window reads "7d(2d2h) 29%": window label, time to reset in smaller
// type inside parentheses, then the percentage. The cell is a baseline flex
// box that pins the percentage to its right edge, so percentages line up
// down a column; the leading space keeps the text readable as plain text.
function buildWindowValue(model, item, now) {
  const value = createElement("span", identityClasses(model, item));
  value.appendChild(createElement("span", "quota-window-label", item.label));
  // A window that already reset reads 0% (or 100% left); a countdown would
  // point at the next cycle the snapshot has not reported yet.
  const countdown = item.reset ? "" : formatResetCountdown(item.resetAt, now);
  if (countdown) value.appendChild(createElement("span", "quota-reset-in", `(${countdown})`));
  value.appendChild(createElement("span", "quota-window-pct", ` ${displayedWindowPercent(item)}%`));
  return value;
}

function buildQuotaRow(model, now) {
  const row = createElement("div", `quota-row${model.state === "stale" ? " is-stale" : ""}`);
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  attachDashboardClick(row);

  if (model.glyphUrl) {
    const glyph = createElement("img", "provider-glyph");
    glyph.setAttribute("src", model.glyphUrl);
    glyph.setAttribute("alt", "");
    row.appendChild(glyph);
  } else {
    const glyph = createElement("span", "provider-glyph extra-glyph", model.glyphLetter || glyphLetter(model.label));
    row.appendChild(glyph);
  }

  const identity = createElement("span", "provider-identity");
  identity.appendChild(createElement("span", "provider-label", model.label));
  if (model.host) identity.appendChild(createElement("span", "provider-host", ` · ${model.host}`));
  row.appendChild(identity);

  const values = createElement("span", "quota-values");
  if (model.kind === "balance") {
    values.appendChild(createElement("span", identityClasses(model, { ring: "outer", pct: 0 }, "long"), model.balance.text));
  } else {
    if (model.balance) {
      values.appendChild(createElement("span", identityClasses(model, { ring: "inner", pct: 0 }, "long"), model.balance.text));
    }
    // DOM order follows the columns: long, week, short.
    const slotOrder = (item) => (item.slot === "third" ? 0 : item.ring === "inner" ? 1 : 2);
    const windows = [...model.windows].sort((a, b) =>
      slotOrder(a) - slotOrder(b) || (Number(b.windowMinutes) || 0) - (Number(a.windowMinutes) || 0));
    for (const item of windows) values.appendChild(buildWindowValue(model, item, now));
  }
  row.appendChild(values);
  return row;
}

function buildOverflowRow(count) {
  const row = createElement("div", "quota-row quota-overflow", `+${count}`);
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  attachDashboardClick(row);
  return row;
}

let lastFingerprint = "";
function fingerprint(now) {
  return JSON.stringify({ mode: quotaDisplayMode(), rows: collectQuotaRows(now).map((row) => ({
    key: row.providerKey,
    host: row.host,
    state: row.state,
    windows: row.windows.map((item) => [item.ring, item.field, item.pct, item.reset, item.stale,
      Number.isFinite(item.resetAt) && item.resetAt > now ? Math.ceil((item.resetAt - now) / 60000) : 0,
      item.stale && Number.isFinite(item.seenAt) ? Math.floor((now - item.seenAt) / 60000) : 0]),
    balance: row.balance && row.balance.text,
  })) });
}

const COLUMN_ORDER = ["long", "week", "short"];

function modelColumns(model) {
  const columns = new Set(model.windows.map(valueColumn));
  if (model.balance) columns.add("long");
  return columns;
}

// One vertical rule at the start of every used value column after the
// first, spanning the provider rows, so long/week/short read as separate
// columns even where a row leaves a cell empty.
function buildColumnRules(models, overflow) {
  const used = new Set();
  for (const model of models) for (const column of modelColumns(model)) used.add(column);
  const columns = COLUMN_ORDER.filter((column) => used.has(column));
  return columns.slice(1).map((column) => {
    const rule = createElement("div", `quota-col-rule quota-col-${column}${overflow > 0 ? " above-overflow" : ""}`);
    rule.setAttribute("aria-hidden", "true");
    return rule;
  });
}

function render() {
  if (!clusterEl) return;
  const now = Date.now();
  lastFingerprint = fingerprint(now);
  clusterEl.replaceChildren();
  // visibleRows is the count main sized the window for; with none, the
  // section stays empty and takes no height.
  if (!Number.isInteger(payload.visibleRows) || payload.visibleRows <= 0) return;
  const rows = collectQuotaRows(now);
  if (!rows.length) return;
  const overflow = Math.max(0, payload.overflow);
  const providerLimit = overflow > 0 ? Math.max(0, payload.visibleRows - 1) : payload.visibleRows;
  const visible = rows.slice(0, providerLimit);
  for (const model of visible) clusterEl.appendChild(buildQuotaRow(model, now));
  if (overflow > 0) clusterEl.appendChild(buildOverflowRow(overflow));
  for (const rule of buildColumnRules(visible, overflow)) clusterEl.appendChild(rule);
}

// Reset times and staleness move on their own; re-render only when what the
// rows would show actually changed.
function tick() {
  if (!clusterEl) return;
  if (fingerprint(Date.now()) !== lastFingerprint) render();
}

root.ClawdHudQuota = {
  update(container, nextPayload) {
    clusterEl = container || null;
    payload = normalizePayload(nextPayload);
    render();
  },
  // Read-only view of the rows a payload would produce; the mounted section
  // keeps its own payload.
  collectQuotaRows(nextPayload, now = Date.now()) {
    const current = payload;
    payload = normalizePayload(nextPayload);
    try {
      return collectQuotaRows(now);
    } finally {
      payload = current;
    }
  },
};
setInterval(tick, 1000);
})(globalThis);
