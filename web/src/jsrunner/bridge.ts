/**
 * JS Runner 脚本 iframe 桥源码生成 + 上下文提供者入口（M3b）。
 *
 * BRIDGE_JS 是一段自包含 IIFE 源码字符串，运行时拼进 buildScriptSrcDoc 的 bridge 槽位，
 * 在脚本 iframe 内执行。它不能 import 任何宿主模块（纯字符串注入），因此所有依赖都内联
 * 在字符串里（const / function 完整自包含）。关键能力：
 *  - TavernHelper（Proxy）：方法经 postMessage 调宿主 onInvoke，返回 Promise；
 *    数据型属性（events/settings/state）与 Symbol/`then` 读取返回 undefined，不炸
 *  - getContext() / getCurrentChatId() / substituteParams() 等同步桩
 *  - eventOn / eventOnce / eventEmit / eventOff 本地事件桥（事件由宿主 {kind:"event"} 帧推进）
 *  - window.SillyTavern 适配面（G1）：惰性扁平快照 getter（每次访问重建 {...getContext(), 成员}）
 *    + 活事件总线 eventSource（复用本地注册表；emit=本地触发+转发宿主，宿主广播给其它脚本）
 *    + eventTypes 常量表 + stopGeneration/deleteLastMessage/setChatMessages/updateChatMetadata 等
 *  - console.log / warn / error 代理（原调用 + 透传宿主 log，不可序列化参数 String 化）
 *  - invoke Promise 通道（宿主 invoke-result 回执配对）
 *  - 顶层抛错 / Promise 未捕获 → 透传宿主 log（error 监听，不炸桥）
 *  - 脚本本体同步执行完后再上报 ready
 *
 * 约束：
 *  - 字符串会被 frame.ts 的 escapeInlineScript 转义后注入 <script>，内部禁止字面 `</script`；
 *  - 整段不含反引号与 `${`，保证外层模板字符串安全；
 *  - 不注入任何 jQuery 相关（vendor 已在帧里注入全局 $/jQuery）。
 *
 * 宿主侧配套（同一文件导出）：
 *  - attachContextProvider(fn)：F1 context.ts 在模块加载时把 buildSnapshot 注册进来；
 *  - getContextSnapshot()：runtime 推送 {kind:"context"} 帧前取最新快照（未注册时返回 null，跳过推送）。
 */
import type { ContextSnapshot } from "./types.ts";

/** F1 context.ts 注册的上下文快照提供者；未注册时 runtime 跳过 context 推送（不炸） */
let contextProvider: (() => ContextSnapshot) | null = null;

/**
 * 注册上下文快照提供者（F1 context.ts 在模块加载时调用，把 buildSnapshot 接进来）。
 * 可重复注册（后注册覆盖）；传非函数忽略。
 */
export function attachContextProvider(fn: () => ContextSnapshot): void {
	if (typeof fn === "function") contextProvider = fn;
}

/** 取最新上下文快照；未注册 provider 时返回 null（调用方跳过推送） */
export function getContextSnapshot(): ContextSnapshot | null {
	return contextProvider ? contextProvider() : null;
}

/**
 * 注入脚本 iframe 的桥源码（自包含 IIFE 字符串）。
 */
export const BRIDGE_JS = `(function () {
	"use strict";

	// ---------- postMessage 工具 ----------
	const post = (msg) => {
		try {
			parent.postMessage(msg, "*");
		} catch (_) {
			// 结构克隆失败等：静默忽略，避免炸桥
		}
	};

	// ---------- invoke 通道（宿主 onInvoke，invoke-result 回执配对）----------
	let callSeq = 0;
	const pending = new Map();
	function invoke(method, args) {
		const callId = "c" + ++callSeq + "-" + Date.now();
		return new Promise((resolve, reject) => {
			pending.set(callId, { resolve, reject });
			try {
				post({ kind: "invoke", method, args: args || [], callId });
			} catch (e) {
				pending.delete(callId);
				reject(e);
			}
		});
	}

	// ---------- 本地状态 ----------
	const listeners = new Map(); // 事件名 -> Set<回调>
	// 初始快照（D4 冒烟修复）：frame.ts 建帧时把当前 context 同步注入 __INITIAL_CTX__，
	// 脚本 body 顶层同步 getContext() 即有值（ready 补发是异步 postMessage，等不到）。
	// 宿主后续 {kind:"context"} 帧覆盖为最新。
	let ctxSnapshot =
		typeof window.__INITIAL_CTX__ !== "undefined" && window.__INITIAL_CTX__
			? window.__INITIAL_CTX__
			: null;

	function safeCall(cb, args) {
		try {
			cb.apply(null, args);
		} catch (e) {
			post({ kind: "log", level: "error", args: [e] });
		}
	}

	// ---------- console 代理：原调用 + 透传宿主 log ----------
	(() => {
		const orig = {
			log: console.log.bind(console),
			warn: console.warn.bind(console),
			error: console.error.bind(console),
		};
		const makeProxy = (level) =>
			function () {
				const args = Array.prototype.slice.call(arguments);
				orig[level].apply(console, args);
				let safe;
				try {
					JSON.stringify(args); // 可 JSON 序列化 → 视为可结构化克隆
					safe = args;
				} catch (_) {
					safe = args.map((a) => String(a)); // 函数/循环引用等 → String 化
				}
				post({ kind: "log", level, args: safe });
			};
		console.log = makeProxy("log");
		console.warn = makeProxy("warn");
		console.error = makeProxy("error");
	})();

	// ---------- 同步便捷：getContext / getCurrentChatId / substituteParams ----------
	function getContext() {
		return ctxSnapshot || {};
	}
	window.getContext = getContext;
	// 当前会话 id（无快照 / 无会话时为 null）
	window.getCurrentChatId = () => (ctxSnapshot && ctxSnapshot.currentChatId) || null;
	// Liyuan 宏在后端处理，桩原样透传
	window.substituteParams = (s) => s;

	// ---------- 事件桥（宿主经 {kind:"event"} 帧推进；本地按名字注册过滤）----------
	function eventOn(name, cb) {
		if (typeof cb !== "function") return () => {};
		let set = listeners.get(name);
		if (!set) {
			set = new Set();
			listeners.set(name, set);
		}
		set.add(cb);
		return () => eventOff(name, cb); // 兼容 ST：返回退订函数
	}
	function eventOnce(name, cb) {
		const wrapper = function () {
			eventOff(name, wrapper);
			return cb.apply(null, arguments);
		};
		return eventOn(name, wrapper);
	}
	function eventEmit(name) {
		const args = Array.prototype.slice.call(arguments, 1);
		post({ kind: "event", name, args }); // 宿主再广播总线
	}
	function eventOff(name, cb) {
		const set = listeners.get(name);
		if (!set) return;
		set.delete(cb);
		if (set.size === 0) listeners.delete(name);
	}
	function dispatchEvent(name, args) {
		const set = listeners.get(name);
		if (!set || set.size === 0) return;
		const cbs = Array.prototype.slice.call(set);
		for (const cb of cbs) safeCall(cb, args || []);
	}

	// ---------- 顶层全局事件 API（jsrunner-port.md §4.2 声明；ST 生态脚本顶层调用） ----------
	window.eventOn = eventOn;
	window.eventOnce = eventOnce;
	window.eventOff = eventOff;
	window.eventEmit = eventEmit;

	// ---------- SillyTavern 适配面（G1）：活事件总线 + 惰性扁平快照 getter ----------
	// 事件常量表：与 server/script-events.ts 的映射名对齐（CHAT_CHANGED / GENERATION_* /
	// MESSAGE_SENT / MESSAGE_RECEIVED），并抄录 ST 脚本常用的其余标准事件名。
	const EVENT_TYPES = {
		APP_READY: "APP_READY",
		CHAT_CHANGED: "CHAT_CHANGED",
		CHAT_COMPLETION_SETTINGS_READY: "CHAT_COMPLETION_SETTINGS_READY",
		CHAT_COMPLETION_SETTINGS_UPDATED: "CHAT_COMPLETION_SETTINGS_UPDATED",
		CHAT_COMPLETION_STARTED: "CHAT_COMPLETION_STARTED",
		CHARACTER_EDITED: "CHARACTER_EDITED",
		CHARACTER_DELETED: "CHARACTER_DELETED",
		CHARACTER_GROUP_UPDATED: "CHARACTER_GROUP_UPDATED",
		CONNECTION_STATUS_CHANGED: "CONNECTION_STATUS_CHANGED",
		EXTRAS_CONNECTED: "EXTRAS_CONNECTED",
		EXTRAS_DISCONNECTED: "EXTRAS_DISCONNECTED",
		GENERATION_STARTED: "GENERATION_STARTED",
		GENERATION_ENDED: "GENERATION_ENDED",
		GENERATION_STOPPED: "GENERATION_STOPPED",
		GENERATION_AFTER_COMMANDS: "GENERATION_AFTER_COMMANDS",
		GENERATE_AFTER_DATA: "GENERATE_AFTER_DATA",
		IMPERSONATE_READY: "IMPERSONATE_READY",
		IMPERSONATE_STARTED: "IMPERSONATE_STARTED",
		IMPERSONATE_STOPPED: "IMPERSONATE_STOPPED",
		LEDGER_BUTTON_CLICKED: "LEDGER_BUTTON_CLICKED",
		MESSAGE_SENT: "MESSAGE_SENT",
		MESSAGE_RECEIVED: "MESSAGE_RECEIVED",
		MESSAGE_EDITED: "MESSAGE_EDITED",
		MESSAGE_UPDATED: "MESSAGE_UPDATED",
		MESSAGE_DELETED: "MESSAGE_DELETED",
		MESSAGE_SWIPED: "MESSAGE_SWIPED",
		ONLINE_STATUS_CHANGED: "ONLINE_STATUS_CHANGED",
		SETTINGS_UPDATED: "SETTINGS_UPDATED",
		USER_ALLY_CHANGED: "USER_ALLY_CHANGED",
		USER_MESSAGE_RECEIVED: "USER_MESSAGE_RECEIVED",
		WORLD_INFO_ACTIVATED: "WORLD_INFO_ACTIVATED",
		WORLD_INFO_ACTIVATED_KEYS: "WORLD_INFO_ACTIVATED_KEYS",
		WORLD_STATE_CHANGED: "WORLD_STATE_CHANGED",
	};

	// 活事件总线：复用本地 listeners 注册表（与 TavernHelper.eventOn 同一套注册表——同一 iframe
	// 内两种 API 订阅互见，避免 ST 脚本与 JS-Runner 脚本各挂一份回调）。
	// emit = 本地触发 + 转发宿主；宿主 runtime 广播给「其它」脚本（排除来源，防回环重复触发）。
	const eventSource = {
		on: eventOn,
		once: eventOnce,
		makeFirst: function () {}, // 顺序控制无对等，no-op 桩
		makeLast: function () {}, // 同上
		emit: function (name) {
			const args = Array.prototype.slice.call(arguments, 1);
			dispatchEvent(name, args); // 本地注册回调
			post({ kind: "event", name, args }); // 转发宿主（广播其它 iframe）
		},
		emitAndWait: function (name) {
			// 简化实现：多数脚本 fire-and-forget；同步触发后立即 resolve
			eventSource.emit.apply(null, arguments);
			return Promise.resolve();
		},
		removeListener: eventOff,
	};

	// fire-and-forget invoke：宿主未注册该 invoke 方法时回执 error，这里吞掉并记日志，不炸桥
	function fireInvoke(method, args) {
		return invoke(method, args || []).catch(function (e) {
			post({ kind: "log", level: "error", args: ["SillyTavern." + method + " 宿主未实现", e] });
			return undefined;
		});
	}

	// SillyTavern 面成员（getContext() 快照没有的在此补充；eventSource 是活引用，非常量快照）
	const StExtras = {
		eventSource: eventSource,
		eventTypes: EVENT_TYPES,
		stopGeneration: function () {
			return fireInvoke("stopGeneration", []);
		},
		deleteLastMessage: function () {
			return invoke("deleteMessage", []);
		},
		setChatMessages: function (msgs, opts) {
			return fireInvoke("setMessages", [msgs, opts]);
		},
		getRequestHeaders: function () {
			return {};
		},
		getWorldBooks: function () {
			return [];
		},
		// 聊天由服务端自动持久化，宿主无 saveChat 对等，no-op 防脚本炸
		saveChat: function () {},
		// 契约（types.ts）：extensionSettings 经 saveSettingsDebounced 落盘——invoke 宿主
		// saveExtensionSettings，并把 iframe 内可变副本当前值回传（postMessage 深拷贝须回传才持久化）
		saveSettingsDebounced: function () {
			return fireInvoke("saveExtensionSettings", [getContext().extensionSettings]);
		},
		getCurrentChatId: function () {
			return (ctxSnapshot && ctxSnapshot.currentChatId) || null;
		},
		generating: false,
		updateChatMetadata: function (partial, reset) {
			return fireInvoke("updateChatMetadata", [partial, reset === true]);
		},
	};

	// 惰性扁平快照：每次访问 window.SillyTavern 都重建 {...getContext(), ...成员, getContext}
	Object.defineProperty(window, "SillyTavern", {
		get: function () {
			return Object.assign({}, getContext(), StExtras, { getContext: getContext });
		},
		configurable: true,
	});

	// ---------- TavernHelper Proxy ----------
	// 已知方法返回真实本地实现；其余方法名一律走 invoke（宿主 onInvoke，返回 Promise）；
	// 数据型属性（events/settings/state）与 Symbol / then 读取返回 undefined，不炸。
	const DATA_PROPS = { events: true, settings: true, state: true };
	const TavernHelper = new Proxy(
		{},
		{
			get(target, method) {
				if (typeof method !== "string") return undefined;
				if (method === "getContext") return getContext;
				if (method === "eventOn") return eventOn;
				if (method === "eventOnce") return eventOnce;
				if (method === "eventEmit") return eventEmit;
				if (method === "eventOff") return eventOff;
				if (method === "SillyTavern") return window.SillyTavern; // G1：状态栏 gn() 等读 TavernHelper?.SillyTavern 兜底
				if (method === "then") return undefined; // 防被当 thenable
				if (DATA_PROPS[method]) return undefined;
				return function () {
					return invoke(method, Array.prototype.slice.call(arguments));
				};
			},
		},
	);
	window.TavernHelper = TavernHelper;
	window.TavernHelper.getContext = getContext;

	// ---------- toastr 桩（R2-④：ST 写法落宿主 toast；success 归入 info） ----------
	const toastrNotify = (level, msg) => invoke("notify", [level, String(msg)]);
	window.toastr = {
		error: (m) => toastrNotify("error", m),
		warning: (m) => toastrNotify("warning", m),
		info: (m) => toastrNotify("info", m),
		success: (m) => toastrNotify("info", m),
	};

	// ---------- 高度上报（ResizeObserver：文档尺寸变化 → resize 帧，宿主驱动面板容器高度）----------
	if (typeof ResizeObserver !== "undefined") {
		const ro = new ResizeObserver(function () {
			const h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
			if (h > 0) post({ kind: "resize", height: h });
		});
		ro.observe(document.documentElement);
	}

	// ---------- 父帧消息监听（只处理 event.source === parent）----------
	window.addEventListener("message", (ev) => {
		if (ev.source !== parent) return;
		const data = ev.data;
		if (!data || typeof data !== "object" || typeof data.kind !== "string") return;
		switch (data.kind) {
			case "event":
				dispatchEvent(data.name, data.args || []);
				break;
			case "context":
				ctxSnapshot = data.snapshot || null;
				break;
			case "invoke-result": {
				const entry = pending.get(data.callId);
				if (entry) {
					pending.delete(data.callId);
					if (data.ok) entry.resolve(data.value);
					else entry.reject(new Error(data.error || "invoke 失败"));
				}
				break;
			}
			case "reload":
				// 宿主重建 iframe 即完成重载，本帧忽略
				break;
			case "theme": {
				// 宿主主题 token → 自身 CSS 变量（脚本 var(--ly-surface) 等引用）
				const t = data.tokens || {};
				const st = document.documentElement.style;
				Object.keys(t).forEach(function (k) {
					st.setProperty("--ly-" + k, t[k]);
				});
				break;
			}
			default:
				break;
		}
	});

	// ---------- 脚本顶层抛错 / Promise 未捕获 → 透传宿主 log ----------
	window.addEventListener("error", (ev) => {
		post({ kind: "log", level: "error", args: [ev.message] });
	});
	window.addEventListener("unhandledrejection", (ev) => {
		post({ kind: "log", level: "error", args: [ev.reason] });
	});

	// ---------- 就绪上报：body 内脚本本体同步执行完后再发 ----------
	setTimeout(() => {
		post({ kind: "ready" });
	}, 0);
})();`;
