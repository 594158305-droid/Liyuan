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

/** 记录落树与落盘的假依赖 */
const makeDeps = (
	respond: string | { error: string },
	over: Partial<ScribeRunDeps> = {},
): ScribeRunDeps & { entries: WorldState[]; activities: string[]; prompts: string[] } => {
	const entries: WorldState[] = [];
	const activities: string[] = [];
	const prompts: string[] = [];
	return {
		entries,
		activities,
		prompts,
		sideText: async (_sp, ut) => {
			prompts.push(ut);
			return respond;
		},
		appendStateEntry: (s) => entries.push(s),
		getLeafId: () => "leaf-1",
		onActivity: (d) => activities.push(d),
		...over,
	};
};

test("场记：patch 落账 + rp-state 快照落树 + 过程条", async () => {
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
	assert.equal(deps.entries.length, 1, "一条 rp-state 快照");
	const snap = deps.entries[0];
	assert.equal(snap.time, "戌时");
	assert.equal(snap.location, "溪桥");
	assert.equal(snap.characters["云澜"]?.affinity, 6);
	assert.deepEqual(snap.inventory, ["黄铜怀表（云澜持有）"]);
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
	assert.equal(deps.entries.length, 0, "废弃分支的账本绝不落树");
	assert.ok(deps.activities.some((a) => a.includes("切换了分支")));
});

test("场记：空 patch / 不可解析 / 调用失败都不落树", async () => {
	const empty = makeDeps(JSON.stringify({ patch: {} }));
	assert.deepEqual(await runScribeTurn(empty, baseInput), { kind: "skipped", reason: "empty-patch" });
	assert.equal(empty.entries.length, 0);

	const garbage = makeDeps("模型今天想聊天，不想输出 JSON。");
	const gr = await runScribeTurn(garbage, baseInput);
	assert.equal(gr.kind, "failed");
	assert.ok(gr.kind === "failed" && gr.error.includes("不可解析"), "失败信息带原文，便于诊断格式跑偏");
	assert.equal(garbage.entries.length, 0);

	const failed = makeDeps({ error: "429 rate limited" });
	assert.deepEqual(await runScribeTurn(failed, baseInput), { kind: "failed", error: "429 rate limited" });
	assert.equal(failed.entries.length, 0);

	const noText = makeDeps(JSON.stringify({ patch: { time: "子时" } }));
	assert.deepEqual(await runScribeTurn(noText, { ...baseInput, assistantText: "  " }), {
		kind: "skipped",
		reason: "no-text",
	});
	assert.equal(noText.entries.length, 0, "空正文不该发起调用");
});

test("场记：角色名归一（大小写/空白变体不开新条目）", async () => {
	const state: WorldState = { ...defaultState(), characters: { 云澜: { affinity: 3, status: "", notes: "" } } };
	const deps = makeDeps(JSON.stringify({ patch: { characters: { " 云澜 ": { affinity: 8 } } } }));
	const r = await runScribeTurn(deps, { ...baseInput, state });

	assert.equal(r.kind, "applied");
	assert.deepEqual(Object.keys(deps.entries[0].characters), ["云澜"], "不得记成两份");
	assert.equal(deps.entries[0].characters["云澜"]?.affinity, 8);
});

test("场记：快照带登场名录（applyPatch 咽喉点自动登记）", async () => {
	const deps = makeDeps(
		JSON.stringify({ patch: { characters: { 老松道人: { affinity: 0, status: "山门守卫" } }, plot_threads: ["寻回师门信物"] } }),
	);
	await runScribeTurn(deps, baseInput);
	const roster = deps.entries[0].roster;
	assert.ok(roster?.characters["老松道人"] !== undefined, "人物进名录");
	assert.ok(roster?.events["寻回师门信物"] !== undefined, "剧情线进名录");
});
