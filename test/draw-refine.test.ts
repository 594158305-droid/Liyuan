/**
 * 插件 D 二期「AI 微调」纯函数单测：decomposePrompt / buildRefineMessages / extractRefinedScene。
 * 运行：node --test test/draw-refine.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRefineMessages, decomposePrompt, decomposeTags, extractRefinedScene } from "../src/draw-plugins/draw-edit/prompt-refine.ts";

// ---------- decomposePrompt ----------

test("decomposePrompt：剥离头部质量前缀与角色数量 tag，保留场景", () => {
	const { scene } = decomposePrompt(
		"masterpiece, best quality, 1girl, long silver hair, blue eyes, night street, lantern, rain",
	);
	assert.equal(scene, "long silver hair, blue eyes, night street, lantern, rain");
});

test("decomposePrompt：权重包裹的质量前缀可识别（n::tag::）", () => {
	const { scene } = decomposePrompt("1.3::best quality::, 1boy, castle interior, candlelight");
	assert.equal(scene, "castle interior, candlelight");
});

test("decomposePrompt：无前缀直接返回原样（去空白）", () => {
	assert.equal(decomposePrompt("forest, morning mist, sunlight").scene, "forest, morning mist, sunlight");
});

test("decomposePrompt：中部质量 tag 不剥（只在头部）", () => {
	assert.equal(decomposePrompt("night, street, masterpiece, lantern").scene, "night, street, masterpiece, lantern");
});

// ---------- extractRefinedScene ----------

test("extractRefinedScene：提取 [场景] / 【场景】内容（含围栏与冒号容错）", () => {
	assert.equal(extractRefinedScene("[场景] 1girl, night street, lanterns"), "1girl, night street, lanterns");
	assert.equal(extractRefinedScene("【场景】：森林、晨雾"), "森林、晨雾");
	assert.equal(extractRefinedScene("```\n[场景] tavern, warm light\n```"), "tavern, warm light");
});

test("extractRefinedScene：其后附加其它段只取首段", () => {
	assert.equal(extractRefinedScene("[场景] tavern, warm light\n[备注] 原样"), "tavern, warm light");
});

test("extractRefinedScene：无标记 / 空内容返回 null", () => {
	assert.equal(extractRefinedScene("1girl, street"), null);
	assert.equal(extractRefinedScene("[场景]   "), null);
	assert.equal(extractRefinedScene(""), null);
	assert.equal(extractRefinedScene(null as unknown as string), null);
});

// ---------- buildRefineMessages ----------

test("buildRefineMessages：要求只输出 [场景] 一行；保留主体、不增加角色特征", () => {
	const msgs = buildRefineMessages("night street, lantern");
	assert.ok(msgs.system.includes("[场景]"), "system 应约定 [场景] 输出格式");
	assert.ok(msgs.system.includes("角色特征"), "system 应约束不改变角色特征");
	assert.ok(msgs.system.includes("主体"), "system 应约束保留主体");
	assert.ok(msgs.user.includes("night street, lantern"), "user 应携带待优化场景");
});

test("buildRefineMessages：可选指令追加到 user（用户指令：…）", () => {
	const msgs = buildRefineMessages("night street, lantern", "强调冷色调与雾气");
	assert.ok(msgs.user.includes("night street, lantern"), "user 保留场景");
	assert.ok(msgs.user.includes("用户指令：强调冷色调与雾气"), "user 应追加用户指令段");
	// 无指令 → 不含用户指令段
	const plain = buildRefineMessages("night street, lantern");
	assert.ok(!plain.user.includes("用户指令"));
});

// ---------- decomposeTags（五段分解，批次 3） ----------

test("decomposeTags：五段分解（mode/qualityPrefix/scene/characters/negative）", () => {
	const r = decomposeTags({
		mode: "landscape",
		scene: "night street, lantern",
		positive: "best quality, masterpiece",
		characterPrompts: [
			{ name: "甲", prompt: "long hair, red dress" },
			{ name: "乙", prompt: "black hair" },
		],
		negative: "lowres",
	});
	assert.equal(r.mode, "landscape");
	assert.equal(r.qualityPrefix, "best quality, masterpiece");
	assert.equal(r.scene, "night street, lantern");
	assert.deepEqual(r.characters, ["long hair, red dress", "black hair"]);
	assert.equal(r.negative, "lowres");
});

test("decomposeTags：无 positive 时从 scene 头部剥质量前缀；mode 缺省 portrait", () => {
	const r = decomposeTags({ scene: "best quality, highres, night street, lantern" });
	assert.equal(r.qualityPrefix, "best quality, highres");
	assert.equal(r.scene, "night street, lantern");
	assert.equal(r.mode, "portrait");
	assert.deepEqual(r.characters, []);
	assert.equal(r.negative, "");
});

test("decomposeTags：中部质量词不剥；空 scene 安全", () => {
	const r = decomposeTags({ scene: "night, masterpiece, street" });
	assert.equal(r.qualityPrefix, "");
	assert.equal(r.scene, "night, masterpiece, street");
	const empty = decomposeTags({});
	assert.equal(empty.scene, "");
	assert.equal(empty.qualityPrefix, "");
	assert.equal(empty.mode, "portrait");
});
