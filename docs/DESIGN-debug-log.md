# DESIGN-debug-log：统一调试接口（LLM 非预期输出监控）

> 2026-08 · 需求：三条 LLM 通道（主聊天主演 / 旁路 / 右栏助手·自定义 agent）在 LLM 返回非预期内容时，
> 统一打印到后台控制台并记录日志；三级级别（INFO / WARNING / ERROR）；预留「开发者模式关掉打印」接口。

## 定位

`src/debug.ts` 是一个**纯 TS、零 pi 依赖**的统一调试出口，`src/` 领域层与 `server/` 宿主层都可直接 import。
它的职责是「**LLM 返回 → 判非预期 → 统一打点**」，与既有追踪各司其职：

| 设施 | 载体 | 用途 | 开关 |
|---|---|---|---|
| `src/stage/trace.ts` `TraceRecorder` | `.liyuan-state/trace/*.jsonl`（分会话） | 主聊天送模全文快照（提示词/思考/草稿） | `config.chatTrace` |
| `src/debug.ts`（本设施） | 后台控制台 + `.liyuan-state/debug.log`（JSONL） | LLM **非预期返回**打点 | `config.debugLog`（开发者可关） |

追踪看「过程和原文」，调试接口看「异常打点」；两者不冲突，都遵循「记录失败不影响主链路」。

## API

```ts
import { debug, configureDebug } from "../src/debug.ts";

debug.info(category, message, detail?);    // 常规流水
debug.warning(category, message, detail?); // 疑似非预期但未致命
debug.error(category, message, detail?);   // 明确失败
debug.log(level, category, message, detail?); // 统一入口

configureDebug({ console, file, filePath, minLevel }); // 增量合并
debugPrintEnabled() / debugFileEnabled() / debugConfig() // 只读快照
```

- **levels**：`info` / `warning` / `error`，逐一映射 `console.log` / `console.warn` / `console.error`。
- **双通道**：`console`（后台控制台打印）+ `file`（`.liyuan-state/debug.log` JSONL，含结构化 `detail`）。
- **`configureDebug` 增量合并**：host 启动时写入 `filePath`；各通道按 `config.debugLog` 现读同步。
- **失败静默**：写文件抛异常被吞掉——调试绝不拖垮演出主链路（与 `TraceRecorder` 同口径）。

## 配置（`liyuan.config.json`）

```jsonc
{
  "developerMode": true,        // 开发者模式总开关（已有）
  "debugLog": {                  // 本设施开关（缺省 undefined = 控制台+文件全开）
    "console": true,             // false = 关掉后台控制台打印（只写文件）
    "file": true                 // false = 只打控制台不落盘
  }
}
```

- `debugLog` 缺省 `undefined` = **全开**：非预期输出既打印又落文件——满足「默认就打印记录日志」。
- 打开开发者模式后可逐通道关：`console=false` 就是预留的「关掉打印」接口。
- 每拍（主演 `#turn`）/每请求（旁路、助手 `buildAgentRunner`）现读配置并 `configureDebug` 同步。

## 三条通道的接入点

### 主聊天主演（`src/stage/engine.ts`，category `main-chat`）
| 非预期 | 级别 | 落点 |
|---|---|---|
| 主演流式 provider error | ERROR | `#turn` 首轮 `e.type==="error"` |
| 整拍以错误收场 | ERROR | `#turn` 末尾 `errored` 分支 |
| 空手无正文（no-draft） | WARNING | `#turn` `!finalText` 分支 |
| 续写完忘 `draft_seal`，程序化补封笔 | WARNING | M-E 兜底封笔 |

### 旁路（category `side-text` / `side-agent`）
- 引擎内 `#sideText`：provider error / 流未产出最终消息 / 最终消息无文本 / 调用异常 → ERROR/WARNING。
- 引擎内 `#sideAgent`（场记表格代理）：返回错误 / 流未产出 → ERROR；打满轮数上限 → WARNING。
- 宿主 `server/main.ts`：
  - `registerPlannerCaller`（生图规划）：error / 无最终消息 → ERROR；无文本 → WARNING。
  - `backfillSideText`（表格回填/导入）：error / 无最终消息 → ERROR；无文本 → WARNING；异常 ERROR。
  - `ext_generate`（JS Runner 旁路）：provider error → ERROR；流结束无文本 → WARNING。
- `src/import-raw.ts`：场记输出无法解析 → WARNING。

### 右栏助手 / 自定义 agent（category `assistant`）
- `server/assistant.ts` `runTask` `softSettle`：回合结束无最终回复 → WARNING。
- `server/assistant.ts` `runTask` catch：执行异常 → ERROR。
- `server/assistant.ts` `return_answer`：交回空摘要 → WARNING。
- `server/main.ts` `onAssistantEvent` `auto_retry_start`：请求失败自动重试 → ERROR。

## 归属与纪律

- 领域层只聊「判非预期 + 打点」，`server/` 负责「配置现读 + 通道同步」——`src/debug.ts` 不 import server。
- 打点信息不回喂模型、不改主线行为（纯旁路观测）。
- 记录失败静默吞掉，与 `src/stage/trace.ts`、`#writeAssemblyReport` 同一口径。
