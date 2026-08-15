# docs/ 文档总索引

> 整理：2026-08-10 · 核对基线：git HEAD `0856703`（master）
> 原则：**只索引与标注，不改写、不删减任何文档内容**——历史文档即使过时也原地保留，状态与出处都在本索引中如实标注。

本索引是 docs/ 的入口：38 份文档全量分类（§1）、散落各文档的待办与遗留事项汇总（§2）、文档与代码的对应关系（§3）、文档中与当前代码不一致的过时标注（§4）、引用关系与命名注意（§5）。

---

## §1 文档分类总表（38 份）

### 一、长期有效规范（7 份）

| 文档 | 行数 | 一句话主题 |
|---|---|---|
| [FLOW-MAP.md](FLOW-MAP.md) | 171 | 主聊天一拍流程图：每步作用 + 预设定制面/代码面标注 + F 机械纪律真实链路（2026-08-13） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 543 | 梨园整体架构（v1.2.0）：五层结构、分域职责、数据流、数据目录、外部依赖、关键决策 |
| [PLAN-ROUND-FLOW.md](PLAN-ROUND-FLOW.md) | 293 | 分轮演出流程**最终形态**（2026-08-08 定稿）：规划轮→演段轮→收尾轮、ask 接入、提示词四层结构、落地记录 P1–P14 |
| [PRESET-SPLIT-TAXONOMY.md](PRESET-SPLIT-TAXONOMY.md) | 182 | 预设拆层类型学：九种性质（A–I）→ 五个去向，三份预设逐块拆层表与量化结论 |
| [READING-THINKING.md](READING-THINKING.md) | 79 | 读思考记录的**唯一正确方法**（会话文件定位、拍/swipe 区分、rpTimeline 字段） |
| [DEV-extend.md](DEV-extend.md) | 187 | 开发者扩展技术路径（REST/MCP/技能/程序卡，纯配置→扩展文件→改源码分级） |
| [jsrunner-port.md](jsrunner-port.md) | 306 | JS Runner（TavernHelper）移植文档（M5 兼容性审计基线 + G1–G12 缺口全表）⚠ 部分内容与代码不符，见 §4 |

### 二、功能设计（8 份，均已实现并与代码吻合）

| 文档 | 行数 | 一句话主题 |
|---|---|---|
| [DESIGN-flow-config.md](DESIGN-flow-config.md) | 113 | 流程配置外置：轮次卡模板 / 预设拆层表 / 回合意图正则 → 数据文件 + liyuan.config.json 覆盖段（2026-08-13） |
| [DESIGN-draw.md](DESIGN-draw.md) | 474 | 生图系统分层设计（底座 + 四插件），一期二期实施完成，§8 实施对账 |
| [DESIGN-websearch.md](DESIGN-websearch.md) | 201 | 内置网络搜索 MCP（SearXNG 默认 / tavily 可插拔），已实现（2026-08-10） |
| [DESIGN-debug-trace.md](DESIGN-debug-trace.md) | 53 | 主聊天跟踪（开发者模式）：JSONL 全过程记录（提示词/思考/工具/草稿/旁路/定稿）、REST 列表下载、事件 schema（2026-08-11） |
| [DESIGN-semantic-review.md](DESIGN-semantic-review.md) | 96 | 语义评审维度化：封笔后旁路模型评审设定/人物/文风一致性，major 问题并入修复门禁（NeuroBook 借鉴，2026-08-14） |
| [DESIGN-tool-staging.md](DESIGN-tool-staging.md) | 137 | DSH 式双阶段工具暴露（deepseek-v4-pro）：剧情侧/助手侧 Minimal 起步，首次工具调用后放开全量（参照 dsh-anchored-standard，2026-08-15） |
| [DESIGN-story-edit.md](DESIGN-story-edit.md) | 126 | story_edit 助手改稿工具：红线改写、rp-edited 分支、改稿后重记账、UI 标记 |
| [DESIGN-custom-agents.md](DESIGN-custom-agents.md) | 124 | 自定义 agent：createAgentHost 工厂、桥权限模型、wire agentId（§8 P0–P5 未标完成，实际已实现） |
| [DESIGN-jsrunner-ledger.md](DESIGN-jsrunner-ledger.md) | 656 | JS Runner 账本 UI 的 D3 设计：需求裁决 R1–R5、协议规格、P0–P4、§11 断链表（6 项全标断） |
| [DESIGN-jsrunner-ledger-ui.md](DESIGN-jsrunner-ledger-ui.md) | 993 | 账本 UI 的 D4 实现级详细设计：PART 1 = V1、PART 2 = V2（六项已全部落地，V2-7 有实测结论） |

### 三、RP agent 化规划系列（5 份，大部分已实施、内含遗留事项）

| 文档 | 行数 | 一句话主题 | 实施状态 |
|---|---|---|---|
| [PLAN-RP-AGENT.md](PLAN-RP-AGENT.md) | 139 | RP agent 化设计契约（tools 层 + harness 层） | M-A/M-B/M-C 已完成（§6 待办 checkbox 未更新，过时，见 §4） |
| [PLAN-RP-AGENT-EXEC.md](PLAN-RP-AGENT-EXEC.md) | 442 | 「立骨架」执行计划 M-A~M-D + 实弹数据 | 主体完成；§7 待办含未完成项，见 §2 |
| [PLAN-RP-HARNESS.md](PLAN-RP-HARNESS.md) | 295 | Harness 重建计划：R1–R9 决策、M0–M5 里程碑、提速实测 | M0–M4 完成；M4.5 提速验收未达成、M5 未做，见 §2 |
| [PLAN-RP-TOOLING.md](PLAN-RP-TOOLING.md) | 299 | 全盘工具化（M-D）契约：三套工具注册表合一 | M-D1/2/3/6 ✅；M-D4/M-D5 未完成，见 §2 |
| [PLAN-RP-TOOLS-PROPOSAL.md](PLAN-RP-TOOLS-PROPOSAL.md) | 345 | M-B 工具清单提案（draft_edit/read/search 等）+ §8 实弹后修订 | 已实施，部分结论被数据推翻（见文末 §8） |

### 四、待办 / 草稿（3 份）

| 文档 | 行数 | 一句话主题 |
|---|---|---|
| [WAIT_TO_CODE.md](WAIT_TO_CODE.md) | 100 | **唯一纯待办清单**（生图/设置/助手/管理/工具/ST 导入/测试工程）；未勾选项见 §2-A |
| [DRAFT-prompt-rp-agent.md](DRAFT-prompt-rp-agent.md) | 99 | 「怎么演这一拍」提示词草稿（好/坏节奏对照）；头注「未落进 assemble.ts」已过时，见 §4 |
| [st-ux-inventory.md](st-ux-inventory.md) | 49 | SillyTavern 界面行为清单草稿（设计输入素材），待用户以重度玩家身份逐条补正 |

### 五、历史快照（14 份，原地保留，供回溯）

| 文档 | 行数 | 一句话主题 |
|---|---|---|
| [RELEASE-NOTES.md](RELEASE-NOTES.md) | 117 | v1.0.0 发布说明正文（下载表/上手/功能清单/ST 搬家对照） |
| [RELEASE-v1.0.1.md](RELEASE-v1.0.1.md)｜[v1.0.2](RELEASE-v1.0.2.md)｜[v1.0.3](RELEASE-v1.0.3.md)｜[v1.0.4](RELEASE-v1.0.4.md)｜[v1.1.0](RELEASE-v1.1.0.md)｜[v1.1.1](RELEASE-v1.1.1.md)｜[v1.1.2](RELEASE-v1.1.2.md)｜[v1.2.0](RELEASE-v1.2.0.md)｜[v1.2.1](RELEASE-v1.2.1.md)｜[v1.3.0](RELEASE-v1.3.0.md) | 28–58 ×10 | 各版本发布说明（v1.0.1 连接配置补丁 → v1.3.0 轮次输出引擎/ask 回归） |
| [REVIEW-ROUND-FLOW-0809.md](REVIEW-ROUND-FLOW-0809.md) | 77 | 分轮演出全链走查快照：6 处实现级问题当场修复（571 绿）+ 4 项设计取舍待拍板 |
| [TESTING-DRAW.md](TESTING-DRAW.md) | 69 | 生图一期验收手测清单（已知边界含 2 个既有失败测试与本功能无关） |

### 六、superpowers/ 子目录（2 份，历史快照）

| 文档 | 行数 | 一句话主题 |
|---|---|---|
| [superpowers/specs/2026-07-22-card-frontend-design.md](superpowers/specs/2026-07-22-card-frontend-design.md) | 133 | 角色卡前端兼容设计（三档分类、垫片 API 三族策略、P0–P3 分期；状态：草案待评审） |
| [superpowers/plans/2026-07-22-card-frontend-p0p1.md](superpowers/plans/2026-07-22-card-frontend-p0p1.md) | 949 | 卡前端 P0+P1（v1.0.5）实现计划：8 个 Task（cardfront→cardSkin→htmlEmbed→HtmlFrame→Messages→REST→App→验收） |

> 另：仓库根目录 `TESTING.md` 是内测说明（反馈模板、已知边界），不引用 docs/；`plan_doc/` 是功能规划记录（3 份：custom-tables-compliance、db-statusbar-codex、jsrunner-ledger），按 AGENTS.md 约定其「待办」节条目**未经用户点名不得实现**，汇总见 §2-E。

---

## §2 待办与遗留事项汇总

> 以下从各文档**原样摘录**（出处 = 文档 §节），不遗漏、不评判优先级。已完成项（如 web search）也在括号注明。

### A. WAIT_TO_CODE.md（唯一纯待办清单）未勾选项

**生图功能**
- 待验证场景：场景 3 AI 微调（悬停插图→操作条→AI 微调，新版本生成、画廊版本数 +1）；场景 4 版本历史切换（画廊旧版本缩略图切换）；场景 5 待学习角色（自动学习闭环：新角色进候选→确认学习→入服装档案）；场景 6 标签组（新建/启用/关掉、导出/导入）；场景 7 在线标签库（更新 HuggingFace CSV、标签搜索更全）
- 界面微调：图片嵌入界面右上角文字太丑；鼠标要悬浮到图片上才显示操作类型（注：2026-08-10 提交 84caef2 已改为悬浮到操作条实际位置才显示，见 git log）；左右切换时图片加载瞬间聊天抖动扭曲；角色管理界面功能不完备
- 其他需求：无未勾项（角色迁移已勾）

**设置功能**：设置字体大小；设置主体文本宽度；隐藏用户输入楼层；隐藏用户输入框；支持 Quick Input 按钮（跟随输入框位置快速输入预制内容）
（注：界面自定义「页面宽度 640–1400px / 字体比例 90–120%」已于 2026-08-10 实现，见提交 a18a008 与 `web/src/ui-custom.ts`，与此处两项有重合但未勾选）

**助手功能增强**：支持删除最后一层；最后一层是 AI 回复时支持重生成；最后一层是用户回复时支持继续生成 + 修改；支持直接 clear 当前会话内容（指向支持/指令）；支持任务派发（真正的 sub agent 能力）

**管理能力增强**：导入导出能力；skill 支持范围

**工具能力增强**：web search 原生支持（✅ 已实现 2026-08-10，见 DESIGN-websearch.md，清单未勾选）；工具管理

**表格管理能力**：无未勾项（「表格更新太弱」已勾）

**ST 原始导入**：原始导入的输入框不小心点到其他地方会关闭；无效 image:slot 清理（考虑新增一个 custom_tools 放清洗脚本）；导入界面不符合预期（当前仅有进度条，预期为含「正在回放第 360/800 层 · 已合并记账 12 次」文字与停止回放按钮的进度界面，ASCII 示意图见原文）

**测试工程**：web 有没有业界开源的测试工程能力？需要探索，最好部署下来

### B. 待用户拍板 / 明确不做先记录（4 组）

**REVIEW-ROUND-FLOW-0809 §3 四项待拍板（未动）**
1. 状态栏提醒的层数：现四层，「时有时无」伤口上宁多勿少，但对提示词膨胀敏感可砍注入块层（程序化谢幕是真正保底）
2. P6 draft_write 门禁扩判据（PLAN §10 遗留）：现只按 lookups>0 拦；纯情感戏/纯场景戏（不查库）仍可一次交完。提案：查过库 **或** 计划≥2 条即拦
3. ask 落树留痕（PLAN §10 遗留）：台上 ask 走 live 选择卡，重放不还原已决卡（`wire.ts` choiceOfToolResult 只认旧 ask_director 名）
4. sov 主权检查第一人称盲区：`checkSovereignty` 主语集只有 `userName|你`——用户第一人称视角卡（正文以「我」=用户自称）代言漏检；加「我」需卡级视角判定，误伤面大，需设计

**REVIEW-ROUND-FLOW-0809 §5 实弹未跑**（改动需重启服务实测，建议先跑「婉儿开始润墨」同输入 2–3 个 swipe，核对四点）：① 修复后该段原地变新不重复；② 状态栏每拍必出、只出一次、恒在最后；③ 收笔前涉及用户行动时 ask 触发（试墨应问不应演）；④ 刷新后重放分段与流式一致
（§4 另有「遗留观察项（无需动作）」4 条：修复卡 sealed 措辞略不合、演段回看卡思考量稳定性 n 尚小、stream:clear 仅传统 agent 路径触发、连勾多步不拦——无需动作，原文保留）

**PLAN-ROUND-FLOW §10 未做（需用户拍板）**：P6 draft_write 门禁扩判据（同上 B-2）；ask 结果落树留痕（同上 B-3）

**PLAN-RP-HARNESS §6**：packages/ai dist 停在 7/18（tsgo 缺失无法重建）——引擎所需 stream()/completeSimple 已在 dist 可用，但**流式开关通用化仍是运行时死代码，发版前必须重建 dist**（独立事项）

### C. 未实施里程碑 / 功能（来自规划系列）

**PLAN-RP-AGENT-EXEC §7 待办总览**
- M-D（全盘工具化）：契约见 PLAN-RP-TOOLING.md（其子项 M-D1/2/3 已完成，见下）
- 路由破口（M-D1 发现）：`/reroll <带参>` 绕过宿主拦截落 pi 会话，跑无台上装配的裸 LLM 回合；前端「编辑用户消息」即走此路（`web/src/App.tsx:1180`）；用户定案归入 M-D6 统一修复——**需复核**：PLAN-RP-TOOLING §3 已标 M-D6 ✅，此条可能已修复
- M-B 顺延项：wire 替换帧 + 展示块渲染管道（D-C3 欠账）——末尾整稿重发仍在（重复上屏已从 2.9x/4.0x 降到约 2.0x）
- 状态栏根治法（模型退出格式博弈）：2026-08-05 定案「先记录不做，下个窗口开工」（三处改动：harness 定稿自动补占位符 / 提示词删「必须输出状态栏」/ 验收器不再验占位符型状态栏）；已修的保底（mergeFinalText 拼回格式尾巴、tailPass 门控，511 绿）让当前形态可用但不是终点
- M-C2 可选：LLM 离线拆层（任意社区预设通解，TAXONOMY §4.1 v1）+ 预设页签去向改判 UI
- ③ 首拍多样本复验**未完成**（上游 500 频发，实得首拍 n=1）；§4.5.5：非首拍 2400 亦因分母小（n=5）且样本跨 500 故障期，暂记不结论
- §4.2 顺手核实 {{random}} 宏是否会话内钉死（TAXONOMY §4.5）——注：PLAN-ROUND-FLOW P13 已确认钉死

**PLAN-RP-HARNESS**
- M4.5 提速（🔶 部分完成 2026-08-03）：句级过滤验算指令 + 给排练断粮已接线，但**实测墙钟无显著改善，验收未达成**，慢因 A 的物理形态待议
- M5 收边（未完成）：命令迁移、ask 档求方向、预设分层产品化（慢因 B 根治）、媒体标记方案、扩展瘦身、README
- §7 待建 ⏳：2 预设页签（性质视图 + 每块分类 reason + 手动改判按块指纹持久化）；3 导入报告（「67 块 18188 字 → 写作阶段实际入场 16155 字」让用户看见预算去哪）；4 装配接线（噪声块不入场，最后做）
- §6 未修：DSML 工具调用偶发泄漏成正文（8/03 发现，high 档实弹出现一次；独立缺陷，不混进里程碑）

**PLAN-RP-TOOLING**：M-D4（角色库+人格）、M-D5（世界线+面板台上化）未完成；§7.2 残存第二叙事路径 `/reroll <带参>`（同 EXEC 路由破口）；M-D3 实弹「拍 3（召回）未取得」，召回能力待上游稳定后补验

**PLAN-RP-TOOLS-PROPOSAL §8.4**：跨拍留存已裁决事项「未展开，留待后续讨论」

### D. 已知缺口 / 断链（来自 jsrunner 与生图设计）

**jsrunner-port.md §5 G1–G12 缺口全表**（审计对象：ST 6 个顶层脚本）：
- G1（高）：`window.SillyTavern` 全局未注入——shujuku_index 196 处、状态栏V2.67 45 处走 fallback，extensionSettings/saveSettings/getRequestHeaders/powerUserSettings 全读空。补法：bridge 注入白名单桩
- G2（高）：`generateRaw` 参数子集——`ordered_prompts`（system 指令）与 `custom_api`（指定模型通道）被丢弃，天赋树/立绘/大采访指令上下文丢失。补法：pickSamplingParams 扩展
- G3（高）：脚本带参触发通道（args）未实现——命令式脚本无法被调用（shujuku_index 的 `args[N]` 22 处）。补法：运行时「触发脚本函数(args)」invoke 通道 + 面板命令入口
- G4（高）：ST 专属 DOM（parent.document）——输入栏折叠直接 return 全失效；状态栏渲染到隐藏 iframe 无意义。**无通用补法**：需脚本改造走宿主面板/卡片通道
- G5（中–高）：getContext() 字段白名单不全（chatId/groupId/extensionSettings/powerUserSettings/chat_metadata 恒 {}）
- G6（中）：tavern_events 常量表未注入——守卫使监听静默跳过（注：已部分修复，§4）
- G7（中）：TavernHelper.generate monkey-patch 覆写失效——Proxy 无 set trap，「剧情规划/去重锁」钩子静默不生效
- G8（中）：getCharData('current') 参数语义 + 返回字段过窄（无 avatar/tags/creator）
- G9（低–中）：window.power_user / characters / this_chid 未注入
- G10（低）：toastr 桩仅 console 日志（注：已改发宿主 toast，§4）
- G11（无）：setMessage/deleteMessage 两脚本均未实际调用（已实现但无真实使用点）
- G12（无）：YAML./z. 零使用

**DESIGN-jsrunner-ledger.md §11 前置依赖与已知断链**（6 项全标「断」）：
1. `JsRunnerPanel` 未挂载 → P0 挂载到 PowersPanel（注：已挂载，见 DESIGN-jsrunner-ledger-ui.md 与 `web/src/jsrunner/ui/`）
2. extdata 1MB 双重上限 → P0 拆文件存储 §3.3
3. `setScriptMeta` 未接线 → getScriptName 恒空，P2 接线
4. `generate/generateRaw` 无 handler → 面板内 LLM 生成挂起（独立项 §5.10）
5. `mapPiEventsToSt` 未接线 → ST 风格服务端事件（本设计不依赖：前端投影；另行处理——注：至今未接线，实际一直是前端投影 `web/src/jsrunner/events.ts:28-46`）
6. `POST /api/script/message` 无路由 → setMessage 404（不影响账本面板，标注已知限制——**至今未补**：`web/src/jsrunner/helper.ts:311,320` 仍在调用）

**DESIGN-jsrunner-ledger-ui.md**：§5 错误矩阵「删除文件清理失败 → 记日志不阻塞删除，孤儿文件可手动清理（V2 提供清理入口？TODO）」

**生图侧预留**：ARCHITECTURE §6.5 与 DESIGN-draw：SD WebUI 🔶 预留、ComfyUI 🔶 预留（仅类型与配置 schema）；DESIGN-websearch §9：web_fetch 工具二期按需、SearXNG 供其他功能复用；DESIGN-draw §6/WAIT_TO_CODE：二期 AI 微调、自动学习闭环等见 §2-A

**DESIGN-story-edit §9 已知风险**：模型通道（main.ts 侧旁路模型调用通道 §4.1 路径乙）需现场确认，无则经 restHost 补——**需复核**：story_edit 已实现（§3 对应表），此遗留大概率已消解

**PRESET-SPLIT-TAXONOMY §4.5**：破限 {{random}} 与前缀缓存遗留问题（不在 M-C 修）；PLAN-ROUND-FLOW P13 已确认会话内钉死（记录确认，修复后置）

### E. plan_doc/ 三份规划记录（按 AGENTS.md：待办未经用户点名不得实现）

- `plan_doc/custom-tables-compliance.md`：自定义表格填表遵从度优化，阶段 A–E 自述全部完成；待办仅引擎级 clear/upsert 语义等未点名项
- `plan_doc/db-statusbar-codex.md`：DB 路线实施记录（codex 工具族 6 工具、choice 卡、CodexPanel、状态栏预设），自述已实施完成、无待办
- `plan_doc/jsrunner-ledger.md`：账本 UI 定制计划（裁决 1–21、V1 6b902ff、V2 六项 475e38f），V2-7 性能实测达标

---

## §3 文档 ↔ 代码对应表

| 文档 | 对应代码（实现位置） |
|---|---|
| FLOW-MAP.md | `src/stage/engine.ts`（#turn/#agentLoop/roundCardFor）、`src/stage/materials.ts`（loadStageMaterials）、`src/stage/assemble.ts`（system 分节/注入块）、`src/draft.ts`（extractDraftRules/checkDraft）、`src/stage/workspace.ts`（验收消费） |
| DESIGN-flow-config.md | `assets/flow/round-cards.json`、`assets/flow/split-tables.json`、`src/flow-templates.ts`、`src/preset-split.ts`（normalizeSplitTable/loadBuiltinSplitTables/resolveSplitTables）、`src/turn-intent.ts`（createIntentClassifier）、`src/types.ts`（flowTemplates/splitTables/intentRegex 段）、`src/stage/engine.ts`（roundCardFor 模板化）、`src/stage/materials.ts`（加载合并）、`liyuan.config.json` 三段 |
| ARCHITECTURE.md | 全仓库（分层总览，无单一实现） |
| PLAN-ROUND-FLOW.md | `src/stage/engine.ts:426`（StageEngine）、`:955`（#agentLoop）、`:1006`（round 循环）、`:286-345`（roundCardFor 注入卡）、`:1127-1210`（同轮连发门禁）；`src/stage/assemble.ts:349`（# 怎么演这一拍）；`src/stage/workspace.ts`、`src/stage/tools.ts`（beat_plan 等写侧五件）；`src/preset-macro.ts` |
| PRESET-SPLIT-TAXONOMY.md | `src/preset-split.ts`（九性质五去向）、`src/preset-classify.ts`（四类兜底）、`src/preset-macro.ts`（宏求值） |
| READING-THINKING.md | 无代码（会话文件 `~/.liyuan/agent/sessions/` 的阅读方法） |
| DEV-extend.md | `server/rest.ts`、`src/mcp.ts`、`.liyuan/extensions/roleplay.ts`（applyRpToolset）、`web/src/jsrunner/helper.ts` 等 |
| jsrunner-port.md | `web/src/jsrunner/`（runtime/helper/context/bridge/bus/log/plan/frame/ui 13 模块）、`src/extdata.ts`、`server/script-events.ts`（⚠ 未接线） |
| DESIGN-draw.md | `src/draw/`（config/novelai/sd-webui/comfyui/params/queue/errors/service）、`src/draw-plugins/`（draw-role/draw-pipeline/draw-slot/draw-edit）、`server/assistant.ts:349-350,782,877`（draw_generate/enhance）、`server/rest.ts:4688-4931`（slot REST 全套）、`src/stage/assemble.ts:55,60`（stripDrawPlaceholders）、`[image:slotId]` 占位符 `src/draw-plugins/draw-slot/index.ts:21` |
| DESIGN-websearch.md | `server/mcp/websearch-server.mjs`（searxng/tavily 双后端）、`src/mcp.ts:280-339`（BUILTIN_WEBSEARCH_ID、env 键、默认 enabled:false）、`scripts/drive-websearch.mjs` |
| DESIGN-debug-trace.md | `src/stage/trace.ts`（TraceRecorder）、`src/stage/engine.ts`（#turn/#agentLoop/#sideText 采集）、`server/main.ts`（recorder 注入）、`server/rest.ts`（/api/trace/list + /api/trace/download）、`web/src/api.ts`（getTraceFiles/downloadTraceFile）、`web/src/components/SettingsPanel.tsx`（开发者模式分区）、`test/trace.test.ts` |
| DESIGN-tool-staging.md | `src/tool-staging.ts`（STAGED_MODELS/minimalStageTools/historyHasToolCall/stagedToolNames）、`src/stage/engine.ts`（stagedTools 装配、agentLoop 晋升、rp-tool-staged 落树）、`server/assistant.ts`（applyToolStaging ×3：build 后/prompt 前/subscribe）、`test/tool-staging.test.ts` |
| DESIGN-semantic-review.md | `src/stage/review.ts`（buildReviewPrompt/parseReviewResult/formatReviewViolation/reviewEvidenceOf）、`src/stage/workspace.ts`（runReviewOnce、seal 自动评审、runCheck 评审项继承与证据过滤）、`src/stage/tools.ts`（draft_review）、`src/stage/engine.ts`（评审闭包装配）、`src/types.ts`（semanticReview 段）、`server/rest.ts`（白名单/归一化）、`test/review.test.ts`、`test/stage-engine.test.ts`（评审集成） |
| DESIGN-story-edit.md | `server/main.ts:2199-2252`（StoryBridge.storyEdit：rp-edited-reply 分支）、`server/assistant.ts:557-590`（story_edit 工具，confirm 门禁）、`server/wire.ts:632-640`（rp-edited-reply→edited:true）、`src/stage/compact.ts:75-90`（branchHistory 压缩）、`web/src/components/Messages.tsx:817-818`（「已改写」徽标）、`src/story-sync.ts`、`src/extdata.ts` |
| DESIGN-custom-agents.md | `server/assistant.ts:1467`（createAgentHost）、`src/assistant-gateway.ts:49-110`（runner 网关注册表）、`server/rest.ts:499,727-760,875`（agents 配置/权限/可编辑）、`server/wire.ts:292,347-353`（assistant_* 帧 agentId）、`liyuan.config.json` agents 段（示例：director） |
| DESIGN-jsrunner-ledger.md / -ui.md | `src/state.ts:34`（saveState，账本落 `.liyuan-state/<sessionId>.json`）、`.liyuan/extensions/roleplay.ts:393-395,1720`、`web/src/jsrunner/ledger.ts:138-162`（面板 registry）、`web/src/components/StatusStrip.tsx:320`、`RosterPanel.tsx:89`、`web/src/App.tsx:1979,2151`（区域扩展）、`ui/JsRunnerPanel.tsx`（zip 导入导出）、`runtime.ts:229,312-318`（sandbox 加固）、`test/jsrunner-baseline.test.ts` |
| PLAN-RP-AGENT.md | `src/stage/tools.ts`（stageTools）、`src/preset-classify.ts`、`src/stage/engine.ts` |
| PLAN-RP-AGENT-EXEC.md | `src/draft.ts`（checkDraft/checkSovereignty/formatDraftReport/extractDraftRules/locateEdit/applyDraftEdits/searchDraft/resolveDraftEditText）、`src/stage/*`、`src/tools/adapters/stage.ts`、`server/tool-adapter.ts` |
| PLAN-RP-HARNESS.md | `src/stage/`（assemble/engine/revise/scribe-run/materials）、`src/scribe.ts`、`src/retention.ts`、`src/stance.ts`（注：场外发言检测，非旁挂模型） |
| PLAN-RP-TOOLING.md | `src/tools/`（registry/lore/memory/card/worldline/draft/gate）、`src/tools/adapters/{stage,assistant,extension}.ts`、`server/tool-adapter.ts` |
| PLAN-RP-TOOLS-PROPOSAL.md | `src/stage/tools.ts`、`src/draft.ts:202,465,518`、`src/stage/workspace.ts`、`server/wire.ts:257` |
| DRAFT-prompt-rp-agent.md | `src/stage/assemble.ts:349`（落地改写版）、`src/stage/tools.ts:158`（draft_write 描述已按配套①改） |
| WAIT_TO_CODE.md | 各项见 §2-A（部分已完成未勾选） |
| st-ux-inventory.md | 无代码（UI 行为设计输入素材） |
| 历史快照/RELEASE-* | 对应各版本的发布时代码基线，无当前实现对应 |
| superpowers/ 两份 | `src/cardfront.ts`、`web/src/cardSkin.ts`、`web/src/htmlEmbed.ts`、`web/src/frameDoc.ts`、`web/src/components/HtmlFrame.tsx`、`Messages.tsx`、`server/rest.ts:1465` 附近、`src/types.ts`（RpConfig.cardSkinOff）、`test/cardfront.test.ts` 等 |

---

## §4 过时 / 不一致标注清单（与当前代码核对的差异）

| 位置 | 问题 | 代码现状 |
|---|---|---|
| docs/jsrunner-port.md 全文 | 声称服务端事件桥已接线：`server/main.ts` 每事件调 mapPiEventsToSt → 广播 `ext_event` 帧 | **未接线**：`server/` 下 `mapPiEventsToSt` 零调用、`ext_event` 仅 `wire.ts:308` 类型与 `script-events.ts:5` 注释；实际改前端投影 `web/src/jsrunner/events.ts:28-46`（state→WORLD_STATE_CHANGED、message 非 user→MESSAGE_RECEIVED、agent end→GENERATION_ENDED） |
| docs/jsrunner-port.md §3.2/§4.1 | 声称 `setMessage/deleteMessage` 走 `POST /api/script/message` | **路由不存在**：`server/rest.ts` 无此 case；`web/src/jsrunner/helper.ts:311,320` 仍调用（会 404）。DESIGN-jsrunner-ledger.md §11 断链表如实标注此断链 |
| docs/jsrunner-port.md §5 | G 清单部分项已修复但未更新 | G2（custom_api 前端直连 `helper.ts:171`）、G6（tavern_events 常量表）、G10（toastr→notify）已修复 |
| docs/DRAFT-prompt-rp-agent.md 头注 | 「状态：待用户逐句过目，未落进 `src/stage/assemble.ts`」 | **已落地**：`src/stage/assemble.ts:349` 起即「# 怎么演这一拍」改写版（落地时经改写，非逐字）；配套① `src/stage/tools.ts:158-164` draft_write 描述已改（「只用于这一拍没有戏的时候」）；配套② harness 门禁已实现（rehearsalGuard 默认开） |
| README.md:129 | 「搜索后端可插拔（…预留 tavily）」「tavily 填 key 即可，预留中」 | **tavily 已实现**：`server/mcp/websearch-server.mjs:7-31`（LIYUAN_WEBSEARCH_TAVILY_API_KEY 等） |
| docs/DESIGN-custom-agents.md §8 | P0–P5 实施顺序表未标完成 | 实际已全部实现（见 §3 对应表） |
| docs/PLAN-RP-AGENT.md §6 | 待办 6 条 checkbox 全未勾 | M-A/M-B/M-C 已完成（后续文档 PLAN-RP-AGENT-EXEC/TOOLING 有实弹记录），此清单未更新 |
| docs/WAIT_TO_CODE.md | 「web search 原生支持」[ ] 未勾 | 已实现 2026-08-10（DESIGN-websearch.md）；「设置字体大小/主体文本宽度」与 ui-custom（a18a008）重合未勾选；「图片嵌入操作条」84caef2 已改实现方式 |
| docs/TESTING-DRAW.md 已知边界 | 「手动『为这条消息配图』前端按钮是二期项」 | 已补上（manualPipelineRun，DESIGN-draw §8 对账项 6） |
| docs/DESIGN-story-edit.md §9 | 「模型通道需现场确认」 | story_edit 已实现（§3），此遗留大概率已消解，**需复核** |
| docs/PLAN-RP-AGENT-EXEC.md §7 | 「路由破口…归入 M-D6 统一修复（中途不顺手改）」 | PLAN-RP-TOOLING §3 已标 M-D6 ✅，此条可能已修复，**需复核** |

**命名注意**（易误读）：
- `src/stage/` 是**扁平 .ts 文件**（assemble.ts / engine.ts / workspace.ts / tools.ts …），不是文档中「assemble/engine/workspace/tools 子目录」——文档所述模块均存在，只是文件级而非目录级
- `src/stance.ts` 是**场外发言检测**（`//`、`(())` 标记），不是旁挂模型/破甲——旁挂模型在 `server/main.ts:2629,2678-2700` + `liyuan.config.json` sideJailbreak
- `src/agent-config.ts` 是 `liyuan.agent.json`（连接/渠道/模型配置），不是 `liyuan.config.json` 的 agents 段
- `web/src/timeline.ts` 是回合时间线（TurnSegment），不是窗口化渲染——窗口化在 `web/src/App.tsx:284` 起

---

## §5 引用关系

**仓库入口引用 docs/ 的位置**：
- `AGENTS.md`：README 相关（本文档）；ARCHITECTURE.md、READING-THINKING.md、PLAN-ROUND-FLOW.md、PRESET-SPLIT-TAXONOMY.md、PLAN-RP-AGENT-EXEC.md、DRAFT-prompt-rp-agent.md、DESIGN-custom-agents.md、DESIGN-story-edit.md、RELEASE-vX.Y.Z.md
- `README.md`：docs/images/home.png（:5）、docs/DESIGN-websearch.md（:129）
- `TESTING.md`：无 docs/ 引用

**文档间互引**：
- DESIGN-jsrunner-ledger-ui.md ← 基线 DESIGN-jsrunner-ledger.md（D3）
- DESIGN-custom-agents.md ← 前置 DESIGN-story-edit.md（复用其桥接缝）
- DESIGN-draw.md ← 关联 RELEASE-v1.1.2.md、RELEASE-v1.2.0.md、DEV-extend.md
- DESIGN-websearch.md ← 对应待办 WAIT_TO_CODE.md
- TESTING-DRAW.md ← 配套 DESIGN-draw.md
- PLAN-RP-AGENT-EXEC.md ← 上游契约 PLAN-RP-AGENT.md；类型学 PRESET-SPLIT-TAXONOMY.md；契约 PLAN-RP-TOOLING.md；PLAN-RP-TOOLS-PROPOSAL §8 修订关联
- PLAN-RP-TOOLING.md ← 承接 EXEC §5
- PLAN-RP-TOOLS-PROPOSAL.md ← 上游 PLAN-RP-AGENT.md、EXEC §3；实施记录在 EXEC §4.5
- PLAN-RP-AGENT.md ← 前置 PLAN-RP-HARNESS.md
- PLAN-RP-HARNESS.md ← 实证文件 `_preset-taxonomy.md`（已被 TAXONOMY 声明作废——基于残缺魔改版）
- PRESET-SPLIT-TAXONOMY.md ← 对 EXEC §4 的修订
- REVIEW-ROUND-FLOW-0809.md ← 对照 PLAN-ROUND-FLOW.md 定案
- superpowers/plans/2026-07-22-card-frontend-p0p1.md ← 规格来源 superpowers/specs/2026-07-22-card-frontend-design.md
- st-ux-inventory.md ← 引用 PLAN-PHASE3 §6（该文档不在 docs/ 中，历史遗留）
- RELEASE-v1.0.3/v1.0.4 ← 引用 RELEASE.txt（发布包内）
