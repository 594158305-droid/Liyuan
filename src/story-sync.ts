/**
 * 剧情扩展内存同步（进程内直达，不经 /panelsync 命令桥）。
 *
 * 背景：助手写面板/账本落盘后，若再用 handlePrompt("/panelsync") 收编，
 * 在剧情回合中（assistant_run 工具执行期间）会 followUp 排队 → 死锁。
 * roleplay 在 session_start 注册回调；server 写盘后直接调用。
 *
 * 【双模块陷阱】roleplay 由 jiti 加载（tryNative:false），main 走 Node 原生 ESM，
 * 两边对同一文件会各得到一份 module scope。stateSync/panelSync 必须挂在
 * globalThis 上，否则 register 写进 A、sync 读 B → 永远 null
 * （2026-08-09 实测：applyTemplate 落盘后树快照不同步，前端/助手看不到自定义表）。
 */

type SyncFn = () => void;

const SLOT_KEY = "__liyuanStorySync__";

type StorySyncSlot = {
	panelSync: SyncFn | null;
	stateSync: SyncFn | null;
};

function slot(): StorySyncSlot {
	const g = globalThis as typeof globalThis & { [SLOT_KEY]?: StorySyncSlot };
	if (!g[SLOT_KEY]) {
		g[SLOT_KEY] = { panelSync: null, stateSync: null };
	}
	return g[SLOT_KEY];
}

export function registerStoryPanelSync(fn: SyncFn | null): void {
	slot().panelSync = fn;
}

export function registerStoryStateSync(fn: SyncFn | null): void {
	slot().stateSync = fn;
}

/** 从磁盘收编剧情扩展的面板内存 + 树快照（无注册时 no-op） */
export function syncStoryPanelsFromDisk(): void {
	try {
		slot().panelSync?.();
	} catch {
		// 扩展未就绪时忽略；下轮 context 仍会从盘读
	}
}

/** 从磁盘收编剧情扩展的世界状态内存 + 树快照 */
export function syncStoryStateFromDisk(): void {
	try {
		slot().stateSync?.();
	} catch {
		// ignore
	}
}
