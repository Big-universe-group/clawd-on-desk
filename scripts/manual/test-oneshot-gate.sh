#!/bin/bash
# Clawd ONESHOT gate 测试脚本
# 用法:
#   bash scripts/manual/test-oneshot-gate.sh               # 全测 5 个状态，间隔 6s
#   bash scripts/manual/test-oneshot-gate.sh error         # 只测 error
#   bash scripts/manual/test-oneshot-gate.sh notification
#   bash scripts/manual/test-oneshot-gate.sh sweeping
#   bash scripts/manual/test-oneshot-gate.sh attention
#   bash scripts/manual/test-oneshot-gate.sh carrying
#   bash scripts/manual/test-oneshot-gate.sh all 10        # 全测，间隔 10s
#   bash scripts/manual/test-oneshot-gate.sh all 6 codex   # 第 3 个参数换 agent_id（默认 claude-code）
#
# 测试场景:
#   1) Settings → Animation Map 里把对应行开关关掉 → 跑脚本 → 桌宠应不出对应动画（gate 生效）
#   2) 再把开关打开 → 跑脚本 → 桌宠应恢复播放对应动画（反向验证）
# 每个测试会话在间隔结束后发 SessionEnd 清掉，不在 HUD / Dashboard 留残行。

STATE=${1:-all}
DELAY=${2:-6}
AGENT=${3:-claude-code}
source "$(dirname "${BASH_SOURCE[0]}")/clawd-server-lib.sh"
clawd_require_server

# state → event，与 hooks/claude-code/clawd-hook.js 的 EVENT_TO_STATE 一致；
# 可关的 state 见 src/runtime/state/priority.js ONESHOT_STATE_NAMES
get_event() {
  case $1 in
    error)        echo "PostToolUseFailure" ;;
    notification) echo "Notification" ;;
    sweeping)     echo "PreCompact" ;;
    attention)    echo "Stop" ;;
    carrying)     echo "WorktreeCreate" ;;
    *) echo "" ;;
  esac
}

run_state() {
  local state=$1
  local event
  event=$(get_event "$state")
  local sid
  sid="test-${state}-$(date +%s)"
  printf "→ [%-13s] event=%-20s " "$state" "$event"
  curl -s -X POST "$CLAWD_BASE/state" -H "Content-Type: application/json" \
    -d "{\"state\":\"$state\",\"event\":\"$event\",\"session_id\":\"$sid\",\"agent_id\":\"$AGENT\"}" \
    -w " HTTP %{http_code}\n"
  sleep "$DELAY"
  clawd_post_state "{\"state\":\"sleeping\",\"event\":\"SessionEnd\",\"session_id\":\"$sid\",\"agent_id\":\"$AGENT\"}" > /dev/null
}

if [ "$STATE" = "all" ]; then
  echo "=== Clawd ONESHOT gate 全测：5 个状态，间隔 ${DELAY}s（port ${CLAWD_PORT}）==="
  for s in error notification sweeping attention carrying; do
    run_state "$s"
  done
  echo "=== 完成 ==="
else
  if [ -z "$(get_event "$STATE")" ]; then
    echo "✗ 未知 state: $STATE"
    echo "  有效值: error | notification | sweeping | attention | carrying | all"
    exit 1
  fi
  run_state "$STATE"
fi
