import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TablesService, type TableDef } from "../src/tables/service.ts";

/**
 * TablesService（DESIGN-tables-sql §4）：临时 db 全链路——建表/元数据/读写 SQL/
 * 报错外露/日志回调/检查点。
 */

const tmp = mkdtempSync(join(tmpdir(), "tables-svc-"));
const makeSvc = (): TablesService => new TablesService(join(tmp, `s-${Math.random().toString(36).slice(2, 8)}.db`));

const jiyaoDef: TableDef = {
	name: "纪要表",
	auto: true,
	description: "每轮新增一条纪要",
	columns: [
		{ name: "时间跨度", type: "text" },
		{ name: "概览", type: "text" },
		{ name: "纪要", type: "text" },
	],
};

const zhuangtaiDef: TableDef = {
	name: "角色状态效果表",
	auto: true,
	description: "状态效果，主键=角色+状态",
	columns: [
		{ name: "角色名称", type: "text", primary: true },
		{ name: "状态名称", type: "text", primary: true },
		{ name: "层数", type: "number" },
		{ name: "失效时间", type: "number" },
	],
};

test("createTable + listTables + getMeta：定义进 __meta，行数实时", () => {
	const svc = makeSvc();
	assert.equal(svc.createTable(jiyaoDef).ok, true);
	assert.equal(svc.createTable(zhuangtaiDef).ok, true);
	const list = svc.listTables();
	assert.equal(list.length, 2);
	const j = list.find((t) => t.name === "纪要表")!;
	assert.equal(j.auto, true);
	assert.equal(j.rowCount, 0);
	assert.deepEqual(svc.getMeta("角色状态效果表")?.columns.map((c) => c.name), ["角色名称", "状态名称", "层数", "失效时间"]);
	svc.close();
});

test("createTable：非法表名/列名拒绝，重复列拒绝", () => {
	const svc = makeSvc();
	assert.equal(svc.createTable({ ...jiyaoDef, name: "a;DROP" }).ok, false);
	assert.equal(svc.createTable({ ...jiyaoDef, name: "__x" }).ok, false);
	assert.equal(
		svc.createTable({ ...jiyaoDef, columns: [{ name: "a", type: "text" }, { name: "a", type: "number" }] }).ok,
		false,
	);
	assert.equal(svc.createTable({ ...jiyaoDef, columns: [] }).ok, false);
	svc.close();
});

test("execRead / execWrite：SQL 全链路 + 日志回调", () => {
	const svc = makeSvc();
	svc.createTable(jiyaoDef);
	const logs: string[] = [];
	svc.onWrite = (e) => logs.push(`${e.op}:${e.changes}`);
	const ins = svc.execWrite("INSERT INTO 纪要表 (时间跨度, 概览, 纪要) VALUES ('第三天', '茶会', '…')");
	assert.equal(ins.ok, true);
	const read = svc.execRead("SELECT COUNT(*) AS n FROM 纪要表");
	assert.equal(read.ok, true);
	if (read.ok) assert.equal((read.rows![0] as { n: number }).n, 1);
	const upd = svc.execWrite("UPDATE 纪要表 SET 概览 = '茶会（改）' WHERE 时间跨度 = '第三天'");
	assert.equal(upd.ok, true);
	assert.deepEqual(logs, ["insert:1", "update:1"]);
	svc.close();
});

test("报错外露：no such table / no such column / 主键冲突", () => {
	const svc = makeSvc();
	svc.createTable(zhuangtaiDef);
	const e1 = svc.execRead("SELECT * FROM 不存在的表");
	assert.equal(e1.ok, false);
	if (!e1.ok) assert.ok(e1.error.includes("no such table"), e1.error);
	const e2 = svc.execWrite("INSERT INTO 角色状态效果表 (不存在的列) VALUES (1)");
	assert.equal(e2.ok, false);
	if (!e2.ok) assert.ok(/no such column|has no column/i.test(e2.error), e2.error);
	assert.equal(svc.execWrite("INSERT INTO 角色状态效果表 (角色名称, 状态名称, 层数) VALUES ('凯尔', '邪神纹章', 1)").ok, true);
	const dup = svc.execWrite("INSERT INTO 角色状态效果表 (角色名称, 状态名称, 层数) VALUES ('凯尔', '邪神纹章', 2)");
	assert.equal(dup.ok, false, "主键冲突");
	if (!dup.ok) assert.ok(dup.error.includes("UNIQUE"), dup.error);
	svc.close();
});

test("外键约束：引用不存在的值拒绝", () => {
	const svc = makeSvc();
	svc.createTable({
		name: "世界地图点",
		auto: false,
		columns: [{ name: "地点名称", type: "text", primary: true }],
	});
	svc.createTable({
		name: "纪要表",
		auto: true,
		columns: [
			{ name: "时间跨度", type: "text" },
			{ name: "地点", type: "text", ref: { table: "世界地图点", column: "地点名称" } },
		],
	});
	const bad = svc.execWrite("INSERT INTO 纪要表 (时间跨度, 地点) VALUES ('x', '不存在的城市')");
	assert.equal(bad.ok, false, "FK 约束");
	if (!bad.ok) assert.ok(bad.error.includes("FOREIGN KEY"), bad.error);
	svc.close();
});

test("clearUserTables + rawExec：重放基元", () => {
	const svc = makeSvc();
	svc.createTable(jiyaoDef);
	svc.execWrite("INSERT INTO 纪要表 (时间跨度, 概览, 纪要) VALUES ('a', 'b', 'c')");
	svc.clearUserTables();
	const gone = svc.execRead("SELECT * FROM 纪要表");
	assert.equal(gone.ok, false, "表已清空");
	const r = svc.rawExec("CREATE TABLE IF NOT EXISTS \"纪要表\" (\"时间跨度\" TEXT, \"概览\" TEXT, \"纪要\" TEXT)");
	assert.equal(r.ok, true);
	const back = svc.rawExec("INSERT INTO 纪要表 (时间跨度, 概览, 纪要) VALUES ('a', 'b', 'c')");
	assert.equal(back.ok, true);
	svc.close();
});

test("STRICT：number 列写字符串报错外露（类型不符不再静默）", () => {
	const svc = makeSvc();
	svc.createTable({ name: "测试表", auto: false, columns: [{ name: "层数", type: "number" }] });
	const bad = svc.execWrite("INSERT INTO 测试表 (层数) VALUES ('skill_exp + 2')");
	assert.equal(bad.ok, false, "STRICT 表类型不符应报错");
	if (!bad.ok) assert.ok(/cannot store|datatype/i.test(bad.error), bad.error);
	const good = svc.execWrite("INSERT INTO 测试表 (层数) VALUES (2)");
	assert.equal(good.ok, true);
	svc.close();
});

test("createTable：表已存在时增量加列 + 斜杠列名规整（meta 与实表不再脱节）", () => {
	const svc = makeSvc();
	svc.createTable({ name: "在场角色表", auto: true, columns: [{ name: "姓名", type: "text" }, { name: "当前状态", type: "text" }] });
	// 第二次 create：meta 带新列 → 实际表增量加列；斜杠列名统一规整为「内衣与内裤」
	const r = svc.createTable({
		name: "在场角色表",
		auto: true,
		columns: [{ name: "姓名", type: "text" }, { name: "当前状态", type: "text" }, { name: "内衣/内裤", type: "text" }],
	});
	assert.equal(r.ok, true);
	// 规整后的列名（内衣与内裤）可写
	const w = svc.execWrite('INSERT INTO 在场角色表 (姓名, 当前状态, "内衣与内裤") VALUES (\'凯尔\', \'祈祷\', \'黑色蕾丝\')');
	assert.equal(w.ok, true, "规整列名增量加列后可写");
	// 原数据保留
	const q = svc.execRead("SELECT COUNT(*) AS n FROM 在场角色表");
	if (q.ok) assert.equal((q.rows![0] as { n: number }).n, 1);
	// __meta 里列名已规整
	const meta = svc.getMeta("在场角色表");
	assert.ok(meta, "meta 存在");
	assert.ok(!(meta!.columns ?? []).some((c) => c.name.includes("/")), "__meta 列名已规整，无斜杠");
	svc.close();
});

test("createTable：物理表已含斜杠旧列 → 建表时 RENAME 迁移为规整列名（保留数据）", () => {
	const svc = makeSvc();
	svc.createTable({ name: "现场表", auto: true, columns: [{ name: "姓名", type: "text" }] });
	svc.rawExec('ALTER TABLE "现场表" ADD COLUMN "内衣/内裤" TEXT');
	svc.rawExec('INSERT INTO 现场表 (姓名, "内衣/内裤") VALUES (\'凯尔\', \'黑色\')');
	// 再次 create：目标列名带斜杠，但物理表里旧列已存在 → RENAME 到规整名
	const r = svc.createTable({ name: "现场表", auto: true, columns: [{ name: "姓名", type: "text" }, { name: "内衣/内裤", type: "text" }] });
	assert.equal(r.ok, true);
	// 规整列名可查且数据保留
	const q = svc.execRead('SELECT "内衣与内裤" AS c FROM 现场表');
	assert.equal(q.ok, true, "规整列可查");
	assert.equal((q.rows![0] as { c: string }).c, "黑色", "RENAME 迁移保留数据");
	svc.close();
});

test("checkpoint：读写往返", () => {
	const svc = makeSvc();
	assert.deepEqual(svc.getCheckpoint(), { throughEntryId: null, at: null });
	svc.setCheckpoint("entry-42");
	const cp = svc.getCheckpoint();
	assert.equal(cp.throughEntryId, "entry-42");
	assert.ok(cp.at !== null);
	svc.close();
});

test("SQL 校验接入：guard 拒绝先于执行", () => {
	const svc = makeSvc();
	svc.createTable(jiyaoDef);
	const r = svc.execWrite("UPDATE 纪要表 SET 概览 = 'x'");
	assert.equal(r.ok, false, "无 WHERE 被 guard 拒绝");
	if (!r.ok) assert.ok(r.error.includes("WHERE"), r.error);
	const d = svc.execWrite("DROP TABLE 纪要表");
	assert.equal(d.ok, false, "DROP 被 guard 拒绝");
	svc.close();
});

// 清理（Windows 上 SQLite 句柄关闭有延迟，EPERM 容错）
test.after(() => {
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		// 句柄延迟：忽略，临时目录由系统清理
	}
});
