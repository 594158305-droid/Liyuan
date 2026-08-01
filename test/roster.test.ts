import assert from "node:assert/strict";
import { test } from "node:test";

import { applyPatch, defaultState, formatRosterIndex } from "../src/state.ts";

test("名录登记：角色/物品/剧情线登场即入册，一句话取登记时状态", () => {
	const r1 = applyPatch(defaultState(), {
		characters: { 苏茜: { affinity: 10, status: "旧识，三年未见", notes: "" } },
		inventory: ["铁剑"],
		plot_threads: ["寻找失踪的妹妹"],
	});
	assert.equal(r1.state.roster?.characters["苏茜"], "旧识，三年未见");
	assert.ok("铁剑" in (r1.state.roster?.items ?? {}));
	assert.ok("寻找失踪的妹妹" in (r1.state.roster?.events ?? {}));
});

test("名录只增不改：状态更新不churn已登记的一句话", () => {
	const r1 = applyPatch(defaultState(), { characters: { 苏茜: { status: "初登场" } } });
	const r2 = applyPatch(r1.state, { characters: { 苏茜: { status: "重伤垂死" } } });
	assert.equal(r2.state.roster?.characters["苏茜"], "初登场");
});

test("名录不删：活跃状态里移除后名录仍在案", () => {
	const r1 = applyPatch(defaultState(), {
		characters: { 苏茜: { status: "在场" } },
		inventory: ["铁剑"],
		plot_threads: ["旧约"],
	});
	const r2 = applyPatch(r1.state, { characters: { 苏茜: null }, inventory: [], plot_threads: [] });
	assert.equal(Object.keys(r2.state.characters).length, 0);
	assert.ok("苏茜" in (r2.state.roster?.characters ?? {}));
	assert.ok("铁剑" in (r2.state.roster?.items ?? {}));
	assert.ok("旧约" in (r2.state.roster?.events ?? {}));
});

test("名录索引：只列已不在当前状态的条目；全活跃时不出索引", () => {
	const r1 = applyPatch(defaultState(), {
		characters: { 苏茜: { status: "在场" }, 老周: { status: "掌柜" } },
		inventory: ["铁剑"],
	});
	// 全部活跃 → 无索引
	assert.equal(formatRosterIndex(r1.state), undefined);
	// 苏茜离场、铁剑失去 → 索引只含它们
	const r2 = applyPatch(r1.state, { characters: { 苏茜: null }, inventory: [] });
	const idx = formatRosterIndex(r2.state);
	assert.ok(idx);
	assert.match(idx, /已离场人物：苏茜（在场）/);
	assert.match(idx, /曾持有物品：铁剑/);
	assert.ok(!idx.includes("老周"));
});

test("名录索引：无名录（旧存档）返回 undefined", () => {
	assert.equal(formatRosterIndex(defaultState()), undefined);
});

test("名录容量：剧情线超上限丢最旧", () => {
	let s = defaultState();
	for (let i = 0; i < 70; i++) {
		s = applyPatch(s, { plot_threads: [`线索${i}`] }).state;
	}
	const events = Object.keys(s.roster?.events ?? {});
	assert.equal(events.length, 60);
	assert.ok(!events.includes("线索0"));
	assert.ok(events.includes("线索69"));
});

test("名录一句话超长截断", () => {
	const r = applyPatch(defaultState(), { characters: { 龙王: { status: "一".repeat(80) } } });
	assert.ok((r.state.roster?.characters["龙王"] ?? "").length <= 30);
});
