# 源码目录改名 my-desktop-aide

- 日期：2026-10-09
- 类型：需求变更 / 实现
- 分支 / 提交：pro `refactor/layering`、mini `feat/unlessbamboo`；bamboo-env `87fbec9`

## 问题
把源码目录 `clawd-on-desk` 改名为 `my-desktop-aide`，从 `forkproject/` 移出，后续先不合并上游（upstream）代码；pro、mini 两台一起改，并同步更新 `my-clawd-dev` 命令。

## 结论 / 回答
- 目录：两台都是 `~/Public/unusebamboo/forkproject/clawd-on-desk` → `~/Public/unusebamboo/my-desktop-aide`（移出 `forkproject`，走 `my-repo-sync` 的自动发现，按普通仓库处理）
- 不再合并上游：两台都 `git remote remove upstream`，并从 `my-repo-sync` 的 `FORK_UPSTREAM` 表删掉该条目 → `pull` 不再 fetch/merge upstream
	+ 以后要恢复跟上游：`git remote add upstream https://github.com/rullerzhou-afk/clawd-on-desk.git`，并在 `FORK_UPSTREAM` 重新登记
	+ `origin` 仍是 `git@github.com:Big-universe-group/clawd-on-desk.git`（GitHub 仓库没改名）
- `my-clawd-dev`：函数名与用法不变，只把 `CLAWD_DEV_DIR` 指到新目录
- 两台的绝对路径消费者全部改完（见「改动」），`~/.claude/settings.json` 的 hook、`~/.codex/clawd-hooks/*` wrapper 由仓库自带 install 脚本刷新；app 自身状态（statusline owner、opencode-family owner）pro 由重启的实例自动修好

## 改动
- bamboo-env（`87fbec9`）：
	+ `profile.d/60-clawd-dev.zsh`：`CLAWD_DEV_DIR` → `$HOME/Public/unusebamboo/my-desktop-aide`
	+ `bin/my-repo-sync`：`FORK_UPSTREAM` 删掉 `clawd-on-desk` 条目
	+ `README.md`：`profile.d` 说明、origin 那行（该项目移出 fork 名单）
	+ `omp/RULES.md`：dev-log 的 `.gitignore` 例外示例改指 `my-desktop-aide`
- 仓库本身（两台，未提交业务代码改动）：`git remote remove upstream` + 目录 `mv`
	+ pro 重启开发实例后从新目录运行（pid 变化，日志仍 `/tmp/clawd.log`）
	+ 从新目录重跑 `npm run install:claude-hooks / install:codex-hooks / install:omp-extension / install:pi-extension`（omp / pi 扩展不存绝对路径，报 Already up to date）
- 机器级配置（两台各改自己的）：
	+ `~/.cc-switch/cc-switch.db` → 表 `settings` → `common_config_claude`：14 处 `/Public/unusebamboo/forkproject/clawd-on-desk` → `/Public/unusebamboo/my-desktop-aide`
	+ `~/.claude/hooks/clawd-statusline-owner.json`：`managedCommand` / `previousManagedCommand`
	+ pro 另有 `~/.config/my-itsession/layouts/clawd.json` 的 4 处 pane 路径
	+ mini 没有跑实例、app 不会自修，`~/.claude/settings.json` 的 `statusLine.command` 与 owner 文件手工改（脚本名仍是该分支的 `hooks/claude-statusline.js`，未动）
	+ 改前备份：两台 `~/.clawd-move-backup/<时间戳>/`
- 实施顺序：停实例 → 改 bamboo-env → `mv` + 删 upstream → 重跑 install → 改 DB / 机器配置 → 起实例 → 提交推送 bamboo-env → mini 拉取后重复

## 对需求的影响
变更：该项目从 `forkproject/` 的 fork 名单转为普通仓库（`my-desktop-aide`），`my-repo-sync` 不再对它做 upstream 合并。

## 待办
- GitHub 仓库名 / 应用名仍是 `clawd-on-desk`（本轮只动本地目录与本机配置）
- mini 的 `~/.cc-switch/cc-switch.db` 存的仍是 `/Users/bamboopro/...` 前缀（历史遗留，切供应商会写回的是本机 `~/.claude/settings.json`，需另行处理）
- blog 侧旧路径笔记待 review 时替换：`tools-clawd-机制`、`tools-双机开发环境同步`、`ai-agent-cc-switch`、`system-env-using`、`vcs-git-workflow`、`pro/桌面助手改造/*`
