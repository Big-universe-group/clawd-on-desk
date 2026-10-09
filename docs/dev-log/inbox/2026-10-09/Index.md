# dev-log 2026-10-09

- README 多语言目录 [问答/实现/回滚] → 英文留根目录，5 份翻译挪到 docs/i18n/<lang>/README.md
- 根目录各目录用途 [问答] → 进包的只有 src/hooks/themes/extensions/pwa/部分 assets，其余为开发用
- 设计文档放到 pro [实现] → 复制到 blog/pro/桌面助手改造/，仓库内保留
- 建立 dev-log [实现] → docs/dev-log 约定 + AGENTS.md / RULES.md 规则，补录 10-08、10-09
- 根目录 test 脚本用途 [问答/实现] → 4 个手动视觉 QA 脚本已修正并挪到 scripts/manual/，动画列表改读 theme.json
- stats 与结构微调并行 worktree [问答] → 可以开；从 refactor/layering 切 feat/stats，同时只跑一个 Clawd，hook 路径会跟着 npm start 的目录走
