# 流程配置外置（DESIGN-flow-config）

> 2026-08-13 落地。把主聊天流程里的硬编码类别（轮次卡文案 / 预设拆层表 / 回合意图正则）外置为数据文件 + 配置覆盖，改文案与规则不再动代码。

## §1 目标与范围

用户裁决（2026-08-13）：外置「提示词 + 拆层表」；载体 = 全局配置（`liyuan.config.json` 新增段）；turn-intent 正则**仅外置不动逻辑**（当前无调用点，见 §4）。

外置三件事：

| 类别 | 数据文件（正式源） | 配置覆盖 | 代码兜底 |
|---|---|---|---|
| 轮次卡 7 张文案 | `assets/flow/round-cards.json` | `flowTemplates` | `src/flow-templates.ts` DEFAULT_ROUND_CARDS |
| 预设拆层表 5 张 | `assets/flow/split-tables.json` | `splitTables` | `src/preset-split.ts` BUILTIN_SPLIT_TABLES |
| 回合意图正则 | — | `intentRegex` | `src/turn-intent.ts` DEFAULT_* |

**不在范围**：`assemble.ts` 的 system 分节/注入块（结构性组装，外置收益低）；`draft.ts` 的检查项（禁词/阈值/开关已由预设文本驱动，剩余解析模式属程序逻辑）。

**数据源优先级**（每拍素材现读，改文件/改配置下一拍生效）：数据文件（assets/flow/*.json）→ 代码内嵌默认（文件缺失/损坏兜底）→ 配置覆盖（`liyuan.config.json` 段）。

## §2 轮次卡模板（flowTemplates）

### 2.1 数据形态

```json
{ "key": "plan", "title": "【第 1 步·规划】", "body": "你还没有落笔、也还没有计划。……{wordRangeHint}。……" }
```

- `key`：程序判定键，固定 7 个——`plan` / `open` / `fix` / `curtain` / `review` / `extend` / `seal`（对应：规划/开工/修复/谢幕/演段回看/续写/收笔评估）。
- `title`：卡名（**含【】**）。两处使用：渲染时作为前缀；引擎替换语义（`engine.ts` agentLoop 推新卡前按 title 前缀匹配移除旧卡，防历史累积）。**改 title 不影响判定**（判定看 key），但同名冲突会让替换语义误删——保持唯一。
- `body`：模板正文，占位符 `{name}` 由引擎按工作区状态填充。

### 2.2 占位符清单

| 占位符 | 出现的卡 | 填充来源 |
|---|---|---|
| `{wordRangeHint}` | plan | 有字数区间时为「，本拍总字数约 X–Y 字，列路标时把字数分配到每一步（几步就分几份，心里有数）」，无则空 |
| `{violationsCount}` | fix | 未修违规条数 |
| `{violations}` | fix | 违规清单逐行 `- …` |
| `{statusBarTail}` | curtain | 有状态栏标签时为「然后输出状态栏（…）等格式块——状态栏意味着本拍结束，输出完即停」，无则「没有格式块要输出就直接停笔」 |
| `{appendsCount}` | review | 已交段数 |
| `{userName}` | review / extend / seal | 用户角色名（config.userName） |
| `{draftBodyChars}` | extend | 当前正文实际字数 |
| `{wordRangeMin}` / `{wordRangeMax}` | extend | 字数区间上下限 |

未知/缺失占位符**保留原样**（宁可露馅不丢上下文）。

### 2.3 覆盖语义

`liyuan.config.json` 的 `flowTemplates` 数组按 `key` 同名覆盖；**只改不删**——配置删掉的 key 用内嵌默认补回（流程信号不缺）。引擎不识别新 key（出卡判定在代码里），故新 key 不追加。

```json
"flowTemplates": [
  { "key": "seal", "title": "【收笔评估】", "body": "自定义收笔文案……{userName}" }
]
```

**状态判定逻辑（哪张卡/何时注入）仍在 `engine.ts` roundCardFor**——外置的是文案不是流程。

## §3 预设拆层表（splitTables）

### 3.1 数据形态

`assets/flow/split-tables.json` 的 `tables` 数组，5 张内置表（顺序即 `BUILTIN_SPLIT_TABLES`：0=liyuan-custom, 1=tgbreak-v2, 2=shuangren-v10, 3=xiajin-v2, 4=dreamwhale-v5）。字段与 `src/preset-split.ts` 的 `PresetSplitTable` 一致，唯二差异：

- **RegExp 字段字符串化**：`blocks[].stripLines`、`blocks[].segments[].match`、`vars[].stripLines` 存正则源文本，加载时 `new RegExp` 编译；非法正则跳过该规则（宁漏勿伤）并进加载警告（引擎按内容去重播报一次）。
- `nature` 存 A–I 字符串（TAXONOMY §1 九性质），`fate` 存 `resident/skill/rules-only/drop`。

### 3.2 覆盖语义（增改不删）

`liyuan.config.json` 的 `splitTables` 数组按 `key` 与内置表**合并**（`resolveSplitTables`，src/preset-split.ts）：

- `fingerprints`：覆盖提供了才替换，缺省继承内置（认表不破）。
- `blocks` / `vars`：按 `name` 合并——同名替换、新名追加、内置全保留。
- `supplements`：覆盖提供了才替换，缺省继承内置。
- 新 key（内置没有）直接追加为自定义表；结构非法（字段类型错）整表弃用。

```json
"splitTables": [
  { "key": "tgbreak-v2", "blocks": [ { "name": "👻TG推荐文风", "nature": "B", "fate": "resident", "section": "B" } ] }
]
```

## §4 回合意图正则（intentRegex）

`liyuan.config.json` 的 `intentRegex` 段覆盖 `src/turn-intent.ts` 的 WANTS_STORY / PURE_OPS 正则清单（字符串数组，加载时 `join("|")` 编译，`i` 标志）：

```json
"intentRegex": { "wantsStory": ["继续", "续写"], "pureOps": ["改配置", "换模型"] }
```

**注意：当前无调用点**——`shouldApplyStoryPreset` 是预留接口，尚未挂进回合流程（2026-08-13 核实仅定义处命中）。本段外置仅完成「声明 + factory 支持 + 示例」，为将来激活（办事轮跳过剧情预设装配）铺路；激活属于流程行为变化，需另行裁决。`createIntentClassifier(opts)` 与 `intentOptionsOf(config)` 即激活时的接线口。

## §5 加载时机与失败兜底

- 加载点在 `src/stage/materials.ts` `loadStageMaterials`（每拍素材现读）——改 JSON / 改配置**下一拍生效**，无热重载缝隙。
- `assets/flow/*.json` 缺失或损坏 → 回退代码内嵌默认（内容与 JSON 逐字一致，测试兜底：`test/flow-templates.test.ts`、`test/flow-split-tables.test.ts` 做逐字比对，**改文案必须两处同步**）。
- 配置覆盖里非法项（结构错/正则编译失败）→ 单项跳过，不炸整拍；加载警告经 engine `flowWarnings` 按内容去重播报一次。

## §6 实施对账（2026-08-13）

| 文件 | 动作 |
|---|---|
| `assets/flow/round-cards.json` | 新增（7 张卡模板） |
| `assets/flow/split-tables.json` | 新增（5 张拆层表） |
| `src/flow-templates.ts` | 新增（RoundCardTemplate / fillTemplate / renderRoundCard / titlesOf / resolveRoundCardTemplates / loadRoundCardsFile） |
| `src/preset-split.ts` | 加 normalizeSplitTable / loadBuiltinSplitTables / resolveSplitTables；findSplitTable 接受表列表参数；RegExp 字段字符串兼容 |
| `src/turn-intent.ts` | 正则拆数组 + createIntentClassifier / intentOptionsOf factory；shouldApplyStoryPreset 行为不变 |
| `src/types.ts` | RpConfig 加 flowTemplates / splitTables / intentRegex 三段 + 三个配置类型 |
| `src/stage/engine.ts` | roundCardFor 模板化（状态判定保留）；替换语义前缀改读模板 title；flowWarnings 播报 |
| `src/stage/materials.ts` | 加载合并 roundCards / splitTables，进 StageMaterials |
| `liyuan.config.example.json` | 三段示例 |
| 测试 | test/flow-templates.test.ts（9）、test/flow-split-tables.test.ts（5）、test/turn-intent.test.ts（4）新增；preset-split / stage-engine / stage-assemble 基线不破；全量 832 过 / 11 挂（与基线一致） |
