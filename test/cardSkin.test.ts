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
