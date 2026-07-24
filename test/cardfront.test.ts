import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCardFrontSnapshot,
	displayRules,
	extractRegexScripts,
	isSkinEnabled,
	setSkinEnabled,
} from "../src/cardfront.ts";

/** 淫宫美人录实卡形态(内联夹具,不读盘,测试自包含) */
const skinScript = {
	scriptName: "状态栏",
	findRegex: "/<StatusBlock>/gs",
	replaceString: '<div style="background-color: rgba(0, 0, 0, 0.5);"><status>',
	placement: [2],
	disabled: false,
	markdownOnly: true,
	promptOnly: false,
	trimStrings: [],
};
/** 大乾风华录:promptOnly 清理向,显示层必须排除 */
const promptOnlyScript = {
	scriptName: "删除描写分析",
	findRegex: "/<descriptive_analysis>[\\s\\S]*</descriptive_analysis>/gm",
	replaceString: "",
	placement: [2],
	disabled: false,
	markdownOnly: false,
	promptOnly: true,
	trimStrings: [],
};

test("extractRegexScripts: data.extensions 与顶层 extensions 都认,缺失返回空", () => {
	assert.equal(extractRegexScripts({ data: { extensions: { regex_scripts: [skinScript] } } }).length, 1);
	assert.equal(extractRegexScripts({ extensions: { regex_scripts: [skinScript] } }).length, 1);
	assert.deepEqual(extractRegexScripts({ name: "x" }), []);
	assert.deepEqual(extractRegexScripts({ data: { extensions: { regex_scripts: "bad" } } }), []);
});

test("displayRules: 显示向保留,promptOnly/disabled/非AI输出排除", () => {
	const rules = displayRules([
		skinScript,
		promptOnlyScript,
		{ ...skinScript, scriptName: "已停用", disabled: true },
		{ ...skinScript, scriptName: "只管用户输入", placement: [1] },
	]);
	assert.equal(rules.length, 1);
	assert.equal(rules[0].name, "状态栏");
	assert.equal(rules[0].source, "<StatusBlock>");
	assert.equal(rules[0].flags, "gs");
	assert.ok(rules[0].replace.startsWith("<div"));
});

test("displayRules: 裸模式串(无 /…/ 包裹)按字面正则源处理", () => {
	const rules = displayRules([{ ...skinScript, findRegex: "<StatusBlock>" }]);
	assert.equal(rules.length, 1);
	assert.equal(rules[0].source, "<StatusBlock>");
	assert.equal(rules[0].flags, "g"); // 无声明时默认 g,保证全文替换
});

test("displayRules: 非法正则跳过不抛", () => {
	const warnings: string[] = [];
	const oldWarn = console.warn;
	try {
		console.warn = (...args) => warnings.push(args.join(" "));
		const rules = displayRules([{ ...skinScript, findRegex: "/([unclosed/g" }, skinScript]);
		assert.equal(rules.length, 1);
		assert.ok(warnings.some((w) => w.includes("正则无法解析")));
	} finally {
		console.warn = oldWarn;
	}
});

test("displayRules: trimStrings 非空的规则整条跳过(v1 不支持,宁缺毋错)", () => {
	const warnings: string[] = [];
	const oldWarn = console.warn;
	try {
		console.warn = (...args) => warnings.push(args.join(" "));
		const rules = displayRules([{ ...skinScript, trimStrings: ["x"] }]);
		assert.equal(rules.length, 0);
		assert.ok(warnings.some((w) => w.includes("trimStrings")));
	} finally {
		console.warn = oldWarn;
	}
});

test("skin 开关:默认开,cardSkinOff 关,setSkinEnabled 幂等往返", () => {
	const cfg = { card: "assets/cards/a.png" } as never;
	assert.equal(isSkinEnabled({ card: "assets/cards/a.png" }, "assets/cards/a.png"), true);
	const off = setSkinEnabled(cfg, "assets/cards/a.png", false);
	assert.equal(isSkinEnabled(off, "assets/cards/a.png"), false);
	const on = setSkinEnabled(off, "assets/cards/a.png", true);
	assert.equal(isSkinEnabled(on, "assets/cards/a.png"), true);
	assert.deepEqual(on.cardSkinOff, []);
});

test("displayRules: substituteRegex 非零的规则整条跳过,warn", () => {
	const warnings: string[] = [];
	const oldWarn = console.warn;
	try {
		console.warn = (...args) => warnings.push(args.join(" "));
		const rules = displayRules([{ ...skinScript, substituteRegex: 1 }]);
		assert.equal(rules.length, 0);
		assert.ok(warnings.some((w) => w.includes("substituteRegex")));
	} finally {
		console.warn = oldWarn;
	}
});

test("displayRules: minDepth/maxDepth 字段忽略但 warn,规则仍应用", () => {
	const warnings: string[] = [];
	const oldWarn = console.warn;
	try {
		console.warn = (...args) => warnings.push(args.join(" "));
		const rules = displayRules([{ ...skinScript, minDepth: 2 }]);
		assert.equal(rules.length, 1);
		assert.ok(warnings.some((w) => w.includes("深度限定")));
	} finally {
		console.warn = oldWarn;
	}
});

test("buildCardFrontSnapshot: hello/REST 同源载荷", () => {
	const raw = { data: { name: "美人录", extensions: { regex_scripts: [skinScript] } } };
	const snap = buildCardFrontSnapshot(
		{ card: "assets/cards/a.png", userName: "旅人" },
		raw,
		"美人录",
	);
	assert.equal(snap.enabled, true);
	assert.equal(snap.hasSkin, true);
	assert.equal(snap.rules.length, 1);
	assert.equal(snap.charName, "美人录");
	assert.equal(snap.userName, "旅人");

	const off = buildCardFrontSnapshot(
		{ card: "assets/cards/a.png", cardSkinOff: ["assets/cards/a.png"], userName: "旅人" },
		raw,
		"美人录",
	);
	assert.equal(off.enabled, false);
	assert.equal(off.hasSkin, true); // 卡上有皮;前端用 enabled 决定是否应用
	assert.equal(off.rules.length, 1);

	const empty = buildCardFrontSnapshot({ card: "x", userName: "u" }, null, "");
	assert.equal(empty.hasSkin, false);
	assert.deepEqual(empty.rules, []);
});
