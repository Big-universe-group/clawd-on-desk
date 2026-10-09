# 根目录 test 脚本用途

- 日期：2026-10-09
- 类型：问答 / 实现
- 分支 / 提交：refactor/layering `f34f8548`

## 问题
根目录下的 test-*.sh 脚本是干嘛的。

## 结论 / 回答
四个都是手动视觉 / 真机 QA 脚本，需先 `npm start`，靠 curl 往 `127.0.0.1:23333` 的 `/state`、`/permission` 发假事件，人眼看桌宠反应；不属于 `npm test`。

- `test-demo.sh [秒]`：轮播 18 个主 SVG 动画（默认每个 8s）
- `test-mini.sh [秒]`：轮播 6 个极简模式动画，最后回 idle
- `test-oneshot-gate.sh [state|all] [秒] [agent]`：发 error / notification / sweeping / attention / carrying 对应事件，验证 Settings Animation Map 开关能否屏蔽一次性动画
- `test-macos.sh`：macOS 适配检查（PID 树、终端名匹配、osascript 聚焦、权限气泡、Dashboard 会话、清理）

已过时点：
- `test-macos.sh` 的 `HOOK="hooks/clawd-hook.js"` 分层后已不存在，应为 `hooks/claude-code/clawd-hook.js`；终端名列表、"main.js line 1186" 也是旧代码描述
- 除 `test-macos.sh` 外端口写死 23333，未读 `~/.clawd/runtime.json`
- `test-oneshot-gate.sh` 注释里的 `agents/claude-code.js` 现为 `src/agents/claude-code/descriptor.js`

## 追问：修正脚本 + 挪位置（同日）

用户要求修正这些脚本，并问能否放到 `scripts/` 或 `test/`。

决定放 `scripts/manual/`：那里已是「需人工、跑真机」脚本的约定目录（带 README）；`test/` 是 `npm test`（`test/run-tests.js`）跑的 `*.test.js`，按 `test/<layer>/<area>/` 分层，放不跑的 shell 脚本会混淆。保留原文件名，`git mv` 保历史。

修正内容：
- 新增 `scripts/manual/clawd-server-lib.sh`：端口按 `~/.clawd/runtime.json` → 23333-23337 发现、用 `x-clawd-server` 头确认；仓库根由脚本位置推出，任意 cwd 可跑
- `test-demo.sh`：手写 18 个 SVG 中有 4 个（conducting / confused / overheated / disconnected）已不存在 → 改为从 `themes/clawd/theme.json` 读出全部主模式动画（现 23 个），结束回 idle
- `test-mini.sh`：同样改读 `miniMode.states`（现 9 个，原 6 个）
- `test-oneshot-gate.sh`：端口自动发现；每个测试会话结束后发 `SessionEnd`，不再在 HUD 留残行；注释指向 `clawd-hook.js` 的 `EVENT_TO_STATE` 和 `priority.js` 的 `ONESHOT_STATE_NAMES`
- `test-macos.sh`：hook 路径改 `hooks/claude-code/clawd-hook.js` 并检查退出码；macOS 无 `timeout`，改用 perl alarm；终端/编辑器名单运行时从 `shared-process.js` `getPlatformConfig()` 读，并按 resolver 方式逐级祖先匹配；Cmd+Click 打开的是 Dashboard（菜单是 Open Dashboard，没有 Sessions 子菜单）；去掉假 pass 的 Test 6（updater）/ Test 7（引用不存在的 main.js 行号）；`trap EXIT` 保证测试会话被清理；权限决定 ≤1s 返回时提示是 permission automation 代答、气泡没被测到
- `AGENTS.md` 命令列表、`scripts/manual/README.md` 新增章节

验证：shellcheck 无 warning；在 `/tmp` 下对运行中的 Clawd（23333）跑 demo / mini / oneshot（all、单项、非法 state 退出 1）全部 `ok`/HTTP 200；`test-macos.sh` 全流程通过（iTerm2 命中、hook exit 0、清理执行）。本机权限请求被 automation 0s 内放行，气泡点击路径未覆盖。

## 改动
- `test-*.sh` → `scripts/manual/test-*.sh`（4 个，内容如上修正）
- `scripts/manual/clawd-server-lib.sh`：新增
- `scripts/manual/README.md`、`AGENTS.md`：路径与说明

## 对需求的影响
无

## 待办
无
