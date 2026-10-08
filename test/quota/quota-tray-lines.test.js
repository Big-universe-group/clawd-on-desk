"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildQuotaTrayLines,
  createQuotaTrayRefreshScheduler,
} = require("../../src/quota/tray-lines");

const NOW = 10_000_000;

function windowLimit(id, label, windowMinutes, usedPercent, resetAt = NOW + 60_000) {
  return { id, label, kind: "window", windowMinutes, usedPercent, resetAt, lastSeenAt: NOW };
}

function quotaFixture() {
  return {
    accountQuota: [{
      sourceKey: "",
      host: null,
      claudeQuota: {
        updatedAt: NOW,
        lastSeenAt: NOW,
        group: {
          claudeFiveHour: { usedPercent: 22.4, windowMinutes: 300, resetAt: NOW + 60_000, lastSeenAt: NOW },
          claudeWeekly: { usedPercent: 66.5, windowMinutes: 10080, resetAt: NOW + 60_000, lastSeenAt: NOW },
        },
      },
      extraQuota: {
        deepseek: {
          label: "DeepSeek",
          updatedAt: NOW,
          lastSeenAt: NOW,
          limits: [{ id: "balance", label: "Balance", kind: "balance", remaining: 43.62, unit: "cny" }],
        },
        commandcode: {
          label: "Command Code",
          updatedAt: NOW,
          lastSeenAt: NOW,
          limits: [
            windowLimit("five-hour", "5h", 300, 11.2),
            windowLimit("weekly", "7d", 10080, 33.2),
            { id: "balance", label: "Balance", kind: "balance", remaining: 8.5, unit: "usd" },
          ],
        },
        "opencode-go": {
          label: "OpenCode Go",
          updatedAt: NOW,
          lastSeenAt: NOW,
          limits: [
            windowLimit("five-hour", "5h", 300, 10),
            windowLimit("weekly", "7d", 10080, 44),
            // Real OMP shape: a calendar month carries no window length.
            windowLimit("monthly", "Monthly limit", undefined, 90),
          ],
        },
      },
    }],
  };
}

function formatterOptions(overrides = {}) {
  return { now: NOW, ...overrides };
}

describe("quota tray lines", () => {
  it("formats real-shaped Claude and extra-provider snapshots in ring draw order", () => {
    assert.deepStrictEqual(buildQuotaTrayLines(quotaFixture(), formatterOptions()), [
      "Claude  7d 67% · 5h 22%",
      "Command Code  $8.50 · 7d 33% · 5h 11%",
      "DeepSeek  ¥43.62",
      "OpenCode Go  1mo 90% · 7d 44% · 5h 10%",
    ]);
  });

  it("keeps every drawable extra provider without the ring's six-coin cap", () => {
    const extraQuota = {};
    for (let index = 0; index < 7; index += 1) {
      const id = `coin-${index}`;
      extraQuota[id] = {
        label: `Provider ${index}`,
        limits: [{ id: "balance", label: "Balance", kind: "balance", remaining: index, unit: "usd" }],
      };
    }
    const lines = buildQuotaTrayLines({ accountQuota: [{ host: null, extraQuota }] }, formatterOptions());
    assert.strictEqual(lines.length, 7);
    assert.strictEqual(lines[0], "Provider 0  $0.00");
    assert.strictEqual(lines[6], "Provider 6  $6.00");
  });

  it("uses the remaining mode for windows but leaves balance amounts unchanged", () => {
    assert.deepStrictEqual(buildQuotaTrayLines(quotaFixture(), formatterOptions({ displayMode: "remaining" })), [
      "Claude  7d 34% · 5h 78%",
      "Command Code  $8.50 · 7d 67% · 5h 89%",
      "DeepSeek  ¥43.62",
      "OpenCode Go  1mo 10% · 7d 56% · 5h 90%",
    ]);
  });

  it("uses ring hidden-provider keys for fixed and extra providers", () => {
    assert.deepStrictEqual(buildQuotaTrayLines(quotaFixture(), formatterOptions({
      hiddenProviders: ["claudeQuota", "extra:commandcode", "extra:deepseek"],
    })), ["OpenCode Go  1mo 90% · 7d 44% · 5h 10%"]);
  });

  it("adds the source host suffix only for remote sources", () => {
    const snapshot = quotaFixture();
    snapshot.accountQuota.push({
      sourceKey: "remote:profile-1",
      host: "build-worker",
      claudeQuota: snapshot.accountQuota[0].claudeQuota,
    });
    assert.deepStrictEqual(buildQuotaTrayLines(snapshot, formatterOptions()).slice(-1), [
      "Claude (build-worker)  7d 67% · 5h 22%",
    ]);
  });

  it("formats expired fixed and extra windows as 0% used and 100% remaining", () => {
    const snapshot = {
      accountQuota: [{
        sourceKey: "",
        host: null,
        claudeQuota: {
          lastSeenAt: NOW,
          group: {
            claudeFiveHour: { usedPercent: 80, windowMinutes: 300, resetAt: NOW, lastSeenAt: NOW },
            claudeWeekly: { usedPercent: 90, windowMinutes: 10080, expired: true, lastSeenAt: NOW },
          },
        },
        extraQuota: {
          "expired-plan": {
            label: "Expired Plan",
            lastSeenAt: NOW,
            limits: [
              windowLimit("five-hour", "5h", 300, 80, NOW),
              windowLimit("weekly", "7d", 10080, 90, NOW),
            ],
          },
        },
      }],
    };
    assert.deepStrictEqual(buildQuotaTrayLines(snapshot, formatterOptions()), [
      "Claude  7d 0% · 5h 0%",
      "Expired Plan  7d 0% · 5h 0%",
    ]);
    assert.deepStrictEqual(buildQuotaTrayLines(snapshot, formatterOptions({ displayMode: "remaining" })), [
      "Claude  7d 100% · 5h 100%",
      "Expired Plan  7d 100% · 5h 100%",
    ]);
  });

  it("selects the most constrained Antigravity window per ring", () => {
    const snapshot = {
      accountQuota: [{
        host: null,
        antigravityQuota: {
          lastSeenAt: NOW,
          group: {
            geminiFiveHour: { usedPercent: 20, windowMinutes: 300, lastSeenAt: NOW },
            thirdPartyFiveHour: { usedPercent: 55, windowMinutes: 300, lastSeenAt: NOW },
            geminiWeekly: { usedPercent: 35, windowMinutes: 10080, lastSeenAt: NOW },
            thirdPartyWeekly: { usedPercent: 70, windowMinutes: 10080, lastSeenAt: NOW },
          },
        },
      }],
    };
    assert.deepStrictEqual(buildQuotaTrayLines(snapshot, formatterOptions()), [
      "Antigravity  7d 70% · 5h 55%",
    ]);
  });
});

describe("quota tray refresh throttle", () => {
  it("coalesces quota bursts and never requests work while disabled", () => {
    let clock = 1000;
    let enabled = true;
    let nextId = 0;
    const jobs = new Map();
    const refreshedAt = [];
    const scheduler = createQuotaTrayRefreshScheduler({
      isEnabled: () => enabled,
      refresh: () => refreshedAt.push(clock),
      now: () => clock,
      setTimeout(callback, delay) {
        const id = ++nextId;
        jobs.set(id, { at: clock + delay, callback });
        return id;
      },
      clearTimeout(id) { jobs.delete(id); },
    });
    const advanceTo = (nextTime) => {
      clock = nextTime;
      while (true) {
        const due = [...jobs.entries()].find(([, job]) => job.at <= clock);
        if (!due) return;
        jobs.delete(due[0]);
        due[1].callback();
      }
    };

    assert.strictEqual(scheduler.request(), true);
    assert.deepStrictEqual(refreshedAt, [1000]);
    clock = 1100;
    assert.strictEqual(scheduler.request(), true);
    clock = 1200;
    assert.strictEqual(scheduler.request(), false, "a burst shares one pending refresh");
    assert.strictEqual(jobs.size, 1);
    advanceTo(30_999);
    assert.deepStrictEqual(refreshedAt, [1000]);
    advanceTo(31_000);
    assert.deepStrictEqual(refreshedAt, [1000, 31_000]);

    enabled = false;
    assert.strictEqual(scheduler.request(), false);
    assert.strictEqual(jobs.size, 0);
    assert.deepStrictEqual(refreshedAt, [1000, 31_000]);
  });
});
