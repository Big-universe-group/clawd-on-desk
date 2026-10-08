"use strict";

// ── Session-independent, per-source account quota store ──
//
// Sessions come and go (staleness sweeps evict them, the app restarts), but
// "how much of that machine's subscription is used" is not a session
// property - the headline use case is checking a remote's quota BEFORE
// starting any work there, when no session exists at all. Quota therefore
// lives here, keyed by reporting source (host prefix; null = this machine),
// and session records do not carry it.
//
// Buckets keep the absolute-resetAt convention from hooks/quota-bucket.js.
// The rate-limit windows reset on wall clock regardless of CLI activity, so
// a stored bucket whose resetAt has passed is not merely stale - it is
// wrong (it would keep showing the pre-reset high). snapshot() flags
// expired buckets (renderers dim them) and reports per-provider updatedAt
// (last value change) plus lastSeenAt (last confirmation) so the UI can
// label quiet sources ("as of N minutes ago") instead of presenting old
// numbers as live.
//
// Persisted to ~/.clawd/account-quota.json (same directory convention as
// runtime.json) so last-known numbers survive an app restart. Writes are
// debounced and atomic; a missing or corrupt file just means an empty
// store. Only quota bucket digests and host labels are ever stored - no
// tokens, no session content. windowMinutes is retained so renderers label
// the service's actual current window instead of guessing from a legacy
// field name.

const fs = require("fs");
const path = require("path");
const os = require("os");

const { readJsonFile } = require("../../hooks/shared/json-utils");
const { normalizeQuotaGroup } = require("../../hooks/shared/quota-bucket");
const { ANTIGRAVITY_QUOTA_FIELDS } = require("../../hooks/antigravity-cli/antigravity-context-usage");
const { CLAUDE_QUOTA_FIELDS } = require("../../hooks/claude-code/claude-rate-limits");
const { CODEX_QUOTA_FIELDS } = require("../../hooks/codex/codex-rate-limits");
const { KIMI_QUOTA_FIELDS } = require("../agents/kimi-cli/quota/normalizer");

const QUOTA_PROVIDER_FIELDS = {
  antigravityQuota: ANTIGRAVITY_QUOTA_FIELDS,
  claudeQuota: CLAUDE_QUOTA_FIELDS,
  codexQuota: CODEX_QUOTA_FIELDS,
  codexSparkQuota: CODEX_QUOTA_FIELDS,
  kimiQuota: KIMI_QUOTA_FIELDS,
};
const QUOTA_PROVIDER_KEYS = Object.keys(QUOTA_PROVIDER_FIELDS);

const DEFAULT_PERSIST_PATH = path.join(os.homedir(), ".clawd", "account-quota.json");
const PERSIST_DEBOUNCE_MS = 2000;

// The host label is client-supplied (hooks read it from the deploy-written
// prefix file, or fall back to the remote's hostname) and every tunnel
// forwards into the same desktop port, so it cannot be origin-verified
// here — the trust boundary is "machines the user deployed Clawd hooks to",
// exactly as for the session cards' host grouping. Sanitize shape only:
// control chars stripped, length capped, so a buggy reporter cannot pollute
// the store/persist file with unbounded or unprintable keys.
const SOURCE_HOST_MAX_LENGTH = 64;

// Hard cap on distinct reporting sources. The label cannot be
// origin-verified (see above), so without a cap a single buggy or hostile
// reporter cycling host names would grow the store, the persist file, and
// every snapshot/IPC payload without bound. 12 is far above any realistic
// personal fleet; reports for a NEW host beyond it are dropped (existing
// sources keep updating normally).
const MAX_SOURCES = 12;

// resetAt plausibility ceiling: the longest real window is 7 days, so a
// reset more than 45 days out is not a quota window — it is a corrupt or
// hostile timestamp that would otherwise pin a bucket as "live" forever.
const MAX_RESET_AHEAD_MS = 45 * 24 * 60 * 60 * 1000;

// Expired buckets render as a dimmed reset state so the gauge does not
// vanish mid-glance, but they must not be immortal: once the window reset
// this long ago with no fresh report, the source is dead and the bucket is
// dropped (and pruned from the store/persist file).
const EXPIRED_BUCKET_DROP_AFTER_MS = 48 * 60 * 60 * 1000;

// A provider record nothing has confirmed for this long is retired outright
// — covers buckets that carry no resetAt (e.g. some Antigravity windows)
// and would otherwise never age out.
const PROVIDER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// lastSeenAt is quantized to whole minutes in snapshots so that an actively
// confirming reporter (statuslines refresh sub-second) changes the snapshot
// at most once a minute — freshness stays honest without re-opening the
// broadcast storm that value-change dedup exists to close.
const SEEN_QUANTUM_MS = 60 * 1000;

// ── Generic ("extra") providers ──
// Command-style usage sources (e.g. `omp usage --json`) report providers
// Clawd has no fixed slot for (DeepSeek balance, Command Code, OpenCode Go…).
// They live under record.extraQuota[providerId] as a COMPLETE snapshot per
// provider: a report replaces that provider's limits (no per-limit merge),
// ordered by the provider-level capturedAt exactly like window-aware Codex.
// Window limits follow the fixed-bucket expiry contract; balance limits never
// expire on wall clock and are only retired by PROVIDER_RETENTION_MS.
const EXTRA_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const EXTRA_LABEL_MAX_LENGTH = 48;
const EXTRA_LIMIT_ID_MAX_LENGTH = 64;
const EXTRA_UNIT_MAX_LENGTH = 12;
const MAX_EXTRA_PROVIDERS = 16;
const MAX_EXTRA_LIMITS = 8;
// Bound the work done on a hostile/buggy report before the per-provider cap.
const MAX_EXTRA_LIMIT_CANDIDATES = 64;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Control chars stripped, code-point-safe length cap (never splits a
// surrogate pair, so CJK/emoji labels stay valid UTF-16).
function sanitizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  const chars = Array.from(cleaned);
  return (chars.length > maxLength ? chars.slice(0, maxLength).join("") : cleaned).trim();
}

// rejectReset: incoming reports drop windows that already reset (the number
// is wrong, not merely stale); persisted data keeps them so snapshot() can
// flag them expired until pruneStale retires them.
function normalizeExtraLimit(value, nowMs, rejectReset) {
  if (!isPlainObject(value)) return null;
  const id = sanitizeText(value.id, EXTRA_LIMIT_ID_MAX_LENGTH);
  if (!id) return null;
  const label = sanitizeText(value.label, EXTRA_LABEL_MAX_LENGTH)
    || sanitizeText(id, EXTRA_LABEL_MAX_LENGTH);
  if (value.kind === "window") {
    const usedPercent = finiteNumber(value.usedPercent);
    if (usedPercent === null) return null;
    const out = {
      id,
      label,
      kind: "window",
      usedPercent: Math.max(0, Math.min(100, Math.round(usedPercent))),
    };
    const windowMinutes = finiteNumber(value.windowMinutes);
    if (windowMinutes !== null && windowMinutes > 0) out.windowMinutes = Math.round(windowMinutes);
    const resetAt = finiteNumber(value.resetAt);
    if (resetAt !== null) {
      if (resetAt > nowMs + MAX_RESET_AHEAD_MS) return null;
      if (rejectReset && resetAt <= nowMs) return null;
      out.resetAt = Math.round(resetAt);
    }
    return out;
  }
  if (value.kind === "balance") {
    const remaining = finiteNumber(value.remaining);
    if (remaining === null) return null;
    const unit = sanitizeText(value.unit, EXTRA_UNIT_MAX_LENGTH).toLowerCase() || "credits";
    // 4 decimals: sub-cent float noise must not count as a value change.
    return { id, label, kind: "balance", remaining: Math.round(remaining * 10000) / 10000, unit };
  }
  return null;
}

function normalizeExtraProvider(value, providerId, nowMs, rejectReset) {
  if (!isPlainObject(value) || !Array.isArray(value.limits)) return null;
  const seenIds = new Set();
  const windows = [];
  const balances = [];
  for (const raw of value.limits.slice(0, MAX_EXTRA_LIMIT_CANDIDATES)) {
    const limit = normalizeExtraLimit(raw, nowMs, rejectReset);
    if (!limit || seenIds.has(limit.id)) continue;
    seenIds.add(limit.id);
    (limit.kind === "window" ? windows : balances).push(limit);
  }
  // Stable sort: windows by duration ascending (unknown duration last), then
  // balances, so renderers can rely on the order without re-sorting.
  windows.sort((a, b) => (a.windowMinutes || Infinity) - (b.windowMinutes || Infinity));
  const limits = windows.concat(balances).slice(0, MAX_EXTRA_LIMITS);
  if (!limits.length) return null;
  const out = {
    label: sanitizeText(value.label, EXTRA_LABEL_MAX_LENGTH) || providerId,
    limits,
  };
  const capturedAt = finiteNumber(value.capturedAt);
  if (capturedAt !== null) out.capturedAt = Math.round(capturedAt);
  return out;
}

function comparableExtraProvider(provider) {
  return JSON.stringify({ label: provider.label, limits: provider.limits });
}

function isExpiredWindowLimit(limit, nowMs) {
  return limit.kind === "window" && Number.isFinite(limit.resetAt) && limit.resetAt <= nowMs;
}

function loadExtraQuota(stored, nowMs) {
  if (!isPlainObject(stored)) return null;
  const out = {};
  let count = 0;
  for (const [providerId, raw] of Object.entries(stored)) {
    if (count >= MAX_EXTRA_PROVIDERS) break;
    if (!EXTRA_PROVIDER_ID_RE.test(providerId)) continue;
    const provider = normalizeExtraProvider(raw, providerId, nowMs, false);
    if (!provider) continue;
    const updatedAt = finiteNumber(raw.updatedAt);
    const lastSeenAt = finiteNumber(raw.lastSeenAt);
    out[providerId] = {
      ...provider,
      updatedAt: updatedAt !== null ? updatedAt : nowMs,
      lastSeenAt: lastSeenAt !== null ? lastSeenAt : (updatedAt !== null ? updatedAt : nowMs),
    };
    count++;
  }
  return count ? out : null;
}

function hasAnyProvider(record) {
  return QUOTA_PROVIDER_KEYS.some((key) => !!record[key])
    || (!!record.extraQuota && Object.keys(record.extraQuota).length > 0);
}

function normalizeSourceHost(host) {
  if (typeof host !== "string") return null;
  const cleaned = host.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned ? cleaned.slice(0, SOURCE_HOST_MAX_LENGTH) : null;
}

// Change detection must ignore capturedAt/seenAt: both advance independently
// of the displayed values, and treating either as a value change would
// broadcast on every statusline refresh.
function comparableGroup(group) {
  const out = {};
  for (const field of Object.keys(group)) {
    const { capturedAt, seenAt, ...rest } = group[field];
    out[field] = rest;
  }
  return JSON.stringify(out);
}

function hasReportedWindow(group) {
  return Object.values(group || {}).some((bucket) =>
    Number.isFinite(bucket && bucket.windowMinutes) && bucket.windowMinutes > 0);
}

function isWindowAwareCodexProvider(providerKey) {
  return providerKey === "codexQuota" || providerKey === "codexSparkQuota";
}

function newestCapture(group) {
  let newest = null;
  for (const bucket of Object.values(group || {})) {
    const capturedAt = Number(bucket && bucket.capturedAt);
    if (Number.isFinite(capturedAt)) {
      newest = newest === null ? capturedAt : Math.max(newest, capturedAt);
    }
  }
  return newest;
}

function expireBuckets(group, nowMs, rawSeenByBucket = null) {
  const out = {};
  for (const [field, bucket] of Object.entries(group)) {
    // Clone (capturedAt stripped — it is store-internal write-ordering
    // metadata): snapshot consumers must never hold live references into the
    // store, which doubles as the persistence source of truth. Per-bucket
    // seenAt is exposed as minute-quantized lastSeenAt so a partial provider
    // refresh cannot make an untouched sibling look fresh.
    // A bucket whose window reset on wall clock is kept but FLAGGED: the
    // pre-reset number would lie high, but hiding the gauge entirely reads
    // as broken — renderers show expired buckets as a dimmed reset state.
    const { capturedAt, seenAt, ...cloned } = bucket;
    const lastSeenAt = Math.floor(Number(seenAt || 0) / SEEN_QUANTUM_MS) * SEEN_QUANTUM_MS;
    const outputBucket = Number.isFinite(bucket.resetAt) && bucket.resetAt <= nowMs
      ? { ...cloned, lastSeenAt, expired: true }
      : { ...cloned, lastSeenAt };
    out[field] = outputBucket;
    if (rawSeenByBucket) rawSeenByBucket.set(outputBucket, Number(seenAt));
  }
  return Object.keys(out).length ? out : null;
}

// Drop incoming buckets the store must never accept: a window that already
// reset (the number is wrong, not merely stale), an implausibly-distant
// resetAt (would pin the bucket live forever), and observations older than
// what the store already holds (two live sessions replaying each other's
// past — write order must follow observation time, not arrival time).
function sanitizeIncomingGroup(group, existingGroup, nowMs) {
  const out = {};
  for (const [field, bucket] of Object.entries(group)) {
    if (Number.isFinite(bucket.resetAt)
      && (bucket.resetAt <= nowMs || bucket.resetAt > nowMs + MAX_RESET_AHEAD_MS)) continue;
    const existing = existingGroup && existingGroup[field];
    if (existing && Number.isFinite(existing.capturedAt) && Number.isFinite(bucket.capturedAt)
      && bucket.capturedAt < existing.capturedAt) continue;
    out[field] = bucket;
  }
  return Object.keys(out).length ? out : null;
}

function createAccountQuotaStore(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  // options.persistPath: undefined -> default path, null -> in-memory only.
  const persistPath = options.persistPath === undefined ? DEFAULT_PERSIST_PATH : options.persistPath;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : () => {};

  // Map<hostKey, { host, [providerKey]: { group, updatedAt, lastSeenAt } }>
  // ("" = local). updatedAt = last VALUE change (drives display of the
  // numbers); each bucket owns a seenAt (drives staleness and merge
  // arbitration). Provider lastSeenAt is retained as the max bucket seenAt
  // for persistence compatibility and summary UI only.
  const sources = new Map();
  let persistTimer = null;

  function load() {
    if (!persistPath) return;
    let raw;
    try {
      // readJsonFile, not a hand-rolled parse: BOM-safe (#590 review C3).
      raw = readJsonFile(persistPath);
    } catch {
      return; // missing or corrupt -> empty store
    }
    const nowMs = now();
    const persistVersion = Number(raw && raw.version);
    const preModelRoutingPersist = !Number.isFinite(persistVersion) || persistVersion < 6;
    const entries = raw && Array.isArray(raw.sources) ? raw.sources : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (sources.size >= MAX_SOURCES) break;
      const host = normalizeSourceHost(entry.host);
      const sourceKey = typeof entry.sourceKey === "string"
        ? normalizeSourceHost(entry.sourceKey)
        : host;
      const record = { host };
      let hasAny = false;
      for (const providerKey of QUOTA_PROVIDER_KEYS) {
        const stored = entry[providerKey];
        if (!stored || typeof stored !== "object") continue;
        // Before v6, even the first identity-aware schema could still route a
        // current Spark turn's generic limit_id="codex" into codexQuota. The
        // persisted shape contains neither raw identity nor turn model (by
        // design), so it is impossible to relabel safely during migration.
        // Drop only that ambiguous cache; the next real main report restores
        // it, while known Spark and unrelated provider caches remain intact.
        if (providerKey === "codexQuota" && preModelRoutingPersist) continue;
        let group = normalizeQuotaGroup(stored.group, QUOTA_PROVIDER_FIELDS[providerKey]);
        if (!group) continue;
        const updatedAt = Number(stored.updatedAt);
        const lastSeenAt = Number(stored.lastSeenAt);
        const fallbackSeenAt = Number.isFinite(lastSeenAt)
          ? lastSeenAt
          : (Number.isFinite(updatedAt) ? updatedAt : nowMs);
        group = Object.fromEntries(Object.entries(group).map(([field, bucket]) => {
          const rawBucket = stored.group && stored.group[field];
          const rawSeenAt = Number(rawBucket && rawBucket.seenAt);
          return [field, {
            ...bucket,
            seenAt: Number.isFinite(rawSeenAt) ? rawSeenAt : fallbackSeenAt,
          }];
        }));
        record[providerKey] = {
          group,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : nowMs,
          // Older persist files predate lastSeenAt — fall back to updatedAt
          // (strictly older-or-equal, so nothing looks fresher than it is).
          lastSeenAt: Math.max(...Object.values(group).map((bucket) => bucket.seenAt)),
        };
        hasAny = true;
      }
      const extraQuota = loadExtraQuota(entry.extraQuota, nowMs);
      if (extraQuota) {
        record.extraQuota = extraQuota;
        hasAny = true;
      }
      if (hasAny) sources.set(sourceKey || "", record);
    }
    pruneStale(nowMs);
  }

  // Retire data nothing will ever refresh: buckets whose window reset long
  // ago, providers unconfirmed past retention, and sources left empty.
  // Mutates the store (so the persist file shrinks too, on the next write).
  function pruneStale(nowMs) {
    let pruned = false;
    for (const [key, record] of sources) {
      let hasProvider = false;
      for (const providerKey of QUOTA_PROVIDER_KEYS) {
        const stored = record[providerKey];
        if (!stored) continue;
        for (const [field, bucket] of Object.entries(stored.group)) {
          const seenAt = Number(bucket.seenAt);
          const unconfirmedTooLong = !Number.isFinite(seenAt)
            || seenAt + PROVIDER_RETENTION_MS <= nowMs;
          const resetTooLongAgo = Number.isFinite(bucket.resetAt)
            && bucket.resetAt + EXPIRED_BUCKET_DROP_AFTER_MS <= nowMs;
          if (unconfirmedTooLong || resetTooLongAgo) {
            delete stored.group[field];
            pruned = true;
          }
        }
        if (!Object.keys(stored.group).length) {
          delete record[providerKey];
          pruned = true;
          continue;
        }
        stored.lastSeenAt = Math.max(
          ...Object.values(stored.group).map((bucket) => Number(bucket.seenAt) || 0)
        );
        hasProvider = true;
      }
      if (record.extraQuota) {
        for (const [providerId, provider] of Object.entries(record.extraQuota)) {
          const seenAt = Number(provider.lastSeenAt);
          if (!Number.isFinite(seenAt) || seenAt + PROVIDER_RETENTION_MS <= nowMs) {
            delete record.extraQuota[providerId];
            pruned = true;
            continue;
          }
          // Balances carry no resetAt and stay until provider retention.
          const kept = provider.limits.filter((limit) => !(limit.kind === "window"
            && Number.isFinite(limit.resetAt)
            && limit.resetAt + EXPIRED_BUCKET_DROP_AFTER_MS <= nowMs));
          if (kept.length !== provider.limits.length) {
            provider.limits = kept;
            pruned = true;
          }
          if (!kept.length) {
            delete record.extraQuota[providerId];
            continue;
          }
          hasProvider = true;
        }
        if (!Object.keys(record.extraQuota).length) delete record.extraQuota;
      }
      if (!hasProvider) {
        sources.delete(key);
        pruned = true;
      }
    }
    return pruned;
  }

  function persistNow() {
    if (!persistPath) return true;
    const body = JSON.stringify({
      // v7 adds the optional per-source extraQuota map; v6 files load as-is.
      version: 7,
      sources: Array.from(sources.entries()).map(([sourceKey, record]) => ({
        sourceKey,
        ...record,
      })),
    }, null, 2);
    const dir = path.dirname(persistPath);
    const tmpPath = path.join(dir, `.account-quota.${process.pid}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, body, "utf8");
      fs.renameSync(tmpPath, persistPath);
      return true;
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      logWarn("Clawd: account-quota persist failed:", err && err.message);
      return false;
    }
  }

  function schedulePersist() {
    if (!persistPath) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
    if (typeof persistTimer.unref === "function") persistTimer.unref();
  }

  // Record a quota report from one source. Returns true when the snapshot
  // callers would broadcast actually changes: either a VALUE changed
  // (updatedAt stamped, mirroring updateSessionMetadata's discipline — an
  // identical statusline refresh must not make the numbers look fresher),
  // or lastSeenAt crossed a minute boundary (so freshness labels stay
  // honest for a reporter that keeps confirming the same numbers, at a
  // bounded ≤1 broadcast/min instead of one per statusline tick).
  function updateDetailed(source, quotas = {}) {
    const nowMs = now();
    const sourceKey = normalizeSourceHost(source);
    const key = sourceKey || "";
    const requestedDisplayHost = Object.prototype.hasOwnProperty.call(quotas, "displayHost")
      ? normalizeSourceHost(quotas.displayHost)
      : sourceKey;
    const sourceHost = requestedDisplayHost;
    let record = sources.get(key);
    if (!record && sources.size >= MAX_SOURCES) {
      logWarn("Clawd: account-quota source cap reached, dropping report from:", key || "(local)");
      return { accepted: false, changed: false };
    }
    let changed = !!record && record.host !== sourceHost;
    let seenAdvanced = false;
    let acceptedAny = false;
    if (record && record.host !== sourceHost) record.host = sourceHost;
    for (const providerKey of QUOTA_PROVIDER_KEYS) {
      const group = normalizeQuotaGroup(quotas[providerKey], QUOTA_PROVIDER_FIELDS[providerKey]);
      if (!group) continue;
      const existing = record && record[providerKey];
      const windowAwareCodex = isWindowAwareCodexProvider(providerKey) && hasReportedWindow(group);
      // A window-aware Codex payload is a complete rate_limits snapshot. A
      // newer single 7-day primary must retire the old short-window bucket,
      // not merge with it. Reject an older complete snapshot at provider
      // scope before it can relocate/erase a newer bucket in another slot.
      if (windowAwareCodex && existing) {
        const incomingCapture = newestCapture(group);
        const existingCapture = newestCapture(existing.group);
        if (incomingCapture !== null && existingCapture !== null
          && incomingCapture < existingCapture) continue;
      }
      const accepted = sanitizeIncomingGroup(group, existing && existing.group, nowMs);
      if (!accepted) continue;
      acceptedAny = true;
      const observed = Object.fromEntries(Object.entries(accepted).map(([field, bucket]) => [
        field,
        { ...bucket, seenAt: nowMs },
      ]));
      // Legacy reports and other providers merge per bucket: a partial
      // report must not evict a sibling that is still valid. Window-aware
      // Codex reports are the exception because rate_limits is a complete
      // snapshot and omission is how a removed service-side window appears.
      const merged = windowAwareCodex
        ? observed
        : (existing ? { ...existing.group, ...observed } : observed);
      if (!record) {
        record = { host: sourceHost };
        sources.set(key, record);
      }
      const valueChanged = !existing || comparableGroup(existing.group) !== comparableGroup(merged);
      if (!valueChanged && existing) {
        for (const field of Object.keys(observed)) {
          const priorSeenAt = Number(existing.group[field] && existing.group[field].seenAt);
          if (!Number.isFinite(priorSeenAt)
            || Math.floor(nowMs / SEEN_QUANTUM_MS) > Math.floor(priorSeenAt / SEEN_QUANTUM_MS)) {
            seenAdvanced = true;
            break;
          }
        }
      }
      const providerLastSeenAt = Math.max(
        ...Object.values(merged).map((bucket) => Number(bucket.seenAt) || 0)
      );
      record[providerKey] = {
        group: merged,
        updatedAt: valueChanged ? nowMs : existing.updatedAt,
        lastSeenAt: providerLastSeenAt,
      };
      if (valueChanged) changed = true;
    }
    if (isPlainObject(quotas.extraQuota)) {
      for (const [providerId, rawProvider] of Object.entries(quotas.extraQuota)) {
        if (!EXTRA_PROVIDER_ID_RE.test(providerId)) continue;
        const incoming = normalizeExtraProvider(rawProvider, providerId, nowMs, true);
        if (!incoming) continue;
        const existingExtra = record && record.extraQuota ? record.extraQuota[providerId] : null;
        if (!existingExtra && record && record.extraQuota
          && Object.keys(record.extraQuota).length >= MAX_EXTRA_PROVIDERS) {
          logWarn("Clawd: account-quota extra provider cap reached, dropping:", providerId);
          continue;
        }
        // Complete snapshot: an older observation must not replace a newer one.
        if (existingExtra && Number.isFinite(existingExtra.capturedAt)
          && Number.isFinite(incoming.capturedAt)
          && incoming.capturedAt < existingExtra.capturedAt) continue;
        acceptedAny = true;
        if (!record) {
          record = { host: sourceHost };
          sources.set(key, record);
        }
        if (!record.extraQuota) record.extraQuota = {};
        const valueChanged = !existingExtra
          || comparableExtraProvider(existingExtra) !== comparableExtraProvider(incoming);
        if (!valueChanged) {
          const priorSeenAt = Number(existingExtra.lastSeenAt);
          if (!Number.isFinite(priorSeenAt)
            || Math.floor(nowMs / SEEN_QUANTUM_MS) > Math.floor(priorSeenAt / SEEN_QUANTUM_MS)) {
            seenAdvanced = true;
          }
        }
        record.extraQuota[providerId] = {
          ...incoming,
          updatedAt: valueChanged ? nowMs : existingExtra.updatedAt,
          lastSeenAt: nowMs,
        };
        if (valueChanged) changed = true;
      }
    }
    if (changed || seenAdvanced) schedulePersist();
    return { accepted: acceptedAny, changed: changed || seenAdvanced };
  }

  function update(source, quotas = {}) {
    return updateDetailed(source, quotas).changed;
  }

  // Remove one provider without disturbing sibling providers carried by the
  // same source. The optional predicate receives the normalized source key
  // ("" = this machine) and lets callers preserve independently-authorized
  // sources such as Remote SSH profiles.
  function clearProvider(providerKey, shouldClearSource = () => true) {
    if (!Object.prototype.hasOwnProperty.call(QUOTA_PROVIDER_FIELDS, providerKey)) return 0;
    const predicate = typeof shouldClearSource === "function" ? shouldClearSource : () => true;
    let cleared = 0;
    for (const [sourceKey, record] of sources) {
      if (!record[providerKey] || !predicate(sourceKey, record)) continue;
      delete record[providerKey];
      cleared++;
      if (!hasAnyProvider(record)) sources.delete(sourceKey);
    }
    if (cleared) schedulePersist();
    return cleared;
  }

  // Renderer-facing view: expired buckets dropped (wall-clock window reset),
  // local source first, remotes sorted by host for a stable UI order.
  //
  // options.mergeSources: opt-in for the "same subscription on every
  // machine" setup — collapse all sources into one unlabeled entry, taking
  // the freshest live report independently for each provider window.
  // Deliberately NOT the
  // default: with different subscriptions per machine a merged view lies,
  // which is why the per-source shape exists in the first place.
  function snapshot(options = {}) {
    const nowMs = now();
    if (pruneStale(nowMs)) schedulePersist();
    const out = [];
    // Merge arbitration uses exact receive time, while snapshots expose only
    // minute-quantized stamps to avoid a broadcast on every statusline tick.
    const rawSeenByBucket = new WeakMap();
    for (const [sourceKey, record] of sources) {
      // sourceKey, not host: `host` is a DISPLAY label and two trusted remote
      // profiles are explicitly allowed to share one (see the "keeps trusted
      // remote profile sources separate when display hosts match" test). Any
      // renderer that keys per-source state off the label would collapse those
      // two sources into one.
      const entry = { sourceKey, host: record.host };
      let hasAny = false;
      for (const providerKey of QUOTA_PROVIDER_KEYS) {
        const stored = record[providerKey];
        if (!stored) continue;
        const group = expireBuckets(stored.group, nowMs, rawSeenByBucket);
        if (!group) continue;
        const provider = {
          group,
          updatedAt: stored.updatedAt,
          // Minute-quantized so an actively-confirming reporter changes the
          // snapshot (and its signature) at most once a minute.
          lastSeenAt: Math.floor(stored.lastSeenAt / SEEN_QUANTUM_MS) * SEEN_QUANTUM_MS,
        };
        entry[providerKey] = provider;
        hasAny = true;
      }
      if (record.extraQuota) {
        const extraQuota = {};
        for (const [providerId, stored] of Object.entries(record.extraQuota)) {
          // Cloned so consumers never hold live references into the store.
          const provider = {
            label: stored.label,
            updatedAt: stored.updatedAt,
            lastSeenAt: Math.floor(stored.lastSeenAt / SEEN_QUANTUM_MS) * SEEN_QUANTUM_MS,
            limits: stored.limits.map((limit) => (isExpiredWindowLimit(limit, nowMs)
              ? { ...limit, expired: true }
              : { ...limit })),
          };
          rawSeenByBucket.set(provider, Number(stored.lastSeenAt));
          extraQuota[providerId] = provider;
        }
        if (Object.keys(extraQuota).length) {
          entry.extraQuota = extraQuota;
          hasAny = true;
        }
      }
      if (hasAny) out.push(entry);
    }
    out.sort((a, b) => {
      if (!a.host) return -1;
      if (!b.host) return 1;
      return a.host.localeCompare(b.host);
    });
    if (options.mergeSources !== true || out.length <= 1) return out;

    // The merged view is a single synthetic source; nothing can collide with it.
    const merged = { sourceKey: null, host: null };
    let hasAny = false;
    for (const providerKey of QUOTA_PROVIDER_KEYS) {
      const providerCandidates = out
        .map((entry) => entry[providerKey])
        .filter(Boolean);
      const hasLiveProvider = providerCandidates.some((candidate) =>
        Object.values(candidate.group).some((bucket) => bucket.expired !== true));
      // When at least one reporter still has live data, a reporter whose
      // entire provider has expired says "nothing" and contributes no stale
      // sibling fields. Mixed reporters remain eligible so their live bucket
      // can win independently while their expired sibling loses to live data.
      const eligibleCandidates = hasLiveProvider
        ? providerCandidates.filter((candidate) =>
          Object.values(candidate.group).some((bucket) => bucket.expired !== true))
        : providerCandidates;
      const group = {};
      const selected = [];
      for (const field of QUOTA_PROVIDER_FIELDS[providerKey]) {
        let best = null;
        let bestLive = false;
        let bestSeenAt = -Infinity;
        for (const candidate of eligibleCandidates) {
          const bucket = candidate && candidate.group[field];
          if (!bucket) continue;
          // Arbitrate each window independently. A source with a live 5h
          // bucket but an expired weekly bucket must not mask another
          // source's still-live weekly observation.
          const live = bucket.expired !== true;
          const rawSeenAt = Number(rawSeenByBucket.get(bucket));
          const seenAt = Number.isFinite(rawSeenAt) ? rawSeenAt : Number(bucket.lastSeenAt);
          if (!best
            || (live && !bestLive)
            || (live === bestLive && seenAt > bestSeenAt)) {
            best = { candidate, bucket };
            bestLive = live;
            bestSeenAt = seenAt;
          }
        }
        if (best) {
          group[field] = best.bucket;
          selected.push(best);
        }
      }
      if (selected.length) {
        merged[providerKey] = {
          group,
          updatedAt: Math.max(...selected.map(({ candidate }) => Number(candidate.updatedAt))),
          // A merged provider can contain windows from different sources.
          // Age it by the oldest selected observation so an older sibling
          // never borrows another bucket's fresh label.
          lastSeenAt: Math.min(...selected.map(({ bucket }) => Number(bucket.lastSeenAt))),
        };
        hasAny = true;
      }
    }
    // Extra providers are complete per-provider snapshots, so arbitration is
    // per provider (never mixing limits from two sources): a report with any
    // live limit beats a fully-expired one, then the freshest observation wins.
    const extraIds = new Set();
    for (const entry of out) {
      if (entry.extraQuota) for (const providerId of Object.keys(entry.extraQuota)) extraIds.add(providerId);
    }
    const mergedExtra = {};
    for (const providerId of Array.from(extraIds).sort()) {
      let best = null;
      let bestLive = false;
      let bestSeenAt = -Infinity;
      for (const entry of out) {
        const candidate = entry.extraQuota && entry.extraQuota[providerId];
        if (!candidate) continue;
        const live = candidate.limits.some((limit) => limit.expired !== true);
        const rawSeenAt = Number(rawSeenByBucket.get(candidate));
        const seenAt = Number.isFinite(rawSeenAt) ? rawSeenAt : Number(candidate.lastSeenAt);
        if (!best || (live && !bestLive) || (live === bestLive && seenAt > bestSeenAt)) {
          best = candidate;
          bestLive = live;
          bestSeenAt = seenAt;
        }
      }
      if (best) mergedExtra[providerId] = best;
    }
    if (Object.keys(mergedExtra).length) {
      merged.extraQuota = mergedExtra;
      hasAny = true;
    }
    return hasAny ? [merged] : [];
  }

  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    return persistNow();
  }

  function prune() {
    const changed = pruneStale(now());
    if (changed) schedulePersist();
    return changed;
  }

  load();

  return { update, updateDetailed, clearProvider, snapshot, prune, flush };
}

module.exports = {
  createAccountQuotaStore,
  QUOTA_PROVIDER_KEYS,
  DEFAULT_PERSIST_PATH,
  MAX_SOURCES,
  MAX_RESET_AHEAD_MS,
  EXPIRED_BUCKET_DROP_AFTER_MS,
  PROVIDER_RETENTION_MS,
  SEEN_QUANTUM_MS,
  MAX_EXTRA_PROVIDERS,
  MAX_EXTRA_LIMITS,
  EXTRA_PROVIDER_ID_RE,
};
