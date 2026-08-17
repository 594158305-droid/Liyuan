import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectTableLogs, replayBranch, replayFromCheckpoint } from "../src/tables/replay.ts";
import { TablesService, type TableLogEntry } from "../src/tables/service.ts";

/**
 * 物化重建（DESIGN-tables-sql §7）：日志 → 重放 → 查询验证；失败停点。
 */

const tmp = mkdtempSync(join(tmpdir(), "tables-replay-"));
const makeSvc = (name: string): TablesService => new TablesService(join(tmp, `${name}.db`));

test("replayBranch：create + insert 日志重放出可查询的表", () => {
	const svc = makeSvc("a");
	const logs: TableLogEntry[] = [
		{
			op: "create",
			sql: 'CREATE TABLE IF NOT EXISTS "纪要表" ("时间跨度" TEXT, "概览" TEXT)',
			changes: 0,
			at: 1,
		},
		{
			op: "insert",
			sql: "INSERT INTO 纪要表 (时间跨度, 概览) VALUES ('第一天', 'A')",
			changes: 1,
			at: 2,
		},
		{
			op: "insert",
			sql: "INSERT INTO 纪要表 (时间跨度, 概览) VALUES ('第二天', 'B')",
			changes: 1,
			at: 3,
		},
	];
	const r = replayBranch(svc, logs);
	assert.equal(r.kind, "ok");
	if (r.kind !== "ok") return;
	assert.equal(r.replayed, 3);
	const q = svc.execRead("SELECT COUNT(*) AS n FROM 纪要表");
	assert.equal(q.ok, true);
	if (q.ok) assert.equal((q.rows![0] as { n: number }).n, 2);
	svc.close();
});

test("replayBranch：重复重放幂等（清表后重建）", () => {
	const svc = makeSvc("b");
	const logs: TableLogEntry[] = [
		{ op: "create", sql: 'CREATE TABLE IF NOT EXISTS "t" ("x" TEXT)', changes: 0, at: 1 },
		{ op: "insert", sql: "INSERT INTO t (x) VALUES ('a')", changes: 1, at: 2 },
	];
	assert.equal(replayBranch(svc, logs).kind, "ok");
	assert.equal(replayBranch(svc, logs).kind, "ok", "二次重放仍 ok");
	const q = svc.execRead("SELECT COUNT(*) AS n FROM t");
	if (q.ok) assert.equal((q.rows![0] as { n: number }).n, 1, "清表重放不叠加");
	svc.close();
});

test("replayBranch：空日志 → 不动物化（迁移基线；2026-08-16 事故回归）", () => {
	const svc = makeSvc("c");
	svc.createTable({ name: "遗留表", auto: false, columns: [{ name: "a", type: "text" }] });
	svc.execWrite("INSERT INTO 遗留表 (a) VALUES ('迁移数据')");
	const r = replayBranch(svc, []);
	assert.equal(r.kind, "ok");
	if (r.kind === "ok") assert.equal(r.baseline, true);
	const q = svc.execRead("SELECT * FROM 遗留表");
	assert.equal(q.ok, true, "空日志不清空物化（迁移基线数据保留）");
	if (q.ok) assert.equal(q.rows!.length, 1);
	svc.close();
});

test("replayBranch：失败停点返回 failedSql", () => {
	const svc = makeSvc("d");
	const logs: TableLogEntry[] = [
		{ op: "insert", sql: "INSERT INTO 不存在的表 (x) VALUES (1)", changes: 1, at: 1 },
	];
	const r = replayBranch(svc, logs);
	assert.equal(r.kind, "failed");
	if (r.kind === "failed") assert.ok(r.failedSql?.includes("不存在的表"));
	svc.close();
});

test("collectTableLogs：从树条目提取 rp-table-log，忽略其他条目", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [] } },
		{ type: "custom", customType: "rp-state", data: { time: "x" } },
		{ type: "custom", customType: "rp-table-log", data: { op: "insert", sql: "INSERT INTO t VALUES (1)", changes: 1, at: 5 } },
		{ type: "custom", customType: "rp-table-log", data: { op: "bad" } },
	];
	const logs = collectTableLogs(branch);
	assert.equal(logs.length, 1);
	assert.equal(logs[0]!.sql, "INSERT INTO t VALUES (1)");
});

// ---------------- 检查点增量重放（2026-08-16 二版） ----------------

const mkBranch = (entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> => entries;

test("replayFromCheckpoint：基线锁定（无检查点）→ 不动；检查点后增量重放", () => {
	const svc = makeSvc("cp1");
	// 迁移基线数据（无日志）
	svc.createTable({ name: "迁移表", auto: false, columns: [{ name: "a", type: "text" }] });
	svc.execWrite("INSERT INTO 迁移表 (a) VALUES ('基线数据')");
	// 无检查点 → 不重放不动物化
	const r0 = replayFromCheckpoint(svc, mkBranch([{ id: "msg-1", type: "message" }]), null);
	assert.equal(r0.kind, "ok");
	if (r0.kind === "ok") assert.equal(r0.baseline, true);
	const q0 = svc.execRead("SELECT * FROM 迁移表");
	assert.equal(q0.ok, true, "基线数据保留");

	// 检查点锁定在 msg-1 之后 → 增量重放其后的日志
	const branch = [
		{ id: "msg-1", type: "message" },
		{ id: "log-1", type: "custom", customType: "rp-table-log", data: { op: "insert", sql: "INSERT INTO 迁移表 (a) VALUES ('新数据')", changes: 1, at: 2 } },
	];
	const r1 = replayFromCheckpoint(svc, branch, "msg-1");
	assert.equal(r1.kind, "ok");
	if (r1.kind === "ok") assert.equal(r1.replayed, 1);
	const q1 = svc.execRead("SELECT a FROM 迁移表 ORDER BY a");
	if (q1.ok) {
		const vals = JSON.parse(JSON.stringify(q1.rows)).map((r) => r.a);
		assert.deepEqual(vals, ["基线数据", "新数据"], "增量叠加不清空");
	}
	// 幂等：同检查点再跑 → 再插一条（增量重放无去重——调用方靠 #lastReplayKey 跳过）
	svc.close();
});

test("replayFromCheckpoint：检查点不在分支 → 不动物化（回退更早分支保守）", () => {
	const svc = makeSvc("cp2");
	svc.createTable({ name: "t", auto: false, columns: [{ name: "a", type: "text" }] });
	svc.execWrite("INSERT INTO t (a) VALUES ('保留')");
	const branch = [
		{ id: "other-branch-msg", type: "message" },
		{ id: "log-9", type: "custom", customType: "rp-table-log", data: { op: "insert", sql: "INSERT INTO t (a) VALUES ('不应重放')", changes: 1, at: 9 } },
	];
	const r = replayFromCheckpoint(svc, branch, "checkpoint-in-other-branch");
	assert.equal(r.kind, "ok");
	if (r.kind === "ok") assert.equal(r.baseline, true);
	const q = svc.execRead("SELECT a FROM t");
	if (q.ok) assert.equal(q.rows!.length, 1, "只保留原数据");
	svc.close();
});

test.after(() => {
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		// 句柄延迟：忽略
	}
});
