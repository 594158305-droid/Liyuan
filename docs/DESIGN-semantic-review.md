# 语义评审维度化（DESIGN-semantic-review）

> 2026-08-14 落地。补主聊天验收的「人格/文风一致性程序层零兜底」盲区——借鉴 NeuroBook（J:\AITools\neuro-book）的评审 agent 机制（outputSchema 强校验 + 问题必须引正文证据 + 改法必须可直接执行），封笔后由旁路模型做一次独立语义评审，major 问题并入现有修复门禁。

## §1 动机与目标

机械验收（`checkDraft`，`src/draft.ts`）只判字面规则：字数、禁词、破折号/半角、比喻频率、「不是…是…」句式、markdown 标题、主权红线（代写对白/内心/决定）——**人格与文风一致性不在检查项内**。预设人格靠 A/B/C 三节常驻提示词约束，漂移与否程序层零兜底（想管也管不了：一致性判定不是正则能写死的）。

语义评审补的就是这一维：封笔后由**旁路模型**（主演对话外的单轮调用，非自我评审，与场记/压缩摘要同构）读「人设与文风基准 + 世界状态 + 现稿」，按三维出问题清单：

- **设定一致性**：与基准设定/世界状态冲突（吃设定：地点、时间、物品归属、人物关系记错）；
- **人物一致性**：行为、语气、性格与角色设定不符（崩人设），对白不符合该角色的说话方式；
- **文风与 AI 味**：明显 AI 腔（空洞抒情、排比堆砌、机械对称、脸谱化心理描写、过度比喻），或与预设文风要求相悖。

## §2 与现有验收的关系（离 PLAN-ROUND-FLOW 多近）

PLAN-ROUND-FLOW §2 的定位：**验收 = 机器**（字数、禁词、格式、主权程序化判定）。语义评审让「机器」多了一维**语义验收**——但执行者从「代码」升级为「旁路模型」。二者关系：

| | 机械验收（checkDraft） | 语义评审（review） |
|---|---|---|
| 执行者 | 代码，同步，零成本 | 旁路模型，异步，一次调用 |
| 时机 | 收稿/收段/封笔/改稿即验 | 封笔时（有戏的一拍）+ 显式 `draft_review` 复验 |
| 检查项 | 9 类机械纪律 + 主权红线 | 设定一致性/人物一致性/文风与 AI 味 |
| 问题格式 | 违规字符串（附引文） | 结构化 JSON：维度 + severity + **证据引文** + **可执行改法** |
| 门禁 | 未修拦 append/done/seal | 并入同一 pendingViolations（带 `[评审·维度]` 前缀），同一修复卡/安全阀 |
| 修复感知 | 复验即消 | **证据引文不在现稿中** = 视为已修（draft_edit 定点改动了该处） |

设计取舍：语义评审定位是**软约束**——major 只拦崩人设/吃设定/明显 AI 味这类大问题，minor 只提示不拦；「修了但没真修好」（机械复验不覆盖语义）属已知边界，接受（评审本来就是提示性兜底，不是硬保证）。

## §3 触发与流程

1. **自动触发**：`draft_seal` 封笔且 `ws.appends > 0`（draft_append 分段演出的拍）——寒暄一次交完（appends=0）不烧调用。
2. 机械验收照常先跑（不绿照样报）；评审 major 问题 push 进 `ws.pendingViolations`（带 `[评审·维度]` 前缀），与机械违规**一起拦推进、一次修完**。
3. 评审报告追加在 seal 的 toolResult 里（`【语义评审】…` 段落）；模型下一轮收到 → 【修复】卡（roundCardFor 已有判定：pendingViolations 非空即 fix 卡）。
4. 修复仍走 `draft_edit` 定点改 → 自动复验 → `runCheck` 里按「证据引文不在现稿中」过滤评审项 → 全消即放行。
5. 误报兜底：复用 3 轮安全阀（stuckFixes ≥ 2 → bailedFixKey 放行）。
6. 显式复验：`draft_review` 工具（对偶 draft_check），未封笔也能手动触发。

## §4 配置

`liyuan.config.json` 新段 `semanticReview`（PUT /api/config 白名单内，rest.ts 归一化）：

```json
{ "semanticReview": { "enabled": true, "gate": "major" } }
```

| 字段 | 缺省 | 语义 |
|---|---|---|
| `enabled` | `true` | 总开关。封笔后旁路评审是否自动跑（每次封笔多一次模型调用；成本敏感可关） |
| `gate` | `"major"` | 拦推进的门槛：`"major"` 只拦 major；`"all"` 全拦（minor 也拦） |

**评审用的模型**：台上旁路（语义评审/场记/压缩摘要）统一走 `sideModel`（`liyuan.config.json` 的旁挂模型段，2026-08-14 接上台）——配置了 `sideModel` 且 `modelRegistry` 找得到就用它，找不到/未配置回退剧情模型（session.model，连接面板选的那个）。解析在 server 侧（`server/main.ts` StageEngine 构造的 `getSideModel`，与 `backfillSideText` 同款），engine 只消费注入。改配置即时生效（每拍解析一次）。

**旁挂模型与主模型不必同渠道**：`/api/models` 新增 `allModels`（全量 + `ready` 标记），设置面板「旁挂模型」下拉按渠道分组展示——未配 key 的渠道置灰标注「未配 key」（选不了但看得见原因）；给目标渠道配 key（连接面板渠道生成器写 `liyuan.agent.json`）后即可选。

**兼容性**：未配置 = 默认开启——既有部署升级后封笔会开始多一次旁路调用（评审质量收益与成本的取舍，可随时关）。

## §5 评审提示词（材料自包含）

评审是独立单轮调用，材料自包含（不依赖主演上下文）：

- systemPrompt：评审者角色 + 三维定义 + 输出 JSON schema（dimension/severity/evidence/problem/suggestion）+ **宁漏勿误**规则（拿不准的不报；找不到原文证据的不报；major 只留给真正破坏体验的问题）。
- userText：`【人设与文风基准】`（卡 personality + 预设 A 层原文）+ `【文风要求】`（B 层）+ `【世界状态】`（formatState）+ `【现稿】`（全量）。

解析：`parseReviewResult`（与 parseScribeResult 同款宽容解析——剥围栏、逐 `{` 试切）；只收 evidence/problem 齐全的问题；解析失败降级为提示，绝不阻断本拍。输出 maxTokens 4096，reasoning off（与场记/压缩同一旁路口径）。

## §6 代码落点

| 文件 | 职责 |
|---|---|
| `src/stage/review.ts`（新） | 纯函数：buildReviewPrompt / parseReviewResult / formatReviewViolation（`[评审·维度]` 前缀 + 证据截断）/ reviewEvidenceOf（证据提取，修复感知用）/ formatReviewReport（回喂文本） |
| `src/stage/workspace.ts` | `TurnWorkspace.semanticIssues/reviewed` 字段；`WorkspaceDeps.runSemanticReview/reviewGate`；`runReviewOnce`（共用执行）；`draft_seal` 分支自动评审；`draft_review` 分支；`runCheck` 的评审项继承与证据过滤；`runWriteTool` 异步化（seal/edit/review 需 await） |
| `src/stage/tools.ts` | `writeTools` 加 `draft_review` schema |
| `src/stage/engine.ts` | `wsDeps` 装配评审闭包（组装材料 + `#sideText(…, 4096, "review", traceOn)`）；`DRAFT_TOOLS` 加 draft_review；三处 `runWriteTool` 调用点 await；`getSideModel` 注入（旁路统一旁挂模型） |
| `src/types.ts` | `RpConfig.semanticReview` 字段 + `SemanticReviewConfig` 类型 |
| `server/rest.ts` | CONFIG_EDITABLE 白名单 + applyConfigPatch 归一化（只认 `{ enabled: bool, gate: major|all }`） |
| `test/review.test.ts`（新） | 纯函数单测（提示词结构/解析容错/格式） |
| `test/stage-engine.test.ts` | makeStage 单测环境显式关评审（评审是旁路调用，会消费假模型响应）；评审集成测试（seal 评审→major 拦→edit 修复→放行） |

## §7 已知边界

- 评审问题「修了但没真修好」：证据引文消失即视为已修（定点改动了该处），是否真正解决语义问题不复查（可再显式 `draft_review` 复验）。
- 模型「直接停手不修」：与机械违规同一力度——门禁只拦推进类工具的**调用**，不拦谢幕（模型摆烂直接停仍会定稿）。
- 每次封笔多一次旁路调用（延迟 + 成本）：有戏的一拍才触发 + `enabled:false` 可关。
- 评审误报：宁漏勿误提示词 + severity 门槛 + 3 轮安全阀兜底。
