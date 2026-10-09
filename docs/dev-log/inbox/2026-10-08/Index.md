# dev-log 2026-10-08

- Stats 集成 clawd [需求变更] → 选定 stats fork 本机导出 JSON、clawd 只读；托盘开关 + 悬停 HUD 图表
- 关闭托盘额度 [实现] → pro prefs quotaTrayEnabled=false；发现切上游 main 跑会剥掉 fork 独有 prefs
- AGPL 二次开发 [问答] → 代码可改可分发须保持 AGPL，素材不可商用
- 代码分层重构 [设计/实现] → 独立维护，src/hooks/test 按层分目录（跨 10-09）
