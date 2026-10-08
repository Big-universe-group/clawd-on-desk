const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/ui/menu/menu");

function loadMenuWithElectron(fakeElectron) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/ui/menu/menu");
  } finally {
    Module._load = originalLoad;
  }
}

// The tray menu is built from a Menu and attached through ctx.tray; the fake
// records every built Menu so the "menu-will-show" subscription can be
// inspected (real Electron Menu is an EventEmitter).
function makeFakeElectron() {
  const built = [];
  return {
    built,
    electron: {
      app: { quit: () => {}, setActivationPolicy: () => {}, dock: { show: () => {}, hide: () => {} } },
      BrowserWindow: function BrowserWindow() {},
      Menu: {
        buildFromTemplate(template) {
          const menu = {
            template,
            listeners: new Map(),
            on(event, handler) {
              menu.listeners.set(event, handler);
              return menu;
            },
          };
          built.push(menu);
          return menu;
        },
      },
      Tray: function Tray() {},
      nativeImage: {
        createFromPath() {
          return { resize() { return this; }, setTemplateImage() {} };
        },
      },
      screen: {
        getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1 }),
      },
    },
  };
}

function buildBaseCtx(overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    sessions: new Map(),
    currentSize: "P:15",
    doNotDisturb: false,
    lang: "en",
    showTray: true,
    showDock: true,
    openAtLogin: false,
    bubbleFollowPet: false,
    hideBubbles: false,
    soundMuted: false,
    petHidden: false,
    tray: null,
    contextMenuOwner: null,
    contextMenu: null,
    isQuitting: false,
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    getDisableMiniMode: () => false,
    getActiveThemeCapabilities: () => ({ miniMode: true }),
    openDashboard: () => {},
    openSettingsWindow: () => {},
    togglePetVisibility: () => {},
    bringPetToPrimaryDisplay: () => {},
    enableDoNotDisturb: () => {},
    disableDoNotDisturb: () => {},
    enterMiniViaMenu: () => {},
    exitMiniMode: () => {},
    miniHandleResize: () => false,
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 120, height: 120 }),
    applyPetWindowBounds: () => {},
    getCurrentPixelSize: () => ({ width: 200, height: 200 }),
    isProportionalMode: () => true,
    repositionBubbles: () => {},
    syncHitWin: () => {},
    flushRuntimeStateToPrefs: () => {},
    reapplyMacVisibility: () => {},
    clampToScreenVisual: (x, y) => ({ x, y }),
    ...overrides,
  };
}

describe("tray menu dismisses the completion alert on open", () => {
  it("invokes ctx.dismissCompletionAlerts when the tray menu is shown", () => {
    const { electron, built } = makeFakeElectron();
    const initMenu = loadMenuWithElectron(electron);
    let dismissed = 0;
    const menu = initMenu(buildBaseCtx({
      tray: { setContextMenu() {} },
      dismissCompletionAlerts: () => { dismissed += 1; },
    }));

    menu.buildTrayMenu();

    const onShow = built.at(-1).listeners.get("menu-will-show");
    assert.strictEqual(typeof onShow, "function", "tray menu must subscribe to menu-will-show");

    onShow();
    assert.strictEqual(dismissed, 1);
  });

  it("re-subscribes on every rebuild so the attached menu stays wired", () => {
    const { electron, built } = makeFakeElectron();
    const initMenu = loadMenuWithElectron(electron);
    let dismissed = 0;
    const menu = initMenu(buildBaseCtx({
      tray: { setContextMenu() {} },
      dismissCompletionAlerts: () => { dismissed += 1; },
    }));

    menu.buildTrayMenu();
    const first = built.at(-1);
    menu.buildTrayMenu();
    const second = built.at(-1);

    assert.notStrictEqual(first, second, "rebuild must produce a fresh Menu");
    assert.strictEqual(typeof second.listeners.get("menu-will-show"), "function");
    second.listeners.get("menu-will-show")();
    assert.strictEqual(dismissed, 1, "the attached menu, not a stale one, must drive the dismiss");
  });

  it("tolerates a ctx without the dismiss capability", () => {
    const { electron, built } = makeFakeElectron();
    const initMenu = loadMenuWithElectron(electron);
    const menu = initMenu(buildBaseCtx({ tray: { setContextMenu() {} } }));

    menu.buildTrayMenu();

    assert.doesNotThrow(() => built.at(-1).listeners.get("menu-will-show")());
  });
});
