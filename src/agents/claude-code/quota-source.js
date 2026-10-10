"use strict";

// Active Claude Code subscription usage via the CLI's own OAuth login.
//
// Read-only by design (same stance as claude-usage-bar / CodexBar): Clawd
// reads Claude Code's stored OAuth access token, never refreshes, rotates or
// writes it back, and keeps it only in memory. The token and the response
// body are never logged or persisted; only the mapped percentages reach the
// account-quota store.
//
// Credential order:
//   1. macOS Keychain via Apple's /usr/bin/security (so any prompt is
//      attributed to Apple's tool) — ONLY on an interactive refresh, because
//      it can pop a Keychain dialog.
//   2. <CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json — any trigger.

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("node:https");
const { execFile } = require("child_process");

const { parseRetryAfter } = require("../kimi-cli/quota/client");

const SOURCE_ID = "claude-oauth";
const AGENT_ID = "claude-code";
const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY_BIN = "/usr/bin/security";
// The Keychain dialog waits for the user; give them time to answer.
const KEYCHAIN_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 7 * 24 * 60;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Claude Code's credential JSON: { claudeAiOauth: { accessToken,
// refreshToken, expiresAt (ms), subscriptionType, scopes } }. Only the access
// token and its expiry are used; refreshToken is never read into a variable.
function parseClaudeCredentials(text) {
  if (typeof text !== "string" || !text || text.length > MAX_CREDENTIAL_BYTES) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const oauth = isPlainObject(value) && isPlainObject(value.claudeAiOauth) ? value.claudeAiOauth : null;
  if (!oauth) return null;
  const token = oauth.accessToken;
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH
    || /[\s\0]/.test(token)) return null;
  const expiresAt = typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
    ? oauth.expiresAt
    : null;
  return { accessToken: token, expiresAt };
}

function credentialsFilePath({ env = process.env, homeDir = os.homedir() } = {}) {
  const configDir = env && typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim()
    ? env.CLAUDE_CONFIG_DIR.trim()
    : path.join(homeDir, ".claude");
  return path.join(configDir, ".credentials.json");
}

function readKeychainCredential(execFileImpl) {
  return new Promise((resolve) => {
    try {
      execFileImpl(
        SECURITY_BIN,
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: MAX_CREDENTIAL_BYTES, encoding: "utf8" },
        (error, stdout) => {
          if (error) return resolve(null);
          resolve(parseClaudeCredentials(String(stdout || "").trim()));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function readFileCredential(fsImpl, filePath) {
  try {
    return parseClaudeCredentials(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Returns { kind: "found", credential, origin } | { kind: "waiting-interaction" }
// | { kind: "none" }. Never invokes `security` unless interactive.
async function discoverClaudeCredential(options = {}) {
  const platform = options.platform || process.platform;
  const fsImpl = options.fs || fs;
  const execFileImpl = options.execFile || execFile;
  if (platform === "darwin" && options.interactive === true) {
    const credential = await readKeychainCredential(execFileImpl);
    if (credential) return { kind: "found", credential, origin: "keychain" };
  }
  const credential = readFileCredential(fsImpl, credentialsFilePath(options));
  if (credential) return { kind: "found", credential, origin: "file" };
  // On macOS Claude Code keeps its login in the Keychain; without an
  // interactive trigger we may not look there.
  if (platform === "darwin" && options.interactive !== true) return { kind: "waiting-interaction" };
  return { kind: "none" };
}

function parseIsoMs(value) {
  if (typeof value !== "string" || !value || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function mapWindow(window, windowMinutes, nowMs) {
  if (!isPlainObject(window)) return null;
  const utilization = window.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const bucket = { usedPercent: utilization, windowMinutes, capturedAt: nowMs };
  const resetAt = parseIsoMs(window.resets_at);
  if (resetAt !== null) bucket.resetAt = resetAt;
  return bucket;
}

// `utilization` is already a 0-100 percentage. A window that has not started
// (null) is simply absent.
function mapClaudeUsageResponse(value, nowMs) {
  if (!isPlainObject(value)) return null;
  const claudeQuota = {};
  const fiveHour = mapWindow(value.five_hour, FIVE_HOUR_MINUTES, nowMs);
  const weekly = mapWindow(value.seven_day, WEEKLY_MINUTES, nowMs);
  if (fiveHour) claudeQuota.claudeFiveHour = fiveHour;
  if (weekly) claudeQuota.claudeWeekly = weekly;
  return Object.keys(claudeQuota).length ? { claudeQuota } : null;
}

// Maps an HTTP outcome to a source result (state names: UsageSourceStatus).
function classifyClaudeUsageResponse(statusCode, headers, body, nowMs) {
  if (statusCode >= 200 && statusCode < 300) {
    let value = null;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {}
    const quotas = mapClaudeUsageResponse(value, nowMs);
    if (!quotas) return { state: "error", detail: "Unrecognized usage response" };
    return { state: "ok", quotas, providers: ["Claude"] };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { state: "needs-login", detail: "Claude login rejected; run Claude Code to sign in again" };
  }
  if (statusCode === 429) {
    const retry = parseRetryAfter(headers && headers["retry-after"], nowMs);
    const retryAt = retry && retry.retryAt > nowMs ? retry.retryAt : nowMs + RATE_LIMIT_BACKOFF_MS;
    return { state: "rate-limited", detail: "Usage endpoint rate limited", retryAt };
  }
  return { state: "error", detail: `Usage endpoint returned HTTP ${statusCode || 0}` };
}

function fetchClaudeUsage(token, options = {}) {
  const request = options.request || https.request;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const appVersion = typeof options.appVersion === "string" && /^[0-9A-Za-z._+-]{1,64}$/.test(options.appVersion)
    ? options.appVersion
    : "unknown";
  const signal = options.signal;
  if (signal && signal.aborted) return Promise.resolve({ state: "error", detail: "Refresh cancelled" });
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(result);
    };
    const onAbort = () => {
      if (req) req.destroy();
      settle({ state: "error", detail: "Refresh cancelled" });
    };
    try {
      req = request(CLAUDE_USAGE_ENDPOINT, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "User-Agent": `clawd-on-desk/${appVersion}`,
        },
        agent: false,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_BODY_BYTES) {
            settle({ state: "error", detail: "Usage response too large" });
            req.destroy();
            return;
          }
          chunks.push(buffer);
        });
        res.on("end", () => {
          settle(classifyClaudeUsageResponse(
            Number(res.statusCode) || 0,
            res.headers || {},
            Buffer.concat(chunks),
            now(),
          ));
        });
        res.on("error", () => settle({ state: "error", detail: "Usage request failed" }));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        settle({ state: "error", detail: "Usage request timed out" });
      });
      req.on("error", () => settle({ state: "error", detail: "Usage request failed (network)" }));
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      req.end();
    } catch {
      settle({ state: "error", detail: "Usage request failed" });
    }
  });
}

function createClaudeOAuthSource(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  // A Keychain-derived credential is kept in memory only (never persisted)
  // until it expires or is rejected, so a background refresh after one
  // interactive read does not need another Keychain prompt.
  let cachedKeychainCredential = null;

  async function run({ interactive = false, signal } = {}) {
    const nowMs = now();
    let credential = null;
    let origin = null;
    if (cachedKeychainCredential
      && (cachedKeychainCredential.expiresAt === null || cachedKeychainCredential.expiresAt > nowMs)) {
      credential = cachedKeychainCredential;
      origin = "keychain";
    } else {
      cachedKeychainCredential = null;
      const found = await discoverClaudeCredential({
        interactive,
        platform: deps.platform,
        fs: deps.fs,
        env: deps.env,
        homeDir: deps.homeDir,
        execFile: deps.execFile,
      });
      if (found.kind === "waiting-interaction") {
        return { state: "waiting-interaction", detail: "Click the pet to read the Claude login from Keychain" };
      }
      if (found.kind === "none") {
        return { state: "unavailable", detail: "No Claude Code login found" };
      }
      credential = found.credential;
      origin = found.origin;
    }
    // Expired access token: Claude Code refreshes it on its next run. Clawd
    // must never refresh it itself, and must not send a known-dead token.
    if (credential.expiresAt !== null && credential.expiresAt <= now()) {
      return { state: "needs-login", detail: "Claude login expired; run Claude Code once to refresh it" };
    }
    if (origin === "keychain") cachedKeychainCredential = credential;
    const result = await fetchClaudeUsage(credential.accessToken, {
      request: deps.request,
      now,
      appVersion: deps.appVersion,
      timeoutMs: deps.timeoutMs,
      signal,
    });
    if (result.state === "needs-login") cachedKeychainCredential = null;
    return result;
  }

  return { id: SOURCE_ID, agentId: AGENT_ID, run };
}

module.exports = {
  CLAUDE_USAGE_ENDPOINT,
  KEYCHAIN_SERVICE,
  SECURITY_BIN,
  RATE_LIMIT_BACKOFF_MS,
  parseClaudeCredentials,
  credentialsFilePath,
  discoverClaudeCredential,
  mapClaudeUsageResponse,
  classifyClaudeUsageResponse,
  fetchClaudeUsage,
  createClaudeOAuthSource,
};
