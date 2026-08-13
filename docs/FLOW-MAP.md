# 主聊天一拍流程图（FLOW-MAP）

> 2026-08-13 整理 · 基于 `src/stage/engine.ts`（#turn / #agentLoop）、`src/stage/materials.ts`、`src/stage/assemble.ts`、`src/draft.ts`、`src/stage/workspace.ts` 实读。
> 标注每一项「预设定制 / 必须改代码 / 参数可调」，并说明每步在聊天中的作用。
> 外置机制的权威说明见 [DESIGN-flow-config.md](DESIGN-flow-config.md)。

**图例**：🟢 = 预设定制（改 JSON / 角色卡 / 世界书 / 配置即生效）｜🔴 = 必须改代码｜🟡 = 代码逻辑 + 配置参数可调

## §1 流程图

```
【用户输入】前端唯一输入框(纯文本) → WS prompt → handlePrompt
                                          ├─ 斜杠命令(/reroll /swipe /compact…)
                                          └─ 忙时排队(回合互斥)
        │
        ▼
① 素材现读 loadStageMaterials（每拍现读，改卡/改预设/改配置下一拍生效）
   ├─ 配置 liyuan.config.json（🟢 全部字段）
   ├─ 角色卡 / 世界书 / 预设(宏求值 setvar/getvar)（🟢 内容全可定制）
   ├─ 拆层表：认表 findSplitTable → 拆层 splitBlockContent
   │      A破限→常驻原文  B文风→常驻  C边界→常驻
   │      D/E方法论→skill包  F机械纪律→仅提取规则  G/H/I→退场
   │      （🟢 assets/flow/split-tables.json + config.splitTables 决定每块去哪）
   └─ 轮次卡模板加载+覆盖合并（🟢 assets/flow/round-cards.json + config.flowTemplates）
        │
        ▼
② 上下文重建 rebuildHistory（🔴 逻辑；🟡 scanDepth/maxLoreInjections/compactEveryNTurns）
   ├─ 分支历史还原纯正文（补丁已套、工具轨迹剥离）
   ├─ 世界状态快照恢复（账本/表）
   └─ 世界书关键词扫描 scanEntries + 面板快照
        │
        ▼
③ postHistory 每拍求值 + 拆层分流
   （🟢 预设 postHistory 块内容与宏；🔴 求值时机；🟢 拆层去向表）
        │
        ▼
④ 工具清单装配（🔴 schema/路由）
   读侧统一层 + writing_guide(🟢 主题=skillPacks+.liyuan-skills)
   + 写侧稿纸11件 + 媒体 + 音效 + assistant_run + MCP外设(🟢 用户自装)
        │
        ▼
⑤ 工作区=稿纸 createWorkspace + 验收规则 extractDraftRules
   （🟢 验收靶子数据=字数句式/禁词分档+阈值/破折号/半角/比喻/不是…是 点灯
        ——从预设原文按特征解析，写对句式才生效，详见 §4；
    🟡 状态栏组=卡作者格式(非预设)；🔴 检查项清单9类与解析模式=代码写死）
        │
        ▼
⑥ 提示词装配
   system：13 分节（🔴 骨架与顺序；🟢 各节填充内容=卡/预设A·B·C原文/世界书/状态栏）
   + 每拍注入：13 块（🔴 结构；🟢 内容=世界状态/相关设定/导演备注…）
        │
        ▼
⑦ 送模组装（🔴 顺序纪律：注入块+首轮卡+用户原话，用户话必须末位）
   【前情提要】+ 历史 + 注入 + 首轮轮次卡 + 用户原话
        │
        ▼
⑧ 首轮流式生成（规划轮）——思考 + 读侧工具 + beat_plan 列路标
   （🟢 规划卡文案；🔴 首轮判定/工具可用面）
        │
        ▼
⑨ agent 循环（≤20 轮，🔴 MAX_ROUNDS/卡序判定）
   ├─ 轮次卡注入：7 张卡按工作区状态出卡 + 替换语义防累积
   │     规划→开工→演段回看→修复→续写→收笔评估→谢幕
   │     （🟢 卡文案与占位符；🔴 哪张卡何时出的判定）
   ├─ 无工具调用 → 谢幕路径（催封笔/开谢幕轮/直出代收draft_write/逼稿）
   ├─ 工具派发：读侧→runStageTool / 写侧→runWriteTool / ask→弹选择卡等用户
   └─ 三道硬件门禁：同轮连发draft_append拒收 / 零思考落笔拒收 / 未修违规不推进（🔴）
        │
        ▼
⑩ 收尾（🔴）
   兜底封笔 → 定稿合并 mergeFinalText(稿纸主体+格式尾巴)
   → 落树(保留思考块/剥离工具轨迹/rpTimeline时间线) → 媒体交付落树
        │
        ▼
⑪ 场记 runScribeTurn（🔴 记账逻辑；🟡 sideModel/sideJailbreak）
   旁路模型写状态补丁 → world_state_update 干跑验证过的补丁优先投影 → 长局压缩摘要
        │
        ▼
【输出】wire 帧 → 前端渲染（正文 + 状态栏🟢卡作者格式 + 媒体 + 时间线）
```

## §2 每步在聊天中的作用

| 步 | 作用（对聊天体验的意义） |
|---|---|
| ① 素材现读 | 保证**改卡/改预设/改书立刻生效**——没有热重载缝隙；拆层表决定预设里每块内容「去哪」：哪些常驻模型视野、哪些按需读、哪些只做验收、哪些退场 |
| ② 上下文重建 | 模型看到的**不是原始会话树**，而是干净的纯正文；世界状态恢复到上拍结尾；关键词扫描把相关世界书条目挂进上下文 |
| ③ postHistory 求值 | 预设里「每拍模板」在此生效，`{{lastusermessage}}` 用当拍用户原话代入——这是预设与当拍互动的接口 |
| ④ 工具清单 | 决定模型这一拍**手里有哪些牌**：读设定/写稿纸/发媒体/委托助手/外接 MCP，依赖没注入的自动下架 |
| ⑤ 稿纸+验收规则 | 正文只写在工作区；「什么算合格」在此定死（字数/禁词/格式）——**验收器与写作分离**，模型不用脑内自查 |
| ⑥ 提示词装配 | system=人格+世界观+流程总纲（会话内字节稳定利于缓存）；注入=当拍事实基准（时间地点人物状态） |
| ⑦ 送模组装 | 上下文**顺序纪律**：用户当拍的话必须最后一句，否则模型会把提问读成历史旧话不回应（8/03 实测教训） |
| ⑧ 首轮规划 | 不让模型直接动笔：先读题、探索（可查设定）、列路标 `beat_plan`——防止无计划自由发挥 |
| ⑨ agent 循环 | 演出主体：每轮注入「你现在在第几步」的卡；写侧工具把正文一段段交到稿纸；门禁挡住三类坏行为（连发塞稿/不思考就写/违规不修） |
| ⑩ 收尾 | 忘记封笔兜底补验收；**定稿=稿纸主体+格式尾巴**（状态栏不被丢）；落树时思考块保留给用户看、工具轨迹剥离 |
| ⑪ 场记 | 旁路模型把这一拍剧情变化**写成世界状态补丁**（账本/表），并压缩早期剧情成摘要——长篇不漂移、上下文不爆 |

## §3 汇总：预设定制面 vs 必须改代码面

### 不用改代码就能定制的

| 定制面 | 载体 | 影响什么 |
|---|---|---|
| 角色人设/文风示例/附加指令/状态栏格式 | 角色卡 | 人格、语气、状态栏渲染与谢幕尾巴 |
| 预设 A/B/C 常驻原文 | `assets/presets/*.json`（liyuan.config.json `preset`） | 破限契约、文风、行为边界——每句都压给模型 |
| 预设 D/E 方法论 | 预设块 → skill 包 | `writing_guide` 按需读的内容（瑟瑟语料只在瑟瑟拍进上下文） |
| 预设 F 机械纪律 | 预设块（【硬禁】【软禁】分档+阈值） | `draft_check` 的验收靶子——机制与边界见 §4 |
| 预设 postHistory 模板 + 宏 | 预设块 | 每拍注入的导演备注/状态栏等 |
| **拆层表**（2026-08-13 外置） | `assets/flow/split-tables.json` + `config.splitTables` | 每个预设块去向：常驻哪节/进哪个主题/仅提取/退场 |
| **轮次卡文案**（2026-08-13 外置） | `assets/flow/round-cards.json` + `config.flowTemplates` | 7 张流程卡的措辞与占位符组合 |
| 世界书 | `lorebooks` + `.liyuan-lore/` | 常驻事实与关键词触发条目 |
| 写作方法论与触发映射 | `.liyuan-skills/*.md` + 预设「写作·技能触发表」 | 演段回看卡④查表决定读哪个主题 |
| 采样/配置参数 | `liyuan.config.json` | language / creationMode(ask\|silent) / compactEveryNTurns / rehearsalGuard / sideModel / sideJailbreak / scanDepth… |
| MCP 外设 | 扩展能力面板 | 识图/搜索/浏览器等外部工具进清单 |
| 回合意图正则（预留） | `config.intentRegex` | **当前无调用点**，为将来激活铺路 |

### 必须改代码才能改的

1. **回合状态机与卡序判定**——哪张卡何时出、修复态优先、字数决定续写还是收笔（`engine.ts` roundCardFor / agentLoop cardKind）
2. **三道硬件门禁**——同轮连发拒收、零思考落笔拒收、未修违规不推进
3. **谢幕路径与防转逻辑**——催封笔只给一轮、逼稿一次、兜底封笔
4. **工具 schema 与执行路由**——写侧 11 件、读侧、媒体、音效的 schema 与派发
5. **system 13 分节 + 注入 13 块的骨架与顺序**（`assemble.ts`）
6. **上下文重建/清洗/压缩**——rebuildHistory、cleanAssistantText、runCompaction
7. **定稿合并**——mergeFinalText 的格式尾巴识别规则
8. **场记与记账投影**——runScribeTurn 与 world_state_update 补丁验证
9. **ask 弹卡交互与时机门禁**——首拦一次坚持放行等
10. **引擎纪律**——MAX_ROUNDS=20、回合互斥排队、轮次卡替换语义

一句话记忆：**「内容与措辞」都在数据文件与预设里，「流程与判定」都在代码里**——2026-08-13 外置就是把两者之间能外置的部分（轮次卡文案、拆层表）划给了前者。

## §4 预设 F 机械纪律 → 验收规则的真实链路（精度说明）

「F 机械纪律能注入验收」成立，但机制不是「拆层表把 F 块定向路由给验收器」——拆层的 F 标记只决定「这块不进模型上下文」，与规则提取无关。真实链路是**全量扫描 + 关键词特征解析**：

```
预设 system 块（含 F 类纪律块）
   ↓ 宏求值（materials.ts：全部启用块，不分拆层去向——注释明写「扫全量含 H 类」）
presetRuleTexts = 全量 system 块原文
   ↓ engine.ts 拼上当拍 postHistory 求值内容
extractDraftRules(全量文本, 卡状态栏格式)   ← draft.ts
   ↓ 关键词特征解析 → DraftRules（9 项）
wsDeps.rules → checkDraft(draft, rules)（workspace.ts）
   ↓
验收报告 → draft_seal / 门禁「未修违规不推进」
```

**写对句式才生效**（解析是启发式的，宁漏勿误）：

| 验收项 | 预设里必须写成什么才被解析到 |
|---|---|
| 字数区间 | 明确句式：`1000–18000 字` / `大于…小于…` / `上限/不超过/至多 N 字`；**单边下限（「至少 800 字」）不支持**（TAXONOMY §2.3 注） |
| 禁词 | 块内容含特征词 `禁用词/禁词表/词汇黑名单/厌恶的词汇` + 引号词；分档靠 `【硬禁】/【软禁】` 节 + `软禁阈值：N` |
| 破折号 | 文本里出现关键词「破折号」即点灯 |
| 半角/英文引号 | 关键词「半角/英文引号/英文直引号」 |
| 比喻频率 | 「比喻」+（频率/段落内/宁缺毋滥/比喻词不重复/只允许使用1次） |
| 不是…是… | 该句式特征本身 |
| 状态栏组 | **来自卡作者的状态栏格式**，不是预设（draft.ts statusBarFormats 通道） |

**不能通过预设注入验收的**：

- `requiredTags`（预设格式栈标签——M-C 拆层后**已明确不再提取**：格式块由工具流与账本渲染承接，不再逼模型手写）
- 任意自定义检查项——检查项清单是代码写死的 9 类，预设只能点亮/喂数据，不能新增检查类型
- 语义级禁令（如「不出现血液」）——解析不了，只能靠拆层救进常驻 C 句让模型自觉守

## §5 交叉引用

- 外置机制的 schema / 覆盖语义 / 回退兜底：[DESIGN-flow-config.md](DESIGN-flow-config.md)
- 流程最终形态与落地记录：[PLAN-ROUND-FLOW.md](PLAN-ROUND-FLOW.md)
- 拆层九性质五去向：[PRESET-SPLIT-TAXONOMY.md](PRESET-SPLIT-TAXONOMY.md)
- 每拍全过程机器跟踪（调试验证用）：[DESIGN-debug-trace.md](DESIGN-debug-trace.md)
