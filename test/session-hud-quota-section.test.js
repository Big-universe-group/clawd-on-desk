"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const Module = require("node:module");

const SESSION_HUD_PATH = require.resolve("../src/ui/hud/session-hud");

function loadSessionHud(platform) {
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.visible = false;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.destroyed = false;
      this.webContents.sent = [];
      this.webContents.isDestroyed = () => this.webContents.destroyed;
      this.webContents.send = (...args) => this.webContents.sent.push(args);
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setAlwaysOnTop() {}
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    loadFile(file) {
      this.file = file;
      queueMicrotask(() => this.webContents.emit("did-finish-load"));
    }
    destroy() {
      this.destroyed = true;
      this.webContents.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }
  }

  const fakeElectron = {
    BrowserWindow: FakeWindow,
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  };
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  delete require.cache[SESSION_HUD_PATH];
  try {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    Module._load = function patchedLoad(request) {
      if (request === "electron") return fakeElectron;
      if (request === "./taskbar") return { keepOutOfTaskbar() {} };
      if (request === "./text-scale") {
        return {
          clampTextScale: (value) => value,
          scaleHeight: (value, scale) => Math.round(value * scale),
          applyZoomToWindow() {},
        };
      }
      return originalLoad.apply(this, arguments);
    };
    return { initSessionHud: require(SESSION_HUD_PATH), windows };
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

const claude = (usedPercent) => ({
  updatedAt: 1,
  group: { claudeFiveHour: { usedPercent, resetAt: 9_999_999_999_999, windowMinutes: 300 } },
});

function snapshotWith({ sessions = [], providers = 1 } = {}) {
  const accountQuota = [];
  for (let i = 0; i < providers; i++) accountQuota.push({ host: i ? `remote-${i}` : null, claudeQuota: claude(20) });
  return { sessions, accountQuota };
}

const session = (id) => ({ id, state: "working", headless: false, updatedAt: Date.now() });

function makeContext(snapshot, overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    sessionHudEnabled: true,
    sessionHudPinned: true,
    sessionHudShowQuota: true,
    sessionHudShowElapsed: false,
    sessionHudShowStateLabels: false,
    sessionHudShowContextUsage: false,
    quotaRingHiddenProviders: [],
    quotaRingDisplayMode: "used",
    lowPowerIdleMode: false,
    getTextScale: () => 1,
    getSessionSnapshot: () => snapshot,
    getPetWindowBounds: () => ({ x: 400, y: 300, width: 120, height: 120 }),
    getHitRectScreen: () => ({ left: 400, top: 300, right: 520, bottom: 420 }),
    getSessionHudAnchorRect: () => null,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    ...overrides,
  };
}

async function startHud(snapshot, overrides) {
  const runtime = loadSessionHud("darwin");
  const context = makeContext(snapshot, overrides);
  const hud = runtime.initSessionHud(context);
  hud.syncSessionHud(snapshot);
  await new Promise((resolve) => setImmediate(resolve));
  const lastPayload = () => {
    const sent = runtime.windows[0].webContents.sent.filter(([channel]) => channel === "session-hud:session-snapshot");
    return sent.length ? sent.at(-1)[1] : null;
  };
  return { ...runtime, context, hud, lastPayload };
}

describe("Session HUD quota section", () => {
  it("draws sessions and quota in ONE window below the pet, sized for both sections", async () => {
    const { windows, hud, lastPayload } = await startHud(snapshotWith({ sessions: [session("a"), session("b")], providers: 3 }));
    assert.equal(windows.length, 1, "no separate quota window");
    const [win] = windows;
    assert.match(win.file, /session-hud\.html$/);
    assert.ok(win.isVisible());
    // shell top 2 + (2*28 + 2 + 3*26 + 2) + shell bottom 8
    assert.equal(win.bounds.height, 2 + 138 + 8);
    assert.ok(win.bounds.y >= 420, "box sits below the pet");
    assert.ok(win.bounds.width >= 250 + 6, "box widens to fit quota rows");
    const payload = lastPayload();
    assert.equal(payload.hudShowSessions, true);
    assert.equal(payload.quota.visibleRows, 3);
    assert.equal(payload.quota.overflow, 0);
    hud.cleanup();
  });

  it("shows a quota-only box when the sessions section is turned off", async () => {
    const { windows, hud, lastPayload } = await startHud(
      snapshotWith({ sessions: [session("a")], providers: 2 }),
      { sessionHudEnabled: false }
    );
    assert.ok(windows[0].isVisible());
    assert.equal(windows[0].bounds.height, 2 + (2 * 26 + 2) + 8);
    assert.equal(lastPayload().hudShowSessions, false);
    hud.cleanup();
  });

  it("drops the quota section when quota is switched off, leaving sessions only", async () => {
    const { windows, hud, lastPayload } = await startHud(
      snapshotWith({ sessions: [session("a")], providers: 2 }),
      { sessionHudShowQuota: false }
    );
    assert.equal(windows[0].bounds.height, 2 + (28 + 2) + 8);
    assert.equal(lastPayload().quota.visibleRows, 0);
    hud.cleanup();
  });

  it("resends the snapshot on a reposition when the section shape changed", async () => {
    const snapshot = snapshotWith({ sessions: [session("a")], providers: 1 });
    const { hud, lastPayload, context } = await startHud(snapshot);
    assert.equal(lastPayload().quota.visibleRows, 1);
    // A provider hidden in Settings: reposition-only syncs must still tell
    // the renderer, or it would draw a row the window no longer has room for.
    context.quotaRingHiddenProviders = ["claudeQuota"];
    hud.repositionSessionHud();
    assert.equal(lastPayload().quota.visibleRows, 0);
    hud.cleanup();
  });
});
