import assert from "node:assert/strict";
import { test } from "node:test";

import { replayFloors, type ReplayDeps, type ReplayFloor } from "../src/import-raw.ts";
import { applyTableOperation, defaultState } from "../src/state.ts";
import type { WorldState } from "../src/types.ts";

/** 组装最小 deps：记录 appendMessage 注入、save 次数；overrides 覆盖同名字段 */
function makeDeps(overrides: Partial<ReplayDeps> = {}): {
	deps: ReplayDeps;
	injected: string[];
	savedCount: () => number;
} {
	const injected: string[] = [];
	let saved = 0;
	const deps: ReplayDeps = {
		floors: [],
		state: defaultState(),
		userName: "User",
		charName: "Alice",
		batchN: 1,
		sideText: async () => '{"patch":{}}',
		appendMessage: (role, text) => {
			injected.push(`${role}:${text}`);
		},
		save: () => {
			saved++;
		},
		...overrides,
	};
	return { deps, injected, savedCount: () => saved };
}

const floorsOf = (n: number): ReplayFloor[] =>
	Array.from({ length: n }, (_, i) => ({
		role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
		name: i % 2 === 0 ? "User" : "Alice",
		text: `第${i + 1}层`,
	}));

test("replayFloors：空 floors → ok:false", async () => {
	const { deps } = makeDeps({ floors: [] });
	const r = await replayFloors(deps);
	assert.equal(r.ok, false);
	assert.ok(!r.ok && r.error.includes("为空"));
});

test("replayFloors：逐层注入 appendMessage，batchN=1 每层一次场记", async () => {
	const { deps, injected } = makeDeps({
		floors: floorsOf(3),
		batchN: 1,
		sideText: async () => '{"patch":{}}',
	});
	const r = await replayFloors(deps);
	assert.ok(r.ok);
	assert.equal(r.floors, 3);
	assert.equal(r.scribeCalls, 3, "batchN=1 每层一次场记");
	assert.deepEqual(injected, ["user:第1层", "assistant:第2层", "user:第3层"], "逐层按序注入");
});

test("replayFloors：onProgress 收到递增的 scribeCalls（成功尝试也计数）", async () => {
	const progress: Array<{ current: number; total: number; stage: string; scribeCalls: number }> = [];
	const { deps } = makeDeps({
		floors: floorsOf(3),
		batchN: 1,
		sideText: async () => '{"patch":{}}',
		onProgress: (current, total, stage, scribeCalls) => progress.push({ current, total, stage, scribeCalls }),
	});
	const r = await replayFloors(deps);
	assert.ok(r.ok);
	assert.equal(r.scribeCalls, 3);
	// 每次场记尝试后 scribeCalls 递增；整体非降序，最终停在 3
	const seen = progress.map((p) => p.scribeCalls);
	for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! >= seen[i - 1]!, "scribeCalls 不降序");
	assert.equal(seen[seen.length - 1], 3, "最后一次进度帧 scribeCalls=3");
	// 每层「回放」进度帧带当时的已记账次数：floor1=0、floor2=1、floor3=2
	const replayStages = progress.filter((p) => p.stage === "回放");
	assert.deepEqual(replayStages.map((p) => p.scribeCalls), [0, 1, 2], "回放帧的 scribeCalls 为已完成的记账次数");
});

test("replayFloors：batchN=3 每 3 层一次场记（末尾不足一批也记账；scribeCalls 按尝试 +1）", async () => {
	const progress: Array<{ current: number; total: number; stage: string; scribeCalls: number }> = [];
	const { deps } = makeDeps({
		floors: floorsOf(5),
		batchN: 3,
		sideText: async () => '{"patch":{}}',
		onProgress: (current, total, stage, scribeCalls) => progress.push({ current, total, stage, scribeCalls }),
	});
	const r = await replayFloors(deps);
	assert.ok(r.ok);
	// 5 层 / batchN=3 → 前 3 层 + 末尾 2 层 = 2 次场记尝试
	assert.equal(r.scribeCalls, 2);
	// 回放帧的 scribeCalls：前 3 层尚无记账（0），第 4/5 层已有 1 次
	const replayStages = progress.filter((p) => p.stage === "回放");
	assert.deepEqual(replayStages.map((p) => p.scribeCalls), [0, 0, 0, 1, 1], "batchN=3 每 3 层 +1");
});

test("replayFloors：某层 sideText 失败 → 跳过该块继续，失败尝试也计数", async () => {
	let calls = 0;
	const progress: Array<{ stage: string; scribeCalls: number }> = [];
	const { deps } = makeDeps({
		floors: floorsOf(4),
		batchN: 1,
		sideText: async () => {
			calls++;
			if (calls === 2) return { error: "旁路 LLM 失败" };
			return '{"patch":{}}';
		},
		onProgress: (current, total, stage, scribeCalls) => progress.push({ stage, scribeCalls }),
	});
	const r = await replayFloors(deps);
	assert.ok(r.ok);
	// scribeCalls 计「尝试次数」：4 层 4 次尝试（第 2 次失败也算一次）
	assert.equal(r.scribeCalls, 4, "失败尝试也计数");
	assert.equal(r.floors, 4);
	// 失败那次进度帧：stage 含「场记失败」且 scribeCalls 已含该次尝试（=2）
	const failed = progress.find((p) => p.stage.includes("场记失败"));
	assert.ok(failed, "失败尝试有进度帧");
	assert.equal(failed!.scribeCalls, 2, "失败尝试计入 scribeCalls");
});

test("replayFloors：场记输出无法解析 → 跳过该块，解析失败尝试也计数", async () => {
	let calls = 0;
	const { deps } = makeDeps({
		floors: floorsOf(3),
		batchN: 1,
		sideText: async () => {
			calls++;
			return calls === 2 ? "这不是 JSON，前言文字没有花括号" : '{"patch":{}}';
		},
	});
	const r = await replayFloors(deps);
	assert.ok(r.ok);
	// 3 次尝试全部计数（第 2 次解析失败也算一次）
	assert.equal(r.scribeCalls, 3, "解析失败尝试也计数");
});

test("replayFloors：signal abort 中途停止，已注入楼层保留", async () => {
	const injected: string[] = [];
	const controller = new AbortController();
	const { deps } = makeDeps({
		floors: floorsOf(5),
		batchN: 1,
		signal: controller.signal,
		appendMessage: (role, text) => {
			injected.push(`${role}:${text}`);
			if (injected.length === 3) controller.abort(); // 注入第 3 层后立刻中断
		},
	});
	const r = await replayFloors(deps);
	assert.equal(r.ok, false);
	assert.ok(!r.ok && r.aborted === true);
	assert.ok(!r.ok && r.error === "已停止");
	assert.equal(injected.length, 3, "前 3 层已注入保留");
});

test("replayFloors：applyPatch 后 state 原位更新（含 auto 表填充，非 applyPatch tables 白名单外也生效）", async () => {
	const state: WorldState = defaultState();
	// 预建一张 auto 表（场记可维护）
	const created = applyTableOperation(state, {
		kind: "create",
		name: "主角信息表",
		columns: [{ name: "姓名" }, { name: "体力", type: "integer" }],
		auto: true,
	});
	assert.ok(created.ok);
	const { deps } = makeDeps({
		state,
		floors: [
			{ role: "user", name: "User", text: "黄昏时分，小明走进林间小屋" },
			{ role: "assistant", name: "Alice", text: "欢迎回来，你的体力还剩不少。" },
		],
		batchN: 2, // 2 层攒一批 → 末尾跑一次场记（只有 1 次，rows 不会重复插入）
		sideText: async () =>
			JSON.stringify({
				patch: {
					time: "黄昏",
					location: "林间小屋",
					characters: { 小明: { affinity: 5, status: "轻松" } },
					tables: { "主角信息表": { insert: [{ 姓名: "小明", 体力: 80 }] } },
				},
			}),
	});
	const r = await replayFloors(deps);
	assert.ok(r.ok);
	assert.equal(r.scribeCalls, 1);
	// applyPatch 返回新对象，核心已回灌进 deps.state（同一对象身份）
	assert.equal(state.time, "黄昏");
	assert.equal(state.location, "林间小屋");
	assert.equal(state.characters["小明"].affinity, 5);
	const tbl = state.tables!["主角信息表"];
	assert.ok(tbl, "auto 表在场记补丁后可写入");
	assert.equal(tbl.rows.length, 1);
	assert.equal(tbl.rows[0]["姓名"], "小明");
	assert.equal(tbl.rows[0]["体力"], 80);
});
