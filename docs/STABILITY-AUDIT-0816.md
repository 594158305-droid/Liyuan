# 代码隐患排查与稳定性评估报告（STABILITY-AUDIT-0816）

> 日期：2026-08-16 · 只读排查基线：HEAD `a37f024`（2026-08-15）· 执行方式：架构文档 + 功能文档 + git log 全史 + 实测测试套件 + 关键源码核验
> 本文档为排查结论快照；文末「修复记录」跟踪随后的落地动作（CI 红测 / jsrunner 断链）。

## 0. 评估基线

| 维度 | 实测数据 |
|---|---|
| 仓库年龄 | 全史仅 **2026-08-05 → 08-16 约 10 天**密集开发，无长稳沉淀期 |
| 测试实测 | `npm test`（node v24.18.0）→ **929 用例 / 918 过 / 11 挂**（exit 1） |
| 11 挂构成 | `test/lorebook.test.ts` 10 例（fixture `assets/lorebooks/Mistvale.json` 缺失 ENOENT——该目录被 `.gitignore:102` 整段忽略，干净检出必然缺失）+ `test/assistant-gateway.test.ts` 1 例（globalThis 槽用例形状与 P3 注册表实现不符） |
| 文档基线 | `docs/README.md` 索引基线 `0856703`（08-10），已滞后于 HEAD；`DESIGN-router.md`（08-16）未入索引 |
| 档位定义 | 极低 / 低 / 中 / 高 / 极高——综合「git 新增时间（越晚越不稳）+ 测试覆盖（覆盖越全、越容易执行越稳；跑不起来的护栏视为失效）+ 近期修复密度 + 改动回归面」 |

## 1. 稳定性评估总表（按域）

### 1.1 叙事引擎域（主聊天心脏）

| 功能 | 落点 | git 新增 | 测试覆盖 | 档位 |
|---|---|---|---|---|
| 台上回合循环（装配→生成→验收→精修→记账→谢幕） | `src/stage/engine.ts`（2059 行）/ assemble / workspace / draft（928 行） | 08-06 起持续打磨 | stage-engine / stage-assemble / workspace / draft / stage-revise / stage-compact / stage-scribe / retention / swipe / timeline 等多族 | **高**（主体）；⚠ 08-15 刚动（世界线返回点 / TODO 派发 / 评审 / 暂存 / router 接线），**局部低** |
| 分轮演出流程（7 张轮次卡 + 三道硬件门禁） | engine.ts roundCardFor / agentLoop | 08-08 定稿，当晚二次修正（同轮连发门禁） | stage-engine 集成断言 | **高** |
| 流程配置外置（轮次卡/拆层表/意图正则） | flow-templates / preset-split / turn-intent + `assets/flow/*.json` | 08-13 | flow-templates(9) / flow-split-tables(5) / turn-intent(4) 逐字比对兜底 | **中**（双源同步持续负担；`intentRegex` 当前无调用点 = 死接口） |
| 语义评审（封笔旁路模型三维评审） | `src/stage/review.ts` / workspace 集成 | 08-14 | review.test.ts + stage-engine 集成 | **低**（旁路行为离线不可验证；**默认开** = 每封笔多一次 LLM 调用；软约束「修了没修好」是已知边界） |
| 工具暂存（DSH 双阶段） | `src/tool-staging.ts` | 08-15 | tool-staging.test.ts（11 例） | **低**（仅 `deepseek-v4-pro`；实弹仅冒烟） |
| **router**（弱人格 + 模式卡 + 旁路收敛） | router-core / router-config / engine（`# 演出姿态` assemble.ts:338）/ main.ts resolveSideModel | **08-16 最新** | router-core(25) / router-config / stage-router(9) 纯函数单测 | **极低** ⚠ **默认开**且直接改全主演路径 system 前缀 + 注入卡；P5 实弹矩阵未跑、P4 助手侧仅留开关、词表初稿待校准 |
| 场记记账 + 表格逐表派发 | scribe-run / `table-todo.ts` | 08-13~08-15 密集 | stage-scribe / table-backfill | **低–中**（逐表派发最新，table-todo 无专门测试） |
| 主聊天跟踪 trace | `src/stage/trace.ts` | 08-11 | trace.test.ts | **中**（调试辅助，失败静默吞） |
| 写作技能体系（writing_guide / 场景触发表 / stage-topic） | stagehand / engine getSkill fallback | 08-11 | skills / stage-engine 部分 | **中** |

### 1.2 世界域 / 内容生成域 / agent 域

| 功能 | 落点 | git 新增 | 测试覆盖 | 档位 |
|---|---|---|---|---|
| 世界状态账本 | src/state.ts | 08-05 起 | state.test.ts | **高** |
| 世界线（含返回点） | src/worldline.ts | 08-05 起；08-15 加返回点 | worldline.test.ts | **高**（近期改动局部低） |
| 世界书 lorebook | src/lorebook.ts | 08-05 起 | **10 例全挂（fixture 缺失）→ 护栏失效** | **中** |
| 知识库 / 向量记忆 | codex / memory | 08-07~08 | codex / memory / tools-memory | **高** |
| 生图底座 | src/draw/ | 08-05 起分层 | 测试最全一族 | **高** |
| 生图近期修复（slot 路径 / 钉回旧层 / 分栏 LWBox / 时刻盘点 / 画师 agent / 文风单锚） | draw-plugins/ | 08-11~08-14 修复密集期 | draw-slot / draw-role / draw-embed-target 等 | **低–中**（修复密集 = 行为仍漂移；画师 agent 无测试） |
| 角色自动学习 / 服装档案 | draw-role-learn | 08-05 起；WAIT_TO_CODE 待验证 | draw-role-learn.test.ts | **低–中** |
| TTS | src/tts.ts | 老 | tts.test.ts | **高** |
| 音效 play_sound | 工具 + Web Audio | **08-12** | **无测试** | **低** |
| 助手托管 assistant.ts（2341 行）+ stagehand | server/assistant.ts | 08-06 起 | stagehand / stagehand-return | **中**（大文件 + 08-11 才修 currentCard 作用域 bug） |
| 委托网关 | assistant-gateway | 老 | **1 例挂（与实现不符）** | **低–中** |
| 自定义 agent / story_edit | assistant.ts / main.ts:2199-2252 | 08-08~09 | **无专门测试**（DESIGN-story-edit §9 遗留「需复核」） | **低–中** |
| MCP + 内置网络搜索 | mcp.ts / websearch-server.mjs | 08-10 | mcp/mcp-stage 有测试；**websearch 仅手动 drive-websearch.mjs** | **低–中**（默认关缓解） |
| 正则脚本管理 | tools/regex.ts | 08-07 | **无专门测试** | **低–中** |

### 1.3 jsrunner / 表格 / 前端 / 宿主

| 功能 | 落点 | git 新增 | 测试覆盖 | 档位 |
|---|---|---|---|---|
| JS Runner 沙箱（13 模块） | web/src/jsrunner/ | 08-06~08-09 密集 | **仅 jsrunner-baseline.test.ts** | **低** |
| 世界状态账本 UI（V1/V2） | ledger + 前端 | 08-09 | **无测试（前端）** | **低** |
| 沙箱同源放开 | runtime.ts sandbox | 08-09 用户裁决 | 无 | **极低–低**（按设计，安全面扩大） |
| 表格/模板系统 + 历史回填 + ACU | templates / table-backfill | 08-09~08-10 | templates / table-backfill | **中** |
| 表格填表遵从度（纪律注入/预算放大） | 引擎+提示词 | 08-10~08-13 | 部分 | **低–中** |
| wire 协议 | server/wire.ts ↔ web/src/wire.ts | 老 | wire.test.ts 25/25 | **极高** |
| server/main.ts / rest.ts | **4504 / 5568 行**单体 | 08-05 起膨胀 | 分散覆盖 | **中**（超大文件回归面大） |
| ST 原始导入 | src/import-raw.ts | 08-09 | import-raw.test.ts | **低–中** |
| 聊天记录导入 | src/chatlog.ts | 老 | chatlog.test.ts | **高** |
| 前端 React 组件（20+ 面板） | web/src/components/ | 全程 | **零组件测试**（仅 timeline.ts 纯模块有测试） | **低–中** |
| 回合窗口化渲染 | web/src/App.tsx | 08-09~08-10 两天三改 | **无** | **低** |
| ui-custom / 背景图 / 玻璃化 | web/src/ui-custom.ts | 08-10~08-12（当日修 2 bug） | **无** | **低** |
| 用户消息收起 / 图片操作条 | App.tsx / Messages.tsx | 08-10~08-11 | **无** | **低–中** |
| 前端模型选择归一 | ModelSelect | 08-14 | **无** | **低–中** |

## 2. 全局隐患清单

### 🔴 高危

1. **CI 单元测试门禁恒红**：CI（`.github/workflows/ci.yml` unit job）三平台直接 `npm test`，实测 **11 挂**（lorebook 10 例 fixture 被 gitignore + assistant-gateway 1 例与实现不符）→ **push 即红，回归无机器兜底**。
2. **router 默认开、实弹矩阵未跑**（DESIGN-router §9 P5 ⏳）：`router.enabled` 默认开，`# 演出姿态` 已进 system、模式卡已进注入区——最新、零真实 LLM 验证的全局行为变更。
3. **语义评审默认开 + 旁路成本**：每次有戏封笔多一次旁路调用；软放行边界（证据引文消失即视为已修）。
4. **jsrunner 两处真实断链**（已核代码现状）：
   - `POST /api/script/message` **路由不存在**，但 `web/src/jsrunner/helper.ts:311,320` 仍在调用 → 调用即 404（当前无脚本实际调用 = 潜伏）；
   - `server/script-events.ts` `mapPiEventsToSt` **零调用**——服务端事件桥死代码，ST 事件依赖前端投影子集。

### 🟡 中危

5. **packages/ai dist 重建门槛**：dist 停在 08-07；docs 记录 tsgo 缺失无法重建 → 「流式开关通用化」运行时死代码，**发版前必须重建 dist**。
6. **已知设计级遗留**（docs 索引 §2，均未动）：P6 draft_write 门禁扩判据；ask 落树留痕（wire.ts choiceOfToolResult 只认 ask_director）；sov 主权检查第一人称盲区；状态栏根治法「先记录不做」；M-D4/M-D5 未完成。`/reroll <带参>` 路由破口**已确认修复**（main.ts:3763-3792）。
7. **文档滞后于代码**：docs 索引基线 08-10 → HEAD 08-15/16；DESIGN-router 未入索引。
8. **超大单体文件**：rest.ts 5568 / main.ts 4504 / roleplay.ts 2907 / assistant.ts 2341 / engine.ts 2059——D3 纪律靠自觉。
9. **发布链依赖本地产物**：`pack:release` 打包本地 web/dist，存在「源码改了、dist 没重建就发版」的缝隙。

### 🟢 低危 / 已知边界

10. **安全面**：服务无鉴权默认绑 0.0.0.0（禁止裸暴露公网）；jsrunner 沙箱同源已按用户裁决放开。
11. **测试的「质」**：918 绿中相当比例是现状锁定/逐字比对类（flow-templates / style-baseline 双源镜像），验证「没退化」强、验证「行为正确」弱；真实 LLM 行为全部靠手动驱动脚本。

## 3. 结论速览

- **越晚越不稳的链条**：router（08-16，极低）→ 语义评审/工具暂存/逐表派发/世界线返回点（08-14~15，低）→ 文风单锚/模型选择归一（08-14，低）→ 流程配置外置/场记按域/生图修复密集期（08-13，低–中）→ trace/写作技能/play_sound/界面自定义（08-11~12，中）→ 表格系统/窗口化/旁挂模型/web search（08-09~10，中）→ 底座与老域（08-05~08，高）。
- **全仓库无「极高」档**（除 wire 协议 25/25），全史只有 10 天。
- **最该盯的三件事**：① CI 恒红 → 回归无兜底；② router 默认开但零实弹；③ 语义评审默认开的每拍旁路成本与软放行语义。
- **测试护栏失效两处**：lorebook（10 例跑不起来）+ assistant-gateway（1 例与实现不符）——修复成本低，优先。

## 4. 修复记录（2026-08-16 起）

> 用户下令：先修复 CI 红测和 jsrunner 断链。落地项在此逐条记录（完成后更新状态与复测数字）。

| # | 事项 | 落点 | 状态 |
|---|---|---|---|
| 1 | lorebook.test.ts 改自包含 fixture（不依赖 gitignore 资产） | `test/lorebook.test.ts` | ✅ 完成 |
| 2 | assistant-gateway.test.ts globalThis 槽形状对齐 P3 注册表 | `test/assistant-gateway.test.ts` | ✅ 完成 |
| 3 | 补 `POST /api/script/message` 路由（setMessage/deleteMessage 404） | `server/rest.ts` | ✅ 完成（流式中 409；op/lastRoleIndex/text 校验 400） |
| 4 | 事件桥接线：`mapPiEventsToSt` 从 StageEngine 事件桥发射 GENERATION_STARTED / MESSAGE_SENT（无投影重叠，零双发） | `server/main.ts`（import + onTurnStart + 用户回显两处广播点） | ✅ 完成 |
| 5 | 复测 | `npm test` + `scripts/smoke-web.mjs` + 路由校验冒烟 | ✅ **929 过 / 0 挂**（exit 0）；smoke-web ✓（服务正常启动）；`POST /api/script/message` 校验三路径均 400 按预期 |
| 6 | 更新 AGENTS.md 测试数字 + jsrunner-port.md 头注 + docs/README.md §4 + DESIGN-jsrunner-ledger §11 | 文档 | ✅ 完成 |

**修复说明**：
- CI 红测（原 11 挂）：lorebook 10 例改为测试内联自包含 fixture（`assets/lorebooks/` 被 `.gitignore:102` 整段忽略，干净检出必然缺失，fixture 不该依赖 git 跟踪策略）；assistant-gateway 1 例为测试用例形状停留在 P3 之前的单 runner 槽（`{runner}`），对齐为当前注册表形状（`{runners: {assistant}}`）——实现无误，测试过期。
- jsrunner 断链①：`POST /api/script/message` 此前无路由，`web/src/jsrunner/helper.ts:311,320` 调用即 404；已按 `host.scriptEditMessage` 接口补路由（与 story_edit 同语义：edit 注入 rp-edited-reply、delete 钉叶到前驱）。
- jsrunner 断链②：`server/script-events.ts` 的 `mapPiEventsToSt` 此前零调用（死代码）。主聊天为自研 StageEngine（不经 pi 会话循环），故接线点为 StageEngine 事件桥：onTurnStart 发射 GENERATION_STARTED、用户消息回显发射 MESSAGE_SENT（此前前端投影均不产生这两类，零双发）；WORLD_STATE_CHANGED / GENERATION_ENDED / MESSAGE_RECEIVED 仍由前端投影（`web/src/jsrunner/events.ts`）承接。前端零改动，无需重建 web/dist。

**遗留（本次未动，另见 §2）**：packages/ai dist 重建、router P5 实弹矩阵、语义评审旁路成本、设计级遗留（P6/ask 落树/sov 第一人称/状态栏根治/M-D4/M-D5）、前端组件测试空白。

### 5. jsrunner 兼容缺口补齐（2026-08-16）

> 目标：jsrunner-port.md §5 缺口表。先复核代码，发现 **G1/G2 早已实现未标注**（SillyTavern 槽、generateRaw ordered_prompts+custom_api）；本次真正落地 G3/G6/G7，并对 G4/G5/G8 标注现状。验证：typecheck ✓、**BRIDGE_JS `new Function` 语法编译 ✓**、web:build ✓、`npm test` 989 过 / 0 挂 ✓、smoke-web ✓。

| 缺口 | 处置 | 落点 |
|---|---|---|
| G1 `window.SillyTavern` | 已实现（复核确认）— 惰性扁平快照桩 + extensionSettings 持久化 | bridge.ts getter / context.ts |
| G2 `generateRaw` 参数子集 | 已实现（复核确认）— ordered_prompts 全槽位 + custom_api 前端直连 | helper.ts implGenerateRaw / prompts.ts |
| G3 脚本带参触发通道 | **本次落地**：`registerScriptAction(name,fn)`（window + TavernHelper 别名）+ `{kind:"action"}` 帧 + runtime.invokeAction / invokeActionByScriptMatch + 面板按钮 `action` 字段 | bridge.ts / runtime.ts / types.ts / LedgerScriptViews.tsx / JsRunnerPanel.tsx |
| G5 `getContext` 字段 | 部分已补（复核确认）：currentChatId/characterId/personaDescription/extensionSettings/chat_metadata/characters；**仍缺** groupId（无组）/powerUserSettings/getRequestHeaders（无 ST 对等物） | context.ts buildSnapshot |
| G6 `tavern_events` 常量表 | **本次落地**：`window.tavern_events = EVENT_TYPES` + `TavernHelper.events` 别名 | bridge.ts |
| G7 Proxy monkey-patch 覆写 | **本次落地**：Proxy 加 `set` trap → overrides 表，`get` 优先返回覆写值 | bridge.ts |
| G4 / G8 / G9 / G10 | 无通用补法（G4 ST DOM）；'current'=当前卡（单卡语义）；getRequestHeaders/power_user 空桩降级；toastr 已改宿主 toast — **保持现状** | — |

**注**：本批改动全部在前端 `web/src/jsrunner/`，已重建 `web/dist` 生效。测试套件经其他并行工作扩展至 989 用例，全绿。

