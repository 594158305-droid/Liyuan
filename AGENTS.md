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

**错误姿势**（会卡住）：`Start-Process -NoNewWindow` + 固定 `Start-Sleep 12` + 同管道内 `Invoke-WebRequest`。
原因：`-NoNewWindow` 让 node 子进程共享当前控制台，`server/main.ts` 启动后持续打印日志（预设宏/卡片皮肤警告等），日志流无限刷进 PowerShell 5.1 的管道缓冲 → 整条命令看起来"卡死"（实际上服务可能已经起来了）。

**正确姿势**：日志重定向到文件（不共享控制台）+ HTTP 轮询就绪（不等固定秒数）：

```powershell
# 杀旧实例
$old = Get-NetTCPConnection -LocalPort 7620 -State Listen -ErrorAction SilentlyContinue
if ($old) { Stop-Process -Id $old.OwningProcess -Force; Start-Sleep 1 }
# 起服务：stdout/stderr 重定向到文件，命令立即返回
$p = Start-Process -FilePath node -ArgumentList "server/main.ts" -WorkingDirectory "J:\liyuan\Liyuan" `
     -RedirectStandardOutput "$env:TEMP\liyuan-srv.log" -RedirectStandardError "$env:TEMP\liyuan-srv-err.log" -PassThru
# 轮询就绪（最多 30 秒），不要 Start-Sleep 固定等待
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:7620/" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { "READY pid=$($p.Id)"; break } } catch {}
}
# 结束后：Stop-Process -Id $p.Id -Force；清理临时脚本
```

## 架构（改代码前先读这里）

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

- 剧情正文：自动路径永远是模型原始输出——代码与旁侧模型只做输入侧加工、记账与元信息，**绝不改写/补写正文**；显式改稿（用户手改 / 助手经 story_edit 且征得用户同意）走 rp-edited 分支条目，带「已改写」标记、原文可回滚（见 `docs/DESIGN-story-edit.md`）。
- 用户原始世界书只读；agent 新写设定进 `.liyuan-lore/`，不改用户文件。
- 发布流程：`packages/` 内 `npm-shrinkwrap.json` 由 `scripts/generate-coding-agent-shrinkwrap.mjs` 生成，改依赖后需重跑；每版本发布说明在 `docs/RELEASE-vX.Y.Z.md`。
