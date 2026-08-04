import assert from "node:assert/strict";
import { test } from "node:test";

import { convertStPreset, enabledBlocks, normalizeRpPreset } from "../src/preset.ts";
import { defaultState } from "../src/state.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const stPreset = {
	temperature: 0.85,
	top_p: 0.98,
	frequency_penalty: 0.3,
	max_tokens: 4096, // 不在搬运名单
	prompts: [
		{ identifier: "main", name: "主提示", system_prompt: true, role: "system", content: "文风块：{{char}}要生动。" },
		{ identifier: "chatHistory", name: "Chat History", marker: true },
		{ identifier: "charDescription", name: "Char Description", marker: true },
		{ identifier: "post1", name: "末端块", role: "system", content: "末端指令：保持节奏。" },
		{ identifier: "depthNote", name: "深度注入", role: "user", content: "深度提醒", injection_position: 1, injection_depth: 4 },
		{ identifier: "disabledOne", name: "被禁块", role: "system", content: "不该出现" },
		{ identifier: "jb", name: "越狱块", role: "system", content: "【用户自备内容原样搬运】" },
	],
	prompt_order: [
		{ character_id: 999, order: [{ identifier: "main", enabled: true }] },
		{
			character_id: 100001,
			order: [
				{ identifier: "main", enabled: true },
				{ identifier: "charDescription", enabled: true },
				{ identifier: "depthNote", enabled: true },
				{ identifier: "chatHistory", enabled: true },
				{ identifier: "post1", enabled: true },
				{ identifier: "jb", enabled: true },
				{ identifier: "disabledOne", enabled: false },
				{ identifier: "ghost", enabled: true },
			],
		},
	],
};

test("转换：位置→通道、marker 弃、深度注入归末端、禁用保留、采样搬运", () => {
	const { preset, report } = convertStPreset(stPreset as Record<string, unknown>, "测试预设");
	const byId = new Map(preset.blocks.map((b) => [b.id, b]));

	assert.equal(byId.get("main")?.channel, "system", "chatHistory 之前 → system");
	assert.equal(byId.get("post1")?.channel, "postHistory", "chatHistory 之后 → postHistory");
	assert.equal(byId.get("jb")?.channel, "postHistory");
	assert.equal(byId.get("jb")?.content, "【用户自备内容原样搬运】", "内容必须原样，不润色");
	assert.equal(byId.get("depthNote")?.channel, "postHistory", "in-chat 深度注入归末端");
	assert.equal(byId.get("depthNote")?.depth, 4);
	assert.equal(byId.get("disabledOne")?.enabled, false, "禁用块保留但不启用");
	assert.ok(!byId.has("chatHistory"), "marker 不产生块");

	assert.deepEqual(preset.samplers, { temperature: 0.85, top_p: 0.98, frequency_penalty: 0.3 });

	assert.ok(report.some((r) => r.identifier === "ghost" && r.action === "缺失定义"));
	assert.ok(report.some((r) => r.identifier === "chatHistory" && r.action.startsWith("marker")));
	const mainReport = report.find((r) => r.identifier === "main");
	assert.ok(mainReport && mainReport.contentChars > 0, "报告只记长度不外显内容");
});

test("转换：选中 character_id 100001 的 prompt_order", () => {
	const { preset } = convertStPreset(stPreset as Record<string, unknown>);
	assert.ok(preset.blocks.length > 1, "不应只有 999 序里的单块");
});

test("normalizeRpPreset：宽容解析", () => {
	const p = normalizeRpPreset({ blocks: [{ id: "a", content: "x", channel: "system", enabled: true }, null, { bad: true }], samplers: { temperature: 1, bogus: "x" } });
	assert.equal(p.blocks.length, 1);
	assert.deepEqual(p.samplers, { temperature: 1 });
	assert.deepEqual(normalizeRpPreset(null).blocks, []);
});
