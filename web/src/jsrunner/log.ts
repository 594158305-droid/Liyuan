/**
 * JS Runner 脚本日志环形缓存（M4b）。
 *
 * 纯 TS 模块：不 import 任何 DOM / ws / api / `?raw` 依赖，node --input-type=module
 * 可直跑冒烟（对比 helper.ts 的 import 链含 ws/api/runtime(`?raw`)，node 无法加载）。
 *
 * helper.ts 的 onLog 写入（pushLog），LogViewer 读取（getLogs / subscribeLogs /
 * clearLogs）都经由这里；helper.ts 只做薄包装 re-export，对外接口一致。
 *
 * 语义：
 * - 环形缓存最多 500 条，超出丢最旧；getLogs 返回新→旧快照（副本，改返回数组不影响缓存）
 * - 订阅者（LogViewer）收到逐条增量回调；订阅返回退订函数，退订幂等
 * - 文本序列化：逐参数 JSON 安全字符串化（undefined/函数/循环引用兜底 String 化），空格连接
 */

/** 日志条目：ts 毫秒时间戳 + 来源脚本 id + 级别 + 文本 */
export interface JsLogEntry {
	ts: number;
	scriptId: string;
	level: "log" | "warn" | "error";
	text: string;
}

/** 环形缓存上限（超出丢最旧） */
export const LOG_LIMIT = 500;

/** 环形存储：新条目 push 尾部，超出上限 shift 头部（天然丢最旧） */
const ring: JsLogEntry[] = [];

/** 订阅者集合（Set 天然去重，退订幂等） */
const subscribers = new Set<(entry: JsLogEntry) => void>();

/** 序列化单个日志参数：JSON 安全字符串化，失败退 String 化 */
function stringifyArg(a: unknown): string {
	if (typeof a === "string") return a;
	try {
		const s = JSON.stringify(a);
		// JSON.stringify(undefined) / 函数等返回 undefined → 兜底 String 化
		return s === undefined ? String(a) : s;
	} catch {
		// 循环引用等不可序列化 → String 化兜底
		return String(a);
	}
}

/** 把脚本 console 参数列表序列化成日志文本（空格连接，与宿主 console 语义一致） */
export function stringifyLogArgs(args: readonly unknown[]): string {
	return args.map(stringifyArg).join(" ");
}

/** 环形缓存快照（新→旧，最多 LOG_LIMIT 条） */
export function getLogs(): JsLogEntry[] {
	return [...ring].reverse();
}

/**
 * 追加一条日志（helper.ts 的 onLog 调用）：入缓存 + 通知订阅者。
 * ts 由本模块取 Date.now() 统一打点。
 */
export function pushLog(entry: Omit<JsLogEntry, "ts">): void {
	const full: JsLogEntry = { ...entry, ts: Date.now() };
	ring.push(full);
	if (ring.length > LOG_LIMIT) ring.shift();
	// 订阅者回调各自 try/catch：单个订阅者出错不能炸坏缓存写入
	for (const cb of [...subscribers]) {
		try {
			cb(full);
		} catch (e) {
			console.warn("[jsrunner log] 订阅者回调出错", e);
		}
	}
}

/** 订阅新日志（增量回调，新条目入参），返回退订函数（幂等） */
export function subscribeLogs(cb: (entry: JsLogEntry) => void): () => void {
	subscribers.add(cb);
	return () => {
		subscribers.delete(cb);
	};
}

/** 清空环形缓存（订阅者保留，后续新日志仍会推送） */
export function clearLogs(): void {
	ring.length = 0;
}
