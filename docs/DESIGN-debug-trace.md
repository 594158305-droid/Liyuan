# 主聊天跟踪（开发者模式）设计

> 2026-08-11 落地 · 用户决策记录：记录格式 = JSONL 机器格式（每事件一行，长文本单行原样存）；查看入口 = 设置面板文件列表 + 下载；开关作用域 = 全局持久（liyuan.config.json）。

## 1. 需求

设置面板最下方新增「开发者模式」分区：总开关打开后显示开发者选项，当前唯一选项为「主聊天跟踪」——开启后把当前聊天的**全过程**记录下来用于分析调试：发送的提示词（送模完整上下文）、模型思考、工具调用细节、旁路模型执行、草稿，以及角色卡 / 聊天标识 / 发生时间 / 使用预设等重要调试信息。

## 2. 配置

- `liyuan.config.json` 新增两键（`src/types.ts` RpConfig + DEFAULT_CONFIG，默认均 false；`server/rest.ts` CONFIG_EDITABLE 白名单 + applyConfigPatch 布尔归一 `=== true`）：
  - `developerMode`：开发者模式总开关（UI 显示层）。
  - `chatTrace`：主聊天跟踪（引擎行为层）。
- 走现有 `PUT /api/config` 流程（设置面板统一保存）；引擎**每拍现读**配置（`loadStageMaterials`），保存后下一回合生效，无需重启。

## 3. 记录载体与格式

- 目录：`.liyuan-state/trace/<sessionId>.jsonl`（`.liyuan-state/` 已在 .gitignore，天然不进 git）。
- 追加写 JSONL：每事件一行 JSON（`{ts, kind, ...payload}`），ts 为 ISO 8601（UTC）。长文本（完整提示词 / 思考 / 草稿全文）经 JSON.stringify 转义后单行原样保存，天然支持长段记录。
- 文件按会话（sessionId）分：切聊天 / 新会话自动开新文件；**不自动清理**，由面板列表显示大小自管。
- 记录失败一律静默吞掉——跟踪是调试辅助，不影响演出主链路（与 `#writeAssemblyReport` 同口径）。

### 事件清单

| kind | 内容 | 采集点 |
|---|---|---|
| `session` | 会话头（文件首条，只写一次）：sessionId、cardPath、cardName、preset、model、thinkingLevel、language | `#turn` 开头 `trace.openSession`（幂等：同进程去重 + 文件已存在不重写） |
| `turn_start` | 用户原话（null = reroll）、model | `#turn` |
| `prompt` | 送模完整上下文：systemPrompt、messages、tools、reasoning | `#turn` 构造完 messages 后、streamFn 前（engine.ts） |
| `thinking` | 每轮完整思考原文（round：0 = 首轮，N = agentLoop 第 N 轮；从各轮 final 的 thinking 块提取） | `#turn` 首轮 + `#agentLoop` 每轮 |
| `tool_call` | 工具名、完整参数、round | `#agentLoop` 工具轮（含被门禁拦下的——配对 tool_result 缺失即被拦） |
| `tool_result` | 工具名、结果全文、isError、耗时（elapsedMs）、round | `#agentLoop` 主干派发后 |
| `draft` | 写侧草稿动作（draft_write/append/edit/seal/check）：交稿全文（args）、验收结果（result） | 同上，DRAFT_TOOLS 判定 |
| `side` | 旁路模型执行：purpose（scribe/compact）、systemPrompt、userText、ok、结果全文、耗时 | `#sideText` 出口（调用方传 purpose + traceOn） |
| `turn_end` | 整拍耗时、usage/token、entryId、最终定稿全文、aborted/error | `#turn` 三处出口（errored / no-draft / 正常） |

## 4. 实现落点

- `src/stage/trace.ts`：`TraceRecorder`（openSession / record / list / fileOf sanitize 防路径穿越）。单测 `test/trace.test.ts`。
- `src/stage/engine.ts`：`StageEngineDeps.trace?: TraceRecorder`；`#turn` / `#agentLoop` / `#sideText` 按上表采集。
- `server/main.ts`：构造 `new TraceRecorder(join(stateDir, "trace"))` 注入引擎。
- `server/rest.ts`：
  - `GET /api/trace/list` → `{ok, files: [{name, size, mtime}]}`（只读目录 metadata）。
  - `GET /api/trace/download?name=` → attachment（文件名严格限定 `<sessionId>.jsonl` 形态，杜绝路径穿越）。
- `web/src/api.ts`：`TraceFileInfo` + `getTraceFiles()` + `downloadTraceFile(name)`。
- `web/src/components/SettingsPanel.tsx`：底部「开发者模式」CollapsibleSection（默认收起）——总开关 → 主聊天跟踪开关 + 说明 → 文件列表（名称/大小/时间/下载按钮 + 刷新）。

## 5. 边界与已知限制（第一版）

- 记录范围 = 引擎内全链路（送模提示词、思考、工具、草稿、场记/压缩旁路、定稿）。REST 侧旁路（storyEdit 重记账、导入回填、生图规划）暂不记录，后续可扩展。
- 每回合记录可达百 KB 级（含全文），文件不自动清理。
- 开关保存后**下一回合**生效（引擎每拍现读配置）。
- 记录文件含聊天全文（含提示词与草稿），属本机数据，与其他 `.liyuan-state/` 同级，不进 git。
