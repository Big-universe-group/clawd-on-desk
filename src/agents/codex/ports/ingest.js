"use strict";

// Ingest port adapter for Codex.

const {
  isCodexCliOriginator,
  isCodexDesktopOriginator,
} = require("../../../../hooks/codex/codex-originator");
const { deriveCodexHomeFromTranscriptPath } = require("../thread-id");
const { isWorkingLikeState, isLocalIdleConversation } = require("../../../runtime/state/stale-cleanup");

// Default silence allowance for a local Codex turn when the user has not set
// `codexWorkingStaleMs`.
const LOCAL_WORKING_STALE_FLOOR_MS = 20 * 60 * 1000;

module.exports = {
  LOCAL_WORKING_STALE_FLOOR_MS,

  // Stateful main-process runtime (JSONL log monitor, archive tracker,
  // official-hook arbitration, turn fence) owned by runtime-main.
  createMainRuntime(services) {
    return require("../main-runtime").createCodexMainRuntime(services);
  },

  // Working-state silence timeout for this session, or undefined for the
  // generic one. Local Codex can spend many minutes in one silent
  // model/command segment, especially while the Desktop app is retrying a weak
  // network. Unlike the generic working timeout, this is an explicit user
  // choice (`codexWorkingStaleMs`). Zero means a silent-but-live local Codex
  // turn is never idled by age alone.
  staleWorkingTimeoutMs(session, { staleConfig } = {}) {
    if (!session || session.host || !isWorkingLikeState(session.state)) return undefined;
    const config = staleConfig || {};
    return Number.isFinite(config.codexWorkingStaleMs) && config.codexWorkingStaleMs >= 0
      ? config.codexWorkingStaleMs
      : LOCAL_WORKING_STALE_FLOOR_MS;
  },

  // Outcome for a session past the idle-age cutoff, or null for the generic
  // rules.
  staleIdleDecision(session, { hasReplyableCompletionMapping } = {}) {
    if (!isLocalIdleConversation(session)) return null;
    const replyable = () => typeof hasReplyableCompletionMapping === "function"
      && hasReplyableCompletionMapping() === true;
    // Codex Desktop threads share one long-lived app-server PID and do not
    // emit SessionEnd. A live process therefore cannot keep an individual idle
    // thread alive forever; use the user-configured idle-age cutoff instead,
    // unless a reply mapping still targets the thread.
    if (isCodexDesktopOriginator(session.codexOriginator)) {
      if (replyable()) return { action: null };
      return { action: "delete", reason: "codex-desktop-idle-timeout" };
    }
    // A JSONL-only CLI session can be queueable even when this host cannot map
    // its writer PID. Keep the session identity while the Telegram mapping is
    // live; otherwise the generic unreachable/no-source rules still retire it.
    if (
      isCodexCliOriginator(session.codexOriginator)
      && !!deriveCodexHomeFromTranscriptPath(session.transcriptPath, process.platform)
      && replyable()
    ) {
      return { action: null };
    }
    return null;
  },
};
