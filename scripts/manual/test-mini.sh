#!/bin/bash
# 极简模式动画测试脚本：按内置 Clawd 主题 miniMode.states 轮播所有 mini-* 动画，最后回 idle
# 用法: bash scripts/manual/test-mini.sh [每个动画秒数，默认6]
# 前提: 已 npm start，且当前主题是内置 Clawd

DELAY=${1:-6}
source "$(dirname "${BASH_SOURCE[0]}")/clawd-server-lib.sh"
clawd_require_server

STATES=()
SVGS=()
while read -r state svg; do
  [ -n "$state" ] || continue
  STATES+=("$state")
  SVGS+=("$svg")
done < <(clawd_theme_mini_states)

echo "=== Mini Mode Demo: ${#SVGS[@]} animations, ${DELAY}s each (port $CLAWD_PORT) ==="
for i in "${!SVGS[@]}"; do
  svg="${SVGS[$i]}"
  state="${STATES[$i]}"
  printf "[%d/%d] %-18s → %-28s " "$((i+1))" "${#SVGS[@]}" "$state" "$svg"
  clawd_post_state "{\"state\":\"$state\",\"svg\":\"$svg\"}"
  echo ""
  sleep "$DELAY"
done

echo "Returning to idle..."
clawd_post_state '{"state":"idle","svg":"clawd-idle-follow.svg"}'
echo ""
echo "=== DONE ==="
