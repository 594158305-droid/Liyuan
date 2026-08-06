/**
 * 回合时间线（web/src/timeline.ts）：思考/工具/正文按发生顺序分段。
 *
 * 本文件钉死的核心不变量：
 * - 时序即渲染序（旧结构的三分区固定顺序是病根，不能回退）
 * - 分段只影响排列，不改写任何正文字符（D10）
 * - stream:clear 只删末尾正文段，已定稿的前文与过程记录不动
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	activitiesOf,
	appendActivity,
	appendDelta,
	concatSegments,
	dropTrailingText,
	estimateTokens,
	formatTokenCount,
	pruneEmpty,
	segmentsFromLegacy,
	textOf,
	thinkingOf,
	trailingText,
	type TurnSegment,
} from "../web/src/timeline.ts";
import type { WireActivity } from "../web/src/wire.ts";

const call = (name: string): WireActivity => ({ kind: "tool_start", name, detail: "" });
const done = (name: string): WireActivity => ({ kind: "tool_end", name, detail: "" });

test("同类增量并入末段，异类开新段——时序即渲染序", () => {
	let segs: TurnSegment[] = [];
	segs = appendDelta(segs, "thinking", "先想");
	segs = appendDelta(segs, "thinking", "一下");
	segs = appendDelta(segs, "text", "正文甲");
	segs = appendDelta(segs, "thinking", "再想");
	segs = appendDelta(segs, "text", "正文乙");

	assert.deepEqual(
		segs.map((s) => s.kind),
		["thinking", "text", "thinking", "text"],
	);
	assert.equal(segs[0].kind === "thinking" && segs[0].text, "先想一下");
	// 关键：第二段思考排在正文甲之后，而不是被抽到顶上与第一段合并
	assert.equal(segs[2].kind === "thinking" && segs[2].text, "再想");
});

test("空增量不产生空段", () => {
	const segs = appendDelta(appendDelta([], "text", ""), "thinking", "");
	assert.deepEqual(segs, []);
});

test("连续工具聚成一段，被正文打断则开新段", () => {
	let segs: TurnSegment[] = [];
	segs = appendActivity(segs, call("draft_write"));
	segs = appendActivity(segs, done("draft_write"));
	assert.equal(segs.length, 1);
	assert.equal(segs[0].kind === "tool" && segs[0].activities.length, 2);

	segs = appendDelta(segs, "text", "改完的正文");
	segs = appendActivity(segs, call("draft_check"));
	assert.deepEqual(
		segs.map((s) => s.kind),
		["tool", "text", "tool"],
	);
});

test("思考→工具→正文→思考 的完整一拍：顺序原样保留", () => {
	let segs: TurnSegment[] = [];
	segs = appendDelta(segs, "thinking", "读题");
	segs = appendActivity(segs, call("lorebook_search"));
	segs = appendDelta(segs, "text", "初稿");
	segs = appendDelta(segs, "thinking", "自检");
	segs = appendActivity(segs, call("draft_edit"));
	segs = appendDelta(segs, "text", "改后");

	assert.deepEqual(
		segs.map((s) => s.kind),
		["thinking", "tool", "text", "thinking", "tool", "text"],
	);
	// 合流口径：正文只取 text 段，思考只取 thinking 段，互不串味
	assert.equal(textOf(segs), "初稿改后");
	assert.equal(thinkingOf(segs), "读题\n\n自检");
	assert.equal(activitiesOf(segs).length, 2);
});

test("dropTrailingText 只删末尾正文段，思考与工具保留", () => {
	let segs: TurnSegment[] = [];
	segs = appendDelta(segs, "thinking", "想");
	segs = appendActivity(segs, call("draft_write"));
	segs = appendDelta(segs, "text", "中间态计划旁白");

	const after = dropTrailingText(segs);
	assert.deepEqual(
		after.map((s) => s.kind),
		["thinking", "tool"],
	);
});

test("dropTrailingText 不动前面轮次已定稿的正文", () => {
	let segs: TurnSegment[] = [];
	segs = appendDelta(segs, "text", "第一轮定稿");
	segs = appendActivity(segs, call("draft_check"));
	segs = appendDelta(segs, "text", "待丢的半截");

	const after = dropTrailingText(segs);
	assert.equal(textOf(after), "第一轮定稿");
	assert.equal(after.length, 2);
});

test("trailingText 取末尾中间态正文（留档成 note 用）", () => {
	let segs: TurnSegment[] = [];
	segs = appendDelta(segs, "thinking", "想");
	segs = appendDelta(segs, "text", "计划：先查设定");
	assert.equal(trailingText(segs), "计划：先查设定");

	// 末段不是正文时为空
	segs = appendActivity(segs, call("x"));
	assert.equal(trailingText(segs), "");
});

test("无末尾正文时 dropTrailingText 返回原数组（不做无谓拷贝）", () => {
	const segs: TurnSegment[] = [{ kind: "thinking", text: "想" }];
	assert.equal(dropTrailingText(segs), segs);
});

test("estimateTokens：中文按字计，英文按 1/4 计", () => {
	// 纯中文 10 字 → 约 10 token（按 /4 会低报到 2~3，那是要避免的）
	assert.equal(estimateTokens("一二三四五六七八九十"), 10);
	// 纯 ASCII 40 字符 → 约 10
	assert.equal(estimateTokens("a".repeat(40)), 10);
	// 空串也至少 1，避免显示 0K
	assert.equal(estimateTokens(""), 1);
});

test("formatTokenCount：千位转 K", () => {
	assert.equal(formatTokenCount(1), "1");
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(1200), "1.2K");
	assert.equal(formatTokenCount(20357), "20K");
});

test("pruneEmpty 清空壳段但留有内容的段", () => {
	const segs: TurnSegment[] = [
		{ kind: "thinking", text: "  " },
		{ kind: "text", text: "正文" },
		{ kind: "tool", activities: [] },
		{ kind: "tool", activities: [call("x")] },
	];
	assert.deepEqual(
		pruneEmpty(segs).map((s) => s.kind),
		["text", "tool"],
	);
});

test("segmentsFromLegacy：老消息按旧渲染约定合成（思考→过程→正文）", () => {
	const segs = segmentsFromLegacy({ thinking: "想", activities: [call("x")], text: "正文" });
	assert.deepEqual(
		segs.map((s) => s.kind),
		["thinking", "tool", "text"],
	);
	// 缺字段不产生空段
	assert.deepEqual(segmentsFromLegacy({ text: "只有正文" }).map((s) => s.kind), ["text"]);
	assert.deepEqual(segmentsFromLegacy({}), []);
});

test("concatSegments：相邻同类归并，文本间补空行不黏连", () => {
	const a: TurnSegment[] = [{ kind: "text", text: "上一稿。" }];
	const b: TurnSegment[] = [{ kind: "text", text: "下一稿。" }];
	const merged = concatSegments(a, b);
	assert.equal(merged.length, 1);
	assert.equal(textOf(merged), "上一稿。\n\n下一稿。");

	// 工具段相接合成一组
	const t = concatSegments([{ kind: "tool", activities: [call("a")] }], [{ kind: "tool", activities: [call("b")] }]);
	assert.equal(t.length, 1);
	assert.equal(t[0].kind === "tool" && t[0].activities.length, 2);

	// 异类不归并，且整体时序 = a 在前 b 在后
	const x = concatSegments([{ kind: "thinking", text: "想" }], [{ kind: "text", text: "写" }]);
	assert.deepEqual(x.map((s) => s.kind), ["thinking", "text"]);
});

test("D10：分段不改写正文字符（含空白与标记原样）", () => {
	const raw = '  *他抬头*，"你来了。"\n\n  末尾空白  ';
	let segs: TurnSegment[] = [];
	for (const ch of raw) segs = appendDelta(segs, "text", ch);
	assert.equal(textOf(segs), raw);
});

test("稿件流（draft=true）替换末尾正文段——多稿重交不叠加", () => {
	let segs: TurnSegment[] = [];
	segs = appendDelta(segs, "thinking", "读题");
	// 第一稿：首块 reset + 分片
	segs = appendDelta(segs, "text", "初稿", true, true);
	segs = appendDelta(segs, "text", "后半", true);
	assert.equal(textOf(segs), "初稿后半", "同稿分片并入当前稿段");

	// 重交：首块 reset 清掉旧稿，分片续上——初稿不得残留
	segs = appendDelta(segs, "text", "终稿", true, true);
	segs = appendDelta(segs, "text", "全文", true);
	assert.equal(textOf(segs), "终稿全文", "重交 = 替换不是叠加（8/05 屏上双份正文的病根）");
	assert.equal(segs.length, 2, "思考段保留，正文段只有一个");

	// 重交后格式尾巴（非 draft）照常追加
	segs = appendDelta(segs, "text", "<catsay>点评</catsay>");
	assert.equal(textOf(segs), "终稿全文<catsay>点评</catsay>");
});

test("稿件流替换语义不动非末尾正文（已定稿的前文）", () => {
	let segs: TurnSegment[] = [];
	segs = appendDelta(segs, "text", "第一轮定稿");
	segs = appendActivity(segs, call("draft_write"));
	segs = appendDelta(segs, "text", "第二轮新稿", true, true);
	assert.equal(textOf(segs), "第一轮定稿第二轮新稿", "只替换末尾段，前文不动");
});
