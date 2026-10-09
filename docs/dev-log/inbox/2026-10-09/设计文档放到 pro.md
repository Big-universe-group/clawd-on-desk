# 设计文档放到 pro

- 日期：2026-10-09
- 类型：实现（文档）
- 分支 / 提交：仓库外（blog）

## 问题
把之前生成的分层设计文档放到 `blog/pro/桌面助手改造/`。

## 结论 / 回答
- 复制为 `blog/pro/桌面助手改造/clawd 代码分层设计文档.md`（加 frontmatter，链接需求文档）；仓库内 `docs/project/layering-architecture.md` 保留，`AGENTS.md` 引用它，两份需手动同步
- 需求文档 §7.1 的代码落点仍是分层前路径，应改为 `src/stats/`

## 改动
- 新增 blog 文件（仓库外）

## 对需求的影响
无

## 待办
需求文档 §7.1 落点路径更新为 `src/stats/`（未做）。
