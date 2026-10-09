#!/bin/bash
# Clawd 动画全播放测试脚本：按内置 Clawd 主题 theme.json 轮播所有主模式动画（不含 mini-*）
# 用法: bash scripts/manual/test-demo.sh [每个动画秒数，默认8]
# 前提: 已 npm start，且当前主题是内置 Clawd（SVG 按当前主题目录解析）

DELAY=${1:-8}
source "$(dirname "${BASH_SOURCE[0]}")/clawd-server-lib.sh"
clawd_require_server

SVGS=()
while IFS= read -r svg; do
  [ -n "$svg" ] && SVGS+=("$svg")
done < <(clawd_theme_main_svgs)

echo "=== Clawd Demo: ${#SVGS[@]} animations, ${DELAY}s each (port $CLAWD_PORT) ==="
for i in "${!SVGS[@]}"; do
  svg="${SVGS[$i]}"
  printf "[%d/%d] %-36s " "$((i+1))" "${#SVGS[@]}" "$svg"
  clawd_post_state "{\"state\":\"working\",\"svg\":\"$svg\"}"
  echo ""
  sleep "$DELAY"
done

echo "Returning to idle..."
clawd_post_state '{"state":"idle","svg":"clawd-idle-follow.svg"}'
echo ""
echo "=== DONE ==="
