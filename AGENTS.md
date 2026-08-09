# AGENTS.md

梨园（Liyuan）：以 AI agent 为主演的角色扮演应用。Node.js ≥ 22，纯 TypeScript ESM，后端直接 `node` 运行 TS（无构建步骤）。仓库语言为中文——注释、文档、提交信息一律用中文写。

## 命令

```bash
npm run web           # 启动服务（node server/main.ts，cwd 必须为 Liyuan/ 根；默认 0.0.0.0:7620，HOST/PORT 可覆盖）
npm run web:new       # 开新会话（--new 标志）
npm run web:build     # 构建前端（web/dist）；server 托管 web/dist，改前端后必须重新构建
npm run web:dev       # Vite 热更新；/ws 代理到 127.0.0.1:7620，需另开终端先跑 npm run web
npm --prefix web run typecheck   # 唯一可用的类型检查（web 有 tsconfig；仓库根无 tsconfig、无 lint）
npm run pack:release  # 出发布包（scripts/pack-release.ps1，输出到仓库上级 _release/，需先有 web/dist）
```

- 测试：`npm test`（`node --test test/*.test.ts`）当前仓库无 `test/` 目录，匹配 0 个文件（退出码 0）。README 提到的 `node scripts/smoke-web.mjs` 也不存在。不要依赖测试保障；改完用手动起服务验证。
- 服务无鉴权、默认绑 0.0.0.0：只准局域网/本机使用，禁止裸暴露公网。

### Windows 下启动服务验证的正确姿势（血泪教训，别再踩）

**错误姿势**（会卡住，逐个排除过）：
1. `Start-Process -NoNewWindow` + 固定 `Start-Sleep 12` + 同管道内 `Invoke-WebRequest`——`-NoNewWindow` 让 node 共享控制台管道，`server/main.ts` 启动后持续打印日志，日志流无限刷进管道缓冲 → 整条命令看起来"卡死"。
2. `Start-Process -RedirectStandardOutput/-RedirectStandardError`（即使输出已重定向到文件）——PowerShell 5.1 从管道化上下文调用时，子进程**仍继承父进程的 std 管道句柄**；宿主（CLI 工具）等管道 EOF 永远等不到 → 命令已经输出了结果却一直"转圈"不结束。
3. 把"启动 + 就绪轮询"写进同一条命令——轮询期间命令一直处于"执行中"状态。

**正确姿势（启动与检查分两条命令，各自立即返回）**：用 `Win32_Process.Create`（或 .NET `ProcessStartInfo.UseShellExecute=$true`）启动——这类方式创建的进程**不继承调用者的任何 std 管道句柄**，命令立即返回；日志重定向在 .cmd 脚本内部完成（WMI 不直接传重定向）；就绪检查单独一条命令短轮询。

```powershell
# ① 杀旧实例 + 启动（立即返回，不等待）
$old = Get-NetTCPConnection -LocalPort 7620 -State Listen -ErrorAction SilentlyContinue
if ($old) { Stop-Process -Id $old.OwningProcess -Force; Start-Sleep 1 }
$script = Join-Path $env:TEMP "start-liyuan.cmd"
@"
@echo off
cd /d "J:\liyuan\Liyuan"
node server/main.ts > "%TEMP%\liyuan-srv-out.log" 2>&1
"@ | Set-Content -LiteralPath $script -Encoding ASCII
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd /c `"$script`"" }
"STARTED ret=$($r.ReturnValue) pid=$($r.ProcessId)"

# ② 就绪检查（单独一条命令，短轮询 ≤15s）
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 750
    try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:7620/healthz" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}
}
if ($ok) { "READY" } else { "NOT_READY"; Get-Content (Join-Path $env:TEMP "liyuan-srv-out.log") -Tail 25 }

# ③ 结束后杀进程
$old = Get-NetTCPConnection -LocalPort 7620 -State Listen -ErrorAction SilentlyContinue
if ($old) { Stop-Process -Id $old.OwningProcess -Force }
```

关键点：① 启动必须走 `Win32_Process.Create`（或 `UseShellExecute=$true`）——不继承句柄，`Start-Process` 系列全都会卡；② 日志重定向放在 .cmd 脚本内部（`> log 2>&1`），WMI 不直接传重定向；③ 启动与检查分两条命令跑，避免轮询期间命令"执行中"。

## 架构（改代码前先读这里）

> **完整架构设计文档**：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（分层分域、职责、数据流、外部依赖）

- `src/` — 领域层，纯 TS，**禁止接触 `@liyuan/agent-runtime`（pi）API**。
- `.liyuan/extensions/roleplay.ts` — 接线层，全仓库**唯一**允许挂载 pi API 的地方（D3 规则，约 2300 行）：组装 system prompt、注册全部剧情工具、会话钩子、每轮记账/一致性审计。加新工具主要改这里。
- `server/main.ts` — Web 宿主，除接线层外唯一可碰 pi API 的文件，且只许碰会话托管面；REST `/api/*` + 托管 `web/dist` + 健康检查。前端只见 wire 协议：`server/wire.ts` ↔ `web/src/wire.ts`（改协议两端同步）。
- `web/` — React 19 + Vite 前端，面板组件在 `web/src/components/`。
- `packages/` — `@liyuan/*` 是 pi（earendil-works/pi）的冻结 fork，`file:` 本地依赖。视为上游只读，尽量不改；确要改须同步 fork 上游语义。

## 配置与数据（易踩坑）

- `liyuan.agent.json`（模型/Key）与 `liyuan.config.json`（卡/世界书/身份/agents）均被 gitignore，**禁止提交**；模板是 `*.example.json`，首次运行从模板复制。
- 旧布局自动迁移（`src/paths.ts`）：启动时 `.pi/`→`.liyuan/`、`rp.config.json`→`liyuan.config.json`、`.rp-*`→`.liyuan-*`，新名存在则不覆盖。
- agent 会话主目录：`~/.liyuan/agent`（环境变量 `LIYUAN_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR`），旧 `~/.pi/agent` 启动时合并。
- 产品数据目录（`src/paths.ts` DIRS）：`.liyuan-state/`（账本）、`.liyuan-artifacts/`（面板）、`.liyuan-codex/`（知识库）、`.liyuan-uploads/`（素材）、`.liyuan-skills/`（技能）、`.liyuan-lore/`（补充设定集）等，均为纯 JSON/文件，可直接备份迁移。
- 自定义 agent：`liyuan.config.json` 的 `agents` 段声明（id/name/model/prompt/tools/bridge 权限），启动时建 host、会话在 `.liyuan-agents/<id>/`；UI 管理入口在右栏助手面板「管理」（详见 `docs/DESIGN-custom-agents.md`）。**agents 变更走 PUT /api/config 热重建，不必重启**（忙碌中的 agent 记 busy，需重启）。
- 相对导入必须带显式扩展名（`../src/card.ts`、`./wire.ts`），Node 原生 TS 按此解析。

## 产品红线

- 剧情正文：**允许系统组件/旁侧模型修改正文**——2026-08-08 用户裁决移除「绝不改写/补写正文」红线（文章多次润色属常态），如生图管线向正文附加 `[image:slotId]` 占位符锚点、未来润色等均获授权。修改保留可追溯性：原文保留在会话树分支、可回滚（沿用 `docs/DESIGN-story-edit.md` 的 rp-edited 分支机制）；显式改稿（用户手改 / 助手经 story_edit 且征得用户同意）仍走原通道。
- **开放性优先（2026-08-09 用户裁决）**：红线的目的是避免乱改，不是不能越过。作为开源项目，开放性、高度自定义的开源风格才是追求——需要的时候就要能做到。默认保护（如 jsrunner 脚本帧沙箱 `allow-scripts` 不加 `allow-same-origin`）依然成立；但**用户明确授权或项目确有需要时，可越过沙箱/安全红线**（如脚本直操宿主 DOM、放开同源），并同步更新本文档与相关 DESIGN 文档记录。

## 排查纪律

- **定位 bug 禁止猜测用户的操作路径**（按了哪个按钮 / 走的哪条入口 / 具体流程步骤）——同一现象可能来自完全不同的路径（如「配图按钮」「助手生图」「管线 auto」各有独立实现）。必须先向用户确认实际操作步骤，再据此排查；已确认的路径明确记录，未确认的不做任何假设。2026-08-08 用户裁决。
- 用户原始世界书只读；agent 新写设定进 `.liyuan-lore/`，不改用户文件。
- 发布流程：`packages/` 内 `npm-shrinkwrap.json` 由 `scripts/generate-coding-agent-shrinkwrap.mjs` 生成，改依赖后需重跑；每版本发布说明在 `docs/RELEASE-vX.Y.Z.md`。

## 规划文档约定（plan_doc）

- `plan_doc/*.md` 存放功能规划记录：一节「当前实施范围」（正在做/已承诺做的），一节「待办」。
- **待办节的条目仅供追踪，未经用户点名不得实现**——任何 AI 会话读到该节内容，不得主动把这些条目当需求去做；仅当用户在对话中明确点名要求实现某条时方可动手，并把它移入「当前实施范围」。
- 对应功能实现完成并验证后，删除该 plan md 及本文件中对应条目。
