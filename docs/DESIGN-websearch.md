# 内置网络搜索 MCP（SearXNG 后端，可插拔）设计

> 状态：设计定稿并已实现（2026-08-10）。searxng 与 tavily 后端均已落地。
> 对应待办：`docs/WAIT_TO_CODE.md`「工具能力增强 → web search 原生支持」。

## 1. 背景与目标

给梨园的 agent（台上叙事引擎 / 右栏助手）加原生 web search 能力，场景是「助手查资料辅助剧情 / 答疑」，轻度低频。

选型结论（评估见对话记录）：**内置 MCP server + 自托管 SearXNG 后端**，即方案 2：

- 无 API key、无限次、查询不出本机（隐私最优）
- 聚合 Bing/Google/百度等引擎，中文可用性最好
- 复用梨园已有 MCP 基建（`src/mcp.ts` 完整 client + 内置 server 先例 `vision-server.mjs`），三面（台上/助手/剧情）自动接入，零补丁零改 pi fork

后端做成**可插拔**（默认 `searxng`，预留 `tavily`）：上游免费额度/反爬策略变化是常态，切换成本 = 改一个配置项。

## 2. 方案总览

```
台上 StageEngine ─┐                    ┌─> SearXNG(docker, 127.0.0.1:8080)
助手 pi Agent ────┼─ McpHub ── stdio ──┤   聚合: Bing/Google/百度/…
剧情扩展 ─────────┘   (src/mcp.ts)   (子进程)  websearch-server.mjs
                                     └─> (预留) Tavily API
```

- 内置条目经 `builtinMcpServers()` 进入发现目录（builtin 层），用户 UI 开关后按既有流程接入，**不新增任何接线代码**。
- 搜索请求只发到本机 SearXNG；SearXNG 侧才出公网。

## 3. 内置 MCP server：`server/mcp/websearch-server.mjs`

仿 `server/mcp/vision-server.mjs` 的现成范式：

- `#!/usr/bin/env node` + 官方 SDK `Server` + `StdioServerTransport`
- 配置从 env 读（`LIYUAN_WEBSEARCH_*`），UI「扩展 → MCP → 内置」可编辑
- stdio 纪律：stdout 只走 MCP 协议，日志一律 stderr
- 错误一律返回 `isError: true` 的文本结果，且报错文案给可执行指引（SearXNG 未起 → 提示 docker 命令）

### 3.1 工具 schema

```json
{
  "name": "web_search",
  "description": "通过网络搜索引擎检索公开网页，返回标题+URL+摘要列表，用于查资料、核实信息。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":            { "type": "string", "description": "搜索关键词，越具体越好" },
      "language":         { "type": "string", "description": "语言（SearXNG 代码），默认 zh" },
      "max_results":      { "type": "integer", "description": "返回条数 1-10，默认 5", "minimum": 1, "maximum": 10 },
      "time_range":       { "type": "string", "enum": ["day", "month", "year"], "description": "可选：只看近期结果" },
      "safesearch":       { "type": "integer", "enum": [0, 1, 2], "description": "安全搜索 0关/1中/2严，默认 1" }
    },
    "required": ["query"]
  }
}
```

### 3.2 后端抽象（可插拔）

server 内按 `LIYUAN_WEBSEARCH_BACKEND` 分发到实现函数，工具接口不变：

| backend | 实现 | 关键配置 |
|---|---|---|
| `searxng`（默认） | GET `{url}/search?q=&format=json&language=&safesearch=&time_range=&categories=general` | `LIYUAN_WEBSEARCH_SEARXNG_URL`（默认 `http://127.0.0.1:8080`） |
| `tavily` | POST `https://api.tavily.com/search`，Bearer 认证（1,000 credits/月免费，无卡注册） | `LIYUAN_WEBSEARCH_TAVILY_API_KEY`（必填）；`LIYUAN_WEBSEARCH_TAVILY_URL` 可覆盖端点（代理/测试用） |

两个后端共用同一工具 schema 与返回格式（tavily 侧经归一化：engine 固定 `tavily`、`published_date` 映射为统一字段）。

### 3.3 SearXNG 实现要点

- 请求头仅 `Accept: application/json`，无需 UA / API key（openclaw 生产先例）
- 响应 `results[]` 取 `title` / `url` / `content`（截断 ~300 字），**条数由 server 截取**（SearXNG 无每页条数参数）
- `language` 不传时由 SearXNG 按 `default_lang` 自动判定，但默认显式传 `zh` 保证中文场景
- 关键坑防错文案：
  - HTTP 403 → 提示「settings.yml 的 search.formats 需含 json」（未启用时 webapp.py 直接 abort 403）
  - 连接失败 → 提示 docker 启动命令 + healthz 探测
- 超时：`LIYUAN_WEBSEARCH_TIMEOUT_MS` 默认 15s，AbortController 实现，`AbortSignal` 透传（承接调用方取消）

### 3.4 返回格式

文本列表（MCP text content，模型友好、token 可控）：

```
1. <标题>  (2分钟前 · bing)
   <URL>
   <摘要 ~300字>

2. ...
```
尾部附引擎失败/降级信息（如部分引擎无响应时给出 `unresponsive_engines`）。

## 4. 注册与配置

### 4.1 `src/mcp.ts` 扩展（唯一改动的领域层文件）

- 新增 `LIYUAN_WEBSEARCH_*` env 键清单（仿 `VISION_ENV_KEYS`，L286）
- `builtinMcpServers()`（L298）追加条目：

```ts
{
  id: "liyuan_websearch",
  name: "网络搜索",
  enabled: false,           // 默认关：SearXNG 未必部署；UI 一键开
  transport: "stdio",
  command: process.execPath,
  args: [join(root, "server", "mcp", "websearch-server.mjs")],
  env: { ...进程环境里 LIYUAN_WEBSEARCH_* },   // 可被 ~/.liyuan/mcp.json / 项目覆盖层盖掉（L476 收口逻辑现成）
  cwd: root,
  source: "builtin", sources: ["builtin"], discovered: true, builtin: true,
}
```

- **默认关**的取舍：与视觉识图一致；未部署 SearXNG 时台上不会多一个必错工具。用户部署后在 UI 开一次即可（会话级快照随 rewind/fork 走，机制现成）。

### 4.2 配置项汇总

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `LIYUAN_WEBSEARCH_BACKEND` | `searxng` | 后端：`searxng` / `tavily` |
| `LIYUAN_WEBSEARCH_SEARXNG_URL` | `http://127.0.0.1:8080` | SearXNG 地址 |
| `LIYUAN_WEBSEARCH_TAVILY_API_KEY` | — | tavily 后端时必填（tavily.com 免费注册，1000 次/月） |
| `LIYUAN_WEBSEARCH_TAVILY_URL` | `https://api.tavily.com/search` | tavily 端点，可覆盖（代理/测试） |
| `LIYUAN_WEBSEARCH_TIMEOUT_MS` | `15000` | 单次搜索超时 |

用户也可完全绕开内置 server，在 `.liyuan-mcp.json` 里接任意第三方搜索 MCP（发现分层现成，无需任何代码）。

## 5. SearXNG 部署指引（写入实现后的文档/说明文案）

### 5.1 最小部署（单容器，limiter 默认关，无需 valkey）

```bash
mkdir -p searxng-config && cd searxng-config
# settings.yml 见下
docker run -d --name liyuan-searxng --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v "$PWD:/etc/searxng/" -v searxng-data:/var/cache/searxng/ \
  docker.io/searxng/searxng:latest
```

端口只绑宿主机 `127.0.0.1`——局域网无鉴权环境下绝不对外暴露。

### 5.2 settings.yml 关键项（三个坑一个不能漏）

```yaml
use_default_settings: true        # 继承完整引擎表
search:
  formats:
    - html
    - json                        # 必须显式加：默认仅 html，否则 format=json 直接 403
server:
  limiter: false                  # 默认即 false，显式写明；不引入 valkey 依赖
engines:                          # 中文引擎默认全禁用，逐个启用
  - name: baidu
    disabled: false
  - name: bing
    disabled: false
    base_url: https://cn.bing.com # 国内实例用 cn.bing.com（上游源码注释建议）
```

若以后开 limiter（`true` + valkey），自家调用方 IP 必须进 `limiter.toml` 的 `[botdetection.ip_lists] pass_ip`，否则纯 API 请求被 bot 检测拦截。

### 5.3 验证

```bash
curl "http://127.0.0.1:8080/healthz"        # → OK
curl "http://127.0.0.1:8080/search?q=测试&format=json&language=zh" | head -c 500
```

## 6. 接入与生效路径（零接线代码）

```
builtinMcpServers() 新增条目
  → discoverMcpCatalog builtin 层（L401）
  → UI 开关（会话启用集，随 rewind/fork 走）
  → syncMcp connect（roleplay.ts L317）
  → 助手侧：registerMcpTools（L248，pi.registerTool）
  → 台上侧：mcp-stage.ts（src/stage/mcp-stage.ts L85，McpStageDeps 注入即自动出现在台上工具清单）
```

工具名在台上显示为 `mcp__liyuan_websearch__web_search`，描述带 `[MCP:liyuan_websearch]` 前缀（模型据此知道失败时该报错而非换工具重试）。

## 7. 边界与安全

- **读侧工具**：不进 `src/tools/gate.ts` 的 GATED_TOOLS（写入门禁只拦写）
- **不自动写正文**：搜索结果作为工具返回值给模型引用；正文落字仍走既有 story_edit 通道（可追溯、可回滚），维持「修改保留可追溯性」红线
- **隐私**：查询只到本机 SearXNG；SearXNG 端口绑 127.0.0.1
- **防滥用**：safesearch 默认 1、max_results ≤10、超时 15s、取消透传
- **stdout 纪律**：MCP 协议纯净，日志走 stderr，避免协议污染

## 8. 验证方案

1. **server 单测**（手动驱动脚本 `scripts/drive-websearch.mjs`）：起 SearXNG 后，用 MCP client 连 stdio server，调 `web_search` 验证：正常检索 / 中文查询 / 403 文案 / 未部署连接失败文案 / 超时
2. **集成**：起梨园 → UI「扩展 → MCP → 内置 → 网络搜索」开开关 → 对话让助手「搜一下 X」→ 检查助手侧工具调用与返回
3. **台上**：叙事回合里让剧情侧模型用搜索（观察 activity 条「MCP liyuan_websearch · web_search」）
4. **降级路径**：停掉 SearXNG → 再调工具 → 报错文案含 docker 指引，模型能理解并告知用户

## 9. 后续扩展（不在本次范围）

- `web_fetch` 工具：抓取单页正文（SearXNG 结果只有摘要，深读需抓取）——二期按需
- SearXNG 供其他功能复用（如 codex 知识库扩充素材）
