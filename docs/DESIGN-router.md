# DESIGN-router：梨园化 router（router-standard 调用模式移植方案）

> 2026-08-16 起草。底稿：`J:\AITools\dsh\dsh-routing-suite\preset`（dsh-router-standard v0.1.1，
> 研究工件，MIT）。本文把该预设的**调用模式**（首消息分类 → 模式人格 → 首轮核心工具 →
> 全量 → 每消息指导 → 模式隔离）移植进梨园，双模型（V4 Pro / V4 Flash）分轨，
> 覆盖全部 LLM 调用路径。本文是**改造方案**，落地须用户另行下令「开始/动手」。
>
> **用户拍板（2026-08-16）**：① 形态取唯一推荐 `personaMode: "perTurn"`（稳定弱人格 +
> 每拍模式卡）；② `router.enabled` **默认开**，一切细节按方案最优解执行。
>
> 参照：`docs/PLAN-ROUND-FLOW.md`（分轮演出流程）、`docs/PRESET-SPLIT-TAXONOMY.md`（预设拆层）、
> `docs/DESIGN-flow-config.md`（流程配置外置）、`docs/DESIGN-custom-agents.md`（自定义 agent）。

## 0. 结论先行

梨园已吃到 router 的「目录侧」成果（`src/tool-staging.ts` 就是 dsh-anchored-standard 的移植，
V4 Pro 全量起步 91/92 → Minimal 起步 98/99），缺的是「**分类侧 + 人格侧**」。本方案补上这两块：

1. **system 区：会话内字节稳定的「模型分档弱人格」**——Pro 用 w6c 风格（spec 句 + classify 指令，
   无锚），Flash 用 w7 风格（中性 + classify + 召回/收敛/防 runaway 锚）。保住前缀缓存，
   是 router 实测的最稳底子（P11/P24：Pro 24/24、Flash 96% 路由 + 100% 单任务完成）。
2. **每拍注入区：按当拍分类的「模式卡」**——构造→直接演、修复→先读题回看、复杂→深想后收敛。
   注入区本来就每拍动态，模式卡每拍可换**零前缀缓存代价**——这是梨园比 router 原版多出的
   自由度（router 因人格在 system 区只能会话固定，梨园可以用「稳定弱人格 + 动态近场卡」
   同时拿到缓存稳定和每拍自适应性）。
3. **工具目录：会话级 staging 维持现状并扩展**（Pro 首轮读侧+规划 → 全量；Flash 不做——
   目录免疫，做了白做，路由套件 5.2 节实测）。
4. **旁路：统一「收敛尾注」+ 模型档位解析收敛**，不注入模式人格（机械窄题，会污染）。

## 1. 与 router-standard 的关系：照搬什么 / 改什么 / 不照搬什么

| 项 | 照搬 | 改 | 不照搬 |
|---|---|---|---|
| 三稳定带模型（spec 0–0.19 / transition 0.2–0.49 / react 0.5–1.0） | ✅ 带宽量化逻辑 `bandOf` | 带的**语义** RP 化（见 §2） | — |
| 路径承诺 / 首请求定型 | ✅ 人格会话固定、目录只变一次 | 用「稳定弱人格 + 动态模式卡」化解「中途任务反转无效」 | — |
| 分类器（关键字计数） | ✅ 机制（净命中多者胜、平局回 weak） | **词表必须 RP 化重标定**（build/fix 词表在 RP 语境全误判） | 原 REACT_RE/SPEC_RE 词表 |
| 人格文本 | ✅ 结构（spec 句 / doer 段 / weak 段，按模型分档） | 文案改写成梨园演出语义（beat_plan/draft_append/回看） | 原文案（讲编码的） |
| 首轮核心工具 | ✅ 机制（首轮最小集 → 全量） | 最小集映射到梨园工具面（读侧+规划 / 读侧+写侧） | DSH 的 read/edit/glob/grep |
| near-field 每消息指导 | ✅ 机制（GUIDE_WEAK / GUIDE_DEEP，复杂度自适应） | 触发条件 = 当拍分类；位置在用户话**之前**（梨园硬约束） | 用户话之后追加 |
| 模式隔离子代理 `dev_mode_subagent` | ✅ 机制（fresh context + 自定 system prompt） | 需新开一条**带思考的旁路通道**（`#sideText` 现强制 `reasoning:"off"`） | — |
| `dev_router_status/mode` 自省工具 | 可做可不做 | RP 场景用户不在演戏时调模式，**建议后置** | — |

**铁律（移植时绝不破坏的梨园不变量）**：
1. `router.enabled === false` 时全部路径行为零变化。
2. 只换 persona / 注入卡，**绝不替换** `# 怎么演这一拍` / 轮次卡 / 文风基准 / 预设 A 破限块
   （router amnesia 教训：整体换 sections → 模型失忆重探索，paper §5.6）。
3. 用户当拍的话必须在上下文**最后一句**（8/03 实测）——模式卡放用户话之前。
4. system 区字节稳定（人格会话固定、按模型分档）；模式卡在注入区（动态，零缓存代价）。
5. 工具目录会话内只变一次（首轮 → 全量），不做拍级变化。
6. 旁路 reasoning 档位维持现状（`off` / `medium` 各有实证理由），router 只加提示词层。
7. 分类判不出归 `weak`（宁让模型自判，不硬推方向）——router P8：weak 人格 + 任务内容能
   lean 轨迹（+2.3..+5.0），且 Flash 上弱人格路由强度是 Pro 的 1.5–2 倍。

## 2. 核心设计：双模型分轨 + 三层模式传导

### 2.1 三个模式带的 RP 语义

router 的 spec/react 是编码任务的「维护 / 构造」双吸引子。RP 语境对应：

| 带 | router 语义 | 梨园 RP 语义 | 行为特征 |
|---|---|---|---|
| `react` | 构造（greenfield build 10/10） | **构造拍**：推进新剧情、长场面、新角色登场、群像戏、高潮/决战 | 直接演：读题 → beat_plan → 一段一段 draft_append，先落笔再回头补细节，不搞仪式 |
| `spec` | 维护（minimal 99/96） | **修复/维护拍**：改稿、重写、修文风、修一致性、用户指出上一拍的问题 | 先读题回看：定位问题 → 计划 → 定点 draft_edit，确认理解再动笔 |
| `weak` | 内部路由（模型自判） | **模糊拍**：寒暄边缘、混合诉求、判不出 | 模型自判，给最小指导 |
| （无） | — | **幕后拍**（`isBackstageText` / turn-intent 高置信纯办事） | 跳过模式卡与人格注入（router 不碰，走现状） |

### 2.2 三层传导（人格 / 卡 / 目录各司其职）

| 层 | 内容 | 稳定性 | 缓存代价 |
|---|---|---|---|
| **system 区** | 模型分档弱人格（一段，插 `# 舞台` 之后） | 会话内字节稳定 | 零（复用前缀缓存） |
| **注入区（每拍）** | 模式卡：构造卡 / 修复卡 / 深度卡（按当拍分类 + `isComplexTask`） | 每拍动态 | 零（注入区本就动态） |
| **工具目录（会话级）** | Pro：首轮 Minimal（读侧+规划）→ 首次工具调用后全量；Flash：全量不动 | 只变一次 | 零（一次性） |

**为什么这样分层**：router 的强人格（spec/react 全文）会话固定会锁死任务类型（P6：尾人格
无效、中途换人格破缓存）；而梨园一拍一输入，任务类型拍间会变。把「强方向」降级为每拍
近场卡（注入区动态 = 免费），把「稳定底子」留在 system 弱人格，既拿到 router 的
「deep-then-converge」收益，又保住每拍自适应性。这正是 router 自己指出的唯一可靠内路由
窗口（weak 人格 + 近场指导）的工程化。

### 2.3 模型分档（pro / flash 双轨）

| 维度 | V4 Pro | V4 Flash |
|---|---|---|
| 目录敏感 | 敏感（staging 必须） | **免疫**（catalog-immune，5.2 节）→ 不做 staging |
| 人格敏感 | 强 | **更强**（100% `We` under minimal） |
| 最优 weak 人格 | w6c：spec 句 + classify 指令，**无锚**（P24：锚对 Pro 有害） | w7：中性 + classify + **召回 / 收敛 / 防 runaway 锚**（P23：单任务完成 100%） |
| 复杂任务 | 深度卡（P30：深度 +12% 且收敛更快） | 深度卡 + **防过度自信**（8/11 用户反馈：flash 复杂任务太浅/太自信） |
| 判定 | `isFlashModel(modelId) = /flash/i`（梨园 `deepseek-v4-flash` 命中） | — |

**persona 文案初稿**（梨园演出语义，落 `assets/flow/router.json` 可改）：

```
weak-pro（system 区，Pro）：
  你是一部长篇角色扮演的创作者。
  每一拍落笔前，先判定这一拍的任务类型：推进新剧情（直接演）还是修正上一拍（先回看定位再动笔），
  按类型选择演出节奏。判定不出就按剧情自然推进。

weak-flash（system 区，Flash，含收敛/防 runaway 锚）：
  你是一部长篇角色扮演的创作者。
  每一拍落笔前，先判定这一拍的任务类型：推进新剧情（直接演）还是修正上一拍（先回看定位再动笔）。
  动手前简短回看本拍已写下的段落，从上次停下的地方继续，不重复已完成的部分。
  不要在思考里做环境自查（echo/whoami/版本检查）或地毯式检索；信息够用就落笔，落笔后自然收束。

构造卡（react，注入区）：
  本拍是推进型：读题 → beat_plan 列路标 → 一段一段 draft_append 直接演。先落笔再回头补细节，
  不搞仪式。文风按 # 文风基准 执行。

修复卡（spec，注入区）：
  本拍是修正型：先读题回看刚写下的段落，定位问题（用户指出的 / 验收报告 / 你自己的判断），
  beat_plan 列定点修改计划，再用 draft_edit 逐处修。确认理解后再动笔，不推倒重来。

深度卡（complex，注入区，Flash 追加「防太浅」句）：
  本拍信息量大：先想清楚本拍的结构与人物状态再落笔。不要在思考上反复确认环境或工具，
  信息完备就产出；每一段思考以「决定或信息需求」收尾。Flash 追加：宁可多想一步也不要
  交浅稿——先深想后收敛，再一段一段演。
```

### 2.4 分类器（RP 语义词表，外置可覆盖）

机制照搬 router-core `classifyTask`（净命中多者胜，平局回 `weak`），词表 RP 化初稿：

```
构造（react，净命中 > 修复）：推进|继续|接着|写下去|开始|新场景|大场面|长段|展开|登场|新角色|
  发展|下一幕|开局|导入|开演|接下来|然后|续写|写一段|演|高潮|决战|转折|群像|多线|战役|长文|万字

修复（spec，净命中 > 构造）：修|改稿|重写|重来|不对|错了|别这样|太短|太长|复读|文风|崩|乱|
  回退|重新|调整|润色|精简|扩写|重roll|撤回|一致性|逻辑|ooc|人设|出戏|状态栏|格式|评审|验收

复杂（isComplexTask，构造/修复命中后叠加）：多线|大场面|群像|多角色|战役|攻城|万字|长文|
  设定密集|世界书|持续|长篇  或 文本长度 > 120 字
```

优先级：`isBackstageText` → 幕后（跳过）；构造 vs 修复净命中；平局 / 无命中 → `weak`；
`isComplexTask` 只决定「深度卡」还是普通卡，不改变带归属。

## 3. 全部 LLM 调用路径清单与接入策略

### A. 主演剧情路径（`src/stage/engine.ts`）——router 主战场

| 子路径 | 现状 | router 接入 |
|---|---|---|
| `#turn` 主生成（`streamFn` → `streamSimple`） | system 区字节稳定 + 每拍注入块 + 轮次卡；模型 = `session.model`；思考档用户自定 | ① system 拼模型分档弱人格；② 注入区加模式卡（当拍分类）；③ `storyPrefix` 已有先例（`config.storyPrefix` 拼 systemPrompt 最前），router 人格走同一通道或新选项 |
| `#agentLoop` 循环请求 | 轮次卡每轮注入；工具目录 `stagedTools ?? tools` | 模式卡并入轮次卡体系（新卡 key：`router-build` / `router-fix` / `router-deep`，`roundCardFor` 之外单独按当拍分类注入，替换语义防累积） |
| `#sideText`（语义评审 / 场记 / 压缩摘要） | `reasoning:"off"` + 固定 prompt + 按用途 maxTokens；模型 = `sideModel → 剧情` | 只加**可选收敛尾注**（信息完备即产出，防旁路飘）；不注入模式人格；reasoning 档位不动 |
| 工具目录 staging（`minimalStageTools`） | Pro 专用，首轮读侧+规划 → 全量 | 保持；`STAGED_MODELS` 从硬编码改配置；`minimalStageTools` 支持按模式微调（可选，默认不动） |

### B. 服务器旁路（`server/main.ts`）

| 子路径 | 现状 | router 接入 |
|---|---|---|
| `registerPlannerCaller`（生图管线规划 LLM） | `reasoning:"medium"` + 81920；模型 = `settings.llm → sideModel → 剧情`；system 最前拼 `sideJailbreak` | 可选收敛尾注（与 A 的 `#sideText` 同款文案）；模型档位解析**收敛为共享函数**（现与 `backfillSideText`/扩展侧各一份拷贝） |
| `backfillSideText`（表格回填 / 原始导入） | 同上 | 同上 |
| `ext_generate`（JS Runner 程序化生成） | 用户/脚本**自带 systemPrompt** 与 reasoning/maxTokens 参数 | **router 不碰**（用户自带提示词的通用通道，注入会污染；文档注明即可） |

### C. 扩展旁路（`.liyuan/extensions/roleplay.ts`，legacy）

| 子路径 | 现状 | router 接入 |
|---|---|---|
| `sideComplete` / `sideCompleteWithRetry`（世界书别名 1024 / 一致性审计 10240 / import 摘要 4096 / 场记 20480 / 回填 81920） | `completeSimple`；模型 = `sideModel → ctx.model`；别名有磁盘缓存 | **默认不动**（StageEngine 已接管场记/审计主职责，此处多为 legacy 兜底）；仅提供可选收敛尾注开关。别名生成保留现状 |

### D. 助手 / 自定义 agent（`server/assistant.ts` + `@liyuan/agent-runtime`）

| 子路径 | 现状 | router 接入 |
|---|---|---|
| 内置助手（`stagehandExtension` 提示词） | staging 已有（`applyToolStaging`，Pro 首轮 read/bash/return_answer → 全量）；模型 = `assistantModel` 或跟随剧情；LLM 循环在 pi runtime 内 | router **默认关**；可选开：首消息分类 → 提示词前缀拼弱人格 + 每消息模式卡（走 `plainPromptExtension` 同款通道） |
| 自定义 agent（`plainPromptExtension`，用户自带 systemPrompt） | 同上 staging；模型 = `agents[].model` 或跟随 | **默认不注入**（用户自带人格）；仅提供 `router: { agents: { enabled } }` 开关 |

### E. 生图管线插件（`src/draw-plugins/draw-pipeline`）

规划 LLM 走 B 的 `registerPlannerCaller`；`settings.llm` / `visionLlm` 已在插件配置可调。
router 只经 B 的收敛尾注覆盖，插件领域层不改。

## 4. 配置设计

### 4.1 `liyuan.config.json` 新段（与 `flowTemplates` / `splitTables` 同款覆盖语义）

```jsonc
"router": {
  "enabled": true,               // 总开关，默认开（用户拍板）；false = 全部路径零变化
  "stage": {
    "personaMode": "perTurn",    // perTurn = 唯一推荐形态（用户拍板）：稳定弱人格 + 每拍模式卡
    "toolStaging": true,         // Pro 双阶段（现状默认 true）
    "modeCards": true            // 每拍模式卡（构造/修复/深度）
  },
  "side": {
    "convergeTail": true         // 旁路统一收敛尾注（A#sideText + B 两处）
  },
  "agents": {
    "enabled": false             // 助手/自定义 agent 的 router（默认关）
  },
  "models": {                    // 按模型覆盖（缺省用内置分档表）
    "deepseek-v4-pro":   { "band": "weak", "persona": "..." },
    "deepseek-v4-flash": { "band": "weak", "persona": "..." }
  },
  "classify": {                  // 词表外置（构造/修复/复杂）
    "build":  ["..."],
    "fix":    ["..."],
    "complex": ["..."]
  }
}
```

### 4.2 `assets/flow/router.json`（仿 `round-cards.json`：代码内嵌默认 + 文件覆盖 + 配置段覆盖）

```
{
  "personas": { "pro": {...}, "flash": {...} },
  "cards": [
    { "key": "router-build", "title": "【构造拍】", "body": "..." },
    { "key": "router-fix",   "title": "【修复拍】", "body": "..." },
    { "key": "router-deep",  "title": "【深度拍】", "body": "..." }
  ],
  "classify": { "build": [...], "fix": [...], "complex": [...] }
}
```

加载仿 `loadRoundCardsFile` / `resolveRoundCardTemplates`：`src/router-config.ts` 提供
`normalizeRouterConfig` / `loadRouterFile` / `resolveRouterConfig`（非法条目跳过、缺省回退内置，
`flowWarnings` 进引擎告警）。

## 5. 模块与逐文件改动点

### 新增

**`src/router-core.ts`**（纯函数，零 pi 依赖，可单测——与 `src/preset-split.ts` 同风格）
```ts
export type RouterBand = "spec" | "react" | "weak";
export const classifyTask(text: string): "react" | "spec" | "weak"   // 净命中 + 平局回 weak
export const isComplexTask(text: string): boolean                     // 长度 > 120 或复杂词
export const isFlashModel(modelId?: string): boolean                  // /flash/i
export const bandOf(mode: RouterBand | number): RouterBand            // 三带量化（transition 只显式 opt-in）
export const personaFor(band: RouterBand, modelId?: string): string   // pro/flash 分档文案（§2.3 初稿）
export const cardFor(task: "react"|"spec"|"weak", complex: boolean, modelId?: string): string
export const parseMode(token: string): RouterBand | "auto" | null     // 供自省工具/配置
```

**`src/router-config.ts`**：配置加载与合并（§4）。

**`src/stage/router.ts`**（可选，引擎集成辅助）：
`classifyTurn(text)` → `{ band, complex }`；`buildRouterCard(...)`；`personaOption(modelId)`。

### 修改

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `RpConfig` 加 `router?: RouterConfig`（接口随 §4.1）；`SplitTableOverride` 旁并列定义 |
| `src/stage/materials.ts` | `loadStageMaterials` 装载 router 配置（`loadRouterConfig`，进 `flowWarnings`）；`StageMaterials` 加 `router` 字段 |
| `src/stage/assemble.ts` | `buildStageSystemPrompt` 加 `routerPersona?: string` 选项（插 `# 舞台` 之后，仅一段）；`buildStageInjection` 加 `routerCard?: string` 选项（插【导演备注】附近、用户话之前） |
| `src/stage/engine.ts` | `#turn`：① 分类（`classifyTurn(lastUserText)`；`personaMode==="fixed"` 时取首条剧情消息并落 `rp-router` 会话树条目）；② `buildStageSystemPrompt` 传 `routerPersona`；③ `buildStageInjection` 传 `routerCard`（weak 带不给卡或给最小卡）；④ `#agentLoop` 轮次卡注入处并入模式卡（替换语义防累积）；⑤ `#sideText` 加可选收敛尾注；⑥ `minimalStageTools` 调用点透传 router 配置 |
| `src/tool-staging.ts` | `STAGED_MODELS` 从硬编码集合改为「配置 + 内置默认」双源（`isStagedModel` 加可选配置参数）；`minimalStageTools` 支持按 band 微调（spec=现状读侧+规划；react=读侧+`draft_write`/`draft_append`，默认不启用） |
| `server/main.ts` | 旁路模型档位解析（`backfillSideText` / `registerPlannerCaller` / 扩展侧）**收敛为共享函数** `resolveSideModel(config, modelRegistry, fallback)`；两处旁路加可选收敛尾注；`ext_generate` 注明不碰 |
| `server/assistant.ts` | `applyToolStaging` 保持；可选 `router.enabled && router.agents.enabled` 时：`build` 里给 `stagehandExtension` / `plainPromptExtension` 前置拼模型分档弱人格 + 委托回合注入模式卡（默认关，零行为变化） |
| `.liyuan/extensions/roleplay.ts` | `sideComplete` 加可选收敛尾注（默认关）；**不动** legacy 行为 |
| `assets/flow/router.json` | 新建（§2.3 文案初稿 + §2.4 词表初稿） |

### 模式状态与持久化

- `personaMode: "perTurn"`（**唯一推荐，用户拍板，默认值**）：模式只活在当拍注入区，
  无持久化，resume 天然一致；system 弱人格会话固定、模型分档，前缀缓存不受影响。
- `personaMode: "fixed"`（**实验性，不推荐**）：首条剧情消息分类 → 落 `rp-router` 会话树
  custom entry（`{ band, model, at }`，仿 `rp-tool-staged`，不进送模流不进历史），
  resume/fork 按条目推导；中途任务反转时模型靠注入区卡 + 轮次卡自愈（不强切人格）。
  保留为配置项仅作对照实验，默认与推荐形态一律 `perTurn`。
- 自省工具（`router_status` / `router_mode`）**后置**（§1 不照搬列），RP 场景价值存疑。

## 6. 测试与验证矩阵

### 单测（`test/`，纯函数，离线可跑）

- `test/router-core.test.ts`：分类（构造/修复/模糊/幕后、平局回 weak）、`isComplexTask`、
  `bandOf` 量化、`personaFor` 按模型分档（pro 无锚 / flash 有锚）、`parseMode`。
- `test/router-config.test.ts`：文件缺失/损坏回退内置、配置段覆盖、非法词表跳过。
- `test/stage-router.test.ts`（引擎集成断言）：`buildStageSystemPrompt` 含/不含 routerPersona；
  `buildStageInjection` 模式卡注入位置（用户话之前）；`enabled=false` 时输出与现状逐字节一致。

### 实弹验证矩阵（主剧情路径）

| 模型 | 任务 | 期望 |
|---|---|---|
| pro | 构造拍（推进长场面） | 首轮 Minimal → 工具调用后全量（现状）；模式卡引导直接演，思考不膨胀 |
| pro | 修复拍（改上一拍文风） | 修复卡引导先回看定位，draft_edit 定点改，不推倒重来 |
| flash | 构造拍 | system 弱人格 + 构造卡；无 staging（目录免疫）；收敛锚生效 |
| flash | 复杂修复拍 | 深度卡 + 防太浅句：思考深度上（对照 8/11 用户反馈「太浅」），收敛更快 |
| 全部 | 寒暄/幕后拍 | 无模式卡、无行为变化 |
| 全部 | `router.enabled=false` | 与现状逐字节一致（回归） |

### 缓存与稳定性验证

- system 区字节稳定：`chatTrace` 对比相邻两拍 `systemPrompt`（router 人格固定、模型分档）。
- 模式卡不累积：连续多拍 trace 中注入区只出现当拍一张卡（替换语义）。
- 用户话最后一句：trace 检查 `messages` 末条为当拍用户原文。

## 7. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | `router-core` / `router-config` 纯函数 + `assets/flow/router.json` + 配置段 + 单测 | 全部单测绿；`enabled=false` 零变化 |
| P2 | 主演路径接入：system 弱人格 + 每拍模式卡 + staging 配置化（engine/assemble/materials/tool-staging） | 实弹矩阵 pro×构造/修复、flash×构造 通过；缓存验证过 |
| P3 | 旁路收敛：`resolveSideModel` 共享函数 + 收敛尾注（main.ts / #sideText） | 旁路输出不劣于现状；失败降级路径不变 |
| P4 | 助手/自定义 agent 可选 router（默认关） | `enabled=false` 时助手零变化；开启后委托回合有模式卡 |
| P5 | 实弹完整矩阵（§6）+ 文档收尾 | 矩阵全过；本文档标「已落地」 |

## 8. 风险与开放问题

1. **分类器准确率**：词表是初稿，RP 语境误判代价与 router 不同——构造误判成修复 = 白回看一轮
   （小代价）；修复误判成构造 = 直接演歪了要重写（大代价）。**兜底方向 = 构造**（与
   `preset-classify` 的「兜底归 style」同哲学：宁多写几段，不白回看）。词表落地后须实弹校准。
2. **weak 带的边界**：寒暄 vs 模糊拍界线（`isBackstageText` 已覆盖明确幕后；模糊拍给最小卡）。
3. **模式隔离旁路**（`dev_mode_subagent` 等价物）：需要新开一条不透传 `reasoning:"off"` 的
   旁路通道（`#sideText` 现强制 off）——价值待 P5 后评估，**默认不做**。
4. **`fixed` 模式与任务反转**：router 实测尾人格无效，`fixed` 模式下中途反转只能靠注入区卡
   自愈。**用户拍板：`perTurn` 为唯一推荐形态**，`fixed` 仅作实验配置保留，不参与默认路径。
5. **legacy 扩展旁路**（roleplay.ts）：与 StageEngine 双轨并存，router 不触碰；后续若
   roleplay.ts 退役，其 sideComplete 调用点并入收敛尾注范围。

## 9. 落地记录（2026-08-16，用户下令 P1→P2 一路做完）

| 阶段 | 状态 | 落点 |
|---|---|---|
| P1 纯函数 + 配置 | ✅ | `src/router-core.ts`（分类/复杂度/模型分档/人格/卡 + RP 语义词表初稿）、`src/router-config.ts`（文件+配置段覆盖解析）、`assets/flow/router.json`、`src/types.ts` `RouterConfig` 段、`test/router-core.test.ts`（25 例）`test/router-config.test.ts` |
| P2 主演路径 | ✅ | `materials.ts` 装载 `router`；`assemble.ts` `buildStageSystemPrompt` 加 `routerPersona`（# 舞台 后）；`engine.ts` #turn 计算弱人格+模式卡（perTurn 分类源=当拍消息；fixed 取首条剧情消息）、注入区拼卡（轮次卡后、用户话前）、staging 开关（enabled=false 维持现状）、`#sideText` 收敛尾注、`#compact` 刷新收敛字段；`test/stage-router.test.ts`（9 例，含真实 router.json 链路） |
| P3 旁路收敛 | ✅ | `server/main.ts`：`resolveSideModel` 收敛三处模型解析（registerPlannerCaller/backfillSideText/getSideModel）、`routerConvergeTailOf` 尾注（默认开，enabled=false 零变化）、`ext_generate` 注明不碰 |
| P4 助手/自定义 agent | ✅ | `RouterConfig.agents.enabled`（默认 false，开启后零差量注入）：`src/router-core.ts` `agentPersonaFor`（Pro 审题规划 / Flash 快动作分档姿态）+ `assistant.ts` `withAgentRouterAttitude`——内置助手（stagehandExtension rebuild）与自定义 agent（plainPromptExtension 调用处）的 systemPrompt 前置注入模型分档工作姿态，覆盖 agent 侧全部 LLM 路径；默认关零行为变化 |
| P5 实弹矩阵 | ⏳ 待用户实弹 | §6 矩阵需真实 LLM 会话验证（分类/卡效果、缓存稳定性、flash 防太浅） |

实现偏差（比方案 §5 更优）：
- **模式卡注入位置**：方案原写「`buildStageInjection` 加 routerCard 选项」，实现改为**引擎拼接**
  （`engine.ts` `#turn` 与轮次卡同通道、首轮注入一次、不累积）——与轮次卡同一机制、单测直接
  钉死 `cardFor` 纯函数，`buildStageInjection` 签名不动。
- **模式卡只首轮注入**：`#agentLoop` 不重复注入（避免每轮两张卡噪音）；修复行为由「修复卡 +
  轮次卡 fix + 同轮连发/未修违规门禁」兜底——router 的 GUIDE 语义是「每真实用户消息一条」，
  梨园一拍 = 一次 #turn，语义对齐。
- **词表修正**：场景规模词（战役/群像/多线/大场面）从 build 词表移出（是复杂度信号不是方向
  信号，避免「群像戏太浅了重写」被 build 词带偏）；fix 补「太浅/太水」。
- **staging 与 enabled 解耦**：`enabled=false` 时 staging 维持现状（toolStaging 默认 true），
  满足「零变化」铁律；`toolStaging:false` 才显式关 staging。
- **分类兜底规则（8/16 实弹校准）**：初版「无命中回 weak」导致长剧情推进（几乎总是构造，
  无关键词）拿不到构造卡。修正：无命中且文本 ≥40 字 → react（构造兜底，兑现 §8.1「宁多写
  几段，不白回看」）；寒暄短句（<40 字）→ weak（不硬推）；平局（build==fix>0）→ weak。
- **旁路 trace 口径**：`#sideTrace` 记录**实际发送**的 systemPrompt（含收敛尾注 `sys`），
  旁路尾注在 `.liyuan-state/trace` 的 side 事件中可观测。

验证：router 相关单测 25+13+9 例全绿；回归 stage-engine/stage-scribe/stage-compact/workspace/
review/stage-tools/flow-*/turn-intent/tools-registry/preset-split/table-backfill 130 例全绿；
服务冒烟 `PORT=7621` 起服 /healthz OK（日志无异常）；真实配置链路脚本验证：缺省 router 配置
→ enabled=true/perTurn/全开，pro 弱人格 + 构造/修复/深度卡分类正确，system prompt 含 `# 演出姿态`。

### 实弹 trace 确认（2026-08-16，会话 019fec6e-…）

- ✅ **system 弱人格已进真实会话**：8/15 13:19/13:24/13:25 UTC 三个 `kind:"prompt"` 事件的
  `systemPrompt` 均含 `# 演出姿态`（模型 `deepseek-v4-pro` → weak-pro 人格）。
- ⚠️ **当时模式卡未注入**：那几拍用户输入为长剧情推进（如「凯尔绕回了自己的店长房间…」178 字），
  初版分类器无命中回 weak → 无卡。分类兜底规则修正后该输入判 react → 【构造拍】（
  `node scripts/check-router.mjs pro "凯尔绕回了…"` 已验证）。**服务重启后下一拍即可见**。
- ⚠️ **旁路尾注 trace 口径**：旧 side 事件记录原始 systemPrompt，看不到尾注；已改为记录
  实际发送的 `sys`，下次旁路调用（场记/评审/压缩）的 side 事件末尾可见「信息完备即产出」。
- ✅ **实弹再确认（2026-08-16 22:11+ UTC / 06:11+ 北京；最新会话拍次）**：trace 后段
  `kind:"prompt"` 事件 `#1842`【构造拍】、`#1910`【深度拍】、`#1947`【深度拍】均含
  `# 演出姿态` 弱人格 + 模式卡——长剧情推进判 react（§8.1 兜底生效），复杂度命中给深度拍。
  至此「弱人格 + 每拍模式卡 + 分类兜底」在真实会话全程可观测，P5 实弹矩阵核心链路通过。
