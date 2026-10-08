"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const quotaGeometry = require("../src/quota/ring-geometry");
const {
  countQuotaCoins,
  formatWindowLabel,
  quotaSeverity,
  computeQuotaSectionLayout,
  listQuotaRingProviders,
  selectExtraRingLimits,
  formatExtraWindowLabel,
} = quotaGeometry;

const bucket = (usedPercent) => ({ usedPercent, resetAt: 9_999_999_999_999 });

describe("quota section provider counting", () => {
  it("counts each drawable provider row per source and honors hidden providers", () => {
    const snapshot = {
      accountQuota: [
        { host: null, claudeQuota: { group: { claudeFiveHour: bucket(10), claudeWeekly: bucket(20) } } },
        { host: "remote", codexQuota: { group: { codexWeekly: bucket(35) } } },
        { host: null, codexSparkQuota: { group: { codexWeekly: bucket(3) } } },
      ],
    };
    assert.equal(countQuotaCoins(snapshot, true), 2);
    assert.equal(countQuotaCoins(snapshot, true, ["codexQuota"]), 1);
    assert.equal(countQuotaCoins(snapshot, false), 0);
  });

  it("counts API balances and extra providers without exposing empty data", () => {
    const snapshot = { accountQuota: [{ extraQuota: {
      balance: { label: "Balance", limits: [{ kind: "balance", remaining: 4, unit: "usd" }] },
      empty: { label: "Empty", limits: [] },
    } }] };
    assert.equal(countQuotaCoins(snapshot, true), 1);
    assert.equal(countQuotaCoins(snapshot, true, ["extra:balance"]), 0);
  });
});
describe("quota provider visibility and extra selection", () => {
  it("lists only reporting providers and preserves hidden state for Settings", () => {
    const snapshot = { accountQuota: [{
      claudeQuota: { group: { claudeWeekly: bucket(30) } },
      extraQuota: {
        zeta: { label: "Zeta", limits: [{ kind: "balance", remaining: 1, unit: "usd" }] },
        alpha: { label: "Alpha", limits: [{ kind: "balance", remaining: 2, unit: "usd" }] },
      },
    }] };
    assert.deepEqual(listQuotaRingProviders(snapshot, ["claudeQuota", "extra:zeta"]), [
      { key: "claudeQuota", label: "Claude", hidden: true },
      { key: "extra:alpha", label: "Alpha", hidden: false },
      { key: "extra:zeta", label: "Zeta", hidden: true },
    ]);
  });

  it("selects up to three PLAN values: short, weekly, then a month or the balance", () => {
    const short = { id: "5h", kind: "window", usedPercent: 10, windowMinutes: 300 };
    const weekly = { id: "7d", kind: "window", usedPercent: 20, windowMinutes: 10080 };
    // A calendar month has no fixed length; it still takes the third slot.
    const monthly = { id: "monthly", label: "Monthly limit", kind: "window", usedPercent: 30 };
    const balance = { id: "balance", kind: "balance", remaining: 4, unit: "usd" };
    assert.deepEqual(selectExtraRingLimits([short, weekly, monthly, balance]), {
      outer: short, inner: weekly, third: monthly, balance: null,
    });
    // No third window: the balance stands in for it (Command Code).
    assert.deepEqual(selectExtraRingLimits([weekly, short, balance]), {
      outer: short, inner: weekly, third: balance, balance: null,
    });
    assert.deepEqual(selectExtraRingLimits([short, weekly]), {
      outer: short, inner: weekly, third: null, balance: null,
    });
    assert.deepEqual(selectExtraRingLimits([balance]), { outer: null, inner: null, third: null, balance });
  });

  it("shortens labels of windows without a fixed length", () => {
    assert.equal(formatExtraWindowLabel({ label: "Monthly limit" }), "1mo");
    assert.equal(formatExtraWindowLabel({ label: "Daily limit" }), "Daily");
    assert.equal(formatExtraWindowLabel({ label: "5 Hour limit", windowMinutes: 300 }), "5h");
  });
});

describe("quota section layout", () => {
  it("shows every provider up to six rows", () => {
    assert.deepEqual(computeQuotaSectionLayout(0), { visibleRows: 0, overflow: 0 });
    assert.deepEqual(computeQuotaSectionLayout(2), { visibleRows: 2, overflow: 0 });
    assert.deepEqual(computeQuotaSectionLayout(6), { visibleRows: 6, overflow: 0 });
  });

  it("caps eight providers at five rows plus a +3 row", () => {
    assert.deepEqual(computeQuotaSectionLayout(8), { visibleRows: 6, overflow: 3 });
  });
});

describe("quota row labels and severity", () => {
  it("formats time windows from their durations", () => {
    assert.equal(formatWindowLabel(300, "short"), "5h");
    assert.equal(formatWindowLabel(10080, "long"), "7d");
    assert.equal(formatWindowLabel(90, "custom"), "90m");
    assert.equal(formatWindowLabel(0, "fallback"), "fallback");
  });

  it("maps used percentages to warning and hot severity", () => {
    assert.equal(quotaSeverity(59), "ok");
    assert.equal(quotaSeverity(60), "warn");
    assert.equal(quotaSeverity(85), "warn");
    assert.equal(quotaSeverity(86), "hot");
  });
});

describe("quota section width estimate", () => {
  const { estimateQuotaSectionWidth } = quotaGeometry;
  const openCodeGo = {
    host: null,
    extraQuota: {
      "opencode-go": {
        label: "OpenCode Go",
        limits: [
          { kind: "window", usedPercent: 95, windowMinutes: 300, resetAt: 9_999_999_999_999 },
          { kind: "window", usedPercent: 95, windowMinutes: 10080, resetAt: 9_999_999_999_999 },
          { kind: "window", usedPercent: 82, label: "Monthly limit", resetAt: 9_999_999_999_999 },
        ],
      },
    },
  };
  const claude = { host: null, claudeQuota: { group: { claudeFiveHour: bucket(10), claudeWeekly: bucket(20) } } };

  // Measured in the real HUD (macOS system font): "OpenCode Go" plus
  // "1mo(28d) 82%  7d(5d12h) 95%  5h(4h59m) 100%" needs a 425px row.
  it("covers a three-window row with countdowns so its label does not truncate", () => {
    assert.ok(estimateQuotaSectionWidth({ accountQuota: [openCodeGo] }, true, []) >= 425);
  });

  it("grows with the widest row's columns and ignores hidden or disabled quota", () => {
    const both = estimateQuotaSectionWidth({ accountQuota: [claude, openCodeGo] }, true, []);
    const claudeOnly = estimateQuotaSectionWidth({ accountQuota: [claude, openCodeGo] }, true, ["extra:opencode-go"]);
    assert.equal(both, estimateQuotaSectionWidth({ accountQuota: [openCodeGo] }, true, []));
    assert.ok(claudeOnly < both);
    assert.equal(estimateQuotaSectionWidth({ accountQuota: [claude] }, false, []), 0);
  });

  // Rows share columns, so a long identity on one row and a balance column
  // on another both widen the table: neither row alone is enough.
  it("sums each shared column's widest cell across rows", () => {
    const remoteClaude = { ...claude, host: "build-server-eu-west" };
    const deepseek = { host: null, extraQuota: { deepseek: {
      label: "DeepSeek", limits: [{ kind: "balance", remaining: 43.62, unit: "cny" }],
    } } };
    const table = estimateQuotaSectionWidth({ accountQuota: [remoteClaude, deepseek] }, true, []);
    assert.ok(table > estimateQuotaSectionWidth({ accountQuota: [remoteClaude] }, true, []));
    assert.ok(table > estimateQuotaSectionWidth({ accountQuota: [deepseek] }, true, []));
  });
});
