import assert from "node:assert/strict";
import test from "node:test";
import { applyCardSkin } from "../web/src/cardSkin.ts";

const M = { charName: "青梧", userName: "旅人" };
const wrapOpen = { name: "状态栏", source: "<StatusBlock>", flags: "gs", replace: '<div style="x"><status>' };
const wrapClose = { name: "状态栏2", source: "</StatusBlock>", flags: "gs", replace: "</status></div>" };

test("皮肤包装:开闭标签替换为卡作者 HTML(淫宫美人录模式)", () => {
	const out = applyCardSkin("正文\n<StatusBlock>\nHP: 80\n</StatusBlock>\n尾", [wrapOpen, wrapClose], M);
	assert.ok(out.includes('<div style="x"><status>'));
	assert.ok(out.includes("</status></div>"));
	assert.ok(!out.includes("<StatusBlock>"));
});

test("捕获组 $1 重排进模板", () => {
	const rule = { name: "血条", source: "HP[:：]\\s*(\\d+)", flags: "g", replace: '<b class="hp">$1</b>' };
	assert.equal(applyCardSkin("HP: 80", [rule], M), '<b class="hp">80</b>');
});

test("宏:find 与 replace 里的 {{user}}/{{char}} 生效;find 侧转义安全", () => {
	const rule = { name: "呼名", source: "{{char}}(说)", flags: "g", replace: "「{{char}}」$1" };
	assert.equal(applyCardSkin("青梧说", [rule], M), "「青梧」说");
});

test("{{match}} 映射整段命中", () => {
	const rule = { name: "高亮", source: "\\*\\*.+?\\*\\*", flags: "g", replace: "<mark>{{match}}</mark>" };
	assert.equal(applyCardSkin("**重要**", [rule], M), "<mark>**重要**</mark>");
});

test("单条规则运行期出错不影响其余规则", () => {
	// flags 合法但 source 在应用期构造失败的场景难造,退一步:构造期抛错由 try/catch 吞掉
	const bad = { name: "坏", source: "(?<", flags: "g", replace: "x" };
	assert.equal(applyCardSkin("<StatusBlock>a</StatusBlock>", [bad, wrapOpen, wrapClose], M).includes("<status>"), true);
});

test("空规则原文返回", () => {
	assert.equal(applyCardSkin("原文", [], M), "原文");
});

test("字面量 $' 不得被 String.replace 特殊序列吃掉（程序卡 '$' 字符）", () => {
	// 模拟凡人修仙 TILE 字符表：'|','$','T'
	const rule = {
		name: "dollar-char",
		source: "TOKEN",
		flags: "g",
		replace: "['|','$','T']",
	};
	assert.equal(applyCardSkin("TOKEN", [rule], M), "['|','$','T']");
});

test("字面 $$ 与捕获组并存", () => {
	const rule = {
		name: "price",
		source: "price:(\\d+)",
		flags: "g",
		replace: "$$ $1",
	};
	assert.equal(applyCardSkin("price:42", [rule], M), "$ 42");
});

test("长替换串（程序卡）不展开 $&；无捕获时 $1 保持字面", () => {
	const payload = `${"x".repeat(9000)} placement.replace(/\\$&/g, args[0]); $1 end`;
	const rule = { name: "prog", source: "TOKEN", flags: "g", replace: payload };
	const out = applyCardSkin("TOKEN", [rule], M);
	assert.ok(out.includes("/\\$&/g"), "卡内 /\\$&/g 必须原样");
	// TOKEN 无捕获组 → $1 保持字面
	assert.ok(out.includes(" $1 end"), "无对应捕获时 $1 保持字面");
	assert.ok(!out.includes("/\\TOKEN/g"), "不得把 $& 展开成命中文本");
});

test("长替换串仍展开有效 $2（LWS 状态栏 rawData=`$2`）", () => {
	const body = "『姓名』: 明月\n『内心想法』: 想逃";
	const payload =
		"```html\n<!DOCTYPE html><html><body><script>const rawData = `$2`;</script><div id=x></div></body></html>\n```".replace(
			"```html\n",
			"```html\n" + "y".repeat(9000) + "\n",
		);
	// 保证超阈值
	assert.ok(payload.length > 8000);
	const rule = {
		name: "state-bar",
		source: "<(state\\d+)>([\\s\\S]+?)<\\/\\1>",
		flags: "g",
		replace: payload,
	};
	const out = applyCardSkin(`<state1>\n${body}\n</state1>`, [rule], M);
	assert.ok(!out.includes("`$2`") && !out.includes("rawData = `$2`"), "不得残留字面 $2");
	assert.ok(out.includes("明月") && out.includes("想逃"), "捕获正文须注入模板");
});
