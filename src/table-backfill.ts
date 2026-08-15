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
import { TABLE_DISCIPLINE } from "./table-discipline.ts";

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
	relatedTables?: Record<string, CustomTable>,
	/** 数据源标签（2026-08-15 逐表派发复用）：历史回填 = "历史片段"；每轮场记逐表维护 = "本轮对话" */
	sourceLabel = "历史片段",
): { systemPrompt: string; userText: string } {
	const columns = table.columns.map((c) => (c.type ? `${c.name}（${c.type}）` : c.name)).join("、");
	const systemPrompt = `你是【表格数据提取器】。你的唯一工作：依据<正文数据>与<当前表格数据>，把与目标表「${table.name}」相关的数据以 JSON 操作形式写入该表。

## 数据来源
- <当前表格数据>：目标表当前状态（列定义、表说明、已有行）——一切操作必须基于它，是操作基础。
- <关联表数据>：目标表说明中引用的其他表（用于核对一致性，例如姓名/地点引用）。只读不写。
- <正文数据>：一段历史剧情原文——数据来源，从中提取与目标表相关的实体与变化。

${TABLE_DISCIPLINE}

## 目标表
列定义：${columns}
（表说明见<当前表格数据>中的 description 字段——它是该表最重要的规则，见下方「表说明优先级」）

## 动手前必须按顺序完成（在心中推理，不要输出）
1. 通读表说明（description），逐条识别其中的约束：固定行数、唯一键、内容范围、格式要求（如描述字数下限）、删除条件、对其它表的引用等；
2. 通读<正文数据>，找出与该表相关的实体及其状态变化；
3. 对照<当前表格数据>的已有行，逐条决定操作：insert（新实体）/ update（变化）/ delete（按规则移除）。

## 表说明优先级
表说明（description）的约束优先级最高——高于以下任何通用规则；冲突时一律以表说明为准。

## 操作规则
- insert：正文中出现、且表中尚不存在的实体。表说明声明了唯一键（如「以列1姓名为唯一键」）时，同名实体绝不重复建档。
- update：必须带 match 精确定位已有行，禁止无条件更新。match 键选择依次尝试：① 表说明示例中使用的键 → ② 唯一键/业务主键（如姓名）→ ③ 其他能唯一定位的业务列。changes 只含实际变化的列。
- delete：仅当表说明明确要求删除（注意：正文片段中某时刻未出场 ≠ 该实体不在场，删除判断以表说明的语义为准）；表说明未授权删除时，一律不删。
- 表说明要求引用其它表的数据（如地点与某表保持一致）而<当前表格数据>未提供该表时：宁可不改，绝不臆造。

## 输出格式（严格执行：只输出一个 JSON 对象，无前言、无解释、无代码围栏）
{
  "insert": [ {行对象}, ... ],
  "update": [ { "match": {匹配键值}, "changes": {新值} }, ... ],
  "delete": [ {匹配键值}, ... ]
}

## 格式要点
- 行对象只含该表已声明的列，不发明新列；integer/number 列输出数字、boolean 列输出 true/false。
- 表说明要求的格式约束（如描述字数下限）逐条遵守。
- 正文中没有相关内容时输出 {"insert":[],"update":[],"delete":[]}——宁缺毋滥，绝不编造。`;

	const userText = `【当前表状态】
${stateSnapshot}

【表说明（description，优先级最高）】
${table.description ?? "（无）"}

【关联表数据】（表说明中引用的其他表，只用于核对一致性，禁止写入）
${
	relatedTables && Object.keys(relatedTables).length > 0
		? Object.entries(relatedTables)
				.map(([name, t]) => `表「${name}」（列：${t.columns.map((c) => c.name).join("、")}）：\n${JSON.stringify(t.rows)}`)
				.join("\n\n")
		: "（无）"
}

【${sourceLabel}】
${chunkText}`;
	return { systemPrompt, userText };
}

/**
 * 从目标表 description 里提取被引用的其他表名（与当前全部表名做包含匹配）。
 * 目标表自身与匹配空串的键排除；命中即注入（可能命中与目标表无关的同名词，
 * 但多带一张表比少带一张导致一致性核对失败更划算）。
 */
export function relatedTableNames(
	description: string | undefined,
	allTables: Record<string, CustomTable>,
	excludeName?: string,
): string[] {
	if (!description) return [];
	const names = Object.keys(allTables).filter((n) => n.trim().length > 0 && n !== excludeName);
	return names.filter((n) => description.includes(n));
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

/** applyOps 的结果：行数 + applied 消息（逐表派发记账摘要用） */
export interface ApplyOpsResult {
	/** 成功应用的行数 */
	rows: number;
	/** 每笔操作的 applied 消息（如「表 X 插入 1 行」） */
	applied: string[];
}

/** 把一组的 ops 应用到表（直接 applyTableOperation，非 auto 表也生效）；返回行数与 applied 消息 */
export function applyOps(state: WorldState, tableName: string, ops: TableBackfillOps): ApplyOpsResult {
	const applied: string[] = [];
	let rows = 0;
	for (const row of ops.insert ?? []) {
		const r = applyTableOperation(state, { kind: "insert", table: tableName, row });
		if (r.ok) {
			rows += countFromApplied(r.applied);
			applied.push(...(r.applied ?? []));
		}
	}
	for (const u of ops.update ?? []) {
		const r = applyTableOperation(state, { kind: "update", table: tableName, match: u.match, changes: u.changes });
		if (r.ok) {
			rows += countFromApplied(r.applied);
			applied.push(...(r.applied ?? []));
		}
	}
	for (const match of ops.delete ?? []) {
		const r = applyTableOperation(state, { kind: "delete", table: tableName, match });
		if (r.ok) {
			rows += countFromApplied(r.applied);
			applied.push(...(r.applied ?? []));
		}
	}
	return { rows, applied };
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
	/** LLM 调用失败 / 输出无法解析时的重试次数（缺省 5，即最多 6 次尝试） */
	maxRetries?: number;
	/** 重试退避基数（毫秒，缺省 2000）：第 n 次重试前等待 baseDelay × 2^(n-1)（2s→4s→8s→16s→32s） */
	retryBaseDelayMs?: number;
	onProgress?: (msg: string) => void;
}

/** 延迟（重试退避用） */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 核心循环（DESIGN-table-backfill §1）：表存在校验 → 分支叙事历史 → 分块 →
 * 逐块 buildTableBackfillPrompt + sideText + parseTableBackfillOps + applyTableOperation。
 * 块级重试：LLM 调用失败（{error} / 抛异常）或输出无法解析时，按 2s 倍增退避重试
 * （缺省 5 次），全部失败才跳过该块继续；重试过程后台打印 [table-backfill] 便于追踪。
 * 时间顺序后写覆盖（增量式）。
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
	const maxRetries = deps.maxRetries ?? 5;
	const baseDelay = deps.retryBaseDelayMs ?? 2000;
	let rows = 0;
	// 目标表说明中引用的其他表（多表一致性核对用；只读不写）——循环外算一次
	let relatedTables: Record<string, CustomTable> | undefined;
	for (let i = 0; i < chunks.length; i++) {
		deps.onProgress?.(`回填 ${i + 1}/${chunks.length}…`);
		// 当前表状态含此前各块已应用的行（增量式：后块只见前块之后的状态）
		const current = deps.state.tables?.[deps.tableName];
		if (!current) break; // 表被并发删掉（异常树）；收尾
		if (!relatedTables) {
			const names = relatedTableNames(current.description, deps.state.tables ?? {}, deps.tableName);
			if (names.length > 0) {
				relatedTables = {};
				for (const n of names) relatedTables[n] = deps.state.tables![n]!;
			}
		}
		const prompt = buildTableBackfillPrompt(current, JSON.stringify(current), chunks[i], relatedTables);
		// 块级重试：失败（调用错误 / 输出垃圾）→ 2s 倍增退避重试，重试成功照样应用
		let attempts = 0;
		let done = false;
		while (!done) {
			attempts++;
			let resp: string | { error: string };
			try {
				resp = await deps.sideText(prompt.systemPrompt, prompt.userText);
			} catch (err) {
				// sideText 实现一般自带 catch 返回 {error}；这里兜底防抛异常中断整轮回填
				resp = { error: err instanceof Error ? err.message : String(err) };
			}
			const ops = typeof resp === "string" ? parseTableBackfillOps(resp) : null;
			if (ops) {
				rows += applyOps(deps.state, deps.tableName, ops).rows;
				done = true;
				break;
			}
			const failReason = typeof resp !== "string" ? `调用失败（${resp.error}）` : "输出无法解析";
			if (attempts > maxRetries) {
				deps.onProgress?.(`块 ${i + 1} ${failReason}，重试 ${maxRetries} 次仍失败，跳过`);
				console.log(
					`[table-backfill] 表「${deps.tableName}」块 ${i + 1}/${chunks.length} ${failReason}，重试 ${maxRetries} 次仍失败，跳过`,
				);
				done = true;
				break;
			}
			const wait = baseDelay * 2 ** (attempts - 1); // 2s → 4s → 8s → 16s → 32s
			console.log(
				`[table-backfill] 表「${deps.tableName}」块 ${i + 1}/${chunks.length} 第 ${attempts} 次尝试${failReason}，` +
					`${wait / 1000}s 后重试（剩余 ${maxRetries - attempts} 次）`,
			);
			deps.onProgress?.(`块 ${i + 1} ${failReason}，${wait / 1000}s 后重试（剩余 ${maxRetries - attempts} 次）…`);
			await sleep(wait);
		}
	}
	return { ok: true, rows, chunks: chunks.length };
}
