/**
 * 端到端显示管线：卡 raw → displayRules → RichContent 真路径（splitRichContentParts）。
 * 必须含 splitStatusParts 同序，否则会绿测坏集成（皮肤内 <status> 被状态面板撕碎）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { displayRules, extractRegexScripts } from "../src/cardfront.ts";
import { applyCardSkin } from "../web/src/cardSkin.ts";
import { isFullInterface, splitHtmlParts } from "../web/src/htmlEmbed.ts";
import { buildSrcDoc } from "../web/src/frameDoc.ts";
import { splitRichContentParts } from "../web/src/richContentParts.ts";
import { splitStatusParts } from "../web/src/statusBlocks.ts";

/** 淫宫美人录形态：开闭标签换皮（内含 <status>，会误触发 isPanelTagName） */
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

const macros = { charName: "青梧", userName: "旅人" };

test("pipeline: 提取→应用→混排切分→无痕 srcdoc", () => {
	const rules = displayRules(extractRegexScripts(sampleRaw));
	assert.equal(rules.length, 2);

	const text = "雨停了。\n<StatusBlock>\nHP: 80\nMP: 20\n</StatusBlock>\n她抬头。";
	const skinned = applyCardSkin(text, rules, macros);
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

test("RichContent 真路径: 皮肤后 HTML 先认领,status 不撕碎 div", () => {
	const rules = displayRules(extractRegexScripts(sampleRaw));
	const text = "雨停了。\n<StatusBlock>\nHP: 80\nMP: 20\n</StatusBlock>\n她抬头。";
	const skin = { rules, ...macros };

	// 反例：旧序 skin → splitStatusParts 会偷走 <status>，外层 div 残骸
	const skinned = applyCardSkin(text, rules, macros);
	const badOrder = splitStatusParts(skinned);
	assert.ok(
		badOrder.some((p) => p.kind === "status"),
		"对照:旧序会把 <status> 当成状态面板",
	);

	// 真路径（Messages.RichContent → splitRichContentParts）
	const parts = splitRichContentParts(text, skin);
	const statuses = parts.filter((p) => p.kind === "status");
	const htmls = parts.filter((p) => p.kind === "html");
	assert.equal(statuses.length, 0, "皮肤产物内 status 不得落 StatusPanel");
	assert.equal(htmls.length, 1, "应保留单一 html 段(外层 div)");
	if (htmls[0].kind === "html") {
		assert.ok(htmls[0].html.startsWith("<div"));
		assert.ok(htmls[0].html.includes("<status>"));
		assert.ok(htmls[0].html.includes("HP: 80"));
		assert.ok(htmls[0].html.endsWith("</div>") || htmls[0].html.trimEnd().endsWith("</div>"));
		// 完整皮肤块进无痕 srcdoc
		const doc = buildSrcDoc(htmls[0].html, false, true);
		assert.ok(doc.includes("HP: 80"));
		assert.ok(!doc.includes("PingFang"));
	}
	assert.ok(parts.some((p) => p.kind === "text" && p.text.includes("雨停了")));
	assert.ok(parts.some((p) => p.kind === "text" && p.text.includes("她抬头")));
});

test("RichContent 真路径: 无皮肤时 StatusBlock 仍落状态面板", () => {
	const text = "前文\n<StatusBlock>\nHP: 80\n</StatusBlock>\n后文";
	const parts = splitRichContentParts(text, null);
	assert.ok(parts.some((p) => p.kind === "status" && p.tag === "statusblock"));
	assert.equal(parts.filter((p) => p.kind === "html").length, 0);
});

test("pipeline: 整楼界面判定", () => {
	const rules = displayRules(extractRegexScripts(sampleRaw));
	const onlySkin = applyCardSkin("<StatusBlock>\nHP: 1\n</StatusBlock>", rules, {
		charName: "x",
		userName: "y",
	});
	assert.equal(isFullInterface(onlySkin), true);
	assert.equal(isFullInterface(`旁白\n${onlySkin}`), false);
	// 真路径整楼也是单 html、无 status 段
	const parts = splitRichContentParts("<StatusBlock>\nHP: 1\n</StatusBlock>", {
		rules,
		charName: "x",
		userName: "y",
	});
	assert.equal(parts.length, 1);
	assert.equal(parts[0].kind, "html");
});

test("pipeline: 关闭皮肤=不应用规则时 StatusBlock 仍为文本段(html 层)", () => {
	const text = "<StatusBlock>\nHP: 80\n</StatusBlock>";
	// 无规则：不切 html（自定义标签留给 statusBlocks）
	const parts = splitHtmlParts(text);
	assert.equal(parts.length, 1);
	assert.equal(parts[0].kind, "text");
});
