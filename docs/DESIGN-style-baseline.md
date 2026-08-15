# 文风单锚：整体文风把控（DESIGN-style-baseline）

> 2026-08-15 起草。回答一个问题：文风为什么越管越碎，以及怎么把文风从「一堆规则」
> 收敛成「一个声音」。
>
> 结论先行：**harness 只讲机制，不藏文风；文风只有一个来源——文风卡；机械验收管硬规则；
> 语义评审对文风卡做整体一致性判断。** 见一个杀一个的禁令清单是开放集合，永远写不完；
> 文风卡用「一个声音 + 一组同场景正反例 + 一个自检问题」覆盖这个开放集合。

## §0 第一原则：harness 与预设不打架

现状：`assemble.ts` / `flow-templates.ts` / `round-cards.json` / `engine.ts` 里混进了
「资深作家、肆意展现文笔、镜头、点睛」这类**强文风引导**。它们的存在意义是流程信号
（第几步、干什么、用哪个工具），不是文风来源；藏了文风引导之后，它们会跟预设 B 层
争夺模型注意力，产出的就是「散文 + 剧本 + 流水账」的混合物。

因此定一条硬原则：

> **harness 提示词（assemble / round-cards / engine 注入）只讲机制和流程；
> 禁止出现「文笔 / 文风 / 精彩 / 镜头 / 点睛 / 肆意 / 倾尽」等审美引导词。
> 审美引导只允许出现在文风卡里。**

审计方法：grep 「资深作家 / 职业作家 / 文笔 / 精彩 / 镜头 / 点睛 / 肆意 / 倾尽」，
`src/stage/assemble.ts`、`src/flow-templates.ts`、`src/stage/engine.ts`、
`assets/flow/round-cards.json` 应零命中。允许的唯一例外是机制性引用
「文风按系统 `# 文风基准` 执行」与分节标题 `# 文风基准`——它们指向文风卡，
不定义文风。测试见 `test/style-baseline.test.ts`。

## §1 问题与目标

### 1.1 现象

- DeepSeek v4 pro 正文出现「看落日把海面烧成一片滚烫的金」——不是电报体，是诗意压缩；
- 用户感受到的是整体文风漂移：镜头式、流水账式、电影剧本式、散文式混在一起，不像小说。

### 1.2 根因

文风控制被拆散在四处，且互相拉扯：

| 位置 | 当前内容 | 对模型的拉扯方向 |
|---|---|---|
| `assemble.ts:369-375` / `round-cards.json` review 卡 | 「资深作家、肆意文笔、镜头、点睛」 | 美文 / 分镜 |
| `liyuan-Custom`「写作·常开纪律」 | 「要丰满，不要精简」 | 丰腴 |
| `liyuan-Custom`「反电报体」 | 「不要短句、不要省略」 | 连贯 |
| `liyuan-Custom`「模型禁词·DeepSeek」 | 「别复读、别模板腔」 | 回避 |

模型每拍面对的不是一个文风，而是四五个平级方向；产出是对这些方向的随机折中。
**不是某条规则不够严，而是没有主从锚点。**

### 1.3 目标

1. 文风只有一个来源：**文风卡（style baseline）**。
2. harness 回归机制，不再描述文风。
3. 机械验收（`draft.ts`）继续管硬规则；语义评审改为**对照文风卡的整体一致性判断**。
4. 用户改文风 = 换一张卡；不再逐条加禁令。

## §2 文风卡（Style Baseline）

文风卡只含四样东西：

### 2.1 声音（一句话）

叙述者是谁、对谁说、像什么。例：

> 你在给读者讲故事，不是在写分镜脚本、散文诗或流水账。

### 2.2 参考系（一个方向，可替换）

例：`成熟中文网文叙事` / `日式轻小说` / `通俗小说`。**单选，不叠加。**

### 2.3 同一场景的正反例（各一段，50–150 字）

- 正例：目标声音的完整段落。
- 反例：**固定覆盖三个跑偏原型**——分镜腔、散文腔、流水账腔。每个原型给一小段。
  反例不是穷举，是原型；模型靠原型泛化，不需要写一百条禁令。

### 2.4 一个自检问题

> 这段读完，读者会觉得在读小说，还是在看分镜 / 散文 / 账本？

落笔前问一次，写完问一次。机械纪律仍由验收器把关，不自查。

### 2.5 为什么这样够用

「不像小说」是开放集合，但跑偏方向收敛为三个原型。文风卡给模型一个**生成目标**
（像什么），而不是一叠**规避清单**（不像什么）。规避清单由机械验收处理；机械判不了的
整体声音，由语义评审对照同一张卡兜底。

## §3 职责分层

| 层 | 归属 | 职责 | 文风相关？ |
|---|---|---|---|
| harness 提示词 | `assemble.ts` / `round-cards.json` / `engine.ts` | 第几步、干什么、用什么工具、怎么收笔 | **不**。只讲机制 |
| 文风卡 | `assets/flow/style-baseline.json`（+ 配置覆盖） | 声音 / 参考系 / 正反例 / 自检问题 | **唯一文风来源** |
| 预设 B 层 | `preset-split.ts` | 拆层后归并为文风卡内容；不原文堆叠 | 作为卡的素材 |
| 机械验收 | `draft.ts` | 字数、禁词、破折号/半角、比喻频率、主权红线 | 硬规则，不判整体文风 |
| 语义评审 | `review.ts` | 设定/人物/文风一致性；文风维度对照文风卡 | 对照卡，不自己定义文风 |

## §4 数据形态与配置

仿照 `DESIGN-flow-config` 的三级来源：

1. `assets/flow/style-baseline.json`：默认文风卡 + 按预设 key 的可选卡（`liyuan-custom`
   等内置表预设各一张）。
2. 代码内嵌兜底（`src/style-baseline.ts`，与 JSON 逐字一致，测试兜底）。
3. `liyuan.config.json` 新增 `styleBaseline` 段，按 key 覆盖；改配置下一拍生效。

默认卡要写得通用：中文长篇叙事、目标「像小说」。预设专用卡从该预设 B 层抽卡（手工校准，
与拆层表同源）。

## §5 harness 去文风化改造点（逐处）

### 5.1 `src/stage/assemble.ts` `# 怎么演这一拍`

现状（369-375）：「资深作家……肆意展现你的文笔……职业作家的水平……镜头、动作、
感官细节、神态情绪、节奏、点睛」。

改为机制性措辞：

- 第 1 轮：读题、探索、列路标。
- 每一轮开始：回看刚写下的段落，决定下一段发生什么。
- 写作过程：按系统里的 `# 文风基准` 写这一段；思考只定「这段发生什么、落在哪个动作
  或对白上」，具体措辞与文风落笔时执行，不在思考里起草正文。
- 写完后：评估岔路 / 路标 / 停点。

### 5.2 `src/flow-templates.ts` + `assets/flow/round-cards.json`

- `open` 卡：「把自己当成一位资深作家，发挥强大的剧情构思能力，肆意展现你的文笔」→
  「进入演出：按第一条未完成的演，一段一段交（`draft_append`，一个自然段就交）。
  正文只在稿纸上诞生。文风按系统 `# 文风基准` 执行。」
- `review` 卡：
  - ② 「发挥自己职业作家的水平」→ 删除，改为「思考这一段剧情往哪走、人物此刻的
    状态与下一步的抉择」；
  - ③ 「全力构思文笔：倾尽所有的……镜头、动作、感官细节、神态情绪、节奏、点睛」→
    「按 `# 文风基准` 构思这一段怎么演：这段发生什么、落在哪个画面 / 动作 / 对白上」。
- 两处文件必须逐字同步（`test/flow-templates.test.ts` 有比对）。

### 5.3 `src/stage/engine.ts:1444` 零思考门禁文案

现状：「这一段的**戏与文笔**要在落笔前想清楚：镜头从哪开、动作怎么拆……」→
改为：「这一段要在落笔前想清楚：发生什么、动作怎么推进、人物此刻的状态与反应、
有没有一个细节立住这一段（文风按 `# 文风基准` 执行）。」

## §6 语义评审改造

### 6.1 `src/stage/review.ts`

- 第三维从「文风与 AI 味」改为「**文风一致性**」：
  > 文风一致性：现稿读起来是否像【文风基准】里的那个声音（叙述姿态、句子节奏、
  > 用词倾向）；跑出反例原型（分镜腔 / 散文腔 / 流水账腔）即按严重度报问题。
- `buildReviewPrompt` 的材料从「【文风要求】= B 层 styleTexts 原文」改为
  「【文风基准】= 文风卡全文」。
- 评审 system prompt 里不再自己定义「明显 AI 腔」清单，改为「对照【文风基准】判断」；
  「宁漏勿误」与证据/改法要求不变。

### 6.2 门禁与修复

沿用现有机制：major 并入 `pendingViolations`、同一修复卡、`reviewEvidenceOf` 证据过滤、
3 轮安全阀。改的只是评审基准，不是门禁流程。

## §7 预设侧处理

1. 内置拆层表命中（`liyuan-custom` / `tgbreak` / `shuangren` / `xiajin` / `dreamwhale`）时，
   `presetResidentB` 不再拼多个 B 块原文，而是输出该预设对应的文风卡。
2. 未知预设：B 层先走四类兜底（行为不回退）；文风卡回退默认卡。LLM 抽卡后置。
3. `liyuan-Custom` 的专用卡直接从现有 B 层抽：
   - 声音：「你写的是给人读的中文长篇叙事；不是分镜脚本、散文诗或流水账。」
   - 反例原型：分镜腔（「镜头从门口推到窗边。她抬头。他转身。」）、
     散文腔（「看落日把海面烧成一片滚烫的金。」）、
     流水账腔（「他先去咖啡厅。再去事务所。下午去港区。五天后回来。」）。
   - 正例取「写作·常开纪律」里已有的完整丰腴段落（或新写一段同场景）。

## §8 实施步骤（建议顺序）

| 步骤 | 内容 | 涉及文件 |
|---|---|---|
| P0-1 | 起草默认文风卡 + liyuan-Custom 专用卡 | `assets/flow/style-baseline.json` |
| P0-2 | harness 去文风化 | `assemble.ts` / `flow-templates.ts` / `round-cards.json` / `engine.ts` |
| P0-3 | 加载链 + 配置覆盖 | `src/style-baseline.ts` / `src/types.ts` / `src/stage/materials.ts` / `liyuan.config.example.json` |
| P0-4 | 语义评审引用文风卡 | `src/stage/review.ts` |
| P1 | 预设 B 层抽卡（内置表命中时输出卡而非原文） | `src/preset-split.ts` / `assets/flow/split-tables.json` |
| P2 | LLM 离线抽卡（未知预设通解） | 后置，不在本草案范围 |

## §9 验收

1. 单测：`test/flow-templates.test.ts`、`test/flow-split-tables.test.ts`、`test/review.test.ts`
   同步更新；新增 `test/style-baseline.test.ts` 校验「harness 文风词零命中」与数据文件/兜底一致。
2. 冒烟：`PORT=7621` 起服务，主聊天跟踪（`chatTrace`）确认送模提示词中
   `assemble` / 轮次卡不再出现「镜头 / 点睛 / 资深作家 / 文笔 / 肆意 / 倾尽」。
3. 实弹：同会话同模型（deepseek-v4-pro）同过渡拍，对照 trace 看「滚烫的金」类
   散文腔是否被文风卡压住；若仍出现，改的是卡里的反例，不再改 harness。

## §10 对账

| 文件 | 动作 |
|---|---|
| `docs/DESIGN-style-baseline.md` | 本文档 |
| `assets/flow/style-baseline.json` | 新增：默认卡 + 预设卡 |
| `src/style-baseline.ts` | 新增：类型 + 内嵌兜底 + 加载/覆盖 |
| `src/types.ts` | `RpConfig.styleBaseline` 段 |
| `src/stage/materials.ts` | 加载文风卡，进 `StageMaterials` |
| `src/stage/assemble.ts` | `# 怎么演这一拍` 去文风化；加 `# 文风基准` 分节 |
| `src/flow-templates.ts` | `open` / `review` 卡去文风化 |
| `assets/flow/round-cards.json` | 同上，逐字同步 |
| `src/stage/engine.ts` | 零思考门禁文案去文风化 |
| `src/stage/review.ts` | 文风维度改对照文风卡 |
| `src/preset-split.ts` | P1：内置表 B 层抽卡 |
| `liyuan.config.example.json` | `styleBaseline` 示例 |
| 测试 | `test/style-baseline.test.ts` 新增；相关测试同步 |

## 当前实施范围

- 2026-08-15 已落地 P0-1~P0-4：文风卡数据文件与加载链（`assets/flow/style-baseline.json` /
  `src/style-baseline.ts` / `src/types.ts` / `src/stage/materials.ts` / `liyuan.config.example.json`）、
  harness 去文风化（`src/stage/assemble.ts` / `src/flow-templates.ts` /
  `assets/flow/round-cards.json` / `src/stage/engine.ts`）、语义评审对照文风卡
  （`src/stage/review.ts`）、测试与冒烟（`test/style-baseline.test.ts` + 相关同步）。

## 待办

- P1：预设 B 层抽卡（内置表命中时输出文风卡而非原文堆叠）——未经用户点名不得实施。
- P2：LLM 离线抽卡（未知预设通解）——未经用户点名不得实施。
