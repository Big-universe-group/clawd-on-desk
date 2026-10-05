"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAccountQuotaStore } = require("../src/state-account-quota");

function tempPersistPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-account-quota-")), "account-quota.json");
}

describe("account quota store", () => {
  it("stores Kimi as a presence-aware provider and preserves an omitted sibling", () => {
    let nowMs = 1000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update(null, { kimiQuota: {
      kimiFiveHour: { usedPercent: 10, windowMinutes: 300, resetAt: 999999 },
      kimiWeekly: { usedPercent: 20, windowMinutes: 10080, resetAt: 999999 },
    } });
    nowMs = 2000;
    store.update(null, { kimiQuota: {
      kimiWeekly: { usedPercent: 21, windowMinutes: 10080, resetAt: 999999 },
    } });
    const group = store.snapshot()[0].kimiQuota.group;
    assert.strictEqual(group.kimiFiveHour.usedPercent, 10);
    assert.strictEqual(group.kimiWeekly.usedPercent, 21);
  });

  it("reports durable flush success and failure", () => {
    const okPath = tempPersistPath();
    const okStore = createAccountQuotaStore({ persistPath: okPath, now: () => 1000 });
    okStore.update(null, { kimiQuota: { kimiWeekly: { usedPercent: 0, resetAt: 999999 } } });
    assert.strictEqual(okStore.flush(), true);

    const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-account-quota-dir-"));
    const warnings = [];
    const badStore = createAccountQuotaStore({
      persistPath: directoryPath,
      now: () => 1000,
      logWarn: (...args) => warnings.push(args),
    });
    badStore.update(null, { kimiQuota: { kimiWeekly: { usedPercent: 0, resetAt: 999999 } } });
    assert.strictEqual(badStore.flush(), false);
    assert.strictEqual(warnings.length, 1);
  });
  it("stores per-source groups and reports change only on real change", () => {
    let nowMs = 1000000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    const group = { claudeWeekly: { usedPercent: 41, resetAt: 2000000 } };

    assert.strictEqual(store.update("pi", { claudeQuota: group }), true);
    nowMs = 1001000;
    assert.strictEqual(store.update("pi", { claudeQuota: group }), false, "identical refresh is a no-op");

    const snapshot = store.snapshot();
    assert.strictEqual(snapshot.length, 1);
    assert.strictEqual(snapshot[0].host, "pi");
    assert.deepStrictEqual(snapshot[0].claudeQuota.group, {
      claudeWeekly: { ...group.claudeWeekly, lastSeenAt: 960000 },
    });
    assert.strictEqual(snapshot[0].claudeQuota.updatedAt, 1000000, "no-op refresh must not look fresher");
  });

  it("keeps trusted remote profile sources separate when display hosts match", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    store.update("remote:profile-a", {
      displayHost: "shared.example",
      claudeQuota: { claudeWeekly: { usedPercent: 10, resetAt: 5000 } },
    });
    store.update("remote:profile-b", {
      displayHost: "shared.example",
      claudeQuota: { claudeWeekly: { usedPercent: 90, resetAt: 5000 } },
    });

    const snapshot = store.snapshot();
    assert.strictEqual(snapshot.length, 2);
    assert.deepStrictEqual(snapshot.map((entry) => entry.host), [
      "shared.example",
      "shared.example",
    ]);
    assert.deepStrictEqual(
      snapshot.map((entry) => entry.claudeQuota.group.claudeWeekly.usedPercent).sort(),
      [10, 90],
    );
  });

  it("normalizes empty/whitespace hosts to the local source and sorts local first", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    store.update("zeta", { codexQuota: { codexWeekly: { usedPercent: 43, resetAt: 5000 } } });
    store.update("  ", { codexQuota: { codexWeekly: { usedPercent: 7, resetAt: 5000 } } });
    store.update("alpha", { codexQuota: { codexWeekly: { usedPercent: 9, resetAt: 5000 } } });

    assert.deepStrictEqual(store.snapshot().map((e) => e.host), [null, "alpha", "zeta"]);
  });

  it("clears one provider from selected sources without disturbing siblings", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    const resetAt = 5000;
    store.update(null, {
      claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt } },
      codexQuota: { codexWeekly: { usedPercent: 7, resetAt } },
    });
    store.update("wsl:Ubuntu", {
      claudeQuota: { claudeWeekly: { usedPercent: 42, resetAt } },
      antigravityQuota: { thirdPartyWeekly: { usedPercent: 8, resetAt } },
    });
    store.update("remote:ssh-work", {
      displayHost: "workbox",
      claudeQuota: { claudeWeekly: { usedPercent: 90, resetAt } },
    });

    assert.strictEqual(
      store.clearProvider("claudeQuota", (sourceKey) => !sourceKey.startsWith("remote:")),
      2
    );
    assert.strictEqual(
      store.clearProvider("claudeQuota", (sourceKey) => !sourceKey.startsWith("remote:")),
      0,
      "repeated cleanup is a no-op"
    );

    const snapshot = store.snapshot();
    const local = snapshot.find((entry) => entry.host === null);
    const wsl = snapshot.find((entry) => entry.host === "wsl:Ubuntu");
    const remote = snapshot.find((entry) => entry.host === "workbox");
    assert.strictEqual(local.claudeQuota, undefined);
    assert.strictEqual(local.codexQuota.group.codexWeekly.usedPercent, 7);
    assert.strictEqual(wsl.claudeQuota, undefined);
    assert.strictEqual(wsl.antigravityQuota.group.thirdPartyWeekly.usedPercent, 8);
    assert.strictEqual(remote.claudeQuota.group.claudeWeekly.usedPercent, 90);
    assert.strictEqual(store.clearProvider("notAProvider"), 0);
  });

  it("flags expired buckets at snapshot time instead of hiding them", () => {
    let nowMs = 1000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update(null, {
      claudeQuota: {
        claudeFiveHour: { usedPercent: 80, resetAt: 2000 },
        claudeWeekly: { usedPercent: 41, resetAt: 999999 },
      },
    });

    nowMs = 3000; // the five-hour window has reset on wall clock
    const group = store.snapshot()[0].claudeQuota.group;
    // Kept but flagged: renderers draw a dimmed reset state, never the
    // pre-reset high (which would lie) and never a vanished gauge (which
    // reads as broken).
    assert.strictEqual(group.claudeFiveHour.expired, true);
    assert.strictEqual(group.claudeWeekly.expired, undefined);
    assert.strictEqual(group.claudeWeekly.usedPercent, 41);
  });

  it("merges partial reports per bucket instead of evicting siblings", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    store.update(null, {
      codexQuota: {
        codexFiveHour: { usedPercent: 4, resetAt: 999999 },
        codexWeekly: { usedPercent: 43, resetAt: 999999 },
      },
    });
    // Real Codex token_count payloads can legitimately carry only the
    // primary window — the weekly bucket must survive the partial report.
    store.update(null, { codexQuota: { codexFiveHour: { usedPercent: 9, resetAt: 999999 } } });

    const group = store.snapshot()[0].codexQuota.group;
    assert.strictEqual(group.codexFiveHour.usedPercent, 9);
    assert.strictEqual(group.codexWeekly.usedPercent, 43, "partial report must not evict the sibling bucket");
  });

  it("replaces a window-aware Codex snapshot so a removed short window cannot linger", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    store.update(null, {
      codexQuota: {
        codexFiveHour: {
          usedPercent: 4,
          windowMinutes: 300,
          resetAt: 999999,
          capturedAt: 100,
        },
        codexWeekly: {
          usedPercent: 43,
          windowMinutes: 10080,
          resetAt: 999999,
          capturedAt: 100,
        },
      },
    });
    store.update(null, {
      codexQuota: {
        codexWeekly: {
          usedPercent: 12,
          windowMinutes: 10080,
          resetAt: 999999,
          capturedAt: 200,
        },
      },
    });

    const group = store.snapshot()[0].codexQuota.group;
    assert.strictEqual(group.codexFiveHour, undefined);
    assert.deepStrictEqual(group.codexWeekly, {
      usedPercent: 12,
      windowMinutes: 10080,
      resetAt: 999999,
      lastSeenAt: 0,
    });
  });

  it("keeps generic and Spark providers isolated while replacing each complete snapshot independently", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    const dual = (fiveHour, weekly, capturedAt) => ({
      codexFiveHour: {
        usedPercent: fiveHour,
        windowMinutes: 300,
        resetAt: 999999,
        capturedAt,
      },
      codexWeekly: {
        usedPercent: weekly,
        windowMinutes: 10080,
        resetAt: 999999,
        capturedAt,
      },
    });
    store.update(null, {
      codexQuota: dual(4, 43, 100),
      codexSparkQuota: dual(1, 8, 100),
    });

    store.update(null, {
      codexSparkQuota: {
        codexWeekly: {
          usedPercent: 12,
          windowMinutes: 10080,
          resetAt: 999999,
          capturedAt: 200,
        },
      },
    });
    let snapshot = store.snapshot()[0];
    assert.strictEqual(snapshot.codexQuota.group.codexFiveHour.usedPercent, 4);
    assert.strictEqual(snapshot.codexQuota.group.codexWeekly.usedPercent, 43);
    assert.strictEqual(snapshot.codexSparkQuota.group.codexFiveHour, undefined);
    assert.strictEqual(snapshot.codexSparkQuota.group.codexWeekly.usedPercent, 12);

    store.update(null, {
      codexQuota: {
        codexWeekly: {
          usedPercent: 17,
          windowMinutes: 10080,
          resetAt: 999999,
          capturedAt: 300,
        },
      },
    });
    snapshot = store.snapshot()[0];
    assert.strictEqual(snapshot.codexQuota.group.codexFiveHour, undefined);
    assert.strictEqual(snapshot.codexQuota.group.codexWeekly.usedPercent, 17);
    assert.strictEqual(snapshot.codexSparkQuota.group.codexWeekly.usedPercent, 12);
  });

  it("rejects out-of-order complete Spark snapshots without affecting generic quota", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    store.update(null, {
      codexQuota: {
        codexWeekly: { usedPercent: 20, windowMinutes: 10080, resetAt: 999999, capturedAt: 300 },
      },
      codexSparkQuota: {
        codexWeekly: { usedPercent: 8, windowMinutes: 10080, resetAt: 999999, capturedAt: 200 },
      },
    });

    assert.strictEqual(store.update(null, {
      codexSparkQuota: {
        codexFiveHour: { usedPercent: 99, windowMinutes: 300, resetAt: 999999, capturedAt: 100 },
      },
    }), false);
    const snapshot = store.snapshot()[0];
    assert.strictEqual(snapshot.codexQuota.group.codexWeekly.usedPercent, 20);
    assert.strictEqual(snapshot.codexSparkQuota.group.codexFiveHour, undefined);
    assert.strictEqual(snapshot.codexSparkQuota.group.codexWeekly.usedPercent, 8);
  });

  it("rejects an older complete Codex snapshot before it can relocate newer windows", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    store.update(null, {
      codexQuota: {
        codexWeekly: {
          usedPercent: 12,
          windowMinutes: 10080,
          resetAt: 999999,
          capturedAt: 200,
        },
      },
    });

    assert.strictEqual(store.update(null, {
      codexQuota: {
        codexFiveHour: {
          usedPercent: 99,
          windowMinutes: 300,
          resetAt: 999999,
          capturedAt: 100,
        },
      },
    }), false);
    const group = store.snapshot()[0].codexQuota.group;
    assert.strictEqual(group.codexFiveHour, undefined);
    assert.strictEqual(group.codexWeekly.usedPercent, 12);
  });

  it("shape-sanitizes the reporting host label (control chars stripped, length capped)", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    store.update(`evil\u0000host\n${"x".repeat(200)}`, {
      claudeQuota: { claudeWeekly: { usedPercent: 1, resetAt: 999999 } },
    });

    const host = store.snapshot()[0].host;
    assert.strictEqual(/[\x00-\x1f\x7f]/.test(host), false, "control chars must be stripped");
    assert.ok(host.length <= 64, `host too long: ${host.length}`);
    assert.ok(host.startsWith("evilhost"));
  });

  it("snapshot returns cloned buckets, not live references into the store", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    store.update(null, { claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt: 999999 } } });

    store.snapshot()[0].claudeQuota.group.claudeWeekly.usedPercent = 99;

    assert.strictEqual(store.snapshot()[0].claudeQuota.group.claudeWeekly.usedPercent, 41);
  });

  it("ignores unknown provider keys and invalid groups", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    assert.strictEqual(store.update("pi", {
      bogusQuota: { x: { usedPercent: 1 } },
      claudeQuota: { claudeWeekly: { usedPercent: "nope" } },
    }), false);
    assert.deepStrictEqual(store.snapshot(), []);
  });

  it("mergeSources collapses to one entry with the freshest report per provider", () => {
    let nowMs = 1000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update("pi", {
      claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt: 999999 } },
      codexQuota: { codexWeekly: { usedPercent: 43, resetAt: 999999 } },
    });
    nowMs = 2000; // local reports codex later - its numbers must win
    store.update(null, { codexQuota: { codexWeekly: { usedPercent: 9, resetAt: 999999 } } });

    const merged = store.snapshot({ mergeSources: true });
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].host, null, "merged entry is unlabeled");
    assert.strictEqual(merged[0].claudeQuota.group.claudeWeekly.usedPercent, 41, "remote-only provider survives");
    assert.strictEqual(merged[0].codexQuota.group.codexWeekly.usedPercent, 9, "freshest reporter wins per provider");
    // Default stays per-source (the maintainer's shape).
    assert.strictEqual(store.snapshot().length, 2);
    // Single source needs no merging.
    assert.strictEqual(store.snapshot({ mergeSources: true })[0].claudeQuota.updatedAt, 1000);
  });

  it("mergeSources arbitrates generic and Spark independently", () => {
    let nowMs = 1000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update("remote", {
      codexQuota: { codexWeekly: { usedPercent: 40, resetAt: 999999 } },
      codexSparkQuota: { codexWeekly: { usedPercent: 5, resetAt: 999999 } },
    });
    nowMs = 2000;
    store.update(null, {
      codexQuota: { codexWeekly: { usedPercent: 10, resetAt: 999999 } },
    });
    nowMs = 3000;
    store.update("remote", {
      codexSparkQuota: { codexWeekly: { usedPercent: 9, resetAt: 999999 } },
    });

    const merged = store.snapshot({ mergeSources: true })[0];
    assert.strictEqual(merged.codexQuota.group.codexWeekly.usedPercent, 10);
    assert.strictEqual(merged.codexSparkQuota.group.codexWeekly.usedPercent, 9);
  });

  it("persists on flush and reloads last-known numbers (app-restart survival)", () => {
    const persistPath = tempPersistPath();
    const group = { claudeWeekly: { usedPercent: 41, resetAt: 9999999 } };
    const store = createAccountQuotaStore({ persistPath, now: () => 1234 });
    store.update("pi", { claudeQuota: group });
    store.flush();

    const reloaded = createAccountQuotaStore({ persistPath, now: () => 5678 });
    const snapshot = reloaded.snapshot();
    assert.strictEqual(snapshot.length, 1);
    assert.strictEqual(snapshot[0].host, "pi");
    assert.deepStrictEqual(snapshot[0].claudeQuota.group, {
      claudeWeekly: { ...group.claudeWeekly, lastSeenAt: 0 },
    });
    assert.strictEqual(snapshot[0].claudeQuota.updatedAt, 1234, "persisted stamp survives reload");
  });

  it("persists Spark quota in the current schema and reloads it independently", () => {
    const persistPath = tempPersistPath();
    const store = createAccountQuotaStore({ persistPath, now: () => 1234 });
    store.update("pi", {
      codexQuota: { codexWeekly: { usedPercent: 41, resetAt: 9999999 } },
      codexSparkQuota: { codexWeekly: { usedPercent: 7, resetAt: 9999999 } },
    });
    store.flush();

    const persisted = JSON.parse(fs.readFileSync(persistPath, "utf8"));
    assert.strictEqual(persisted.version, 7);
    assert.strictEqual(persisted.sources[0].codexSparkQuota.group.codexWeekly.usedPercent, 7);
    const snapshot = createAccountQuotaStore({ persistPath, now: () => 5678 }).snapshot()[0];
    assert.strictEqual(snapshot.codexQuota.group.codexWeekly.usedPercent, 41);
    assert.strictEqual(snapshot.codexSparkQuota.group.codexWeekly.usedPercent, 7);
  });

  it("drops ambiguous pre-v6 Codex cache while preserving Spark and unrelated providers", () => {
    const persistPath = tempPersistPath();
    fs.writeFileSync(persistPath, JSON.stringify({
      version: 5,
      sources: [{
        host: null,
        codexQuota: {
          group: {
            codexFiveHour: {
              usedPercent: 7,
              windowMinutes: 300,
              resetAt: 9999999,
            },
            codexWeekly: {
              usedPercent: 19,
              windowMinutes: 10080,
              resetAt: 9999999,
            },
          },
          updatedAt: 1000,
          lastSeenAt: 1000,
        },
        codexSparkQuota: {
          group: {
            codexWeekly: {
              usedPercent: 7,
              windowMinutes: 10080,
              resetAt: 9999999,
            },
          },
          updatedAt: 1000,
          lastSeenAt: 1000,
        },
        claudeQuota: {
          group: { claudeWeekly: { usedPercent: 41, resetAt: 9999999 } },
          updatedAt: 1000,
          lastSeenAt: 1000,
        },
      }],
    }));

    const snapshot = createAccountQuotaStore({ persistPath, now: () => 2000 }).snapshot();
    assert.strictEqual(snapshot.length, 1);
    assert.strictEqual(snapshot[0].codexQuota, undefined);
    assert.strictEqual(snapshot[0].codexSparkQuota.group.codexWeekly.usedPercent, 7);
    assert.strictEqual(snapshot[0].claudeQuota.group.claudeWeekly.usedPercent, 41);
  });

  it("treats a missing or corrupt persist file as an empty store", () => {
    const persistPath = tempPersistPath();
    assert.deepStrictEqual(createAccountQuotaStore({ persistPath, now: () => 1 }).snapshot(), []);

    fs.writeFileSync(persistPath, "{not json");
    assert.deepStrictEqual(createAccountQuotaStore({ persistPath, now: () => 1 }).snapshot(), []);
  });

  it("rejects out-of-order capturedAt per bucket (two-session oscillation)", () => {
    let nowMs = 1000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    // Session A observed 10% at t=500, session B observed 20% at t=800.
    store.update(null, { codexQuota: { codexWeekly: { usedPercent: 10, resetAt: 999999, capturedAt: 500 } } });
    nowMs = 2000;
    store.update(null, { codexQuota: { codexWeekly: { usedPercent: 20, resetAt: 999999, capturedAt: 800 } } });
    // Session A replays its cached (older) observation later — must lose.
    nowMs = 3000;
    assert.strictEqual(
      store.update(null, { codexQuota: { codexWeekly: { usedPercent: 10, resetAt: 999999, capturedAt: 500 } } }),
      false
    );
    assert.strictEqual(store.snapshot()[0].codexQuota.group.codexWeekly.usedPercent, 20);
  });

  it("strips capturedAt from snapshots and keeps it out of change detection", () => {
    let nowMs = 1000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update(null, { codexQuota: { codexWeekly: { usedPercent: 10, resetAt: 999999, capturedAt: 500 } } });
    // Same numbers, newer observation, same minute: neither a value change
    // nor a seen-quantum advance — no broadcast, or every token_count line
    // would re-broadcast the full snapshot.
    nowMs = 1500;
    assert.strictEqual(
      store.update(null, { codexQuota: { codexWeekly: { usedPercent: 10, resetAt: 999999, capturedAt: 900 } } }),
      false
    );
    assert.strictEqual(store.snapshot()[0].codexQuota.group.codexWeekly.capturedAt, undefined);
  });

  it("caps distinct sources and keeps accepting updates for existing ones", () => {
    const { MAX_SOURCES } = require("../src/state-account-quota");
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000 });
    const group = { claudeQuota: { claudeWeekly: { usedPercent: 1, resetAt: 999999 } } };
    for (let i = 0; i < MAX_SOURCES; i++) {
      assert.strictEqual(store.update(`host-${i}`, group), true);
    }
    // A hostile/buggy reporter cycling names must not grow the store further.
    assert.strictEqual(store.update("host-overflow", group), false);
    assert.strictEqual(store.snapshot().length, MAX_SOURCES);
    // Existing sources are unaffected by the cap.
    assert.strictEqual(
      store.update("host-0", { claudeQuota: { claudeWeekly: { usedPercent: 50, resetAt: 999999 } } }),
      true
    );
  });

  it("rejects already-expired and implausibly-distant resetAt at write time", () => {
    const { MAX_RESET_AHEAD_MS } = require("../src/state-account-quota");
    const store = createAccountQuotaStore({ persistPath: null, now: () => 1000000 });
    assert.strictEqual(store.update(null, {
      claudeQuota: {
        claudeFiveHour: { usedPercent: 80, resetAt: 999000 }, // already reset: wrong, not stale
        claudeWeekly: { usedPercent: 41, resetAt: 1000000 + MAX_RESET_AHEAD_MS + 1 }, // never-expiring pin
      },
    }), false);
    assert.deepStrictEqual(store.snapshot(), []);
  });

  it("advances lastSeenAt on identical confirmations (bounded to minute quanta)", () => {
    let nowMs = 60000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    const group = { claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt: 99999999 } } };
    store.update("pi", group);
    // Identical confirmation in the same minute: silent.
    nowMs = 90000;
    assert.strictEqual(store.update("pi", group), false);
    // Identical confirmation in a NEW minute: the reporter is alive and the
    // freshness label must say so — one broadcast per minute at most.
    nowMs = 121000;
    assert.strictEqual(store.update("pi", group), true);
    const provider = store.snapshot()[0].claudeQuota;
    assert.strictEqual(provider.lastSeenAt, 120000, "snapshot lastSeenAt is minute-quantized");
    assert.strictEqual(provider.updatedAt, 60000, "identical numbers never bump updatedAt");
  });

  it("merge arbitration follows lastSeenAt and prefers live buckets over expired ones", () => {
    let nowMs = 60000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    // Local changed a value once, then went quiet.
    store.update(null, { codexQuota: { codexWeekly: { usedPercent: 9, resetAt: 99999999 } } });
    // Remote keeps confirming the same number long after.
    nowMs = 120000;
    store.update("pi", { codexQuota: { codexWeekly: { usedPercent: 41, resetAt: 99999999 } } });
    nowMs = 600000;
    store.update("pi", { codexQuota: { codexWeekly: { usedPercent: 41, resetAt: 99999999 } } });
    assert.strictEqual(
      store.snapshot({ mergeSources: true })[0].codexQuota.group.codexWeekly.usedPercent,
      41,
      "the actively-confirming reporter wins, not the last value-changer"
    );

    // A freshly-seen source whose buckets ALL expired says "nothing", not
    // "zero" — an older source with live buckets must win the merge.
    nowMs = 700000;
    store.update("mini", { claudeQuota: { claudeFiveHour: { usedPercent: 90, resetAt: 800000 } } });
    nowMs = 750000;
    store.update(null, { claudeQuota: { claudeWeekly: { usedPercent: 30, resetAt: 99999999 } } });
    nowMs = 900000; // mini's only bucket has now reset; mini keeps confirming
    store.update("mini", { claudeQuota: { claudeFiveHour: { usedPercent: 91, resetAt: 850000 } } });
    const mergedClaude = store.snapshot({ mergeSources: true })[0].claudeQuota.group;
    assert.strictEqual(mergedClaude.claudeWeekly.usedPercent, 30);
    assert.strictEqual(mergedClaude.claudeFiveHour, undefined);
  });

  it("merge arbitration selects each bucket independently across mixed live and expired sources", () => {
    let nowMs = 60000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update("remote", {
      codexQuota: {
        codexFiveHour: { usedPercent: 20, resetAt: 1000000 },
        codexWeekly: { usedPercent: 70, resetAt: 1000000 },
      },
    });
    nowMs = 120000;
    store.update(null, {
      codexQuota: {
        codexFiveHour: { usedPercent: 25, resetAt: 1000000 },
        codexWeekly: { usedPercent: 80, resetAt: 150000 },
      },
    });
    nowMs = 180000;
    store.update(null, { codexQuota: { codexFiveHour: { usedPercent: 30, resetAt: 1000000 } } });

    const provider = store.snapshot({ mergeSources: true })[0].codexQuota;
    assert.strictEqual(provider.group.codexFiveHour.usedPercent, 30, "fresh local 5h wins");
    assert.strictEqual(provider.group.codexWeekly.usedPercent, 70, "live remote weekly beats expired local weekly");
    assert.strictEqual(provider.group.codexWeekly.expired, undefined);
    assert.strictEqual(provider.lastSeenAt, 60000, "mixed provider is aged by its oldest selected source");
  });

  it("merge arbitration uses exact observation time inside a minute", () => {
    let nowMs = 61000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update(null, { claudeQuota: { claudeWeekly: { usedPercent: 10, resetAt: 1000000 } } });
    nowMs = 119000;
    store.update("remote", { claudeQuota: { claudeWeekly: { usedPercent: 90, resetAt: 1000000 } } });

    const provider = store.snapshot({ mergeSources: true })[0].claudeQuota;
    assert.strictEqual(provider.group.claudeWeekly.usedPercent, 90);
    assert.strictEqual(provider.lastSeenAt, 60000, "renderer-facing freshness stays minute-quantized");
  });

  it("does not let a fresh partial window refresh an untouched sibling", () => {
    let nowMs = 60000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update("a", { claudeQuota: { claudeWeekly: { usedPercent: 90, resetAt: 1000000 } } });
    nowMs = 120000;
    store.update("b", { claudeQuota: { claudeWeekly: { usedPercent: 20, resetAt: 1000000 } } });
    nowMs = 180000;
    store.update("a", { claudeQuota: { claudeFiveHour: { usedPercent: 10, resetAt: 1000000 } } });

    const merged = store.snapshot({ mergeSources: true })[0].claudeQuota.group;
    assert.strictEqual(merged.claudeFiveHour.usedPercent, 10);
    assert.strictEqual(merged.claudeWeekly.usedPercent, 20,
      "A's fresh 5h report must not make its old weekly bucket beat B");
  });

  it("prunes long-expired buckets, unconfirmed providers, and emptied sources", () => {
    const { EXPIRED_BUCKET_DROP_AFTER_MS, PROVIDER_RETENTION_MS } = require("../src/state-account-quota");
    let nowMs = 1000000;
    const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
    store.update("pi", {
      claudeQuota: {
        claudeFiveHour: { usedPercent: 80, resetAt: 2000000 },
        claudeWeekly: { usedPercent: 41 }, // no resetAt: only retention can retire it
      },
    });

    // Freshly expired: kept, flagged (dimmed reset ring).
    nowMs = 2000001;
    assert.strictEqual(store.snapshot()[0].claudeQuota.group.claudeFiveHour.expired, true);

    // Expired past the drop window: the bucket is gone, the sibling stays.
    nowMs = 2000000 + EXPIRED_BUCKET_DROP_AFTER_MS;
    const group = store.snapshot()[0].claudeQuota.group;
    assert.strictEqual(group.claudeFiveHour, undefined);
    assert.strictEqual(group.claudeWeekly.usedPercent, 41);

    // Nothing confirmed the provider within retention: source disappears.
    nowMs = 1000000 + PROVIDER_RETENTION_MS;
    assert.deepStrictEqual(store.snapshot(), []);
  });

  it("prunes at load so a dead persist file does not resurrect zombie sources", () => {
    const { PROVIDER_RETENTION_MS } = require("../src/state-account-quota");
    const persistPath = tempPersistPath();
    const store = createAccountQuotaStore({ persistPath, now: () => 1000 });
    store.update("pi", { claudeQuota: { claudeWeekly: { usedPercent: 41, resetAt: 99999999999 } } });
    store.flush();

    const reloaded = createAccountQuotaStore({ persistPath, now: () => 1000 + PROVIDER_RETENTION_MS });
    assert.deepStrictEqual(reloaded.snapshot(), []);
  });

  describe("extra providers", () => {
    const BASE = 1_000_000_000;
    const HOUR = 60 * 60 * 1000;

    it("sanitizes, orders and caps a provider report", () => {
      const { MAX_RESET_AHEAD_MS } = require("../src/state-account-quota");
      const store = createAccountQuotaStore({ persistPath: null, now: () => BASE });
      store.update(null, { extraQuota: {
        "Bad ID": { label: "nope", limits: [{ id: "x", kind: "balance", remaining: 1, unit: "usd" }] },
        deepseek: {
          label: "Deep\u0000Seek\n",
          limits: [
            { id: "deepseek:balance:CNY", label: "Balance", kind: "balance", remaining: 43.62, unit: "CNY" },
            { id: "weekly", label: "Weekly", kind: "window", usedPercent: 140, windowMinutes: 10080, resetAt: BASE + HOUR },
            { id: "monthly", label: "Monthly", kind: "window", usedPercent: 3, resetAt: BASE + HOUR },
            { id: "5h", label: "5 Hour", kind: "window", usedPercent: 12.4, windowMinutes: 300, resetAt: BASE + HOUR },
            { id: "5h", label: "duplicate", kind: "window", usedPercent: 99, windowMinutes: 300 },
            { id: "reset", label: "Already reset", kind: "window", usedPercent: 50, resetAt: BASE - 1 },
            { id: "far", label: "Implausible", kind: "window", usedPercent: 50, resetAt: BASE + MAX_RESET_AHEAD_MS + 1 },
            { id: "bogus", kind: "meter", usedPercent: 1 },
            { id: "", kind: "balance", remaining: 1 },
          ],
        },
      } });

      const extra = store.snapshot()[0].extraQuota;
      assert.deepStrictEqual(Object.keys(extra), ["deepseek"]);
      assert.strictEqual(extra.deepseek.label, "DeepSeek");
      assert.deepStrictEqual(extra.deepseek.limits, [
        { id: "5h", label: "5 Hour", kind: "window", usedPercent: 12, windowMinutes: 300, resetAt: BASE + HOUR },
        { id: "weekly", label: "Weekly", kind: "window", usedPercent: 100, windowMinutes: 10080, resetAt: BASE + HOUR },
        { id: "monthly", label: "Monthly", kind: "window", usedPercent: 3, resetAt: BASE + HOUR },
        { id: "deepseek:balance:CNY", label: "Balance", kind: "balance", remaining: 43.62, unit: "cny" },
      ]);
    });

    it("caps providers per source and limits per provider", () => {
      const { MAX_EXTRA_PROVIDERS, MAX_EXTRA_LIMITS } = require("../src/state-account-quota");
      const store = createAccountQuotaStore({ persistPath: null, now: () => BASE });
      const limits = Array.from({ length: MAX_EXTRA_LIMITS + 4 }, (_, i) => ({
        id: `b${i}`, kind: "balance", remaining: i, unit: "credits",
      }));
      const extraQuota = {};
      for (let i = 0; i < MAX_EXTRA_PROVIDERS + 4; i++) extraQuota[`p${i}`] = { label: `P${i}`, limits };
      store.update(null, { extraQuota });
      const extra = store.snapshot()[0].extraQuota;
      assert.strictEqual(Object.keys(extra).length, MAX_EXTRA_PROVIDERS);
      assert.strictEqual(extra.p0.limits.length, MAX_EXTRA_LIMITS);
      // Existing providers keep updating at the cap.
      store.update(null, { extraQuota: { p0: { label: "P0", limits: [limits[0]] } } });
      assert.strictEqual(store.snapshot()[0].extraQuota.p0.limits.length, 1);
    });

    it("replaces a provider's limits wholesale and rejects older complete reports", () => {
      let nowMs = BASE;
      const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
      const window = (id, usedPercent, windowMinutes) => ({
        id, label: id, kind: "window", usedPercent, windowMinutes, resetAt: BASE + 10 * HOUR,
      });
      store.update(null, { extraQuota: { commandcode: {
        label: "Command Code", capturedAt: BASE - 100, limits: [window("5h", 10, 300), window("7d", 40, 10080)],
      } } });
      nowMs = BASE + 1000;
      store.update(null, { extraQuota: { commandcode: {
        label: "Command Code", capturedAt: BASE, limits: [window("7d", 41, 10080)],
      } } });
      assert.deepStrictEqual(
        store.snapshot()[0].extraQuota.commandcode.limits.map((limit) => [limit.id, limit.usedPercent]),
        [["7d", 41]],
        "a newer report retires the omitted 5h limit"
      );

      const stale = store.updateDetailed(null, { extraQuota: { commandcode: {
        label: "Command Code", capturedAt: BASE - 50, limits: [window("5h", 99, 300)],
      } } });
      assert.deepStrictEqual(stale, { accepted: false, changed: false });
      assert.deepStrictEqual(
        store.snapshot()[0].extraQuota.commandcode.limits.map((limit) => limit.id),
        ["7d"]
      );
    });

    it("reports change only on value change or a lastSeenAt minute crossing", () => {
      const { SEEN_QUANTUM_MS } = require("../src/state-account-quota");
      let nowMs = BASE;
      const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
      const report = { extraQuota: { deepseek: {
        label: "DeepSeek", limits: [{ id: "bal", kind: "balance", remaining: 43.62, unit: "cny" }],
      } } };
      assert.strictEqual(store.update(null, report), true);
      nowMs = BASE + 1000;
      assert.strictEqual(store.update(null, report), false, "identical refresh within a minute is a no-op");
      assert.strictEqual(store.snapshot()[0].extraQuota.deepseek.updatedAt, BASE);
      nowMs = BASE + SEEN_QUANTUM_MS;
      assert.strictEqual(store.update(null, report), true, "freshness label moves once a minute");
      const provider = store.snapshot()[0].extraQuota.deepseek;
      assert.strictEqual(provider.updatedAt, BASE, "confirmation does not look like a value change");
      assert.strictEqual(provider.lastSeenAt, Math.floor(nowMs / SEEN_QUANTUM_MS) * SEEN_QUANTUM_MS);
    });

    it("flags reset windows, drops them later, and keeps balances until retention", () => {
      const { EXPIRED_BUCKET_DROP_AFTER_MS, PROVIDER_RETENTION_MS } = require("../src/state-account-quota");
      let nowMs = BASE;
      const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
      store.update(null, { extraQuota: { commandcode: { label: "Command Code", limits: [
        { id: "5h", kind: "window", usedPercent: 10, windowMinutes: 300, resetAt: BASE + HOUR },
        { id: "balance", kind: "balance", remaining: 43.96, unit: "credits" },
      ] } } });

      nowMs = BASE + HOUR;
      let limits = store.snapshot()[0].extraQuota.commandcode.limits;
      assert.strictEqual(limits[0].expired, true);
      assert.strictEqual(limits[1].expired, undefined);

      nowMs = BASE + HOUR + EXPIRED_BUCKET_DROP_AFTER_MS;
      limits = store.snapshot()[0].extraQuota.commandcode.limits;
      assert.deepStrictEqual(limits.map((limit) => limit.id), ["balance"]);

      nowMs = BASE + PROVIDER_RETENTION_MS;
      assert.deepStrictEqual(store.snapshot(), []);
    });

    it("persists extra providers in v7 and still loads v6 files", () => {
      const persistPath = tempPersistPath();
      const store = createAccountQuotaStore({ persistPath, now: () => BASE });
      store.update(null, { extraQuota: { "opencode-go": { label: "OpenCode Go", capturedAt: BASE - 5, limits: [
        { id: "rolling-5h", label: "5 Hour limit", kind: "window", usedPercent: 0, windowMinutes: 300, resetAt: BASE + HOUR },
      ] } } });
      assert.strictEqual(store.flush(), true);
      assert.strictEqual(JSON.parse(fs.readFileSync(persistPath, "utf8")).version, 7);

      const reloaded = createAccountQuotaStore({ persistPath, now: () => BASE + 1000 });
      const provider = reloaded.snapshot()[0].extraQuota["opencode-go"];
      assert.strictEqual(provider.label, "OpenCode Go");
      assert.strictEqual(provider.updatedAt, BASE);
      assert.deepStrictEqual(provider.limits, [
        { id: "rolling-5h", label: "5 Hour limit", kind: "window", usedPercent: 0, windowMinutes: 300, resetAt: BASE + HOUR },
      ]);
      // capturedAt survives the reload, so an older report is still rejected.
      assert.strictEqual(reloaded.updateDetailed(null, { extraQuota: { "opencode-go": {
        label: "OpenCode Go", capturedAt: BASE - 10, limits: [{ id: "x", kind: "balance", remaining: 1 }],
      } } }).accepted, false);

      const v6Path = tempPersistPath();
      fs.writeFileSync(v6Path, JSON.stringify({ version: 6, sources: [{
        sourceKey: "",
        host: null,
        codexQuota: { group: { codexWeekly: { usedPercent: 41, resetAt: BASE + HOUR, seenAt: BASE } }, updatedAt: BASE, lastSeenAt: BASE },
      }] }));
      const fromV6 = createAccountQuotaStore({ persistPath: v6Path, now: () => BASE }).snapshot();
      assert.strictEqual(fromV6[0].codexQuota.group.codexWeekly.usedPercent, 41);
      assert.strictEqual(fromV6[0].extraQuota, undefined);
    });

    it("mergeSources takes the freshest live report per provider without mixing limits", () => {
      let nowMs = BASE;
      const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
      const report = (usedPercent, resetAt, extraLimit) => ({ extraQuota: { zai: { label: "Z.ai", limits: [
        { id: "5h", kind: "window", usedPercent, windowMinutes: 300, resetAt },
        ...(extraLimit ? [extraLimit] : []),
      ] } } });
      store.update(null, report(10, BASE + HOUR, { id: "bal", kind: "balance", remaining: 5, unit: "usd" }));
      nowMs = BASE + 1000;
      store.update("remote", report(20, BASE + 2 * HOUR));
      let merged = store.snapshot({ mergeSources: true });
      assert.strictEqual(merged.length, 1);
      assert.deepStrictEqual(
        merged[0].extraQuota.zai.limits.map((limit) => [limit.id, limit.usedPercent]),
        [["5h", 20]],
        "freshest source wins wholesale; the older source's balance is not mixed in"
      );

      // A fully-expired report loses to an older live one.
      nowMs = BASE + HOUR + 1;
      store.update("remote", report(30, BASE + HOUR + 2));
      nowMs = BASE + HOUR + 3;
      merged = store.snapshot({ mergeSources: true });
      assert.deepStrictEqual(
        merged[0].extraQuota.zai.limits.map((limit) => limit.id),
        ["5h", "bal"],
        "local still has a live balance"
      );
    });

    it("clearing a fixed provider keeps a source that still has extra providers", () => {
      const store = createAccountQuotaStore({ persistPath: null, now: () => BASE });
      store.update(null, {
        claudeQuota: { claudeWeekly: { usedPercent: 5, resetAt: BASE + HOUR } },
        extraQuota: { deepseek: { label: "DeepSeek", limits: [{ id: "bal", kind: "balance", remaining: 1, unit: "cny" }] } },
      });
      assert.strictEqual(store.clearProvider("claudeQuota"), 1);
      assert.strictEqual(store.clearProvider("extraQuota"), 0, "only fixed provider keys are clearable");
      const [entry] = store.snapshot();
      assert.strictEqual(entry.claudeQuota, undefined);
      assert.deepStrictEqual(Object.keys(entry.extraQuota), ["deepseek"]);
    });

    it("moves the session snapshot signature on extra value/label/freshness changes only", () => {
      const { buildSessionSnapshot, sessionSnapshotSignature } = require("../src/state-session-snapshot");
      const { SEEN_QUANTUM_MS } = require("../src/state-account-quota");
      let nowMs = BASE;
      const store = createAccountQuotaStore({ persistPath: null, now: () => nowMs });
      const signature = () => sessionSnapshotSignature(buildSessionSnapshot(new Map(), {
        statePriority: {},
        getAgentIconUrl: () => null,
        accountQuota: store.snapshot(),
      }));
      const report = (remaining, label = "DeepSeek") => ({ extraQuota: { deepseek: {
        label, limits: [{ id: "bal", kind: "balance", remaining, unit: "cny" }],
      } } });
      store.update(null, report(43.62));
      const original = signature();
      nowMs = BASE + 1000;
      store.update(null, report(43.62));
      assert.strictEqual(signature(), original, "same-minute confirmation does not re-broadcast");
      store.update(null, report(40));
      const changedValue = signature();
      assert.notStrictEqual(changedValue, original);
      store.update(null, report(40, "DeepSeek CN"));
      const changedLabel = signature();
      assert.notStrictEqual(changedLabel, changedValue);
      nowMs = BASE + SEEN_QUANTUM_MS;
      store.update(null, report(40, "DeepSeek CN"));
      assert.notStrictEqual(signature(), changedLabel, "lastSeenAt minute crossing reaches renderers");
    });
  });
});
