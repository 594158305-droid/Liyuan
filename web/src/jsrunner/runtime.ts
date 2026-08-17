/**
 * JS Runner 脚本运行时管理器（M3a，单例）。
 *
 * 每个 enabled 脚本一个隐藏 <iframe>（display:none，srcdoc=buildScriptSrcDoc(meta, bridgeJs)），
 * 挂到 document.body 下固定容器 `#jsrunner-host`。脚本在帧内跑（window.TavernHelper.* /
 * getContext() / $ / YAML 等由 M3b 桥注入），通过 postMessage 与宿主通信。
 *
 * 消息路由（只接受已知 iframe 的 event.source）：
 * - ready      → 标记该 iframe 就绪（此后可投递事件）
 * - log        → host.onLog
 * - invoke     → host.onInvoke，结果以 invoke-result postMessage 回该 iframe
 * - event      → host.onEvent
 * - resize     → ledger.setHeight（面板容器高度）
 * - storage    → 脚本 localStorage 代理落盘（V2-6 sandbox 加固：桥内内存副本 + 异步落宿主）
 * 宿主推事件：emitToScript(scriptId, name, args)（M3b 从 jsrunnerBus 桥接）。
 *
 * M3b 接线（模块加载时执行，helper.ts → runtime.ts 依赖链触发）：
 * - setBridgeJs(BRIDGE_JS)：注入真实 TavernHelper/getContext 桥（含对已建 iframe 重注入）
 * - jsrunnerBus.registerSink：hello/message 帧 → 推送 {kind:"context"} 快照给全部脚本；
 *   ext_event 帧 → 先推 context 再广播事件（脚本回调里 getContext() 是新鲜快照）
 * - 脚本上报 ready 时立即补发一次最新快照（新脚本不用等下一帧 hello/message）
 * - G1：脚本 emit 的事件（eventSource.emit / eventEmit）→ 广播给「其它」脚本
 *   （emitToAllExcept 排除来源，防回环重复触发；来源在桥内已本地触发）
 *
 * 纯 TS 模块 + 单例导出：App 不持有，M4 UI 直接 import scriptRuntimes。
 */
import { buildScriptSrcDoc, MINIMAL_BRIDGE_JS } from "./frame.ts";
import { planScriptSync } from "./plan.ts";
import { jsrunnerBus, type WireBusSink } from "./bus.ts";
import { BRIDGE_JS, getContextSnapshot } from "./bridge.ts";
import { mapFrameToScriptEvents } from "./events.ts";
import { getThemeTokensFrom, ledger } from "./ledger.ts";
import type { HostMessage, RuntimeHost, ScriptMeta, ScriptRequest } from "./types.ts";

/** 单脚本运行时条目 */
interface ScriptEntry {
	iframe: HTMLIFrameElement;
	/** ready 收到过（脚本桥初始化完成，才可投递事件） */
	ready: boolean;
	meta: ScriptMeta;
}

/** 宿主容器 id：全部脚本 iframe 的父节点 */
const HOST_ID = "jsrunner-host";

export class ScriptRuntimes {
	private host: RuntimeHost | null = null;
	/** 桥源码（M3b 注入真实 TavernHelper/getContext 桥；本任务用最小占位） */
	private bridgeJs = MINIMAL_BRIDGE_JS;
	private runtimes = new Map<string, ScriptEntry>();
	private listenerAttached = false;
	/** 当前应运行的脚本 id 集（setScripts 维护）：异步 create 完成后据此放弃已停用/已删除的脚本 */
	private desiredIds = new Set<string>();
	/** 进行中的异步 create 序号令牌：destroy / 新 create 会使旧 fetch 结果失效，不建陈旧 iframe */
	private createTokens = new Map<string, number>();
	private createSeq = 0;

	constructor() {
		// 浏览器外（node 冒烟等）不挂监听
		if (typeof window !== "undefined") {
			window.addEventListener("message", this.onMessage);
			this.listenerAttached = true;
		}
	}

	/** 注册宿主分发器（M3b 传入实现；传 null 则清空） */
	setHost(host: RuntimeHost | null): void {
		this.host = host;
	}

	/**
	 * M3b 注入真实桥源码后重建全部脚本帧（桥是运行时核心，不能只对新建帧生效）。
	 * 空串/纯空白忽略。
	 */
	setBridgeJs(js: string): void {
		if (typeof js !== "string" || !js.trim()) return;
		this.bridgeJs = js;
		this.reloadAll();
	}

	/** 全量设置脚本列表（含启停增量管理：只重建启停/脚本引用（file/content）变化的，未变的不动） */
	setScripts(list: ScriptMeta[]): void {
		// 期望运行集：停用/删除的脚本即使有 fetch 在途也不得建帧
		this.desiredIds = new Set(list.filter((m) => m.enabled).map((m) => m.id));
		const cur = [...this.runtimes].map(([id, e]) => ({ id, key: e.meta.file ?? e.meta.content ?? "" }));
		const plan = planScriptSync(cur, list);
		for (const id of plan.toRemove) this.destroy(id);
		for (const meta of plan.toCreate) void this.create(meta);
		// toKeep 保持不动（脚本状态不丢）
	}

	/** 重建指定脚本的 iframe（销毁旧的、用内部最新 meta 重建；未运行则 no-op） */
	reload(id: string): void {
		const entry = this.runtimes.get(id);
		if (!entry) return;
		this.destroy(id);
		void this.create(entry.meta);
	}

	/** 重建全部运行中脚本的 iframe */
	reloadAll(): void {
		for (const [id, entry] of [...this.runtimes]) {
			this.destroy(id);
			void this.create(entry.meta);
		}
	}

	/** 销毁全部 iframe + 移除宿主容器 + 摘掉 window 监听 */
	dispose(): void {
		if (this.listenerAttached && typeof window !== "undefined") {
			window.removeEventListener("message", this.onMessage);
			this.listenerAttached = false;
		}
		for (const id of [...this.runtimes.keys()]) this.destroy(id);
		if (typeof document !== "undefined") {
			document.getElementById(HOST_ID)?.remove();
		}
	}

	isRunning(id: string): boolean {
		return this.runtimes.has(id);
	}

	runningIds(): string[] {
		return [...this.runtimes.keys()];
	}

	/** 读运行中脚本的元信息（helper getScriptName/getScriptInfo 用；未运行返回 undefined） */
	getMeta(id: string): ScriptMeta | undefined {
		return this.runtimes.get(id)?.meta;
	}

	/**
	 * 事件推入：对就绪 iframe postMessage HostMessage.event（公开方法，M3b 从 bus 桥接）。
	 * 未运行 / 未 ready 的脚本静默忽略。
	 */
	emitToScript(scriptId: string, name: string, args: unknown[]): void {
		const entry = this.runtimes.get(scriptId);
		if (!entry || !entry.ready) return;
		const msg: HostMessage = { kind: "event", name, args };
		entry.iframe.contentWindow?.postMessage(msg, "*");
	}

	/**
	 * 向全部运行中脚本广播事件（内部按 ready 过滤；iframe 内再按本地注册过滤）。
	 * M3b 从 bus sink 的 ext_event 帧调用。
	 */
	emitToAll(name: string, args: unknown[]): void {
		for (const id of this.runtimes.keys()) this.emitToScript(id, name, args);
	}

	/**
	 * 向「除来源外」的运行中脚本广播事件（G1 事件回环排除）。
	 * 脚本 eventSource.emit / eventEmit → 宿主 onEvent → 本方法把事件转给其它脚本；
	 * 来源脚本已在桥内本地触发过一次，再广播回去会造成重复触发（回环）。
	 */
	emitToAllExcept(sourceScriptId: string, name: string, args: unknown[]): void {
		for (const id of this.runtimes.keys()) {
			if (id === sourceScriptId) continue;
			this.emitToScript(id, name, args);
		}
	}

	/**
	 * G3：按名调用某脚本内 registerScriptAction 注册的动作函数（带参）。
	 * 未运行 / 未 ready / 桥未就绪的脚本静默忽略（无动作表也无回调，安全）。
	 * 面板按钮（ScriptMeta.buttons 带 action）与程序化触发共用此入口。
	 */
	invokeAction(scriptId: string, name: string, args: unknown[]): void {
		const entry = this.runtimes.get(scriptId);
		if (!entry || !entry.ready) return;
		const msg: HostMessage = { kind: "action", name, args };
		entry.iframe.contentWindow?.postMessage(msg, "*");
	}

	/**
	 * G3：匹配名称触发动作。名字匹配规则：完全匹配脚本 id/name，或 `<id>:<action>`；
	 * 命中的脚本按 action（缺省 name 的按钮用按钮名）调用。返回命中数（未命中返回 0）。
	 * 供面板/未来命令入口遍历调用（脚本名可重复，故遍历而非单点）。
	 */
	invokeActionByScriptMatch(scriptRef: string, action: string, args: unknown[]): number {
		const ref = String(scriptRef ?? "");
		let hits = 0;
		for (const [id, entry] of this.runtimes) {
			if (!entry.ready) continue;
			const meta = entry.meta;
			const idMatch = id === ref;
			const nameMatch = meta && (meta.name === ref || `${meta.name}:${action}` === ref);
			if (!idMatch && !nameMatch) continue;
			this.invokeAction(id, action, args);
			hits++;
		}
		return hits;
	}

	/**
	 * 向全部就绪 iframe 推送最新上下文快照（{kind:"context"}）。
	 * attachContextProvider 未注册（F1 未接）时返回 null 跳过推送——不炸。
	 * M3b 在 hello/message 帧、ext_event 帧（先推 context）与脚本 ready 时调用。
	 */
	pushContextToAll(): void {
		const snapshot = getContextSnapshot();
		if (!snapshot) return;
		const msg: HostMessage = { kind: "context", snapshot };
		for (const [id, entry] of this.runtimes) {
			if (!entry.ready) continue;
			try {
				entry.iframe.contentWindow?.postMessage(msg, "*");
			} catch (e) {
				console.warn("[jsrunner] context 推送失败", id, e);
			}
		}
	}

	// ---------- 面板可见化挂载（D4 §2.4：同一 contentWindow，不重载） ----------

	/**
	 * 把脚本 iframe 可见化挂进宿主容器（同一 contentWindow，脚本状态完整保留）。
	 * 挂载时补推主题 token（bridge 接收即应用，脚本 var(--ly-*) 即时生效）。
	 */
	mount(scriptId: string, container: HTMLElement): void {
		const entry = this.runtimes.get(scriptId);
		if (!entry) return;
		container.appendChild(entry.iframe);
		entry.iframe.style.display = "";
		entry.iframe.removeAttribute("aria-hidden");
		entry.iframe.tabIndex = 0;
		this.postThemeTo(entry.iframe);
	}

	/** 移回 #jsrunner-host 隐藏容器，恢复隐藏态（面板收起/模态关闭/区域切换用） */
	unmount(scriptId: string): void {
		const entry = this.runtimes.get(scriptId);
		if (!entry) return;
		entry.iframe.style.display = "none";
		entry.iframe.setAttribute("aria-hidden", "true");
		entry.iframe.tabIndex = -1;
		if (typeof document !== "undefined") {
			document.getElementById(HOST_ID)?.appendChild(entry.iframe);
		}
	}

	/** 向全部运行中脚本广播主题（A7：App 主题切换处调用；未挂载的也推，bridge 接收即应用） */
	broadcastTheme(): void {
		if (typeof document === "undefined") return;
		const tokens = getThemeTokensFrom(document);
		for (const [, entry] of this.runtimes) {
			entry.iframe.contentWindow?.postMessage({ kind: "theme", tokens }, "*");
		}
	}

	/** 向单帧推主题（内部；theme 帧封装，A5：注入式读 CSS 变量） */
	private postThemeTo(iframe: HTMLIFrameElement): void {
		if (typeof document === "undefined") return;
		iframe.contentWindow?.postMessage(
			{ kind: "theme", tokens: getThemeTokensFrom(document) },
			"*",
		);
	}

	// ---------- V2-6 sandbox 加固：localStorage 代理的宿主侧 ----------

	/**
	 * 收集「脚本可读」的宿主 localStorage 快照（storage-snapshot 帧载荷）。
	 * 排除 Liyuan 应用自用键（`liyuan.` 前缀：面板布局/主题/排序等，保持宿主状态私有）；
	 * 其余键打包给脚本桥——脚本经代理写入的键会落宿主 localStorage，刷新后经快照恢复。
	 * 快照用完后局部变量即释放（postMessage 深拷贝），不长期驻留宿主内存。
	 */
	private collectScriptStorage(): Record<string, string> {
		if (typeof localStorage === "undefined") return {};
		const data: Record<string, string> = {};
		try {
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i);
				if (!key || key.startsWith("liyuan.")) continue;
				const value = localStorage.getItem(key);
				if (value !== null) data[key] = value;
			}
		} catch (e) {
			console.warn("[jsrunner] 读取 localStorage 快照失败", e);
		}
		return data;
	}

	/** 向单帧推送脚本可读 localStorage 快照（storage-snapshot 帧；桥覆盖式刷新内存副本） */
	private postStorageSnapshot(iframe: HTMLIFrameElement): void {
		iframe.contentWindow?.postMessage(
			{ kind: "storage-snapshot", data: this.collectScriptStorage() },
			"*",
		);
	}

	// ---------- 内部 ----------

	private ensureContainer(): HTMLDivElement {
		const doc = document;
		const existing = doc.getElementById(HOST_ID);
		if (existing) return existing as HTMLDivElement;
		const div = doc.createElement("div");
		div.id = HOST_ID;
		div.style.display = "none";
		doc.body.appendChild(div);
		return div;
	}

	/**
	 * 建脚本 iframe（P0 拆文件存储：D4 §2.4）。
	 * - meta.content 存在 → 同步内联（迁移兼容）；
	 * - 否则 meta.file 存在 → fetch('/uploads/jsrunner/<file>') 拉文本后组装；
	 *   失败（404/网络）→ console.warn + **不建 iframe**（面板占位由 LedgerScriptViews
	 *   依据 ledger 条目 ready=false 渲染「脚本文件缺失」）；
	 * - 两者皆无 → 不建（静默）。
	 * 异步护栏：destroy / 后续 create 会使本次 fetch 结果失效（createTokens 令牌比对），
	 * 避免迟到的 fetch 为已删除/已更新的脚本建陈旧 iframe。
	 */
	private async create(meta: ScriptMeta): Promise<void> {
		if (typeof document === "undefined") return; // 非浏览器环境（node 冒烟）跳过
		const token = ++this.createSeq;
		this.createTokens.set(meta.id, token);

		let content: string | undefined = meta.content;
		if (content === undefined && meta.file) {
			// file 兼容两种登记形态：完整可访问路径（/uploads/...，UI 侧 uploadRef 换算）或
			// jsrunner 子目录文件名（/uploads/jsrunner/<file>，D4 §2.2 约定）
			const url = meta.file.startsWith("/") ? meta.file : `/uploads/jsrunner/${meta.file}`;
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				content = await res.text();
			} catch (e) {
				console.warn("[jsrunner] 脚本文件拉取失败（不建 iframe，面板待占位）", meta.id, url, e);
				return;
			}
		}
		if (typeof content !== "string") return;
		// 已被 destroy / 更新的 create 覆盖，或脚本已停用/删除：放弃本次建帧
		if (!this.desiredIds.has(meta.id) || this.createTokens.get(meta.id) !== token) return;

		const iframe = document.createElement("iframe");
		iframe.style.display = "none";
		iframe.title = `jsrunner:${meta.id}`;
		iframe.setAttribute("aria-hidden", "true");
		iframe.tabIndex = -1;
		// V2-6 sandbox 加固（D4 V2-6）：allow-scripts 但**不加** allow-same-origin → 帧 origin 变
		// opaque，脚本无法访问 parent.document；localStorage 随之不可用——由桥内代理（内存副本 +
		// postMessage 落宿主）承接。桥与宿主通信走 postMessage，不受 sandbox 影响；
		// fetch('/uploads/…') 因跨源需要 CORS（server /uploads/ 已加 Access-Control-Allow-Origin: *）。
		// 2026-08-09 用户裁决（开放性优先，见 AGENTS.md 产品红线）：放开 allow-same-origin——
		// 脚本可访问 parent.document 直操宿主 DOM（瑟瑟状态栏 bundle 直操宿主 UI 所需）。
		iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
		// 初始 context 同步注入（D4 冒烟修复）：脚本顶层 getContext() 即有值
		iframe.srcdoc = buildScriptSrcDoc({ ...meta, content }, this.bridgeJs, getContextSnapshot());
		this.ensureContainer().appendChild(iframe);
		// 建帧即推送脚本可读 localStorage 快照（桥内内存副本初始化源；ready 时再补推一次保证到位）
		this.postStorageSnapshot(iframe);
		this.runtimes.set(meta.id, { iframe, ready: false, meta });
	}

	private destroy(id: string): void {
		const entry = this.runtimes.get(id);
		// 使进行中的异步 create 失效（fetch 回来后不再建帧）；已停用/删除脚本一并清出期望集
		this.createTokens.delete(id);
		this.desiredIds.delete(id);
		if (!entry) return;
		// 2026-08-09 用户裁决（开放性优先）：脚本直操宿主 DOM——destroy 前调用脚本注册的
		// 宿主清理钩子（__lyHostCleanup），移除宿主页面注入的骨架/样式/脚本，避免停用后 UI 残留。
		try {
			(window as unknown as { __lyHostCleanup?: () => void }).__lyHostCleanup?.();
		} catch (e) {
			console.warn("[jsrunner] 宿主清理钩子调用失败", e);
		}
		try {
			entry.iframe.remove();
		} catch {
			// 已脱离 DOM，忽略
		}
		this.runtimes.delete(id);
		// 面板注册表联动清理（D4 §2.4：脚本停用/删除 → 面板消失）
		ledger.remove(id);
	}

	/** window message 入口：只接受已知脚本 iframe 的 event.source，按 ScriptRequest 路由 */
	private onMessage = (ev: MessageEvent): void => {
		const data = ev.data as ScriptRequest | null;
		if (!data || typeof data !== "object" || typeof data.kind !== "string") return;

		// 来源校验：srcdoc 帧 origin 是 opaque "null"，event.source === contentWindow 才是权威判断
		let entry: ScriptEntry | null = null;
		let scriptId = "";
		for (const [id, e] of this.runtimes) {
			if (e.iframe.contentWindow === ev.source) {
				entry = e;
				scriptId = id;
				break;
			}
		}
		if (!entry) return;

		switch (data.kind) {
			case "ready": {
				entry.ready = true;
				// 面板就绪标记（LedgerScriptViews 依据 ready 决定挂载/占位）
				ledger.setReady(scriptId, true);
				// V2-6：ready 时补推 localStorage 快照（建帧时的推送在 iframe 加载完成前发出，
				// 可能被早到的消息时序覆盖——这里保证桥内内存副本最终到位）
				this.postStorageSnapshot(entry.iframe);
				// 新就绪脚本立即补发一次最新快照：否则要等下一帧 hello/message 才拿得到 context
				const snapshot = getContextSnapshot();
				if (snapshot) {
					const msg: HostMessage = { kind: "context", snapshot };
					try {
						entry.iframe.contentWindow?.postMessage(msg, "*");
					} catch (e) {
						console.warn("[jsrunner] ready 补发 context 失败", scriptId, e);
					}
				}
				return;
			}
			case "resize": {
				// bridge ResizeObserver 上报 → 面板容器高度（面板未注册时 ledger 静默忽略）
				ledger.setHeight(scriptId, data.height);
				return;
			}
			case "storage": {
				// V2-6：脚本 localStorage 代理落盘（桥内内存副本 + 异步落宿主真实 localStorage）。
				// op="get" 是协议完备面（桥内 getItem 走缓存同步读，通常不发 get）；
				// key="*" 表示请求全量脚本可读快照，经 invoke-result 通道回执。
				try {
					switch (data.op) {
						case "set":
							localStorage.setItem(data.key ?? "", data.value ?? "");
							break;
						case "remove":
							localStorage.removeItem(data.key ?? "");
							break;
						case "clear":
							localStorage.clear();
							break;
						case "get": {
							const value = data.key === "*"
								? this.collectScriptStorage()
								: localStorage.getItem(data.key ?? "");
							entry.iframe.contentWindow?.postMessage(
								{ kind: "invoke-result", callId: data.callId ?? "", ok: true, value },
								"*",
							);
							break;
						}
					}
				} catch (e) {
					console.warn("[jsrunner] storage 代理落盘失败", scriptId, e);
				}
				return;
			}
			case "log": {
				this.host?.onLog(scriptId, data.level, data.args);
				return;
			}
			case "invoke": {
				const { callId, method, args } = data;
				// 捕获发起时的 contentWindow：若 invoke 未决期间该 iframe 被重建，
				// 回执仍发给旧帧（不会错发给新帧）
				const target = entry.iframe.contentWindow;
				const send = (msg: HostMessage): void => {
					try {
						target?.postMessage(msg, "*");
					} catch (e) {
						console.warn("[jsrunner] invoke 回执发送失败", callId, e);
					}
				};
				if (!this.host) {
					send({ kind: "invoke-result", callId, ok: false, error: "宿主 RuntimeHost 未注册" });
					return;
				}
				void this.host
					.onInvoke(scriptId, method, args)
					.then(
						(value) => send({ kind: "invoke-result", callId, ok: true, value }),
						(err) =>
							send({
								kind: "invoke-result",
								callId,
								ok: false,
								error: err instanceof Error ? err.message : String(err),
							}),
					);
				return;
			}
			case "event": {
				// G1 回环结论（读 bus.ts / helper.ts 后确认）：脚本 emit → host.onEvent → emitExt
				// 只到宿主侧 onExt 订阅者，原本不广播回 iframe——无回环但也没有跨脚本投递。
				// 为了让 eventSource.emit 到达其它脚本：这里广播给「其它」脚本（排除来源，
				// 来源在桥内已本地触发一次，再广播=重复触发）。
				this.host?.onEvent(scriptId, data.name, data.args);
				this.emitToAllExcept(scriptId, data.name, data.args);
				return;
			}
			default:
				console.warn("[jsrunner] 未知脚本请求 kind", (data as { kind: string }).kind);
		}
	};
}

/** 全局单例（App 不持有；M4 UI / M3b bus 桥直接 import） */
export const scriptRuntimes = new ScriptRuntimes();

// ---------- M3b 接线（模块加载即生效） ----------

/**
 * 帧 sink（jsrunnerBus）：把宿主帧桥进脚本 iframe。
 * - hello/message/state：先推上下文快照（F1 context.ts 已维护快照，这里只负责透传；
 *   同轮内 postMessage 有序，脚本回调里 getContext() 是新鲜快照），再投影事件
 *   （D4 §5.2：state→WORLD_STATE_CHANGED、message(非user)→MESSAGE_RECEIVED、
 *   agent(end)→GENERATION_ENDED；投影逻辑在 events.ts 纯模块，node 可直测）
 * - ext_event：先推 context 再广播事件（M3b 既有行为）
 */
const scriptFrameSink: WireBusSink = {
	onWireFrame(frame) {
		// 数据帧（hello/message/state）与事件帧（ext_event）都需要先推 context
		if (
			frame.type === "hello" ||
			frame.type === "message" ||
			frame.type === "state" ||
			frame.type === "ext_event"
		) {
			scriptRuntimes.pushContextToAll();
		}
		for (const ev of mapFrameToScriptEvents(frame)) {
			scriptRuntimes.emitToAll(ev.name, ev.args);
		}
	},
};

// 注入真实桥（对已建 iframe 重注入）+ 注册帧 sink（上下文推送 / 事件广播入口）
scriptRuntimes.setBridgeJs(BRIDGE_JS);
jsrunnerBus.registerSink(scriptFrameSink);
