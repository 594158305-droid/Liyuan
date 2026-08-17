import assert from "node:assert/strict";
import { test } from "node:test";

import { guardRead, guardWrite, scanSql } from "../src/tables/sql-guard.ts";

/**
 * SQL 校验器（DESIGN-tables-sql §6）：语句类型白名单 + 危险黑名单 + WHERE 强制 + 单语句。
 * 字符串/标识符字面量内的关键字与分号不误判。
 */

// ---------------- scanSql（扫描基础） ----------------

test("scanSql：字符串与标识符内的关键字/分号不出现在 tokens/semicolons", () => {
	const s = scanSql("SELECT * FROM t WHERE 备注 = 'DROP TABLE; -- 假' AND `weird;col` = 1");
	assert.ok(s.tokens.some((t) => t.word === "SELECT"));
	assert.ok(!s.tokens.some((t) => t.word === "DROP"));
	assert.equal(s.semicolons, 0, "字符串/反引号内的分号不算");
});

test("scanSql：注释跳过（行注释与块注释）", () => {
	assert.ok(!scanSql("SELECT 1 -- DROP TABLE\nFROM t").tokens.some((t) => t.word === "DROP"));
	assert.ok(!scanSql("SELECT 1 /* PRAGMA x */ FROM t").tokens.some((t) => t.word === "PRAGMA"));
	assert.ok(scanSql("/* 前导注释 */ SELECT 1").tokens[0]!.word === "SELECT", "注释后仍能取到语句类型");
});

test("scanSql：尾部分号 vs 多语句判定", () => {
	const tail = scanSql("SELECT 1;");
	assert.equal(tail.semicolons, 1);
	assert.equal(tail.tailAfterLastSemicolon, false, "尾部分号后无内容");
	const multi = scanSql("SELECT 1; SELECT 2");
	assert.equal(multi.semicolons, 1, "只有一个分号");
	assert.equal(multi.tailAfterLastSemicolon, true, "分号后还有内容 = 多语句");
});

// ---------------- guardRead ----------------

test("guardRead：SELECT 放行（含 JOIN/聚合/子查询/CTE）", () => {
	for (const sql of [
		"SELECT * FROM 纪要表",
		"SELECT COUNT(*) AS n FROM 纪要表",
		"SELECT 角色名称, MAX(层数) FROM 角色状态效果表 GROUP BY 角色名称",
		"SELECT * FROM 纪要表 t JOIN 世界地图点 m ON t.地点 = m.地点名称 WHERE m.上级地区 LIKE '%王都%'",
		"SELECT * FROM (SELECT * FROM 纪要表 ORDER BY 时间跨度 DESC LIMIT 3)",
		"WITH 近期 AS (SELECT * FROM 纪要表 ORDER BY 时间跨度 DESC LIMIT 3) SELECT * FROM 近期",
	]) {
		const r = guardRead(sql);
		assert.equal(r.ok, true, sql);
	}
});

test("guardRead：非 SELECT 拒绝", () => {
	const r = guardRead("INSERT INTO t VALUES (1)");
	assert.equal(r.ok, false);
	if (!r.ok) assert.ok(r.error.includes("SELECT"), r.error);
	assert.equal(guardRead("").ok, false);
	assert.equal(guardRead("   ").ok, false);
});

test("guardRead：危险语句拒绝", () => {
	for (const sql of [
		"SELECT * FROM t; DROP TABLE t",
		"SELECT * FROM t WHERE x = (SELECT 1); PRAGMA journal_mode",
		"SELECT * FROM t UNION SELECT 1 FROM t2; ATTACH 'x' AS y",
	]) {
		const r = guardRead(sql);
		assert.equal(r.ok, false, sql);
	}
});

test("guardRead：字符串里的危险词不误杀", () => {
	const r = guardRead("SELECT 备注 FROM 纪要表 WHERE 备注 = 'DROP TABLE 是危险操作'");
	assert.equal(r.ok, true);
});

// ---------------- guardWrite ----------------

test("guardWrite：INSERT/UPDATE/DELETE（带 WHERE）放行", () => {
	for (const sql of [
		"INSERT INTO 纪要表 (时间跨度, 概览, 纪要, 重要对话) VALUES ('第三天', '茶会', '…', '…')",
		"UPDATE 角色状态效果表 SET 层数 = 2 WHERE 角色名称 = '凯尔' AND 状态名称 = '邪神纹章'",
		"DELETE FROM 角色状态效果表 WHERE 失效时间 <= 1786800000 AND 状态 = '有效'",
	]) {
		const r = guardWrite(sql);
		assert.equal(r.ok, true, sql);
	}
});

test("guardWrite：UPDATE/DELETE 无 WHERE 拒绝（防全表误操作）", () => {
	for (const sql of ["UPDATE t SET x = 1", "DELETE FROM t"]) {
		const r = guardWrite(sql);
		assert.equal(r.ok, false, sql);
		if (!r.ok) assert.ok(r.error.includes("WHERE"), r.error);
	}
});

test("guardWrite：SELECT 与危险语句拒绝", () => {
	assert.equal(guardWrite("SELECT * FROM t").ok, false);
	assert.equal(guardWrite("DROP TABLE 纪要表").ok, false);
	assert.equal(guardWrite("CREATE TABLE x (a)").ok, false);
	assert.equal(guardWrite("BEGIN TRANSACTION").ok, false);
});

test("guardWrite：INSERT 里的子查询/多行 VALUES 放行", () => {
	const r = guardWrite(
		"INSERT INTO 纪要表 (时间跨度, 概览) SELECT 时间跨度, 概览 FROM 旧表 WHERE 时间跨度 > 'X'",
	);
	assert.equal(r.ok, true);
});

test("guardWrite：CTE 内 SELECT 不误判主类型（INSERT 主语句 + CTE 子查询）", () => {
	const r = guardWrite(
		"WITH 近期 AS (SELECT * FROM 纪要表 ORDER BY 时间跨度 DESC LIMIT 3) INSERT INTO 副本 SELECT * FROM 近期",
	);
	assert.equal(r.ok, true);
});

test("guardWrite：UPDATE 的 WHERE 只认顶层——子查询里的 WHERE 不能顶替", () => {
	const r = guardWrite("UPDATE t SET x = (SELECT MAX(n) FROM t2 WHERE a = 1)");
	assert.equal(r.ok, false, "主语句无顶层 WHERE → 拒绝");
	if (!r.ok) assert.ok(r.error.includes("WHERE"), r.error);
	// 带顶层 WHERE 则放行
	const ok = guardWrite("UPDATE t SET x = (SELECT MAX(n) FROM t2 WHERE a = 1) WHERE id = 2");
	assert.equal(ok.ok, true);
});

test("guardWrite：多语句拒绝（分号拼接）", () => {
	const r = guardWrite("DELETE FROM t WHERE id = 1; DROP TABLE t");
	assert.equal(r.ok, false);
});
