/**
 * JS Runner 事件桥（M2）：App 每收到一个 wire 帧就转发到此，脚本运行时通过它
 * 订阅 ST 风格扩展事件（如 MESSAGE_RECEIVED）与原始 wire 帧。
 *
 * 设计给 M3 脚本 iframe 运行时复用（registerSink / unregisterSink 透传通道）：
 * - onExt 订阅者只收 ext_event 帧（精确名匹配广播）
 * - sink（iframe 运行时）收到全部帧（hello/message/state/ext_event 等）：
 *   hello/message 维护聊天只读快照；ext_event 广播进脚本（M3b runtime sink）
 *
 * 纯 TS 模块，不 import React。
 */
import type { ServerFrame } from "../wire.ts";

/** M3 脚本 iframe 运行时注册的原始帧接收者 */
export interface WireBusSink {
	onWireFrame(frame: ServerFrame): void;
}

export interface JsRunnerBus {
	/** App.tsx 每收到一个 ServerFrame 调用（在 onFrame 入口处） */
	onWireFrame(frame: ServerFrame): void;
	/** 订阅 ST 风格扩展事件（MESSAGE_RECEIVED 等），返回退订函数 */
	onExt(name: string, cb: (...args: unknown[]) => void): () => void;
	offExt(name: string, cb: (...args: unknown[]) => void): void;
	/** 本地广播（脚本 eventEmit / 宿主内部使用） */
	emitExt(name: string, ...args: unknown[]): void;
	/** M3 脚本 iframe 运行时注册（收到帧时除 ext_event 外的帧也会透传给它） */
	registerSink(sink: WireBusSink): void;
	unregisterSink(sink: WireBusSink): void;
}

/** ext 事件订阅表：精确名匹配，同名多订阅者并存（Set 天然去重、删除幂等） */
const extSubs = new Map<string, Set<(...args: unknown[]) => void>>();

/** 原始帧透传目标（M3 脚本 iframe 运行时注册；Set 保证注册/退订幂等） */
const sinks = new Set<WireBusSink>();

/** 本地广播：订阅者回调各自 try/catch，脚本出错不能炸宿主，只 console.warn */
function emitExt(name: string, ...args: unknown[]): void {
	const set = extSubs.get(name);
	if (!set || set.size === 0) return;
	for (const cb of [...set]) {
		try {
			cb(...args);
		} catch (e) {
			console.warn(`[jsrunnerBus] ext 事件「${name}」回调出错`, e);
		}
	}
}

export const jsrunnerBus: JsRunnerBus = {
	onWireFrame(frame) {
		// ext_event → 扩展事件总线（onExt 订阅者）；同时一并透传 sink（M3b 脚本 iframe 运行时广播用）
		if (frame.type === "ext_event") {
			emitExt(frame.name, ...frame.args);
		}
		// 全部帧（含 ext_event）一并透传给所有已注册 sink
		for (const sink of [...sinks]) {
			try {
				sink.onWireFrame(frame);
			} catch (e) {
				console.warn("[jsrunnerBus] sink 处理帧出错", sink, e);
			}
		}
	},
	onExt(name, cb) {
		let set = extSubs.get(name);
		if (!set) {
			set = new Set();
			extSubs.set(name, set);
		}
		set.add(cb);
		// 幂等退订：重复调用无副作用；空表项顺手清理
		return () => {
			set.delete(cb);
			if (set.size === 0) extSubs.delete(name);
		};
	},
	offExt(name, cb) {
		const set = extSubs.get(name);
		if (!set) return;
		set.delete(cb);
		if (set.size === 0) extSubs.delete(name);
	},
	emitExt,
	registerSink(sink) {
		sinks.add(sink);
	},
	unregisterSink(sink) {
		sinks.delete(sink);
	},
};
