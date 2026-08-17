# 支持 JS Runner 定制世界状态账本 UI（设计 D3）

> 版本：D3（2026-08-09）· 取代 D2 · 适用代码基线：`web/src/jsrunner/*` +
> `web/src/components/StatusStrip.tsx` + `web/src/components/RosterPanel.tsx` + `web/src/App.tsx`
> D3 整合 2026-08-09 grilling 需求澄清全部裁决（R1–R5，见 §1.1 与 plan_doc/jsrunner-ledger.md
> 裁决记录 1–20）。本文档只做设计；实施范围以 plan_doc 承诺为准。

---

## 1. 概述与目标

### 1.1 需求来源与裁决清单（grilling R1–R5，2026-08-09）

用户澄清的「高度定制化」六项界面能力（全部纳入）：

| # | 能力 | 语义 |
|---|---|---|
| ① | 自定义静态数据包读取 | 脚本可携带/读取自有静态数据（玩法库、成就表、卡池等） |
| ② | 新增渲染图标 | 脚本视图内自由渲染图标（emoji/SVG/图片/字体） |
| ③ | 新增按钮 | 脚本视图内按钮 + 宿主级按钮（面板标题栏） |
| ④ | 额外弹出独立管理界面 | 脚本可弹出独立模态/管理界面 |
| ⑤ | 自有配置独立存储持久化 | per-script 命名空间落盘，多脚本互不踩 |
| ⑥ | 自定义动态数据存储 | 任意 JSON 形态动态数据持久化 |

grilling 关键裁决（完整清单见 plan_doc 裁决记录 1–20）：

| 裁决 | 内容 |
|---|---|
| R1-① | 大内容承载 = **拆文件存储**（content 落 `.liyuan-uploads/`，extdata 只存元数据+引用） |
| R1-② | 面板头**独立收起/展开**（V1 做）；顺序**拖拽排序 V2 必做**（TODO） |
| R1-④ | 验收基准 = **常驻测试** |
| R2-① | 导入 = 多文件（主 `.js` + 可选附带数据文件）；导出 = 主脚本单文件（数据包不并回）；zip V2 |
| R2-② | 编辑 = **统一外部编辑**（只读查看 + 下载 + 重新导入） |
| R2-③ | 删除 = **级联清理文件**（脚本 = 文件所有权边界，文件默认隔离；共享 V2） |
| R2-④ | **toastr 纳入**：桩改宿主 toast + `notify(level,text)` |
| R3-① | 挂载范围 = **主卡 + 名录双区域**（`area: "status"\|"roster"`） |
| R3-② | 面板**默认展开**（可独立收起） |
| R3-③ | 面板**数量不设上限** |
| R3-④ | 导入大小**不额外限制**（沿用 64MB 通道） |
| R4-① | 崩溃/未就绪 = **占位提示**（不自动重试） |
| R4-② | 导入类型校验：主脚本强制 `.js`，附带文件任意 |
| R5-① | 事件面 = 账本 + **消息/回合事件前端投影**（MESSAGE_RECEIVED / GENERATION_ENDED） |
| R5-② | 常驻基准测试 = **自动化 + 演示脚本双轨** |

### 1.2 能力基准（不是迁移目标）

以 ST 生态「瑟瑟灵感状态栏V2.67.js」为**支持程度基准**（exp-4）：该脚本是自包含完整前端
应用（5 套主题、13 类弹层组件、全部自建 DOM/CSS、事件驱动 rAF 渲染、内嵌素材），其 UI
本体 ≈90% 可在「脚本 iframe 可见化」模型下原样呈现。**本设计不迁移该脚本**——它只定义
「需要支持到什么程度」：任何达到该自包含程度的脚本，其**视觉、组件、交互、渲染驱动**
均应能原样呈现。

**明确不在需求内**（用户裁决）：布局定位形态不追求复刻（fixed 悬浮不做，统一内嵌挂载）；
不迁移任何具体脚本。

### 1.3 设计目标（三条通道 + 存储面）

| 通道 | 方向 | 内容 |
|---|---|---|
| 读 | 宿主 → 脚本 | `ContextSnapshot.worldState` + `WORLD_STATE_CHANGED` / `MESSAGE_RECEIVED` / `GENERATION_ENDED` 事件 |
| 渲染 | 脚本 → 宿主 | `registerLedgerPanel()` 注册面板；iframe **可见化挂载**进账本卡片/名录面板 |
| 写 | 脚本 → 宿主 | `applyStatePatch(patch)` + `notify(level,text)` |
| 存 | 脚本 ↔ 宿主 | 拆文件存储（content/数据包落 `.liyuan-uploads/`）+ extdata 自由键（per-script 命名空间） |

### 1.4 设计原则

1. **复用既有机制**：数据走 `state` 帧 + jsrunnerBus；写走 `/api/state`；文件走
   `/api/upload` + `/uploads/` 托管；自由键走 `/api/extdata`；渲染走脚本 iframe。
2. **兼容 ST 生态心智**：UI 脚本「往 document 里画」——Liyuan 里画进自己的 iframe
   document（G4 缺口的 Liyuan 化解法）。
3. **宿主全控边界**：脚本只获得挂载容器 + 主题 token + 白名单 invoke，不接触宿主 DOM。
4. **契约演进守则**：新消息/新快照字段一律可选，不改旧字段。

---

## 2. 现状事实（侦察结论摘要）

### 2.1 账本 UI 与数据流

- 数据权威：`server/main.ts currentState()`（main.ts:367-377）＝会话树快照优先，磁盘
  `.liyuan-state/<sessionId>.json` 兜底；随 `/rewind /branch` 回退（R4 分支模型）。
- 前端唯一入口：WS 帧 `hello`（wire.ts:236 带 `state`）与 `state`（wire.ts:267）→
  `App.tsx` `case "hello"`（:731）/ `case "state"`（:892）setWorldState → props 下发
  StatusStrip（主卡）/ RosterPanel（左栏名录）/ DrawPanel。
- 唯一写入口：`PUT /api/state {patch}`（rest.ts:2686-2693）→ `applyStatePatch`
  （main.ts:1521-1527，落盘 + 收编进树）→ fs.watch 200ms 去抖广播 `state` 帧回流。
- applyPatch 语义（src/state.ts:88-200）：time/location 替换；characters 按名合并
  （null 删）；flags 按键合并；inventory/plot_threads 整体替换；roster 表改注。

### 2.2 jsrunner 现状与容量约束（exp-5）

- 每 enabled 脚本一个 `<iframe srcdoc>`（runtime.ts create() :180），`display:none`
  挂 `#jsrunner-host`；postMessage 协议（types.ts）双向四类消息。
- **容量硬约束（exp-5 实测）**：脚本经 `PUT /api/extdata?scope=global&key=scripts`
  存储；`src/extdata.ts` **单键 value ≤1MB 且整 scope 文件 ≤1MB 双重上限**（:18, :45-60,
  :95, :114）——2.9MB（状态栏）/ 8.5MB（shujuku_index）脚本**必挂**（400）。即使提高
  单键上限，scripts + script_vars + ext_settings 共享同一文件预算仍会撞顶。
- `.liyuan-uploads/` 通道（exp-5 确认）：`POST /api/upload`（rest.ts:1458-1466，
  readBodyRaw 64MB）、`/uploads/` 静态托管（main.ts:2762-2784，防穿越 + nosniff）、
  `DELETE /api/uploads`（rest.ts:1483-1503）。脚本 iframe 同源 `fetch('/uploads/…')`
  可行（srcdoc 继承父 origin，CSP connect-src 放行 http）。**服务端零改动即可承接**。
- `ContextSnapshot`（types.ts:42-71）无 worldState；`state` 帧被 `scriptFrameSink`
  default 丢弃（runtime.ts:305-307）。
- TavernHelper 方法表（helper.ts:350-440）20 个方法，无 UI 注册/自由键/通知方法。
- iframe 注入面（bridge.ts BRIDGE_JS）：jQuery/YAML、TavernHelper Proxy、getContext、
  事件桥、SillyTavern 适配面（EVENT_TYPES 常量表 :162-194）、toastr 桩（仅 console）。

### 2.3 关键缺口

| 缺口 | 与本设计关系 |
|---|---|
| G4 ST 专属 DOM 无等价物 | 化解法：脚本渲染自身 iframe document |
| G3 脚本无带参触发通道 | 面板按钮/事件覆盖；V1 由 iframe 常驻 + 事件驱动 |
| extdata 1MB 双重上限（exp-5） | **拆文件存储**解决（R1-①） |
| `scriptFrameSink` 丢弃 state 帧 | P1 修复 |
| `setScriptMeta` 未接线 | P2 顺带接线 |
| `JsRunnerPanel` 未挂载 | P0 前置 |
| toastr 桩仅 console（G10） | P3 纳入（R2-④） |
| `generate` 服务端无 handler | 独立项（§5.10） |

---

## 3. 设计决策

### 3.1 渲染形态：脚本 iframe 可见化挂载（选定）

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A. iframe 可见化**（选定） | 脚本在自身 iframe 内自由渲染，宿主把该 iframe 移入账本卡片/名录面板容器并显示 | 能力完整、隔离彻底、脚本状态同帧、ST 生态心智 | 需尺寸同步与主题 token 桥 |
| B. 宿主渲染脚本产出 HTML | 脚本给 HTML 字符串，宿主渲染 | 实现最简 | 无交互、无事件响应、XSS 面更大 |
| C. 结构化组件协议 | 脚本声明字段/布局，宿主渲染 | 最安全 | 定制自由度低 |

选定 A：iframe 本就是脚本运行时的家，可见化 = 移动 DOM 节点 + 去掉 display:none，
**同一 contentWindow 不重载，脚本状态完整保留**。CSP 无需放宽。渲染目标约定为脚本
自身 `document.body`。

### 3.2 挂载位置：主卡 + 名录双区域（R3-①）

- **status 区域**（默认）：StatusStrip 展开卡 `status-card` 内、`field-hint` 之前，
  新增 `<LedgerScriptViews area="status" />`。
- **roster 区域**：RosterPanel（左栏名录面板）名录表格下方追加
  `<LedgerScriptViews area="roster" />`。
- `LedgerPanelSpec.area` 决定挂载目标；无脚本注册时组件渲染 null，零侵入。
- 面板头：标题/图标 + scriptId 小字 + **收起/展开按钮**（R1-②，iframe 常驻运行）+
  `ScriptMeta.buttons` 宿主按钮（P4）。
- 面板**默认展开**（R3-②）；**数量不设上限**（R3-③）。
- 布局定位不追求复刻（用户裁决）：fixed 悬浮语义在容器内退化为容器内相对定位，
  UI 本体不受影响。
- tab 接管（脚本替换标准视图）= V2（`position:"tab"` 预留，TODO）。

### 3.3 大内容承载：拆文件存储（R1-①，exp-5 事实驱动）

**问题**：extdata 单键 + 整 scope 文件双重 1MB 上限（src/extdata.ts:18, :95），
2.9MB/8.5MB 脚本与大数据包必挂。

**方案**：
```
ScriptMeta.content 不再内联进 extdata scripts 键
  → 主脚本文件落 /uploads/jsrunner/<scriptId>.js
  → 附带数据文件落 /uploads/jsrunner/<scriptId>/assets/<name>
  → extdata scripts 键只存元数据 + 文件引用（file/assets）
  → 脚本 iframe 内容经 fetch('/uploads/jsrunner/<id>.js') 拉取后组装 srcdoc
  → 附带文件脚本运行期 fetch('/uploads/jsrunner/<id>/assets/<name>') 引用
```

- 复用 `POST /api/upload`（64MB）+ `/uploads/` 托管 + `DELETE /api/uploads`，
  **服务端与 src/ 领域层零改动**。
- 影响面全在前端：JsRunnerPanel（导入/导出/编辑改造）、types.ts（ScriptMeta 引用化）、
  runtime.ts（create 从同步内联变**异步拉取后建帧**）、plan.ts（content 变更检测改按
  引用比对）、frame.ts（srcdoc 组装读引用内容）。
- 数据包（①）同通道：导入时附带文件登记进 assets，脚本 fetch 引用（R1-②导入多文件）。
- **导入**（R2-①）：多文件选择——主脚本 `.js` 强制校验（R4-②）+ 可选附带数据文件
  （任意扩展名）→ 上传 jsrunner 子目录 → 元数据登记。
- **导出**（R2-①）：下载主脚本单文件（数据包不并回，保持脚本自包含可移植）；zip
  打包 V2（TODO）。
- **编辑**（R2-②）：统一外部编辑——脚本只读查看 + 下载，编辑走「下载-改-重新导入」
  覆盖（不破例小脚本）。
- **删除**（R2-③）：删除脚本 → 级联删除其登记文件（jsrunner 子目录）；导入覆盖 →
  旧文件删除新文件登记；清理失败仅记日志不阻塞。脚本 = 文件所有权边界，脚本间文件
  默认隔离；文件共享 V2（TODO）。
- **大小**（R3-④）：不设产品级上限，沿用 64MB 通道。

### 3.4 数据面：前端投影（含消息/回合事件，R5-①）

`state`/`message`/`agent` 帧均已在前端全量流转。账本与剧情事件由前端投影，**不碰
服务端**（mapPiEventsToSt 桥另行处理，与本设计解耦）：

| 事件 | 触发帧 | 说明 |
|---|---|---|
| `WORLD_STATE_CHANGED` | `state` / `hello`（带 state） | 账本变化（含分支回退后的 state 帧） |
| `MESSAGE_RECEIVED` | `message`（assistant 通道落定） | 新回复落定，脚本可刷新剧情可视化 |
| `GENERATION_ENDED` | `agent`（state=end） | 回合结束 |

### 3.5 数据分工：静态数据嵌入脚本，增量数据走 codex（用户裁决）

| 数据 | 谁消费 | 谁变更 | 结论 |
|---|---|---|---|
| 存量静态数据（玩法/成就/卡池等） | 脚本 UI 展示 | 几乎不变 | **嵌入脚本**（文件通道随脚本） |
| 增量/新增数据 | 剧情模型（发卡/邂逅）+ 助手 | 助手持续新增 | **codex**（工具族现成 + 门禁 + 挂载检索） |
| DB 路线已导入 12 库 | 剧情侧检索发卡/邂逅 | — | 保留不动 |

核心分界线：**数据被剧情模型/助手引用 → codex；只被脚本 UI 展示 → 嵌入脚本。**
codex 定位为「AI 可维护的增量通道」，不是存量静态数据仓库。

---

## 4. 架构总览

```
┌──────────────────── 数据面（P1，纯前端投影）──────────────────────┐
│  模型记账/用户编辑/脚本 applyStatePatch                              │
│    → PUT /api/state → 落盘 → fs.watch → broadcast {type:"state"}   │
│    → App.tsx onFrame → jsrunnerBus.onWireFrame(帧)                  │
│        ├─ context.ts sink：缓存 worldState（hello/state 帧）         │
│        └─ runtime.ts scriptFrameSink：                             │
│             state → pushContextToAll + WORLD_STATE_CHANGED          │
│             message(assistant) → MESSAGE_RECEIVED                   │
│             agent(end) → GENERATION_ENDED                           │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼ iframe postMessage
┌──────────────────── 渲染面（P2）────────────────────────────────────┐
│  脚本: TavernHelper.registerLedgerPanel({title, icon?, area?, ...}) │
│    → helper.ts → ledger registry（Map<scriptId, spec>）→ 通知 React  │
│  LedgerScriptViews（status 卡内 / roster 名录下）→ runtime.mount     │
│  resize 帧（bridge ResizeObserver）→ 容器高度（min(reported,maxH)）   │
│  theme 帧（宿主 CSS 变量）→ bridge 写 --ly-*                         │
│  面板头：收起/展开（V1）· ScriptMeta.buttons（P4）· 崩溃占位          │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼
┌──────────────────── 写面与存储面（P3/P4）───────────────────────────┐
│  写账本：applyStatePatch(patch) → PUT /api/state                    │
│  通知：notify(level,text) / toastr 桩 → 宿主 toast                  │
│  文件：导入/导出/删除（/uploads/jsrunner/，P0 拆文件存储）             │
│  自由键：getExtData/setExtData → /api/extdata（<scriptId>:* 命名空间）│
│  管理界面：openManager() → ModalPanel（P4）                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. 协议与接口规格

### 5.1 ContextSnapshot.worldState（types.ts:42）

```ts
// ContextSnapshot 新增（可选字段，遵守契约守则）：
worldState?: WorldState;   // 当前世界状态账本（hello/state 帧投影；未就绪时缺省）
```

- `WorldState` 从 `web/src/wire.ts` 导入（与 App.tsx 同源）。
- context.ts 模块级缓存；sink（context.ts:304）增加 `hello`（取 `frame.state`）与
  `state` 帧缓存；`buildSnapshot()`（:114）有值则带上。

### 5.2 事件面（含 R5-① 前端投影）

- 常量（bridge.ts EVENT_TYPES :162-194 增加）：`WORLD_STATE_CHANGED`、
  `MESSAGE_RECEIVED`、`GENERATION_ENDED`、`LEDGER_BUTTON_CLICKED`。
- runtime.ts `scriptFrameSink`（:294）扩展：

```ts
case "state":
    scriptRuntimes.pushContextToAll();
    scriptRuntimes.emitToAll("WORLD_STATE_CHANGED", [frame.state]);
    break;
case "message":
    // 仅 assistant 通道（narrative/backstage/greeting）落定 → MESSAGE_RECEIVED
    scriptRuntimes.pushContextToAll();
    if (frame.message.channel !== "user")
        scriptRuntimes.emitToAll("MESSAGE_RECEIVED", [{ mes: frame.message.text, is_user: false }]);
    break;
case "agent":
    if (frame.state === "end") scriptRuntimes.emitToAll("GENERATION_ENDED", []);
    break;
```

- 先推 context 后广播事件（脚本回调里 getContext() 新鲜）。脚本写法：
  `eventOn('WORLD_STATE_CHANGED', () => renderLedger(getContext().worldState))`。

### 5.3 registerLedgerPanel / unregisterLedgerPanel（helper.ts 新增）

```ts
/** 面板注册规格（LedgerPanelSpec，types.ts） */
interface LedgerPanelSpec {
    title: string;              // 面板标题（显示在面板头）
    icon?: string;              // 可选：标题栏图标（emoji/文本）
    area?: "status" | "roster"; // 挂载区域，默认 "status"（R3-①）
    position?: "append";        // V1 仅 append（"tab" 预留 V2）
    maxHeight?: number;         // 可选，覆盖默认上限（默认 480px）
}
```

- `registerLedgerPanel(spec)` → ledger registry（新模块 `web/src/jsrunner/ledger.ts`）：
  `Map<scriptId, {spec, height, collapsed}>` + `subscribe` / `getPanels` / `setHeight` /
  `toggleCollapsed` / `remove` / `getThemeTokens`。
- 重复注册 = 覆盖；非法 spec 抛错转 error 回执。`unregisterLedgerPanel()` 移除并通知。
- 生命周期回收：`runtime.destroy(id)`（:192）自动 `ledger.remove(id)`。
- 注册时机：脚本 body 顶层直接调用。
- P2 顺带接线 `setScriptMeta`（helper.ts:31）：`runtime.create()` 建帧时调用
  （面板标题缺省用 meta.name，spec.title 优先）。

### 5.4 applyStatePatch（写账本）

```ts
/** 写账本：与 PUT /api/state 同语义（applyPatch；见 src/state.ts） */
TavernHelper.applyStatePatch(patch: Record<string, unknown>)
    → Promise<{ applied: string[]; warnings: string[] }>
```

- helper.ts 直接 `apiPut("/api/state", { patch })`（与 StatusStrip.tsx:138 同封装），
  无服务端改动。流式生成中拒绝由 REST 面自带。

### 5.5 notify / toastr（P3，R2-④）

```ts
/** 脚本通知 → 宿主 toast（level: "info"|"warning"|"error"|"success"） */
TavernHelper.notify(level: string, text: string): Promise<void>
```

- bridge.ts toastr 桩从「仅 console」改为 invoke `notify`（兼容 ST 写法，
  `toastr.success/error/warning/info` 24 处调用自动落到宿主 toast）。
- 宿主复用现有 pushToast 通道（App.tsx 已有）。

### 5.6 resize 帧与尺寸同步

```ts
// ScriptRequest 新增（types.ts:31）：
| { kind: "resize"; height: number }
```

- bridge.ts 注入 ResizeObserver 自动上报（脚本无需感知）；runtime `onMessage`
  `case "resize"` → `ledger.setHeight` → 通知 React；容器高度 = min(reported, maxHeight)，
  超出上限 iframe 内滚动。挂载时初始上报一次。

### 5.7 theme 帧与主题适配

```ts
// HostMessage 新增（types.ts:80）：
| { kind: "theme"; tokens: Record<string, string> }   // --ly-* token 值
```

- 宿主 `getThemeTokens()` 读 `getComputedStyle(document.documentElement)` 的 app.css
  变量（--surface/--text/--hairline-strong/--accent 等）；推送时机：面板挂载时 +
  App 主题切换处。bridge 写自身 documentElement CSS 变量，脚本 `var(--ly-surface)` 引用。
- 兜底：未收到 theme 前脚本可用亮色/`prefers-color-scheme`。

### 5.8 脚本自有存储面（P4）

```ts
/** 自由 extdata 键读写（scope: "global" | "chat"，缺省 global） */
TavernHelper.getExtData(key: string, scope?: "global" | "chat"): Promise<unknown>
TavernHelper.setExtData(key: string, value: unknown, scope?: "global" | "chat"): Promise<void>
```

- 底层复用 `GET/PUT /api/extdata`（rest.ts:4297-4309），无服务端改动。
- **键约束**（src/extdata.ts:34-43）：≤128 字符、不含 `.` `/` `\`、拒绝原型键；
  单值 ≤1MB（:18）。**命名空间约定**：`<scriptId>:<key>`（如 `cfg:状态栏v267`、
  `data:状态栏v267`）——⑤配置隔离 / ⑥动态数据落此约定。
- **静态数据包（①）走文件通道**（§3.3）：导入附带文件落
  `/uploads/jsrunner/<scriptId>/assets/`，脚本 fetch 引用——不受 1MB 限制。
- 现有 `saveExtensionSettings`（ext_settings 全局键）保持 ST 兼容面不变；新脚本优先
  per-script 键，两通道并行。

### 5.9 宿主级按钮与独立管理界面（P4）

- **宿主按钮（③）**：复用 `ScriptMeta.buttons`（types.ts:21，`{name, visible}[]`），
  宿主在面板标题栏渲染 visible 按钮；点击 → `emitToScript(scriptId,
  "LEDGER_BUTTON_CLICKED", [name])` → 脚本 eventOn 响应。
- **独立管理界面（④）**：宿主组件 `ModalPanel`（居中模态，主题适配，全屏高度），
  复用 `runtime.mount(scriptId, modalBodyEl)`；关闭 → unmount 移回原容器，脚本状态不丢。

```ts
/** 请求宿主弹出该脚本的独立管理界面（模态） */
TavernHelper.openManager(): Promise<{ ok: boolean }>
```

- 同一脚本两个视图（面板 + 模态）= 同一 contentWindow 交替挂载，互斥显示。
  模态内高度不钳制。

### 5.10 LLM 生成内容（独立项）

侦察结论（exp-3）：**补 `ext_generate` 服务端 handler 走旁路 streamSimple 是最短可行
路径（约 40 行）**；agent 通道「能实现但不划算」（语义不匹配 + 浏览器侧无执行入口）。

```ts
// server/main.ts:3573 switch 新增：
case "ext_generate":   // 仿 registerPlannerCaller（main.ts:2425-2464）
    // modelRegistry.find → getApiKeyAndHeaders → streamSimple → ext_gen{delta/end/error}
    break;
case "ext_abort":      // AbortController.abort()
```

- 前端 helper.ts:46-68 pendingGenerates 按 reqId 配对已就绪。与账本定制解耦。

---

## 6. 宿主 UI 设计

### 6.1 LedgerScriptViews（web/src/jsrunner/ui/LedgerScriptViews.tsx）

```tsx
/** 脚本视图区（area="status" 挂 StatusStrip 卡内；area="roster" 挂名录表格下） */
export function LedgerScriptViews({ area }: { area: "status" | "roster" }) {
    const [panels, setPanels] = useState(ledger.getPanels());
    useEffect(() => ledger.subscribe(setPanels), []);
    // 按 area 过滤 panels；每个面板：
    //   <div class="ledger-view">
    //     <div class="ledger-view-head" onClick={toggleCollapsed}>
    //       icon title（+ scriptId 小字）+ 收起/展开箭头 + ScriptMeta.buttons（P4）
    //     </div>
    //     {!collapsed && <div class="ledger-view-body" ref={mountEl} style={{height}} />}
    //   </div>
    // 未就绪/崩溃 → body 灰态占位「脚本未就绪/已停止，查看日志」（R4-①）
}
```

- runtime 新增公开方法（R1-②：收起只隐藏 body，iframe 常驻运行）：

```ts
mount(scriptId: string, container: HTMLElement): void {
    const entry = this.runtimes.get(scriptId);
    if (!entry) return;
    container.appendChild(entry.iframe);
    entry.iframe.style.display = "";
    entry.iframe.removeAttribute("aria-hidden");
    entry.iframe.tabIndex = 0;
    postThemeTo(entry.iframe);
}
unmount(scriptId: string): void { /* 移回 #jsrunner-host 隐藏容器 */ }
```

### 6.2 集成点

- StatusStrip.tsx：`status-card` 内、`field-hint` 前插入 `<LedgerScriptViews area="status" />`。
- RosterPanel.tsx：名录表格下方插入 `<LedgerScriptViews area="roster" />`。
- 无脚本注册时组件渲染 null，零侵入。

### 6.3 ModalPanel（P4）

- 居中模态：遮罩 + 面板容器，主题适配；标题栏 + 关闭按钮；同时只允许一个模态
  （打开前先 unmount 旧脚本）。`runtime.mount(scriptId, modalBodyEl)`。

### 6.4 样式（app.css）

- `.ledger-view*`：面板头小号标签 + 分隔线（--hairline-strong）；body 高度由 registry
  驱动（min(reported, maxHeight)），溢出 iframe 内滚动；占位灰态 `.ledger-view-empty`。
- `.modal-panel*`：遮罩 + 居中卡片，复用现有 CSS 变量与深浅主题。

---

## 7. 预期效果与用户用例

**一句话预期效果**：账本卡片与名录面板里，任何已安装的 jsrunner 脚本都能长出自己的一块
**自定义视图**——实时跟着账本与剧情走、可一键回写、带图标/按钮/独立管理界面/自有数据，
支持到「自包含前端应用」级别的 UI 表现。

### 7.1 前后对比（status 区域）

```
┌─────────────────────────────────────────────┐
│ ▼ 梨园客栈 · 暮色                    现在   │
│  时间   暮色                              │
│  地点   梨园客栈                           │
│  角色   ┃林晚┃ 好感 60 ██████░░ 状态 受伤   │
│  物品   伤药、铜钱×12、书信                │
│  剧情线 为父寻药；客栈老板娘的秘密          │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ▼ 梨园客栈 · 暮色                    设计后 │
│  时间   暮色            （标准视图，不变）    │
│  地点   梨园客栈                            │
│  ……                                        │
│  ── 脚本视图 ────────────────────────────── │
│  ▍⚙ 状态仪表盘（脚本A）    [收起] [设置]     │ ← 图标+收起/展开+宿主按钮
│  ┌──────────────────────────────┐          │
│  │ 林晚  ❤ 60  ──受伤── 温热的关切│          │
│  │ 沈砚  ❤ 85  ──疑心──           │          │
│  └──────────────────────────────┘          │
│  ▍🎒 背包图鉴（脚本B）                      │
│  ┌──────────┬──────────┬──────────┐         │
│  │ 💊 伤药  │ 🪙 铜钱×12│ ✉ 书信   │         │
│  └──────────┴──────────┴──────────┘         │
└─────────────────────────────────────────────┘
```

### 7.2 UC1｜状态仪表盘（status 区域）

展开账本卡片 → 脚本自绘仪表盘（好感渐变条/状态徽章/备注）；模型记账好感 60→85 →
仪表盘当场刷新；深夜主题 → 配色跟随变暗。

### 7.3 UC2｜背包图鉴 + 回写

物品渲染成可点背包格子；丢弃/新增走 `applyStatePatch` → 标准视图同步；空位格录入新物品。

### 7.4 UC3｜剧情可视化 + 一键推进

面板随 `MESSAGE_RECEIVED`/`GENERATION_ENDED` 更新（新回复落定即刷新）；底部预设按钮
「→ 次日清晨」→ applyStatePatch → 折叠条摘要更新 + 面板重渲染；`/rewind /branch`
回退后视图随分支账本一致。

### 7.5 UC4｜多脚本并存与启停

纵向堆叠互不干扰；停用一个 → 面板当场消失；改脚本保存 → 旧面板不残留；每个面板可
独立收起（iframe 常驻运行，收起再展开数据还在）。

### 7.6 UC5｜名录区域挂载（roster）

脚本注册 `area:"roster"` → 左栏名录面板表格下方出现该脚本视图（如"在场角色关系图"）；
与名录表格同屏，数据同源。

### 7.7 UC6｜大脚本 + 静态数据包（P0/P4）

导入 2.9MB 状态栏级脚本成功（拆文件存储）；附带 JSON 数据包（玩法/成就表）一并导入，
脚本 fetch 引用渲染；编辑统一外部（下载-改-重新导入）；删除脚本 → 其文件一并清理。

### 7.8 UC7｜配置隔离 + 动态数据（P4）

脚本把偏好写 `cfg:<id>`、抽卡历史写 `data:<id>` → 刷新仍在、另一脚本读不到；
`getExtData/setExtData` 自由 JSON 形态。

### 7.9 UC8｜独立管理界面 + 通知（P3/P4）

面板头「设置」按钮 → 居中模态脚本自绘管理界面（配置表单/导入导出/测试）；关闭后面板
原样、脚本状态不丢；脚本 toastr/notify → 宿主 toast 可见（"已记账""生成完成"）。

### 7.10 崩溃占位（R4-①）

脚本崩溃/未就绪 → 面板头照常、内容区灰态「脚本未就绪/已停止，查看日志」；不自动重试；
不影响其他面板与宿主。

### 7.11 需求满足度矩阵

| 需求 | 满足情况 |
|---|---|
| 脚本在账本 UI 内渲染自定义视图（status + roster 双区域） | ✅ 核心满足 |
| 账本/剧情数据实时进脚本（3 事件前端投影，随分支回退） | ✅ 满足 |
| 脚本回写账本 | ✅ applyStatePatch |
| ① 静态数据包 | ✅ 文件通道（不受 1MB 限） |
| ② 渲染图标 | ✅ iframe 自由渲染 + 面板头 icon |
| ③ 新增按钮 | ✅ 面板内自由 + ScriptMeta.buttons 宿主渲染 |
| ④ 独立管理界面 | ✅ openManager + ModalPanel |
| ⑤ 配置独立存储 | ✅ cfg:<scriptId> 命名空间 |
| ⑥ 动态数据存储 | ✅ extdata 自由键 |
| 大脚本（2.9MB/8.5MB）承载 | ✅ 拆文件存储（P0） |
| 主题自适应 | ✅ --ly-* token 桥 |
| 通知可见 | ✅ notify / toastr 桩改宿主 toast |
| 面板收起/展开 | ✅ V1；拖拽排序 V2（TODO） |
| 布局定位形态复刻（fixed 悬浮） | ❌ 用户裁决不做 |
| 用户能装上脚本 | ❌ P0 前置（JsRunnerPanel 挂载 + 拆文件） |
| 面板内 LLM 生成 | ⚠️ 独立项 ext_generate |

---

## 8. 改动点清单

| 文件 | 改动 |
|---|---|
| `web/src/jsrunner/types.ts` | ContextSnapshot 加 `worldState?`；ScriptRequest 加 `resize`；HostMessage 加 `theme`；`ScriptMeta` 引用化（file/assets）；新增 `LedgerPanelSpec`（含 `area`） |
| `web/src/jsrunner/ledger.ts`（新） | 面板 registry（Map + subscribe + getPanels + setHeight + toggleCollapsed + remove + getThemeTokens） |
| `web/src/jsrunner/context.ts` | sink 加 hello/state 缓存 worldState；buildSnapshot 带 worldState |
| `web/src/jsrunner/runtime.ts` | scriptFrameSink 加 state/message/agent 事件；onMessage 加 resize；mount/unmount；**create 异步拉取文件后建帧**；setScriptMeta 接线；destroy 调 ledger.remove |
| `web/src/jsrunner/helper.ts` | 方法表加 registerLedgerPanel/unregisterLedgerPanel/applyStatePatch/notify；P4：getExtData/setExtData/openManager |
| `web/src/jsrunner/bridge.ts` | EVENT_TYPES 加 4 事件；ResizeObserver 上报；theme 帧写 CSS 变量；**toastr 桩改 invoke notify** |
| `web/src/jsrunner/plan.ts` | content 变更检测改按 file 引用比对 |
| `web/src/jsrunner/frame.ts` | srcdoc 组装读引用内容 |
| `web/src/jsrunner/ui/JsRunnerPanel.tsx` | **拆文件存储**：多文件导入（.js 强制校验）/ 导出单文件 / 只读查看+下载 / 删除级联清理（P0）；P4：附带数据文件导入 |
| `web/src/jsrunner/ui/LedgerScriptViews.tsx`（新） | 面板渲染（双 area）+ iframe 挂载 + 收起/展开 + 崩溃占位 + 按钮渲染（与 JsRunnerPanel 同 feature 目录） |
| `web/src/jsrunner/ui/ModalPanel.tsx`（新，P4） | 独立管理界面模态容器（App 顶层挂单例） |
| `web/src/components/StatusStrip.tsx` | status-card 内插入 LedgerScriptViews(area="status") |
| `web/src/components/RosterPanel.tsx` | 名录表格下插入 LedgerScriptViews(area="roster") |
| `web/src/App.tsx` | 主题切换处广播 theme tokens；toast 通道复用 |
| `web/src/app.css` | `.ledger-view*` + `.modal-panel*` 样式 |

不改：server/（拆文件复用 /api/upload + /uploads/；数据面纯前端投影；自由键复用
/api/extdata）、src/（领域层）、wire 协议。独立项 ext_generate 例外：server/main.ts
switch + ~40 行。

---

## 9. 安全与边界

- **隔离不变**：脚本可见化只是显示已有 iframe，CSP 不动；脚本不能直接操作宿主 DOM/状态。
- **渲染面完全在 iframe 内**：DOM/样式/脚本注入局限于自身帧；面板高度 maxHeight 钳制。
- **写面走既有 REST 白名单**：applyStatePatch 复用 /api/state 校验面。
- **存储面**：自由键继承 extdata 约束（键长度/字符集/原型键/1MB）；文件走 uploads
  通道（64MB，防穿越托管）。
- **文件所有权**：脚本 = 文件边界，级联清理；导入仅 `.js` 主脚本强制校验。
- **已知边界**（如实标注）：脚本理论上可访问 parent.document（srcdoc 无 sandbox，
  既有架构如此）；sandbox 加固属独立事项（V2 TODO）。外部资源：iframe CSP 允许远程
  资源（用户安装脚本即信任脚本，维持既有信任模型）。

---

## 10. 分阶段实施

| 阶段 | 内容 | 规模 | 验证 |
|---|---|---|---|
| **P0 脚本管理面** | JsRunnerPanel 挂载到 PowersPanel + **拆文件存储**（导入多文件/.js 校验/导出单文件/只读查看+下载/级联清理） | 中 | 导入 2.9MB 级脚本成功；删除级联清理 |
| **P1 数据面** | worldState 快照 + 3 事件前端投影 | 小 | 测试脚本 eventOn 打日志 |
| **P2 渲染面** | ledger registry + registerLedgerPanel + mount/unmount + resize/theme + LedgerScriptViews 双区域 + 收起/展开 + 崩溃占位 + setScriptMeta | 中 | 面板出现、高度跟随、收起/展开、双区域 |
| **P3 写面** | applyStatePatch + notify/toastr | 小 | 改账本双向同步；toast 可见 |
| **P4 定制扩展面** | extdata 自由键 + 面板头按钮 + ModalPanel/openManager + 数据包文件 | 中 | 六项能力逐项冒烟 |
| **独立项** | ext_generate handler（~40 行） | 小 | generate 流式回执 |
| **验收物** | 常驻基准测试双轨（自动化 + 演示脚本） | 随各阶段增量 | npm test 常驻回归 + 演示脚本自检 toast |

P2 与 P3 可并行；P1 无依赖先做；P0 是全部前置；P4 依赖 P2。

---

## 11. 前置依赖与已知断链

| 项 | 状态 | 影响 | 处置 |
|---|---|---|---|
| `JsRunnerPanel` 未挂载 | 断 | 用户无法部署脚本 | P0 挂载到 PowersPanel |
| extdata 1MB 双重上限 | 断 | 大脚本/数据包无法存储 | P0 拆文件存储（§3.3） |
| `setScriptMeta` 未接线 | 断 | getScriptName 恒空 | P2 接线 |
| `generate/generateRaw` 无 handler | 断 | 面板内 LLM 生成挂起 | 独立项（§5.10） |
| `mapPiEventsToSt` 未接线 | ✅ 已接（2026-08-16） | ST 风格服务端事件 | StageEngine 事件桥发射 GENERATION_STARTED/MESSAGE_SENT；前端投影承接其余（无重叠） |
| `POST /api/script/message` 无路由 | ✅ 已补（2026-08-16） | setMessage 404 | rest.ts 新增路由调 host.scriptEditMessage（流式中 409）；helper.ts 调用不再 404 |

---

## 12. 验证方式

### 12.1 构建与类型

```bash
npm --prefix web run typecheck   # tsc --noEmit
npm run web:build                # 改前端后必须重建
npm run web                      # cwd=Liyuan/ 根；0.0.0.0:7620
```

### 12.2 常驻基准测试（R5-② 双轨）

1. **自动化**（`test/jsrunner-baseline.test.ts`，`npm test` 常驻回归）：
   - 快照含 worldState 且字段齐全；
   - 3 事件触发（state/message/agent 帧 → 事件名与载荷正确）；
   - 面板注册/更新/移除（registry 状态机）；
   - applyStatePatch 请求形状正确（mock fetch）；
   - extdata 自由键命名空间与键约束；
   - 文件引用（上传/登记/级联清理）链路。
2. **演示脚本**（可导入 JsRunnerPanel 的 jsrunner 脚本）：
   - 面板注册（status + roster 双 area）、图标、宿主按钮事件；
   - 账本渲染 + 3 事件驱动重渲染；
   - 回写按钮 + notify/toast 汇报；
   - 配置/数据自由键读写；
   - openManager 弹出管理界面；
   - 大内容渲染（体积渲染压力项）——逐项自检后 toast 汇总「能力基准通过/失败项」。

### 12.3 冒烟要点（人工）

1. 导入 2.9MB 级脚本 → 面板出现、可收起/展开、双区域可挂。
2. 改时间/新回复/回合结束 → 面板 3 事件驱动刷新。
3. 深色主题切换 → --ly-* 跟随。
4. 删除脚本 → 面板消失 + 上传区文件级联清理。
5. 崩溃脚本 → 占位提示，其他面板与宿主无恙。
