/**
 * 物化重建（DESIGN-tables-sql §7，2026-08-16 二版：检查点增量）。
 *
 * 权威 = 会话树上的 rp-table-log 日志（随分支走）；SQLite db 是焦点分支的物化。
 * 2026-08-16 实弹事故：迁移基线的表没有日志（迁移一次性导入），任何「空日志/全量
 * 重放」都会把物化清空。二版改为**检查点增量重放**：
 * - 无检查点 + 物化有表 → 基线锁定（以当前叶为基线，不清空不重放）；
 * - 检查点在分支上 → 只重放其后的日志（增量，不清空）；
 * - 检查点不在分支上（回退到更早分支）→ 不动物化（保守：多数据好于丢数据）。
 *
 * 纯函数式（service 注入），可单测。
 */

import { TablesService, type TableLogEntry } from "./service.ts";

export type ReplayOutcome =
	| { kind: "ok"; replayed: number; baseline: boolean; reason?: string }
	| { kind: "failed"; error: string; failedSql?: string };

/** 从会话树 custom 条目提取表写日志（rp-table-log）；非日志条目忽略。 */
export function collectTableLogs(branch: Array<Record<string, unknown>>): TableLogEntry[] {
	const out: TableLogEntry[] = [];
	for (const e of branch) {
		if (e.type !== "custom" || e.customType !== "rp-table-log") continue;
		const d = e.data as Partial<TableLogEntry> | undefined;
		if (!d || typeof d !== "object" || typeof d.sql !== "string") continue;
		out.push({
			op: (d.op ?? "insert") as TableLogEntry["op"],
			sql: d.sql,
			changes: typeof d.changes === "number" ? d.changes : 0,
			at: typeof d.at === "number" ? d.at : 0,
			entryId: typeof e.id === "string" ? e.id : undefined,
		});
	}
	return out;
}

/**
 * 检查点增量重放：branch 上 checkpointEntryId 之后的日志按序重放（不清空物化）。
 * - checkpointEntryId 为 null → 不重放（调用方负责基线锁定）；
 * - checkpoint 条目不在分支上 → 不重放（回退到更早分支，物化保持不变）；
 * - 重放失败 → 停在失败点返回 failed。
 */
export function replayFromCheckpoint(
	svc: TablesService,
	branch: Array<Record<string, unknown>>,
	checkpointEntryId: string | null,
): ReplayOutcome {
	if (!checkpointEntryId) {
		return { kind: "ok", replayed: 0, baseline: true, reason: "无检查点（基线由调用方锁定）" };
	}
	const cpIdx = branch.findIndex((e) => e.id === checkpointEntryId);
	if (cpIdx < 0) {
		return { kind: "ok", replayed: 0, baseline: true, reason: "检查点不在该分支（回退到更早分支，物化保持不变）" };
	}
	const after = collectTableLogs(branch.slice(cpIdx + 1));
	if (after.length === 0) return { kind: "ok", replayed: 0, baseline: false };
	let replayed = 0;
	for (const entry of after) {
		const r = svc.rawExec(entry.sql);
		if (!r.ok) {
			return { kind: "failed", error: `增量重放失败（第 ${replayed + 1} 笔，${entry.op}）：${r.error}`, failedSql: entry.sql };
		}
		replayed++;
	}
	return { kind: "ok", replayed, baseline: false };
}

/**
 * 全量重放（旧版，仅测试/显式重建场景用；常规路径请走 replayFromCheckpoint）：
 * 空日志 → 不动物化（迁移基线）；非空日志 → 清空 + 按序重放。
 */
export function replayBranch(svc: TablesService, logs: TableLogEntry[]): ReplayOutcome {
	try {
		if (logs.length === 0) {
			return { kind: "ok", replayed: 0, baseline: true, reason: "该分支没有表写日志（迁移基线，物化保持不变）" };
		}
		svc.clearUserTables();
		let replayed = 0;
		for (const entry of logs) {
			const r = svc.rawExec(entry.sql);
			if (!r.ok) {
				return { kind: "failed", error: `重放失败（第 ${replayed + 1} 笔，${entry.op}）：${r.error}`, failedSql: entry.sql };
			}
			replayed++;
		}
		return { kind: "ok", replayed, baseline: false };
	} catch (e) {
		return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
	}
}
