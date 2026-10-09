# AGPL 二次开发

- 日期：2026-10-08
- 类型：问答
- 分支 / 提交：无

## 问题
AGPL-3.0 协议下能否基于 clawd-on-desk 二次开发。

## 结论 / 回答
- 代码 `AGPL-3.0-only`：可修改、自用、分发、商用；分发时整个改版仍须 AGPL、保留版权、写明改动、提供源码；不能闭源或改成宽松协议
- 素材 `assets/`、`themes/*/assets/` 为 All Rights Reserved，Clawd 角色归 Anthropic，禁止商用与改图分发
- stats 为 MIT；当前方案是两个程序经本机 HTTP 交换数据，stats fork 不受 AGPL 影响

## 改动
无

## 对需求的影响
约束：新增界面图形需自绘，不复用 clawd 美术素材做商用分发。

## 待办
README 顶部注明「基于 rullerzhou-afk/clawd-on-desk 的非官方修改版」（未做）。
