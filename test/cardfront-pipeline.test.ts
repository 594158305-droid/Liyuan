/**
 * 端到端显示管线（纯函数串联）：卡 raw → displayRules → applyCardSkin → splitHtmlParts。
 * 证明皮肤产物进 html 段且不碰 server 送模路径。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { displayRules, extractRegexScripts } from "../src/cardfront.ts";
import { applyCardSkin } from "../web/src/cardSkin.ts";
import { isFullInterface, splitHtmlParts } from "../web/src/htmlEmbed.ts";
import { buildSrcDoc } from "../web/src/frameDoc.ts";

/** 淫宫美人录形态：开闭标签换皮 */
const skinScripts = [
	{
		scriptName: "状态栏开",
		findRegex: "/<StatusBlock>/gs",
		replaceString: '<div style="background-color: rgba(0, 0, 0, 0.5); border-radius: 8px;"><status>',
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
		trimStrings: [],
	},
	{
		scriptName: "状态栏闭",
		findRegex: "/</StatusBlock>/gs",
		replaceString: "</status></div>",
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
		trimStrings: [],
	},
];

const sampleRaw = {
	data: {
		name: "美人录",
		extensions: { regex_scripts: skinScripts },
	},
};

test("pipeline: 提取→应用→混排切分→无痕 srcdoc", () => {
	const rules = displayRules(extractRegexScripts(sampleRaw));
	assert.equal(rules.length, 2);

	const text = "雨停了。\n<StatusBlock>\nHP: 80\nMP: 20\n</StatusBlock>\n她抬头。";
	const skinned = applyCardSkin(text, rules, { charName: "青梧", userName: "旅人" });
	assert.ok(!skinned.includes("<StatusBlock>"));
	assert.ok(skinned.includes('<div style="background-color: rgba(0, 0, 0, 0.5)'));
	assert.ok(skinned.includes("</status></div>"));

	const parts = splitHtmlParts(skinned);
	const htmlParts = parts.filter((p) => p.kind === "html");
	assert.equal(htmlParts.length, 1);
	if (htmlParts[0].kind === "html") {
		assert.ok(htmlParts[0].html.startsWith("<div"));
		assert.equal(htmlParts[0].scripts, false);
		const doc = buildSrcDoc(htmlParts[0].html, false, true);
		assert.ok(!doc.includes("PingFang"));
		assert.ok(doc.includes("background:transparent"));
		assert.ok(!doc.includes("<script>"));
	}
	assert.ok(parts.some((p) => p.kind === "text" && p.text.includes("雨停了")));
	assert.ok(parts.some((p) => p.kind === "text" && p.text.includes("她抬头")));
});

test("pipeline: 整楼界面判定", () => {
	const rules = displayRules(extractRegexScripts(sampleRaw));
	const onlySkin = applyCardSkin("<StatusBlock>\nHP: 1\n</StatusBlock>", rules, {
		charName: "x",
		userName: "y",
	});
	assert.equal(isFullInterface(onlySkin), true);
	assert.equal(isFullInterface(`旁白\n${onlySkin}`), false);
});

test("pipeline: 关闭皮肤=不应用规则时 StatusBlock 仍为文本段", () => {
	const text = "<StatusBlock>\nHP: 80\n</StatusBlock>";
	// 无规则：不切 html（自定义标签留给 statusBlocks）
	const parts = splitHtmlParts(text);
	assert.equal(parts.length, 1);
	assert.equal(parts[0].kind, "text");
});
