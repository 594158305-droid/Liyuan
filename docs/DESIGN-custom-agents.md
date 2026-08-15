# DESIGN: 自定义 agent（声明式子 agent 能力）

> 设计稿（2026-08-07）。前置：docs/DESIGN-story-edit.md（story_edit 已落地，本文复用其桥接缝）。行号以各文件当前实际内容为准。

## 0. 定位：自定义 agent 是什么、不是什么

**是**：用户可在配置中声明式定义额外 agent（名称 / 模型 / 提示词 / 工具白名单 / 桥权限 / 会话目录），与剧情模型、内置助手并列运行；剧情 agent 可经 `assistant_run` 工具（加 `agent` 参数）把系统事务委托给任意自定义 agent。

**不是**：pi 式进程内 sub-agent 派生（pi 官方明确不内置 sub-agent，梨园 fork 同样无此 API）。梨园的"子 agent"= 同进程内独立完整会话（与现有助手同一模式），每个 agent 拥有独立会话树、独立模型、独立上下文。

**与助手的关系**：内置助手重构为"第一个内置 agent 实例"（id: `assistant`），现有全部行为保持兼容；story_edit 是它桥上的既有权限接口（DESIGN-story-edit §3），同一套桥权限模型扩展到所有 agent。

## 1. 核心架构决策

| 决策点 | 方案 | 理由 / 证据 |
|---|---|---|
| 宿主 | `createAssistantHost`（assistant.ts:1080）**泛化为 `createAgentHost` 工厂**，内置助手为默认实例 | assistant.ts:1080 已是完整可参数化的会话宿主（build 三态 1346-1401、模型 1404-1430、绑定 1657-1692） |
| 会话目录 | 每 agent 独立目录：新增 agent 用 `.liyuan-agents/<id>/`；**内置助手保持 `.liyuan-assistant/` 不迁移** | 现有助手会话数据（平铺 jsonl）不能丢；新增目录零迁移成本 |
| 委托链路 | 网关（src/assistant-gateway.ts）单一 runner slot 改 **name→runner 注册表**；roleplay `assistant_run` 工具加 `agent?: string` 参数（缺省=assistant） | assistant-gateway.ts:51-59 的 globalThis 单 slot 结构；roleplay.ts:1134-1185 现硬编码唯一助手 |
| 桥权限 | storyBridge 单对象（main.ts:1526-1591）改 **`createStoryBridge(permissions)` 工厂**，每 agent 按权限裁剪 | 写方法 6 个（queueStoryCommand/applyStatePatch/writePanels/emitStoryMedia/refreshStoryMaterials/mountCodex + storyEdit），只读方法 8 个 |
| 工具面 | `createStagehandTools`（assistant.ts:263）加 `allowTools` 白名单参数，按 agent 配置过滤 | 与既有 `config.backendControl === false → noTools:"builtin"`（assistant.ts:1377）开关模式同构；sdk.ts 原生支持 `tools` 白名单（sdk.ts:244-250） |
| 世界线归属 | **v1 只支持「叙事外」agent**（ops 类，不进世界线，语义=现有助手）；「叙事内」agent（进世界线/快照/回档）列为 v2 | 叙事内需扩展 worldline 快照体系（现只对剧情会话树条目），回档/双写一致性风险高；v1 先吃低风险面 |
| 并发 | 委托保持**同一时刻最多一个**（delegateDepth 全局布尔沿用，assistant-gateway.ts:70-82） | 多 agent 并发委托需按 agent 隔离 delegate 状态，v1 不做，简单安全 |
| 配置 | `liyuan.config.json` 新增 `agents: AgentConfig[]` 段；`CONFIG_EDITABLE` 白名单（rest.ts:410-430）加键；/rprefresh 热载 | 配置加载/校验/热更新链路现成（rest.ts:382-385,432-465；main.ts:1146-1165） |

## 2. AgentConfig 配置 schema

```jsonc
// liyuan.config.json 新增段
"agents": [
  {
    "id": "director",                     // 唯一 id（小写连字符），委托时引用
    "name": "导演",                       // 面板显示名
    "description": "剧情规划与节奏把控",   // 显示在 agent 选择器
    "model": { "provider": "deepseek", "id": "deepseek-chat" },  // 可选；缺省跟随剧情模型（同助手 syncFollowModel 语义）
    "prompt": "你是梨园的导演……",          // systemPrompt 全文；或 "promptFile": ".liyuan-agents/director.md"
    "skills": [],                          // 可选：可见技能白名单（复用 skills 机制）
    "tools": ["story_read", "lorebook_search", "story_edit", "panel_write", "ask_user", "return_answer"],
    "bridge": {
      "readStory": true,      // storyMessages / snapshot / worldState / cardName / listModels
      "writePanels": false,
      "storyEdit": false,
      "queueCommand": false,  // 危险：可触发剧情侧任何斜杠命令，默认 false
      "applyStatePatch": false,
      "emitMedia": false,
      "refreshMaterials": false,
      "mountCodex": false
    }
  }
]
```

校验（照 `applyConfigPatch` 模式，rest.ts:432-465）：`id` 必填唯一、`/^[a-z][a-z0-9-]*$/`；`tools` 必须是已知工具名；`bridge` 键白名单；`prompt` 与 `promptFile` 二选一；非法配置整段拒绝并报错（不静默丢弃）。

## 3. 内置助手 = 第一个 agent 实例

- 概念上 `assistant` 是内置 agent：prompt 来自 stagehand.ts 提示词体系（现有 stagehandExtension，assistant.ts:1039-1076），tools=现有 26 个助手工具全白名单，bridge=全权限。
- **实施约束**：不迁移 `.liyuan-assistant/`、不改现有 wire 帧名（assistant_* 保留），UI 选择器中"助手"即 id=assistant。现有代码行为零变化，只把创建路径换到新工厂。

## 4. 桥权限模型（storyBridge 工厂化）

```ts
// server/assistant.ts 定义（或新 server/agent-host.ts）
export interface BridgePermissions {
  readStory: boolean;      // 只读组：storyMessages/snapshot/worldState/cardName/listModels/deliverMedia
  writePanels: boolean;    // writePanels
  storyEdit: boolean;      // storyEdit（DESIGN-story-edit §3）
  queueCommand: boolean;   // queueStoryCommand（含 /back /store 等全部命令）
  applyStatePatch: boolean;// applyStatePatch
  tableOps: boolean;       // applyTableOp/applyTemplate/applyTableBackfill（DESIGN-custom-tables §7）
  emitMedia: boolean;      // emitStoryMedia
  refreshMaterials: boolean; // refreshStoryMaterials
  mountCodex: boolean;     // mountCodex
  embedStoryImage: boolean; // draw_generate 嵌入剧情正文（Q15）
}
export function createStoryBridge(base: StoryBridge, perms: BridgePermissions): StoryBridge;
```

实现：返回代理对象，未授权方法 `throw new Error("bridge 权限未授予: xxx")`（工具执行层捕获转成工具错误返回，助手/agent 可见"无权限"）。只读组由 `readStory` 一键开关。

## 5. 委托链路改造

1. **网关**（src/assistant-gateway.ts）：`registerAssistantRunner(fn)` → `registerAgentRunner(name, fn)`；`runAssistantTask(req)` → `runAgentTask(agent: string, req)`。globalThis 挂载点改注册表 `Record<string, fn>`（结构照现有 51-59）。
2. **roleplay.ts `assistant_run` 工具**（1134-1185）：参数加 `agent?: string`（默认 `"assistant"`），execute 传 `runAgentTask(agent, {task, mode, signal})`。工具描述注明"agent 缺省为内置助手；自定义 agent 用 id 指定"。
3. **main.ts runner 注册**（1690-1751）：单 host 变量（1593 `let assistantHost`）改 `Map<string, AgentHost>`；按 name 路由，未知 name 返回"未知 agent"错误。
4. **delegateDepth 沿用全局布尔**（v1 互斥委托），注释说明 v2 扩展方向。

## 6. wire 与 UI

- **wire**：现有 assistant_* 帧（wire.ts:456-473,590-606）**加 `agentId?: string` 字段**（缺省="assistant"，旧前端忽略新字段，向后兼容）；main.ts 处理器（2673-2760）按 agentId 路由到对应 host。新增 `agents_list` 帧（可选，v1 由 `assistant_sessions` 返回各 agent 会话列表或跳过）。
- **前端**：`AssistantPanel.tsx` 泛化为 `AgentPanel`（props 加 agentId），右栏 header 加 agent 选择器（剧情 / 助手 / 各自定义 agent，来自配置）；`App.tsx:1407-1456` case "assistant" 扩为按当前 agent 路由。选择器数据源：`/api/config` 已有配置读取（rest.ts），前端解析 agents 段即可，无需新接口。

## 7. 范围界定

**v1（本设计实施范围）**：
- 声明式配置 + 校验 + /rprefresh 热载；
- createAgentHost 工厂 + 内置助手迁移兼容；
- 桥权限工厂 + 工具白名单；
- 网关注册表 + assistant_run 加 agent 参数 + main.ts 多 host 路由；
- wire agentId 字段 + 前端 AgentPanel 泛化 + agent 选择器；
- 只支持**叙事外** agent（ops/规划/诊断/文审类，不进世界线）。

**v2（明确不做）**：
- 叙事内 agent（进世界线、快照、回档）——需扩展 worldline 快照体系；
- 多 agent 并发委托；
- UI 内可视化 agent 配置编辑（v1 只配置文件）。

## 8. 实施顺序与验证

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 | AgentConfig 类型（src/types.ts）+ 校验（rest.ts）+ example 配置 + 文档 | 配置加载/校验单测式手动检查 |
| P1 | createStoryBridge 工厂（全权限代理）+ 现有 storyBridge 改用它 | 助手全部功能回归（改稿/面板/命令委托） |
| P2 | createAgentHost 泛化（从 assistant.ts 提取）+ 内置助手走新工厂 | 助手开关/换卡/换故事/模型跟随全回归 |
| P3 | 网关注册表 + assistant_run 加 agent + main.ts 多 host 路由 | 剧本：/委托导演 agent 干活；未知 agent 报错 |
| P4 | wire agentId + AgentPanel 泛化 + 选择器 | 前端切 agent、各自会话/模型独立 |
| P5 | 端到端剧本：定义 director agent（受限权限）→ 委托 → 权限拒绝用例 | 无权限工具返回"无权限"；story_edit 仅授权 agent 可用 |

每阶段 typecheck（`npm --prefix web run typecheck`）+ 服务启动冒烟 + 手动剧本（仓库无自动化测试）。

## 9. 风险清单

- **P2 重构回归面大**：assistant.ts 1000+ 行，泛化必须保持内置助手行为不变——回归重点：助手独立会话/模型跟随/换故事绑定/assistant_run 委托；
- **单 host 全局变量**（main.ts:1593）：改 Map 后所有引用点（switchToStory 调用点 1193/2633/2649、runner 1690）须同步；
- **wire 兼容**：加字段不动帧名，旧前端不炸；新前端对旧服务端（无 agentId）按缺省处理；
- **权限默认最小**：queueCommand/applyStatePatch/storyEdit 默认 false——用户配错最多是"委托报无权限"，不会产生越权写。

## 10. 模型注册表共享（2026-08-15）

所有 agent 会话（内置助手 + 自定义 agent）与主聊天**共享同一 ModelRegistry / AuthStorage 实例**：main.ts 的 `createAgentHost` 调用传 `runtime.services.modelRegistry / authStorage`，assistant.ts `build → createAgentSession` 原样透传（sdk.ts 支持传入）。

背景（修复「主聊天能用、助手报缺少 API key」）：此前 agent 会话各自独立创建 ModelRegistry（创建时快照、从不刷新），运行中配置热重载（连接面板/agent-config → 重写 models.json + 主会话 `refreshModels`）后主会话立即生效、agent 仍持旧快照——`applyModelTo` 的 `hasConfiguredAuth` 判定失败。共享后刷新即全局一致。

注意：`CreateAgentHostOptions.modelRegistry/authStorage` 为可选字段，缺省不传 = 各自新建（向后兼容）。
