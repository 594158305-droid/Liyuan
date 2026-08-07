# DESIGN: story_edit 助手改稿工具

> 设计稿（2026-08-07）。实现顺序见 §8；行号以各文件当前实际内容为准，本稿中的行号为调查时点位，仅作定位参考。

## 0. 定位

把既有的 `rp-edited-reply` 例外通道（现仅"用户手改"走）扩展为**助手代用户改稿**：显式授权、分支树提交、原文可回滚、改后重记账、UI 带标记。

红线**不改语义，只改表述**——自动路径"正文=模型原始输出"不变；改稿是带标记的显式操作。从"每个字都是模型写的"软化为"每个字都有出处"。

## 1. 红线文本改写（9 处，不是删除）

统一新表述：

> 剧情正文：自动路径永远是模型原始输出；显式改稿（用户手改 / 助手经 story_edit 且征得用户同意）走 rp-edited 分支条目，带标记、原文可回滚。

| # | 文件 | 现状要点 | 改动 |
|---|---|---|---|
| 1 | `AGENTS.md:35-37` 产品红线 | 绝不改写/补写正文 | 补充 rp-edited 显式例外 |
| 2 | `README.md:51` | "你读到的每一个剧情字，永远只出自剧情模型" | 改写为"显式改稿除外，UI 有标记" |
| 3 | `README.md:66` | "界面直接改写正文"列为不兼容项 | 调整为"经 UI 的显式改稿受支持（带标记），脚本直改正文仍不兼容" |
| 4 | `README.md:128` | D10 红线重申 | 同步补充 |
| 5 | `roleplay.ts:1-8` 文件头 | 红线声明 | 同步补充 |
| 6 | `server/assistant.ts:12` | "工具面不存在任何写剧情正文的通道" | 改"除 story_edit（须显式同意）外无通道" |
| 7 | `src/stagehand.ts:12,40,55-57` | 助手"唯一不能做的一件事"条款；**:57"用户要求改上一轮→正确动作是调整生产条件或让用户自己改"（与 story_edit 直接冲突）** | 改写为"经 story_edit 改，先征得同意"；工具描述钉死"仅当用户已明确要求改稿" |
| 8 | `src/director.ts:8` | 剧情正文红线（PLAN §7 分工红线） | 同步补充 |
| 9 | `server/wire.ts:7,13` | "narrative 通道文本必须是主演模型原始输出" | 补充"rp-edited 例外：经显式改稿的回复带 edited 标记" |

原则：**自动路径的承诺不变**，只是为"用户授权的改稿"开一个带标记的例外口子。

## 2. story_edit 工具规格

- **注册**：`server/assistant.ts:263` `createStagehandTools` 内照 `story_command` / `world_write` 模式加 `defineTool`。
- **签名**：

  ```
  story_edit({
    target: number,   // lastRoleIndex：从分支末尾倒数第 N 条角色消息（assistant/custom），默认 0 = 最后一条
    text: string,     // 改后全文（助手直接产出修订稿，一次成型）
    confirm: boolean  // 必须 true；工具描述钉死"仅当用户已明确要求改稿时使用"
  })
  ```

- **约束**：
  - 目标须是 assistant/custom 角色消息（与 `scriptEditMessage` 的 lastRoleIndex 语义一致，`main.ts:1442`）；
  - greeting / backstage / 戏外轮不在此工具范围；
  - 门禁靠提示词（stagehand.ts）+ `ask_user`（assistant.ts:306）双保险：助手想主动改时先 `ask_user` 征得同意；工具本身不做强制门禁（信任模型 + 原文可回滚兜底）。

- **为何助手产出全文而非"指导重写"**：改稿是单次定向操作；助手已有全局视角（StoryBridge 只读侧），一次产出、一次提交，最省上下文。

## 3. StoryBridge 新方法

```ts
storyEdit(input: { lastRoleIndex: number; text: string }): Promise<{ ok: boolean; error?: string }>
```

- 接口定义：`server/assistant.ts:94-133` StoryBridge 接口内新增。
- 实现体：`server/main.ts:1526-1591` storyBridge 闭包内（所有桥方法都是闭包直捕 `session`，照抄此模式）。
- **提交语义：照 `scriptEditMessage`（main.ts:1429-1481），绝不照 `/editreply` 的 navigateTree** —— main.ts:1467 注释的教训："navigateTree 对 user/assistant 目标有副作用语义（实测导致分支回退到开场白、改写丢失）"。
  - `sm.branch(targetId)` 直钉（同步叶指针，无 session_tree 事件、无 editor 副作用）；
  - `session.sendCustomMessage({ customType: "rp-edited-reply", content: text, display: true })`；
  - append-only：原回复保留在树里，不覆盖原文；
  - 不触发 session_tree → 世界状态快照不回退（与用户手改 /editreply 的行为差异是有意为之：改稿不应当连带回退账本）。

## 4. 关键难点：改稿后重记账

**问题**：`sm.branch` 直钉不产生 agent_end / context 事件，场记（roleplay.ts:1630）不会自动触发；且**不能**用 `queueStoryCommand` 触发（assistant_run 执行期间故事侧在 waitForIdle，命令排队 = 死锁）。

**方案**：`storyEdit` 桥实现内直接旁路记账：

1. 提交前等在途场记归位（`waitForScribe` 等价物，roleplay.ts:1780；该函数在 roleplay.ts 闭包内，main.ts 拿不到——需要把"场记在途状态/等待"以轻量方式暴露给 main.ts，见 §4.1）；
2. 提交后（叶已移）：
   - `import { buildScribeTurnPrompt, parseScribeResult } from src/scribe.ts`（纯函数零 pi 依赖，`scribe.ts:1-6`）；
   - 经 main.ts 侧 modelRegistry 旁路调用（照 roleplay.ts `sideComplete` 模式，roleplay.ts:450-476）；
   - `applyPatch` → `saveState` + `snapshotState`（照 /import 模式 roleplay.ts:2425-2442）；
   - **快照必须在编辑后的新叶位置写**（编辑后叶已移到目标回复的前驱，注入的 rp-edited-reply 是新叶内容的一部分）。

### 4.1 跨模块暴露（实现时现场确认）

`waitForScribe` / `sideComplete` 都在 roleplay.ts（接线层）闭包内，main.ts 无法直接调用。两条可选路径：

- **路径甲（推荐）**：在 roleplay.ts 暴露一个轻量模块级导出（如 `export function waitForScribeIdle(): Promise<void>` 与旁路记账封装 `export async function scribeTurn({userText, assistantText})`），经 globalThis 网关（照 `src/assistant-gateway.ts:7-10` 的 jiti/ESM 双模块规避模式）挂载，main.ts 侧读取调用；
- **路径乙**：main.ts 自建旁路模型通道（modelRegistry 在 rest.ts 侧，main.ts 是否可直接拿到需现场确认；若无现成通道则经 restHost 补一个旁路 complete 接口）。

> 实现要点：记账内容必须与"编辑后的叙事位置"一致——把被编辑轮的用户消息 + 改后回复作为输入喂给 buildScribeTurnPrompt。

## 5. UI 标记（改稿与原文可区分）

- `server/wire.ts`：WireMsg（93-163）增加 `edited?: boolean`；
- `server/wire.ts:975-979`：rp-edited-reply 转换时置 `edited: true`（现有 customType 判断分支处）；
- `web/src/components/Messages.tsx`：照 `chip-unfinished`（1290-1297）模式加 `chip-edited`「已改写」徽标；气泡 class 可加 `msg-edited`；
- 前端"编辑"按钮路径（App.tsx:1164-1203 用户手改）保持不动。

## 6. 压缩摘要修正（调查发现的隐藏问题）

`compaction.ts:68-91` 的 `serializeForSummary` 只序列化 user/assistant/greeting —— **rp-edited-reply 是 custom 类型会被滤掉**，改稿后的正文会从压缩摘要里消失。

必改：`serializeForSummary` 将 rp-edited-reply 按 assistant 正文纳入（或先经 roleplay.ts:1486 的转换逻辑再序列化）。

## 7. 与既有机制的交互（已确认语义）

| 机制 | 行为 | 说明 |
|---|---|---|
| 世界线 /back | 改稿条目不跟随回档（append-only，原回复保留树内） | `sm.branch` 直钉不触发 session_tree，快照不回退 |
| 压缩 | 摘要须包含改后正文 | §6 修正 |
| 场记 | 改后显式重记账 | §4 |
| swipe | 不改（rp-edited-reply 无 swipe 列表） | 现状保持 |
| 角色卡/世界书 | 无交互 | — |

## 8. 实施顺序与验证

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 | 红线文本改写（§1 的 9 处，stagehand.ts:57 冲突条款优先） | 无功能变更，diff 走查 |
| P1 | StoryBridge.storyEdit + main.ts 提交与重记账（§3+§4） | 手动起服务：助手改稿→查分支树/账本/快照位置 |
| P2 | story_edit 工具注册 + 提示词同意门禁（§2） | 剧本：用户要求改稿→成功；助手主动改→先 ask_user |
| P3 | wire edited 字段 + UI「已改写」徽标（§5） | 改稿后前端可见标记 |
| P4 | serializeForSummary 纳入 rp-edited-reply（§6） | 改稿后压缩→摘要含改后正文 |

仓库无测试保障（AGENTS.md：`npm test` 匹配 0 个文件），P1 起每阶段手动起服务验证；重点回归：`/back` 回档、swipe、场记快照位置、assistant_run 期间无死锁。

## 9. 已知风险

- **模型通道**：main.ts 侧旁路模型调用通道（§4.1 路径乙）需现场确认，无则经 restHost 补；
- **门禁依赖模型自觉**：confirm 非强制，靠提示词 + ask_user + 原文可回滚兜底；
- **行号漂移**：wire.ts / Messages.tsx 疑似近期格式化，行号以内容锚点为准。
