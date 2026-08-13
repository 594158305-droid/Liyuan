import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEFAULT_ROUND_CARDS,
	fillTemplate,
	loadRoundCardsFile,
	normalizeRoundCards,
	renderRoundCard,
	resolveRoundCardTemplates,
	titlesOf,
	wordRangeHintOf,
} from "../src/flow-templates.ts";

test("数据文件与内嵌默认逐字一致（assets/flow/round-cards.json ↔ DEFAULT_ROUND_CARDS）", () => {
	const fromFile = loadRoundCardsFile(process.cwd());
	assert.ok(fromFile, "round-cards.json 应可加载（仓库根有 assets/flow/）");
	assert.equal(fromFile!.length, DEFAULT_ROUND_CARDS.length);
	for (const t of fromFile!) {
		const builtin = DEFAULT_ROUND_CARDS.find((d) => d.key === t.key);
		assert.ok(builtin, `key ${t.key} 应存在于内嵌默认`);
		assert.equal(t.title, builtin!.title, `${t.key} 标题一致`);
		assert.equal(t.body, builtin!.body, `${t.key} 正文逐字一致（改文案必须两处同步）`);
	}
});

test("内置默认覆盖 7 个流程 key，key 与 title 一一对应", () => {
	const keys = DEFAULT_ROUND_CARDS.map((t) => t.key).sort();
	assert.deepEqual(keys, ["curtain", "extend", "fix", "open", "plan", "review", "seal"]);
	const titles = DEFAULT_ROUND_CARDS.map((t) => t.title);
	assert.ok(titles.every((t) => t.startsWith("【") && t.endsWith("】")), "title 含【】卡名（替换语义前缀）");
});

test("fillTemplate：占位符替换；缺失保留原样（宁可露馅不丢上下文）", () => {
	assert.equal(fillTemplate("你好 {userName}！", { userName: "旅人" }), "你好 旅人！");
	assert.equal(fillTemplate("未知 {nope}", {}), "未知 {nope}");
	assert.equal(fillTemplate("多占位 {a}{b}{a}", { a: "x", b: "y" }), "多占位 xyx");
});

test("renderRoundCard：title + 填充正文", () => {
	const card = { key: "fix", title: "【修复】", body: "共 {violationsCount} 处：\n{violations}" };
	assert.equal(renderRoundCard(card, { violationsCount: "2", violations: "- a\n- b" }), "【修复】共 2 处：\n- a\n- b");
});

test("wordRangeHintOf：字数提示句", () => {
	assert.equal(wordRangeHintOf(800, 1500), "，本拍总字数约 800–1500 字，列路标时把字数分配到每一步（几步就分几份，心里有数）");
});

test("resolveRoundCardTemplates：配置按 key 覆盖；删 key 用内置补回；非法项忽略", () => {
	const builtin = DEFAULT_ROUND_CARDS;
	const overrides = [
		{ key: "plan", title: "【第 1 步·规划】", body: "自定义规划卡 {wordRangeHint}" },
		{ key: "no-such-key", title: "【不存在】", body: "引擎不识别，应被忽略" },
		{ key: "open", title: 42 as unknown as string, body: "非法项应被忽略" },
	];
	const out = resolveRoundCardTemplates(builtin, overrides);
	assert.equal(out.length, builtin.length, "只改不删：7 张卡齐");
	assert.equal(out.find((t) => t.key === "plan")!.body, "自定义规划卡 {wordRangeHint}", "plan 被覆盖");
	assert.ok(!out.some((t) => t.key === "no-such-key"), "内置没有的 key 不追加（引擎不识别）");
	assert.equal(out.find((t) => t.key === "open")!.body, builtin.find((t) => t.key === "open")!.body, "非法覆盖项忽略，保留内置");
});

test("normalizeRoundCards：结构非法返回 null；合法数组通过", () => {
	assert.equal(normalizeRoundCards(null), null);
	assert.equal(normalizeRoundCards({}), null);
	assert.equal(normalizeRoundCards({ cards: [{ key: "a", title: "【A】", body: "x" }, { key: "b" }] }), null, "缺 body 非法");
	const ok = normalizeRoundCards({ cards: [{ key: "a", title: "【A】", body: "x {p}" }] });
	assert.equal(ok?.length, 1);
	assert.equal(ok![0].body, "x {p}");
});

test("titlesOf：按 key 取卡名；缺失给空串", () => {
	assert.deepEqual(titlesOf(DEFAULT_ROUND_CARDS, ["review", "seal", "extend", "fix", "curtain"]), [
		"【演段回看】",
		"【收笔评估】",
		"【续写】",
		"【修复】",
		"【谢幕】",
	]);
	assert.deepEqual(titlesOf(DEFAULT_ROUND_CARDS, ["missing"]), [""]);
});
