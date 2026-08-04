import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRevisePrompt, MAX_EDITS_PER_ROUND, parseReviseEdits } from "../src/stage/revise.ts";

test("buildRevisePrompt：交接单三件套——当前稿、核验报告、成文纪律；无纪律块则不出该节", () => {
	const p = buildRevisePrompt({
		draftText: "她眼中闪过一丝冷意。",
		violations: ["禁词「闪过」：…眼中闪过一丝冷意…"],
		policeTexts: ['词汇黑名单 = { "闪过" }'],
		charName: "云澜",
		userName: "沈舟",
		language: "中文",
	});
	assert.ok(p.systemPrompt.includes("定点替换"));
	assert.ok(p.systemPrompt.includes("沈舟"), "主权约束点名用户角色");
	assert.ok(p.userText.includes("【当前稿】") && p.userText.includes("她眼中闪过一丝冷意。"));
	assert.ok(p.userText.includes("【核验报告】") && p.userText.includes("1. 禁词"));
	assert.ok(p.userText.includes("【成文纪律】") && p.userText.includes("词汇黑名单"));

	const noPolice = buildRevisePrompt({
		draftText: "x",
		violations: ["v"],
		policeTexts: [],
		charName: "云澜",
		userName: "沈舟",
		language: "中文",
	});
	assert.ok(!noPolice.userText.includes("【成文纪律】"));
});

test("parseReviseEdits：裸 JSON / 代码围栏 / 前后杂文 三形态都解析", () => {
	const edits = [{ old: "闪过一丝", new: "沉了沉" }, { append: "<state1>补</state1>" }];
	const clean = JSON.stringify({ edits });
	assert.deepEqual(parseReviseEdits(clean), edits);
	assert.deepEqual(parseReviseEdits("```json\n" + clean + "\n```"), edits);
	assert.deepEqual(parseReviseEdits("好的，以下是修订：\n" + clean + "\n以上。"), edits);
});

test("parseReviseEdits：坏条目逐条丢弃、超上限截断、解析不出返回空", () => {
	const mixed = JSON.stringify({
		edits: [
			{ old: "a", new: "b" },
			{ old: "", new: "x" }, // old 空：丢
			{ append: "  " }, // 空白 append：丢
			"garbage",
			{ old: "c", new: "" }, // new 允许为空串（删除式替换）
		],
	});
	assert.deepEqual(parseReviseEdits(mixed), [
		{ old: "a", new: "b" },
		{ old: "c", new: "" },
	]);

	const tooMany = JSON.stringify({ edits: Array.from({ length: 40 }, (_, i) => ({ old: `o${i}`, new: `n${i}` })) });
	assert.equal(parseReviseEdits(tooMany).length, MAX_EDITS_PER_ROUND);

	assert.deepEqual(parseReviseEdits("完全不是 JSON"), []);
	assert.deepEqual(parseReviseEdits('{"notEdits": []}'), []);
	assert.deepEqual(parseReviseEdits(""), []);
});
