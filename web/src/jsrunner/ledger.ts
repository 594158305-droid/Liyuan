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
/**
 * 面板顺序（V2-2）：scriptId 顺序数组；getPanels 按此排序，未收录的面板按注册序追加。
 * 持久化由 UI 侧负责（LedgerScriptViews 读/写 extdata global:panel-order），本模块保持
 * 零 DOM / 零网络（A5），只提供 setOrder/getOrder/move 状态机。
 */
let order: string[] = [];
/** V2-5：status 区域 tab 条当前激活项（"standard" = 标准视图，其余 = tab 面板 scriptId） */
let activeTab = "standard";
/** V2-5：tab 面板 id 缓存（status 区域 position="tab" 的面板，按 order 排序，rebuildSnapshot 重建） */
let tabIdsCache: readonly string[] = [];
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

/**
 * 全局有序 id 列表（V2-2）：order 在前，未收录的面板按注册序追加。
 * move 与持久化回灌都以「当前面板全集」为基准，避免拖拽重排漏掉新注册面板。
 */
function orderedIds(): string[] {
	const ranked = new Set(order);
	return [...order, ...[...panels.keys()].filter((id) => !ranked.has(id))];
}

/** 变更后重建快照缓存（新引用）+ 通知订阅者；同时刷新 tab 列表与激活项归一化 */
function rebuildSnapshot(): void {
	// V2-2：按 order 排序（rank 相同的保持注册序——Array.sort 稳定）
	const rank = new Map<string, number>();
	order.forEach((id, i) => rank.set(id, i));
	const entries = [...panels];
	entries.sort((a, b) => {
		const ra = rank.get(a[0]);
		const rb = rank.get(b[0]);
		if (ra === undefined && rb === undefined) return 0;
		if (ra === undefined) return 1;
		if (rb === undefined) return -1;
		return ra - rb;
	});
	panelsSnapshot = entries.map(([scriptId, entry]) => ({ scriptId, entry }));
	// V2-5：tab 面板 = status 区域 position="tab"（按全局顺序）
	tabIdsCache = panelsSnapshot
		.filter((p) => p.entry.spec.position === "tab" && (p.entry.spec.area ?? "status") === "status")
		.map((p) => p.scriptId);
	// V2-5：激活的 tab 面板被移除/改型后回落到标准视图
	if (activeTab !== "standard" && !tabIdsCache.includes(activeTab)) {
		activeTab = "standard";
	}
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
		// V2-2：从顺序数组剔除，持久化数据保持干净（activeTab 回落由 rebuildSnapshot 归一化）
		order = order.filter((id) => id !== scriptId);
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

	// ---------- V2-2：面板顺序（拖拽/键盘排序；持久化由 UI 侧读写 extdata） ----------

	/**
	 * 应用持久化顺序（初始化时 UI 读 extdata global:panel-order 后调用）：
	 * 过滤未知/重复 id；与当前 order 相同时不通知（防初始化空转）。
	 */
	setOrder(ids: readonly string[]): void {
		if (!Array.isArray(ids)) return;
		const seen = new Set<string>();
		const next: string[] = [];
		for (const id of ids) {
			if (typeof id !== "string" || seen.has(id) || !panels.has(id)) continue;
			seen.add(id);
			next.push(id);
		}
		if (next.length === order.length && next.every((id, i) => id === order[i])) return;
		order = next;
		rebuildSnapshot();
	},

	/** 当前面板顺序（UI 在 move 后读它持久化） */
	getOrder(): readonly string[] {
		return order;
	},

	/**
	 * 移动面板到「同区域面板」第 toAreaIndex 位之前（0 = 该区域最前；超出末尾 = 插到
	 * 该区域队尾）。全局 order 同步重排，其它区域面板的相对顺序保持不变——UI 拖拽/键盘
	 * 只需传「本区域容器内算出的目标序号」，无需感知跨区域排序细节。
	 */
	move(scriptId: string, toAreaIndex: number): void {
		const entry = panels.get(scriptId);
		if (!entry) return;
		const area = entry.spec.area ?? "status";
		const ids = orderedIds();
		if (!ids.includes(scriptId)) return;
		const rest = ids.filter((id) => id !== scriptId);
		// 目标位置 = rest 中第 toAreaIndex 个同区域面板之前（越界则队尾）
		const areaCount = rest.filter((id) => (panels.get(id)?.spec.area ?? "status") === area).length;
		const to = Math.max(0, Math.min(Math.round(toAreaIndex), areaCount));
		let target = rest.length;
		if (to < areaCount) {
			let seen = 0;
			for (let i = 0; i < rest.length; i++) {
				if ((panels.get(rest[i])?.spec.area ?? "status") === area) {
					if (seen === to) {
						target = i;
						break;
					}
					seen += 1;
				}
			}
		}
		rest.splice(target, 0, scriptId);
		order = rest;
		rebuildSnapshot();
	},

	// ---------- V2-5：status 区域 tab 接管（[标准] [脚本A] [脚本B]） ----------

	/** 切换 tab："standard" = 标准视图；scriptId = 该脚本 tab 面板。非法 id 忽略；同值不通知。 */
	setActiveTab(id: string): void {
		const next = id === "standard" ? "standard" : id;
		if (next !== "standard") {
			const entry = panels.get(next);
			if (
				!entry ||
				entry.spec.position !== "tab" ||
				(entry.spec.area ?? "status") !== "status"
			) {
				return;
			}
		}
		if (activeTab === next) return;
		activeTab = next;
		rebuildSnapshot();
	},

	/** 当前激活 tab（默认 "standard"；tab 面板被移除后自动回落） */
	getActiveTab(): string {
		return activeTab;
	},

	/** status 区域 tab 面板 id 列表（按全局顺序；rebuildSnapshot 缓存，返回稳定引用） */
	getTabIds(): readonly string[] {
		return tabIdsCache;
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
