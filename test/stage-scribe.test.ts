import assert from "node:assert/strict";
import { test } from "node:test";

import { runScribeTurn, type ScribeRunDeps } from "../src/stage/scribe-run.ts";
import { defaultState } from "../src/state.ts";
import type { WorldState } from "../src/types.ts";

const baseInput = {
	state: defaultState(),
	userText: "我把怀表递给她。",
	assistantText: "云澜接过怀表，指尖顿了顿。",
	charName: "云澜",
	userName: "沈舟",
};

/**
 * 记录旁路提示词与过程条的假依赖。
 * 8/13 域分工后 runScribeTurn 不再自行落树/落盘——落账（appendStateEntry/saveState）
 * 由调用方统一做，返回 applied 的 state 即最终账本；本测试直接断言 r.state。
 */
const makeDeps = (
	respond: string | { error: string },
	over: Partial<ScribeRunDeps> = {},
): ScribeRunDeps & { activities: string[]; prompts: string[]; systemPrompts: string[] } => {
	const activities: string[] = [];
	const prompts: string[] = [];
	const systemPrompts: string[] = [];
	return {
		activities,
		prompts,
		systemPrompts,
		sideText: async (sp, ut) => {
			systemPrompts.push(sp);
			prompts.push(ut);
			return respond;
		},
		getLeafId: () => "leaf-1",
		onActivity: (d) => activities.push(d),
		...over,
	};
};

/** 单表 auto 账本（tables-only 用例基底） */
const autoState = (): WorldState => ({
	...defaultState(),
	characters: { 云澜: { affinity: 5, status: "在场", notes: "" } },
	tables: {
		在场角色表: { name: "在场角色表", auto: true, columns: [{ name: "姓名" }], rows: [{ 姓名: "云澜" }] },
	},
});

test("场记：patch 应用 + 返回最终账本 + 过程条", async () => {
	const deps = makeDeps(
		JSON.stringify({
			patch: {
				time: "戌时",
				location: "溪桥",
				characters: { 云澜: { affinity: 6, status: "手持怀表" } },
				inventory: ["黄铜怀表（云澜持有）"],
			},
		}),
	);
	const r = await runScribeTurn(deps, baseInput);

	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	assert.equal(r.state.time, "戌时");
	assert.equal(r.state.location, "溪桥");
	assert.equal(r.state.characters["云澜"]?.affinity, 6);
	assert.deepEqual(r.state.inventory, ["黄铜怀表（云澜持有）"]);
	assert.ok(deps.activities.some((a) => a.startsWith("记账")), "有记账过程条");
	// 场记看到的是账本 + 本拍对白
	assert.ok(deps.prompts[0].includes("云澜接过怀表"));
});

test("场记：叶守卫——调用期间分支变了则整体丢弃（R9）", async () => {
	let leaf = "leaf-1";
	const deps = makeDeps(JSON.stringify({ patch: { time: "亥时" } }), {
		sideText: async () => {
			leaf = "leaf-2"; // 模拟调用期间用户 swipe
			return JSON.stringify({ patch: { time: "亥时" } });
		},
		getLeafId: () => leaf,
	});
	const r = await runScribeTurn(deps, baseInput);

	assert.equal(r.kind, "stale");
	assert.ok(deps.activities.some((a) => a.includes("切换了分支")));
});

test("场记：空 patch / 不可解析 / 调用失败都不产生 applied", async () => {
	const empty = makeDeps(JSON.stringify({ patch: {} }));
	assert.deepEqual(await runScribeTurn(empty, baseInput), { kind: "skipped", reason: "empty-patch" });

	const garbage = makeDeps("模型今天想聊天，不想输出 JSON。");
	const gr = await runScribeTurn(garbage, baseInput);
	assert.equal(gr.kind, "failed");
	assert.ok(gr.kind === "failed" && gr.error.includes("不可解析"), "失败信息带原文，便于诊断格式跑偏");

	const failed = makeDeps({ error: "429 rate limited" });
	assert.deepEqual(await runScribeTurn(failed, baseInput), { kind: "failed", error: "429 rate limited" });

	const noText = makeDeps(JSON.stringify({ patch: { time: "子时" } }));
	assert.deepEqual(await runScribeTurn(noText, { ...baseInput, assistantText: "  " }), {
		kind: "skipped",
		reason: "no-text",
	});
});

test("场记：角色名归一（大小写/空白变体不开新条目）", async () => {
	const state: WorldState = { ...defaultState(), characters: { 云澜: { affinity: 3, status: "", notes: "" } } };
	const deps = makeDeps(JSON.stringify({ patch: { characters: { " 云澜 ": { affinity: 8 } } } }));
	const r = await runScribeTurn(deps, { ...baseInput, state });

	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	assert.deepEqual(Object.keys(r.state.characters), ["云澜"], "不得记成两份");
	assert.equal(r.state.characters["云澜"]?.affinity, 8);
});

test("场记：快照带登场名录（applyPatch 咽喉点自动登记）", async () => {
	const deps = makeDeps(
		JSON.stringify({ patch: { characters: { 老松道人: { affinity: 0, status: "山门守卫" } }, plot_threads: ["寻回师门信物"] } }),
	);
	const r = await runScribeTurn(deps, baseInput);
	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	const roster = r.state.roster;
	assert.ok(roster?.characters["老松道人"] !== undefined, "人物进名录");
	assert.ok(roster?.events["寻回师门信物"] !== undefined, "剧情线进名录");
});

test("场记：tables-only 无 auto 表 → skipped（省一次旁路调用）", async () => {
	const deps = makeDeps(JSON.stringify({ patch: {} }));
	const r = await runScribeTurn(deps, { ...baseInput, scope: "tables-only" });
	assert.deepEqual(r, { kind: "skipped", reason: "no-auto-tables" });
	assert.equal(deps.prompts.length, 0, "未发起调用");
});

test("场记：tables-only 补丁应用在 baseState（主演 patch 投影）上", async () => {
	const base = autoState();
	const deps = makeDeps(JSON.stringify({ patch: { tables: { 在场角色表: { insert: [{ 姓名: "沈舟" }] } } } }));
	const r = await runScribeTurn(deps, { ...baseInput, state: defaultState(), baseState: base, scope: "tables-only" });

	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	assert.deepEqual(
		r.state.tables["在场角色表"].rows,
		[{ 姓名: "云澜" }, { 姓名: "沈舟" }],
		"行叠加在主演投影后的账本上",
	);
});

test("场记：tables-only 注入裁剪——【当前账本】只含时间/地点/角色名册/表格", async () => {
	const base = autoState();
	const deps = makeDeps(JSON.stringify({ patch: { tables: {} } }));
	await runScribeTurn(deps, { ...baseInput, state: base, baseState: base, scope: "tables-only" });

	const user = deps.prompts[0];
	const ledgerBlock = user.slice(user.indexOf("【当前账本】"), user.indexOf("【本轮对话】"));
	const parsed = JSON.parse(ledgerBlock.slice(ledgerBlock.indexOf("{"))) as {
		characters: unknown;
		tables: unknown;
		inventory?: unknown;
	};
	assert.deepEqual(parsed.characters, ["云澜"], "tables-only 注入角色名册而非全量字段");
	assert.ok(parsed.tables && typeof parsed.tables === "object", "表格全量注入（场记 update 的 match 需要现有行）");
	assert.equal(parsed.inventory, undefined, "顶层字段不注入");
	// 分工指令进 system prompt：场记只维护 tables，不输出顶层
	assert.ok(deps.systemPrompts[0].includes("只维护 tables 补丁"), "分工指令进 system prompt");
});
