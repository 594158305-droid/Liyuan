// 主聊天跟踪（2026-08-11，开发者模式子选项）
//
// 记录载体：`.liyuan-state/trace/<sessionId>.jsonl`，每事件一行 JSON（JSONL 机器格式，
// 追加写）。长文本（完整提示词/思考/草稿全文）经 JSON.stringify 转义后单行原样保存，
// 天然支持长段记录。schema 与事件清单见 docs/DESIGN-debug-trace.md。
//
// 设计口径：记录失败一律静默吞掉（与 #writeAssemblyReport 同口径）——跟踪是调试辅助，
// 绝不影响演出主链路。文件按会话分，切聊天自动开新文件；不自动清理，由设置面板
// 列表（/api/trace/list）显示大小自行管理。

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface TraceEventBase {
	/** ISO 8601 发生时间（UTC，toISOString）；缺省由 record 补当前时间 */
	ts?: string;
}

/** 会话头（文件首条，仅首次写）：角色卡/聊天/时间/预设等关键调试元信息 */
export interface TraceSessionEvent extends TraceEventBase {
	kind: "session";
	sessionId: string;
	cardPath?: string;
	cardName?: string;
	preset?: string | null;
	model?: string;
	thinkingLevel?: string;
	language?: string;
}

export interface TraceTurnStartEvent extends TraceEventBase {
	kind: "turn_start";
	/** 用户原话；null = reroll/swipe 再生成（不追加 user 消息） */
	userText?: string | null;
	model?: string;
}

/** 送模完整上下文：本拍发出去的 systemPrompt + messages + tools（调试提示词的权威快照） */
export interface TracePromptEvent extends TraceEventBase {
	kind: "prompt";
	systemPrompt: string;
	messages: unknown[];
	tools?: unknown;
	reasoning?: string;
}

/** 一轮的完整思考原文（从该轮 final.content 的 thinking 块提取，流式增量不逐条记） */
export interface TraceThinkingEvent extends TraceEventBase {
	kind: "thinking";
	/** 0 = 首轮（performTurn 直发）；1.. = agentLoop 第 N 轮 */
	round: number;
	text: string;
}

export interface TraceToolCallEvent extends TraceEventBase {
	kind: "tool_call";
	name: string;
	arguments: unknown;
	round: number;
}

export interface TraceToolResultEvent extends TraceEventBase {
	kind: "tool_result";
	name: string;
	text: string;
	isError: boolean;
	elapsedMs: number;
	round: number;
}

/** 写侧草稿动作（draft_* 工具）：交稿全文与验收结果——草稿→定稿差异排查的关键 */
export interface TraceDraftEvent extends TraceEventBase {
	kind: "draft";
	action: string;
	args: Record<string, unknown>;
	ok?: boolean;
	result?: string;
}

/** 旁路模型执行（场记/压缩等，引擎内 #sideText 出口） */
export interface TraceSideEvent extends TraceEventBase {
	kind: "side";
	purpose: string;
	systemPrompt?: string;
	userText?: string;
	model?: string;
	ok?: boolean;
	/** 结果全文（成功时正文；失败时 error 文案） */
	text?: string;
	elapsedMs?: number;
}

export interface TraceTurnEndEvent extends TraceEventBase {
	kind: "turn_end";
	aborted: boolean;
	error?: string;
	entryId?: string;
	/** 本拍最终定稿全文（含格式尾巴；工作区空拍时无） */
	finalText?: string;
	elapsedMs: number;
	usage?: unknown;
}

export type TraceEvent =
	| TraceSessionEvent
	| TraceTurnStartEvent
	| TracePromptEvent
	| TraceThinkingEvent
	| TraceToolCallEvent
	| TraceToolResultEvent
	| TraceDraftEvent
	| TraceSideEvent
	| TraceTurnEndEvent;

export interface TraceFileInfo {
	name: string;
	size: number;
	mtime: string;
}

export class TraceRecorder {
	readonly dir: string;
	/** 本进程内已写过会话头的 sessionId（配合文件存在性做幂等） */
	#opened = new Set<string>();

	constructor(traceDir: string) {
		this.dir = traceDir;
	}

	/** 会话头：文件首条元信息（角色卡/预设/模型/时间）。幂等——同进程或文件已存在则不重写 */
	openSession(sessionId: string, meta: Omit<TraceSessionEvent, "kind">): void {
		if (this.#opened.has(sessionId) || existsSync(this.fileOf(sessionId))) {
			this.#opened.add(sessionId);
			return;
		}
		this.#opened.add(sessionId);
		this.record(sessionId, { kind: "session", ...meta } as TraceSessionEvent);
	}

	/** 追加写一条事件；失败静默（跟踪不影响演出） */
	record(sessionId: string, event: TraceEvent): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			const line = { ...event, ts: event.ts ?? new Date().toISOString() };
			appendFileSync(this.fileOf(sessionId), JSON.stringify(line) + "\n", "utf8");
		} catch {
			// 记录失败不影响演出
		}
	}

	/** 目录内跟踪文件元信息（只读 metadata 不读内容；供 /api/trace/list） */
	list(): TraceFileInfo[] {
		try {
			return readdirSync(this.dir, { withFileTypes: true })
				.filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
				.map((d) => {
					const st = statSync(join(this.dir, d.name));
					return { name: d.name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
				})
				.sort((a, b) => b.mtime.localeCompare(a.mtime));
		} catch {
			return [];
		}
	}

	/** 文件名严格限定 <sessionId>.jsonl（sanitize 防路径穿越） */
	fileOf(sessionId: string): string {
		const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
		return join(this.dir, `${safe}.jsonl`);
	}
}
