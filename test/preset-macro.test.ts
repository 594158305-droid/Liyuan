/**
 * 预设宏求值器：ST 宏最小核心集（setvar/getvar/addvar/random/trim/{{//}}/lastusermessage/char/user）。
 * 承诺边界：清单外的 {{…}} 一律剥除并记入 unsupported（显式降级，不发字面量噪声）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createMacroEnv, evalPresetMacros } from "../src/preset-macro.ts";

const env = (overrides: Partial<Parameters<typeof createMacroEnv>[0]> = {}) =>
	createMacroEnv({ charName: "阿远", userName: "小舟", userText: "我们出发吧", ...overrides });

test("char/user 宏替换（大小写不敏感）", () => {
	const r = evalPresetMacros("{{char}}看着{{USER}}", env());
	assert.equal(r.text, "阿远看着小舟");
	assert.deepEqual(r.unsupported, []);
});

test("setvar 存值返回空串，getvar 取值，未定义取空", () => {
	const e = env();
	const r1 = evalPresetMacros("{{setvar::pov::第一人称}}", e);
	assert.equal(r1.text, "");
	const r2 = evalPresetMacros("视角:{{getvar::pov}}|空:{{getvar::nothing}}", e);
	assert.equal(r2.text, "视角:第一人称|空:");
});

test("setvar 值可含多行与冒号外字符，跨块共享同一 env", () => {
	const e = env();
	evalPresetMacros("{{setvar::hook::\n<rule>\n- 不收尾\n</rule>\n}}", e);
	const r = evalPresetMacros("{{getvar::hook}}", e);
	assert.ok(r.text.includes("- 不收尾"));
});

test("addvar 追加到已有值", () => {
	const e = env();
	evalPresetMacros("{{setvar::style::简练}}{{addvar::style::、冷峻}}", e);
	assert.equal(evalPresetMacros("{{getvar::style}}", e).text, "简练、冷峻");
});

test("setvar 空值可清空变量", () => {
	const e = env();
	evalPresetMacros("{{setvar::x::有}}{{setvar::x::}}", e);
	assert.equal(evalPresetMacros("[{{getvar::x}}]", e).text, "[]");
});

test("getvar 取出的值中若含宏，继续求值（有限轮，自引用不死循环）", () => {
	const e = env();
	evalPresetMacros("{{setvar::inner::{{char}}的独白}}", e);
	assert.equal(evalPresetMacros("{{getvar::inner}}", e).text, "阿远的独白");
	// 自引用：不挂起，最终剥除
	evalPresetMacros("{{setvar::loop::A{{getvar::loop}}}}", e);
	const r = evalPresetMacros("{{getvar::loop}}", e);
	assert.ok(!r.text.includes("{{"), `自引用应被剥净，得到:${r.text}`);
});

test("random：逗号列表与 :: 列表都支持，结果是候选之一", () => {
	const candidates = ["甲", "乙", "丙"];
	for (const tpl of ["{{random::甲,乙,丙}}", "{{random::甲::乙::丙}}"]) {
		const r = evalPresetMacros(tpl, env());
		assert.ok(candidates.includes(r.text), `${tpl} → ${r.text}`);
	}
});

test("{{//注释}} 与 {{trim}} 剥除；trim 收掉两侧空白", () => {
	const r = evalPresetMacros("{{//这是说明文字}}正文A \n {{trim}} \n正文B", env());
	assert.equal(r.text, "正文A正文B");
});

test("lastusermessage 展开为本轮用户原文，缺省为空", () => {
	assert.equal(evalPresetMacros("<m>{{lastusermessage}}</m>", env()).text, "<m>我们出发吧</m>");
	assert.equal(evalPresetMacros("<m>{{lastusermessage}}</m>", env({ userText: undefined })).text, "<m></m>");
});

test("清单外宏剥除并记录名字（去重）", () => {
	const r = evalPresetMacros("{{roll:d20}}A{{time}}B{{pick::x,y}}C{{time}}", env());
	assert.equal(r.text, "ABC");
	assert.deepEqual([...r.unsupported].sort(), ["pick", "roll", "time"]);
});

test("非宏的花括号文本不受影响", () => {
	const src = "JSON 示例 {\"a\":1} 与 ${模板} 原样保留";
	assert.equal(evalPresetMacros(src, env()).text, src);
});

test("实战混合：双人成行式块求值", () => {
	const e = env();
	evalPresetMacros(
		"{{setvar::pov_target::\n<pov>\n写作视角: 用户角色第一人称\n</pov>\n}}{{setvar::word_count::1000-1500}}{{trim}}",
		e,
	);
	const r = evalPresetMacros(
		"【问题】核心文风:\n  - 以{{getvar::pov_target}}叙述故事\n【问题】字数: {{getvar::word_count}}字\n{{getvar::plot_check}}{{unknownmacro::x}}",
		e,
	);
	assert.ok(r.text.includes("用户角色第一人称"));
	assert.ok(r.text.includes("1000-1500字"));
	assert.ok(!r.text.includes("{{"));
	assert.deepEqual(r.unsupported, ["unknownmacro"]);
});
