#!/bin/bash
# macOS adaptation check for Clawd on Desk (manual, interactive)
# Run this AFTER launching the app: npm start
# Usage: bash scripts/manual/test-macos.sh

set -e

source "$(dirname "${BASH_SOURCE[0]}")/clawd-server-lib.sh"
HOOK="$CLAWD_REPO_ROOT/hooks/claude-code/clawd-hook.js"
SHARED_PROCESS="$CLAWD_REPO_ROOT/hooks/shared/shared-process.js"
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
CYAN='\033[36m'
RESET='\033[0m'

pass() { echo -e "  ${GREEN}✓${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }
info() { echo -e "  ${DIM}→${RESET} $1"; }
header() { echo -e "\n${BOLD}${CYAN}[$1]${RESET} $2"; }
# macOS has no GNU timeout by default; perl alarm kills the exec'd command.
_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }
proc_base() { echo "$1" | sed 's|^-||' | xargs basename 2>/dev/null | tr '[:upper:]' '[:lower:]'; }

TEST_SESSIONS="macos-test macos-test-probe focus-test dash-1 dash-2"
cleanup() {
  [ -n "$CLAWD_BASE" ] || return 0
  for sid in $TEST_SESSIONS; do
    clawd_post_state '{"state":"sleeping","session_id":"'"$sid"'","event":"SessionEnd"}' > /dev/null || true
  done
  echo -e "\n${BOLD}${CYAN}[✓]${RESET} Cleanup"
  pass "Test sessions ended: $TEST_SESSIONS"
}

# ─── Pre-flight ───
header "0" "Pre-flight checks"

if [ "$(uname)" != "Darwin" ]; then
  fail "This script is for macOS only"
  exit 1
fi
pass "Running on macOS ($(sw_vers -productVersion))"

clawd_require_server
pass "Clawd HTTP server is reachable on port $CLAWD_PORT"
trap cleanup EXIT

# ─── Test 1: Claude hook + process tree walk ───
header "1" "Claude hook — process tree walk (hooks/shared/shared-process.js)"

echo -e "${DIM}  Current terminal process tree:${RESET}"
CUR=$$
for i in $(seq 1 8); do
  PNAME=$(ps -o comm= -p "$CUR" 2>/dev/null || echo "???")
  PPID_VAL=$(ps -o ppid= -p "$CUR" 2>/dev/null | tr -d ' ' || echo "0")
  echo -e "    ${DIM}Level $i: PID=$CUR  name=$(proc_base "$PNAME")  ppid=$PPID_VAL${RESET}"
  if [ "$PPID_VAL" = "0" ] || [ "$PPID_VAL" = "1" ] || [ "$PPID_VAL" = "$CUR" ]; then
    break
  fi
  CUR=$PPID_VAL
done

echo ""
info "Running $HOOK SessionStart ..."
HOOK_STATUS=0
HOOK_OUTPUT=$(echo '{"session_id":"macos-test","cwd":"'"$(pwd)"'"}' | _timeout 5 node "$HOOK" SessionStart 2>&1) || HOOK_STATUS=$?
if [ "$HOOK_STATUS" -eq 0 ]; then
  pass "Hook script exited 0"
else
  fail "Hook script exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

PROBE_RESULT=$(clawd_post_state '{"state":"idle","session_id":"macos-test-probe"}' 2>&1)
if [ "$PROBE_RESULT" = "ok" ]; then
  pass "State server accepted a direct /state request"
else
  fail "State server response: $PROBE_RESULT"
fi

# ─── Test 2: Terminal name matching ───
header "2" "Terminal name matching (BASE_TERMINAL_NAMES_MAC / BASE_EDITOR_MAP_MAC)"

# Read the live lists from the resolver instead of copying them here.
TERMINAL_NAMES=$(node -e 'const c = require(process.argv[1]).getPlatformConfig(); console.log([...c.terminalNames].join(" "))' "$SHARED_PROCESS")
EDITOR_NAMES=$(node -e 'const c = require(process.argv[1]).getPlatformConfig(); console.log(Object.keys(c.editorMap).join(" "))' "$SHARED_PROCESS")
info "Terminal names: $TERMINAL_NAMES"
info "Editor names:   $EDITOR_NAMES"

# The resolver walks every ancestor, so report the first terminal/editor hit.
MATCH=""
CUR=$(ps -o ppid= -p $$ | tr -d ' ')
for i in $(seq 1 8); do
  [ -n "$CUR" ] && [ "$CUR" -gt 1 ] || break
  BASE=$(proc_base "$(ps -o comm= -p "$CUR" 2>/dev/null || echo unknown)")
  for name in $TERMINAL_NAMES $EDITOR_NAMES; do
    if [ "$BASE" = "$name" ]; then
      MATCH="$BASE (PID $CUR)"
      break 2
    fi
  done
  CUR=$(ps -o ppid= -p "$CUR" 2>/dev/null | tr -d ' ' || true)
done

if [ -n "$MATCH" ]; then
  pass "Ancestor recognized as terminal/editor: $MATCH"
else
  fail "No ancestor matches the macOS terminal/editor lists"
  info "${YELLOW}Add your terminal's process name to BASE_TERMINAL_NAMES_MAC in hooks/shared/shared-process.js${RESET}"
fi

# ─── Test 3: osascript activation ───
header "3" "osascript activation (System Events frontmost)"

ACCESSIBILITY=$(osascript -e 'tell application "System Events" to return name of first process whose frontmost is true' 2>&1 || true)
if echo "$ACCESSIBILITY" | grep -qi "not allowed\|assistive\|1002"; then
  fail "Accessibility permission NOT granted"
  info "Go to: System Settings → Privacy & Security → Accessibility"
  info "Add your terminal app (or Clawd) to the allowed list"
else
  pass "Accessibility permission OK (frontmost app: $ACCESSIBILITY)"
fi

TERM_PID=$(ps -o ppid= -p $$ | tr -d ' ')
info "Registering session focus-test with source_pid=$TERM_PID (click it in the Dashboard to test Clawd's own focus path)"
clawd_post_state '{"state":"working","session_id":"focus-test","event":"PreToolUse","source_pid":'"$TERM_PID"',"cwd":"'"$(pwd)"'"}' > /dev/null

echo ""
echo -e "  ${YELLOW}>>> In 3 seconds this script will osascript-focus THIS terminal <<<${RESET}"
echo -e "  ${YELLOW}>>> Switch to another window NOW to verify it comes back       <<<${RESET}"
sleep 3

FOCUS_SCRIPT='
set pid to '"$TERM_PID"'
repeat 8 times
  try
    set pInfo to do shell script "ps -o ppid=,comm= -p " & pid
    set ppid to (word 1 of pInfo) as integer
    tell application "System Events"
      set pList to every process whose unix id is pid
      if (count of pList) > 0 then
        set frontmost of item 1 of pList to true
        return "focused pid " & pid
      end if
    end tell
    if ppid is less than or equal to 1 then exit repeat
    set pid to ppid
  on error errMsg
    return "error: " & errMsg
  end try
end repeat
return "no focusable process found"'

FOCUS_RESULT=$(osascript -e "$FOCUS_SCRIPT" 2>&1 || true)
if echo "$FOCUS_RESULT" | grep -qi "focused"; then
  pass "osascript focus succeeded: $FOCUS_RESULT"
else
  fail "osascript focus result: $FOCUS_RESULT"
fi

# ─── Test 4: Permission Bubble ───
header "4" "Permission bubble — POST /permission"

info "Sending permission request (waits up to 15s for your click) ..."
echo -e "  ${YELLOW}>>> A permission bubble should appear; click Allow or Deny       <<<${RESET}"
echo -e "  ${YELLOW}>>> The first click must land without focusing the bubble first <<<${RESET}"

PERM_STARTED=$(date +%s)
PERM_RESPONSE=$(_timeout 15 curl -s -X POST "$CLAWD_BASE/permission" \
  -H "Content-Type: application/json" \
  -d '{
    "tool_name": "Bash",
    "tool_input": {"command": "echo hello from test-macos.sh"},
    "session_id": "bubble-test",
    "permission_suggestions": [
      {"type": "addRules", "toolName": "Bash", "ruleContent": "echo *", "behavior": "allow", "destination": "localSettings"},
      {"type": "setMode", "mode": "acceptEdits", "destination": "localSettings"}
    ]
  }' 2>&1 || echo '{"timeout":true}')

PERM_ELAPSED=$(( $(date +%s) - PERM_STARTED ))
if echo "$PERM_RESPONSE" | grep -qi "allow\|deny\|hookSpecificOutput"; then
  pass "Decision received after ${PERM_ELAPSED}s: $(echo "$PERM_RESPONSE" | head -c 120)"
  if [ "$PERM_ELAPSED" -le 1 ]; then
    info "${YELLOW}No time for a click — permission automation (Settings) decided it, the bubble was not tested${RESET}"
  fi
elif [ -z "$PERM_RESPONSE" ]; then
  info "Empty response (DND on, bubbles disabled, or connection dropped — no decision is expected then)"
else
  fail "Unexpected response: $PERM_RESPONSE"
fi

# ─── Test 5: Sessions Dashboard ───
header "5" "Sessions Dashboard"

clawd_post_state '{"state":"working","session_id":"dash-1","event":"PreToolUse","source_pid":'"$TERM_PID"',"cwd":"/Users/test/project-alpha"}' > /dev/null
clawd_post_state '{"state":"thinking","session_id":"dash-2","event":"UserPromptSubmit","source_pid":'"$TERM_PID"',"cwd":"/Users/test/project-beta"}' > /dev/null
pass "2 sessions registered (project-alpha: working, project-beta: thinking)"
echo -e "  ${YELLOW}>>> Cmd+Click the pet (or right-click → Open Dashboard) to see them <<<${RESET}"
echo -e "  ${YELLOW}>>> Press Enter when done; test sessions are ended on exit          <<<${RESET}"
read -r _ || true

echo ""
echo -e "${BOLD}Done!${RESET} Review the results above."
echo -e "If the hook or terminal matching failed, check:"
echo -e "  1. Accessibility permission for your terminal/Clawd"
echo -e "  2. Terminal process name in BASE_TERMINAL_NAMES_MAC (hooks/shared/shared-process.js)"
echo -e "  3. focus-debug.log in Clawd's userData dir (~/Library/Application Support/<app name>/)"
