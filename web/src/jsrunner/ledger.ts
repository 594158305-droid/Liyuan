/**
 * JS Runner 账本面板注册中心（D4 §2.1，纯 TS，**零 DOM 依赖**——A5）。
 *
 * 脚本经 helper.registerLedgerPanel 上报面板规格（LedgerPanelSpec），宿主
 * LedgerScriptViews（useSyncExternalStore 订阅）据此渲染面板区块。本模块只维护
 * 状态机 + 订阅通知，不碰 document/window（node 无 DOM 环境可直接 import 单测）。
 *
 * 关键设计（A2 快照稳定性）：内部 Map<scriptId, LedgerEntry> + Set<listener> +
 * 快照缓存——每次变更重建 panelsSnapshot 数组（新引用）并缓存；getPanels() 直接
 * 返回缓存引用。**不变不重建**（setHeight/setReady/setModalized 值未变时提前返回），
 * 满足 useSyncExternalStore 对 getSnapshot 的引用稳定性要求，防无限重渲染。
 *
 * 额外通道：
 * - getThemeTokensFrom(doc)：读 CSS 变量供 theme 帧（注入式，调用方传 document，
 *   模块顶层不触碰 DOM——node 单测可安全 import）；
 * - toast 通道：setToastHandler 注册宿主 toast（App 侧接线），notifyToast 供 helper
 *   的 notify 方法与 bridge toastr 桩调用；
 * - manager 请求：requestManager/onManagerRequest（P4，openManager 触发宿主模态）。
 */
import type { LedgerPanelSpec } from "./types.ts";

/** 注册表条目（ledger.ts 内部状态机；D4 §2.1） */
export interface LedgerEntry {
	/** 面板注册规格（upsert 覆盖整体替换） */
	spec: LedgerPanelSpec;
	/** bridge resize 上报的 iframe 内容高度（未上报为 0） */
	height: number;
	/** 用户收起状态（V1 不做持久化） */
	collapsed: boolean;
	/** iframe ready 收到过（崩溃/未就绪占位依据） */
	ready: boolean;
	/** 面板被模态占用（P4：账本侧不挂载） */
	modalized: boolean;
}

/** getPanels 快照元素（脚本Id + 内部条目） */
export interface LedgerPanelSnapshot {
	scriptId: string;
	entry: LedgerEntry;
}

/** 宿主 toast 处理函数（级别对齐宿主 Toast.level；success 由调用方映射为 info） */
export type LedgerToastHandler = (level: "info" | "warning" | "error", text: string) => void;

/** 面板注册表：scriptId → 条目 */
const panels = new Map<string, LedgerEntry>();
/** 订阅者监听器 */
const listeners = new Set<() => void>();
/** 快照缓存：写时重建数组引用，无变更时 getPanels() 返回同一引用（A2） */
let panelsSnapshot: readonly LedgerPanelSnapshot[] = [];
/** manager 请求订阅者（P4，ModalPanel 单例） */
const managerSubs = new Set<(scriptId: string) => void>();
/** toast 处理函数（宿主注入；未注册时 notifyToast 静默） */
let toastHandler: LedgerToastHandler | null = null;
/**
 * 待应用就绪标记：bridge 的 ready 上报（setTimeout 0）可能先于脚本 module 里的
 * registerLedgerPanel（invoke）到达宿主——条目未注册时 setReady 无法落位，先记 pending，
 * upsert 创建条目时应用（冒烟修复：ready/invoke 时序竞态）。
 */
const pendingReady = new Set<string>();

/** 通知订阅者：各自 try/catch，单面板异常不能炸宿主 */
function notifyListeners(): void {
	for (const fn of [...listeners]) {
		try {
			fn();
		} catch (e) {
			console.warn("[ledger] 订阅者回调出错", e);
		}
	}
}

/** 变更后重建快照缓存（新引用）+ 通知订阅者 */
function rebuildSnapshot(): void {
	panelsSnapshot = [...panels].map(([scriptId, entry]) => ({ scriptId, entry }));
	notifyListeners();
}

/** 校验/清洗 resize 高度：非正数按 0（占位高度），小数四舍五入 */
function normalizeHeight(height: number): number {
	return typeof height === "number" && Number.isFinite(height) && height > 0
		? Math.round(height)
		: 0;
}

/** 面板注册中心（纯状态机，无 React 依赖，与 jsrunnerBus 同风格） */
export const ledger = {
	/** 注册/覆盖（脚本 invoke 入口；重复注册 = 更新 spec） */
	upsert(scriptId: string, spec: LedgerPanelSpec): void {
		if (typeof scriptId !== "string" || !scriptId) return;
		const prev = panels.get(scriptId);
		if (prev) {
			prev.spec = spec;
		} else {
			panels.set(scriptId, {
				spec,
				height: 0,
				collapsed: false,
				// 应用 ready 竞态补偿：ready 帧先于本次 upsert 到达时，条目直接就绪
				ready: pendingReady.has(scriptId),
				modalized: false,
			});
			pendingReady.delete(scriptId);
		}
		rebuildSnapshot();
	},

	/** 注销（unregisterLedgerPanel 或 destroy 调用）；不存在时 no-op 不通知 */
	remove(scriptId: string): void {
		if (!panels.delete(scriptId)) return;
		rebuildSnapshot();
	},

	/** 面板列表快照（useSyncExternalStore 的 getSnapshot；返回稳定引用，A2） */
	getPanels(): ReadonlyArray<LedgerPanelSnapshot> {
		return panelsSnapshot;
	},

	/** 订阅（React 用）；返回退订函数（幂等） */
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},

	/** bridge resize 上报入口；高度未变不通知（防 ResizeObserver 抖动刷屏） */
	setHeight(scriptId: string, height: number): void {
		const entry = panels.get(scriptId);
		if (!entry) return;
		const h = normalizeHeight(height);
		if (entry.height === h) return;
		entry.height = h;
		rebuildSnapshot();
	},

	/** 收起/展开切换（R1-②，iframe 常驻运行，收起只隐藏 body） */
	toggleCollapsed(scriptId: string): void {
		const entry = panels.get(scriptId);
		if (!entry) return;
		entry.collapsed = !entry.collapsed;
		rebuildSnapshot();
	},

	/** iframe ready 状态更新（runtime ready 时调用）；条目未注册时记 pending（竞态补偿）；值未变不通知 */
	setReady(scriptId: string, ready: boolean): void {
		const entry = panels.get(scriptId);
		if (!entry) {
			// ready 先于 registerLedgerPanel 到达：记 pending，upsert 时应用
			if (ready === true) pendingReady.add(scriptId);
			return;
		}
		const next = ready === true;
		if (entry.ready === next) return;
		entry.ready = next;
		rebuildSnapshot();
	},

	/** 面板 modalized 状态（P4：模态占用时账本侧不挂载）；值未变不通知 */
	setModalized(scriptId: string, modalized: boolean): void {
		const entry = panels.get(scriptId);
		if (!entry) return;
		const next = modalized === true;
		if (entry.modalized === next) return;
		entry.modalized = next;
		rebuildSnapshot();
	},

	/** P4：openManager 请求通道（helper.openManager → requestManager → 宿主 ModalPanel） */
	requestManager(scriptId: string): void {
		for (const cb of [...managerSubs]) {
			try {
				cb(scriptId);
			} catch (e) {
				console.warn("[ledger] manager 请求回调出错", e);
			}
		}
	},

	/** P4：订阅独立管理界面请求；返回退订函数（ModalPanel 挂载时注册） */
	onManagerRequest(cb: (scriptId: string) => void): () => void {
		managerSubs.add(cb);
		return () => {
			managerSubs.delete(cb);
		};
	},
};

/**
 * 主题 token 读取（A5：注入式，ledger 核心零 DOM——调用方传入 document）。
 * 读 documentElement 计算样式里的 CSS 变量（--surface/--text/--hairline-strong/--accent
 * /--danger/--ok/--radius/--font-size 等，按 app.css 实际变量核清单），
 * 缺失的变量跳过（脚本侧用亮色兜底）。
 */
export function getThemeTokensFrom(doc: Document): Record<string, string> {
	const style = doc.defaultView
		? doc.defaultView.getComputedStyle(doc.documentElement)
		: null;
	if (!style) return {};
	const names = [
		"surface",
		"surface-dim",
		"surface-deep",
		"text",
		"text-strong",
		"text-soft",
		"text-faint",
		"hairline",
		"hairline-strong",
		"accent",
		"accent-strong",
		"accent-bright",
		"accent-wash",
		"accent-wash-strong",
		"ok",
		"danger",
		"radius",
		"radius-s",
		"radius-l",
		"font-size",
	];
	const tokens: Record<string, string> = {};
	for (const name of names) {
		const value = style.getPropertyValue(`--${name}`).trim();
		if (value) tokens[name] = value;
	}
	return tokens;
}

// ---------- toast 通道（模块级注册，helper/bridge 用；宿主 App 侧接线） ----------

/** 注册宿主 toast 处理函数（传 null 清空；后注册覆盖） */
export function setToastHandler(fn: LedgerToastHandler | null): void {
	toastHandler = fn;
}

/** 通知（level 白名单由调用方校验；未注册 handler 时静默丢弃） */
export function notifyToast(level: "info" | "warning" | "error", text: string): void {
	toastHandler?.(level, text);
}
