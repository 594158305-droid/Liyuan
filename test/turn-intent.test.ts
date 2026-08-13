import assert from "node:assert/strict";
import { test } from "node:test";

import { createIntentClassifier, intentOptionsOf, shouldApplyStoryPreset } from "../src/turn-intent.ts";

test("默认分类器：剧情主路径——长文/续写/混写走预设，短句办事跳过", () => {
	// 剧情（默认 true）
	assert.equal(shouldApplyStoryPreset("她推开门，月光洒了进来。"), true, "普通叙述默认剧情");
	assert.equal(shouldApplyStoryPreset("继续写下去，接着演"), true, "明确续写信号");
	assert.equal(shouldApplyStoryPreset("把设定补进世界书，然后继续剧情"), true, "混写走预设");
	assert.equal(shouldApplyStoryPreset("接下来去找谁？"), true, "求方向仍是剧情");
	// 办事（false）
	assert.equal(shouldApplyStoryPreset("改配置"), false, "配置类办事");
	assert.equal(shouldApplyStoryPreset("换模型"), false, "模型类办事");
	assert.equal(shouldApplyStoryPreset("看日志"), false, "诊断类办事");
	assert.equal(shouldApplyStoryPreset("更新面板"), false, "面板类办事");
	assert.equal(shouldApplyStoryPreset("生图"), false, "媒体类办事");
	assert.equal(shouldApplyStoryPreset("别写正文，只改状态栏"), false, "明确不要剧情");
	assert.equal(shouldApplyStoryPreset("让助手查一下"), false, "显式助手");
	// 场外标记 / 空串
	assert.equal(shouldApplyStoryPreset("// 系统备注"), false, "场外标记按非剧情");
	assert.equal(shouldApplyStoryPreset("   "), true, "空白默认剧情");
});

test("createIntentClassifier：配置覆盖正则清单（外置入口，DESIGN-flow-config §4）", () => {
	const c = createIntentClassifier({
		wantsStory: ["立刻开演"],
		pureOps: ["查天气"],
	});
	assert.equal(c("立刻开演"), true, "自定义续写信号命中");
	assert.equal(c("查天气"), false, "自定义办事信号命中");
	assert.equal(c("继续写"), true, "未覆盖的原内置信号失效（整体替换语义）");
});

test("intentOptionsOf：只取数组字段，缺省返回空对象", () => {
	assert.deepEqual(intentOptionsOf(undefined), {});
	assert.deepEqual(intentOptionsOf({}), {});
	assert.deepEqual(intentOptionsOf({ wantsStory: ["a"], pureOps: "不是数组" as never }), { wantsStory: ["a"] });
	assert.deepEqual(intentOptionsOf({ pureOps: ["b"] }), { pureOps: ["b"] });
});

test("intentOptionsOf 产物可直接喂 factory（配置链路闭合）", () => {
	const c = createIntentClassifier(intentOptionsOf({ wantsStory: ["开拍吧"], pureOps: ["关灯"] }));
	assert.equal(c("开拍吧"), true);
	assert.equal(c("关灯"), false);
});
