# DSH 式双阶段工具暴露（tool staging）

> 实现：2026-08-15 · 参照 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（DeepSeek Harness 社区 preset，MIT）· 代码：`src/tool-staging.ts`（判定纯函数）、`src/stage/engine.ts`（剧情侧）、`server/assistant.ts`（助手侧）· 测试：`test/tool-staging.test.ts`

## 1 背景与动机

DeepSeek V4 Pro 会**强烈依赖 API 中可见的工具目录选择执行轨迹**——全量工具一上来就摆满时，它会在目录里纠结/选错路径。dsh-anchored-standard 在 DeepSeek Harness（编码 agent）上的两轮评测：

| 起步方式 | 得分 |
|---|---|
| Standard（25 工具全量起步） | 91 / 92 |
| PTC | 92 |
| Minimal（官方，2 工具全程） | 99 / 96 |
| **Anchored Standard（先 2 工具，首次工具调用后放开 25）** | **98 / 99** |

结论：**双阶段工具暴露**——会话早期只暴露最小工具集，等会话历史里出现**首次工具调用**后，下一轮请求放开全量工具；状态从持久会话记录推导（resume/reload 不丢），工具目录全程只变一次（前缀缓存友好）。

梨园两侧存在同样的场景：剧情侧（主聊天演员每拍 30+ 工具）、助手/自定义 agent 侧（40 个 stagehand 工具）。本设计把 DSH 机制落进梨园。

## 2 机制总览

- **触发条件**：当前模型 id ∈ `STAGED_MODELS`（现为 `deepseek-v4-pro` 一个，常量集集中管理，将来可提配置）。非目标模型一律不启用——行为与现状完全一致。
- **Minimal 阶段**：会话早期只暴露最小工具集。
- **晋升**：历史里出现首次工具调用后，**下一轮请求**起放开全量（对齐 DSH「首次调用后下一请求」）。
- **永不回退**：晋升是会话级一次性事件，状态从持久记录推导，resume/reload/fork 后自动恢复正确阶段。

## 3 剧情侧（主聊天演员，src/stage/engine.ts）

### 3.1 Minimal 集

`minimalStageTools(tools, readDeps)`（src/tool-staging.ts）把当拍装配的全量工具裁剪为：

- **读侧**：统一层世界书族/向量库族（按注入裁剪）+ `world_state_get` + `table_query` + `writing_guide`
- **规划侧**：`beat_plan` / `beat_step_done`

规划工具**必须**保留：装配提示词点名「第 1 轮……用 `beat_plan` 记下每一步」（assemble.ts），目录里没有会与提示词矛盾。写侧（`draft_*`、`ask`）与媒体 / 音效 / MCP / 助手委托（`assistant_run`）全隐藏。

首轮 V4 Pro 只能侦查与规划；侦查（首次工具调用）后下一轮放开全量，正常写正文。首轮直出正文的路径不受影响——直出正文照旧代收为 `draft_write`（宽进严出，正文不丢）。

### 3.2 晋升判定与持久化

- 判定：分支上存在 `rp-tool-staged` 协议条目（`customType`，rp-summary 同款 CustomEntry——不进送模流、不进历史，rebuildHistory 自动过滤）。
- 落树：一拍内出现工具调用（agentLoop 检测 `calls.length > 0`）→ turn 收尾时 `sm.appendCustomEntry("rp-tool-staged", { model, at })`。
- 语义：**未调过工具就一直 Minimal**（寒暄拍直出正文不触发晋升）；首次工具调用后永久全量；fork 新分支没有标记 → 重新侦查起步（合理：新分支=新方向）。

### 3.3 请求流

```
#turn 装配 tools（全量）
  → stagedTools = 目标模型 && 分支无标记 ? minimalStageTools(...) : null
  → 首轮请求 tools = stagedTools ?? tools（trace 同步记实际目录）
  → #agentLoop：
      for round:
        calls = last.content 里的 toolCall
        if (calls.length > 0) promoted = true        ← 首次工具调用
        ctx.tools = stagedTools && !promoted ? stagedTools : tools
        （末轮安全阀撤工具逻辑不变）
  → turn 收尾：turnToolUsed && stagedTools → 落 rp-tool-staged 条目
```

晋升发生在本轮处理完工具调用之后——**本轮（下一请求）即全量**，与 DSH「首次工具调用后，下一份 header 即完整目录」逐字对齐。

## 4 助手/自定义 agent 侧（server/assistant.ts）

### 4.1 Minimal 集

`MINIMAL_STAGEHAND_TOOLS = ["read", "bash", "return_answer"]`——DSH 原版 read/bash 语义。`return_answer` 必须保留：委托交回通道，去掉会致剧情侧永久等待。与注册表（registry）取交集：自定义 agent 的 `toolsAllow` 白名单 / `backendControl: false`（noTools builtin）自然生效——白名单没放 read/bash 则交集变小，交集为空则跳过 staging（维持现状）。

### 4.2 晋升判定

`historyHasToolCall(session.messages)`——从**持久会话消息**推导（assistant 消息的 toolCall 块；toolResult 消息也算痕迹）。resume/reload 后同一判据自动恢复全量。

### 4.3 实现

pi 现成能力 `AgentSession.setActiveToolsByName(names)`（agent-session.ts）：从 registry 按名激活、重建 system prompt、**下一轮请求现读 state.tools**（prepareNextTurnWithContext）——turn 中途调用，同一委托的下一轮请求立即生效，零 pi 侵入。

幂等 `applyToolStaging(s)` 三处调用：

1. **build 完成时**：会话加载即对齐——resume 时历史已有工具调用 → 恢复全量；新会话且目标模型 → Minimal。
2. **prompt / runTask 开头**（`syncFollowModel()` 后）：模型跟随切换后兜底。
3. **subscribe 回调包装**：每次事件先 `applyToolStaging` 再转发——message_end 时本次工具调用已落历史，同一委托下一轮请求放开全量。

## 5 与既有机制的边界

| 机制 | 关系 |
|---|---|
| 自定义 agent `toolsAllow` 白名单 | 交集天然受限；`getAllTools()` 只含 registry（= 白名单裁剪后），不会越权激活 |
| `backendControl: false` | read/bash 不在 registry → Minimal 交集变小/为空 → 跳过 staging |
| `plainPromptExtension`（自定义 agent 提示词） | `before_agent_start` 每轮盖回，`setActiveToolsByName` 的 system prompt 重建不影响 |
| 剧情侧提示词工具点名（beat_plan/table_query/memory_search/lorebook_search） | 点名工具全部在 Minimal 集内，无矛盾 |
| 非目标模型（flash 等） | `isStagedModel` false → 全部路径不变，回归面为零 |

## 6 局限与扩展方向

- 剧情侧 Minimal 不含 `ask`：求方向的拍首轮不能弹选择卡（原「ask 时机门禁」已首拦一次，语义兼容）；放开后照常可问。
- `STAGED_MODELS` 是硬编码常量集——将来可按模型/按 agent 配置化（如 agents 段加 `toolStaging: false` 显式关闭）。
- 助手侧晋升粒度 = 「首次工具调用后同一委托下一轮」；若将来要更早放开（如按工具类别渐进），可在 `stagedToolNames` 上扩展阶段表。

## 7 验证

- 单测：`node --test test/tool-staging.test.ts`（11 用例：判定/交集/裁剪/永不回退）。
- 剧情侧冒烟（`PORT=7621`）：主聊天切 deepseek-v4-pro + 开发者模式开主聊天跟踪 → 首拍 trace 的 `prompt.tools` 仅读侧+规划 7 件；首次工具调用后的下一轮 `tools` 全量；第二拍起（已晋升）直接全量；切回 flash 目录无变化。
- 助手侧冒烟：`PORT=7621` 起服务，自定义 agent 模型指 deepseek-v4-pro，委托任务 → `.liyuan-agents/<id>/*.jsonl` 首份请求 tools 仅 3 件，首次工具调用后全量（DSH README 同款验证法）。
