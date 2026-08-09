import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildTableBackfillPrompt,
	parseTableBackfillOps,
	runTableBackfill,
	type TableBackfillDeps,
} from "../src/table-backfill.ts";
import { applyTableOperation, defaultState } from "../src/state.ts";
import { chunkMessagesForSummary } from "../src/chatlog.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";
import type { CustomTable, WorldState } from "../src/types.ts";

/** 造一条叙事楼层（rebuildHistory 消费的 message 条目） */
const msg = (role: "user" | "assistant", text: string, name = "发言人"): BranchEntryLike => ({
	type: "message",
	message: { role, content: [{ type: "text", text }] },
});

/** 造足够长的历史，让默认 25000 字符预算切成多块 */
const longHistory = (n: number): BranchEntryLike[] => {
	const out: BranchEntryLike[] = [];
	for (let i = 0; i < n; i++) {
		out.push(msg("user", `第${i}轮-` + "字".repeat(2600)));
		out.push(msg("assistant", `回${i}轮-` + "字".repeat(2600), "青梧"));
	}
	return out;
};

const deps = (over: Partial<TableBackfillDeps>): TableBackfillDeps => ({
	branchEntries: [],
	state: defaultState(),
	tableName: "主角信息",
	userName: "阿远",
	charName: "青梧",
	sideText: async () => '{"insert":[],"update":[],"delete":[]}',
	...over,
});

test("buildTableBackfillPrompt：含表名/列名/当前状态/历史片段", () => {
	const table: CustomTable = { name: "主角信息", columns: [{ name: "姓名" }, { name: "体力", type: "integer" }], rows: [] };
	const snapshot = JSON.stringify(table);
	const { systemPrompt, userText } = buildTableBackfillPrompt(table, snapshot, "阿远说：我刚喝了药。");
	assert.ok(systemPrompt.includes("主角信息"), "system 含表名");
	assert.ok(systemPrompt.includes("姓名"), "system 含列名");
	assert.ok(systemPrompt.includes("体力（integer）"), "system 含列类型");
	assert.ok(systemPrompt.includes("insert"), "system 说明输出格式");
	assert.ok(userText.includes("主角信息"), "user 含当前表状态");
	assert.ok(userText.includes("我刚喝了药"), "user 含历史片段");
	assert.ok(userText.includes("【当前表状态】"));
	assert.ok(userText.includes("【历史片段】"));
});

test("parseTableBackfillOps：合法 JSON / 围栏 / 前言带 { / 垃圾输入", () => {
	const valid = '{"insert":[{"姓名":"阿远","体力":80}],"update":[],"delete":[]}';
	const ops = parseTableBackfillOps(valid);
	assert.ok(ops);
	assert.deepEqual(ops.insert, [{ 姓名: "阿远", 体力: 80 }]);

	// 围栏包裹
	const fenced = '```json\n{"insert":[{"姓名":"小红"}]}\n```';
	assert.deepEqual(parseTableBackfillOps(fenced)?.insert, [{ 姓名: "小红" }]);

	// 前言带 {（如解释性文本里出现孤 {），仍能切到真正的 JSON
	const prelude = '我先看看：这里有个 {"说法"} 不太对。\n好了：{"insert":[{"姓名":"小明"}]}';
	const withPrelude = parseTableBackfillOps(prelude);
	assert.ok(withPrelude, "前言含孤 { 也能解析出 ops");
	assert.deepEqual(withPrelude!.insert, [{ 姓名: "小明" }]);

	// 纯垃圾 / 空 / 无数组键的对象 → null
	assert.equal(parseTableBackfillOps("什么都不是"), null);
	assert.equal(parseTableBackfillOps(""), null);
	assert.equal(parseTableBackfillOps('{"foo":1}'), null, "无 insert/update/delete 键的对象不算命中");
	assert.equal(parseTableBackfillOps("{not json"), null);
});

test("runTableBackfill：表不存在 → ok:false", async () => {
	const r = await runTableBackfill(deps({ tableName: "不存在的表" }));
	assert.equal(r.ok, false);
	if (!r.ok) assert.ok(r.error.includes("不存在"));
});

test("runTableBackfill：空历史 → ok:false", async () => {
	// 全空分支
	assert.equal((await runTableBackfill(deps({ branchEntries: [] }))).ok, false);
	// 只有非叙事条目（如 rp-state 快照）→ 历史仍为空
	const state = defaultState();
	applyTableOperation(state, { kind: "create", name: "主角信息", columns: [{ name: "姓名" }] });
	const r2 = await runTableBackfill(
		deps({ branchEntries: [{ type: "custom", customType: "rp-state", data: {} }], state }),
	);
	assert.equal(r2.ok, false);
	if (!r2.ok) assert.ok(r2.error.includes("没有可回填"));
});

test("runTableBackfill：多块按块调用、非 auto 表也生效", async () => {
	const state: WorldState = defaultState();
	// 建一张非 auto 静态表（无 auto 标记）——回填必须能直接写它（不走 applyPatch 的 auto 限制）
	applyTableOperation(state, { kind: "create", name: "主角信息", columns: [{ name: "姓名" }, { name: "体力", type: "integer" }] });
	const branch = longHistory(10);
	const expectedChunks = chunkMessagesForSummary(
		branch.map((e) => ({
			role: e.message!.role as "user" | "assistant",
			name: e.message!.role === "user" ? "阿远" : "青梧",
			text: (e.message!.content as Array<{ text: string }>)[0].text,
		})),
		"阿远",
	);

	const calls: Array<{ sys: string; user: string }> = [];
	const r = await runTableBackfill(
		deps({
			branchEntries: branch,
			state,
			sideText: async (sys, user) => {
				calls.push({ sys, user });
				return '{"insert":[{"姓名":"阿远","体力":80}]}';
			},
		}),
	);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.chunks, expectedChunks.length, "分块数与 chunkMessagesForSummary 一致");
	assert.equal(r.chunks, calls.length, "每块恰好一次 sideText 调用");
	assert.equal(r.rows, r.chunks, "每块插 1 行");
	// 非 auto 表被直接写入（applyTableOperation），表无 auto 标记仍生效
	const t = state.tables!["主角信息"];
	assert.equal(t.auto, undefined, "表保持非 auto");
	assert.equal(t.rows.length, r.chunks, "行按块数插入");
	assert.ok(calls.every((c) => c.sys.includes("主角信息")), "每块提示词都带表 schema");
});

test("runTableBackfill：某块 {error} → 跳过继续，其余块仍应用", async () => {
	const state = defaultState();
	applyTableOperation(state, { kind: "create", name: "主角信息", columns: [{ name: "姓名" }] });
	const branch = longHistory(10);
	let call = 0;
	const r = await runTableBackfill(
		deps({
			branchEntries: branch,
			state,
			// 关闭重试（重试行为有专门用例）：失败即跳过
			maxRetries: 0,
			sideText: async () => {
				call++;
				if (call === 2) return { error: "模型超时" };
				return '{"insert":[{"姓名":"阿远"}]}';
			},
		}),
	);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.ok(r.chunks > 1, "历史应切成多块");
	assert.equal(state.tables!["主角信息"].rows.length, r.chunks - 1, "失败块跳过，其余块仍应用");
	assert.ok(r.rows <= r.chunks - 1);
});

test("runTableBackfill：某块输出垃圾 → 跳过，不中断", async () => {
	const state = defaultState();
	applyTableOperation(state, { kind: "create", name: "主角信息", columns: [{ name: "姓名" }] });
	const branch = longHistory(10);
	let call = 0;
	const r = await runTableBackfill(
		deps({
			branchEntries: branch,
			state,
			maxRetries: 0,
			sideText: async () => {
				call++;
				if (call === 3) return "这不是 JSON 输出";
				return '{"insert":[{"姓名":"阿远"}]}';
			},
		}),
	);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.ok(r.chunks > 1);
	assert.equal(state.tables!["主角信息"].rows.length, r.chunks - 1, "垃圾块跳过，其余块仍应用");
});

test("runTableBackfill：{error} 按退避重试，重试成功照样应用", async () => {
	const state = defaultState();
	applyTableOperation(state, { kind: "create", name: "主角信息", columns: [{ name: "姓名" }] });
	const branch = longHistory(10);
	let call = 0;
	const waits: number[] = [];
	const origSetTimeout = globalThis.setTimeout;
	// 用 1ms 基数 + 截获等待时长断言退避按 2 的幂倍增（1→2→4…）
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
		waits.push(ms ?? 0);
		return origSetTimeout(fn, 1, ...args);
	}) as unknown as typeof setTimeout;
	try {
		const r = await runTableBackfill(
			deps({
				branchEntries: branch,
				state,
				maxRetries: 3,
				retryBaseDelayMs: 1,
				sideText: async () => {
					call++;
					if (call <= 2) return { error: `瞬态错误 ${call}` };
					return '{"insert":[{"姓名":"阿远"}]}';
				},
			}),
		);
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.rows, r.chunks, "每块重试成功后均应用 1 行");
		assert.equal(state.tables!["主角信息"].rows.length, r.chunks);
		// 仅首块前 2 次调用失败 → 2 次退避等待（1ms × 2^0、1ms × 2^1）；其余块一次成功无等待
		assert.deepEqual(waits, [1, 2], "退避按基数（生产 2s）倍增");
	} finally {
		globalThis.setTimeout = origSetTimeout;
	}
});

test("runTableBackfill：输出垃圾重试后成功；重试耗尽仍失败才跳过", async () => {
	const state = defaultState();
	applyTableOperation(state, { kind: "create", name: "主角信息", columns: [{ name: "姓名" }] });
	const branch = longHistory(10);
	// 块 1：垃圾 → 垃圾 → 成功；块 2 起：垃圾 → 垃圾 → 垃圾 → 耗尽跳过
	let call = 0;
	const r = await runTableBackfill(
		deps({
			branchEntries: branch,
			state,
			maxRetries: 2,
			retryBaseDelayMs: 1,
			sideText: async () => {
				call++;
				if (call === 1 || call === 2) return "这不是 JSON";
				if (call === 3) return '{"insert":[{"姓名":"阿远"}]}';
				return "还是垃圾";
			},
		}),
	);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.ok(r.chunks >= 2, "历史切成多块");
	// 块 1：3 次尝试（2 重试）后成功应用 1 行；其余块各尝试 3 次耗尽跳过
	assert.equal(state.tables!["主角信息"].rows.length, 1, "重试成功的块应用，耗尽的块跳过");
	assert.equal(call, 3 * r.chunks, "每块恰好尝试 3 次（1 初始 + 2 重试）");
});

test("runTableBackfill：后块 update 覆盖前块 insert 的同一 match", async () => {
	const state = defaultState();
	applyTableOperation(state, { kind: "create", name: "主角信息", columns: [{ name: "姓名" }, { name: "体力", type: "integer" }] });
	const branch = longHistory(8);
	let call = 0;
	const r = await runTableBackfill(
		deps({
			branchEntries: branch,
			state,
			sideText: async () => {
				call++;
				if (call === 1) return '{"insert":[{"姓名":"阿远","体力":60}]}';
				return '{"update":[{"match":{"姓名":"阿远"},"changes":{"体力":90}}]}';
			},
		}),
	);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	const rows = state.tables!["主角信息"].rows;
	assert.equal(rows.length, 1, "后块 update 匹配前块 insert 的行，不重复插");
	assert.deepEqual(rows[0], { 姓名: "阿远", 体力: 90 }, "后写覆盖前值");
});
