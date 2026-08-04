# PLAN-RP-TOOLING：全盘工具化（M-D 契约）

> 2026-08-04 定稿。前置：M-A/M-B/M-C/M-C2 已完成（452/452 绿，全部未提交）。
> 用户定案：**M-D = 全盘工具化——梨园的各个板块（数据库/向量库/角色库/世界书）都要成为
> agent 可自由操控的工具**；且**三套工具注册表必须合一**（用户 2026-08-04 明示「得动架构」）。
>
> ⚠ 定位纪律（承接 EXEC §5）：M-D 对「演得好」影响不大，**不能拿它当思考问题的判据来源**。
> 思考问题已在 M-C2 收口。M-D 的目标函数是**能力覆盖**，不是思考量。

## 0. 现状核对（2026-08-04 实测，动手前的事实基线）

### 0.1 三套注册表，服务不同消费者，形状彼此不兼容

| 注册表 | 服务谁 | 数量 | 工具形状 | 依赖获取方式 ||---|---|---|---|---|
| `src/stage/tools.ts` | **台上 RP agent**（真实生成路径 `StageEngine`，server/main.ts:1976） | 10 | 纯数据 schema（裸 JSON Schema）+ `runStageTool()` 集中派发 | **依赖注入**（`StageToolDeps`），可离线单测 |
| `server/assistant.ts` | 幕后助手（配置/管理对话） | 22 | `defineTool({...execute})` typebox | **闭包捕获** `cwd/bridge/hooks` |
| `.liyuan/extensions/roleplay.ts` | 旧扩展路径 | 18(20 处注册) | `pi.registerTool({...execute})` typebox | **pi 运行时副作用注册** |

**关键差异（决定合并难度）**：
- stage 是**纯数据 + 注入**，`src/` 层**刻意不依赖 typebox**（tools.ts:24 有注释写明）；
  assistant / roleplay 都直接 `import { Type } from "typebox"`。
- stage 用**集中 `if (name === ...)` 派发**；另两套是**每工具自带 execute 闭包**。
- **合并的地基应当是 stage 的形状**（纯数据 + 注入 + 可单测），让另两套向它靠，
  而不是反过来——否则 `src/` 会被拖进 typebox 依赖，且失去离线单测能力。

### 0.2 重复实现（同名工具多处各写一遍）

| 工具 | stage | assistant | roleplay |
|---|---|---|---|
| `lorebook_search` | ✔ | ✔ | ✔ |
| `world_state_get` / `memory_search` / `world_state_update` | ✔ | — | ✔ |
| `lorebook_write` / `codex_write` / `panel_write` | **—** | ✔ | ✔ |

`lorebook_search` **一个工具三份实现**（返回文案、limit 默认值、无命中兜底话术各不相同）。

### 0.3 各板块工具化缺口（本里程碑的靶子）

| 板块 | 服务层规模 | 现有工具 | 缺口 |
|---|---|---|---|
| **向量库** `src/memory/` | service.ts **17 导出**（增删查改/导入文本/重嵌入/多 store 作用域/云端探针） | ~~仅 `memory_search`（只读）~~ **M-D3 已补齐**：search/add/list/delete 四件 | ~~最大缺口~~ **已合拢**（import 按 D-T3 并入 add；重嵌入/云端探针属设置面板，非模型情境） |
| **世界书** `src/lorebook.ts` | 条目 CRUD + 指纹启停 + overlay | 台上**只读**；`lorebook_write` 台上缺席 | 台上写侧缺席；**列举/启停三处全缺**（今天 MVU 禁用是硬编码，agent 自己做不到） |
| **角色库** `src/card.ts` / `personas.ts` | 22 + 13 导出 | 仅助手侧 `card_create` | 读卡/改卡/列卡库/人格**全线零工具** |
| **世界线** `src/worldline.ts` | 23 导出（存档/分叉/回溯） | 零 | 全缺 |
| **面板** `src/panels.ts` | 17 导出 | 助手+扩展有，**台上无** | 台上缺席 |
| **预设** `preset.ts`/`preset-split.ts` | 拆层去向可查 | 助手 `preset_read/toggle` | 台上看不到自己被喂了什么 |
| swipe / skills / scribe / stance | 11/8/10/2 | 零 | 待评估（未必都值得工具化） |

## 1. 设计目标与非目标

**目标**
1. **一份实现，多处消费**：同一能力只写一次，台上/幕后/扩展按需取子集。
2. **各板块可被 agent 自由操控**：向量库、世界书、角色库、世界线都有读写工具。
3. 保住 stage 的两条优点：`src/` 不依赖 typebox；工具可离线单测。

**非目标（明确不做）**
- 不追求「所有服务层导出都变成工具」——**工具是给模型用的，不是 API 镜像**。
  每个候选工具都要能回答「模型在什么情境下会调它」，答不上来就不做。
- 不拿 M-D 改善思考量（见定位纪律）。
- 不动 MCP 外部工具通道（`src/mcp.ts` 是另一套，与本次合并无关）。

## 2. 架构：统一工具层

### 2.1 分层

```
src/tools/registry.ts     工具定义（纯数据 schema + handler，零 typebox、零 pi）
   ├─ src/tools/lore.ts       世界书族
   ├─ src/tools/memory.ts     向量库族
   ├─ src/tools/card.ts       角色库族
   ├─ src/tools/worldline.ts  世界线族
   ├─ src/tools/draft.ts      稿纸族（现 workspace 执行器迁入）
   └─ …
        ↓ 三个适配器（薄，只做形状转换）
   ├─ adapters/stage.ts      → StageTool[]（裸 JSON Schema）+ 集中派发
   ├─ adapters/assistant.ts  → ToolDefinition[]（typebox，在 server/ 层转）
   └─ adapters/extension.ts  → pi.registerTool（在 .liyuan/ 层转）
```

**要点**：typebox 转换只发生在 `server/` 与 `.liyuan/` 侧的适配器里，`src/tools/` 保持纯数据。

### 2.2 工具定义形状（草案，实施时以代码为准）

```ts
export interface ToolSpec<Deps> {
  name: string;
  /** 能力域，用于按消费者取子集 */
  domain: "lore" | "memory" | "card" | "worldline" | "draft" | "state" | "panel" | "preset";
  /** 读/写——写侧工具受门禁与消费者白名单约束 */
  mode: "read" | "write";
  /** 哪些消费者可见 */
  surfaces: Array<"stage" | "assistant" | "extension">;
  description: string;               // 英文，对标现有工具
  parameters: Record<string, unknown>; // 裸 JSON Schema
  run(args: Record<string, unknown>, deps: Deps): Promise<ToolResult>;
}
export interface ToolResult { text: string; activity?: string; details?: unknown; }
```

`surfaces` 是**合一之后仍能分发不同子集**的关键——台上不该看到 `config_write`，
助手不该看到 `draft_write`。

### 2.3 依赖注入

沿用 `StageToolDeps` 的思路，扩成分域依赖包（`LoreDeps` / `MemoryDeps` / …）。
**jiti 二象性红线**：依赖里只放函数与数据，**不放模块级可变状态**；
工作区（workspace）仍由引擎持有并按拍注入，不跨边界共享。

## 3. 里程碑拆分

### M-D1：地基 + 一族垂直切片（先证明形状对）—— ✅ **已完成**（2026-08-04，464 绿，未提交；详见 §7.4）
- 建 `src/tools/registry.ts` 与 stage 适配器；
- **只迁 `lorebook_search` 一个工具**做垂直切片：三套注册表统一走新实现，
  三处消费者行为不变（文案差异需人工裁定统一版本）；
- 回归 452 绿 + 新单测（同一工具在三个 surface 上的产出一致性）。
- **验收**：~~三处~~ **两处**（台上/助手）`lorebook_search` 只剩一份实现；
  扩展那份按 D-T5 保持原样（其工具对台上不可达）；实弹一拍确认台上检索照常。

### M-D2：世界书族补全（台上写侧 + 列举/启停）—— ✅ **已完成**（2026-08-04，475 绿，未提交）
- `lorebook_write`（台上开放，走写入门禁）、`lorebook_list`、`lorebook_toggle`；
- ⚠ `lorebook_toggle` 与 M-C2 的协议禁用是同一机制（`enabled` 置位）——
  实现时复用 `disabledLore` 指纹通道，**不要另起一套**（已复用：`toggleDisabledLore()`）。

**落点**：`src/tools/gate.ts`（写入门禁）+ `src/tools/lore.ts` 三件新工具
+ `src/lorebook.ts` 抽出 `toggleDisabledLore()`（工具与 REST 共用一套语义）。

**开工即发现的阻塞（已记 M-D6 R3）**：D-T4 说「走现有写入门禁」，但那套门禁
**当时是坏的**——`GATED_TOOLS`/`WRITE_REQUEST_RE`/`lastUserText` 只用不定义
（探针实证 `creationMode:"ask"` 必抛 ReferenceError），且 `src/` 里**一处门禁也没有**。
用户定案：**把原语义搬进 `src/tools/gate.ts` 做成纯函数**（符合 D-T4「不新造权限体系」），
两侧共用且可离线单测；扩展侧那处 ReferenceError 归 M-D6 统一修，修时从本模块取。

**两条设计决定**：
- **依赖缺失的工具不上清单**（`availableSpecs()`）——工具存在却恒回「本环境不支持」
  是最糟形态，模型会反复试。故 `lorebook_toggle` 只在宿主注入 `setDisabledLore` 时出现。
- **助手面不挂门禁**：助手的每次调用都由用户当面驱动，不存在台上那种
  「演着演着自作主张写」的场景；台上才是门禁的适用场景。
- R8「台上零写入工具」正式退役（M-A 起就已不成立），台上写侧改由**门禁 + 依赖注入**双重约束。

**验证**：单测 +11（门禁三档/拦下时不碰服务层/列举只给目录/启停持久语义/依赖过滤）；
实弹两拍——拍 1 未提写入则**零写入**，拍 2 用户明确要求 → `写设定「青冥诀」`
且落盘在**补充设定集**（用户原始世界书只读不动）。

### M-D3：向量库族（缺口最大）—— ✅ **已完成**（2026-08-04，**492 绿**，未提交）

- `memory_add` / `memory_list` / `memory_delete` 三件新工具 + `memory_search` **台上/助手两面合一**
  （台上 `src/stage/tools.ts` 原有一份、助手侧此前**一件也没有**；扩展 `roleplay.ts:619`
  那份按 D-T5 保持原样不动——其工具面对台上不可达，仍不写第三个适配器）。
- **落点**：`src/tools/memory.ts` + `src/tools/gate.ts`（追加删除信号）
  + `src/stage/{tools,engine}.ts`（旧实现摘除、写侧依赖透传）
  + `server/main.ts`（台上注入）+ `server/assistant.ts`（助手面首次拥有记忆工具，
  经新增的 `StoryBridge.memoryScope()` 取作用域）。

**契约候选四件里 `memory_import` 未做**（D-T3）：对模型而言它与 `memory_add` 是同一情境
（「把这段文字存进记忆」），差别只在 metadata 与切块策略——那是 UI 与服务层的事。
多一个工具只会让模型多做一次「这算 add 还是 import」的无谓判断。

**作用域语义（本里程碑的硬前置，2026-08-04 用户拍板）**：
- `MemoryScope = {sessionId, card}` **对模型完全不可见**，由宿主按「当前对话 + 当前卡」绑定。
  单测有守卫：任何 memory 工具的 schema 都不得出现 `scope`/`sessionId`/`card` 参数。
- **写侧不给 `store` 参数**——服务层 `assertExtraStore` 对 `narrative` 硬抛（探针实证），
  合法值只剩 `external` 一个；**只有一个合法值就不该让模型选**，否则等于摆一个必然失败的选项。
- `store` 只在 `memory_list` 暴露（两库性质不同：手动录入 vs 自动生成的剧情摘要）；
  `memory_search` 沿用「合并两库取前 6」不按库拆；`memory_delete` 的归属由 list 回传。
- ⚠ **最易说谎处**：向量记忆按 `cardHash__sessionId` 隔离，写进去的东西**不跨会话**——
  与 `lorebook_write` 语义正好相反。故 `memory_add` 的描述与回执都必须钉死「只在当前对话有效」，
  并把「要跨会话留存」明确改道 `lorebook_write`（两条都有单测钉住）。

**门禁（D-T4）**：`GATED_TOOLS` 增补 `memory_add` / `memory_delete`。
关键设计：**删除认删除信号，不认写入信号**——用户说「把那条忘掉」不含任何写入词，
用 `WRITE_REQUEST_RE` 判会被错拦；反过来把删除词并进写入词集，则「删掉那条设定」
会去放行 `lorebook_write`。故 `gate.ts` 新增 `DELETE_REQUEST_RE`，`checkWriteGate` 按工具名选信号集。

**验证**：
- 单测 +17（`test/tools-memory.test.ts`）：跨 surface 一致性（命中正文逐字相同）、
  作用域守卫、写侧无 store、门禁双向（写入词不放行删除、删除词不放行写入）、
  拦下时服务层零调用、列举不静默截断。回归 475 → **492 绿**。
- **开工前置探针**（承 M-D2 教训，不信读码）：实跑服务层 8 组，候选导出全部活着
  （与 M-D2 那套已损坏的门禁不同，`src/memory/` 未被 8/02 清场波及）。
- **接线探针**：宿主注入 → 统一层 → 服务层全线打通（真落盘/真检索/真删除、
  作用域隔离、门禁两向），产物已清。
- **实弹**（TGbreak + 淫乱仙侠 + `/greeting 3`）：拍 1 未提记忆 → **零写入**（门禁生效）；
  拍 2 用户明确要求 → `写记忆「赤霄剑线索」· 1 条`，落盘条目为模型自拟标题 + 自撰摘要
  （`source=manual`，scope 正确）。**拍 3（召回）未取得**——上游连续
  `Stream ended without finish_reason`；**已用鉴别实验排除本次改动**：
  全新会话（历史无 memory 工具调用）同样失败，故为上游问题。召回能力待上游稳定后补验。

### ~~M-D3~~（原计划条目，保留供对照）
- ~~`memory_add` / `memory_import` / `memory_list` / `memory_delete`~~；
- ~~需先定**作用域语义**~~ → 已定，见上。

### M-D4：角色库 + 人格
- `card_read` / `card_list` / `card_edit`（改卡是高风险写操作，门禁与确认策略要定）；
- `persona_read` / `persona_write`。

### M-D5：世界线 + 面板台上化 + 收口
- `worldline_*`（存档/分叉/回溯——**回溯是危险操作**，先只读再议写侧）；
- 面板工具开放到台上；
- 全量回归 + 实弹；三套注册表重复实现清零对账。

### M-D6：欠账统一修复 — ✅ **已完成**（2026-08-04，**492 绿**，未提交）

| # | 欠账 | 修法 | 状态 |
|---|---|---|---|
| R1 | `/reroll <带参>` 绕过宿主拦截 → pi 裸回合 | 宿主拦截正则补 `.exec(trimmed)` 分支：`branch(userId) + appendMessage(editedText) + stage.regenerate()`，全程走 StageEngine | ✅ |
| R2 | 助手提示词 `lorebook_search` 称含「已挂载知识库」，实现不含 | `src/stagehand.ts:75` 改为「检索世界书与补充设定集（原始条目，含被台上剥离的外部插件协议条目）」 | ✅ |
| R3 | 扩展写入门禁 `ReferenceError`（GATED_TOOLS/WRITE_REQUEST_RE/lastUserText 未定义） | `roleplay.ts` 从 `src/tools/gate.ts` import 两常量；`lastUserText(ctx)` 从 `sessionManager.getEntries()` 倒序取最后一条 user 消息 | ✅ |

R1 的扩展 `/reroll` 命令处理器（`roleplay.ts:1564`）现已休眠——宿主拦截所有 `/reroll` 形式，不再漏到 pi。未删除（无关无害，且可作日后参考）。

R3 的门禁语义**从 `src/tools/gate.ts` 取**（M-D2 已搬）：`GATED_TOOLS` / `WRITE_REQUEST_RE` 与台上/助手共享同一份定义，不再有「改了一处忘了另一处」的风险。

## 4. 决策记录（本文档采用；否决请改此节）

- **D-T1 地基取 stage 形状**（纯数据 + 注入 + 集中派发），另两套向它靠。
  理由：保住 `src/` 无 typebox 依赖与离线单测（§0.1）。
- **D-T2 保留三个 surface，不强行让三方看同一份清单**。合一的是**实现**，不是清单。
- **D-T3 工具粒度按「模型的调用情境」定，不按服务层 API 镜像**（§1 非目标）。
- **D-T4 写侧工具一律走现有写入门禁**，不新造权限体系。
- **D-T5 扩展路径（roleplay.ts）的去留**：本次**只做适配器接入，不判其死活**。
  ~~它是否已是死代码需单独核实~~ **2026-08-04 M-D1 已核实：不是死代码**（见 §7）。
  用户定案：M-D1 **不写第三个适配器**——扩展的 18 个工具对台上不可达，
  唯一的可达破口 `/reroll <带参>` 是路由缺陷（记为待办，见 §7），该修的是路由不是工具。

## 7. 开工前置核实结论（2026-08-04 M-D1 实测，修正 §6/D-T5 的猜测）

### 7.1 `.liyuan/extensions/roleplay.ts` 是活代码——加载是**隐式**的

§6 曾猜「main.ts 未见显式加载点」。真相：
- `server/main.ts:183` `createAgentSessionServices({cwd})` **内部**自建 `DefaultResourceLoader`，
  未传 `resourceLoaderOptions` → `noExtensions` 取默认 `false`（`resource-loader.ts:232`）。
- 扫描目录不是 `.pi` 而是 **`.liyuan`**——`packages/coding-agent/package.json:6-8` 把
  `piConfig.configDir` 改名成了 `.liyuan`，故 `.liyuan/extensions/roleplay.ts` 被自动发现。
- 硬证据：`server/main.ts:1110` 调 `session.prompt("/rprefresh")`，而 `rprefresh` **只**注册在
  `roleplay.ts:2017`——没加载这行必报未知命令。

### 7.2 但「加载了」≠「模型见得到那些工具」——分三层

| 面 | 状态 |
|---|---|
| 21 个 `registerCommand` | **活**（`/rewind` `/import` `/state` 等经 `main.ts:2146` 走 pi 会话） |
| 3 个 `pi.on` 钩子 | **活** |
| 18 个 `registerTool` | 台上 `stage.performTurn` 完全绕开 pi 会话 → **对 RP 生成实际上是死的** |

⚠ **残存的第二叙事路径（待办，不属 M-D 范围）**：宿主拦截正则 `^\/reroll\s*$`
（`main.ts:2092`）只吃**无参** reroll；**带参**落到 pi → `roleplay.ts:1578`
`pi.sendUserMessage()` → `agent-session.ts:1403` `prompt()` → **真跑一次 LLM 回合**，
活跃工具集是 `RP_TOOLS`。而 `roleplay.ts:1489` 注明「harness 生成流程已整体移除」——
这一拍**没有台上装配**（无预设拆层/无工作区/无验收器）。前端 `web/src/App.tsx:1180`
编辑用户消息即发此帧。判断：M-B/M-C 换引擎后遗留的路由破口，该由宿主改道 StageEngine 修，
不该靠给扩展补工具救。

### 7.3 三份 `lorebook_search`：没有一份是另外两份的超集

底层同调 `searchEntries`（`src/lorebook.ts:482`），**差的是语料**：

| | stage | assistant | roleplay |
|---|---|---|---|
| 外部插件协议剥离（M-C2） | ✔ | ✘ | ✘ |
| 挂载知识库 codex | ✘ | ✘ | ✔ |
| 中文别名 `withAliases` | ✘ | ✘ | ✔ |
| limit | 硬编码 3 | 默认 5，钳 [1,20] | 硬编码 3 |

另有两处**描述与实现不符**：`src/stage/tools.ts:59` 与 `src/stagehand.ts:75` 都承诺
「已挂载知识库」，而两侧实现从不加载 codex。

### 7.4 M-D1 落点（2026-08-04，464/464 绿，未提交）

- `src/tools/registry.ts`（地基：`ToolSpec`/`ToolContext`/`toolsFor`/参数清洗，零 typebox）
  + `src/tools/lore.ts`（**唯一一份** `lorebook_search`）
  + `src/tools/adapters/stage.ts`、`server/tool-adapter.ts`（两个适配器）。
- **语料差异归依赖注入**：台上注入「世界书+overlay+协议剥离+**挂载知识库**」
  （补齐 codex，兑现描述；`codexNamesFromBranch` 落在 `assemble.ts`，与
  `main.ts:1206`/扩展 `restoreCodexFromBranch` 同规则）；
  助手注入**原始**世界书（**不剥协议**——用户定案：助手是诊断面，
  用户问「我的卡为什么带 UpdateVariable」时它必须看得见）。中文别名留后续里程碑。
- **话术按面裁剪但同住一文件**（D-T2 的落地形态）：台上给「查不到＝未被写下，可自行创造」
  的授权，助手给语料规模与命中回声；台上不开 limit（配额固定好控预算），助手开。
- 单测 `test/tools-registry.test.ts` 11 条：跨 surface 产出一致性（命中正文逐字相同）、
  差异是有意的、limit 钳制、容错不抛、**D-T1 红线守卫**（扫 `src/tools/` 禁 import typebox）。
- 实弹一拍（TGbreak + 模拟修仙2 + `/greeting 3`）：`查设定「补气丹 丹药 凡人 炼化」· 3 条`
  与 `· 无命中` 两条路径都实录，正文零协议污染。**只验能力不验思考量**（定位纪律）。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| 三套文案不一致，合并时选错版本导致行为回退 | M-D1 垂直切片阶段逐条人工裁定；单测钉死产出 |
| `src/tools/` 引入 typebox 破坏离线单测 | 适配器边界强制：`src/` 内禁 import typebox（可加 lint/测试守卫） |
| 写侧工具放开后模型误改用户数据 | D-T4 门禁；高风险操作（改卡/回溯世界线）先只读或加确认 |
| jiti 二象性复发 | 依赖只传函数与数据；工作区不跨边界（§2.3） |
| 合并期间回归面过大 | 一族一迁，每族回归绿了再下一族 |
| M-D 被误当思考问题的判据 | 定位纪律写在文首；实弹只验能力不验思考量 |

## 6. 开工前置（下窗口第一件事）

1. 核实扩展路径 `.liyuan/extensions/roleplay.ts` 是否仍被加载（D-T5）；
2. 确认 `lorebook_search` 三份文案的统一版本（需用户或我裁定）；
3. 本文档 §3 里程碑顺序按缺口排（向量库 > 世界书 > 角色库 > 世界线），
   但 **M-D1 垂直切片先用 lorebook_search**（它是唯一三处都有的工具，最能验证形状）。
