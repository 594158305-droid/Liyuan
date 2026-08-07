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

	/** 全量设置脚本列表（含启停增量管理：只重建启停/content 变化的，未变的不动） */
	setScripts(list: ScriptMeta[]): void {
		const cur = [...this.runtimes].map(([id, e]) => ({ id, content: e.meta.content }));
		const plan = planScriptSync(cur, list);
		for (const id of plan.toRemove) this.destroy(id);
		for (const meta of plan.toCreate) this.create(meta);
		// toKeep 保持不动（脚本状态不丢）
	}

	/** 重建指定脚本的 iframe（销毁旧的、用内部最新 meta 重建；未运行则 no-op） */
	reload(id: string): void {
		const entry = this.runtimes.get(id);
		if (!entry) return;
		this.destroy(id);
		this.create(entry.meta);
	}

	/** 重建全部运行中脚本的 iframe */
	reloadAll(): void {
		for (const [id, entry] of [...this.runtimes]) {
			this.destroy(id);
			this.create(entry.meta);
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

	private create(meta: ScriptMeta): void {
		if (typeof document === "undefined") return; // 非浏览器环境（node 冒烟）跳过
		const iframe = document.createElement("iframe");
		iframe.style.display = "none";
		iframe.title = `jsrunner:${meta.id}`;
		iframe.setAttribute("aria-hidden", "true");
		iframe.tabIndex = -1;
		iframe.srcdoc = buildScriptSrcDoc(meta, this.bridgeJs);
		this.ensureContainer().appendChild(iframe);
		this.runtimes.set(meta.id, { iframe, ready: false, meta });
	}

	private destroy(id: string): void {
		const entry = this.runtimes.get(id);
		if (!entry) return;
		try {
			entry.iframe.remove();
		} catch {
			// 已脱离 DOM，忽略
		}
		this.runtimes.delete(id);
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
 * - hello / message：推上下文快照（F1 context.ts 已维护快照，这里只负责透传）
 * - ext_event：先推 context（同轮内 postMessage 有序，脚本回调里 getContext() 是新鲜快照）再广播事件
 */
const scriptFrameSink: WireBusSink = {
	onWireFrame(frame) {
		switch (frame.type) {
			case "hello":
			case "message":
				scriptRuntimes.pushContextToAll();
				break;
			case "ext_event":
				scriptRuntimes.pushContextToAll();
				scriptRuntimes.emitToAll(frame.name, frame.args);
				break;
			default:
				// state / ext_gen / 其它帧：不进脚本
				break;
		}
	},
};

// 注入真实桥（对已建 iframe 重注入）+ 注册帧 sink（上下文推送 / 事件广播入口）
scriptRuntimes.setBridgeJs(BRIDGE_JS);
jsrunnerBus.registerSink(scriptFrameSink);
