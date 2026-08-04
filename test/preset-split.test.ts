import assert from "node:assert/strict";
import { test } from "node:test";

import {
	BUILTIN_SPLIT_TABLES,
	findSplitTable,
	lookupBlockRule,
	reportItemFor,
	splitBlockContent,
	stripFormatStackLines,
} from "../src/preset-split.ts";

test("findSplitTable：指纹 ≥2 命中认表；不足/未知返回 null", () => {
	const tg = findSplitTable(["😀话痨抢话", "👻TG推荐文风", "别的块"]);
	assert.equal(tg?.key, "tgbreak-v2");
	assert.equal(findSplitTable(["😀话痨抢话"]), null, "单指纹不认（防误配）");
	assert.equal(findSplitTable(["随便", "什么", undefined]), null, "未知预设走兜底且不炸 undefined 名");
});

test("splitBlockContent：整块 fate——resident/skill/rules-only/drop 各就位", () => {
	const table = BUILTIN_SPLIT_TABLES[0]; // tgbreak
	const style = splitBlockContent(lookupBlockRule(table, "👻TG推荐文风"), "👻TG推荐文风", "白描为主。");
	assert.deepEqual(style.resident, [{ section: "B", text: "白描为主。" }]);

	const nsfw = splitBlockContent(lookupBlockRule(table, "🥵瑟瑟描述"), "🥵瑟瑟描述", "直白原则。");
	assert.deepEqual(nsfw.skill, [{ topic: "nsfw", text: "直白原则。" }]);

	const rules = splitBlockContent(lookupBlockRule(table, "✔️文笔优化-比喻"), "✔️文笔优化-比喻", "比喻原则。");
	assert.equal(rules.resident.length + rules.skill.length, 0, "rules-only 不产出上下文文本");

	const cot = splitBlockContent(lookupBlockRule(table, "检查格式"), "检查格式", "strict_format …");
	assert.equal(cot.resident.length + cot.skill.length, 0, "H 类退场");
});

test("splitBlockContent：segments 分段拆——同一块拆向多个去向，剩余走块级 fate", () => {
	const table = BUILTIN_SPLIT_TABLES[2]; // xiajin
	const rule = lookupBlockRule(table, "色情描写/防重复");
	const content = [
		"<色情描写规则>肉体美学……</色情描写规则>",
		"<防重复要求>防重复检查……</防重复要求>",
		"<抗升华>必须以角色的动作/对白收尾。</抗升华>",
		"你在故事中必须使用纯中文。",
		"</用户基础需求>",
	].join("\n");
	const p = splitBlockContent(rule, "色情描写/防重复", content);
	assert.ok(p.skill.some((s) => s.topic === "nsfw" && s.text.includes("肉体美学")), "色情框架入 skill:nsfw");
	assert.ok(!JSON.stringify(p).includes("防重复检查"), "防重复自检段丢弃");
	const residentC = p.resident.filter((r) => r.section === "C").map((r) => r.text).join("\n");
	assert.ok(residentC.includes("抗升华") || residentC.includes("动作/对白收尾"), "抗升华随剩余入常驻 C");
	assert.ok(residentC.includes("纯中文"), "剩余散句入常驻 C");
	assert.ok(!residentC.includes("用户基础需求"), "stripLines 摘掉闭合标签行");
});

test("splitBlockContent：stripLines 句级摘杂质（活人感 random 运算壳）", () => {
	const table = BUILTIN_SPLIT_TABLES[0];
	const rule = lookupBlockRule(table, "💞活人感（测试版）");
	const content = ["人是复杂、不完美的。", "```x1= 2; if( x1 === 1) {衍生性格}else {跳过}```", "结合以上，推断真实反应。"].join("\n");
	const p = splitBlockContent(rule, "💞活人感（测试版）", content);
	const text = p.skill.map((s) => s.text).join("\n");
	assert.ok(text.includes("人是复杂") && text.includes("推断真实反应"), "方法论主体保留");
	assert.ok(!text.includes("x1"), "伪代码运算壳摘除");
});

test("splitBlockContent：四类兜底——style→常驻B / police→仅规则 / format→skill+格式栈行过滤 / noise→丢", () => {
	const style = splitBlockContent(undefined, "未知文风块", "活人感：角色是活人，以直接对白为主。");
	assert.equal(style.fallbackKind, "style");
	assert.equal(style.resident[0]?.section, "B");

	const police = splitBlockContent(undefined, "未知禁词块", '<用户厌恶的词汇>禁词表：“喉结”</用户厌恶的词汇>');
	assert.equal(police.fallbackKind, "police");
	assert.equal(police.resident.length + police.skill.length, 0, "纪律不进上下文（规则提取另扫全量）");

	const fmt = splitBlockContent(
		undefined,
		"未知格式块",
		"输出格式要求：\n严格按顺序输出各模块，不得调换顺序。\n先想清楚结构再动笔。",
	);
	assert.equal(fmt.fallbackKind, "format");
	const fmtText = fmt.skill.map((s) => s.text).join("\n");
	assert.ok(!fmtText.includes("严格按顺序输出"), "格式栈指令行被安全网摘除");
	assert.ok(fmtText.includes("先想清楚结构"), "非指令内容保留");

	const noise = splitBlockContent(undefined, "分隔", "━━━━ 文风 ━━━━");
	assert.equal(noise.fallbackKind, "noise");
	assert.equal(noise.resident.length + noise.skill.length, 0);
});

test("stripFormatStackLines：只摘明确输出指令句式，宁漏勿误", () => {
	const r = stripFormatStackLines(
		["- 按照<w2g>标签名输出，请勿修改标签。", "- 所有标签必须闭合。", "- 选择的内容是用户的行动。"].join("\n"),
	);
	assert.equal(r.dropped, 2);
	assert.ok(r.text.includes("选择的内容"), "内容句保留");
	assert.equal(stripFormatStackLines("纯文风描述。").dropped, 0);
});

test("reportItemFor：去向可读（多去向拼接/仅规则/退场/兜底标注）", () => {
	const table = BUILTIN_SPLIT_TABLES[0];
	const drop = reportItemFor(
		splitBlockContent(lookupBlockRule(table, "检查格式"), "检查格式", "x"),
		"检查格式",
		"postHistory",
		1,
	);
	assert.equal(drop.fate, "退场");
	assert.equal(drop.nature, "H");
	const fb = reportItemFor(splitBlockContent(undefined, "块", "活人感：以对白为主。"), "块", "system", 10);
	assert.ok(String(fb.nature).startsWith("兜底:"));
	assert.equal(fb.fate, "常驻B");
});

test("拆层表卫生：三份表的 sovereigntyOverride 只出现在 C 类；rules-only 只出现在 F 类", () => {
	for (const table of BUILTIN_SPLIT_TABLES) {
		for (const b of table.blocks) {
			if (b.sovereigntyOverride) assert.equal(b.nature, "C", `${table.key}/${b.name}`);
			if (b.fate === "rules-only") assert.equal(b.nature, "F", `${table.key}/${b.name}`);
		}
	}
});
