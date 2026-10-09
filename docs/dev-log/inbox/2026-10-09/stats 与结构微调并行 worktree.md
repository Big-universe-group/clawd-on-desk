# stats 与结构微调并行 worktree

- 日期：2026-10-09
- 类型：问答
- 分支 / 提交：refactor/layering `f34f8548`（未提交）

## 问题
能否开 worktree：一边用 Claude + opencode/DeepSeek V4 Flash 写 stats 并迁移功能，一边在原目录继续做代码结构微调。

## 结论 / 回答
- 可以开。主目录留在 `refactor/layering` 做结构微调；新 worktree `../clawd-on-desk-stats` 从 `refactor/layering` 切 `feat/stats`，因为 `src/stats/` 依赖分层后的目录
- 开之前先提交主目录里未提交的 dev-log 文件，避免两边各写一份
- 新 worktree 要单独 `npm ci`（node_modules 不共享，约 447M）
- 同一时刻只能跑一个 Clawd：`requestSingleInstanceLock` + 共用 userData（prefs、日志）；后启动的实例被拒
- 在 stats worktree 里 `npm start` 会把 `~/.claude/settings.json` 等 hook 绝对路径同步到 worktree 目录；测完回主目录 `npm start` 一次把路径同步回来，删 worktree 前必须做
- 冲突面：stats 挂载点（`ui/menu/menu.js`、`ui/hud/session-hud.js`、`ui/settings/renderer.js`、`core/settings/effect-router.js`、`main.js`）正是结构微调第 4.2 条要改的地方；stats 代码尽量只放 `src/stats/` 与 `test/stats/`，挂载改动放最后、保持小；结构侧每提交一批，stats 分支 `git rebase refactor/layering`
- dev-log 两边都会写同一天的 `Index.md`，冲突只是追加行，合并时两边都保留

## 改动
- 无代码改动

## 对需求的影响
无

## 待办
- 执行 worktree 创建（用户自行或下一轮）
