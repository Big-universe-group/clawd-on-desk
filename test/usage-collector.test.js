"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createUsageCollector,
  SOURCE_MIN_INTERVAL_MS,
  FORCE_MIN_INTERVAL_MS,
} = require("../src/usage-collector");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fakeSource(id, agentId, results) {
  const source = {
    id,
    agentId,
    calls: [],
    run: async (options) => {
      source.calls.push(options);
      const next = typeof results === "function" ? results(source.calls.length, options) : results;
      return next;
    },
  };
  return source;
}

const OK_CLAUDE = {
  state: "ok",
  quotas: { claudeQuota: { claudeWeekly: { usedPercent: 10 } } },
  providers: ["Claude"],
};

function harness(overrides = {}) {
  const state = {
    nowMs: 1_000_000,
    master: true,
    agents: { "claude-code": true, codex: true, omp: true },
    commits: [],
  };
  const sources = overrides.sources || [
    fakeSource("claude-oauth", "claude-code", OK_CLAUDE),
    fakeSource("codex-app-server", "codex", { state: "needs-login", detail: "ChatGPT login required" }),
  ];
  const collector = createUsageCollector({
    sources,
    now: () => state.nowMs,
    isMasterEnabled: () => state.master,
    isAgentEnabled: (agentId) => state.agents[agentId] === true,
    updateAccountQuota: (host, quotas) => {
      state.commits.push({ host, quotas });
      return true;
    },
  });
  return { state, sources, collector };
}

describe("usage collector", () => {
  it("does nothing while the quota ring master switch is off", async () => {
    const { state, sources, collector } = harness();
    state.master = false;
    const statuses = await collector.requestRefresh({ trigger: "startup" });
    assert.strictEqual(sources[0].calls.length, 0);
    assert.strictEqual(sources[1].calls.length, 0);
    assert.deepStrictEqual(statuses.map((status) => status.state), ["off", "off"]);
  });

  it("skips sources whose agent is disabled and commits ok results to the local source", async () => {
    const { state, sources, collector } = harness();
    state.agents.codex = false;
    assert.deepStrictEqual(collector.getStatus().map((status) => status.state), ["idle", "agent-disabled"]);
    const statuses = await collector.requestRefresh({ trigger: "pet-click", interactive: true });
    assert.strictEqual(sources[1].calls.length, 0);
    assert.strictEqual(sources[0].calls[0].interactive, true);
    assert.deepStrictEqual(state.commits, [{ host: null, quotas: OK_CLAUDE.quotas }]);
    assert.deepStrictEqual(statuses[0], {
      id: "claude-oauth",
      agentId: "claude-code",
      state: "ok",
      lastSuccessAt: 1_000_000,
      lastAttemptAt: 1_000_000,
      detail: null,
      providers: ["Claude"],
    });
    assert.strictEqual(statuses[1].state, "agent-disabled");
  });

  it("records failures with their diagnostic and keeps them out of the store", async () => {
    const { state, collector } = harness();
    const statuses = await collector.requestRefresh({ trigger: "startup" });
    assert.strictEqual(state.commits.length, 1, "only the ok source commits");
    assert.strictEqual(statuses[1].state, "needs-login");
    assert.strictEqual(statuses[1].detail, "ChatGPT login required");
    assert.strictEqual(statuses[1].lastSuccessAt, null);
  });

  it("throttles each source to the minimum interval, forced refreshes to 60s", async () => {
    const { state, sources, collector } = harness();
    await collector.requestRefresh({ trigger: "startup" });
    state.nowMs += FORCE_MIN_INTERVAL_MS - 1;
    await collector.requestRefresh({ trigger: "pet-click", interactive: true });
    await collector.requestRefresh({ trigger: "settings-refresh", interactive: true, force: true });
    assert.strictEqual(sources[0].calls.length, 1);

    state.nowMs += 1;
    await collector.requestRefresh({ trigger: "settings-refresh", interactive: true, force: true });
    assert.strictEqual(sources[0].calls.length, 2, "forced refresh admitted after 60s");

    state.nowMs += SOURCE_MIN_INTERVAL_MS - 1;
    await collector.requestRefresh({ trigger: "dashboard-open", interactive: true });
    assert.strictEqual(sources[0].calls.length, 2);
    state.nowMs += 1;
    await collector.requestRefresh({ trigger: "dashboard-open", interactive: true });
    assert.strictEqual(sources[0].calls.length, 3);
  });

  it("keeps a single request in flight per source and settles every caller", async () => {
    const gate = deferred();
    const source = fakeSource("omp-usage", "omp", () => gate.promise);
    const { sources, collector } = harness({ sources: [source] });
    const first = collector.requestRefresh({ trigger: "pet-click", interactive: true });
    const second = collector.requestRefresh({ trigger: "settings-refresh", interactive: true, force: true });
    assert.strictEqual(sources[0].calls.length, 1);
    gate.resolve({ state: "ok", quotas: {}, providers: ["DeepSeek"] });
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a[0].state, "ok");
    assert.deepStrictEqual(b[0].providers, ["DeepSeek"]);
  });

  it("re-checks the master switch and agent gate before committing", async () => {
    const masterGate = deferred();
    const agentGate = deferred();
    const claude = fakeSource("claude-oauth", "claude-code", () => masterGate.promise);
    const omp = fakeSource("omp-usage", "omp", () => agentGate.promise);
    const { state, collector } = harness({ sources: [claude, omp] });

    const masterRun = collector.requestRefresh({ trigger: "pet-click", interactive: true });
    state.master = false;
    masterGate.resolve(OK_CLAUDE);
    agentGate.resolve({ state: "ok", quotas: { extraQuota: {} }, providers: [] });
    await masterRun;
    assert.deepStrictEqual(state.commits, [], "ring turned off mid-flight: nothing written");

    state.master = true;
    state.nowMs += SOURCE_MIN_INTERVAL_MS;
    const agentGate2 = deferred();
    omp.run = async () => agentGate2.promise;
    claude.run = async () => OK_CLAUDE;
    const agentRun = collector.requestRefresh({ trigger: "dashboard-open", interactive: true });
    state.agents.omp = false;
    agentGate2.resolve({ state: "ok", quotas: { extraQuota: { deepseek: {} } }, providers: ["DeepSeek"] });
    await agentRun;
    assert.deepStrictEqual(state.commits.map((commit) => Object.keys(commit.quotas)), [["claudeQuota"]]);
  });

  it("honors a rate-limit backoff even for forced refreshes", async () => {
    const source = fakeSource("claude-oauth", "claude-code", {
      state: "rate-limited", detail: "Usage endpoint rate limited", retryAt: 1_000_000 + 10 * 60 * 1000,
    });
    const { state, collector } = harness({ sources: [source] });
    await collector.requestRefresh({ trigger: "startup" });
    state.nowMs += 5 * 60 * 1000;
    await collector.requestRefresh({ trigger: "settings-refresh", interactive: true, force: true });
    assert.strictEqual(source.calls.length, 1);
    assert.strictEqual(collector.getStatus()[0].state, "rate-limited");
    state.nowMs += 5 * 60 * 1000;
    await collector.requestRefresh({ trigger: "settings-refresh", interactive: true, force: true });
    assert.strictEqual(source.calls.length, 2);
  });

  it("lets an interactive request through right after a waiting-interaction attempt", async () => {
    const source = fakeSource("claude-oauth", "claude-code", (_n, options) => (options.interactive
      ? OK_CLAUDE
      : { state: "waiting-interaction", detail: "Click the pet" }));
    const { state, collector } = harness({ sources: [source] });
    await collector.requestRefresh({ trigger: "startup", interactive: false });
    assert.strictEqual(collector.getStatus()[0].state, "waiting-interaction");
    state.nowMs += 1000;
    await collector.requestRefresh({ trigger: "startup", interactive: false });
    assert.strictEqual(source.calls.length, 1, "background retries stay throttled");
    await collector.requestRefresh({ trigger: "pet-click", interactive: true });
    assert.strictEqual(source.calls.length, 2);
    assert.strictEqual(collector.getStatus()[0].state, "ok");
  });

  it("turns a throwing source into an error status", async () => {
    const source = fakeSource("omp-usage", "omp", () => { throw new Error("boom"); });
    const { collector } = harness({ sources: [source] });
    const [status] = await collector.requestRefresh({ trigger: "startup" });
    assert.strictEqual(status.state, "error");
    assert.strictEqual(status.detail, "Unexpected source failure");
  });

  it("aborts in-flight sources and ignores refreshes after dispose", async () => {
    let seenSignal = null;
    const gate = deferred();
    const source = fakeSource("omp-usage", "omp", (_n, options) => {
      seenSignal = options.signal;
      return gate.promise;
    });
    const { state, collector } = harness({ sources: [source] });
    const pending = collector.requestRefresh({ trigger: "startup" });
    collector.dispose();
    assert.strictEqual(seenSignal.aborted, true);
    gate.resolve({ state: "ok", quotas: { extraQuota: {} }, providers: [] });
    await pending;
    assert.deepStrictEqual(state.commits, []);
    state.nowMs += SOURCE_MIN_INTERVAL_MS;
    await collector.requestRefresh({ trigger: "pet-click", interactive: true });
    assert.strictEqual(source.calls.length, 1);
  });

  it("restores its own provider data after a provider-wide clear, only while gated in", async () => {
    const { state, collector } = harness();
    await collector.requestRefresh({ trigger: "startup" });
    state.commits.length = 0;
    assert.strictEqual(collector.recommitProvider("claudeQuota"), true);
    assert.deepStrictEqual(state.commits, [
      { host: null, quotas: { claudeQuota: OK_CLAUDE.quotas.claudeQuota } },
    ]);
    // Nothing cached for a provider no source delivered.
    assert.strictEqual(collector.recommitProvider("codexQuota"), false);
    state.agents["claude-code"] = false;
    assert.strictEqual(collector.recommitProvider("claudeQuota"), false);
    state.agents["claude-code"] = true;
    state.master = false;
    assert.strictEqual(collector.recommitProvider("claudeQuota"), false);
    assert.strictEqual(state.commits.length, 1);
  });
});
