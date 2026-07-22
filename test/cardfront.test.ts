import assert from "node:assert/strict";
import test from "node:test";
import { displayRules, extractRegexScripts, isSkinEnabled, setSkinEnabled } from "../src/cardfront.ts";

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
	const rules = displayRules([{ ...skinScript, findRegex: "/([unclosed/g" }, skinScript]);
	assert.equal(rules.length, 1);
});

test("displayRules: trimStrings 非空的规则整条跳过(v1 不支持,宁缺毋错)", () => {
	const rules = displayRules([{ ...skinScript, trimStrings: ["x"] }]);
	assert.equal(rules.length, 0);
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
