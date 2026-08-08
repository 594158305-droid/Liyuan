# 梨园（Liyuan）架构设计文档

> 版本：v1.2.0（2026-08-08）
> 定位：以 AI agent 为主演的角色扮演应用
> 技术栈：Node.js ≥ 22 · 纯 TypeScript ESM · 后端零构建直跑 TS · React 19 + Vite 前端

---

## 一、顶层设计概览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           前端层 (web/)                                  │
│   React 19 + Vite · 面板组件 · wire 协议客户端 · 程序卡沙箱 iframe        │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ wire 协议 (WebSocket + REST)
┌──────────────────────────────────┴──────────────────────────────────────┐
│                         Web 宿主层 (server/)                             │
│   main.ts (HTTP/WS 服务) · rest.ts (REST API) · wire.ts (协议翻译)       │
│   assistant.ts (助手/agent 会话托管) · bridge.ts · tool-adapter.ts        │
│   ⚠ 除接线层外唯一允许接触 pi API 的文件（仅会话托管面）                     │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
┌──────────────────────────────────┴──────────────────────────────────────┐
│                        接线层 (.liyuan/extensions/roleplay.ts)           │
│   全仓库唯一允许挂载 pi API 的地方（D3 规则，~2290 行）                     │
│   组装 system prompt · 注册全部剧情工具 · 会话钩子 · 每轮记账/一致性审计     │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ 调用
┌──────────────────────────────────┴──────────────────────────────────────┐
│                        领域层 (src/)                                     │
│   纯 TS，禁止接触 pi API                                                │
│   ┌─────────┬──────────┬──────────┬──────────┬──────────┬──────────┐   │
│   │ 叙事域   │ 记忆域    │ 世界域    │ agent 域 │ 内容域    │ 外设域   │   │
│   │ stage/  │ memory/  │ state.ts │ tools/   │ draw/    │ mcp.ts   │   │
│   │ draft.ts│ scribe.ts│ lorebook │ stagehand│ draw-plug│ skills.ts│   │
│   │ retentio│ worldline│ codex.ts │ assistant│ panels.ts│ commands │   │
│   │ preset  │ retention│ card.ts  │ -gateway │ uploads  │ tts.ts   │   │
│   └─────────┴──────────┴──────────┴──────────┴──────────┴──────────┘   │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ 依赖
┌──────────────────────────────────┴──────────────────────────────────────┐
│                      内核层 (packages/)                                  │
│   @liyuan/agent-runtime (pi fork) · @liyuan/agent-core · @liyuan/ai     │
│   @liyuan/tui — file: 本地依赖，视为上游只读                              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 二、分层架构详解

### 2.1 领域层 (`src/`) — 纯业务逻辑

**核心纪律**：零 pi import，纯 TypeScript，可独立测试。

| 子域 | 文件/目录 | 职责 |
|------|----------|------|
| **叙事引擎** | `stage/engine.ts` | 台上引擎：RP 原生回合循环（装配→生成→验收→精修→记账→谢幕） |
| | `stage/assemble.ts` | 上下文装配器：从分支现算 system + 历史 + 末端注入 |
| | `stage/materials.ts` | 读盘装载：config/卡/世界书/预设/状态栏格式 |
| | `stage/revise.ts` | 精修请求组装 + 补丁解析 |
| | `stage/scribe-run.ts` | 场记调度 + 叶守卫（定稿后旁路记账） |
| | `stage/workspace.ts` | 回合工作区：稿纸 + 补丁累积 + 验收报告 |
| | `stage/compact.ts` | 固定楼层压缩（接力摘要 + 原文归档） |
| **稿件/正文** | `draft.ts` | 补丁应用、规则提取、checkDraft 验收、isPoliceBlock |
| **记忆系统** | `memory/` | 向量记忆服务：narrative 剧情库 + external 资料库 |
| | `scribe.ts` | 场记提示词 + 接力摘要提示词 |
| | `retention.ts` | 上下文裁剪（每轮确定性裁掉过程性内容） |
| **世界信息** | `state.ts` | 结构化世界状态账本（applyPatch / loadState / saveState） |
| | `lorebook.ts` | 世界书管理（ST 格式兼容、关键词扫描、常驻/激活） |
| | `codex.ts` | 知识库（跨对话持久、可导出 ST 世界书） |
| | `worldline.ts` | 世界线（存档/回档/分支，整个世界状态一致回退） |
| **角色卡** | `card.ts` | 角色卡解析（V1/V2/V3/ST 导出格式兼容） |
| | `cardfront.ts` | 卡面正则规则（显示美化/清理） |
| | `cardSkin.ts` | 卡皮肤（显示向正则） |
| **agent 域** | `tools/` | 助手工具定义（lore/memory/card/panels/worldline/regex/gate） |
| | `stagehand.ts` | 助手提示词体系 + 剧情快照格式 |
| | `assistant-gateway.ts` | 委托网关（runAgentTask 注册表） |
| | `agent-config.ts` | agent 配置加载/同步 |
| **内容生成** | `draw/` | 生图底座（config/novelai/params/queue/errors/sd-webui|comfyui 预留） |
| | `draw-plugins/` | 生图插件（角色管理/旁路管线/存储映射/编辑操作） |
| | `tts.ts` | 语音合成（TTS） |
| **面板/素材** | `panels.ts` | agent 生成面板（markdown/svg/html） |
| | `uploads.ts` | 素材库（不进上下文，只附路径） |
| **外设** | `mcp.ts` | MCP 集成（内置 + 外部，按对话启用） |
| | `skills.ts` | 技能管理（.liyuan-skills/*.md） |
| | `commands.ts` | 斜杠命令注册 |
| **预设** | `preset.ts` | 预设加载与归一化 |
| | `preset-classify.ts` | 预设块性质分类（文风/纪律/结构/噪声） |
| | `preset-split.ts` | 预设分层装配 |
| | `preset-macro.ts` | 预设宏求值（setvar/getvar 等） |
| **基础设施** | `paths.ts` | 数据路径 + 旧布局迁移 |
| | `types.ts` | 领域层共享类型（CharacterCard/WorldState/RpConfig/AgentConfig 等） |
| | `postprocess.ts` | 后处理（折叠标签、正文清洗） |
| | `chatlog.ts` | 聊天记录导入/清洗 |

### 2.2 接线层 (`.liyuan/extensions/roleplay.ts`) — pi API 唯一挂载点

**核心纪律**：全仓库**唯一**允许接触 pi API 的地方（D3 规则）。

**职责**：
1. 装载配置/角色卡/世界书 → 组装 system prompt
2. 注册全部剧情工具（RP_TOOLS 名单）
3. 会话钩子（context 钩子注入世界状态/触发设定/记忆召回）
4. 每轮后场记记账 + 一致性审计（旁侧模型）
5. 剧情向压缩接管
6. 新会话注入开场白
7. applyRpToolset() 收窄活跃工具集

**关键约束**：
- 约 2290 行，是仓库最大的单文件
- 加新剧情工具主要改这里
- 扩展注册的工具若不在历史活跃集中，默认不会自动进入剧情会话

### 2.3 Web 宿主层 (`server/`) — 服务与协议

| 文件 | 职责 |
|------|------|
| `main.ts` | Web 宿主入口（3731 行）：HTTP/WS 服务、会话托管、StoryBridge 闭包、世界线管理 |
| `rest.ts` | REST API（/api/*）：配置/状态/世界书/知识库/面板/素材/模型/绘图等全部端点 |
| `wire.ts` | wire 协议定义（WireMsg/WireChannel/WireSegment 等）+ pi→wire 翻译 |
| `assistant.ts` | 助手/agent 会话托管：createAgentHost 工厂、工具注册、桥权限 |
| `bridge.ts` | StoryBridge 接口实现 |
| `tool-adapter.ts` | 助手工具定义适配 |
| `script-events.ts` | 程序卡事件处理 |
| `mcp/` | MCP 服务器管理 |

**D3 纪律**：main.ts 是接线层之外唯一允许接触 pi API 的文件，且只许碰会话托管面。

### 2.4 前端层 (`web/`) — React 19 + Vite

**技术栈**：React 19 · Vite 6 · TypeScript 5.8

**核心文件**：
- `App.tsx` — 主应用（路由/面板切换）
- `wire.ts` — wire 协议客户端（与 server/wire.ts 同步）
- `ws.ts` — WebSocket 连接管理
- `api.ts` — REST API 调用封装

**组件面板**（`web/src/components/`）：

| 组件 | 功能 |
|------|------|
| `Messages.tsx` | 消息流（正文/思考/工具时间线） |
| `HomePage.tsx` | 主页（卡选择/快速开始） |
| `CardPanel.tsx` | 角色卡管理 |
| `LorebookPanel.tsx` | 世界书管理 |
| `CodexPanel.tsx` | 知识库管理 |
| `AssistantPanel.tsx` | 助手/agent 对话面板 |
| `AgentManagerPanel.tsx` | 自定义 agent 管理 |
| `ArtifactPanel.tsx` | 面板/面板 Dock |
| `PanelDock.tsx` | 面板停靠区 |
| `DrawPanel.tsx` | 生图管理 |
| `WorldlinePanel.tsx` | 世界线（存档/回档/分支） |
| `SessionsPanel.tsx` | 会话管理 |
| `PresetPanel.tsx` | 预设管理 |
| `SettingsPanel.tsx` | 设置 |
| `PowersPanel.tsx` | 扩展能力（MCP/技能） |
| `UploadsPanel.tsx` | 素材库 |
| `StatusStrip.tsx` | 世界信息条（输入框上方） |
| `PersonaPanel.tsx` | 用户身份 |
| `RegexPanel.tsx` | 正则脚本 |
| `RosterPanel.tsx` | 登场名录 |

### 2.5 内核层 (`packages/`) — pi fork 冻结

| 包 | 原名 | 职责 |
|----|------|------|
| `@liyuan/agent-runtime` | `@pi/coding-agent` | agent 运行时（会话管理/工具注册/扩展加载） |
| `@liyuan/agent-core` | `@pi/agent` | agent 核心（传输抽象/状态管理/附件） |
| `@liyuan/ai` | `@pi/ai` | 统一 LLM API（OpenAI/Anthropic/Gemini/Bedrock/Mistral） |
| `@liyuan/tui` | `@pi/tui` | 终端 UI 组件库 |

**纪律**：视为上游只读，尽量不改；确要改须同步 fork 上游语义。

---

## 三、分域职责详解

### 3.1 叙事域（Narrative）

**核心文件**：`src/stage/` + `src/draft.ts`

**职责**：
- 管理回合循环（一拍 = 装配→生成→验收→精修→记账→谢幕）
- 上下文装配（f(分支)：system + 前情摘要 + 往拍定稿 + 末端动态区 + 本幕指令）
- 稿件管理（draft_write/draft_edit/draft_check 工具循环）
- 压缩摘要（固定楼层压缩 + 接力摘要）

**关键机制**：
- **台上引擎自持**（R1）：不依赖 pi 的 AgentSession 循环，自建 RpEngine
- **稿纸即工作区**（R2）：模型流式输出即稿子，修订以补丁追加
- **上下文 = f(分支)**（R3）：每次 LLM 调用从当前分支现算
- **竞态两律**（R9）：回合互斥 + 叶守卫

### 3.2 记忆域（Memory）

**四层记忆结构**：

| 层 | 载体 | 注入方式 | 职责 |
|----|------|----------|------|
| 纯净上下文 | 装配器裁剪 | 每轮无条件 | 只保留叙事正文 + 快照，过程性内容代码层裁掉 |
| 结构化账本 | `state.ts` WorldState | 每轮无条件注入 | 物品/好感/时间/伏笔，旁侧模型每轮自动记账 |
| 检索资产 | lorebook + codex + memory | 关键词/语义/主动检索 | 世界书 + 知识库 + 向量库，用时才取 |
| 剧情化压缩 | `compact.ts` | 每 N 轮触发 | 按叙事逻辑生成前情提要，压缩也压得懂剧情 |

### 3.3 世界域（World）

**核心文件**：`state.ts` + `lorebook.ts` + `codex.ts` + `worldline.ts`

**职责**：
- 结构化世界状态（time/location/characters/inventory/flags/plot_threads/roster）
- 世界书管理（ST 格式兼容、constant/关键词激活、多本挂载）
- 知识库（跨对话持久、双向导出 ST 世界书）
- 世界线（存档/回档/分支，整个世界一致回退）

**关键机制**：
- **世界 = f(分支)**（R4）：账本从当前分支的 rp-state 快照重建
- **applyPatch 语义**：time/location 替换，characters/flags 按 key 合并，inventory/plot_threads 整体替换

### 3.4 agent 域（Agent）

**核心文件**：`server/assistant.ts` + `src/tools/` + `src/stagehand.ts`

**职责**：
- 双 agent 分治：剧情归剧情模型，系统事务归助手
- 自定义 agent 声明式配置（liyuan.config.json agents 段）
- 桥权限模型（BridgePermissions：readStory/writePanels/storyEdit/queueCommand 等）
- 委托链路（assistant_run 工具 + 网关注册表）

**关键机制**：
- 助手独立会话树（.liyuan-assistant/），绝不进剧情会话列表/世界线
- 超集视野：经 StoryBridge 只读剧情，写操作走白名单
- 自定义 agent v1 只支持「叙事外」agent（不进世界线）

### 3.5 内容生成域（Content Generation）

**核心文件**：`src/draw/` + `src/draw-plugins/` + `src/tts.ts`

**分层架构**：
```
┌─────────────────────────────────────────────────────┐
│ 插件层（src/draw-plugins/，默认关闭）                  │
│  A 角色管理 · B 生图旁路管线 · C 存储映射 · D 编辑操作  │
└──────────────────────────┬──────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────┐
│ 底座（src/draw/，常驻）                               │
│  config · novelai · params · queue · errors          │
│  sd-webui/comfyui 预留（仅类型与配置 schema）          │
└─────────────────────────────────────────────────────┘
```

### 3.6 外设域（Extension）

**核心文件**：`mcp.ts` + `skills.ts` + `commands.ts`

**扩展入口**：
| 入口 | 载体 | 用途 |
|------|------|------|
| MCP | 标准 MCP 服务器 | 骰子/数据库/任意工具（按对话启用） |
| 技能 | `.liyuan-skills/*.md` | 能力笔记（agent 可自写） |
| 斜杠命令 | 输入框 `/` 触发 | 快捷操作（/state /lore /import 等） |
| REST API | /api/* | 外部脚本/服务直接读写 |
| 程序卡 | 前端沙箱 iframe | HTML/JS 角色卡 |

---

## 四、数据流与协议

### 4.1 wire 协议

**定义**：`server/wire.ts` ↔ `web/src/wire.ts`（改协议两端同步）

**通道类型**（WireChannel）：
- `user` — 用户消息
- `narrative` — 剧情正文（模型原始输出，D10 红线）
- `greeting` — 开场白
- `backstage` — 后台（思考/系统）
- `info` — 信息提示
- `image` / `audio` / `video` — 媒体
- `choice` — 决策卡
- `html` — 对话流内嵌 HTML

**rp-edited 例外**：经显式改稿的回复带 `edited: true` 标记，仅此通道允许非模型原始输出。

### 4.2 REST API

服务默认 `http://127.0.0.1:7620`（无鉴权，仅限本机/局域网）。

**主要端点分组**：
- 世界状态：`GET/PUT /api/state`
- 世界书：`GET /api/lorebooks` · `POST /api/lorebooks/import` · ...
- 知识库：`GET /api/codex` · `POST /api/codex/mount` · ...
- 向量记忆：`POST /api/memory/import` · `POST /api/memory/search` · ...
- 面板：`GET/PUT /api/panels` · ...
- 角色卡：`GET/POST /api/cards` · `POST /api/cards/import` · ...
- 会话：`GET /api/sessions/search` · `DELETE /api/sessions` · ...
- 世界线：`GET /api/worldline` · ...
- 模型/配置：`GET /api/models` · `GET/PUT /api/config` · ...
- 生图：`GET/POST /api/draw/providers` · `POST /api/draw/generate` · ...
- MCP/技能：`GET /api/mcp` · `GET/POST /api/skills` · ...

---

## 五、目录结构与数据目录

### 5.1 代码目录

```
Liyuan/
├── src/                    # 领域层（纯 TS，零 pi 依赖）
│   ├── stage/              # 台上引擎
│   ├── memory/             # 向量记忆服务
│   ├── tools/              # 助手工具定义
│   ├── draw/               # 生图底座
│   ├── draw-plugins/       # 生图插件
│   ├── types.ts            # 共享类型
│   ├── paths.ts            # 数据路径 + 迁移
│   └── ...                 # 其他领域模块
├── server/                 # Web 宿主
│   ├── main.ts             # 入口（HTTP/WS/会话托管）
│   ├── rest.ts             # REST API
│   ├── wire.ts             # wire 协议
│   ├── assistant.ts        # 助手/agent 会话托管
│   └── mcp/                # MCP 管理
├── web/                    # 前端
│   ├── src/
│   │   ├── components/     # 面板组件
│   │   ├── wire.ts         # wire 协议客户端
│   │   └── App.tsx         # 主应用
│   └── vite.config.ts
├── packages/               # pi fork（@liyuan/*）
│   ├── agent/              # @liyuan/agent-core
│   ├── ai/                 # @liyuan/ai
│   ├── coding-agent/       # @liyuan/agent-runtime
│   └── tui/                # @liyuan/tui
├── .liyuan/                # 运行时配置
│   ├── extensions/
│   │   └── roleplay.ts     # 接线层（唯一 pi API 挂载点）
│   └── settings.json
├── docs/                   # 设计文档
├── scripts/                # 构建/发布脚本
├── deploy/                 # 部署配置
└── test/                   # 测试
```

### 5.2 数据目录（相对项目根）

| 目录 | 用途 |
|------|------|
| `.liyuan-state/` | 世界状态账本 |
| `.liyuan-artifacts/` | 面板 |
| `.liyuan-assistant/` | 助手独立会话树 |
| `.liyuan-agents/` | 自定义 agent 会话目录 |
| `.liyuan-cache/` | 缓存 |
| `.liyuan-codex/` | 知识库 |
| `.liyuan-lore/` | 补充设定集 |
| `.liyuan-media/` | 媒体文件 |
| `.liyuan-audio/` | 音频文件 |
| `.liyuan-skills/` | 技能 |
| `.liyuan-uploads/` | 素材库 |
| `.liyuan-wardrobe/` | 角色衣橱档案 |
| `.liyuan-worldline/` | 世界线存档 |
| `.liyuan-memory/` | 向量记忆库 |

**配置文件**：
- `liyuan.config.json` — 卡/世界书/身份/agents（gitignore）
- `liyuan.agent.json` — 模型/Key（gitignore）
- `liyuan.draw.json` — 生图配置

---

## 六、外部依赖

### 6.1 内核依赖（pi fork）

| 包 | 版本 | 来源 | 用途 |
|----|------|------|------|
| `@liyuan/agent-runtime` | 0.80.3 | [earendil-works/pi](https://github.com/earendil-works/pi) fork | agent 运行时（会话/工具/扩展） |
| `@liyuan/agent-core` | 0.80.3 | 同上 | agent 核心抽象 |
| `@liyuan/ai` | 0.80.3 | 同上 | 统一 LLM API |
| `@liyuan/tui` | 0.80.3 | 同上 | 终端 UI |

**依赖方式**：`file:./packages/*` 本地依赖，视为上游只读。

**pi 运行时 API**（仅两处允许接触）：
1. `.liyuan/extensions/roleplay.ts` — 接线层（全仓库唯一挂载点）
2. `server/main.ts` + `server/assistant.ts` — 会话托管面

### 6.2 LLM API 提供商

通过 `@liyuan/ai` 统一接口支持：

| 提供商 | SDK | 用途 |
|--------|-----|------|
| OpenAI | `openai@6.26.0` | 主模型/视觉/TTS |
| Anthropic | `@anthropic-ai/sdk@0.91.1` | Claude 系列 |
| Google | `@google/genai@1.52.0` | Gemini 系列 |
| AWS Bedrock | `@aws-sdk/client-bedrock-runtime@3.1048.0` | Bedrock 托管模型 |
| Mistral | `@mistralai/mistralai@2.2.6` | Mistral 系列 |

**兼容层**：任何 OpenAI 兼容 API（如 DeepSeek）均可接入。

### 6.3 前端依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `react` | ^19.1.0 | UI 框架 |
| `react-dom` | ^19.1.0 | DOM 渲染 |
| `vite` | ^6.3.5 | 构建工具 |
| `typescript` | ~5.8.0 | 类型检查 |

### 6.4 通信协议

| 协议 | 包 | 用途 |
|------|-----|------|
| WebSocket | `ws@^8.18.0` | 实时消息推送 |
| MCP | `@modelcontextprotocol/sdk@^1.29.0` | 外部工具集成 |

### 6.5 生图后端

| 后端 | 状态 | 说明 |
|------|------|------|
| NovelAI | ✅ 已实现 | V4.5/V3 双协议 |
| SD WebUI | 🔶 预留 | 仅类型与配置 schema |
| ComfyUI | 🔶 预留 | 仅类型与配置 schema |

### 6.6 运行时依赖

- **Node.js** ≥ 22（必需）
- **jiti** — 扩展 TS 文件直跑（无需编译）

---

## 七、关键设计决策

### 7.1 D3 扩展条款（pi API 隔离）

全仓库只允许两处接触 pi API：
1. `.liyuan/extensions/roleplay.ts` — 接线层（工具/钩子/记账）
2. `server/main.ts` + `server/assistant.ts` — 会话托管面

领域层（src/）禁止任何 pi import。

### 7.2 R1 台上循环自持

叙事引擎不依赖 pi 的 AgentSession 循环，自建 StageEngine。harness 知道当前是哪一幕，不再从消息角色里猜。

### 7.3 R2 稿纸即工作区

初稿阶段模型的流式输出本身就是稿子，修订以补丁追加，树只追加不改写。

### 7.4 R3/R4 上下文与世界 = f(分支)

每次 LLM 调用的上下文从当前分支现算；账本从当前分支的 rp-state 快照重建。swipe/rewind/世界线切换天然看到正确状态。

### 7.5 双 agent 分治

- 剧情模型：只演戏，上下文纯净
- 助手/自定义 agent：系统事务，独立会话，超集视野

### 7.6 正文红线（2026-08-08 更新）

自动路径永远是模型原始输出；显式改稿（用户手改 / 助手经 story_edit 且征得用户同意）走 rp-edited 分支条目，带标记、原文可回滚。

---

## 八、兼容性与数据生态

### 8.1 角色卡兼容

- PNG 卡和 JSON 卡直接导入
- V1 / V2 chara_card_v2 / V3 chara_card_v3 / ST 导出格式
- 卡内嵌世界书一并读取

### 8.2 世界书兼容

- JSON 直接导入（ST world info 格式）
- 蓝灯 constant / 绿灯关键词激活语义保留
- 双向导出（梨园知识库 → ST 世界书）

### 8.3 聊天记录兼容

- jsonl 旧档直接导入续玩
- 导入时自动清洗（剥离旧状态栏和思维链）
- 旧剧情自动摘要、自动建账

### 8.4 预设兼容

- 直接导入，采样参数生效
- 变量引擎（setvar/getvar）、文风开关、思维链模板

### 8.5 程序卡

- HTML/JS 在浏览器沙箱 iframe 运行
- TavernHelper API 兼容
- 卡代码只在浏览器沙箱内运行，不落本机

---

## 九、部署与运行

### 9.1 启动方式

```bash
npm run web           # 启动服务（默认 0.0.0.0:7620）
npm run web:new       # 开新会话
npm run web:build     # 构建前端
npm run web:dev       # Vite 热更新（开发）
```

### 9.2 部署选项

| 方式 | 说明 |
|------|------|
| 一键安装脚本 | systemd 服务，自动安装 Node 22 |
| Docker Compose | 数据在命名卷，升级重建不丢档 |
| 手动打包 | `npm run pack:release` 输出发布包 |

### 9.3 安全约束

- 服务无鉴权，默认绑 0.0.0.0：**禁止裸暴露公网**
- 对外请套反向代理 + 鉴权
- 扩展与 MCP 服务器以完整系统权限运行

---

## 十、相关文档索引

| 文档 | 路径 | 内容 |
|------|------|------|
| 开发者说明 | `AGENTS.md` | 命令/架构/配置/红线 |
| 用户文档 | `README.md` | 功能介绍/快速开始/进阶 |
| 扩展开发 | `docs/DEV-extend.md` | 对外能力与扩展技术路径 |
| 自定义 agent | `docs/DESIGN-custom-agents.md` | 声明式子 agent 设计 |
| 改稿工具 | `docs/DESIGN-story-edit.md` | story_edit 助手改稿设计 |
| 生图系统 | `docs/DESIGN-draw.md` | 生图分层设计 |
| RP Harness | `docs/PLAN-RP-HARNESS.md` | RP Harness 重建计划 |
| RP Agent | `docs/PLAN-RP-AGENT.md` | RP agent 化设计（工具栈+预设拆层） |
| 执行计划 | `docs/PLAN-RP-AGENT-EXEC.md` | 立骨架执行计划 |
| 发布说明 | `docs/RELEASE-v*.md` | 各版本发布说明 |
