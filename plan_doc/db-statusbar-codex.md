# DB 路线(agent + tool/MCP 重建两个 ST 脚本能力)——已实施完成

> 本文件记录 DB 路线的实施成果。**该路线已实施并验证完毕,不是待办。**
> 详细设计与决策见 `plugin-analysis/DB分析01~04`(该目录已被 .gitignore 忽略,为本地分析工作区)。

## 当前实施范围(已完成)

2026-08-08 已实施并提交(git commits a728956 / f47f077 / 70a0a36 / dc3dd2a):

1. **codex 工具族**(src/tools/codex.ts):codex_list/read/create/write/delete/mount 6 个工具,包装 src/codex.ts 纯函数,写侧过门禁;stage 与 assistant 双面接入。
2. **choice 工具**(src/tools/choice.ts):台上选择卡工具,包装 uiContext.select(选项 2-4 + 自由输入),主演可发玩法/邂逅选择卡。
3. **CodexPanel 条目编辑**:PUT /api/codex/entries 路由 + src/codex.ts updateCodexEntry + 前端编辑态(commit a728956、dc3dd2a 前)。
4. **状态栏独立预设**(assets/presets/状态栏-梦鲸思客V4-0802.json):梦鲸思客全量 94 块 + 3 状态栏行为块(记账纪律/玩法检索与发卡/邂逅事件)。预设为单文件整包替换,切换即装、切回即卸。
5. **数据导入**:plugin-analysis/extract-data.mjs 从 ST 脚本抽取,直写 12 个 .liyuan-codex/*.json(玩法 6 库/成就 616/卡池 630/技能表/邂逅 2 库/示意图)。.liyuan-codex/ 被 .gitignore 忽略,数据在本机,不入仓库;可用抽取脚本随时重建。
6. **直播剥离**(server/main.ts):流式 text_delta 广播前剥离模型误写的 `<tool_calls>`/`<invoke>` 标签文本(会话级状态机,处理跨 delta 切分)。
7. **CodexPanel 挂载反馈**:挂载/卸载 toast 文案修正 + 标题「已挂载 N 库」汇总(commit dc3dd2a 前)。

关键裁决(2026-08-08 用户):
- 不做定制 agent:自带助手(stagehand)已有 codex_create/codex_write/codex_mount 工具,AI 改表助手等由自带助手完成。
- rerank 不做(独立能力,当前用不上)。
- 图片"给用户看":示意图 URL 存知识库,按需经 show_image 交付(ZoomImg 渲染),不进模型上下文。
- 知识库 vs 账本分工:动态状态(时间/地点/好感/物品)→ 世界状态账本(world_state_update);静态知识/玩法/成就 → 知识库。

## 待办

- 无。(DB 路线范围内无未完成项;挂载反馈增强已随 dc3dd2a 完成。)

> 注意:用户原始世界书只读,agent 新写设定进 .liyuan-lore/ 或知识库,不改用户文件(AGENTS.md 红线)。
