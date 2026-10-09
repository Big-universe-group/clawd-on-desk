# Stats 集成 clawd

- 日期：2026-10-08
- 类型：需求变更 / 设计
- 分支 / 提交：未提交（只做了调研与方案选择）

## 问题
能否把 stats（macOS 系统监控，fork 在 `forkproject/stats`）集成进 clawd；在 clawd 里加两个开关：① 在托盘显示；② 鼠标移到桌宠上时，在额度下方显示 stats 信息的图形表格，移开即隐藏。

## 结论 / 回答
- 可以集成。stats 是原生 Swift 菜单栏应用（未沙盒），各模块读数都经过 `Kit/module/reader.swift` 的 `Reader.callback`，值是 Codable 结构
- 数据来源三选一，用户选定：**改 stats fork，在本机导出 JSON 快照，clawd 只读**（另两个方案：clawd 内 Node 自采 / 把 stats 编成 helper 打包进 clawd）
- clawd 侧可复用：托盘额度分组（`quota-tray-lines.js` + `menu.js`）、Session HUD 的额度分区与 auto-hide 热区、`tick.js` 的 `mouseOverPet` 悬停信号
- 需求文档 v0.2（`blog/pro/桌面助手改造/clawd 系统监控需求文档.md`）写的展示形态是「悬停弹卡片 + 右键三级目录」，与本次「额度下方图形表格」不同，待定

## 改动
无

## 对需求的影响
新增：Stats 监控（托盘开关 + 悬停 HUD 图表开关），数据源 = stats fork 本机导出。

## 待办
- stats fork 增加本机导出端点
- 首版展示形态：HUD 额度下方图表 vs 需求文档的悬停卡片
