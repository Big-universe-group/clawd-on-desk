"use strict";

// Resolve an agent CLI to an absolute executable path.
//
// A packaged app launched from the Dock/Finder inherits launchd's minimal
// PATH (/usr/bin:/bin:/usr/sbin:/sbin) — no Homebrew, no ~/.local/bin — so
// PATH alone misses most real installs. The well-known per-user and package
// manager directories are searched after PATH. Everything is injectable so
// tests never touch the real filesystem or environment.

const fs = require("fs");
const os = require("os");
const path = require("path");

const BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function readEnvKey(env, key, platform) {
  if (!env) return "";
  if (platform !== "win32") return typeof env[key] === "string" ? env[key] : "";
  // Windows env keys are case-insensitive ("Path" is common).
  const match = Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase());
  return match && typeof env[match] === "string" ? env[match] : "";
}

function extraSearchDirs(options) {
  const { platform, env, homeDir } = options;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const appData = readEnvKey(env, "APPDATA", platform);
    return appData ? [pathApi.join(appData, "npm")] : [];
  }
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin"];
  if (homeDir) {
    dirs.push(
      pathApi.join(homeDir, ".local", "bin"),
      pathApi.join(homeDir, ".bun", "bin"),
      pathApi.join(homeDir, ".npm-global", "bin"),
    );
  }
  return dirs;
}

function normalizeOptions(options = {}) {
  return {
    fs: options.fs || fs,
    env: options.env || process.env,
    platform: options.platform || process.platform,
    homeDir: options.homeDir === undefined ? os.homedir() : options.homeDir,
  };
}

// Ordered, de-duplicated directory list: PATH first (the user's own choice
// wins), then the well-known install locations.
function searchDirs(options = {}) {
  const opts = normalizeOptions(options);
  const delimiter = opts.platform === "win32" ? ";" : ":";
  const fromPath = readEnvKey(opts.env, "PATH", opts.platform).split(delimiter);
  const seen = new Set();
  const out = [];
  for (const dir of fromPath.concat(extraSearchDirs(opts))) {
    const trimmed = typeof dir === "string" ? dir.trim().replace(/^"(.*)"$/, "$1") : "";
    if (!trimmed) continue;
    const key = opts.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function candidateNames(name, opts) {
  if (opts.platform !== "win32") return [name];
  const exts = (readEnvKey(opts.env, "PATHEXT", opts.platform) || DEFAULT_WIN_PATHEXT)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => /^\.[a-z0-9]+$/.test(ext));
  return exts.map((ext) => `${name}${ext}`);
}

function isExecutableFile(fsImpl, fullPath, platform) {
  try {
    const stat = fsImpl.statSync(fullPath);
    if (!stat || !stat.isFile()) return false;
    return platform === "win32" || (Number(stat.mode) & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolveCliBinary(name, options = {}) {
  if (typeof name !== "string" || !BINARY_NAME_RE.test(name)) return null;
  const opts = normalizeOptions(options);
  const pathApi = opts.platform === "win32" ? path.win32 : path.posix;
  const names = candidateNames(name, opts);
  for (const dir of searchDirs(opts)) {
    if (!pathApi.isAbsolute(dir)) continue;
    for (const candidate of names) {
      const fullPath = pathApi.join(dir, candidate);
      if (isExecutableFile(opts.fs, fullPath, opts.platform)) return fullPath;
    }
  }
  return null;
}

// Child environment: the resolved binary's own directory plus the search
// dirs are prepended/appended to PATH so script shims (`#!/usr/bin/env node`,
// bun) resolve their interpreter even under launchd's minimal PATH.
function buildCliEnv(binaryPath, options = {}) {
  const opts = normalizeOptions(options);
  const pathApi = opts.platform === "win32" ? path.win32 : path.posix;
  const delimiter = opts.platform === "win32" ? ";" : ":";
  const dirs = [pathApi.dirname(binaryPath), ...searchDirs(opts)];
  const env = { ...opts.env };
  const pathKey = opts.platform === "win32"
    ? (Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "Path")
    : "PATH";
  env[pathKey] = Array.from(new Set(dirs)).join(delimiter);
  return env;
}

// Spawn options for a resolved CLI. Node refuses to spawn .cmd/.bat shims
// without a shell on Windows; the command is quoted and every argument is a
// fixed constant from this codebase (never user input).
function spawnCli(spawn, binaryPath, args, options = {}) {
  const platform = options.platform || process.platform;
  const env = buildCliEnv(binaryPath, options);
  const needsShell = platform === "win32" && /\.(cmd|bat)$/i.test(binaryPath);
  return spawn(needsShell ? `"${binaryPath}"` : binaryPath, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: needsShell,
  });
}

module.exports = {
  resolveCliBinary,
  searchDirs,
  buildCliEnv,
  spawnCli,
};
