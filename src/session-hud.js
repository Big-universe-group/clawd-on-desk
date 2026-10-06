"use strict";

const { BrowserWindow, screen } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");
const { clampTextScale, scaleHeight, applyZoomToWindow } = require("./text-scale");
const ringGeom = require("./quota-ring-geometry");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

const HUD_BORDER_Y = 2;
const HUD_WIDTH = 240;
const HUD_WIDTH_COMPACT = 190;
const HUD_WIDTH_LABELS = 320;
const HUD_WIDTH_LABELS_COMPACT = 260;
const HUD_CONTEXT_USAGE_WIDTH_BUMP = 36;
const HUD_LABELS_ONLY_WIDTH_TRIM = 36;
const HUD_ROW_HEIGHT = 28;
const HUD_MAX_EXPANDED_ROWS = 3;
const HUD_MAX_EXPANDED_ROWS_LABELS = 5;
const HUD_HEIGHT = HUD_ROW_HEIGHT + HUD_BORDER_Y;
const HUD_WINDOW_SHELL = Object.freeze({
  top: 2,
  right: 3,
  bottom: 8,
  left: 3,
});
const HUD_PET_GAP = 4;
const BUBBLE_GAP = 6;
const EDGE_MARGIN = 8;
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;
const HOT_ZONE_PAD = 24;
const AUTO_HIDE_POLL_MS = 200;
const HIDE_GRACE_MS = 500;
const HIDDEN_WINDOW_DESTROY_MS = 30000;
const HUD_WIDTH_GROWTH_RATIO = 0.4;
// 2px rule between the sessions section and the quota section (session-hud.html).
const HUD_SECTION_DIVIDER = 2;

function clampToWorkArea(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function isScreenRect(rect) {
  return !!rect
    && Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom);
}

function isHudSession(session) {
  return !!session && !session.headless && session.state !== "sleeping" && !session.hiddenFromHud;
}

function snapshotHasVisibleSessions(snapshot) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  return sessions.some(isHudSession);
}

function evaluateBaseEligible({
  snapshot,
  sessionHudEnabled,
  petHidden,
  miniMode,
  miniTransitioning,
  showQuota,
  hiddenQuotaProviders,
}) {
  if (!snapshot) return false;
  if (petHidden) return false;
  if (miniMode || miniTransitioning) return false;
  // The sessions and quota sections are independent: sessions follow the HUD
  // master switch, quota follows the quota switch. Either can make the
  // floating UI eligible on a pet click.
  const hudEligible = sessionHudEnabled !== false && snapshotHasVisibleSessions(snapshot);
  const quotaEligible = countQuotaCoins(snapshot, showQuota, hiddenQuotaProviders) > 0;
  return hudEligible || quotaEligible;
}

function pointInExpandedRect(point, rect, pad) {
  if (!point || !isScreenRect(rect)) return false;
  const p = Number.isFinite(pad) ? pad : 0;
  return point.x >= rect.left - p
    && point.x <= rect.right + p
    && point.y >= rect.top - p
    && point.y <= rect.bottom + p;
}

function computeAutoHideHotZone({ petHitRect, expectedHudContentBounds, pad }) {
  const rects = [];
  if (isScreenRect(petHitRect)) rects.push(petHitRect);
  const r = expectedHudContentBounds;
  if (r && Number.isFinite(r.x) && Number.isFinite(r.y)
      && Number.isFinite(r.width) && Number.isFinite(r.height)
      && r.width > 0 && r.height > 0) {
    rects.push({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });
  } else if (isScreenRect(r)) {
    rects.push(r);
  }
  return { rects, pad: Number.isFinite(pad) ? pad : 0 };
}

function pointInHotZone(point, hotZone) {
  if (!hotZone || !Array.isArray(hotZone.rects)) return false;
  for (const rect of hotZone.rects) {
    if (pointInExpandedRect(point, rect, hotZone.pad)) return true;
  }
  return false;
}

function evaluateShouldShow({
  snapshot,
  sessionHudEnabled,
  sessionHudPinned,
  clickRevealed,
  inHotZone,
  now,
  visibleHoldUntil,
  hideGraceMs,
  petHidden,
  miniMode,
  miniTransitioning,
  showQuota,
}) {
  const baseEligible = evaluateBaseEligible({
    snapshot,
    sessionHudEnabled,
    petHidden,
    miniMode,
    miniTransitioning,
    showQuota,
  });
  if (!baseEligible) return { show: false, nextHoldUntil: 0 };
  if (sessionHudPinned === true) return { show: true, nextHoldUntil: 0 };
  if (clickRevealed !== true) return { show: false, nextHoldUntil: 0 };

  // revealed 态：hot zone 续命 + grace period
  let nextHoldUntil = Number.isFinite(visibleHoldUntil) ? visibleHoldUntil : 0;
  const tNow = Number.isFinite(now) ? now : 0;
  const grace = Number.isFinite(hideGraceMs) ? hideGraceMs : 0;
  if (inHotZone) {
    nextHoldUntil = tNow + grace;
  }
  const show = inHotZone || tNow < nextHoldUntil;
  return { show, nextHoldUntil };
}

function getHudMaxExpandedRows(showStateLabels = true) {
  return showStateLabels === false ? HUD_MAX_EXPANDED_ROWS : HUD_MAX_EXPANDED_ROWS_LABELS;
}

function computeHudLayout(snapshot, options = {}) {
  const sessions = (snapshot && Array.isArray(snapshot.sessions)) ? snapshot.sessions : [];
  if (sessions.length === 0) return { expanded: [], folded: [], rowCount: 0 };
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const orderedIds = (snapshot && Array.isArray(snapshot.orderedIds))
    ? snapshot.orderedIds
    : sessions.map((s) => s.id);
  const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  const orderedSet = new Set(ordered.map((s) => s.id));
  const missing = sessions.filter((s) => !orderedSet.has(s.id));
  const visible = ordered.concat(missing).filter(isHudSession);
  const maxExpandedRows = getHudMaxExpandedRows(options.showStateLabels);
  const expanded = visible.slice(0, maxExpandedRows);
  const folded = visible.slice(maxExpandedRows);
  const rowCount = expanded.length + (folded.length > 0 ? 1 : 0);
  return { expanded, folded, rowCount };
}

// One quota-section row per (source, provider) with drawable quota. Quota
// alone can keep the pet's floating UI eligible even when the Session HUD's
// sessions section is disabled.
function countQuotaCoins(snapshot, showQuota, hiddenQuotaProviders) {
  return ringGeom.countQuotaCoins(snapshot, showQuota, hiddenQuotaProviders);
}

function computeHudHeight(rowCount) {
  if (!Number.isFinite(rowCount) || rowCount <= 0) return HUD_ROW_HEIGHT;
  return rowCount * HUD_ROW_HEIGHT + HUD_BORDER_Y;
}

// CSS px content height of the one HUD box: session rows, then quota rows,
// with a divider only when both sections are present.
function computeHudBoxHeight({ sessionRows = 0, quotaRows = 0 } = {}) {
  const s = Number.isFinite(sessionRows) && sessionRows > 0 ? sessionRows : 0;
  const q = Number.isFinite(quotaRows) && quotaRows > 0 ? quotaRows : 0;
  if (s === 0 && q === 0) return HUD_ROW_HEIGHT;
  return s * HUD_ROW_HEIGHT
    + q * ringGeom.constants.QUOTA_ROW_HEIGHT
    + (s > 0 && q > 0 ? HUD_SECTION_DIVIDER : 0)
    + HUD_BORDER_Y;
}

// Box width with a quota section: at least QUOTA_MIN_WIDTH, and wide enough
// for the widest quota row's estimate (row width + the box's 1px side borders)
// so "7d(2d2h) 29%"-style values never push the provider label to an ellipsis.
function getHudBoxWidth(sessionWidth, quotaRows, quotaRowWidth = 0) {
  if (!(quotaRows > 0)) return sessionWidth;
  const rowNeed = Number.isFinite(quotaRowWidth) && quotaRowWidth > 0 ? quotaRowWidth + 2 : 0;
  return Math.max(sessionWidth, ringGeom.constants.QUOTA_MIN_WIDTH, rowNeed);
}

function computeHudReservedOffset(cardHeight) {
  const h = Number.isFinite(cardHeight) && cardHeight > 0 ? cardHeight : HUD_ROW_HEIGHT;
  return HUD_PET_GAP + h + HUD_WINDOW_SHELL.bottom + BUBBLE_GAP;
}

function getHudWidthScale(scale) {
  const s = clampTextScale(scale);
  if (s <= 1) return s;
  return 1 + (s - 1) * HUD_WIDTH_GROWTH_RATIO;
}

function computeHudOuterWidth(width, scale, widthScale = scale) {
  const s = clampTextScale(scale);
  const ws = clampTextScale(widthScale);
  return Math.round(width * ws)
    + Math.round(HUD_WINDOW_SHELL.left * s)
    + Math.round(HUD_WINDOW_SHELL.right * s);
}

function computeSessionHudBounds({ hitRect, anchorRect, workArea, width = HUD_WIDTH, height = HUD_HEIGHT, scale = 1, widthScale = scale }) {
  const followRect = isScreenRect(anchorRect) ? anchorRect : hitRect;
  if (!isScreenRect(followRect) || !workArea) return null;
  const followTop = Math.round(followRect.top);
  const followBottom = Math.round(followRect.bottom);
  const followCx = Math.round((followRect.left + followRect.right) / 2);

  // width/height arrive in CSS px (HUD constants); rects are DIP. Convert
  // everything page-rendered before mixing coordinate spaces. Height, shell and
  // gaps keep full textScale, while width can grow more gently so a large-text
  // HUD stays compact instead of turning into a banner.
  const s = clampTextScale(scale);
  const ws = clampTextScale(widthScale);
  const dipWidth = Math.round(width * ws);
  const dipHeight = Math.ceil(height * s);
  const shell = {
    top: Math.round(HUD_WINDOW_SHELL.top * s),
    right: Math.round(HUD_WINDOW_SHELL.right * s),
    bottom: Math.round(HUD_WINDOW_SHELL.bottom * s),
    left: Math.round(HUD_WINDOW_SHELL.left * s),
  };
  const petGap = Math.round(HUD_PET_GAP * s);
  const edgeMargin = Math.round(EDGE_MARGIN * s);

  const outerWidth = dipWidth + shell.left + shell.right;
  const outerHeight = dipHeight + shell.top + shell.bottom;
  const minX = Math.round(workArea.x);
  const maxX = Math.round(workArea.x + workArea.width - dipWidth);
  const x = clampToWorkArea(followCx - Math.round(dipWidth / 2), minX, maxX);

  const belowY = followBottom + petGap;
  const belowMax = workArea.y + workArea.height - edgeMargin;
  if (belowY + dipHeight <= belowMax) {
    const contentBounds = { x, y: belowY, width: dipWidth, height: dipHeight };
    return {
      bounds: {
        x: contentBounds.x - shell.left,
        y: contentBounds.y - shell.top,
        width: outerWidth,
        height: outerHeight,
      },
      contentBounds,
      flippedAbove: false,
    };
  }

  const minY = Math.round(workArea.y + edgeMargin);
  const maxY = Math.round(workArea.y + workArea.height - edgeMargin - dipHeight);
  const aboveY = followTop - dipHeight - petGap;
  const contentBounds = {
    x,
    y: clampToWorkArea(aboveY, minY, maxY),
    width: dipWidth,
    height: dipHeight,
  };
  return {
    bounds: {
      x: contentBounds.x - shell.left,
      y: contentBounds.y - shell.top,
      width: outerWidth,
      height: outerHeight,
    },
    contentBounds,
    flippedAbove: true,
  };
}

function getHudWidth(showElapsed = true, showStateLabels = true, showContextUsage = false) {
  const base = showStateLabels === false
    ? (showElapsed === false ? HUD_WIDTH_COMPACT : HUD_WIDTH)
    : (showElapsed === false ? HUD_WIDTH_LABELS_COMPACT : HUD_WIDTH_LABELS);
  if (showStateLabels !== false && showContextUsage !== true) {
    return Math.max(HUD_WIDTH_COMPACT, base - HUD_LABELS_ONLY_WIDTH_TRIM);
  }
  return showContextUsage === true ? base + HUD_CONTEXT_USAGE_WIDTH_BUMP : base;
}

function deferMacFloatingVisibility(ctx, win) {
  if (!isMac || !win || win.isDestroyed()) return;
  const deferUntil = Date.now() + MAC_FLOATING_TOPMOST_DELAY_MS;
  win.__clawdMacDeferredVisibilityUntil = deferUntil;
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (win.__clawdMacDeferredVisibilityUntil === deferUntil) {
      delete win.__clawdMacDeferredVisibilityUntil;
    }
    if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }, MAC_FLOATING_TOPMOST_DELAY_MS);
}

module.exports = function initSessionHud(ctx) {
  let hudWindow = null;
  let didFinishLoad = false;
  let latestSnapshot = null;
  let hudFlippedAbove = false;
  let lastReservedOffset = 0;
  let hiddenDestroyTimer = null;
  // Section shape last sent to the renderer; a change forces a resend even on
  // reposition-only syncs so the rows always match the window height.
  let sectionKey = null;

  function getTextScale() {
    return clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale() : 1);
  }
  let lastHudHeight = HUD_ROW_HEIGHT;
  let pollTimer = null;
  let clickRevealed = false;
  let visibleHoldUntil = 0;

  function getCurrentSnapshot() {
    return typeof ctx.getSessionSnapshot === "function"
      ? ctx.getSessionSnapshot()
      : { sessions: [], groups: [], orderedIds: [], menuOrderedIds: [] };
  }

  function getMiniMode() {
    return typeof ctx.getMiniMode === "function" && ctx.getMiniMode();
  }

  function getMiniTransitioning() {
    return typeof ctx.getMiniTransitioning === "function" && ctx.getMiniTransitioning();
  }

  function baseEligible(snapshot = latestSnapshot) {
    return evaluateBaseEligible({
      snapshot,
      sessionHudEnabled: ctx.sessionHudEnabled,
      petHidden: ctx.petHidden,
      miniMode: getMiniMode(),
      miniTransitioning: getMiniTransitioning(),
      showQuota: ctx.sessionHudShowQuota !== false,
      hiddenQuotaProviders: ctx.quotaRingHiddenProviders,
    });
  }

  function shouldShow(snapshot = latestSnapshot) {
    if (!baseEligible(snapshot)) return false;
    if (ctx.sessionHudPinned === true) return true;
    return clickRevealed;
  }

  function isAutoHidePollingNeeded() {
    if (!baseEligible(latestSnapshot)) return false;
    if (ctx.sessionHudPinned === true) return false;
    return clickRevealed === true;
  }

  // Which sections the box carries for this snapshot. The sessions section
  // follows the Session HUD master switch; the quota section follows the quota
  // switch and hidden-provider list, so either can appear alone.
  function resolveSections(snapshot) {
    const sessionRows = ctx.sessionHudEnabled !== false && snapshotHasVisibleSessions(snapshot)
      ? computeHudLayout(snapshot, { showStateLabels: ctx.sessionHudShowStateLabels !== false }).rowCount
      : 0;
    const showQuota = ctx.sessionHudShowQuota !== false;
    const quota = ringGeom.computeQuotaSectionLayout(
      countQuotaCoins(snapshot, showQuota, ctx.quotaRingHiddenProviders)
    );
    const quotaRowWidth = quota.visibleRows > 0
      ? ringGeom.estimateQuotaSectionWidth(snapshot, showQuota, ctx.quotaRingHiddenProviders)
      : 0;
    return { sessionRows, quota, quotaRowWidth };
  }

  function getPetHitRect() {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds || typeof ctx.getHitRectScreen !== "function") return null;
    return ctx.getHitRectScreen(petBounds);
  }

  function computeBoxLayout(snapshot, scale = getTextScale()) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const sections = resolveSections(snapshot);
    if (sections.sessionRows === 0 && sections.quota.visibleRows === 0) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function"
      ? ctx.getHitRectScreen(petBounds)
      : null;
    const anchorRect = typeof ctx.getSessionHudAnchorRect === "function"
      ? ctx.getSessionHudAnchorRect(petBounds)
      : null;
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const height = computeHudBoxHeight({
      sessionRows: sections.sessionRows,
      quotaRows: sections.quota.visibleRows,
    });
    const width = getHudBoxWidth(getHudWidth(
      ctx.sessionHudShowElapsed !== false,
      ctx.sessionHudShowStateLabels !== false,
      ctx.sessionHudShowContextUsage !== false
    ), sections.quota.visibleRows, sections.quotaRowWidth);
    const widthScale = getHudWidthScale(scale);
    const computed = computeSessionHudBounds({ hitRect, anchorRect, workArea, width, height, scale, widthScale });
    if (!computed) return null;
    return { ...computed, hitRect, height, sections };
  }

  function evaluateAutoHideCursorNow({ syncOnChange = true } = {}) {
    if (!isAutoHidePollingNeeded()) {
      stopAutoHidePoll();
      return false;
    }
    let cursor = null;
    try {
      cursor = screen.getCursorScreenPoint();
    } catch (_err) {
      cursor = null;
    }
    let inHotZone = false;
    if (cursor) {
      // Single scale resolve for the whole evaluation: the expected box must
      // carry the SAME scale the visible HUD was laid out with — an unscaled
      // expectation makes the hot zone smaller than the real window, so the
      // cursor "leaves" while still visually over it.
      const scale = getTextScale();
      const expected = computeBoxLayout(latestSnapshot, scale);
      const hotZone = computeAutoHideHotZone({
        petHitRect: expected ? expected.hitRect : getPetHitRect(),
        expectedHudContentBounds: expected && expected.contentBounds,
        pad: Math.round(HOT_ZONE_PAD * scale),
      });
      inHotZone = pointInHotZone(cursor, hotZone);
    }
    const now = Date.now();
    const result = evaluateShouldShow({
      snapshot: latestSnapshot,
      sessionHudEnabled: ctx.sessionHudEnabled,
      sessionHudPinned: ctx.sessionHudPinned,
      clickRevealed,
      inHotZone,
      now,
      visibleHoldUntil,
      hideGraceMs: HIDE_GRACE_MS,
      petHidden: ctx.petHidden,
      miniMode: getMiniMode(),
      miniTransitioning: getMiniTransitioning(),
      showQuota: ctx.sessionHudShowQuota !== false,
      hiddenQuotaProviders: ctx.quotaRingHiddenProviders,
    });
    visibleHoldUntil = result.nextHoldUntil;
    // In revealed state, poll detecting !show means user moved away past grace.
    // Clear clickRevealed so subsequent ticks stop polling.
    const wasRevealed = clickRevealed;
    if (wasRevealed && !result.show && ctx.sessionHudPinned !== true) {
      clickRevealed = false;
      visibleHoldUntil = 0;
      if (syncOnChange) {
        syncSessionHud(latestSnapshot, { sendSnapshot: false });
      }
      return true;
    }
    return false;
  }

  function pollAutoHideCursor() {
    pollTimer = null;
    if (!isAutoHidePollingNeeded()) {
      stopAutoHidePoll();
      return;
    }
    evaluateAutoHideCursorNow();
    schedulePollTick();
  }

  function schedulePollTick() {
    if (pollTimer) return;
    pollTimer = setTimeout(pollAutoHideCursor, AUTO_HIDE_POLL_MS);
  }

  function startAutoHidePoll() {
    evaluateAutoHideCursorNow({ syncOnChange: false });
    if (!isAutoHidePollingNeeded()) return;
    if (!pollTimer) schedulePollTick();
  }

  function stopAutoHidePoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    clickRevealed = false;
    visibleHoldUntil = 0;
  }

  function cancelHiddenDestroy() {
    if (!hiddenDestroyTimer) return;
    clearTimeout(hiddenDestroyTimer);
    hiddenDestroyTimer = null;
  }

  function scheduleHiddenDestroy() {
    // Reclaiming a hidden HUD renderer is a low-power-idle-mode behavior;
    // default mode keeps the window warm so reveals stay instant.
    if (!ctx.lowPowerIdleMode) return;
    if (!hudWindow || hudWindow.isDestroyed() || hudWindow.isVisible()) return;
    if (hiddenDestroyTimer) return;
    hiddenDestroyTimer = setTimeout(() => {
      hiddenDestroyTimer = null;
      // Re-check the flag: the user may have left low-power mode while hidden.
      if (!ctx.lowPowerIdleMode) return;
      if (!hudWindow || hudWindow.isDestroyed() || hudWindow.isVisible()) return;
      hudWindow.destroy();
    }, HIDDEN_WINDOW_DESTROY_MS);
  }

  // Internal: clear revealed state without syncing. Caller decides next sync.
  function clearReveal() {
    clickRevealed = false;
    visibleHoldUntil = 0;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // Public API: user clicked the pet to reveal HUD.
  function revealFromPet() {
    // Quota can expire while the HUD is hidden and no session event arrives.
    // Re-read before deciding eligibility so a stale cached snapshot cannot
    // resurrect a stale provider row.
    latestSnapshot = getCurrentSnapshot();
    if (!baseEligible(latestSnapshot)) return;
    if (ctx.sessionHudPinned === true) return;     // pinned already always-show
    if (clickRevealed) {
      // Already revealed — refresh grace as a click tolerance.
      visibleHoldUntil = Date.now() + HIDE_GRACE_MS;
      return;
    }
    clickRevealed = true;
    visibleHoldUntil = Date.now() + HIDE_GRACE_MS;  // seed
    syncSessionHud(latestSnapshot, { sendSnapshot: true });
    startAutoHidePoll();
  }

  // Public API: settings effect router calls this when sessionHudPinned flips.
  // Router has already updated ctx.sessionHudPinned before calling.
  function handlePinnedChanged(next) {
    if (next === true) {
      stopAutoHidePoll();
      // Pinned now — HUD always shows via shouldShow. Clear any stale reveal.
      clickRevealed = false;
      visibleHoldUntil = 0;
      syncSessionHud(latestSnapshot);
      return;
    }
    // unpin transition — read real window state, NOT shouldShow() (router
    // already mirrored sessionHudPinned=false so shouldShow would return
    // false and cause the HUD to flash hidden).
    const wasVisible = !!hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible();
    if (wasVisible && baseEligible(latestSnapshot)) {
      // Seed revealed state so the HUD stays visible until the user moves
      // away (grace period), preserving the on-screen experience.
      clickRevealed = true;
      visibleHoldUntil = Date.now() + HIDE_GRACE_MS;
      startAutoHidePoll();
      syncSessionHud(latestSnapshot);
    } else {
      syncSessionHud(latestSnapshot);
    }
  }

  function syncAutoHidePollLifecycle() {
    if (isAutoHidePollingNeeded()) startAutoHidePoll();
    else stopAutoHidePoll();
  }

  function sendSnapshot(snapshot, sections) {
    if (!snapshot || !sections || !hudWindow || hudWindow.isDestroyed() || !didFinishLoad) return false;
    if (!hudWindow.webContents || hudWindow.webContents.isDestroyed()) return false;
    hudWindow.webContents.send("session-hud:session-snapshot", {
      ...snapshot,
      hudShowSessions: sections.sessionRows > 0,
      hudShowStateLabels: ctx.sessionHudShowStateLabels !== false,
      hudShowElapsed: ctx.sessionHudShowElapsed !== false,
      hudShowContextUsage: ctx.sessionHudShowContextUsage !== false,
      hudPinned: ctx.sessionHudPinned === true,
      // The quota section's own payload. visibleRows/overflow come from the
      // same count that sized the window, so rows and height never disagree.
      quota: {
        accountQuota: Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [],
        quotaAgentIcons: snapshot.quotaAgentIcons || {},
        displayMode: ctx.quotaRingDisplayMode === "remaining" ? "remaining" : "used",
        hiddenQuotaProviders: Array.isArray(ctx.quotaRingHiddenProviders)
          ? ctx.quotaRingHiddenProviders
          : [],
        visibleRows: sections.quota.visibleRows,
        overflow: sections.quota.overflow,
      },
    });
    return true;
  }

  function sendI18n() {
    if (typeof ctx.getI18n !== "function") return;
    const payload = ctx.getI18n();
    if (hudWindow && !hudWindow.isDestroyed() && didFinishLoad
        && hudWindow.webContents && !hudWindow.webContents.isDestroyed()) {
      hudWindow.webContents.send("session-hud:lang-change", payload);
    }
  }

  function ensureSessionHud() {
    cancelHiddenDestroy();
    if (hudWindow && !hudWindow.isDestroyed()) return hudWindow;
    if (!ctx.win || ctx.win.isDestroyed()) return null;

    didFinishLoad = false;
    hudFlippedAbove = false;
    sectionKey = null;
    const hudWidth = getHudWidth(
      ctx.sessionHudShowElapsed !== false,
      ctx.sessionHudShowStateLabels !== false,
      ctx.sessionHudShowContextUsage !== false
    );
    // Provisional CSS px → DIP size; syncSessionHud() replaces it with the
    // precise computeSessionHudBounds() result before the window is shown.
    const scale = getTextScale();
    const widthScale = getHudWidthScale(scale);
    hudWindow = new BrowserWindow({
      parent: ctx.win,
      width: computeHudOuterWidth(hudWidth, scale, widthScale),
      height: scaleHeight(HUD_HEIGHT + HUD_WINDOW_SHELL.top + HUD_WINDOW_SHELL.bottom, scale),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: !isMac,
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-session-hud.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (isWin) hudWindow.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(hudWindow);

    hudWindow.loadFile(path.join(__dirname, "session-hud.html"));
    hudWindow.webContents.once("did-finish-load", () => {
      didFinishLoad = true;
      // Explicit even though same-origin propagation usually covers it — a
      // stale partition-persisted factor must never win over prefs.
      applyZoomToWindow(hudWindow, getTextScale());
      sendI18n();
      syncSessionHud();
    });
    hudWindow.on("closed", () => {
      cancelHiddenDestroy();
      hudWindow = null;
      didFinishLoad = false;
      hudFlippedAbove = false;
      sectionKey = null;
      notifyReservedOffsetIfChanged();
    });

    return hudWindow;
  }

  function hideSessionHud() {
    hudFlippedAbove = false;
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
    notifyReservedOffsetIfChanged();
    scheduleHiddenDestroy();
  }

  function showSessionHud(win) {
    if (!win || win.isDestroyed() || !didFinishLoad) return;
    cancelHiddenDestroy();
    if (!win.isVisible()) {
      win.showInactive();
      keepOutOfTaskbar(win);
      if (isMac) deferMacFloatingVisibility(ctx, win);
      else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
    }
    notifyReservedOffsetIfChanged();
  }

  function syncSessionHud(snapshot = latestSnapshot || getCurrentSnapshot(), options = {}) {
    latestSnapshot = snapshot;
    // Defend against stale reveal: if base eligibility dropped (last session
    // ended AND quota went away), clear any leftover clickRevealed so a future
    // new session does not pop the UI without a fresh user click.
    if (!baseEligible(snapshot)) {
      clearReveal();
    }
    syncAutoHidePollLifecycle();

    // Resolve the scale ONCE per sync and feed the same value to the window
    // and the bounds math — separate reads could disagree mid-display-crossing.
    const scale = getTextScale();
    const layout = shouldShow(snapshot) ? computeBoxLayout(snapshot, scale) : null;
    if (!layout) {
      hideSessionHud();
      return;
    }
    const win = ensureSessionHud();
    if (!win || win.isDestroyed()) return;
    applyZoomToWindow(win, scale);
    hudFlippedAbove = !!layout.flippedAbove;
    lastHudHeight = layout.height;
    win.setBounds(layout.bounds);
    const { sessionRows, quota } = layout.sections;
    const nextSectionKey = `${sessionRows}|${quota.visibleRows}|${quota.overflow}`;
    if ((options.sendSnapshot !== false || nextSectionKey !== sectionKey)
        && sendSnapshot(snapshot, layout.sections)) {
      sectionKey = nextSectionKey;
    }
    showSessionHud(win);
  }

  function broadcastSessionSnapshot(snapshot) {
    syncSessionHud(snapshot);
  }

  function repositionSessionHud() {
    syncSessionHud(latestSnapshot || getCurrentSnapshot(), { sendSnapshot: false });
  }

  function getHudReservedOffset() {
    return readHudReservedOffset();
  }

  function readHudReservedOffset() {
    if (!hudWindow || hudWindow.isDestroyed() || !hudWindow.isVisible()) return 0;
    if (hudFlippedAbove) return 0;
    // computeHudReservedOffset works in CSS px; consumers (bubble avoidance)
    // position windows in DIP.
    return scaleHeight(computeHudReservedOffset(lastHudHeight), getTextScale());
  }

  function notifyReservedOffsetIfChanged() {
    const next = readHudReservedOffset();
    if (next === lastReservedOffset) return;
    lastReservedOffset = next;
    if (typeof ctx.onReservedOffsetChange === "function") ctx.onReservedOffsetChange(next);
  }

  function cleanup() {
    stopAutoHidePoll();
    cancelHiddenDestroy();
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.destroy();
    hudWindow = null;
    didFinishLoad = false;
    hudFlippedAbove = false;
    sectionKey = null;
    lastHudHeight = HUD_ROW_HEIGHT;
    notifyReservedOffsetIfChanged();
  }

  return {
    ensureSessionHud,
    broadcastSessionSnapshot,
    repositionSessionHud,
    syncSessionHud,
    sendI18n,
    getHudReservedOffset,
    cleanup,
    getWindow: () => hudWindow,
    // v5 three-state API
    revealFromPet,
    handlePinnedChanged,
    clearReveal,
  };
};

module.exports.__test = {
  computeSessionHudBounds,
  computeHudBoxHeight,
  getHudBoxWidth,
  computeHudLayout,
  getHudMaxExpandedRows,
  computeHudHeight,
  countQuotaCoins,
  computeHudReservedOffset,
  isHudSession,
  getHudWidth,
  getHudWidthScale,
  computeHudOuterWidth,
  evaluateBaseEligible,
  evaluateShouldShow,
  pointInExpandedRect,
  computeAutoHideHotZone,
  pointInHotZone,
  constants: {
    HUD_WIDTH,
    HUD_WIDTH_COMPACT,
    HUD_WIDTH_LABELS,
    HUD_WIDTH_LABELS_COMPACT,
    HUD_CONTEXT_USAGE_WIDTH_BUMP,
    HUD_LABELS_ONLY_WIDTH_TRIM,
    HUD_HEIGHT,
    HUD_ROW_HEIGHT,
    HUD_MAX_EXPANDED_ROWS,
    HUD_MAX_EXPANDED_ROWS_LABELS,
    HUD_WINDOW_SHELL,
    HUD_PET_GAP,
    BUBBLE_GAP,
    EDGE_MARGIN,
    HUD_BORDER_Y,
    HOT_ZONE_PAD,
    AUTO_HIDE_POLL_MS,
    HIDE_GRACE_MS,
    HIDDEN_WINDOW_DESTROY_MS,
    HUD_WIDTH_GROWTH_RATIO,
    HUD_SECTION_DIVIDER,
  },
};
