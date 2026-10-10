"use strict";

// Agent port registry: the kernel side of the ports-and-adapters split.
//
// Kernel code (src/core, src/runtime, shared main-process owners) must not
// branch on a literal agent id. Where behavior genuinely differs per agent it
// asks this registry for that agent's adapter on a named port and calls it; an
// agent without an adapter on that port gets the kernel default behavior.
//
// Adapters are discovered by directory convention, never imported by name:
// an agent plugin provides `<pluginRoot>/<agent-id>/ports/<port-file>.js`.
// The kernel knows the convention and the port names only, so adding,
// replacing or removing an agent never edits kernel files.
//
// Each adapter module is the agent's anti-corruption layer for that port: the
// agent's own vocabulary (event names, payload shapes, fallbacks) stays inside
// the adapter, and the kernel only sees the port's normalized contract.

const fs = require("fs");
const path = require("path");

const PORT_FILES = Object.freeze({
  integration: "integration.js",
  ingest: "ingest.js",
  permission: "permission.js",
  sessionMeta: "session-meta.js",
  usage: "usage.js",
  process: "process.js",
  presentation: "presentation.js",
});

const PORT_NAMES = Object.freeze(Object.keys(PORT_FILES));
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_PLUGIN_ROOT = path.join(__dirname, "..", "..", "agents");

let pluginRoot = DEFAULT_PLUGIN_ROOT;
const portCache = new Map();
let agentIdCache = null;

function isValidAgentId(agentId) {
  return typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId);
}

function assertPortName(portName) {
  if (!Object.prototype.hasOwnProperty.call(PORT_FILES, portName)) {
    throw new Error(`unknown agent port: ${portName}`);
  }
}

function portFilePath(agentId, portName) {
  return path.join(pluginRoot, agentId, "ports", PORT_FILES[portName]);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// Returns the adapter object an agent plugin exports for `portName`, or null
// when the agent has none (unknown id, custom HTTP agent, or no port file).
// A port file that exists but throws while loading is a plugin bug and is
// rethrown rather than silently treated as "no adapter".
function getAgentPort(agentId, portName) {
  assertPortName(portName);
  if (!isValidAgentId(agentId)) return null;
  const cacheKey = `${agentId}\u0000${portName}`;
  if (portCache.has(cacheKey)) return portCache.get(cacheKey);
  const filePath = portFilePath(agentId, portName);
  const adapter = fileExists(filePath) ? require(filePath) : null;
  portCache.set(cacheKey, adapter);
  return adapter;
}

// Agent plugin ids present under the plugin root, sorted for deterministic
// iteration. A directory counts as an agent plugin when it has a descriptor.
function listAgentIds() {
  if (agentIdCache) return agentIdCache;
  let entries = [];
  try {
    entries = fs.readdirSync(pluginRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  agentIdCache = Object.freeze(entries
    .filter((entry) => entry.isDirectory() && isValidAgentId(entry.name))
    .map((entry) => entry.name)
    .filter((agentId) => fileExists(path.join(pluginRoot, agentId, "descriptor.js")))
    .sort());
  return agentIdCache;
}

// Every agent that provides `portName`, as `{ agentId, adapter }` pairs.
function listAgentPorts(portName) {
  assertPortName(portName);
  const result = [];
  for (const agentId of listAgentIds()) {
    const adapter = getAgentPort(agentId, portName);
    if (adapter) result.push({ agentId, adapter });
  }
  return result;
}

// Convenience for the common "call the adapter hook if present" shape.
// Returns `fallback` when the agent has no adapter on the port or the adapter
// does not implement `hookName`.
function callAgentPort(agentId, portName, hookName, args = [], fallback = undefined) {
  const adapter = getAgentPort(agentId, portName);
  if (!adapter || typeof adapter[hookName] !== "function") return fallback;
  return adapter[hookName](...args);
}

// Test seam: point discovery at a fixture plugin root (or back to the default
// with no argument) and drop every cached lookup.
function configureAgentPorts({ root } = {}) {
  pluginRoot = root || DEFAULT_PLUGIN_ROOT;
  portCache.clear();
  agentIdCache = null;
}

module.exports = {
  PORT_NAMES,
  PORT_FILES,
  getAgentPort,
  listAgentIds,
  listAgentPorts,
  callAgentPort,
  configureAgentPorts,
};
