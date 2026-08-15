# NeuroBook 借鉴点（语义评审已实施 + 其余待办）

> 2026-08-14 探索对比 `J:\AITools\neuro-book`（notnotype 的本地 AI 长篇创作工作台）与 Liyuan 后整理的借鉴清单。**待办节的条目仅供追踪，未经用户点名不得实现**——只有用户明确点名要求实现某条时方可动手，并把它移入「当前实施范围」。

## 当前实施范围

### 语义评审维度化（2026-08-14 已实施并验证）

补主聊天验收的「人格/文风一致性程序层零兜底」盲区：封笔后由旁路模型做一次独立评审（设定一致性 / 人物一致性 / 文风与 AI 味三维），输出结构化问题清单（证据引文 + 可执行改法），major 问题并入现有修复门禁（draft_edit 定点修、同一修复卡、同一 3 轮安全阀）。

- 设计文档：`docs/DESIGN-semantic-review.md`
- 借鉴点：NeuroBook `chapter-write-review-revise` workflow 的「评审者 = 独立 agent + outputSchema 强校验 + 问题必须引正文证据」——Liyuan 裁剪为旁路单轮调用（不引多 agent 编排），评审维度收敛为三维，major/minor 分档控制误报代价。
- 验证：`test/review.test.ts`（8 用例纯函数）+ `test/stage-engine.test.ts` 评审集成测试（seal 评审 → major 拦 → edit 修复 → 放行）；全量 `npm test` 849 过 / 11 挂（11 挂为基线已知：lorebook fixture 缺失 10 + globalThis 槽 1）。

## 待办

### 高契合（直补 Liyuan 盲区）

1. **信息控制字段（knowledge[]）**——角色「谁知道什么」结构化：谁知道什么、何时知道、读者知道什么；防全知 brief（写作时只给「查哪些 subject」的查询提示，不展开状态）。来源：NeuroBook `state.md` 的 `knowledge[]` + 三层视角隔离 + 防全知模式。RP 价值：剧情迷雾/角色信息边界的机制化——现在只靠预设 B/C 常驻提示 + 主权红线，无「角色不知道 X」的结构化载体。
2. **素材变更感知**——每拍注入「本拍与上拍素材差异提醒」（卡/世界书/lore/技能库被改过，模型不知变）。来源：NeuroBook `profile-turn-context` 的 `<file-change-notice>`（游标推进 last_seen_entry_id + diff 提醒）。Liyuan 素材每拍现读但模型不知道变了，改卡/换预设后易演旧设定。
3. **未决决策记账**——用户没拍板的剧情线记账（StoryDecision 类 ADR），写正文时警告「不得写死/说破」。来源：NeuroBook `StoryDecision`（必填 risk）+ ChapterBrief 未决决策警告。Liyuan 有 `ask` 工具但无「未决决策」跨拍账本——模型会把没定的变量顺手定型。

### 中契合（裁剪形态后可用）

4. **伏笔/承诺账本**——跨拍伏笔埋设/推进/兑现记账（Promise/Beat：deadline/cadence 四分类），每拍生成写作任务（「只写到发烫，不许发光」式幅度控制）。来源：NeuroBook 承诺账本 + `chapter-writer-brief.service` beat→指令措辞。RP 长局适用（可与 table_query 自定义表结合，不一定要新模块）。
5. **世界状态事件溯源**——账本从「快照」升级为「事件溯源」：patch 全量留存（谁在何时改了什么）、任意时间点重放。来源：NeuroBook WorldSlice/WorldPatch（JSON Patch + sqlite-vec 向量）。Liyuan 已有 `world_state_update` 的 patch 数据与 rp-state 快照链，升级成本可控，价值是设定漂移审计。
6. **draft_edit diff 可视化**——「修了什么」的 UI 呈现。rp-draft-op 补丁数据已有（可回放），缺前端 diff 视图（NeuroBook 有 diff-workbench）。对排查/回滚友好。
7. **系统提示词可视化面板**——当前拍完整组装提示词的摘要视图。trace 是全量 JSONL（机器格式），缺可读 UI（NeuroBook 有 AgentSystemPromptPanel）。对调试「为什么模型这么演」友好。
8. **llmlint 写前投影**——F 类机械规则（禁词/句式/比喻频率）除了进检查代码，还**投影成文风约束注入提示词**（写前约束，减少写了再改）。来源：NeuroBook llmlint 的「写前投影」时机。注意与「验算指令摘除」（stripAuditLines 防脑内自查）的平衡——投影是「怎么写」不是「写完查」，文案要区分。

### 观察/不采纳（低契合，仅记录）

- TSX Profile DSL（Liyuan 已有拆层 + JSON 配置 + writing_guide 按需读，引入 DSL 成本高）。
- 多 Provider 模板 + 透明计费（单机自用价值有限）。
- 三模式审批流（Liyuan 的 `ask` 已是轻量版）。
- 自动压缩（Liyuan `compact.ts` 已有：保留最近 6 拍 + 摘要 + 归档剧情库，方向一致且更务实）。
- ST 角色卡导入（Liyuan `card.ts` 已支持 CC V2/V3 PNG/JSON）。
