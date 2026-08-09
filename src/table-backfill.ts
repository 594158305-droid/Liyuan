/**
 * 表格历史回填（DESIGN-table-backfill §1 核心）：从当前分支的叙事楼层逐块提取数据填充表。
 *
 * 纯函数 + 注入依赖，零 pi 依赖：
 * - 数据源 = 当前分支叙事历史（branchHistory，与压缩摘要同一条「剔摘要条目 + rebuildHistory」路）；
 * - 不走摘要：分块直读原文提取，避免摘要信息损失；
 * - 增量式：每块提示词带「当前表状态」，模型只输出该块新出现/变化的数据，时间顺序后写覆盖；
 * - 写操作直接走 applyTableOperation——不经过 applyPatch（其 tables case 只接受 auto 表，
 *   回填要对任意表（含非 auto 静态表）有效）。
 */

import { chunkMessagesForSummary, type StChatMessage } from "./chatlog.ts";
import { applyTableOperation } from "./state.ts";
import { branchHistory } from "./stage/compact.ts";
import type { BranchEntryLike } from "./stage/assemble.ts";
import type { CustomTable, WorldState } from "./types.ts";

/** 提取器输出：三类操作（与 applyTableOperation 的 insert/update/delete 一一对应） */
export interface TableBackfillOps {
	insert?: Record<string, unknown>[];
	update?: { match: Record<string, unknown>; changes: Record<string, unknown> }[];
	delete?: Record<string, unknown>[];
}

/**
 * 提取提示词：system = 提取器指令（表 schema + 输出 JSON 格式）；user = 当前表状态 + 历史片段原文。
 * stateSnapshot 由调用方决定粒度——传 JSON.stringify(table)（含当前行）最省 token 且增量式够用。
 */
export function buildTableBackfillPrompt(
	table: CustomTable,
	stateSnapshot: string,
	chunkText: string,
): { systemPrompt: string; userText: string } {
	const columns = table.columns.map((c) => (c.type ? `${c.name}（${c.type}）` : c.name)).join("、");
	const systemPrompt = `你是表格数据提取器。从给定的历史剧情片段中，把与表「${table.name}」相关的数据提取出来，以 JSON 输出。

表「${table.name}」列定义：${columns}${table.description ? `\n表说明：${table.description}` : ""}

输出格式（只输出 JSON，不要任何前言、解释或代码围栏）：
{
  "insert": [ {行对象}, ... ],
  "update": [ { "match": {匹配键值}, "changes": {新值} }, ... ],
  "delete": [ {匹配键值}, ... ]
}

规则：
- 行对象只含该表已声明的列，不要发明新列；integer/number 列输出数字、boolean 列输出 true/false。
- 增量式提取：只输出本片段「新出现或变化」的数据——表中已存在且未变化的行不要重复输出。
- match 用能唯一定位行的键值（如行号/名称）；changes 只含变化了的列。
- 没有相关内容时输出 {"insert":[],"update":[],"delete":[]}。
- 只输出 JSON。`;

	const userText = `【当前表状态】\n${stateSnapshot}\n\n【历史片段】\n${chunkText}`;
	return { systemPrompt, userText };
}

/**
 * 宽容解析提取输出（剥围栏、逐个「{」试切，同 parseScribeResult 风格）；失败返回 null。
 * 命中条件：候选对象里存在 insert/update/delete 任一数组键（前言里的孤 {} 不算）。
 */
export function parseTableBackfillOps(text: string): TableBackfillOps | null {
	let t = text.trim();
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) t = fence[1].trim();
	let idx = 0;
	while (true) {
		const start = t.indexOf("{", idx);
		if (start === -1) break;
		// 从候选起点向后找平衡的右括号（跳过字符串里的「}」）
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		for (let i = start; i < t.length; i++) {
			const ch = t[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) break;
		try {
			const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
			if (obj && typeof obj === "object" && !Array.isArray(obj)) {
				const ops: TableBackfillOps = {};
				if (Array.isArray(obj.insert)) ops.insert = obj.insert as Record<string, unknown>[];
				if (Array.isArray(obj.delete)) ops.delete = obj.delete as Record<string, unknown>[];
				if (Array.isArray(obj.update)) {
					// update 项须为 { match, changes } 对象，不合法的项丢弃
					ops.update = (obj.update as unknown[]).filter(
						(u): u is { match: Record<string, unknown>; changes: Record<string, unknown> } =>
							!!u &&
							typeof u === "object" &&
							!Array.isArray(u) &&
							typeof (u as { match?: unknown }).match === "object" &&
							(u as { match?: unknown }).match !== null &&
							typeof (u as { changes?: unknown }).changes === "object" &&
							(u as { changes?: unknown }).changes !== null,
					);
				}
				if (ops.insert || ops.update || ops.delete) return ops;
			}
		} catch {
			// 本候选不成（前言里的孤 {），试下一个
		}
		idx = start + 1;
	}
	return null;
}

/** 从 applied 摘要消息里取行数（如「表 X 更新 3 行」→ 3；无数字返回 0） */
function countFromApplied(applied: string[] | undefined): number {
	for (const a of applied ?? []) {
		const m = /(\d+)\s*行/.exec(a);
		if (m) return Number(m[1]);
	}
	return 0;
}

/** 把一组的 ops 应用到表（直接 applyTableOperation，非 auto 表也生效）；返回成功应用的行数 */
function applyOps(state: WorldState, tableName: string, ops: TableBackfillOps): number {
	let rows = 0;
	for (const row of ops.insert ?? []) {
		const r = applyTableOperation(state, { kind: "insert", table: tableName, row });
		if (r.ok) rows += countFromApplied(r.applied);
	}
	for (const u of ops.update ?? []) {
		const r = applyTableOperation(state, { kind: "update", table: tableName, match: u.match, changes: u.changes });
		if (r.ok) rows += countFromApplied(r.applied);
	}
	for (const match of ops.delete ?? []) {
		const r = applyTableOperation(state, { kind: "delete", table: tableName, match });
		if (r.ok) rows += countFromApplied(r.applied);
	}
	return rows;
}

export interface TableBackfillDeps {
	/** 当前分支条目（调用方从 sessionManager.getBranch() 取） */
	branchEntries: BranchEntryLike[];
	/** 工作状态（可变；applyTableOperation 直接改传入对象，调用方事后 save） */
	state: WorldState;
	tableName: string;
	userName: string;
	charName: string;
	/** 旁路文本调用：返回文本；失败返回 {error} */
	sideText: (systemPrompt: string, userText: string) => Promise<string | { error: string }>;
	onProgress?: (msg: string) => void;
}

/**
 * 核心循环（DESIGN-table-backfill §1）：表存在校验 → 分支叙事历史 → 分块 →
 * 逐块 buildTableBackfillPrompt + sideText + parseTableBackfillOps + applyTableOperation。
 * 块失败 / 输出垃圾跳过继续；时间顺序后写覆盖（增量式）。
 */
export async function runTableBackfill(deps: TableBackfillDeps): Promise<
	| { ok: true; rows: number; chunks: number }
	| { ok: false; error: string }
> {
	const table = deps.state.tables?.[deps.tableName];
	if (!table) {
		return { ok: false, error: `表「${deps.tableName}」不在当前聊天中，请先物化/建表` };
	}
	const history = branchHistory(deps.branchEntries);
	if (history.length === 0) {
		return { ok: false, error: "当前分支没有可回填的叙事楼层" };
	}
	// 分支历史 → 分块（name 语义与 serializeForSummary 一致：user=userName，assistant=charName）
	const msgs: StChatMessage[] = history.map((m) => ({
		role: m.role,
		name: m.role === "user" ? deps.userName : deps.charName,
		text: m.text,
	}));
	const chunks = chunkMessagesForSummary(msgs, deps.userName);
	let rows = 0;
	for (let i = 0; i < chunks.length; i++) {
		deps.onProgress?.(`回填 ${i + 1}/${chunks.length}…`);
		// 当前表状态含此前各块已应用的行（增量式：后块只见前块之后的状态）
		const current = deps.state.tables?.[deps.tableName];
		if (!current) break; // 表被并发删掉（异常树）；收尾
		const prompt = buildTableBackfillPrompt(current, JSON.stringify(current), chunks[i]);
		const resp = await deps.sideText(prompt.systemPrompt, prompt.userText);
		if (typeof resp !== "string") {
			deps.onProgress?.(`块 ${i + 1} 失败：${resp.error}`);
			continue;
		}
		const ops = parseTableBackfillOps(resp);
		if (!ops) {
			deps.onProgress?.(`块 ${i + 1} 输出无法解析，跳过`);
			continue;
		}
		rows += applyOps(deps.state, deps.tableName, ops);
	}
	return { ok: true, rows, chunks: chunks.length };
}
