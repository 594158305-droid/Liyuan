/**
 * 统一调试接口（2026-08）：三条 LLM 通道（主聊天主演 / 旁路 / 右栏助手·自定义 agent）
 * 在「LLM 返回非预期内容」时统一打印 + 记录日志的出口。
 *
 * 设计口径（与主聊天跟踪 src/stage/trace.ts 同源）：
 * - 后台控制台打印（INFO→console.log / WARNING→console.warn / ERROR→console.error）
 *   与写日志文件（.liyuan-state/debug.log，JSONL）双通道。
 * - 记录失败一律静默吞掉——调试辅助绝不拖垮演出主链路。
 * - 「开发者模式」可关闭打印：host 按 config 现读并 configure 切换。
 *
 * 线程/进程安全：追加写走 appendFileSync，单进程内顺序调用无竞态。
 */

import { appendFileSync, mkdirSync } from "node:fs";

export type DebugLevel = "info" | "warning" | "error";

/** 每条日志的分级字段值：console 输出用 / level 字段过滤 */
const LEVEL_TAG: Record<DebugLevel, string> = {
	info: "INFO",
	warning: "WARNING",
	error: "ERROR",
};

/** 控制台方法：INFO/WARNING/ERROR 各走一层，便于终端里按颜色/级别过滤 */
const CONSOLE_FN: Record<DebugLevel, (msg: string) => void> = {
	info: (m) => console.log(m),
	warning: (m) => console.warn(m),
	error: (m) => console.error(m),
};

interface DebugState {
	/** 是否向后台控制台打印（开发者模式可关） */
	console: boolean;
	/** 是否追加写 .liyuan-state/debug.log */
	file: boolean;
	/** 日志文件绝对路径；空 = 不写文件 */
	filePath: string;
	/** 最低级别过滤：低于该级别的不输出（缺省 info = 全量） */
	minLevel: DebugLevel;
}

/** 默认状态：控制台 + 文件全开，记全部级别；filePath 由 host（main.ts）configure 写入 */
let state: DebugState = {
	console: true,
	file: true,
	filePath: "",
	minLevel: "info",
};

/** 级别数值（越大越关键），用于 minLevel 过滤 */
const LEVEL_ORDER: Record<DebugLevel, number> = { info: 0, warning: 1, error: 2 };

/** 解析合法级别（容错：非法回退 info） */
function toLevel(v: string): DebugLevel {
	return v === "warning" || v === "error" ? v : "info";
}

export interface DebugConfig {
	console?: boolean;
	file?: boolean;
	filePath?: string;
	minLevel?: DebugLevel | string;
}

/**
 * 配置调试接口（可多次调用，增量合并）。
 * - console/file：两条通道的开关（保留「开发者模式关掉打印」的接入点，host 按 config 现读）。
 * - filePath：日志文件绝对路径（host 启动时写入 .liyuan-state/debug.log）。
 * - minLevel：最低输出级别（预留：需要时可按级别抑制）。
 */
export function configureDebug(cfg: DebugConfig): void {
	if (typeof cfg.console === "boolean") state.console = cfg.console;
	if (typeof cfg.file === "boolean") state.file = cfg.file;
	if (typeof cfg.filePath === "string") state.filePath = cfg.filePath;
	if (cfg.minLevel !== undefined) state.minLevel = toLevel(String(cfg.minLevel));
}

/** 读取当前配置快照（测试/设置面板用） */
export function debugConfig(): { console: boolean; file: boolean; filePath: string; minLevel: DebugLevel } {
	return { ...state };
}

/** 当前是否允许向控制台打印（对外暴露，供需要前置判断的场景） */
export function debugPrintEnabled(): boolean {
	return state.console;
}

/** 当前是否允许写文件（对外暴露） */
export function debugFileEnabled(): boolean {
	return state.file;
}

/** 往日志文件追加一行 JSONL；失败静默（调试不影响主链路） */
function writeFile(level: DebugLevel, category: string, message: string, detail?: unknown): void {
	if (!state.file || !state.filePath) return;
	try {
		mkdirSync(dirnameOf(state.filePath), { recursive: true });
		const line = {
			ts: new Date().toISOString(),
			level,
			category,
			message,
			...(detail === undefined ? {} : { detail }),
		};
		appendFileSync(state.filePath, JSON.stringify(line) + "\n", "utf8");
	} catch {
		// 记录失败不影响演出
	}
}

/** 极简 dirname（避免 import node:path 增加依赖面；仅处理常见路径） */
function dirnameOf(p: string): string {
	const i = p.lastIndexOf("/");
	const j = p.lastIndexOf("\\");
	const k = Math.max(i, j);
	return k < 0 ? "." : p.slice(0, k) || "/";
}

/** 单条日志的任意参数 → 可读字符串（对象 JSON 化，字符串原样） */
function stringifyArg(a: unknown): string {
	if (typeof a === "string") return a;
	if (a === null) return "null";
	if (a === undefined) return "undefined";
	try {
		return typeof a === "object" ? JSON.stringify(a) : String(a);
	} catch {
		return String(a);
	}
}

function emit(level: DebugLevel, category: string, message: string, detail?: unknown): void {
	// 级别过滤：低于 minLevel 直接丢（详情也不拼）
	if (LEVEL_ORDER[level] < LEVEL_ORDER[state.minLevel]) return;
	const tag = LEVEL_TAG[level];
	const line = `${tag} [${category}] ${message}`;
	// 控制台通道（开发者模式可关）
	if (state.console) {
		if (detail !== undefined) {
			CONSOLE_FN[level](`${line} :: ${stringifyArg(detail)}`);
		} else {
			CONSOLE_FN[level](line);
		}
	}
	// 文件通道（JSONL，含结构化 detail）
	writeFile(level, category, message, detail);
}

/** INFO：常规流水（如「旁路调用发起/成功」等非异常但值得记录的信息） */
export const debugInfo = (category: string, message: string, detail?: unknown): void =>
	emit("info", category, message, detail);

/** WARNING：LLM 返回疑似非预期但未致命（空输出、stopReason 奇、工具结果异常等） */
export const debugWarning = (category: string, message: string, detail?: unknown): void =>
	emit("warning", category, message, detail);

/** ERROR：LLM 返回/链路明确失败（provider error、流未产出、解析失败等） */
export const debugError = (category: string, message: string, detail?: unknown): void =>
	emit("error", category, message, detail);

/** 按级别名分发（统一入口：level 字符串 + message/detail） */
export function debugLog(level: DebugLevel, category: string, message: string, detail?: unknown): void {
	emit(level, category, message, detail);
}

/** 便捷对象：debug.info(...) / debug.warning(...) / debug.error(...) */
export const debug = {
	info: debugInfo,
	warning: debugWarning,
	error: debugError,
	log: debugLog,
};
