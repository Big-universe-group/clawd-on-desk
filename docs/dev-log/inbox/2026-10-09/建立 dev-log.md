# 建立 dev-log

- 日期：2026-10-09
- 类型：实现（流程）
- 分支 / 提交：refactor/layering「docs(dev-log): add per-turn development log convention」（`~/.omp/agent/RULES.md` 在仓库外）

## 问题
在 clawd-on-desk 目录下像 blog 一样，每个 turn 后记录问题和回答，后续手动整合成需求变动和更新记录文档。

## 结论 / 回答
- 约定 `docs/dev-log/README.md`：`inbox/<日期>/<主题>.md` + `Index.md`，单篇字段：日期 / 类型 / 提交 / 问题 / 结论 / 改动 / 对需求的影响 / 待办
- 整合目标 `docs/dev-log/需求变更记录.md`，只在手动整合时改
- 规则写进仓库 `AGENTS.md`（cwd 在仓库时生效）和 `~/.omp/agent/RULES.md`（cwd 不在仓库时也生效）
- 已补录 2026-10-08、10-09 的相关 turn

## 改动
- `docs/dev-log/`（README、需求变更记录、inbox）；`.gitignore` 放行 `docs/dev-log/`；`AGENTS.md`；`~/.omp/agent/RULES.md`

## 对需求的影响
无（流程）。

## 待办
无
