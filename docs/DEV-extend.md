# 梨园开发者说明：对外能力与扩展技术路径

> 适用读者：想给梨园接外部服务 / 写自定义脚本 / 做深度定制的开发者与硬核用户。
> 本文所有能力均经代码核实（`server/rest.ts`、`src/mcp.ts`、`.liyuan/extensions/roleplay.ts`、`packages/coding-agent/docs/extensions.md` 等）。
> 分级：**纯配置**（零代码）→ **扩展文件**（写 TS 但不动源码）→ **改源码**（必须动仓库代码）。

---

## 一、对外能力总览

梨园把"数据怎么被模型看到"分成四层，外加四类扩展入口。先记住这张图，后面所有案例都落在里面：

| 层 | 载体 | 注入方式 | 用途示例 |
|---|---|---|---|
| 状态账本 | `world_state`（time/location/characters/inventory/flags/plot_threads） | **每轮无条件注入** | 关系进度、好感、境界、当前地点 |
| 世界书 / 知识库 | lorebook（`.liyuan-lore/`、卡内嵌、独立书）+ codex（`.liyuan-codex/`） | constant 常驻 + 关键词激活 + `lorebook_search` 主动检索 | 门派设定、功法规则、人物档案 |
| 向量记忆 | memory 服务（narrative 剧情库 + external 额外库） | 每轮按语义相似度自动注入 | 规则书、设定文档的语义召回 |
| 面板 | `panel_write`（markdown / svg / html） | 展示给人看，agent 可 `panel_read` 读回 | 关系图谱、属性表、装备库、地图 |

扩展入口：**REST API**（外部脚本/服务）· **MCP**（按对话启用的外设工具）· **技能**（`.liyuan-skills/*.md`）· **程序卡/JS Runner**（前端沙箱脚本）。

---

## 二、纯配置 / 零代码即可完成的技术路径

### 2.1 REST API：外部脚本直接读写一切数据

服务默认 `http://127.0.0.1:7620`（无鉴权，仅限本机/局域网，勿裸暴露公网）。完整端点清单：

**世界状态与数据（本文重点）：**

| 端点 | 说明 |
|---|---|
| `GET /api/state` · `PUT /api/state` | 读写世界状态账本。`PUT` 的 body 为 `{"patch": {...}}`，applyPatch 语义：`time`/`location` 替换，`characters`/`flags` 按 key 合并（null 删除），`inventory`/`plot_threads` 整体替换。落盘即广播，前端输入框上方的世界信息条即时刷新，随世界线回档 |
| `GET /api/lorebooks` · `POST /api/lorebooks/select` · `POST /api/lorebooks/import` · `DELETE /api/lorebooks` | 世界书挂载/导入（ST 格式）/卸载 |
| `GET /api/lorebook` · `GET /api/lorebook/search` · `POST /api/lorebook/entry` · `POST /api/lorebook/toggle` · `GET /api/lorebook/export` | 世界书条目读写、关键词检索、启停、导出 |
| `GET /api/codex` · `POST /api/codex` · `POST /api/codex/rename` · `DELETE /api/codex` · `POST /api/codex/mount` | 知识库（跨对话持久、可导出 ST 世界书）管理 |
| `GET /api/codex/entries` · `POST /api/codex/entries` · `DELETE /api/codex/entries` · `GET /api/codex/export` | 知识库条目读写 |
| `POST /api/memory/search` | 向量检索：`{"storeId":"external","query":"...","topK":5}` → 按余弦相似度返回命中 |
| `POST /api/memory/import` | **向量导入**：`{"text":"...","fileName":"..."}` → 自动分块向量化，之后每轮语义注入 |
| `POST /api/memory/manual` | 手动单条向量化 `{"text":"...","title":"..."}` |
| `GET /api/memory` · `PUT /api/memory` · `GET /api/memory/chunks` · `POST /api/memory/reembed` · `POST /api/memory/clear` | 向量库配置与维护 |
| `GET /api/panels` · `PUT /api/panels` · `DELETE /api/panels` · `POST /api/panels/import` | 面板读写（`PUT` body：`{"name":"...","kind":"markdown\|svg\|html","content":"..."}`） |
| `GET /api/extdata` · `PUT /api/extdata` | 扩展数据 key-value（scope：`global/preset/character/chat`），脚本与外部服务共享 |
| `POST /api/script/message` | 改稿/删稿（`{"op":"edit"\|"delete","lastRoleIndex":N,"text":"..."}`），显式改稿带标记、原文可回滚 |

**内容管理：** `GET/POST /api/cards`、`POST /api/cards/import`、`GET/PUT /api/card`、`GET /api/card/export`、`GET/POST/DELETE /api/personas`、`GET/POST /api/presets`、`POST /api/upload`、`GET/DELETE /api/uploads`、`GET/POST /api/greeting`、`POST /api/import`。

**会话与世界线：** `GET /api/sessions/search`、`POST /api/sessions/rename`、`DELETE /api/sessions`、`GET /api/sessions/export`、`GET /api/worldline`、`POST /api/worldline/delete-save`、`POST /api/worldline/rename`。

**模型与配置：** `GET /api/models`、`POST /api/models/select`、`POST /api/models/thinking`、`GET /api/auth`、`POST/DELETE /api/auth`、`GET /api/agent-tools`、`GET/POST/PUT /api/agent-profiles`、`POST /api/agent-profiles/enable`、`GET /api/commands`、`POST /api/command`、`POST /api/tts`。

**扩展外设：** `GET /api/mcp`、`POST /api/mcp/sync`、`POST /api/mcp/enable`、`POST/PUT/DELETE /api/mcp/servers`、`POST /api/mcp/probe`、`GET/POST/DELETE /api/skills`、`GET /api/skills/content`、`GET/PUT /api/cardfront`。

**画图/装扮：** `GET/POST/DELETE /api/draw/providers`、`PUT /api/draw/default`、`POST /api/draw/test`、`POST /api/draw/generate`、`POST /api/draw/enhance`、`GET/PUT /api/wardrobe`、`POST /api/wardrobe/ref`、`POST /api/wardrobe/current`。

### 2.2 案例：外部脚本定制"世界信息"条（输入框上方）

```bash
# 改时间与地点（摘要行即 time · location）
curl -X PUT http://127.0.0.1:7620/api/state \
  -H "Content-Type: application/json" \
  -d '{"patch":{"time":"第三天黄昏","location":"梨园后山·凉亭"}}'

# 恋爱文：角色好感 / 状态
curl -X PUT http://127.0.0.1:7620/api/state \
  -d '{"patch":{"characters":{"苏晚晴":{"affinity":72,"status":"心意渐明","notes":"收下绣帕，约定灯会相见"}}}}'

# 修仙文：境界与门派（角色 status + 自由 flags）
curl -X PUT http://127.0.0.1:7620/api/state \
  -d '{"patch":{"flags":{"境界":"筑基三层","门派":"青云宗外门","功法":"长春功"}}}'
```

改动即时生效（fs.watch 落盘即广播），且收编进会话树——回档时一并回退，语义与产品一致。

### 2.3 案例：向量召回外部设定（无需改代码）

把规则书/设定文档导入额外库，模型每轮按语义相似度自动注入：

```bash
curl -X POST http://127.0.0.1:7620/api/memory/import \
  -H "Content-Type: application/json" \
  -d '{"text":"青云宗功法体系：长春功分九层……","fileName":"青云宗功法.md"}'
```

之后 agent 在剧情中遇到相关语义会自动命中注入；也可用 `POST /api/memory/search` 主动检索验证。

### 2.4 案例：世界书召回（关键词/常驻）

- **常驻设定**（永远进上下文）：导入 ST 世界书 JSON（`POST /api/lorebooks/import`），条目 `constant` 项常驻；
- **关键词激活**：条目带 keys 时命中即注入；
- **主动检索**：agent 自己用 `lorebook_search` 工具按需查。
- 也可把 `.liyuan-codex/` 下知识库条目（与世界书同构）挂载进会话（`POST /api/codex/mount`），跨对话共享。

### 2.5 案例：MCP 外设（骰子 / 数据库 / 任意工具）

骰子、强 schema 表格数据库这类领域专用逻辑，写一个标准 MCP 服务器即可，梨园零改动：

1. 配置 `~/.liyuan/mcp.json`（或项目 `.liyuan-mcp.json` / 复用 `~/.claude.json`、Cursor 配置）：

```json
{
  "format": "liyuan-mcp",
  "version": 2,
  "servers": [
    {
      "id": "dice",
      "name": "骰子",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "dice-mcp"]
    }
  ]
}
```

2. 在「扩展能力 → MCP」面板按对话启用 → 工具以 `mcp__dice__*` 注册进 agent，剧情中即可调用。
3. 跑团属性表等强约束数据：MCP 服务器自己持 SQLite/JSON 表，暴露 `roll_dice` / `stat_get` / `stat_update` 工具。

### 2.6 案例：技能（让 agent 学会用外部服务）

`.liyuan-skills/*.md`，frontmatter（`name`/`description`/可选 `disable-model-invocation: true`）+ Markdown 正文（endpoint、认证、请求格式、curl 示例）。agent 摸通外部服务后可自写，用户也可手写后经「扩展能力」面板控制暴露。技能是能力笔记，全局共享，不按卡分。

### 2.7 案例：程序卡 / JS Runner（前端沙箱脚本）

角色卡自带 HTML/JS 在浏览器沙箱 iframe 运行（不落本机），脚本可调 `TavernHelper` API（`getContext()` / `eventOn` / 变量 / extdata），生成走 `ext_generate` 旁路，改稿走 `POST /api/script/message`。前端脚本 + extdata（`GET/PUT /api/extdata`，四作用域）组合可实现完整的界面定制与持久化。

### 2.8 案例：按题材的完整落地路径

| 需求 | 技术路径（全部零代码） |
|---|---|
| 恋爱文：关系进度 | `PUT /api/state` characters.affinity/status/notes（每轮注入）+ agent 自建 SVG 关系图谱面板 |
| 修仙文：门派/境界 | codex 知识库存门派体系（关键词+主动检索）+ state flags 存当前境界（每轮注入） |
| 跑团文：属性记录 | 面板 markdown 表格（属性卡）+ state characters.status；数值约束与骰子走 MCP 服务器 |
| 外部设定文档召回 | `POST /api/memory/import` 向量化（每轮语义注入） |
| 常驻世界观 | 世界书 constant 条目 + 知识库挂载 |

---

## 三、写扩展文件即可实现（不修改梨园源码）

### 3.1 扩展加载规则

`.liyuan/extensions/`（项目级）与全局扩展目录下的 TS/JS 文件会被自动发现加载（jiti 直跑 TS，无需编译）：
- 直接文件：`extensions/*.ts` / `*.js`
- 子目录：`extensions/<name>/index.ts`、或带 `package.json` 声明 `"pi": {"extensions": [...]}`（可带 npm 依赖）

`roleplay.ts` 本身就是一个扩展。你可以在同一目录放自己的扩展文件，实现：

- **注册自定义工具**：`pi.registerTool({...})`（typebox 定义参数 schema，execute 实现逻辑）；
- **事件钩子**：`pi.on("tool_call" | "context" | "message_end" | ...)` 拦截/修改工具调用、注入上下文、自定义压缩；
- **自定义命令**：`pi.registerCommand("mycmd", ...)`；
- **会话持久状态**：`pi.appendEntry()`。

### 3.2 ⚠️ 关键边界：扩展工具与剧情工具集

`roleplay.ts` 的 `applyRpToolset()` 会在会话启动 / MCP 启用 / 工具变更时调用 `pi.setActiveTools()`，把活跃集**收窄**为：剧情工具（RP_TOOLS）+ MCP 工具 + 历史活跃集中的通用工具。因此：

- 扩展注册的工具若不在历史活跃集（savedTools）中，**默认不会自动进入剧情会话的工具面板**；
- 解决：在扩展的 `session_start` 或 `before_agent_start` 钩子中主动调用 `pi.setActiveTools()` 追加自己的工具名（注意在 roleplay 收窄之后执行），或把工具名写入历史活跃集；
- 想进**默认**剧情工具集，只能改 `roleplay.ts` 的 `RP_TOOLS` 名单（见第四节）。

---

## 四、不修改梨园源码就无法实现的能力（明确标注）

| 能力 | 为什么必须改源码 | 改动位置 |
|---|---|---|
| 新增剧情工具进**默认**活跃集 | `applyRpToolset()` 每次启动把活跃集收窄成 RP_TOOLS 名单 | `.liyuan/extensions/roleplay.ts` 的 `RP_TOOLS` 数组 |
| 状态账本新顶层字段 | `applyPatch` 只认 `time/location/characters/inventory/flags/plot_threads` 六个 key，未知字段被忽略并警告 | `src/state.ts` 的 `TOP_KEYS` 与 applyPatch |
| 前端布局 / 新 UI 组件（如改世界信息条的样式与结构、加新页签） | 前端是 React 应用，REST 只给数据不给布局 | `web/src/`（如 `components/StatusStrip.tsx`、`App.tsx`） |
| wire 协议新增字段 | `server/wire.ts ↔ web/src/wire.ts` 必须两端同步改 | 两处 wire.ts |
| harness 级行为（上下文裁剪策略、每轮记账频率、压缩规则） | 这些是记忆优化的核心逻辑，写在接线层与领域层 | `.liyuan/extensions/roleplay.ts` + `src/retention.ts`、`src/scribe.ts`、`src/compaction.ts` |
| 程序卡 TavernHelper 方法表扩展（新增脚本可用 API） | 方法表是宿主适配层硬编码 | `web/src/jsrunner/helper.ts` + `server/script-events.ts` |
| 画图/文生图/语音等内置通道的默认行为调整 | 内置工具实现 | `server/assistant.ts`、`src/tts.ts`、`src/draw-config.ts` |

> 例外提示：很多看似"要改源码"的需求实际能用**配置层组合**绕开——例如跑团骰子用 MCP（§2.5）、自定义表格用面板 + extdata（§2.1）、语义召回用向量库（§2.3）。动源码前先对照第二节。

---

## 五、安全边界（务必阅读）

- 服务**无鉴权**，默认绑 `0.0.0.0`：REST/MCP 仅限本机与局域网，禁止裸暴露公网（对外必须反向代理 + 鉴权）。
- 扩展与 MCP 服务器以**完整系统权限**运行，可执行任意代码——只装可信来源。
- 程序卡 HTML/JS 只在**浏览器沙箱 iframe** 内运行（sandbox + CSP），不落本机；对外 HTTP 仍受浏览器沙箱约束。
- 剧情正文红线：任何外部通道都不应改写剧情正文——显式改稿只能走 `POST /api/script/message`（带「已改写」标记、原文可回滚）。`PUT /api/state` 只能动元信息层，与产品红线一致。
