"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const quotaGeometry = require("../src/quota-ring-geometry");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "quota-ring-renderer.js"), "utf8");

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.attributes = {};
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.listeners = new Map();
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type, extra = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ type, target: this, preventDefault() {}, ...extra });
    }
  }
}

function loadRenderer() {
  const cluster = new FakeElement("div");
  const calls = { dashboard: 0 };
  const context = {
    document: {
      createElement: (tag) => new FakeElement(tag),
    },
    window: {
      sessionHudAPI: {
        openDashboard() { calls.dashboard += 1; },
      },
    },
    setInterval() {},
    Date,
    Math,
  };
  vm.createContext(context);
  vm.runInContext(rendererSource, context);
  const api = context.ClawdHudQuota;
  return {
    calls,
    cluster,
    // Mirrors main: visibleRows/overflow come from the same provider count
    // that sizes the HUD window, unless a test pins them explicitly.
    render(snapshot, options = {}) {
      const layout = quotaGeometry.computeQuotaSectionLayout(
        quotaGeometry.countQuotaCoins({ accountQuota: snapshot }, true, options.hiddenQuotaProviders)
      );
      api.update(cluster, {
        quotaAgentIcons: {},
        displayMode: "used",
        hiddenQuotaProviders: [],
        ...layout,
        ...options,
        accountQuota: snapshot,
      });
    },
    collect(snapshot, hiddenQuotaProviders = []) {
      // Array.from runs in this realm, so deepStrictEqual compares plain arrays.
      return Array.from(api.collectQuotaRows({ accountQuota: snapshot, hiddenQuotaProviders }), (row) => row.providerKey);
    },
    rows: () => cluster.children,
    update: (payload) => api.update(cluster, payload),
  };
}

const now = Date.now();
const bucket = (usedPercent, options = {}) => ({
  usedPercent,
  windowMinutes: 300,
  resetAt: now + 3_600_000,
  lastSeenAt: now,
  ...options,
});
const plan = (key, short, long, options = {}) => ({
  host: options.host || null,
  sourceKey: options.sourceKey,
  [key]: {
    lastSeenAt: options.lastSeenAt === undefined ? now : options.lastSeenAt,
    group: {
      ...(short === undefined ? {} : { [`${key.slice(0, -5)}FiveHour`]: bucket(short, { windowMinutes: 300 }) }),
      ...(long === undefined ? {} : { [`${key.slice(0, -5)}Weekly`]: bucket(long, { windowMinutes: 10080 }) }),
    },
  },
});

function elementsWithClass(root, className) {
  const found = [];
  const visit = (node) => {
    if ((node.className || "").split(/\s+/).includes(className)) found.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return found;
}

// Value text as the row reads it ("7d(2d2h) 33%"); `withCountdown: false`
// drops the reset countdown so percentage assertions stay time-independent.
function valueText(node, { withCountdown = true } = {}) {
  if (!withCountdown && node.className === "quota-reset-in") return "";
  return node.textContent + (node.children || []).map((child) => valueText(child, { withCountdown })).join("");
}

function rowValues(row, options = { withCountdown: false }) {
  const values = elementsWithClass(row, "quota-values")[0];
  return values.children.map((child) => ({ text: valueText(child, options), className: child.className }));
}

function providerName(row) {
  return elementsWithClass(row, "provider-label")[0].textContent;
}

describe("HUD quota section rows", () => {
  it("shows long then short PLAN values with provider/window identity classes", () => {
    const renderer = loadRenderer();
    const source = plan("claudeQuota", 11, 33, { host: "build-box" });
    source.claudeQuota.group.claudeFiveHour = bucket(11, { windowMinutes: 300 });
    source.claudeQuota.group.claudeWeekly = bucket(33, { windowMinutes: 10080 });
    renderer.render([source], { quotaAgentIcons: { claudeQuota: "file:///agents/claude.png" } });

    const [row] = renderer.rows();
    assert.deepEqual(rowValues(row).map((value) => value.text), ["7d 33%", "5h 11%"]);
    assert.match(rowValues(row)[0].className, /pv-claudeQuota rg-inner sev-ok/);
    assert.match(rowValues(row)[1].className, /pv-claudeQuota rg-outer sev-ok/);
    assert.equal(elementsWithClass(row, "provider-host")[0].textContent, " · build-box");
    assert.equal(elementsWithClass(row, "provider-glyph")[0].attributes.src, "file:///agents/claude.png");
  });

  it("renders a single weekly window as one value with its long-window identity hue", () => {
    const renderer = loadRenderer();
    const source = plan("codexQuota", undefined, 12);
    source.codexQuota.group.codexWeekly = bucket(12, { windowMinutes: 10080 });
    renderer.render([source]);
    assert.deepEqual(rowValues(renderer.rows()[0]).map((value) => value.text), ["7d 12%"]);
    assert.match(rowValues(renderer.rows()[0])[0].className, /pv-codexQuota rg-inner/);
  });

  it("compresses Antigravity candidates and keeps third-party-only quota", () => {
    const renderer = loadRenderer();
    const both = { antigravityQuota: { lastSeenAt: now, group: {
      geminiFiveHour: bucket(30, { windowMinutes: 300 }),
      thirdPartyFiveHour: bucket(72, { windowMinutes: 300 }),
      geminiWeekly: bucket(98, { windowMinutes: 10080, lastSeenAt: now - 6 * 60_000 }),
      thirdPartyWeekly: bucket(40, { windowMinutes: 10080 }),
    } } };
    const thirdPartyOnly = { antigravityQuota: { lastSeenAt: now, group: {
      thirdPartyWeekly: bucket(52, { windowMinutes: 10080 }),
    } } };
    renderer.render([both, thirdPartyOnly]);
    assert.deepEqual(renderer.rows().map((row) => rowValues(row).map((value) => value.text)), [
      ["7d 40%", "5h 72%"],
      ["7d 52%"],
    ]);
  });

  it("puts the balance in the long slot of a PLAN row that has no monthly window", () => {
    const renderer = loadRenderer();
    renderer.render([{ extraQuota: { command: {
      label: "Command Code",
      lastSeenAt: now,
      limits: [
        { id: "5h", kind: "window", usedPercent: 12, windowMinutes: 300 },
        { id: "7d", kind: "window", usedPercent: 33, windowMinutes: 10080 },
        { id: "balance", kind: "balance", remaining: 43.96, unit: "credits" },
      ],
    } } }]);
    const [row] = renderer.rows();
    assert.equal(providerName(row), "Command Code");
    assert.deepEqual(rowValues(row).map((value) => value.text), ["43.96 cr", "7d 33%", "5h 12%"]);
  });

  it("shows a calendar-month window first, labelled 1mo", () => {
    const renderer = loadRenderer();
    renderer.render([{ extraQuota: { "opencode-go": {
      label: "OpenCode Go",
      lastSeenAt: now,
      limits: [
        { id: "rolling-5h", label: "5 Hour limit", kind: "window", usedPercent: 0, windowMinutes: 300 },
        { id: "weekly", label: "Weekly limit", kind: "window", usedPercent: 0, windowMinutes: 10080 },
        { id: "monthly", label: "Monthly limit", kind: "window", usedPercent: 15, resetAt: now + 86_400_000 },
      ],
    } } }], { displayMode: "remaining" });
    assert.deepEqual(rowValues(renderer.rows()[0]).map((value) => value.text), ["1mo 85%", "7d 100%", "5h 100%"]);
  });

  it("shows an API balance-only provider as one formatted amount", () => {
    const renderer = loadRenderer();
    renderer.render([{ host: "remote", extraQuota: {
      deepseek: { label: "DeepSeek", lastSeenAt: now, limits: [
        { id: "balance", kind: "balance", remaining: 43.62, unit: "cny" },
      ] },
    } }]);
    const [row] = renderer.rows();
    assert.equal(providerName(row), "DeepSeek");
    assert.deepEqual(rowValues(row).map((value) => value.text), ["¥43.62"]);
    assert.match(rowValues(row)[0].className, /pv-extraQuota rg-outer/);
    assert.equal(elementsWithClass(row, "extra-glyph")[0].textContent, "D");
  });

  it("flips PLAN percentages in remaining mode and keeps reset values muted", () => {
    const renderer = loadRenderer();
    const source = plan("claudeQuota", 20, 40);
    source.claudeQuota.group.claudeFiveHour = bucket(20, { windowMinutes: 300 });
    source.claudeQuota.group.claudeWeekly = bucket(90, { windowMinutes: 10080, resetAt: now - 1 });
    renderer.render([source], { displayMode: "remaining" });
    const [row] = renderer.rows();
    assert.deepEqual(rowValues(row).map((value) => value.text), ["7d 100%", "5h 80%"]);
    assert.match(rowValues(row)[0].className, /sev-reset/);
    assert.match(rowValues(row)[1].className, /sev-ok/);
  });

  it("lets warning and hot severity override identity classes", () => {
    const renderer = loadRenderer();
    const source = plan("claudeQuota", 60, 90);
    source.claudeQuota.group.claudeFiveHour = bucket(60, { windowMinutes: 300 });
    source.claudeQuota.group.claudeWeekly = bucket(90, { windowMinutes: 10080 });
    renderer.render([source]);
    const values = rowValues(renderer.rows()[0]);
    assert.match(values[0].className, /pv-claudeQuota rg-inner sev-hot/);
    assert.match(values[1].className, /pv-claudeQuota rg-outer sev-warn/);
  });

  it("keeps rendered provider rows in sync with geometry counting and hidden keys", () => {
    const renderer = loadRenderer();
    const snapshot = { accountQuota: [{
      antigravityQuota: { group: { geminiWeekly: bucket(22, { windowMinutes: 10080 }) } },
      claudeQuota: { group: { claudeFiveHour: bucket(11) } },
      codexQuota: { group: { codexWeekly: bucket(33, { windowMinutes: 10080 }) } },
      kimiQuota: { group: { kimiFiveHour: bucket(44) } },
      extraQuota: {
        zeta: { label: "Zeta", limits: [{ kind: "balance", remaining: 1, unit: "usd" }] },
        alpha: { label: "Alpha", limits: [{ kind: "balance", remaining: 2, unit: "usd" }] },
      },
    }] };
    for (const hidden of [[], ["codexQuota"], ["extra:alpha"], ["antigravityQuota", "extra:zeta"]]) {
      const rows = renderer.collect(snapshot.accountQuota, hidden);
      assert.equal(rows.length, quotaGeometry.countQuotaCoins(snapshot, true, hidden));
    }
    assert.deepEqual(renderer.collect(snapshot.accountQuota), [
      "antigravityQuota", "claudeQuota", "codexQuota", "kimiQuota", "extra:alpha", "extra:zeta",
    ]);
  });
  it("dims a stale provider row", () => {
    const renderer = loadRenderer();
    const source = plan("claudeQuota", 15, undefined, { lastSeenAt: now - 6 * 60_000 });
    source.claudeQuota.group.claudeFiveHour = bucket(15, {
      windowMinutes: 300,
      lastSeenAt: now - 6 * 60_000,
    });
    renderer.render([source]);
    assert.match(renderer.rows()[0].className, /is-stale/);
  });
  it("uses the longer stale window for Kimi provider data", () => {
    const renderer = loadRenderer();
    const rowAtAge = (ageMinutes) => {
      const seenAt = now - ageMinutes * 60_000;
      const source = plan("kimiQuota", 15, undefined, { lastSeenAt: seenAt });
      source.kimiQuota.group.kimiFiveHour = bucket(15, { windowMinutes: 300, lastSeenAt: seenAt });
      renderer.render([source]);
      return renderer.rows()[0];
    };
    assert.doesNotMatch(rowAtAge(6).className, /is-stale/);
    assert.match(rowAtAge(8).className, /is-stale/);
  });

  it("excludes hidden providers", () => {
    const renderer = loadRenderer();
    const claude = plan("claudeQuota", 15, undefined);
    claude.claudeQuota.group.claudeFiveHour = bucket(15, { windowMinutes: 300 });
    const codex = plan("codexQuota", undefined, 25);
    codex.codexQuota.group.codexWeekly = bucket(25, { windowMinutes: 10080 });
    renderer.render([claude, codex], { hiddenQuotaProviders: ["claudeQuota"] });
    assert.deepEqual(renderer.rows().map(providerName), ["Codex"]);
  });

  it("renders five providers and +N for overflow, and both targets open Dashboard", () => {
    const renderer = loadRenderer();
    const accountQuota = [
      { host: null, antigravityQuota: { group: { geminiFiveHour: bucket(10, { windowMinutes: 300 }) }, lastSeenAt: now } },
      ...["claudeQuota", "codexQuota", "kimiQuota"].map((key) => {
        const provider = plan(key, 10, undefined);
        provider[key].group[`${key.slice(0, -5)}FiveHour`] = bucket(10, { windowMinutes: 300 });
        return provider;
      }),
      ...["alpha", "bravo", "charlie", "delta"].map((id) => ({ extraQuota: {
        [id]: { label: id, lastSeenAt: now, limits: [{ kind: "balance", remaining: 1, unit: "usd" }] },
      } })),
    ];
    renderer.render(accountQuota, { visibleRows: 6, overflow: 3 });
    assert.equal(renderer.rows().length, 6);
    assert.deepEqual(renderer.rows().slice(0, 5).map(providerName), ["Antigravity", "Claude", "Codex", "Kimi", "alpha"]);
    const overflow = renderer.rows()[5];
    assert.equal(overflow.textContent, "+3");
    overflow.dispatch("click");
    renderer.rows()[0].dispatch("click");
    assert.equal(renderer.calls.dashboard, 2);
  });

  it("uses six rows without overflow when exactly six providers report", () => {
    const renderer = loadRenderer();
    const providers = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
      .map((id) => ({ extraQuota: { [id]: { label: id, limits: [
        { kind: "balance", remaining: 1, unit: "usd" },
      ] } } }));
    renderer.render(providers, { visibleRows: 6, overflow: 0 });
    assert.equal(renderer.rows().length, 6);
    assert.equal(elementsWithClass(renderer.cluster, "quota-overflow").length, 0);
  });

  it("draws no rows when main sized the HUD without a quota section, even with data", () => {
    const renderer = loadRenderer();
    const source = plan("claudeQuota", 11, 33);
    renderer.update({ accountQuota: [source], visibleRows: 0, overflow: 0 });
    assert.equal(renderer.rows().length, 0);
  });
});

describe("HUD quota reset countdown", () => {
  function countdowns(row) {
    return elementsWithClass(row, "quota-values")[0].children.map((value) => {
      const reset = value.children.find((child) => child.className === "quota-reset-in");
      return reset ? reset.textContent : null;
    });
  }

  it("reads each window as label(time to reset) percentage, longest window first", () => {
    const renderer = loadRenderer();
    const source = plan("claudeQuota", 11, 33);
    const t = Date.now();
    source.claudeQuota.group.claudeFiveHour = bucket(11, { windowMinutes: 300, resetAt: t + (2 * 60 + 13) * 60_000 - 30_000 });
    source.claudeQuota.group.claudeWeekly = bucket(33, { windowMinutes: 10080, resetAt: t + (3 * 24 + 4) * 3_600_000 - 30_000 });
    renderer.render([source]);
    const [row] = renderer.rows();
    assert.deepEqual(rowValues(row, { withCountdown: true }).map((value) => value.text), ["7d(3d4h) 33%", "5h(2h13m) 11%"]);
    assert.deepEqual(countdowns(row), ["(3d4h)", "(2h13m)"]);
  });

  it("drops the minor unit where two units would not fit", () => {
    const renderer = loadRenderer();
    const t = Date.now();
    const cases = [
      [12 * 24 * 60 + 300, "12d"],
      [13 * 60 + 5, "13h"],
      [45, "45m"],
      [60, "1h"],
      [24 * 60, "1d"],
    ];
    for (const [minutes, expected] of cases) {
      const source = plan("codexQuota", undefined, 12);
      source.codexQuota.group.codexWeekly = bucket(12, { windowMinutes: 10080, resetAt: t + minutes * 60_000 - 1_000 });
      renderer.render([source]);
      assert.deepEqual(countdowns(renderer.rows()[0]), [`(${expected})`], `${minutes}m left`);
    }
  });

  it("omits the countdown for a window that already reset or reports no reset time", () => {
    const renderer = loadRenderer();
    const source = plan("claudeQuota", 11, 33);
    source.claudeQuota.group.claudeFiveHour = bucket(80, { windowMinutes: 300, resetAt: Date.now() - 1_000 });
    source.claudeQuota.group.claudeWeekly = bucket(33, { windowMinutes: 10080, resetAt: undefined });
    renderer.render([source]);
    const [row] = renderer.rows();
    assert.deepEqual(rowValues(row, { withCountdown: true }).map((value) => value.text), ["7d 33%", "5h 0%"]);
    assert.deepEqual(countdowns(row), [null, null]);
  });
});
