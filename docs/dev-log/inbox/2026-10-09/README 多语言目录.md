# README 多语言目录

- 日期：2026-10-09
- 类型：问答 / 实现 / 回滚
- 分支 / 提交：refactor/layering `88adb3f7`

## 问题
1. 为何很多开源项目把多语言 README 平铺在根目录而不放文件夹
2. 放到 `docs/i18n` 下还是一个个 README，是否合理
3. 「按你说的做」→ 实际删掉了 4 份翻译
4. 回滚：要的是挪到 `docs/i18n/<语言>/`

## 结论 / 回答
- 根目录平铺的原因：GitHub 首页只渲染根目录一份 README；README 里的相对链接无需改；命名约定直观；npm / PyPI 只认根 README
- 误把「删减语言」当成用户选择执行了（提交未推送），已 `git reset --hard` 撤销
- 最终：英文 `README.md` 留根目录，zh-CN / zh-TW / ko-KR / ja-JP / es 挪到 `docs/i18n/<lang>/README.md`

## 改动
- 5 份翻译 `git mv` 到 `docs/i18n/<lang>/README.md`，按新位置重算所有相对链接
- 根 README 语言链接改为 `docs/i18n/<lang>/README.md`；4 篇中文 guide 的「返回 README」改为 `../i18n/zh-CN/README.md`
- `.gitignore` 增加 `!docs/i18n/`、`!docs/i18n/**`
- 3 个 README 测试改新路径，新增「语言链接都指向存在的 README」检查

## 对需求的影响
无（仓库结构调整）。

## 待办
无
