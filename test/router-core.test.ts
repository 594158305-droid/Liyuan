import assert from "node:assert/strict";
import { test } from "node:test";

import {
	bandOf,
	cardFor,
	classifyTask,
	countHits,
	DEFAULT_CARDS,
	DEFAULT_LEXICON,
	DEFAULT_PERSONAS,
	agentPersonaFor,
	isComplexTask,
	isFlashModel,
	parseMode,
	personaFor,
	type RouterCard,
} from "../src/router-core.ts";

/**
 * 梨园化 router 核心纯函数（docs/DESIGN-router.md）：任务分类 / 复杂度 / 模型分档 /
 * 模式卡。机制照搬 dsh-router-standard（净命中多者胜、平局回 weak、长度或关键词判复杂），
 * 词表按 RP 语境重标定。
 */

// ---------------- isFlashModel ----------------

test("isFlashModel：flash 家族命中，pro/其他不命中", () => {
	assert.equal(isFlashModel("deepseek-v4-flash"), true);
	assert.equal(isFlashModel("deepseek-v4-pro"), false);
	assert.equal(isFlashModel("claude-sonnet-4-5"), false);
	assert.equal(isFlashModel(undefined), false);
});

// ---------------- countHits / classifyTask ----------------

test("classifyTask：构造信号 > 修复 → react", () => {
	assert.equal(classifyTask("继续演下去，写一段大场面高潮"), "react");
	assert.equal(classifyTask("推进剧情，新角色登场，展开群像戏"), "react");
});

test("classifyTask：修复信号 > 构造 → spec", () => {
	assert.equal(classifyTask("上一拍文风崩了，重写一下"), "spec");
	assert.equal(classifyTask("太短了，扩写，别这样敷衍"), "spec");
	// 补充/丰富类话术（8/16 实弹校准）：多补充细节 > 续写/发展 → 修复拍
	assert.equal(classifyTask("多补充动作和对话细节，自由加一些没营养的动作也没关系，禁止续写"), "spec");
});

test("classifyTask：无命中 → 长剧情输入兜底构造（react），寒暄短句回 weak", () => {
	// 寒暄短句（<40 字）不强推
	assert.equal(classifyTask("嗯"), "weak");
	assert.equal(classifyTask("好的，知道了"), "weak");
	// 长剧情行动/对话（无关键词）在 RP 里几乎都是构造 → 兜底 react（DESIGN-router §8.1）
	const longScene = "凯尔绕回了自己的店长房间，美美睡了一觉。不过最近都没怎么攻略位面之子，这会儿又报销了2000点数，凯尔着实心疼。起来后，凯尔吩咐阿罗娜找找有没有值得下手的目标。";
	assert.ok(longScene.length >= 40);
	assert.equal(classifyTask(longScene), "react");
	assert.equal(classifyTask(""), "weak");
	assert.equal(classifyTask("  "), "weak");
	assert.equal(classifyTask(undefined), "weak");
});

test("classifyTask：平局（构造=修复都有命中）→ weak（真模糊，模型自判）", () => {
	// 「续写」build + 「扩写」fix → 1:1 平局 → weak
	assert.equal(classifyTask("续写，扩写"), "weak");
	// 净命中规则：build 双命中（继续+推进）> fix 单命中（重写）→ react
	assert.equal(classifyTask("继续推进，也重写一下"), "react");
});

test("classifyTask：自定义词表覆盖", () => {
	const lex = { build: ["喵"], fix: ["汪"], complex: [] };
	assert.equal(classifyTask("喵喵喵", lex), "react");
	assert.equal(classifyTask("汪汪汪", lex), "spec");
	assert.equal(classifyTask("叽", lex), "weak");
});

// ---------------- isComplexTask ----------------

test("isComplexTask：长文本（>120 字）→ true", () => {
	const long = "本".repeat(121);
	assert.equal(isComplexTask(long), true);
	assert.equal(isComplexTask("短句"), false);
});

test("isComplexTask：复杂关键词 → true；普通关键词不误伤", () => {
	assert.equal(isComplexTask("这场战役要写群像多线，设定密集"), true);
	assert.equal(isComplexTask("继续演一段"), false);
});

// ---------------- bandOf / parseMode ----------------

test("bandOf：weak/auto/undefined → weak；数字 <0.2 → spec，≥0.2 → react", () => {
	assert.equal(bandOf("weak"), "weak");
	assert.equal(bandOf("auto"), "weak");
	assert.equal(bandOf(undefined), "weak");
	assert.equal(bandOf(0), "spec");
	assert.equal(bandOf(0.19), "spec");
	assert.equal(bandOf(0.2), "react");
	assert.equal(bandOf(1), "react");
	assert.equal(bandOf(50), "react"); // 0-100 数字按 /100 处理
});

test("parseMode：band 名 / 数字 / auto / 非法", () => {
	assert.equal(parseMode("spec"), "spec");
	assert.equal(parseMode("react"), "react");
	assert.equal(parseMode("weak"), "weak");
	assert.equal(parseMode("auto"), "auto");
	assert.equal(parseMode("0"), "spec");
	assert.equal(parseMode("100"), "react");
	assert.equal(parseMode("0.3"), "react");
	assert.equal(parseMode("xyz"), null);
	assert.equal(parseMode(undefined), null);
});

// ---------------- personaFor（模型分档） ----------------

test("personaFor weak：pro 无锚 / flash 带锚，文案不同", () => {
	const pro = personaFor("weak", "deepseek-v4-pro");
	const flash = personaFor("weak", "deepseek-v4-flash");
	assert.equal(pro, DEFAULT_PERSONAS.pro);
	assert.equal(flash, DEFAULT_PERSONAS.flash);
	assert.notEqual(pro, flash);
	// flash 锚：含「回看/不重复/信息够用就落笔」
	assert.ok(flash.includes("信息够用就落笔"));
	// pro 无锚：不含防 runaway 句
	assert.ok(!pro.includes("地毯式检索"));
});

test("personaFor：覆盖优先于内置（pro/flash/spec/react 各自独立）", () => {
	const overrides = { pro: "自定义 pro 人格", flash: "自定义 flash 人格" };
	assert.equal(personaFor("weak", "deepseek-v4-pro", overrides), "自定义 pro 人格");
	assert.equal(personaFor("weak", "deepseek-v4-flash", overrides), "自定义 flash 人格");
	assert.equal(personaFor("weak", "deepseek-v4-pro"), DEFAULT_PERSONAS.pro); // 未覆盖仍内置
});

test("personaFor：强人格按 band（spec/react），与模型无关", () => {
	assert.equal(personaFor("spec", "deepseek-v4-flash"), DEFAULT_PERSONAS.spec);
	assert.equal(personaFor("react", "deepseek-v4-pro"), DEFAULT_PERSONAS.react);
});

test("agentPersonaFor：Pro 审题规划 / Flash 快动作，按模型分档", () => {
	const pro = agentPersonaFor("pro", "deepseek-v4-pro");
	const flash = agentPersonaFor("flash", "deepseek-v4-flash");
	assert.notEqual(pro, flash);
	assert.ok(pro.includes("审题规划"), "pro 审题规划姿态");
	assert.ok(flash.includes("快动作"), "flash 快动作姿态");
	// band=flash 优先于 modelId；undefined 模型按 band
	assert.ok(agentPersonaFor("flash", undefined).includes("快动作"));
	assert.ok(agentPersonaFor("pro", "deepseek-v4-flash").includes("审题规划"), "band 覆盖 modelId");
});

// ---------------- cardFor（模式卡） ----------------

test("cardFor：weak → 无卡", () => {
	assert.equal(cardFor("weak"), null);
});

test("cardFor：构造拍 / 修复拍普通卡", () => {
	const build = cardFor("react");
	assert.equal(build?.key, "router-build");
	assert.ok(build?.body.includes("draft_append"));
	const fix = cardFor("spec");
	assert.equal(fix?.key, "router-fix");
	assert.ok(fix?.body.includes("draft_edit"));
});

test("cardFor：深度卡填充 {direction}，flash 追加防太浅 {flashGuard}", () => {
	const deepPro = cardFor("react", { complex: true, modelId: "deepseek-v4-pro" });
	assert.equal(deepPro?.key, "router-deep");
	assert.ok(deepPro?.body.includes("按推进节奏演"));
	assert.ok(!deepPro?.body.includes("宁可多想一步")); // pro 无 flashGuard
	assert.ok(!deepPro?.body.includes("{flashGuard}"), "pro 深度卡不得残留占位符（模板泄漏）");
	assert.ok(!deepPro?.body.includes("{direction}"), "pro 深度卡不得残留 direction 占位符");
	const deepFlashFix = cardFor("spec", { complex: true, modelId: "deepseek-v4-flash" });
	assert.ok(deepFlashFix?.body.includes("按修正节奏演"));
	assert.ok(deepFlashFix?.body.includes("宁可多想一步也不要交浅稿"));
	// 占位符不留残余
	assert.ok(!deepFlashFix?.body.includes("{direction}"));
	assert.ok(!deepFlashFix?.body.includes("{flashGuard}"));
});

test("cardFor：卡覆盖优先于内置", () => {
	const cards: Partial<Record<"build" | "fix" | "deep", RouterCard>> = {
		build: { key: "router-build", title: "【构造拍·自定义】", body: "直接演" },
	};
	const build = cardFor("react", { cards });
	assert.equal(build?.title, "【构造拍·自定义】");
	assert.equal(build?.body, "直接演");
	// 未覆盖的 key 仍内置
	assert.equal(cardFor("spec", { cards })?.key, "router-fix");
});

// ---------------- 内置常量与 router.json 一致性 ----------------

test("内置词表/卡/人格常量齐全（供 router-config 默认值引用）", () => {
	assert.ok(DEFAULT_LEXICON.build.length > 20);
	assert.ok(DEFAULT_LEXICON.fix.length > 20);
	assert.ok(DEFAULT_LEXICON.complex.length >= 8);
	assert.ok(DEFAULT_PERSONAS.pro.length > 10);
	assert.ok(DEFAULT_PERSONAS.flash.length > 10);
	assert.deepEqual(Object.keys(DEFAULT_CARDS).sort(), ["build", "deep", "fix"]);
});
