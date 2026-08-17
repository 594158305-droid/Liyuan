# JS Runner（TavernHelper）移植文档

> 版本：M5 兼容性审计 · 适用代码基线：`web/src/jsrunner/*` + `server/script-events.ts` + `server/main.ts`（ext_generate / scriptEditMessage）
> 目标：SillyTavern JS-Slash-Runner（TavernHelper）→ Liyuan 的能力等价移植，**旧脚本零改动**运行。
>
> ⚠ **部分内容与当前代码不符（2026-08-10 核对，详见 docs/README.md §4）**：
> ① §3.2/§6 声称的服务端事件桥——**2026-08-16 已部分接线**：`server/main.ts` 经 `mapPiEventsToSt` 从 StageEngine 事件桥发射 `ext_event` 帧（GENERATION_STARTED / MESSAGE_SENT）；WORLD_STATE_CHANGED / GENERATION_ENDED / MESSAGE_RECEIVED 仍由前端投影（`web/src/jsrunner/events.ts:28-46`）承接，两源无重叠不双发；
> ② `POST /api/script/message` 路由——**2026-08-16 已补**（`server/rest.ts`，调 `host.scriptEditMessage`），setMessage/deleteMessage 不再 404（DESIGN-jsrunner-ledger.md §11 断链表第 6 项同此销案）；
> ③ §5 缺口表大部分已由代码演进补齐（2026-08-16 复核）：G1（SillyTavern 桩）/G2（generateRaw ordered_prompts+custom_api）早已实现未标注；G6（tavern_events 常量表）/G7（Proxy set trap）/G3（带参动作触发通道）**本次落地**。仍未补的非阻塞项：G4（ST 专属 DOM，无通用补法）、G8 参数语义（Liyuan 单卡语义下 'current'=当前卡）、getRequestHeaders 空桩（无 ST 对等物）。各缺口逐条现状见 §5。本文档保留为 M5 审计基线，缺口全表仍有效。

---

## 1. 概述

Liyuan 移植了 SillyTavern 生态的 **JS-Slash-Runner** 扩展（下文简称 JS Runner）：旧酒馆脚本以
沙箱 iframe 方式运行，通过 `window.TavernHelper`（Proxy）与宿主全局 API（`getContext` /
`eventOn` / `toastr` 等）与 Liyuan 交互，目标是**旧脚本零改动**即可运行——脚本不知道自己跑在
Liyuan 上。

移植范围（按里程碑）：

- **M1**：extdata 通用持久化通道（`/api/extdata`，`src/extdata.ts`）
- **M2**：事件桥 `jsrunnerBus`（wire 帧 → 脚本事件）
- **M3a**：脚本 iframe 运行时 `runtime.ts`（增量启停 + 消息路由）
- **M3b**：宿主适配层 `helper.ts`（TavernHelper 方法表）+ `context.ts`（变量/快照）+ `bridge.ts`
  （iframe 注入面）
- **M4a**：脚本管理面板 `JsRunnerPanel`（PowersPanel「脚本」tab）
- **M4b**：日志查看器 `LogViewer` + 变量管理器 `VariableManager`（日志环形缓存 `log.ts`）
- **M5**：本文档（兼容性审计 + 缺口清单）

兼容策略：**能映射到 Liyuan 对等物的 API 走真实通道；无对等物的给桩（降级）；既无对等物又无桩的
返回明确错误**——任何情况都**不炸宿主**。

---

## 2. 架构

三层结构：

```
┌─────────────────────────── 脚本层（沙箱 iframe，display:none）───────────────────────────┐
│  window.TavernHelper（Proxy）· getContext() · eventOn/Once/Off/Emit · substituteParams │
│  window.toastr（桩）· console（代理转发）· $ (jQuery) / YAML（vendor 注入）             │
│  脚本本体（每个 enabled 脚本一个 <iframe srcdoc>，挂 #jsrunner-host 容器）              │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ postMessage（{kind: ready/log/invoke/event}）
                                           ▼
┌─────────────────────────── 宿主适配层（web/src/jsrunner/）──────────────────────────────┐
│  runtime.ts   路由消息：log→onLog · invoke→onInvoke · event→onEvent · ready→补发快照      │
│  helper.ts    TavernHelper 方法分发表（tavernHelperImpl）+ generate 流式回执配对          │
│  context.ts   上下文快照（hello/message 帧投影）+ 变量缓存（getVar/setVar/addVar/deleteVar│
│                + extdata 防抖持久化）                                                    │
│  bridge.ts    生成注入 iframe 的桥源码（BRIDGE_JS 自包含字符串）                          │
│  bus.ts       事件总线（ext_event 广播 / 原始帧 sink 透传）                              │
│  log.ts       日志环形缓存（≤500 条，订阅者推送）                                        │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ ws ClientFrame{ext_generate} / REST /api/*
                                           ▼
┌─────────────────────────── 后端通道（server/）──────────────────────────────────────────┐
│  main.ts          ext_generate → 旁路模型生成（streamSimple，与剧情会话解耦）             │
│  rest.ts          /api/extdata（global/preset/character/chat 四作用域 key-value）        │
│                   /api/script/message（edit/delete，分支导航 + rp-edited-reply 注入）    │
│  script-events.ts pi 会话事件 → ST 风格 ext_event 帧（CHAT_CHANGED/GENERATION_*/MESSAGE_*）│
│  src/extdata.ts   JSON 落盘 <cwd>/.liyuan-state/extdata/<scope>.json                     │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **脚本层**：运行时 `runtime.ts` 为每个 enabled 脚本建一个隐藏 `<iframe srcdoc>`，
  `bridge.ts` 生成的 `BRIDGE_JS` 注入后与宿主 `postMessage` 通信。
- **宿主适配层**：`helper.ts` 的 `RuntimeHost.onInvoke` 查 `tavernHelperImpl` 分发表执行；
  `context.ts` 维护 getContext 快照与脚本变量；`log.ts` 承接脚本 console 输出。
- **后端通道**：变量/脚本列表走 REST extdata；程序化生成走 WS `ext_generate` → `ext_gen`
  流式回执；改稿走 REST `/api/script/message`；pi 事件经 `script-events.ts` 映射后以
  `ext_event` 帧广播回前端。

---

## 3. 数据流

### 3.1 脚本 invoke → 宿主方法

```
脚本: TavernHelper.generate(...)
  → bridge.ts invoke(): postMessage({kind:"invoke", method, args, callId})
  → runtime.ts onMessage: 校验 event.source 属于已知 iframe → host.onInvoke(scriptId, method, args)
  → helper.ts tavernHelperImpl[method](scriptId, args)
      · 变量类：context.ts 同步读写 + 防抖 putExtData（scope=global|chat, key=script_vars）
      · 生成类：sendFrame({type:"ext_generate", reqId, params}) → server handleExtGenerate
                → streamSimple 流式 → 广播 ext_gen{start/delta/end|error}
                → helper.ts 的 ext_gen sink 按 reqId 累计，end/error 时 resolve/reject（即删表防重复）
      · 改稿类：POST /api/script/message {op, lastRoleIndex, text}
  → runtime.ts 把返回值/异常封成 invoke-result{ok} postMessage 回该 iframe（callId 配对）
```

### 3.2 事件反向（pi 会话事件 → 脚本内回调）

```
pi 事件（session.subscribe：turn_start / turn_end / message_end 等）
  → server/main.ts 每事件调用 mapPiEventsToSt（server/script-events.ts）
  → 广播 ServerFrame{type:"ext_event", name, args}（无映射返回空数组，不广播）
  → App.tsx: jsrunnerBus.onWireFrame(frame)
  → runtime.ts 的 scriptFrameSink:
      ext_event → 先 pushContextToAll()（脚本回调里 getContext() 是新鲜快照）再 emitToAll(name, args)
  → iframe 内 bridge 的 window message 监听 {kind:"event"} → dispatchEvent(name, args)
  → 脚本 eventOn(name, cb) 注册的本地回调执行（回调各自 try/catch，出错转 log 不炸桥）
```

### 3.3 变量写入（脚本 setVar → 持久化）

```
setVar(key, value, scope)
  → context.ts varsFor(scope) 同步更新内存缓存（脚本侧 getVar 立即可见）
  → schedulePersist(scope)：300ms 防抖
  → persistVars → putExtData(scope, "script_vars", vars) → .liyuan-state/extdata/<scope>.json
```

---

## 4. 已实现 API 清单

### 4.1 TavernHelper 方法表（helper.ts `tavernHelperImpl`）

| 方法 | 语义 | 底层通道 | 备注 |
|---|---|---|---|
| `getVar(key, scope?)` | 读变量 | context.ts 同步 | scope 缺省 global |
| `setVar(key, value, scope?)` | 写变量，返回写入值 | context.ts 同步 + 防抖 extdata | 兼容链式使用 |
| `addVar(key, delta, scope?)` | 数值累加，返回新值 | context.ts 同步 + 防抖 extdata | 非数值按 0 起步 |
| `getContext()` | 上下文快照 | context.ts `buildSnapshot()` | 见 §7 白名单 |
| `generate(prompt, params?)` | 程序化生成（字符串 prompt） | WS ext_generate → ext_gen 流式 | params 采样子集见 §7 |
| `generateRaw(params)` | 程序化生成（参数对象） | 同上 | 兼容 `{messages}` 与 `{user_input}` 两种写法 |
| `triggerSlash(raw)` | 执行斜杠命令 | `tavernShim.triggerSlash` | 与 App 的 TavernChatBridge 一致 |
| `getCharData()` | 角色卡 `{name, description}` | GET /api/card（失败回落快照角色名） | **仅 name/description**，见 §5 |
| `getCurrentChatId()` | 当前会话 id | 快照 `currentChatId` | 无会话返回空串 |
| `getScriptName(scriptId)` | 脚本显示名 | `setScriptMeta` 注册表（runtime 建帧时登记） | |
| `getScriptInfo(scriptId)` | 脚本说明 | 同上（meta.info） | |
| `setMessage(index, text)` | 改稿 | POST /api/script/message `op=edit` | 快照索引 → lastRoleIndex，见 §7 |
| `deleteMessage(index)` | 删稿 | POST /api/script/message `op=delete` | 只导航不注入 |
| `eventOn/Once/Off` | 事件注册 | **宿主侧占位抛错**——事件在 iframe 内由 bridge 本地实现 | 见 §4.2 |

### 4.2 脚本 iframe 注入面（bridge.ts `BRIDGE_JS`）

| 注入 | 实现 |
|---|---|
| `window.TavernHelper` | Proxy：`getContext/eventOn/eventOnce/eventEmit/eventOff` 返回本地实现；`then`→undefined；`events/settings/state` 数据属性→undefined；**其余方法名一律 invoke 宿主** |
| `window.getContext()` | 同步返回最近 `{kind:"context"}` 帧快照（无快照返回 `{}`） |
| `window.getCurrentChatId()` | 快照 `currentChatId`（无会话返回 null） |
| `window.substituteParams(s)` | 桩：原样透传（Liyuan 宏在后端处理） |
| `window.eventOn/eventOnce/eventOff/eventEmit` | 本地监听表 + `{kind:"event"}` 帧桥；eventOn 返回退订函数（兼容 ST） |
| `window.toastr` | 桩：`error/warning/info/success` 全部转 `console.warn('[toastr]', msg)` |
| `console.log/warn/error` | 代理：原调用 + 透传宿主 `{kind:"log"}`（不可序列化参数 String 化） |
| `window.onerror / unhandledrejection` | 透传宿主 error 日志 |
| `$` / `jQuery`、`jsyaml`/`YAML` | vendor 注入（`frame.ts` 拼 srcdoc；宿主无 jQuery） |

---

## 5. 未实现 / 桩 API 清单（M5 审计缺口全表）

审计对象：`JS-Slash-Runner/my/` 顶层 6 个用户脚本
（`瑟瑟灵感状态栏V2.67.js`、`shujuku_index.js`、`输入栏折叠.js`、`v2_repair.js`、
`v2_repair_tracking.js`、`v2_restore_frames.js`；排除 `scripts/`、`.bak`、`.analysis.txt` 等）。
其中 3 个 `v2_*` 为 **Node CLI 维护工具**（`require('fs')`/`process.argv`），非 ST 脚本，无 API 使用。

| # | 缺口 | 影响脚本（API 使用点） | 严重度 | 影响说明 | 可行补法（一句话） |
|---|---|---|---|---|---|
| G1 | `window.SillyTavern` 全局未注入 | shujuku_index（`SillyTavern` 196 处，其中 `window.SillyTavern.getContext()` 25 处）、状态栏V2.67（`SillyTavern` 45 处） | **高** | **✅ 已补**（2026-08-16 前已实现惰性扁平快照桩：`bridge.ts` Object.defineProperty getter 每次访问重建 `{...getContext(), StExtras, getContext}`，`SillyTavern.getContext()` 可用；含 eventSource/eventTypes/saveSettingsDebounced/updateChatMetadata/stopGeneration 等）；extensionSettings 持久化面在 context.ts（scope=global key=ext_settings）——getRequestHeaders 仍 `{}` 空桩（Liyuan 无 ST 鉴权头对等物，留降级） |
| G2 | `generateRaw` 参数子集 | 状态栏V2.67（5 处 `{should_silence, user_input, ordered_prompts:[{role:'system',content},'world_info_before','persona_description',...], custom_api}`） | **高** | **✅ 已补**（2026-08-16 前已实现）：`helper.ts` `implGenerateRaw` 支持 `ordered_prompts`（经 `prompts.ts` parseOrderedPrompts 解析：system role → systemPrompt、'user_input' 哨兵注入、'chat_history' 从快照取、'world_info_before/persona_description' 等无投影占位符跳过）+ `custom_api`（有 apiurl 则前端 fetch 直连外部端点，header 带 Bearer；否则回落 ws ext_generate）；pickSamplingParams 透传 temperature/maxTokens/reasoning/systemPrompt |
| G3 | 脚本带参触发通道（`args`）未实现 | shujuku_index（`args[N]` 22 处，`extractTag(args)` 解析 `[模块]` 前缀） | **高** | **✅ 已补**（2026-08-16）：新增动作触发通道——桥内 `window.registerScriptAction(name, fn)` + `TavernHelper.registerScriptAction` 注册带参函数；宿主 `scriptRuntimes.invokeAction(scriptId, name, args)`（含 `invokeActionByScriptMatch` 按脚本名/`<id>:<action>` 匹配）经 `{kind:"action"}` 帧按名调用 fn(...args)；面板按钮 `ScriptMeta.buttons` 支持 `action` 字段（缺省用按钮名），点击走动作通道 + 保留 LEDGER_BUTTON_CLICKED 事件兼容。命令式脚本需显式注册动作函数（脚本本体仍载入即执行一次，函数注册后由宿主按名触发） |
| G4 | ST 专属 DOM（`parent.document`） | 输入栏折叠（`#send_textarea/#sheld/send_form` 等）、状态栏V2.67（`document.getElementById` 377 处） | **高** | 输入栏折叠：找不到 DOM 直接 return，功能全失效；状态栏：渲染到隐藏 iframe 无意义（UI 类脚本主功能失效） | 无通用补法：Liyuan 无 ST DOM 等价物，需脚本改造（UI 改走宿主面板/卡片通道） |
| G5 | `getContext()` 字段白名单不全 | 状态栏V2.67（`chatId`、`chat_metadata?.file_name`）、shujuku_index（`extensionSettings/saveSettings/getRequestHeaders`） | 中–高 | **部分已补**：快照已含 `currentChatId`/`chatId`（sessionId）、`characterId`（卡路径）、`personaDescription`、`extensionSettings`（可变深拷贝 + saveSettingsDebounced 回传落盘）、`chat_metadata`（可变副本 + updateChatMetadata 落盘）、`characters`（当前卡）；**仍缺** `groupId`（Liyuan 无组）、`powerUserSettings`、`getRequestHeaders` 实数据（返回 `{}` 降级）——Liyuan 无 ST 鉴权头对等物 |
| G6 | `tavern_events` 常量表未注入 | 状态栏V2.67（`tavern_events` 6 处，其中 `eventOn(tavern_events.CHAT_CHANGED, ...)` 带 `typeof tavern_events !== 'undefined'` 守卫） | 中 | **✅ 已补**（2026-08-16）：桥内 `window.tavern_events = EVENT_TYPES`（事件名↔名常量表，含 CHAT_CHANGED/GENERATION_STARTED/GENERATION_ENDED/MESSAGE_SENT/MESSAGE_RECEIVED 等，与 server/script-events.ts 映射对齐）；`TavernHelper.events` 别名同挂。`typeof tavern_events !== 'undefined'` 守卫放行，CHAT_CHANGED 等重建逻辑可生效 |
| G7 | `TavernHelper.generate` 覆写（monkey-patch）失效 | shujuku_index（`window.TavernHelper.generate = async fn(...)` 钩子 + `original_TavernHelper_generate_ACU`） | 中 | **✅ 已补**（2026-08-16）：Proxy 增加 `set` trap——覆写值存入 `overrides` 表，`get` 优先返回覆写值（monkey-patch 生效）；readonly 数据属性（events/settings/state）与 then 覆写忽略以保护桥自身语义 |
| G8 | `getCharData('current')` 参数语义 + 返回字段过窄 | shujuku_index（`TavernHelper.getCharData('current')` 4 处 + fallback 链） | 中 | **部分已补**：`implGetCharData` 现忽略 'current'/'recent' 参数（落在缺省行为：GET /api/card 当前卡 → `{name, description}`），Liyuan 单会话单卡语义下 'current' 即当前卡；仍无 avatar/tags/creator 字段（/api/card 无 ST extensions 对等物，脚本 fallback 链可退到 getContext 面）。保持现状（当前卡即 'current'） |
| G9 | `window.power_user` / `window.characters` / `window.this_chid` 未注入 | shujuku_index（`window.power_user.persona_description`、`window.characters[this_chid]` fallback） | 低–中 | 人设描述、角色索引 fallback 落空（脚本有优先级链，可退到 getContext 面） | bridge 注入只读桩：`power_user.persona_description` 从快照 name1/characters 出 |
| G10 | toastr 桩仅 console 日志 | 状态栏V2.67（`toastr.success/error/warning/info` 24 处）、shujuku_index（3 处） | 低 | 不阻断执行，但用户看不到通知；降级可用 | toastr 桩改为发宿主 toast（复用面板通知通道） |
| G11 | `setMessage/deleteMessage` | 两脚本均**未实际调用**（shujuku 的 16 处 `setMessage(` 是脚本**本地函数** `function setMessage(store, kind, text)`，非 ST API） | 无 | 已实现但当前无真实使用点；ST 语义为 `setMessage(index, text)` 触发改稿 | —（保持实现；验证脚本用 §9） |
| G12 | `YAML.` / `z.` | 两脚本均 0 使用 | 无 | vendor 注入面只含 jQuery + js-yaml；`z` 未注入但无脚本使用 | — |

> **审计方法**：对 6 个顶层脚本全文正则扫描（`TavernHelper.<method>(`、`TavernHelper.<prop>`、
> 全局 `getContext/setMessage/eventOn/...(`、`window.TavernHelper`、`YAML.`、`z.`、`$(` 等 40+ 模式），
> 并对命中位置抽取上下文人工核对（区分脚本本地同名函数与 ST API）。

**高影响缺口现状（G1–G4）**：G1（SillyTavern 全局）**已补**（惰性扁平快照桩）；G2（generateRaw 参数）**已补**（ordered_prompts/custom_api）；G3（args 触发）**已补**（registerScriptAction + action 通道 + 面板按钮）；G4（ST 专属 DOM）仍缺——影响状态栏V2.67 与 shujuku_index 的 **UI 类主功能**（渲染到隐藏 iframe 无意义、输栏折叠找 DOM 失效），无通用补法，需脚本改造走宿主面板/卡片通道。故剩余高影响缺口仅 G4。

---

## 6. 事件映射表

来源：`server/script-events.ts` `mapPiEventsToSt`（pi 事件名以 `@liyuan/agent-core` AgentEvent 为准）。

| pi 事件 | ST 事件名 | args 载荷 | 说明 |
|---|---|---|---|
| `session_start` | `CHAT_CHANGED` | `[{ sessionId }]` | 会话启动/加载/重载 → 前端全量重拉聊天 |
| `turn_start` | `GENERATION_STARTED` | `[]` | 回合开始（一次助手回复 + 工具调用） |
| `turn_end` | `GENERATION_ENDED` | `[]` | 回合结束 |
| `message_end`（role=user） | `MESSAGE_SENT` | `[{ mes, is_user:true, name:'You' }]` | 消息落定 |
| `message_end`（role=assistant） | `MESSAGE_RECEIVED` | `[{ mes, is_user:false, name:'' }]` | 消息落定 |
| `input`（仅扩展处理器路径） | `MESSAGE_SENT` | `[{ mes, is_user:true, name:'You' }]` | 保留映射供直接调用/测试 |
| `tool_call` / `tool_result` / `agent_start` / `agent_end` / `message_start` / `compaction_*` 等 | **无映射** | — | 无 ST 对等，返回空数组不广播 |

**未映射事件说明**：上述 pi 事件在 Liyuan 有剧情/过程语义但对 ST 脚本无意义，不广播；
脚本不应依赖它们。`MESSAGE_SENT` 与 `MESSAGE_RECEIVED` 的投影只含 `{mes, is_user, name}`，
不含 `entryId`（事件载荷无会话树条目 id，暂不输出）。

---

## 7. 已知差异与限制

1. **generate/generateRaw 采样参数子集**：仅透传 `temperature` / `maxTokens` / `reasoning`
   （`none|low|medium|high`）/ `systemPrompt`；**无 top_p / penalty 类 ST 采样档**。且 `generateRaw`
   只认 `{messages}` 与 `{user_input}` 两种载荷（见 §5 G2，`ordered_prompts`/`custom_api` 未支持）。
2. **getContext() 白名单面**（`web/src/jsrunner/types.ts` ContextSnapshot）：
   `chat`（消息投影：user 通道 is_user=true；narrative/greeting/import/backstage 为角色侧；
   其余通道 is_system=true）、`chat_metadata`（**恒空对象**）、`name1`（角色名）、`name2`（用户名）、
   `vars`（全局变量）、`chatVars`（聊天变量）、`currentChatId?`、`characters`（仅 `{name, description}`）。
   缺失字段见 §5 G5。
3. **setMessage 语义**（`server/main.ts` `scriptEditMessage`）：
   - 前端 `helper.ts` `chatIndexToLastRoleIndex` 把快照 chat 数组索引换算成 `lastRoleIndex`
     （从分支末尾倒数第 N 条「角色消息」；index 指向 user 消息时回退到其后第一条角色消息）；
   - 后端按 `lastRoleIndex` 定位分支目标条目的**前驱**，`session.navigateTree(targetId, {summarize:false})`
     导航过去；`op=edit` 注入 `rp-edited-reply`（上下文钩子转成 assistant 进 LLM），**原回复保留旧分支**；
     `op=delete` 只导航到前驱、不注入任何内容。
4. **jQuery 仅注入脚本 iframe**（`frame.ts` vendor 拼接），宿主页面无 jQuery；脚本用 `$(parent.document)`
   操作宿主 DOM 的写法依赖宿主 DOM 结构（见 §5 G4）。
5. **正文写走追加式分支模型**：Liyuan 后端是 append-only 分支树（pi 语义），改稿不覆盖原稿、不删原文，
   只切分支 + 注入新回复——与 ST「编辑楼层」的**内容替换**语义不同，脚本侧感知为「改稿 = 生成新分支回复」。
6. **toastr 桩降级**：通知只进宿主 console / 日志查看器，不弹 toast（§5 G10）。
7. **脚本无带参触发入口**：见 §5 G3；当前脚本生命周期 = iframe 载入即执行一次（M4a 面板管理启停）。
8. **extdata 键约束**：key 长度 ≤128、禁止点号/路径分隔符（防穿越）、拒绝 `__proto__/constructor/prototype`
   原型污染键、单值 ≤1MB（`src/extdata.ts`）。
9. **事件 args 简化投影**：`MESSAGE_SENT/RECEIVED` 无 `entryId`；`CHAT_CHANGED` 只带 sessionId。

---

## 8. UI 与数据

- **入口**：PowersPanel「扩展能力」下的「脚本」tab（`JsRunnerPanel`，M4a），与技能/MCP 并列；
  内部三个子 tab：**脚本**（列表管理）/ **日志**（`LogViewer`，M4b）/ **变量**（`VariableManager`，M4b）。
- **脚本持久化**：`GET/PUT /api/extdata?scope=global&key=scripts`（body `{value: ScriptMeta[]}`，
  字段对齐 ST 脚本模型：`id/name/content/enabled/info?/buttons?`）；面板改动即
  `putExtData("global","scripts", next)` + `scriptRuntimes.setScripts(next)` 增量启停。
- **变量持久化**：`scope=global|chat, key=script_vars`（context.ts `VARS_KEY`）；
  `setVar/addVar/deleteVar` 300ms 防抖写 extdata，落盘 `.liyuan-state/extdata/<scope>.json`。
- **日志**：脚本 console 输出经 `onLog` 入环形缓存（`log.ts`，≤500 条，新→旧快照，订阅者推送），
  `LogViewer` 实时显示（时间 HH:MM:SS + scriptId + 级别色标 + 文本，自动滚底，可清空）。
- **变量管理器**：global/chat 作用域切换，表格展示 key / JSON value / 编辑（inline textarea JSON）/
  删除（二击确认）；新增行 value 先 `JSON.parse` 失败按字符串存；编辑后本地 state 立即生效
  （extdata 防抖异步，不依赖快照回流）。

---

## 9. 验证方式

### 9.1 构建与类型

```bash
npm --prefix web run typecheck   # tsc --noEmit（web 有 tsconfig；唯一类型检查）
npm run web:build                # vite build 前端（server 托管 web/dist，改前端后必须重新构建）
npm run web                      # 起服务（cwd=Liyuan/ 根，默认 0.0.0.0:7620）
```

### 9.2 冒烟要点

1. 面板新建脚本 → `scriptRuntimes.setScripts` 建 iframe；脚本 `console.log` 出现在
   PowersPanel「脚本→日志」tab，且宿主 console 有 `[jsrunner:<id>]` 前缀。
2. 脚本 `setVar/getVar` → 变量管理器可见；刷新页面（重连）后变量仍在（extdata 持久化）。
3. 发一条用户消息 → 事件桥推 `MESSAGE_SENT`；assistant 回复落定 → `MESSAGE_RECEIVED`；
   每个回合还会收到 `GENERATION_STARTED` / `GENERATION_ENDED`（eventOn 脚本可见）。
4. 日志环形缓存：连续打 505+ 条日志，只保留最近 500 条（旧日志被挤出）。

### 9.3 测试脚本示例

**① eventOn 事件打日志**（验证事件桥 + 日志查看器）：

```javascript
// 事件订阅冒烟：每收到一个 ST 事件就打一条日志
eventOn('MESSAGE_RECEIVED', (args) => {
  const mes = (args && args[0] && args[0].mes) || '';
  console.log('[event-demo] MESSAGE_RECEIVED', mes.slice(0, 50));
});
eventOn('CHAT_CHANGED', () => console.warn('[event-demo] CHAT_CHANGED'));
console.log('[event-demo] ready');
```

**② setMessage 改稿**（验证快照索引 → 分支导航 → rp-edited-reply 注入）：

```javascript
// 把最近一条角色回复改写（文本随意）
const chat = getContext().chat;
let target = chat.length - 1;
// 从末尾往上找一条角色消息（is_user=false）作为改稿目标
while (target >= 0 && chat[target].is_user !== false) target--;
if (target >= 0) {
  await TavernHelper.setMessage(target, '[改稿] 我是脚本注入的新回复（原文保留在旧分支）');
  console.log('[edit-demo] setMessage target=' + target);
} else {
  console.warn('[edit-demo] 没有可改写的角色消息');
}
```

**③ 变量读写**（验证 context 变量 + 持久化 + 变量管理器）：

```javascript
TavernHelper.setVar('demo_counter', (Number(TavernHelper.getVar('demo_counter') ?? 0)) + 1);
TavernHelper.addVar('demo_delta', 2);
console.log('[var-demo]', JSON.stringify(getContext().vars));
```

> 预期：③ 的变量在「变量」tab 的 global 作用域立即可见，刷新页面后仍存在；② 触发后聊天流出现
> 带 `[改稿]` 前缀的新回复且原回复仍可从分支历史看到；① 的日志随每轮消息实时滚入日志查看器。
