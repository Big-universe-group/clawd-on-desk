"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const path = require("node:path");

const { createAccountQuotaStore } = require("../../src/quota/account-store");
const {
  mapOmpUsageReport,
  parseOmpUsageOutput,
  createOmpUsageSource,
  OMP_USAGE_ARGS,
} = require("../../src/agents/omp/quota-source");
const {
  mapCodexRateLimitsResponse,
  createCodexAppServerSource,
} = require("../../src/agents/codex/quota-source");
const {
  CLAUDE_USAGE_ENDPOINT,
  SECURITY_BIN,
  KEYCHAIN_SERVICE,
  RATE_LIMIT_BACKOFF_MS,
  parseClaudeCredentials,
  mapClaudeUsageResponse,
  classifyClaudeUsageResponse,
  createClaudeOAuthSource,
} = require("../../src/agents/claude-code/quota-source");
const { resolveCliBinary, buildCliEnv } = require("../../src/quota/cli-binary");

// Sanitized real `omp usage --json --redact` output (capacity section elided;
// it is not read).
const OMP_SAMPLE = {
  generatedAt: 1791099130137,
  reports: [
    {
      provider: "anthropic",
      fetchedAt: 1791099118788,
      limits: [
        {
          id: "anthropic:5h",
          label: "Claude 5 Hour",
          scope: { provider: "anthropic", windowId: "5h", shared: true },
          window: { id: "5h", label: "5 Hour", durationMs: 18000000, resetsAt: 1791111000462 },
          amount: { used: 35, limit: 100, remaining: 65, usedFraction: 0.35, remainingFraction: 0.65, unit: "percent" },
          status: "ok",
        },
        {
          id: "anthropic:7d",
          label: "Claude 7 Day",
          scope: { provider: "anthropic", windowId: "7d", shared: true },
          window: { id: "7d", label: "7 Day", durationMs: 604800000, resetsAt: 1791468000462 },
          amount: { used: 33, limit: 100, remaining: 67, usedFraction: 0.33, remainingFraction: 0.6699999999999999, unit: "percent" },
          status: "ok",
        },
      ],
    },
    {
      provider: "deepseek",
      fetchedAt: 1791099130135,
      limits: [
        {
          id: "deepseek:balance:CNY",
          label: "CNY 余额（赠送 0 + 充值 43.62）",
          scope: { provider: "deepseek", windowId: "balance", shared: true },
          amount: { remaining: 43.62, unit: "credits" },
          status: "ok",
        },
        {
          id: "deepseek:statusline",
          label: "状态栏占位（无真实日额度）",
          scope: { provider: "deepseek", windowId: "1d", tier: "¥43.62", shared: true },
          window: { id: "1d", label: "1d", durationMs: 86400000 },
          amount: { used: 0, usedFraction: 0, unit: "percent" },
          status: "ok",
        },
      ],
    },
    {
      provider: "opencode-go",
      fetchedAt: 1791098965453,
      limits: [
        {
          id: "rolling-5h",
          label: "5 Hour limit",
          scope: { provider: "opencode-go", windowId: "5h", shared: true },
          window: { id: "5h", label: "5 Hour", resetsAt: 1791116965304, durationMs: 18000000 },
          amount: { used: 0, usedFraction: 0, remainingFraction: 1, unit: "percent" },
          status: "ok",
        },
        {
          id: "weekly",
          label: "Weekly limit",
          scope: { provider: "opencode-go", windowId: "7d", shared: true },
          window: { id: "7d", label: "Weekly", resetsAt: 1791158400000, durationMs: 604800000 },
          amount: { used: 0, usedFraction: 0, remainingFraction: 1, unit: "percent" },
          status: "ok",
        },
        {
          id: "monthly",
          label: "Monthly limit",
          scope: { provider: "opencode-go", windowId: "monthly", shared: true },
          window: { id: "monthly", label: "Monthly", resetsAt: 1793746936000 },
          amount: { used: 0, usedFraction: 0, remainingFraction: 1, unit: "percent" },
          status: "ok",
        },
      ],
    },
    {
      provider: "commandcode",
      fetchedAt: 1791098965748,
      limits: [
        {
          id: "commandcode:5h",
          label: "5-hour limit",
          scope: { provider: "commandcode", accountId: "89*", windowId: "5h", shared: true },
          window: { id: "5h", label: "5-hour", durationMs: 18000000, resetsAt: 1791111412492 },
          amount: { used: 0.005211472, limit: 14, usedFraction: 0.000372248, unit: "credits" },
          status: "ok",
        },
        {
          id: "commandcode:7d",
          label: "Weekly limit",
          scope: { provider: "commandcode", accountId: "89*", windowId: "7d", shared: true },
          window: { id: "7d", label: "Weekly", durationMs: 604800000, resetsAt: 1791534637193 },
          amount: { used: 15.416839865, limit: 35, usedFraction: 0.440481139, unit: "credits" },
          status: "ok",
        },
        {
          id: "commandcode:balance",
          label: "Credit balance",
          scope: { provider: "commandcode", accountId: "89*", windowId: "balance", shared: true },
          amount: { remaining: 43.9644636339, unit: "credits" },
        },
      ],
    },
  ],
  accountsWithoutUsage: [],
  disabledCredentials: [],
};
const OMP_NOW = 1791099130137;

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.written = [];
  child.stdinEnded = false;
  child.killed = false;
  child.stdin = {
    write: (data) => { child.written.push(data); },
    end: () => { child.stdinEnded = true; },
    on: () => {},
  };
  child.kill = () => { child.killed = true; };
  return child;
}

function fakeSpawn(onSpawn) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = fakeChild();
    calls.push({ command, args, options, child });
    onSpawn(child);
    return child;
  };
  return { spawn, calls };
}

describe("omp usage source", () => {
  it("maps the real UsageReport sample onto the quota contract", () => {
    const mapped = mapOmpUsageReport(OMP_SAMPLE, OMP_NOW);
    assert.deepStrictEqual(mapped.providers, ["Claude", "DeepSeek", "OpenCode Go", "Command Code"]);
    assert.deepStrictEqual(mapped.quotas.claudeQuota, {
      claudeFiveHour: { usedPercent: 35, windowMinutes: 300, resetAt: 1791111000462, capturedAt: 1791099118788 },
      claudeWeekly: { usedPercent: 33, windowMinutes: 10080, resetAt: 1791468000462, capturedAt: 1791099118788 },
    });
    assert.strictEqual(mapped.quotas.codexQuota, undefined);

    const extra = mapped.quotas.extraQuota;
    assert.deepStrictEqual(Object.keys(extra), ["deepseek", "opencode-go", "commandcode"]);
    assert.deepStrictEqual(extra.deepseek, {
      label: "DeepSeek",
      capturedAt: 1791099130135,
      limits: [{
        id: "deepseek:balance:CNY",
        label: "CNY 余额（赠送 0 + 充值 43.62）",
        kind: "balance",
        remaining: 43.62,
        unit: "cny",
      }],
    }, "the zero-used, reset-less statusline placeholder is dropped");
    assert.deepStrictEqual(extra.commandcode.limits.map((limit) => [limit.id, limit.kind, limit.usedPercent ?? limit.remaining]), [
      ["commandcode:5h", "window", 0],
      ["commandcode:7d", "window", 44],
      ["commandcode:balance", "balance", 43.9644636339],
    ]);
    assert.strictEqual(extra.commandcode.limits[2].unit, "credits");
    assert.deepStrictEqual(extra["opencode-go"].limits.map((limit) => [limit.id, limit.windowMinutes, limit.usedPercent]), [
      ["rolling-5h", 300, 0],
      ["weekly", 10080, 0],
      ["monthly", undefined, 0],
    ]);

    const serialized = JSON.stringify(mapped);
    assert.doesNotMatch(serialized, /accountId|89\*|scope|status/, "no identity or raw fields carried over");
  });

  it("keeps a not-yet-started window that has a real capacity, but not a placeholder", () => {
    const report = { reports: [{
      provider: "commandcode",
      fetchedAt: OMP_NOW,
      limits: [
        // Fresh 5h window: nothing spent yet, so no reset instant either.
        { id: "commandcode:5h", label: "5-hour limit", window: { id: "5h", durationMs: 18000000 },
          amount: { used: 0, limit: 14, usedFraction: 0, unit: "credits" } },
        // Percent-only zero with no reset: still no information.
        { id: "commandcode:other", label: "Other", window: { id: "1d", durationMs: 86400000 },
          amount: { used: 0, limit: 100, usedFraction: 0, unit: "percent" } },
        // Tier-scoped statusline view, even with a capacity.
        { id: "commandcode:statusline", label: "Statusline", scope: { tier: "pro" },
          window: { id: "1d", durationMs: 86400000 }, amount: { used: 0, limit: 5, usedFraction: 0, unit: "credits" } },
      ],
    }] };
    const mapped = mapOmpUsageReport(report, OMP_NOW);
    assert.deepStrictEqual(mapped.quotas.extraQuota.commandcode.limits, [
      { id: "commandcode:5h", label: "5-hour limit", kind: "window", usedPercent: 0, windowMinutes: 300 },
    ]);
  });

  it("lands in the account store with the contract ordering", () => {
    const store = createAccountQuotaStore({ persistPath: null, now: () => OMP_NOW });
    store.update(null, mapOmpUsageReport(OMP_SAMPLE, OMP_NOW).quotas);
    const [entry] = store.snapshot();
    assert.strictEqual(entry.claudeQuota.group.claudeFiveHour.usedPercent, 35);
    assert.strictEqual(entry.claudeQuota.group.claudeWeekly.usedPercent, 33);
    assert.deepStrictEqual(entry.extraQuota.deepseek.limits.map((limit) => [limit.kind, limit.remaining, limit.unit]), [
      ["balance", 43.62, "cny"],
    ]);
    assert.deepStrictEqual(entry.extraQuota.commandcode.limits.map((limit) => limit.kind), ["window", "window", "balance"]);
    assert.strictEqual(entry.extraQuota["opencode-go"].label, "OpenCode Go");
  });

  it("maps openai-codex windows by duration and ignores tier-scoped limits", () => {
    const window = (id, minutes, usedFraction, tier) => ({
      id,
      label: id,
      scope: { provider: "openai-codex", windowId: id, ...(tier ? { tier } : {}) },
      window: { id, label: id, durationMs: minutes * 60000, resetsAt: OMP_NOW + 3600000 },
      amount: { usedFraction, unit: "percent" },
    });
    const mapped = mapOmpUsageReport({ reports: [{
      provider: "openai-codex",
      fetchedAt: OMP_NOW,
      limits: [window("spark-5h", 300, 0.9, "spark"), window("5h", 300, 0.12), window("7d", 10080, 0.5)],
    }] }, OMP_NOW);
    assert.deepStrictEqual(mapped.providers, ["Codex"]);
    assert.strictEqual(mapped.quotas.codexQuota.codexFiveHour.usedPercent, 12);
    assert.strictEqual(mapped.quotas.codexQuota.codexWeekly.usedPercent, 50);
    assert.strictEqual(mapped.quotas.codexQuota.codexWeekly.windowMinutes, 10080);
  });

  it("parses JSON preceded by a warning line", () => {
    assert.deepStrictEqual(parseOmpUsageOutput("warning: something\n{\"reports\":[]}\n"), { reports: [] });
    assert.strictEqual(parseOmpUsageOutput("not json"), null);
  });

  it("spawns `omp usage --json --redact` and reports ok with provider labels", async () => {
    const { spawn, calls } = fakeSpawn((child) => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify(OMP_SAMPLE)));
        child.emit("close", 0);
      });
    });
    const source = createOmpUsageSource({
      spawn,
      resolveBinary: () => "/opt/homebrew/bin/omp",
      now: () => OMP_NOW,
      platform: "darwin",
      env: { PATH: "/usr/bin" },
      homeDir: "/Users/me",
    });
    const result = await source.run({});
    assert.strictEqual(result.state, "ok");
    assert.deepStrictEqual(result.providers, ["Claude", "DeepSeek", "OpenCode Go", "Command Code"]);
    assert.strictEqual(calls[0].command, "/opt/homebrew/bin/omp");
    assert.deepStrictEqual(calls[0].args, OMP_USAGE_ARGS);
    assert.deepStrictEqual(OMP_USAGE_ARGS, ["usage", "--json", "--redact"]);
    assert.ok(calls[0].options.env.PATH.split(":").includes("/opt/homebrew/bin"));
  });

  it("reports unavailable without a binary and error on a failing exit", async () => {
    const missing = createOmpUsageSource({ resolveBinary: () => null, spawn: () => assert.fail("must not spawn") });
    assert.deepStrictEqual(await missing.run({}), { state: "unavailable", detail: "omp CLI not found" });

    const { spawn } = fakeSpawn((child) => setImmediate(() => child.emit("close", 2)));
    const failing = createOmpUsageSource({ spawn, resolveBinary: () => "/bin/omp", platform: "linux", env: {} });
    const result = await failing.run({});
    assert.strictEqual(result.state, "error");
    assert.match(result.detail, /code 2/);
  });
});

describe("codex app-server source", () => {
  const NOW = 1_800_000_000_000;
  const response = {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1_800_003_600 },
      secondary: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_003_600 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null },
      },
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1_800_100_000 },
        secondary: null,
      },
    },
  };

  it("prefers rateLimitsByLimitId and routes generic vs Spark through the rollout router", () => {
    const mapped = mapCodexRateLimitsResponse(response, NOW);
    assert.deepStrictEqual(mapped.providers, ["Codex", "Codex Spark"]);
    assert.deepStrictEqual(mapped.quotas.codexQuota, {
      codexFiveHour: { usedPercent: 12, windowMinutes: 300, resetAt: 1_800_003_600_000, capturedAt: NOW },
      codexWeekly: { usedPercent: 40, windowMinutes: 10080, capturedAt: NOW },
    }, "a null resetsAt is omitted, never read as an already-reset 0");
    assert.deepStrictEqual(mapped.quotas.codexSparkQuota, {
      codexWeekly: { usedPercent: 7, windowMinutes: 10080, resetAt: 1_800_100_000_000, capturedAt: NOW },
    });
  });

  it("falls back to the single rateLimits view", () => {
    const mapped = mapCodexRateLimitsResponse({ ...response, rateLimitsByLimitId: null }, NOW);
    assert.deepStrictEqual(Object.keys(mapped.quotas), ["codexQuota"]);
    assert.strictEqual(mapped.quotas.codexQuota.codexFiveHour.usedPercent, 99);
  });

  function appServerSpawn(reply) {
    return fakeSpawn((child) => {
      child.stdin.write = (data) => {
        child.written.push(data);
        const message = JSON.parse(data);
        setImmediate(() => {
          if (message.id === 1) {
            child.stdout.emit("data", '{"method":"configWarning","params":{}}\n{"id":1,"result":{}}\n');
          } else if (message.id === 2) {
            child.stdout.emit("data", `${JSON.stringify({ id: 2, ...reply })}\n`);
          }
        });
      };
    });
  }

  it("runs initialize → initialized → account/rateLimits/read and closes stdin", async () => {
    const { spawn, calls } = appServerSpawn({ result: response });
    const source = createCodexAppServerSource({
      spawn,
      resolveBinary: () => "/Users/me/.local/bin/codex",
      now: () => NOW,
      appVersion: "1.2.3",
      platform: "darwin",
      env: {},
      homeDir: "/Users/me",
    });
    const result = await source.run({});
    assert.strictEqual(result.state, "ok");
    assert.deepStrictEqual(result.providers, ["Codex", "Codex Spark"]);
    assert.deepStrictEqual(calls[0].args, ["app-server"]);
    const sent = calls[0].child.written.map((line) => JSON.parse(line));
    assert.deepStrictEqual(sent.map((message) => [message.id, message.method]), [
      [1, "initialize"],
      [undefined, "initialized"],
      [2, "account/rateLimits/read"],
    ]);
    assert.deepStrictEqual(sent[0].params.clientInfo, { name: "clawd-on-desk", version: "1.2.3" });
    assert.strictEqual(calls[0].child.stdinEnded, true);
  });

  it("maps the API-key account error to needs-login", async () => {
    const { spawn } = appServerSpawn({
      error: { code: -32600, message: "chatgpt authentication required to read rate limits" },
    });
    const source = createCodexAppServerSource({ spawn, resolveBinary: () => "/bin/codex", platform: "linux", env: {} });
    assert.deepStrictEqual(await source.run({}), { state: "needs-login", detail: "ChatGPT login required" });
  });

  it("times out and kills a silent server", async () => {
    const { spawn, calls } = fakeSpawn(() => {});
    const source = createCodexAppServerSource({
      spawn, resolveBinary: () => "/bin/codex", timeoutMs: 10, platform: "linux", env: {},
    });
    const result = await source.run({});
    assert.deepStrictEqual(result, { state: "error", detail: "Codex app-server timed out" });
    assert.strictEqual(calls[0].child.killed, true);
  });

  it("reports unavailable when codex is not installed", async () => {
    const source = createCodexAppServerSource({ resolveBinary: () => null, spawn: () => assert.fail("must not spawn") });
    assert.deepStrictEqual(await source.run({}), { state: "unavailable", detail: "codex CLI not found" });
  });
});

describe("claude oauth source", () => {
  const NOW = 1_800_000_000_000;
  const credentialJson = (expiresAt) => JSON.stringify({
    claudeAiOauth: { accessToken: "tok-abc", refreshToken: "refresh-xyz", expiresAt, scopes: ["user:inference"] },
  });
  const usageBody = {
    five_hour: { utilization: 35, resets_at: "2027-01-15T10:00:00.000Z" },
    seven_day: { utilization: 33.4, resets_at: "2027-01-20T00:00:00+00:00" },
    seven_day_opus: null,
  };

  function fakeRequest(statusCode, body, headers = {}) {
    const calls = [];
    const request = (url, options, onResponse) => {
      calls.push({ url, options });
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = statusCode;
          res.headers = headers;
          onResponse(res);
          res.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
          res.emit("end");
        });
      };
      return req;
    };
    return { request, calls };
  }

  function fakeFs(files) {
    const reads = [];
    return {
      reads,
      readFileSync: (filePath) => {
        reads.push(filePath);
        if (Object.prototype.hasOwnProperty.call(files, filePath)) return files[filePath];
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      },
    };
  }

  function fakeExecFile(stdout, error = null) {
    const calls = [];
    const execFile = (file, args, options, callback) => {
      calls.push({ file, args });
      setImmediate(() => callback(error, stdout));
    };
    return { execFile, calls };
  }

  it("parses only the access token and expiry", () => {
    assert.deepStrictEqual(parseClaudeCredentials(credentialJson(NOW + 1000)), { accessToken: "tok-abc", expiresAt: NOW + 1000 });
    assert.strictEqual(parseClaudeCredentials("{}"), null);
    assert.strictEqual(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "a b" } })), null);
  });

  it("maps five_hour/seven_day utilization to Claude buckets", () => {
    assert.deepStrictEqual(mapClaudeUsageResponse(usageBody, NOW), { claudeQuota: {
      claudeFiveHour: { usedPercent: 35, windowMinutes: 300, capturedAt: NOW, resetAt: Date.parse("2027-01-15T10:00:00.000Z") },
      claudeWeekly: { usedPercent: 33.4, windowMinutes: 10080, capturedAt: NOW, resetAt: Date.parse("2027-01-20T00:00:00Z") },
    } });
    assert.deepStrictEqual(
      Object.keys(mapClaudeUsageResponse({ five_hour: null, seven_day: { utilization: 1 } }, NOW).claudeQuota),
      ["claudeWeekly"]
    );
    assert.strictEqual(mapClaudeUsageResponse({ five_hour: null }, NOW), null);
  });

  it("maps HTTP statuses to source states", () => {
    const empty = Buffer.from("");
    assert.strictEqual(classifyClaudeUsageResponse(401, {}, empty, NOW).state, "needs-login");
    assert.strictEqual(classifyClaudeUsageResponse(403, {}, empty, NOW).state, "needs-login");
    assert.deepStrictEqual(
      classifyClaudeUsageResponse(429, { "retry-after": "120" }, empty, NOW),
      { state: "rate-limited", detail: "Usage endpoint rate limited", retryAt: NOW + 120000 }
    );
    assert.strictEqual(classifyClaudeUsageResponse(429, {}, empty, NOW).retryAt, NOW + RATE_LIMIT_BACKOFF_MS);
    assert.deepStrictEqual(classifyClaudeUsageResponse(500, {}, empty, NOW), { state: "error", detail: "Usage endpoint returned HTTP 500" });
    assert.strictEqual(classifyClaudeUsageResponse(200, {}, Buffer.from("nope"), NOW).state, "error");
  });

  it("never sends an expired token", async () => {
    const credPath = path.join("/home/me", ".claude", ".credentials.json");
    const { request, calls } = fakeRequest(200, usageBody);
    const source = createClaudeOAuthSource({
      platform: "linux",
      fs: fakeFs({ [credPath]: credentialJson(NOW - 1) }),
      env: {},
      homeDir: "/home/me",
      request,
      now: () => NOW,
    });
    const result = await source.run({ interactive: true });
    assert.strictEqual(result.state, "needs-login");
    assert.strictEqual(calls.length, 0);
  });

  it("never invokes `security` on a non-interactive refresh", async () => {
    const { execFile, calls } = fakeExecFile(credentialJson(NOW + 3600000));
    const { request, calls: requests } = fakeRequest(200, usageBody);
    const source = createClaudeOAuthSource({
      platform: "darwin", fs: fakeFs({}), env: {}, homeDir: "/Users/me", execFile, request, now: () => NOW,
    });
    const result = await source.run({ interactive: false });
    assert.strictEqual(result.state, "waiting-interaction");
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(requests.length, 0);
  });

  it("reads the Keychain on an interactive refresh and sends the documented request", async () => {
    const { execFile, calls } = fakeExecFile(`${credentialJson(NOW + 3600000)}\n`);
    const { request, calls: requests } = fakeRequest(200, usageBody);
    const source = createClaudeOAuthSource({
      platform: "darwin", fs: fakeFs({}), env: {}, homeDir: "/Users/me",
      execFile, request, now: () => NOW, appVersion: "9.9.9",
    });
    const result = await source.run({ interactive: true });
    assert.strictEqual(result.state, "ok");
    assert.deepStrictEqual(result.providers, ["Claude"]);
    assert.strictEqual(result.quotas.claudeQuota.claudeFiveHour.usedPercent, 35);
    assert.deepStrictEqual(calls[0], {
      file: SECURITY_BIN,
      args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    });
    assert.strictEqual(requests[0].url, CLAUDE_USAGE_ENDPOINT);
    assert.strictEqual(requests[0].options.method, "GET");
    assert.deepStrictEqual(requests[0].options.headers, {
      Accept: "application/json",
      Authorization: "Bearer tok-abc",
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "User-Agent": "clawd-on-desk/9.9.9",
    });

    // The Keychain credential stays in memory: a later background refresh
    // needs no second Keychain read.
    const background = await source.run({ interactive: false });
    assert.strictEqual(background.state, "ok");
    assert.strictEqual(calls.length, 1);
  });

  it("honors CLAUDE_CONFIG_DIR and reports needs-login on 401", async () => {
    const credPath = path.join("/custom/claude", ".credentials.json");
    const files = fakeFs({ [credPath]: credentialJson(NOW + 3600000) });
    const { request } = fakeRequest(401, { error: "nope" });
    const source = createClaudeOAuthSource({
      platform: "linux", fs: files, env: { CLAUDE_CONFIG_DIR: "/custom/claude" }, homeDir: "/home/me", request, now: () => NOW,
    });
    const result = await source.run({ interactive: false });
    assert.strictEqual(result.state, "needs-login");
    assert.deepStrictEqual(files.reads, [credPath]);
  });

  it("reports unavailable without any login off macOS", async () => {
    const source = createClaudeOAuthSource({ platform: "linux", fs: fakeFs({}), env: {}, homeDir: "/home/me" });
    assert.deepStrictEqual(await source.run({ interactive: true }), { state: "unavailable", detail: "No Claude Code login found" });
  });
});

describe("cli binary resolver", () => {
  function statFs(executables, plainFiles = []) {
    return {
      statSync: (filePath) => {
        if (executables.includes(filePath)) return { isFile: () => true, mode: 0o755 };
        if (plainFiles.includes(filePath)) return { isFile: () => true, mode: 0o644 };
        throw new Error("ENOENT");
      },
    };
  }

  it("finds Homebrew/user installs that a Dock-launched PATH lacks", () => {
    const options = {
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin" },
      homeDir: "/Users/me",
      fs: statFs(["/opt/homebrew/bin/omp", "/Users/me/.local/bin/codex"]),
    };
    assert.strictEqual(resolveCliBinary("omp", options), "/opt/homebrew/bin/omp");
    assert.strictEqual(resolveCliBinary("codex", options), "/Users/me/.local/bin/codex");
    assert.strictEqual(resolveCliBinary("missing", options), null);
    assert.strictEqual(resolveCliBinary("../omp", options), null);
  });

  it("prefers PATH and skips non-executable files", () => {
    const options = {
      platform: "linux",
      env: { PATH: "/first:/second" },
      homeDir: "/home/me",
      fs: statFs(["/second/omp", "/usr/local/bin/omp"], ["/first/omp"]),
    };
    assert.strictEqual(resolveCliBinary("omp", options), "/second/omp");
  });

  it("uses PATHEXT and %APPDATA%\\npm on Windows", () => {
    const options = {
      platform: "win32",
      env: { Path: "C:\\Windows", PATHEXT: ".EXE;.CMD", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      homeDir: "C:\\Users\\me",
      fs: statFs(["C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"]),
    };
    assert.strictEqual(resolveCliBinary("codex", options), "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("puts the binary directory and search dirs on the child PATH", () => {
    const env = buildCliEnv("/opt/homebrew/bin/omp", { platform: "darwin", env: { PATH: "/usr/bin", HOME: "/Users/me" }, homeDir: "/Users/me" });
    const dirs = env.PATH.split(":");
    assert.strictEqual(dirs[0], "/opt/homebrew/bin");
    assert.ok(dirs.includes("/usr/bin"));
    assert.ok(dirs.includes("/Users/me/.bun/bin"));
    assert.strictEqual(env.HOME, "/Users/me");
  });
});
