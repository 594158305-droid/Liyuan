import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildScribeAgentSystemPrompt,
	buildScribeAgentUserText,
	makeSqlExec,
	scribeAgentToolSchemas,
	tableOfSql,
} from "../src/stage/scribe-agent.ts";
import { runScribeTurn, type ScribeRunDeps } from "../src/stage/scribe-run.ts";
import { defaultState } from "../src/state.ts";
import type { TableDef } from "../src/tables/service.ts";
import type { WorldState } from "../src/types.ts";

/**
 * 场记表格维护代理（DESIGN-tables-sql §5）：模型按维护规则用 sql_read/sql_write
 * 自主查写，写库即持久。本文件钉死执行器行为与 runScribeTurn 代理路径。
 */

const meta: Record<string, TableDef> = {
	纪要表: {
		name: "纪要表",
		auto: true,
		description: "每轮新增一条纪要",
		columns: [{ name: "时间跨度", type: "text" }, { name: "概览", type: "text" }],
	},
	角色状态效果表: {
		name: "角色状态效果表",
		auto: true,
		description: "失效即删",
		columns: [{ name: "角色名称", type: "text", primary: true }, { name: "状态名称", type: "text", primary: true }, { name: "失效时间", type: "number" }],
	},
};

// ---------------- 执行器 ----------------

test("makeSqlExec：read 返回行、write 报 changes 并回调", async () => {
	const writes: Array<{ sql: string; changes: number }> = [];
	const exec = makeSqlExec(
		{
			execRead: async (sql) => ({ ok: true, rows: [{ n: 112 }] }),
			execWrite: async (sql) => ({ ok: true, changes: 1 }),
		},
		(sql, changes) => writes.push({ sql, changes }),
	);
	const read = await exec("sql_read", { sql: "SELECT COUNT(*) AS n FROM 纪要表" });
	assert.ok(read.text.includes("112"));
	const write = await exec("sql_write", { sql: "INSERT INTO 纪要表 (时间跨度, 概览) VALUES ('x','y')" });
	assert.ok(write.text.includes("1 行"));
	assert.deepEqual(writes, [{ sql: "INSERT INTO 纪要表 (时间跨度, 概览) VALUES ('x','y')", changes: 1 }]);
});

test("makeSqlExec：SQL 报错原样外露", async () => {
	const exec = makeSqlExec({
		execRead: async () => ({ ok: false, error: "no such table: 不存在的表" }),
		execWrite: async () => ({ ok: false, error: "UNIQUE constraint failed" }),
	});
	const r1 = await exec("sql_read", { sql: "SELECT * FROM 不存在的表" });
	assert.equal(r1.isError, true);
	assert.ok(r1.text.includes("no such table"), r1.text);
	const r2 = await exec("sql_write", { sql: "INSERT INTO t VALUES (1)" });
	assert.equal(r2.isError, true);
	assert.ok(r2.text.includes("UNIQUE"), r2.text);
});

test("工具 schema：sql_read/sql_write 两件且描述达标", () => {
	const names = scribeAgentToolSchemas().map((t) => t.name);
	assert.deepEqual(names, ["sql_read", "sql_write"]);
	for (const t of scribeAgentToolSchemas()) {
		assert.ok(t.description.length > 20, `${t.name} 描述`);
		assert.equal((t.parameters as { type: string }).type, "object");
	}
});

test("buildScribeAgentSystemPrompt：含各表维护规则、不含任何行数据", () => {
	const sys = buildScribeAgentSystemPrompt(["纪要表", "角色状态效果表"], (name) => meta[name] ?? null);
	assert.ok(sys.includes("纪要表"));
	assert.ok(sys.includes("维护规则"));
	assert.ok(sys.includes("sql_read"), "提示词点名工具");
	assert.ok(!sys.includes("112"), "不得含行数据");
	assert.ok(buildScribeAgentUserText("本轮对话内容").includes("本轮对话"));
});

test("tableOfSql：写语句提取表名", () => {
	assert.equal(tableOfSql("INSERT INTO 纪要表 (a) VALUES (1)"), "纪要表");
	assert.equal(tableOfSql('UPDATE "角色状态效果表" SET x=1 WHERE y=2'), "角色状态效果表");
	assert.equal(tableOfSql("DELETE FROM `t` WHERE id=1"), "t");
	assert.equal(tableOfSql("WITH x AS (SELECT 1) SELECT * FROM x"), "?");
});

// ---------------- runScribeTurn 代理路径 ----------------

test("runScribeTurn：注入 agentTableMaintain 时 tables-only 走代理（不触发旧全表旁路）", async () => {
	let agentCalls = 0;
	let sideTextCalls = 0;
	const deps: ScribeRunDeps & { activities: string[] } = {
		activities: [],
		sideText: async () => {
			sideTextCalls++;
			return { error: "不应走到旧全表旁路" };
		},
		agentTableMaintain: async ({ todo, dialogue }) => {
			agentCalls++;
			assert.ok(todo.includes("纪要表"), `todo 应含强制入列的纪要表：${todo.join(",")}`);
			assert.ok(dialogue.includes("沈舟："));
			return { applied: ["表 纪要表 写入 1 行"] };
		},
		getLeafId: () => "leaf-1",
		onActivity: (d) => deps.activities.push(d),
	};
	const state: WorldState = {
		...defaultState(),
		tables: {
			纪要表: { name: "纪要表", auto: true, columns: [{ name: "时间跨度", type: "text" }], rows: [] },
			角色状态效果表: { name: "角色状态效果表", auto: true, columns: [{ name: "角色名称", type: "text" }], rows: [] },
		},
	};
	const r = await runScribeTurn(deps, {
		state,
		userText: "我把怀表递给她。",
		assistantText: "云澜接过怀表。",
		charName: "云澜",
		userName: "沈舟",
		scope: "tables-only",
	});
	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	assert.equal(agentCalls, 1);
	assert.equal(sideTextCalls, 0, "代理路径不得触发旧全表旁路");
	assert.deepEqual(r.applied, ["表 纪要表 写入 1 行"]);
	assert.equal(r.state, undefined, "SQL 化：代理不产生 WorldState");
});

test("runScribeTurn：代理报错且零应用 → failed；零应用无错误 → skipped", async () => {
	const input = {
		state: {
			...defaultState(),
			tables: {
				纪要表: { name: "纪要表", auto: true, columns: [{ name: "时间跨度", type: "text" }, { name: "纪要", type: "text" }], rows: [] },
			},
		},
		userText: "a",
		assistantText: "b",
		charName: "云澜",
		userName: "沈舟",
		scope: "tables-only" as const,
	};
	const deps: ScribeRunDeps = {
		sideText: async () => ({ error: "x" }),
		agentTableMaintain: async () => ({ applied: [], error: "代理失败" }),
		getLeafId: () => "leaf-1",
	};
	assert.equal((await runScribeTurn(deps, input)).kind, "failed");
	const deps2: ScribeRunDeps = {
		sideText: async () => ({ error: "x" }),
		agentTableMaintain: async () => ({ applied: [] }),
		getLeafId: () => "leaf-1",
	};
	assert.equal((await runScribeTurn(deps2, input)).kind, "skipped");
});
