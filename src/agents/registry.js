// Agent registry — loads all agent configs, provides lookup API
// Used by main.js for process detection and session tracking

const claudeCode = require("./claude-code/descriptor");
const deepseekHarness = require("./deepseek-harness/descriptor");
const codex = require("./codex/descriptor");
const copilotCli = require("./copilot-cli/descriptor");
const geminiCli = require("./gemini-cli/descriptor");
const antigravityCli = require("./antigravity-cli/descriptor");
const cursorAgent = require("./cursor-agent/descriptor");
const codebuddy = require("./codebuddy/descriptor");
const kiroCli = require("./kiro-cli/descriptor");
const kimiCli = require("./kimi-cli/descriptor");
const qwenCode = require("./qwen-code/descriptor");
const zcode = require("./zcode/descriptor");
const codewhale = require("./codewhale/descriptor");
const opencode = require("./opencode/descriptor");
const mimocode = require("./mimocode/descriptor");
const pi = require("./pi/descriptor");
const omp = require("./omp/descriptor");
const openclaw = require("./openclaw/descriptor");
const hermes = require("./hermes/descriptor");
const qoder = require("./qoder/descriptor");
const reasonix = require("./reasonix/descriptor");
const qoderwork = require("./qoderwork/descriptor");
const qwenwork = require("./qwenwork/descriptor");
const workbuddy = require("./workbuddy/descriptor");
const traecode = require("./traecode/descriptor");
const grokBuild = require("./grok-build/descriptor");
const minimax = require("./minimax/descriptor");

const AGENTS = [
  claudeCode,
  deepseekHarness,
  codex,
  copilotCli,
  geminiCli,
  antigravityCli,
  cursorAgent,
  codebuddy,
  kiroCli,
  kimiCli,
  qwenCode,
  zcode,
  codewhale,
  opencode,
  mimocode,
  pi,
  omp,
  openclaw,
  hermes,
  qoder,
  reasonix,
  qoderwork,
  qwenwork,
  workbuddy,
  traecode,
  grokBuild,
  minimax,
];
const AGENT_MAP = new Map(AGENTS.map((a) => [a.id, a]));

function namesForPlatform(agent, field) {
  const namesByPlatform = agent[field] || {};
  const isWin = process.platform === "win32";
  const isLinux = process.platform === "linux";
  return isWin
    ? (namesByPlatform.win || [])
    : isLinux
      ? (namesByPlatform.linux || namesByPlatform.mac || [])
      : (namesByPlatform.mac || []);
}

function collectProcessNames(field) {
  const result = [];
  for (const agent of AGENTS) {
    const names = namesForPlatform(agent, field);
    for (const name of names) result.push({ name, agentId: agent.id });
  }
  return result;
}

module.exports = {
  getAllAgents: () => AGENTS,
  getAgent: (id) => AGENT_MAP.get(id),

  getAllProcessNames: () => collectProcessNames("processNames"),
  getStartupRecoveryProcessNames: () => collectProcessNames("startupRecoveryProcessNames"),
};
