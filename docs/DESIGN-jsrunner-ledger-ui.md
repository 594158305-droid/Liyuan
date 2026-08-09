# 支持 JS Runner 定制世界状态账本 UI——前端详细设计（D4）

> 版本：D4（2026-08-09）· 基线：D3（docs/DESIGN-jsrunner-ledger.md，需求/协议/架构/裁决）
> 本文档是 D3 的**实现级详细设计**（组件规格、状态、交互、样式、错误处理、验证清单）。
> **分段约定：PART 1 = V1（当前实施范围）；PART 2 = V2（设计完整，仅标记【V2】，
> 实施另行点名）。** 所有 V2 项仅完成设计，不进入实施。
> 适用代码基线：`web/src/jsrunner/*` + `web/src/components/*` + `web/src/app.css`。
>
> **审计修订（D4.1，2026-08-09，依据 feature-arch / react / typescript / ui-design 技能）**：
> - A1 组件归属：`LedgerScriptViews`/`ModalPanel` 归入 **`web/src/jsrunner/ui/`**（与
>   JsRunnerPanel/LogViewer 同 feature，struct-feature-self-contained）；宿主层
>   StatusStrip/RosterPanel/App 向 jsrunner/ui import（与 App.tsx:40-43 既有方向一致）。
> - A2 外部 store 订阅：改用 **`useSyncExternalStore`**（react 7.5）替代 useState+useEffect；
>   `ledger.getPanels()` 返回**稳定快照引用**（写时重建缓存，防无限重渲染）。
> - A3 面板重渲染隔离：`LedgerView` 用 **`React.memo` + primitive props 拆分**，
>   防单面板 resize 上报触发全部面板重渲染。
> - A4 ModalPanel 挂载点：**App.tsx 顶层挂 `<ModalPanel />` 单例**；openManager 请求通道
>   并入 ledger（`onManagerRequest/requestManager`），不再另设 bus。
> - A5 测试边界：项目 `npm test` = node 无 DOM 环境（无 jsdom，AGENTS.md 明示）——
>   自动化只测**纯逻辑 + fetch mock**（ledger 状态机/plan/事件投影），DOM/iframe 行为
>   归演示脚本人工验证；`ledger.ts` 保持**零 DOM 依赖**（getThemeTokens 改注入式）。
> - A6 CLS：面板 body 未就绪时 `min-height` 占位（cwv-minimize-cls）。
> - A7 主题广播：runtime 增公开方法 `broadcastTheme()`（App 主题切换处调用）。
> - A8 TS 纪律：type-only import / interface / 显式返回类型 / exhaustive / 守卫函数。

---

# PART 1：V1 详细设计

## 1. 组件与模块架构

### 1.1 组件树（新增/改动高亮）

```
App.tsx
├─ StatusStrip.tsx  ────────────── 插入 <LedgerScriptViews area="status" />
│   └─ status-card 内、field-hint 前
├─ RosterPanel.tsx  ────────────── 插入 <LedgerScriptViews area="roster" />
│   └─ 名录表格下方
├─ PowersPanel.tsx  ────────────── 挂载 <JsRunnerPanel/>（P0，新增「脚本」tab）
└─ <ModalPanel />（P4，顶层单例，与既有模态同层）

web/src/jsrunner/ui/（新组件，与 JsRunnerPanel/LogViewer 同 feature）
├─ LedgerScriptViews.tsx（area 参数化，status/roster 两处复用）
│   └─ LedgerView（memo：头 + body）
│      ├─ 面板头：icon + title + scriptId 小字 + 收起箭头 + ScriptMeta.buttons（P4）
│      └─ body：iframe 挂载槽（runtime.mount 目标）｜崩溃占位｜收起时隐藏
└─ ModalPanel.tsx（P4）
   └─ 遮罩 + 居中卡片（标题栏 + 关闭）
```

### 1.2 模块依赖图

```
ledger.ts（新：面板注册中心，纯 TS，**零 DOM 依赖**——A5）
  ├─ 依赖：types.ts（LedgerPanelSpec）；（getThemeTokens 由调用方注入 document）
  ├─ 被依赖：helper.ts（方法实现）、runtime.ts（destroy 清理）、
  │         jsrunner/ui/LedgerScriptViews.tsx（useSyncExternalStore 订阅）、
  │         jsrunner/ui/ModalPanel.tsx（manager 请求订阅）
  └─ 额外通道：onManagerRequest/requestManager（P4 模态请求，A4）

runtime.ts（扩展）
  ├─ mount/unmount（iframe 可见化）
  ├─ broadcastTheme()（A7：App 主题切换处调用，向全部已挂载 iframe 推 theme）
  ├─ scriptFrameSink 3 事件（state/message/agent）
  ├─ onMessage resize
  ├─ create 异步拉取文件（P0 拆文件存储）
  └─ destroy → ledger.remove

helper.ts（扩展）：registerLedgerPanel / unregisterLedgerPanel / applyStatePatch /
                   notify / getExtData / setExtData / openManager（P4）

bridge.ts（扩展）：EVENT_TYPES 4 常量 / ResizeObserver / theme 帧 / toastr→notify
```

### 1.3 状态流（面板生命周期状态机）

```
脚本 iframe 载入 → 顶层调用 registerLedgerPanel(spec)
  → ledger.upsert(scriptId, spec) → notify 订阅者 → React setState
  → LedgerScriptViews 渲染面板区块
  → useEffect：runtime.mount(scriptId, el)（iframe 移入、可见、推 theme）
  → bridge ResizeObserver 上报 → ledger.setHeight → React 更新容器高度
脚本未 ready / 崩溃 → 面板头照常 + body 占位「脚本未就绪/已停止」
用户点收起 → ledger.toggleCollapsed → body 隐藏（iframe 常驻）
脚本停用/删除 → runtime.destroy → ledger.remove → 面板消失 + 文件级联清理（P0）
```

---

## 2. 模块详细规格

### 2.1 ledger.ts（新模块，面板注册中心）

**类型**（types.ts 同步）：

```ts
/** 面板注册规格（types.ts 新增） */
export interface LedgerPanelSpec {
    title: string;               // 面板标题（面板头显示）
    icon?: string;               // 可选：标题栏图标（emoji/文本，宿主渲染）
    area?: "status" | "roster";  // 挂载区域，默认 "status"
    position?: "append";         // V1 仅 append（"tab" 预留 V2）
    maxHeight?: number;          // 可选，覆盖默认上限（默认 480px）
}

/** 注册表条目（ledger.ts 内部） */
interface LedgerEntry {
    spec: LedgerPanelSpec;
    height: number;              // bridge resize 上报的 iframe 内容高度
    collapsed: boolean;          // 用户收起状态（V1 不做持久化）
    ready: boolean;              // iframe ready 收到过（崩溃/未就绪占位依据）
}
```

**API**：

```ts
export const ledger = {
    /** 注册/覆盖（脚本 invoke 入口；重复注册 = 更新 spec） */
    upsert(scriptId: string, spec: LedgerPanelSpec): void,
    /** 注销（unregisterLedgerPanel 或 destroy 调用） */
    remove(scriptId: string): void,
    /** 面板列表快照（useSyncExternalStore 的 getSnapshot；返回稳定引用，A2） */
    getPanels(): ReadonlyArray<{ scriptId: string; entry: LedgerEntry }>,
    /** 订阅（React 用）；返回退订函数 */
    subscribe(listener: () => void): () => void,
    /** bridge resize 上报入口 */
    setHeight(scriptId: string, height: number): void,
    /** 收起/展开切换 */
    toggleCollapsed(scriptId: string): void,
    /** iframe ready 状态更新（runtime ready 时调用） */
    setReady(scriptId: string, ready: boolean): void,
    /** 面板 modalized 状态（P4：模态占用时账本侧不挂载） */
    setModalized(scriptId: string, modalized: boolean): void,
    /** P4：openManager 请求通道（helper.openManager → requestManager） */
    requestManager(scriptId: string): void,
    onManagerRequest(cb: (scriptId: string) => void): () => void,
};

/** 主题 token 读取（A5：注入式，ledger 核心零 DOM）——ledger.ts 只声明，
 *  实现在独立函数 getThemeTokensFrom(doc: Document)，runtime/App 注入调用 */
export function getThemeTokensFrom(doc: Document): Record<string, string>;
```

**实现要点**：
- 内部 `Map<scriptId, LedgerEntry>` + `Set<listener>` + **快照缓存**：每次变更重建
  `panelsSnapshot` 数组（新引用）并缓存；`getPanels()` 直接返回缓存引用——
  **不变不重建**（useSyncExternalStore 要求 getSnapshot 引用稳定，否则无限循环）。
- `getThemeTokensFrom(doc)`：读 `doc.documentElement` 的 CSS 变量（--surface/--text/
  --hairline-strong/--accent/--danger/--ok/--radius/--font-size 等，实现时按 app.css
  实际变量核清单，缺省跳过）。**ledger.ts 模块顶层不触碰 document**（node 测试可
  直接 import，A5）。
- 无 React 依赖，纯模块（与 jsrunnerBus 同风格）。

### 2.2 types.ts 扩展

```ts
// ContextSnapshot（:42）新增：
worldState?: WorldState;   // 账本快照（hello/state 帧投影）

// ScriptRequest（:31）新增：
| { kind: "resize"; height: number }

// HostMessage（:80）新增：
| { kind: "theme"; tokens: Record<string, string> }

// ScriptMeta（:13）引用化（P0 拆文件存储）：
export interface ScriptMeta {
    id: string;
    name: string;
    /** 脚本本体文件引用（/uploads/jsrunner/<id>.js 的文件名或完整相对路径） */
    file: string;
    /** 附带数据文件列表（导入时登记；脚本 fetch('/uploads/jsrunner/<id>/assets/<name>') 引用） */
    assets?: string[];
    enabled: boolean;
    info?: string;
    buttons?: Array<{ name: string; visible: boolean }>;
    /** 兼容字段（旧数据迁移后删除；V1 保留 content 可选，有则优先生效） */
    content?: string;
}

// 新增：
export interface LedgerPanelSpec { /* 见 2.1 */ }
```

**契约守则**：新字段全可选；`content` 保留为迁移兼容（读取时 file 优先）。

### 2.3 context.ts（worldState 缓存）

```ts
// 模块级缓存
let worldStateCache: WorldState | null = null;

// sink（:304）扩展：
case "hello": if (frame.state) worldStateCache = frame.state; /* 既有逻辑继续 */
case "state": worldStateCache = frame.state; break;  // 新增 case

// buildSnapshot（:114）：
worldState: worldStateCache ?? undefined,
```

### 2.4 runtime.ts（渲染核心）

**scriptFrameSink 扩展**（:294）：

```ts
case "state":
    scriptRuntimes.pushContextToAll();
    scriptRuntimes.emitToAll("WORLD_STATE_CHANGED", [frame.state]);
    break;
case "message":
    scriptRuntimes.pushContextToAll();
    if (frame.message.channel !== "user")
        scriptRuntimes.emitToAll("MESSAGE_RECEIVED", [{ mes: frame.message.text, is_user: false }]);
    break;
case "agent":
    if (frame.state === "end") scriptRuntimes.emitToAll("GENERATION_ENDED", []);
    break;
```

**onMessage 扩展**：`case "resize"` → `ledger.setHeight(scriptId, data.height)`。
**ready 处理**（:221）：`ledger.setReady(scriptId, true)`；补发快照逻辑不变。

**mount/unmount**：

```ts
/** 把脚本 iframe 可见化挂进宿主容器（同一 contentWindow，不重载） */
mount(scriptId: string, container: HTMLElement): void {
    const entry = this.runtimes.get(scriptId);
    if (!entry) return;
    container.appendChild(entry.iframe);
    entry.iframe.style.display = "";
    entry.iframe.removeAttribute("aria-hidden");
    entry.iframe.tabIndex = 0;
    this.postTheme(entry.iframe);   // 挂载时补推主题 token
}

/** 移回 #jsrunner-host 隐藏容器，恢复隐藏态（面板收起/模态关闭/区域切换用） */
unmount(scriptId: string): void {
    const entry = this.runtimes.get(scriptId);
    if (!entry) return;
    entry.iframe.style.display = "none";
    entry.iframe.setAttribute("aria-hidden", "true");
    entry.iframe.tabIndex = -1;
    document.getElementById(HOST_ID)?.appendChild(entry.iframe);
}

/** 向单帧推主题（内部；theme 帧封装） */
private postTheme(iframe: HTMLIFrameElement): void {
    iframe.contentWindow?.postMessage({
        kind: "theme",
        tokens: getThemeTokensFrom(document),   // A5：注入式读取
    }, "*");
}

/** 向全部运行中脚本广播主题（A7：App 主题切换处调用；未挂载的也推，bridge 接收即应用） */
broadcastTheme(): void {
    const tokens = getThemeTokensFrom(document);
    for (const [id, entry] of this.runtimes) {
        entry.iframe.contentWindow?.postMessage({ kind: "theme", tokens }, "*");
    }
}
```

**create 异步化**（P0 拆文件存储）：`create(meta)` 改为：若 `meta.file` 存在 →
`fetch("/uploads/jsrunner/<file>")` 拉文本 → 组装 srcdoc → 建 iframe；`meta.content`
（迁移兼容）同步用。失败（404/网络）→ `console.warn` + 面板占位（ledger 侧显示
「脚本文件缺失」）。注意 fetch 失败时**不建 iframe**，占位由 LedgerScriptViews 依据
`ledger` 中条目 + iframe 缺失状态渲染。

**destroy**（:192）：`ledger.remove(id)` 追加进现有清理。

### 2.5 helper.ts（方法表新增）

```ts
// 面板注册
registerLedgerPanel(scriptId, [spec]) {
    const s = (args[0] as LedgerPanelSpec | undefined) ?? {};
    if (typeof s.title !== "string" || !s.title.trim())
        throw new Error("registerLedgerPanel 需要 title");
    if (s.area && s.area !== "status" && s.area !== "roster")
        throw new Error(`非法 area: ${s.area}`);
    ledger.upsert(scriptId, { area: "status", position: "append", ...s, title: s.title.trim() });
    return { ok: true };
},
unregisterLedgerPanel(scriptId) { ledger.remove(scriptId); return { ok: true }; },

// 写账本
applyStatePatch(scriptId, args) {
    const patch = (args[0] as Record<string, unknown> | undefined) ?? {};
    return apiPut("/api/state", { patch });   // 复用 StatusStrip 同封装
},

// 通知（R2-④）
notify(scriptId, args) {
    const level = ["info","warning","error","success"].includes(String(args[0]))
        ? String(args[0]) : "info";
    return pushToast(level as any, String(args[1] ?? ""));
},

// P4：自由 extdata 键
getExtData(scriptId, args) { return getExtDataRaw(String(args[0]), args[1] as any); },
setExtData(scriptId, args) {
    setExtDataRaw(String(args[0]), args[1], (args[2] as "global"|"chat") ?? "global");
    return undefined;
},

// P4：独立管理界面
openManager(scriptId, args) { openManagerModal(scriptId); return { ok: true }; },
```

- `pushToast`：复用 App 现有 toast 通道（模块级订阅 App 的 toast 函数或走
  `window.dispatchEvent(new CustomEvent("liyuan:toast", ...))`，实现时取轻量方案）。
- `getExtDataRaw/setExtDataRaw`：封装 `apiGet/apiPut("/api/extdata?scope=&key=")`。

### 2.6 bridge.ts（iframe 注入面扩展）

**EVENT_TYPES**（:162）追加：`WORLD_STATE_CHANGED`、`MESSAGE_RECEIVED`、
`GENERATION_ENDED`、`LEDGER_BUTTON_CLICKED`。

**ResizeObserver 注入**（BRIDGE_JS 内）：

```js
if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(function () {
        const h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
        if (h > 0) post({ kind: "resize", height: h });
    });
    ro.observe(document.documentElement);
}
```

**theme 帧处理**（消息监听 switch 追加）：

```js
case "theme": {
    const t = data.tokens || {};
    const st = document.documentElement.style;
    Object.keys(t).forEach(function (k) { st.setProperty("--ly-" + k, t[k]); });
    break;
}
```

**toastr 桩改造**（R2-④）：`window.toastr = { error: t, warning: t, info: t, success: t }`
其中 `t = (msg) => invoke("notify", ["info", msg])` 按级别映射
（error→"error", warning→"warning", info/success→"info"）。

### 2.7 LedgerScriptViews.tsx（新组件，web/src/jsrunner/ui/）

```tsx
/** 脚本视图区（area="status" 挂 StatusStrip 卡内；area="roster" 挂名录表格下） */
export function LedgerScriptViews({ area }: { area: "status" | "roster" }) {
    // A2：外部 store 用 useSyncExternalStore（react 7.5），getPanels 返回稳定快照引用
    const panels = useSyncExternalStore(ledger.subscribe, ledger.getPanels);

    const visible = panels.filter((p) => (p.entry.spec.area ?? "status") === area);
    if (visible.length === 0) return null;   // 零侵入

    return (
        <div className="ledger-views">
            {visible.map(({ scriptId, entry }) => (
                // A3：primitive props + memo，单面板高度变化不触发其它面板重渲染
                <LedgerView
                    key={scriptId}
                    scriptId={scriptId}
                    title={entry.spec.title}
                    icon={entry.spec.icon}
                    collapsed={entry.collapsed}
                    ready={entry.ready}
                    modalized={entry.modalized}
                    height={entry.height}
                    maxHeight={entry.spec.maxHeight}
                />
            ))}
        </div>
    );
}

const LedgerView = memo(function LedgerView({
    scriptId, title, icon, collapsed, ready, modalized, height, maxHeight,
}: LedgerViewProps) {
    const bodyRef = useRef<HTMLDivElement>(null);

    // 挂载/卸载副作用：面板出现挂载；收起/模态占用/未就绪不挂载。
    // A3：依赖全为 primitive，避免对象引用导致的反复卸载/重挂
    useEffect(() => {
        const el = bodyRef.current;
        if (!el || collapsed || modalized || !ready) return;
        scriptRuntimes.mount(scriptId, el);
        return () => { scriptRuntimes.unmount(scriptId); };
    }, [scriptId, collapsed, modalized, ready]);

    const h = Math.min(height, maxHeight ?? 480);

    return (
        <div className="ledger-view">
            <div
                className="ledger-view-head"
                role="button" tabIndex={0}
                aria-expanded={!collapsed}
                onClick={() => ledger.toggleCollapsed(scriptId)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ledger.toggleCollapsed(scriptId); } }}
            >
                {icon ? <span className="ledger-view-icon">{icon}</span> : null}
                <span className="ledger-view-title">{title}</span>
                <span className="ledger-view-script">{scriptId}</span>
                <span className="ledger-view-caret">{collapsed ? "▸" : "▾"}</span>
                {/* P4：ScriptMeta.buttons 宿主按钮渲染（点击 emitToScript LEDGER_BUTTON_CLICKED） */}
                <LedgerViewButtons scriptId={scriptId} />
            </div>
            {!collapsed && (
                <div
                    className="ledger-view-body"
                    ref={bodyRef}
                    style={ready ? { height: `${h}px` } : undefined}
                >
                    {!ready && (
                        <div className="ledger-view-empty">
                            脚本未就绪/已停止（查看脚本日志）
                        </div>
                    )}
                </div>
            )}
        </div>
    );
});
```

**关键行为**：
- **折叠**：body 不渲染 → iframe 被 unmount 移回隐藏容器（R1-②：iframe 常驻运行，
  收起/展开不重载，脚本状态保留）。
- **崩溃/未就绪**：`ready=false` → 不 mount + 灰态占位（R4-①）。
- **模态占用**：`modalized=true`（P4）→ 本区域不挂载（iframe 在模态里），关闭后恢复。
- **多区域互斥**：同一脚本只注册一个 area；若脚本重复注册不同 area，后者覆盖（upsert
  语义），前区域面板消失——文档引导脚本只注册一处。
- **重渲染隔离（A3）**：LedgerView 收 primitive props + memo——某面板 resize 上报只
  重渲染自身；列表订阅经 useSyncExternalStore 快照（A2），ledger 变更才触发。
- **性能**：面板多时（R3-③ 不设上限）靠 iframe 常驻 + maxHeight 钳制；V1 不做虚拟化
  （V2 性能实测项见 PART 2）。

### 2.8 ModalPanel.tsx（新组件，web/src/jsrunner/ui/，P4）

> A4：**App.tsx 顶层挂 `<ModalPanel />` 单例**；请求通道走 `ledger.onManagerRequest`
> （helper.openManager → ledger.requestManager），不再另设 bus 模块。

```tsx
/** 独立管理界面模态：挂载脚本 iframe 到模态 body；关闭 unmount 移回原容器 */
export function ModalPanel() {
    const [openScript, setOpenScript] = useState<string | null>(null);

    useEffect(() => {
        // A4：统一走 ledger 的 manager 请求通道；同时只允许一个模态
        const off = ledger.onManagerRequest((scriptId) => {
            // 先标记旧模态脚本解除占用，再打开新的
            if (openScriptRef.current) ledger.setModalized(openScriptRef.current, false);
            setOpenScript(scriptId);
        });
        return off;
    }, []);

    useEffect(() => {
        const prev = prevScriptRef.current;
        if (prev && prev !== openScript) ledger.setModalized(prev, false);
        prevScriptRef.current = openScript;
        if (openScript) ledger.setModalized(openScript, true);
    }, [openScript]);

    if (!openScript) return null;
    return (
        <div className="modal-panel-overlay" onClick={() => setOpenScript(null)}>
            <div className="modal-panel" role="dialog" aria-modal="true"
                 aria-label={`脚本管理界面：${openScript}`}
                 onClick={(e) => e.stopPropagation()}>
                <div className="modal-panel-head">
                    <span>{openScript}</span>
                    <button type="button" className="icon-btn" aria-label="关闭"
                            onClick={() => setOpenScript(null)}>✕</button>
                </div>
                <div className="modal-panel-body" ref={bodyRef} />
            </div>
        </div>
    );
}
```

- Esc 关闭（App 级 keydown 监听，仅当 openScript 非空）。
- 模态打开/关闭 = `ledger.setModalized` 标记 → LedgerScriptViews 的挂载副作用感知
  `modalized` → 账本侧不挂载（同一 iframe 只能挂一处）；关闭后恢复挂载。
- 焦点管理：打开后焦点入模态（关闭按钮或标题）；关闭后焦点回 `document.body`
  （脚本触发的模态无宿主侧触发元素，ui-design：不丢失焦点即可）。

### 2.9 JsRunnerPanel.tsx 改造（P0 拆文件存储）

**ScriptMeta 读写变化**：`saveList`（:201-215）不再把 content 内联进 scripts 数组——
元数据（id/name/enabled/info/buttons/file/assets）走 extdata；内容文件走 uploads。

**导入流程**（importFile :244-275 重写）：

```
用户选择文件（<input type="file" multiple>）
→ 校验：主脚本扩展名必须 .js（R4-②）；其余文件视为附带数据文件（assets）
→ POST /api/upload（逐文件；path 带 jsrunner/<scriptId> 前缀由前端生成文件名）
→ 生成 scriptId（crypto.randomUUID 或短 id）
→ 元数据登记：extdata scripts 键 append { id, name: 文件名, file: <文件名>, assets: [...] }
→ scriptRuntimes.setScripts(更新后列表) → iframe 异步拉取文件建帧
→ toast「脚本已导入」
```

**导出流程**（新增「下载」按钮）：
- 从 `/uploads/jsrunner/<file>` fetch 文本 → Blob → a[download] 触发下载
  （文件名为脚本名 .js）。

**只读查看 + 外部编辑**（R2-②）：
- 编辑区对已有脚本：只读 textarea/pre + 「下载」按钮；提示文案
  「编辑：下载后修改，重新导入覆盖」。
- 移除保存按钮（saveScript 改为仅元数据保存：name/enabled/info/buttons 可编辑）。

**删除级联清理**（R2-③）：
- removeScript：DELETE /api/uploads（file + assets 逐个）→ 失败记日志不阻塞 →
  元数据从 scripts 键移除 → setScripts。

**P4 附带文件**：导入时 assets 自动登记；`meta.assets` 在脚本侧不可见（脚本用
`fetch('/uploads/jsrunner/<id>/assets/<name>')`，文件名由脚本约定或面板展示）。

### 2.10 StatusStrip / RosterPanel 集成

- 宿主层 import 方向与 App.tsx:40-43 一致（components → jsrunner/ui，A1）：
  `import { LedgerScriptViews } from "../jsrunner/ui/LedgerScriptViews.tsx";`
- StatusStrip.tsx：`status-card` 内 `field-hint`（:241）之前插入
  `<LedgerScriptViews area="status" />`。
- RosterPanel.tsx：名录表格之后插入 `<LedgerScriptViews area="roster" />`。
- 两处均无条件渲染（组件内部按注册过滤，空则 null）。
- App.tsx：顶层（与既有模态同层）挂 `<ModalPanel />`（P4）；主题切换处调
  `scriptRuntimes.broadcastTheme()`（A7）。

---

## 3. 样式设计（app.css）

```css
/* ── 脚本视图区（账本卡片内 / 名录面板下）── */
.ledger-views {
    margin-top: 10px;                 /* 与上方内容分隔 */
    display: flex; flex-direction: column; gap: 8px;
}
.ledger-view {
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius, 8px);
    background: var(--surface);
}
.ledger-view-head {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px;
    font-size: 12px; color: var(--text-faint);
    cursor: pointer; user-select: none;
}
.ledger-view-head:hover { background: var(--surface-2, var(--surface)); }
.ledger-view-icon { font-size: 14px; }
.ledger-view-title { color: var(--text); font-weight: 600; }
.ledger-view-script { opacity: .6; font-size: 11px; }
.ledger-view-caret { margin-left: auto; }
.ledger-view-buttons { display: flex; gap: 4px; margin-left: 8px; }
.ledger-view-buttons button {
    font-size: 11px; padding: 2px 8px;
    border: 1px solid var(--hairline); border-radius: 4px;
    background: transparent; color: var(--accent); cursor: pointer;
}
.ledger-view-body {
    border-top: 1px solid var(--hairline);
    overflow: hidden;                 /* iframe 内滚动由 iframe 自身承担 */
    min-height: 120px;                /* A6：未就绪/高度未上报时占位，防展开 CLS */
}
.ledger-view-body iframe {
    width: 100%; height: 100%; border: 0; display: block;
}
.ledger-view-empty {
    padding: 24px 12px; text-align: center;
    color: var(--text-faint); font-size: 12px;
}
.ledger-view-buttons button {
    min-height: 24px;                 /* ui-design access-target-size：≥24px 触控目标 */
    min-width: 40px;
}

/* ── 独立管理界面模态（P4）── */
.modal-panel-overlay {
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,.45);
    display: flex; align-items: center; justify-content: center;
}
.modal-panel {
    width: min(720px, calc(100vw - 32px));
    height: min(80vh, 640px);
    background: var(--surface);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius, 10px);
    display: flex; flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,.3);
}
.modal-panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; border-bottom: 1px solid var(--hairline);
    font-size: 13px; color: var(--text);
}
.modal-panel-body { flex: 1; overflow: hidden; }
.modal-panel-body iframe { width: 100%; height: 100%; border: 0; display: block; }
```

- 深色主题：全部走 CSS 变量，自动适配（无需额外媒体查询）。
- 移动端（≤999px）：`.modal-panel` 宽度 `calc(100vw - 16px)`、高度 `92vh`。

---

## 4. 交互与可访问性

| 交互 | 实现 | 可访问性 |
|---|---|---|
| 面板头点击收起/展开 | onClick + Enter/Space（role=button） | aria-expanded |
| 面板头宿主按钮（P4） | 原生 button | 默认 |
| 模态打开 | openManager invoke → ModalPanel | role=dialog + aria-modal + Esc 关闭 |
| 模态关闭 | 遮罩点击 / ✕ / Esc | 关闭后焦点回面板头 |
| 面板顺序 | V1 固定注册序 | —（V2 拖拽时再补 aria-grabbed 等） |
| 崩溃占位 | 文本 + 查看日志提示 | 文本可读即可 |
| iframe 内容 | 脚本自管理 | 不承诺（第三方内容） |

键盘导航完整性：面板头可 Tab 聚焦、Enter/Space 触发；模态内 Tab 循环（V1 简化：
至少关闭按钮可聚焦 + Esc 关闭）。

---

## 5. 错误处理矩阵

| 场景 | 表现 | 处置 |
|---|---|---|
| 脚本文件 fetch 404/网络失败（P0） | 面板占位「脚本文件缺失」 | 日志 + 面板可重试（重新导入）；不自动重试 |
| 脚本顶层抛错 | 已有 error → 日志；面板置未就绪占位 | 用户查日志；重载由脚本管理面板 |
| iframe 未 ready 超时（如 10s） | 面板占位「脚本未就绪」 | 不重试；显示脚本名（用户可停用） |
| registerLedgerPanel 非法 spec | error 回执 → 脚本 catch | 宿主不崩 |
| applyStatePatch 400（流式中/非法 patch） | error 回执 → 脚本 catch + 可选 notify | REST 校验面自带 |
| 面板高度超 maxHeight | 钳制 + iframe 内滚动 | 正常行为 |
| 导入文件超 64MB | 上传 413 → toast 失败 | 用户自担（R3-④） |
| 删除文件清理失败 | 记日志不阻塞删除 | 孤儿文件可手动清理（V2 提供清理入口？TODO） |
| 模态同时打开两个 | 后开先关（单模态） | openManager 互斥 |
| theme 未推送（主题切换前） | 脚本用亮色兜底 | bridge 缺省不阻塞 |

---

## 6. 验证清单（常驻双轨，R5-②）

### 6.1 自动化（test/jsrunner-baseline.test.ts，npm test 常驻）

> A5 边界：项目 `npm test` = `node --test test/*.test.ts`（node 无 DOM 环境、无 jsdom，
> AGENTS.md 明示 web 无测试框架）。**自动化只测纯逻辑**：ledger 状态机、plan 同步计划、
> 事件投影（注入假帧）、fetch mock（apiPut/apiGet 层）、extdata 键约束。
> DOM/iframe 行为（mount/unmount/收起/占位）归 §6.2 演示脚本人工验证。
> 依赖 node 可跑性：ledger.ts 零 DOM（A5）、context 事件投影拆纯函数（见 §6.1b）。

| 用例 | 断言 |
|---|---|
| ledger upsert/remove | 注册 → getPanels 含条目；重复注册覆盖；remove 清空；订阅通知次数 |
| ledger 快照稳定性（A2） | 无变更时 getPanels() 返回同一引用；变更后新引用 |
| toggleCollapsed / setReady / setModalized | 状态翻转 + 订阅通知次数 |
| 事件投影：WORLD_STATE_CHANGED | 注入 state 帧 → 事件名 + [state] 载荷 |
| 事件投影：MESSAGE_RECEIVED | 注入 message(assistant) → 事件 + 载荷；user 通道不触发 |
| 事件投影：GENERATION_ENDED | 注入 agent(state=end) → 事件；start 不触发 |
| applyStatePatch | mock fetch 断言 PUT /api/state {patch} |
| notify | mock toast 断言级别/文本映射 |
| extdata 键约束 | 非法键（点号/超长/原型键）抛错 |
| ScriptMeta 引用化 | file 优先于 content；assets 列表登记 |
| 级联清理 | 删除 → DELETE /api/uploads 调用次数 = file+assets（mock fetch） |

**§6.1b 事件投影拆纯函数**（A5 支撑）：`scriptFrameSink` 的事件映射逻辑（帧 → 事件名
+ 载荷）抽成纯函数 `mapFrameToScriptEvents(frame)`（runtime.ts 内导出，无 DOM 依赖），
自动化直测该函数；sink 只做「调用函数 + pushContext + emitToAll」薄壳。

### 6.2 演示脚本（可导入 JsRunnerPanel 的 jsrunner 脚本，自检 toast 汇报）

```javascript
// 能力基准演示脚本（常驻；导入即跑，逐项自检 toast 汇报）
TavernHelper.registerLedgerPanel({ title: '能力基准自检', icon: '🧪' });
const report = [];
const check = (name, ok, extra) => report.push(`${ok ? '✅' : '❌'} ${name}${extra ? '：' + extra : ''}`);

// 1. 面板注册 + 图标
check('面板注册+图标', true);
// 2. 账本数据
const ws = getContext().worldState;
check('worldState 快照', !!ws && typeof ws.time === 'string', ws ? `time=${ws.time}` : '缺');
// 3. 事件（WORLD_STATE_CHANGED / MESSAGE_RECEIVED / GENERATION_ENDED）
let evCount = 0;
eventOn('WORLD_STATE_CHANGED', () => { evCount++; render(); });
eventOn('MESSAGE_RECEIVED', () => { evCount++; render(); });
eventOn('GENERATION_ENDED', () => { evCount++; render(); });
check('3 事件订阅', typeof eventOn === 'function');
// 4. 渲染（大内容：1000 行表格）
document.body.innerHTML = '<div id="demo"></div>';
function render() {
    const ws = getContext().worldState || {};
    const rows = Array.from({ length: 1000 }, (_, i) => `<tr><td>${i}</td><td>${ws.time || ''}</td></tr>`).join('');
    document.getElementById('demo').innerHTML = `<table>${rows}</table>`;
    check('大内容渲染(1000行)', document.getElementById('demo').innerHTML.length > 10000);
}
render();
// 5. 回写
TavernHelper.applyStatePatch({ flags: { '基准自检': String(Date.now()) } }).then((r) => {
    check('applyStatePatch 回写', r.applied.length > 0, r.applied.join('、'));
    reportAll();
}, (e) => { check('applyStatePatch 回写', false, String(e)); reportAll(); });
// 6. 存储（P4：free key）
TavernHelper.setExtData('cfg:baseline', { ts: Date.now() });
TavernHelper.getExtData('cfg:baseline').then((v) => {
    check('extdata 自由键读写', !!v && v.ts > 0);
    reportAll();
});
// 7. 通知
TavernHelper.notify('info', '能力基准脚本已就绪');
function reportAll() {
    const fails = report.filter((r) => r.startsWith('❌'));
    TavernHelper.notify(fails.length ? 'error' : 'success',
        `能力基准：${report.length - fails.length}/${report.length} 通过`);
    console.log('[baseline]', report.join('\n'));
}
```

> 人工验证项：面板出现在账本卡片；收起/展开；双 area（改 area 重注册看名录面板）；
> 深色主题下 --ly-* 生效；模态弹出（P4 openManager 按钮）。

---

# PART 2：V2 详细设计（仅设计，标记【V2】，实施另行点名）

> 以下各项设计完整但不实施。V1 实施完成后，用户点名某项即可按本节落地。

## V2-1. zip 打包导入/导出【V2】

**目标**：脚本 + 数据包 + 图标素材多文件一次打包（对应 R2-① zip V2 与 V2 TODO ①）。

**设计**：
- 导入：接受 `.zip`；前端 `JSZip`（新依赖）解包 → 按约定结构识别主脚本（根目录
  唯一 `.js` 或 manifest 指定）→ 其余文件按相对路径落
  `/uploads/jsrunner/<id>/assets/`（保留子目录）→ 元数据登记。
- 导出：勾选「包含附带文件」→ 打包 zip 下载（主脚本 + assets）。
- Manifest（可选）：`manifest.json` 声明 `{ main: "script.js", assets: [...], title }`；
  无 manifest 时按「唯一 .js」推断。
- 挂载点：JsRunnerPanel 导入/导出流程扩展；类型校验：`.js` 单文件照旧，`.zip` 走本流程。
- 依赖：新依赖 JSZip（或后端 zip（V2 再定）——**V2 决策点**：前端解包 vs 后端解包。
  前端解包简单但浏览器端 JSZip 体积 ~100KB；后端解包需新增依赖 + 端点。倾向前端）。

## V2-2. 面板顺序拖拽排序【V2】

**目标**：用户拖拽面板头调整显示顺序（R1-② 必做项，V2 TODO ②）。

**设计**：
- ledger 增 `order: string[]`（scriptId 顺序数组）；`move(scriptId, toIndex)`；
  getPanels 按 order 排序（未收录的按注册序追加）。
- 持久化：extdata `global:panel-order`（per 会话区域？V1 无会话级区分，全局即可；
  若需要 per-session 再议——V2 决策点）。
- 交互：面板头拖拽把手（grip icon）→ pointer events + setPointerCapture；
  拖拽中目标面板 `data-dragging` 高亮；释放后 move + 订阅通知。
- 可访问性：grip 可聚焦 + Alt+↑/↓ 移动（aria-grabbed 语义）。
- 依赖：LedgerScriptViews 渲染排序 + runtime 无改动（不移动 iframe DOM 顺序，
  靠 React 重排——注意 React 重排会触发挂载副作用？不：挂载副作用按 scriptId 稳定，
  重排仅改变 DOM 顺序，iframe 已在各自 body 内不动）。

## V2-3. 脚本间文件共享【V2】

**目标**：多个脚本共享资源文件（如公共图标库、共同数据文件）（R2-③ 文件共享，V2 TODO ③）。

**设计**：
- 命名空间扩展：`/uploads/jsrunner/shared/<name>`（共享区）+ `assets` 支持跨脚本引用。
- ScriptMeta 增 `sharedAssets?: string[]`（引用共享区文件名）；导入时可选勾选
  「存入共享区」。
- 权限：共享文件不被单个脚本删除级联清理（所有权 = 全局）；删除需显式（JsRunnerPanel
  「共享文件管理」入口，V2）。
- 冲突：同名共享文件 = 覆盖（最后一次写入）；登记引用计数（防误删）。
- 依赖：P0 拆文件存储就绪后扩展。

## V2-4. 挂载区域扩展（顶栏/侧栏等）【V2】

**目标**：脚本面板可挂到账本 UI 之外的宿主区域（V2 TODO ④；超出「账本 UI」范围）。

**设计**：
- `LedgerPanelSpec.area` 枚举扩展：`"status" | "roster" | "left" | "top" | "right"`。
- 宿主挂载面：左侧栏（sidePanel left）、顶栏（topbar 底部工具条）、右栏——各插
  `<LedgerScriptViews area="x" />`。
- 面积/高度策略：left/right 区域面板 maxHeight 默认 0（自然高，随内容）；top 默认
  单行高自适应。
- 约束：同一脚本仍只挂一处（upsert 覆盖语义）；区域面板过多时靠面板收起兜底。
- 依赖：P2 渲染面 + 双 area 就绪后扩展（纯加挂载点 + 枚举）。

## V2-5. 面板 tab 接管视图【V2】

**目标**：脚本可完全接管账本标准视图（替换默认字段表单，V2 TODO ⑤；D3 §3.2
`position:"tab"` 预留）。

**设计**：
- `LedgerPanelSpec.position: "append" | "tab"`；`tab` 面板进入账本卡片顶部 tab 条：
  `[标准] [脚本A] [脚本B]`；默认仍「标准」。
- 标准 tab = 现有 status-card 内容；脚本 tab = 该脚本 iframe（挂载逻辑同 append）。
- tab 条状态：`ledger.activeTab`（默认 "standard"）；切换 → 标准内容/iframe 挂载切换
  （unmount 一个再 mount 另一个——复用现有 mount/unmount）。
- 约束：同一 area 至多一个 tab 面板（多个报错）；tab 面板高度不钳制（全卡片高度）。
- 依赖：P2 渲染面 + ledger 状态扩展（activeTab + tab 列表）。

## V2-6. iframe sandbox 加固【V2】

**目标**：给脚本 iframe 加 sandbox，封死「理论上可访问 parent.document」的既有风险
（V2 TODO ⑥；D3 §9 已知边界）。

**设计**：
- runtime.create：`iframe.setAttribute("sandbox", "allow-scripts")`（不加
  allow-same-origin → origin 变 opaque，parent 访问被封）。
- **兼容影响**（必须评估）：脚本 localStorage 访问会抛错（opaque origin 无 storage）；
  同源 fetch('/uploads/…') 变跨源（需服务端加 CORS 头或改经 postMessage 转发——
  V2 决策点：① 服务端 /uploads/ 加 `Access-Control-Allow-Origin: *`（对静态资源可接受）
  ② 桥注入 localStorage 代理（postMessage 到宿主存取）③ 两者都做）。
- 迁移：V1 不加固（保持现状）；V2 加固时需跑全量基准测试确认无回归，并给出
  localStorage 代理方案。
- 依赖：独立安全项，与功能无关。

## V2-7. 面板上限与性能实测【V2】

**目标**：实测多面板下的性能并决定是否设上限/虚拟化（V2 TODO ⑦⑧；R3-③ 实测指标）。

**设计**：
- 实测脚本：N 个面板（N=1/5/10/20）各渲染 1000 行内容，测：账本卡片展开耗时、
  内存占用、state 帧到达 → 全部面板重渲染的时延（ResizeObserver + iframe 常驻
  的叠加成本）。
- 指标阈值：展开耗时 < 500ms、state 帧 → 最后面板刷新 < 200ms（V2 定稿时按实测校准）。
- 若超标：方案 A 面板虚拟化（仅挂载可见面板 + 惰性挂载折叠面板）；
  方案 B 默认收起超过 N 个的后面板（提示展开）；方案 C 上限告警。
- 滚动性能：账本卡片展开区 `overflow: auto` + `.ledger-view` 内容 iframe 内滚，
  双层滚动体验实测优化（可能引入面板懒加载 iframe srcdoc 延迟）。
- 依赖：P2 渲染面 + 真实脚本生态（V1 后用户实装数据）。

---

## 7. V1/V2 交付边界总表

| 项 | 版本 | 文档位 |
|---|---|---|
| P0 拆文件存储 + JsRunnerPanel 挂载/导入导出/级联清理 | V1 | PART 1 §2.4/2.9 |
| P1 数据面（worldState + 3 事件） | V1 | PART 1 §2.2-2.4 |
| P2 渲染面（registry/mount/unmount/resize/theme/双区域/收起/占位） | V1 | PART 1 §2.1/2.4/2.7/2.10/§3 |
| P3 写面 + notify | V1 | PART 1 §2.5/2.6 |
| P4 自由键/按钮/ModalPanel/数据包 | V1 | PART 1 §2.5/2.8/2.9 |
| ext_generate handler | 独立项 | D3 §5.10 |
| 常驻基准测试双轨 | V1 | PART 1 §6 |
| zip 打包 | V2 | PART 2 V2-1 |
| 面板拖拽排序 | V2 | PART 2 V2-2 |
| 脚本间文件共享 | V2 | PART 2 V2-3 |
| 挂载区域扩展 | V2 | PART 2 V2-4 |
| tab 接管视图 | V2 | PART 2 V2-5 |
| iframe sandbox 加固 | V2 | PART 2 V2-6 |
| 面板上限/性能实测 | V2 | PART 2 V2-7 |
