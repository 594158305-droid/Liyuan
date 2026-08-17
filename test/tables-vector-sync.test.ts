import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	chunkIdOf,
	clearTableVec,
	removeTableVec,
	rowText,
	searchTableRows,
	syncTableRows,
	tableVecSize,
} from "../src/tables/vector-sync.ts";
import type { MemoryScope } from "../src/memory/config.ts";

/**
 * 表格行向量同步（DESIGN-tables-vector P1）：独立文件、行级 upsert/清理、
 * 余弦检索与阈值过滤、降级健壮性。嵌入用默认 local（临时目录无 memory 配置）。
 */

const tmp = mkdtempSync(join(tmpdir(), "tables-vec-"));
const cwd = tmp;
const scope: MemoryScope = { sessionId: "sess-1", card: "cards/x.json" };

// 预置 .liyuan-memory 目录结构（loadMemoryConfig 无文件时回默认 local）
mkdirSync(join(cwd, ".liyuan-memory"), { recursive: true });

test("rowText：序列化与 chunkId 稳定", () => {
	assert.equal(rowText("纪要表", { __rowid: 1, 时间跨度: "第一天", 概览: "茶会", 纪要: "" }), "纪要表｜时间跨度=第一天；概览=茶会");
	assert.equal(chunkIdOf("纪要表", 12), "tables:纪要表:12");
});

test("syncTableRows：新增/更新/移除三态 + 检索命中", async () => {
	await syncTableRows(cwd, scope, "纪要表", [
		{ rowid: 1, text: rowText("纪要表", { 时间跨度: "第一天", 概览: "茶会", 纪要: "凯尔与赫斯提雅开茶会" }) },
		{ rowid: 2, text: rowText("纪要表", { 时间跨度: "第二天", 概览: "吻别", 纪要: "千束在旅馆门口吻别" }) },
	]);
	assert.equal(tableVecSize(cwd, scope), 2);

	// 命中：查「茶会」相关（local hash 嵌入是宽匹配——验证首位最相关即可）
	const hits = await searchTableRows(cwd, scope, "凯尔 赫斯提雅 茶会", 6, 0.05);
	assert.ok(hits.length >= 1);
	assert.equal(hits[0]!.rowid, 1, "最相关应为茶会行");
	assert.ok(hits[0]!.text.includes("茶会"));

	// 更新行 1 文本
	const r = await syncTableRows(cwd, scope, "纪要表", [
		{ rowid: 1, text: rowText("纪要表", { 时间跨度: "第一天", 概览: "茶会（改）", 纪要: "改动后的内容" }) },
		{ rowid: 2, text: rowText("纪要表", { 时间跨度: "第二天", 概览: "吻别", 纪要: "千束在旅馆门口吻别" }) },
	]);
	assert.equal(r.updated, 1);
	assert.equal(tableVecSize(cwd, scope), 2);

	// 移除行 2
	const r2 = await syncTableRows(cwd, scope, "纪要表", [
		{ rowid: 1, text: rowText("纪要表", { 时间跨度: "第一天", 概览: "茶会（改）", 纪要: "改动后的内容" }) },
	]);
	assert.equal(r2.removed, 1);
	assert.equal(tableVecSize(cwd, scope), 1);
});

test("searchTableRows：阈值过滤与 topK 截断", async () => {
	await clearTableVec(cwd, scope);
	await syncTableRows(cwd, scope, "主角技能表", [
		{ rowid: 1, text: rowText("主角技能表", { 技能名称: "魅惑口才", 技能经验值: 3 }) },
		{ rowid: 2, text: rowText("主角技能表", { 技能名称: "战术侦察", 技能经验值: 5 }) },
		{ rowid: 3, text: rowText("主角技能表", { 技能名称: "邪神纹章", 技能经验值: 1 }) },
	]);
	const hit = await searchTableRows(cwd, scope, "战术侦察", 6, 0.05);
	assert.ok(hit.length >= 1);
	assert.equal(hit[0]!.rowid, 2, "最相关应为战术侦察行");
	// 高阈值过滤全部
	const none = await searchTableRows(cwd, scope, "完全不相关的话题", 6, 0.9);
	assert.equal(none.length, 0);
	// 空查询
	assert.deepEqual(await searchTableRows(cwd, scope, "  ", 6, 0.05), []);
});

test("removeTableVec / clearTableVec：删表与全清", async () => {
	await syncTableRows(cwd, scope, "备忘录", [{ rowid: 1, text: rowText("备忘录", { 备忘标题: "测试" }) }]);
	assert.equal(tableVecSize(cwd, scope), 4); // 主角技能表 3 + 备忘录 1
	removeTableVec(cwd, scope, "备忘录");
	assert.equal(tableVecSize(cwd, scope), 3);
	clearTableVec(cwd, scope);
	assert.equal(tableVecSize(cwd, scope), 0);
});

test("空库检索：无 chunks 不嵌入直接空返回", async () => {
	clearTableVec(cwd, scope);
	assert.deepEqual(await searchTableRows(cwd, scope, "任意", 6, 0.05), []);
});

test("坏行容错：损坏行跳过不炸", async () => {
	const { tableVecFile } = await import("../src/tables/vector-sync.ts");
	const p = tableVecFile(cwd, scope);
	writeFileSync(p, "{bad json\n" + JSON.stringify({ id: "tables:测试表:1", table: "测试表", rowid: 1, text: "测试表｜a=1", embedding: new Array(256).fill(0) }) + "\n", "utf8");
	const size = tableVecSize(cwd, scope);
	assert.equal(size, 1, "坏行跳过，好行保留");
});

test.after(() => {
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		// 句柄延迟忽略
	}
});
