# liyuan-瑟瑟状态栏：ST 脚本适配方案（方案 A）

> 版本：P1（2026-08-09）· 基线：docs/DESIGN-jsrunner-ledger.md（D3）+ DESIGN-jsrunner-ledger-ui.md
> （D4，V1/V2 已实现）+ exp-4（源脚本结构侦察）+ exp-1（Liyuan 适配通道侦察）
> 目标：把 ST 生态「瑟瑟灵感状态栏V2.67.js」适配为 Liyuan jsrunner 脚本
> 「liyuan-瑟瑟状态栏」——UI 本体（视觉/组件/交互/渲染驱动）表现复刻，数据/事件/写回
> 全部走 Liyuan 已实现通道。本文档只做方案设计；实施以 plan_doc 承诺为准。

---

## 1. 适配目标与范围

### 1.1 目标

| 项 | 承诺 |
|---|---|
| UI 表现 | 状态栏自包含前端应用的视觉/组件/交互/渲染驱动**原样复刻**（能力基准 = 自包含程度，exp-4 结论 ≈90% 可原样） |
| 数据 | 静态数据（玩法 489/成就 579/卡池/技能表/邂逅库）**嵌入脚本**（zip 导入 + 文件通道，用户裁决）；动态数据走 extdata（per-script 命名空间） |
| 事件 | 账本/剧情事件走 Liyuan 前端投影（WORLD_STATE_CHANGED / MESSAGE_RECEIVED / GENERATION_ENDED） |
| 写回 | applyStatePatch（账本）、triggerSlash（发送聊天）、notify（通知） |
| 管理 | openManager 独立管理界面（P4 已实现） |

### 1.2 明确不做（如实降级）

| 项 | 处置 |
|---|---|
| 布局定位形态复刻（fixed 悬浮） | 不做（用户裁决，append 内嵌） |
| LLM 生成功能（采访/立绘/天赋树/地图/特卖/大调查/日历/NSFW 指导，13 个 generateRaw 调用点） | **降级为占位/禁用提示**（依赖独立项 ext_generate，未实现） |
| ST 宿主元素操作（#send_textarea/#send_but/#main_api/#api_button_openai/#settingsOverlay/#chat） | 映射或删除（见 §4 映射表） |
| 移动端 overlay 修复（Loader :283-297） | 删除（无对等 DOM） |
| AutoCardUpdaterAPI 世界书数据库 | 替换为内嵌数据 + 账本/存储（§5） |

---

## 2. 源脚本结构摘要（exp-4）

**双层架构**：外层 Loader（10-453 行，JS-Slash-Runner 宿主注入层）+ 内嵌 EMBEDDED_HTML
完整前端应用（2.9MB，5 套主题 / 13 类弹层 / 玩法 489 / 成就 579，`<script type="module">`
webpack bundle，仅外部依赖 html2canvas-pro CDN）。

| 部件 | 职责 | 适配处置 |
|---|---|---|
| Loader `inject()`（:128-280） | 解析 EMBEDDED_HTML → 注入宿主 body/head | **删除**（不再注入宿主；EMBEDDED_HTML 由脚本自身 document 承载） |
| Loader `wrapCSS()`（:69-122） | fixed-top/bottom/follow 定位 | **删除**（append 内嵌，布局形态不追求复刻） |
| Loader 齿轮拖拽（:302-358） | 齿轮位置拖拽 + localStorage 持久化 | 保留（iframe 内 pointer 事件自包含，localStorage 走沙箱代理） |
| Loader `#chat` MutationObserver 守卫（:370-380） | wrapper 被清空时重建 | 删除（Liyuan 无宿主 DOM 注入，无清空场景） |
| Loader `eventOn(CHAT_CHANGED)`（:383-402） | 聊天切换重建 | 适配（§6 事件面） |
| 内嵌应用（module bundle） | 全部 UI/交互/状态（自身 document 内） | **原样保留**（唯一改动：`parent.document`/`window.parent` 重定向为自身） |
| `AutoCardUpdaterAPI` 数据库（DB 层 z6/k9/uY/A5/Bq/pj/o1） | 世界书数据读写 | 替换（§5） |

---

## 3. 适配策略（三层）

```
┌─ 第一层：外壳重写（Loader 变换）────────────────────────────┐
│  原 Loader 的宿主注入职责 → 删除；替换为 Liyuan 入口：        │
│    registerLedgerPanel({title, icon, area:"status"})        │
│    + 把 EMBEDDED_HTML 作为自身 iframe 文档内容渲染            │
│    + parent.document/window.parent 重定向为自身（45+89 处）   │
└────────────────────────────────────────────────────────────┘
┌─ 第二层：API 映射层（适配桥 stub）──────────────────────────┐
│  SillyTavern.* / TavernHelper.* / 事件 / toastr / localStorage │
│  → Liyuan helper 方法表（§4 映射表）                          │
└────────────────────────────────────────────────────────────┘
┌─ 第三层：数据面（AutoCardUpdaterAPI 替换）──────────────────┐
│  世界书 DB → 内嵌 JSON 数据（zip 导入）+ worldState 账本      │
│  + extdata 持久化（§5）                                      │
└────────────────────────────────────────────────────────────┘
```

### 3.1 外壳形态（关键设计）

适配后的脚本文件结构（zip 导入，单 .js 主脚本 + 附带数据文件）：

```
liyuan-瑟瑟状态栏/
├── liyuan-瑟瑟状态栏.js      ← 主脚本（改造后 Loader + 适配桥）
├── app.html                  ← 原 EMBEDDED_HTML（从源脚本 16-35 行提取）
├── data/play.json            ← 玩法 489（原世界书表导出）
├── data/achievement.json     ← 成就 579
├── data/gacha.json           ← 卡池
├── data/skills.json          ← 技能表
└── data/encounter-*.json     ← 邂逅库（古代/现代）
```

主脚本骨架：

```js
// 1. Liyuan 面板注册（V1/P2 已实现通道）
TavernHelper.registerLedgerPanel({ title: "瑟瑟状态栏", icon: "✨", area: "status", maxHeight: 480 });

// 2. 适配桥：parent.document → 自身 document（系统替换 45+89 处引用）
//    const pd = parent.document  →  const pd = document
//    window.parent.document      →  document
//    un()/fn() 等文档解析器       →  重定向自身

// 3. 把 EMBEDDED_HTML 渲染到自身 iframe（取代原 Loader 的宿主注入）
//    app.html 经 zip 附带文件 fetch('/uploads/<file>') 读取后：
//    document.body.innerHTML = appHtml 中 <body> 部分；
//    appHtml 中 <script type="module"> 注入自身 document 执行（原样）。

// 4. API 适配桥（§4）：window.SillyTavern / TavernHelper 走 Liyuan 面
```

**渲染方式说明**：EMBEDDED_HTML 的 module bundle 原设计是"宿主文档解析后执行、
操作宿主 document"——适配后它操作**自身 iframe document**（iframe 内 jQuery/事件/
rAF 全自包含），与 jsrunner「脚本渲染自身 document」模型一致（D3 §3.1 方案 A）。

---

## 4. API 映射表（第二层，exp-1 通道事实核实）

### 4.1 全局/宿主 API

| ST 调用（源脚本） | Liyuan 映射 | 通道（exp-1 确认） | 处置 |
|---|---|---|---|
| `getContext()`（9 处） | `getContext()`（含 worldState/chat/name2/currentChatId/extensionSettings） | bridge 注入 + 快照 | ✅ 原样可用 |
| `eventOn(tavern_events.CHAT_CHANGED)` | 无对等投影 → **适配层包装** | §6 | ⚠️ 包装 |
| `eventOn(MESSAGE_RECEIVED)`（NSFW 自动清空） | `eventOn("MESSAGE_RECEIVED")` | events.ts 前端投影 | ✅ 原样 |
| `TavernHelper.generateRaw(...)`（13 调用点） | **降级桩**：面板内占位「该功能需 LLM 生成通道（独立项），当前不可用」 | ext_generate 断链（D3 §5.10 独立项） | ❌ 降级 |
| `TavernHelper.injectPrompts`（10 处） | 既有 no-op 桩（helper.ts:497） | 已实现 | ✅ 桩 |
| `TavernHelper.triggerSlash('/secret-id ...')` | `triggerSlash` 同构 | tavernShim（命令面全通） | ✅ 原样 |
| `TavernHelper.getCharWorldbookNames/deleteWorldbook/rebindGlobalWorldbooks` | **无对等** → 删除（数据面由内嵌库替代，§5） | — | ❌ 删除 |
| `toastr.success/error/warning/info`（24 处） | `notify`（桥已改） | bridge toastr → invoke notify | ✅ 自动 |
| `window.SillyTavern.getRequestHeaders` + `fetch('/api/images/upload')`（立绘上传） | 同源 fetch 直连（无鉴权，AGENTS.md） | CSP connect-src 放行 | ⚠️ 保留（立绘功能属本地功能非 LLM） |
| `window.SillyTavern.chatCompletionSettings`（场景切换改写） | **无对等** → 删除（场景切换降级） | — | ❌ 删除 |
| `parent.localStorage`（19-59 行等） | 沙箱 localStorage 代理（内存副本 + 落宿主，V2-6 已实现） | bridge storage-snapshot | ✅ 自动 |
| `$`/`jQuery`（Loader 与内嵌） | iframe 内 vendor 注入（frame.ts） | 已实现 | ✅ 原样 |
| `AutoCardUpdaterAPI`（34 行 p() 及 DB 层） | **替换**（§5） | — | 🔁 替换 |
| `window.__ub_*` 全局（18 个，Loader↔应用契约） | **保留原样**（同一 iframe 内自契约） | 自身 document | ✅ 原样 |

### 4.2 宿主元素操作

| 源脚本 | Liyuan 处置 |
|---|---|
| `#send_textarea` 填值 + `#send_but.click()`（邂逅/选项栏发送，`D()`/`R()`） | → `TavernHelper.triggerSlash('/send ' + text + '|/trigger')`（exp-1 确认：唯一「带文本直接发送并生成」入口） |
| `#main_api`/`#api_button_openai` 场景切换 | 删除（降级） |
| `#chat` 定位（follow-bottom）/ `#send_textarea` 高度计算 | 删除（append 内嵌，无悬浮定位） |
| `#settingsOverlay/#nsfwOverlay/#panelOverlay` 移动端修复 | 删除 |

### 4.3 交互（iframe 内自包含，原样保留）

点击弹层、hover tooltip、标签 checkbox、随机/删除、地图缩放、拖拽（齿轮/地图视口）——
全部自身 document 事件，**不动**（D4 V2-2 的 setPointerCapture 先例可参考）。

---

## 5. 数据面设计（第三层）

### 5.1 静态数据（用户裁决：嵌入脚本，不进 codex）

| 数据 | 来源 | Liyuan 承载 |
|---|---|---|
| 玩法 489 | 原 AutoCardUpdaterAPI「全局数据表/玩法」 | zip `data/play.json` → `/uploads/<file>` → 脚本 `fetch()` 读入内存库 |
| 成就 579 | 同上 | zip `data/achievement.json` |
| 卡池/技能表/邂逅库 | 同上 | zip `data/*.json` |
| 主题图/字体（base64，2.9MB 内嵌） | EMBEDDED_HTML 自带 | 随 app.html 走（EMBEDDED_HTML 原样） |

数据包提取工具：`plugin-analysis/extract-data.mjs`（DB 路线已有，从 ST 脚本抽取到
.liyuan-codex 的脚本可复用改输出目标为 zip data/）。

### 5.2 动态数据（extdata，per-script 命名空间）

| 原 localStorage 键 | Liyuan 承载 |
|---|---|
| `statusbar-play-state/tags/item-use/gacha-*/fixed-btn-pos/...` | 沙箱 localStorage 代理（自动落宿主 localStorage，V2-6）——**零改动** |
| `extensionSettings.__userscripts.<名>`（u()/g() 函数） | `saveExtensionSettings` / `updateChatMetadata`（helper 已实现）或 `setExtData('cfg:脚本名', ...)`（P4 自由键） |
| 世界书 DB（角色表/物品表/能量） | → **worldState 账本**（§5.3） |

### 5.3 世界状态对应（AutoCardUpdaterAPI → Liyuan 账本）

| 原表 | Liyuan worldState 字段 | 读写 |
|---|---|---|
| 全局数据表（当前时间/地点/是否色色） | `time` / `location` / `flags.是否色色` | 读：`getContext().worldState`；写：`applyStatePatch` |
| 主角信息表（瑟瑟能量/近况/身份） | `characters[主角].affinity` / `.status` / `.notes` | 同上 |
| 在场角色/重要角色/恋爱对象表 | `characters[].affinity/status/notes` | 同上 |
| 物品表 | `inventory` | 同上（整体替换语义） |
| 备忘录/瑟瑟任务表 | `flags` / `notes` | 同上 |
| 恋爱日记/地图/NSFW 信息 | 超出 worldState → **extdata 自定义键**（脚本自持，随脚本走） | `getExtData/setExtData` |

写回语义：`applyStatePatch`（applyPatch：characters 按名合并、inventory/plot_threads
整体替换、flags 按键合并）——与 ST 世界书写库的「按表写」语义对齐为「按 worldState
字段写」。

---

## 6. 事件面设计

| 脚本需要 | Liyuan 现状（exp-1） | 适配处置 |
|---|---|---|
| CHAT_CHANGED（聊天切换重建） | **无投影**（hello 帧只刷快照不发事件） | **适配层包装**：`MESSAGE_RECEIVED`/`GENERATION_ENDED` 回调里比对 `getContext().currentChatId`，变化即触发原 CHAT_CHANGED 重建逻辑（脚本内 `dispatchEvent('CHAT_CHANGED', ...)`）；零宿主改动 |
| MESSAGE_RECEIVED（NSFW 自动清空等） | ✅ 前端投影（events.ts:28） | 原样 |
| GENERATION_ENDED | ✅ 前端投影（events.ts:32） | 原样 |
| WORLD_STATE_CHANGED（新增价值） | ✅ 前端投影（events.ts:24） | 适配层增挂：账本变化 → 更新脚本内角色/物品/时间缓存并重渲染 |

---

## 7. 实施步骤（分阶段）

| 阶段 | 内容 | 规模 | 验证 |
|---|---|---|---|
| **P1 外壳** | 主脚本骨架：registerLedgerPanel + EMBEDDED_HTML 渲染自身 + parent 重定向（45+89 处系统替换）+ zip 导入结构 | 中 | 导入后账本卡片出现状态栏面板（主题/布局原样） |
| **P2 数据** | AutoCardUpdaterAPI 面替换：静态数据 zip 提取 + 内存库桥 + worldState 读（§5.3）+ 动态数据存储 | 中 | 玩法标签/成就/抽奖/卡池可浏览；角色状态从账本读 |
| **P3 交互** | 发送聊天（triggerSlash /send）、写回（applyStatePatch）、通知（notify）、降级占位（generateRaw 13 点） | 中 | 邂逅发送进聊天；改能量/时间 → 标准视图同步 |
| **P4 收尾** | openManager 管理界面（设置自绘）、日志/变量接入、能力基准回归、V2-7 式性能实测 | 小 | 管理界面可配置；基准 15 用例 + 冒烟清单全绿 |

P1/P2 可部分并行（外壳与数据提取独立）；P3 依赖 P2（内存库就绪）。

---

## 8. 验证方式

### 8.1 常驻基准（既有）

- `npm --prefix web run typecheck` / `npm run web:build`
- `node --test test/jsrunner-baseline.test.ts`（15 用例，协议面）
- 能力基准演示脚本（baseline-demo.js，8 项自检）

### 8.2 适配冒烟清单（人工，对照 exp-4 功能清单）

1. zip 导入「liyuan-瑟瑟状态栏」→ 账本卡片出现面板，5 套主题可切换（古风/撩人/极简/甜/仙侠）
2. 13 类弹层抽查：玩法标签/成就/数据库/设置打开渲染正常
3. 剧情推进（MESSAGE_RECEIVED）→ NSFW 玩法自动清空等事件逻辑触发
4. 手动改账本时间/好感 → WORLD_STATE_CHANGED → 面板角色条/时间同步
5. 邂逅按钮「发送到聊天」→ 消息进入聊天流并触发生成（triggerSlash /send 链路）
6. 改能量/物品 → applyStatePatch → 标准视图同步 + 分支回退一致
7. 刷新页面 → 动态数据（标签/抽奖历史）仍在（localStorage 代理 / extdata）
8. generateRaw 功能（采访/立绘/天赋树等）→ 占位提示，不炸
9. openManager → 设置模态弹出，配置保存生效
10. 深色主题 → --ly-* token 生效；面板收起/展开、拖拽排序正常

### 8.3 性能

参照 V2-7 实测方法（N 面板注入实测 + 指标记录），状态栏为单面板重型脚本——
重点测：首帧渲染耗时、账本事件 → 面板刷新时延、内存。

---

## 9. 已知降级清单（诚实标注）

| 功能 | 现状 | 说明 |
|---|---|---|
| 采访/立绘/天赋树/地图/特卖/大调查/日历/NSFW 指导（generateRaw 13 点） | 占位/禁用 | 依赖独立项 ext_generate（D3 §5.10，~40 行服务端 handler）；该独立项落地后脚本改回真实调用即可（适配桥已留 `generateRaw` 通道） |
| 场景切换（改 API 预设） | 删除 | Liyuan 模型配置是全局的，无 ST API 面板对等 |
| 移动端 overlay 修复 | 删除 | 无对等 DOM |
| CHAT_CHANGED 事件 | 适配层包装 | 宿主不补投影（避免新增服务端/前端事件面），脚本侧 currentChatId 比对 |
| AutoCardUpdaterAPI 世界书 | 内嵌库替换 | 数据同源（同一 ST 世界书导出），写回改走账本/存储 |

## 10. 与既有资产的衔接

- **DB 路线资产**（plan_doc/db-statusbar-codex.md）：`.liyuan-codex/` 12 库（玩法/成就/
  卡池/技能表/邂逅/示意图）由 ST 脚本抽取——**复用 extract-data.mjs 改输出为 zip data/**；
  「状态栏-梦鲸思客V4-0802」预设保持（剧情侧发卡/邂逅仍走 codex_mount 检索），与本
  脚本 UI 并行不冲突（预设=剧情侧、脚本=UI 侧，数据同源双轨）。
- **ext_generate 独立项**（D3 §5.10）：本方案降级项的前置修复，独立立项随时可做。

## 11. 实施结论（P1–P3，2026-08-09）

### 交付物

- `scripts/convert-statusbar.mjs`：自动化转换脚本（提取 EMBEDDED_HTML/内联数据/bundle、
  parent 重定向、生成适配主脚本）；**宿主零改动**（用户裁决：瑟瑟状态栏适配不动 Liyuan
  代码）
- `assets/liyuan-statusbar/liyuan-瑟瑟状态栏.js`：转换产物（单文件，JsRunnerPanel 直接导入）

### 冒烟验证（真实运行）

1. **P1 外壳**：面板注册成功、UI 真实渲染（「点击收回状态栏」+ 📍位置 + 折叠/展开控件）；
   Vue 报错清零（脚本内 CDN 注入）、AutoCardUpdaterAPI 桩就绪轮询立即通过
2. **P2 数据面**：状态栏**真实显示账本数据**——`🕐 神历1024年3月20日 深夜（伊利亚斯离开后）
   | 📍 失落废墟·无名祭坛前`（worldState 桥：exportTableAsJson 从 getContext().worldState
   构建 5 表：全局数据表/主角信息表/在场角色表/物品表/备忘录；WORLD_STATE_CHANGED →
   重建表 + 触发 registerTableUpdateCallback 刷新）；甚至触发了「确认地图地点归属」
   对话框（bundle 地图模块读到真实地点数据）
3. **P3 交互**：发送聊天替身（#send_textarea/#send_but 隐藏元素 → triggerSlash
   `/send X|/trigger`）、generateRaw/generate 降级（立即 reject 占位，不挂起）

### 冒烟迭代修复（记录）

| 问题 | 修复 |
|---|---|
| bundle 引用全局 Vue（ST 宿主有，Liyuan iframe 无） | 脚本内 Vue 2 CDN 加载后再注入 bundle |
| ST 世界书 API（getCharWorldbookNames 等 7 个）宿主无桩 | 脚本内 Proxy 包装 TavernHelper 返回空值（宿主零改动） |
| AutoCardUpdaterAPI 桩结构不符（轮询条件 registerTableUpdateCallback + exportTableAsJson 期望 sheet 结构） | 桩对齐 + P2 升级为 worldState 桥 |
| 转换脚本模板内反引号破坏生成产物 | 主脚本模板禁反引号（字符串拼接） |

### 宿主改动记录

- **helper.ts 世界书桩已回滚**（77ac0d7）：曾临时加 7 个桩，用户裁决「不动 Liyuan 代码」
  后撤回，桩全部移至脚本内 Proxy 包装。当前 Liyuan 代码与 V2 基线一致，零差异。
