import assert from "node:assert/strict";
import { test } from "node:test";

import { PROACTIVE_COMPACT_MIN_TOKENS, shouldProactiveCompact } from "../src/compaction.ts";
import { formatLoreIndex } from "../src/director.ts";

// ---------- 固定楼层压缩判定 ----------

const base = {
	narrativeTurnsSinceCompact: 30,
	everyNTurns: 30,
	contextTokens: PROACTIVE_COMPACT_MIN_TOKENS,
	compactInFlight: false,
};

test("固定楼层压缩：轮数达标 + token 足量 + 无在途 → 触发", () => {
	assert.equal(shouldProactiveCompact(base), true);
});

test("固定楼层压缩：everyNTurns=0 关闭主动压缩", () => {
	assert.equal(shouldProactiveCompact({ ...base, everyNTurns: 0 }), false);
	assert.equal(shouldProactiveCompact({ ...base, everyNTurns: -1 }), false);
});

test("固定楼层压缩：轮数未达周期不触发", () => {
	assert.equal(shouldProactiveCompact({ ...base, narrativeTurnsSinceCompact: 29 }), false);
});

test("固定楼层压缩：上下文低于门槛不触发（可裁余量太少，压了白压）", () => {
	assert.equal(shouldProactiveCompact({ ...base, contextTokens: PROACTIVE_COMPACT_MIN_TOKENS - 1 }), false);
});

test("固定楼层压缩：token 未知（刚压缩完/未知模型）不触发，等被动压缩兜底", () => {
	assert.equal(shouldProactiveCompact({ ...base, contextTokens: null }), false);
	assert.equal(shouldProactiveCompact({ ...base, contextTokens: undefined }), false);
});

test("固定楼层压缩：已有压缩在途不重复触发", () => {
	assert.equal(shouldProactiveCompact({ ...base, compactInFlight: true }), false);
});

test("固定楼层压缩：轮数远超周期（压缩失败后累积）仍可触发", () => {
	assert.equal(shouldProactiveCompact({ ...base, narrativeTurnsSinceCompact: 95 }), true);
});

// ---------- 设定集索引行 ----------

const entry = (comment: string, keys: string[] = [], enabled = true) => ({ comment, keys, enabled });

test("设定集索引：条目标题顿号相连，带总数", () => {
	const line = formatLoreIndex([entry("雾息猎犬"), entry("北境王都"), entry("血誓仪式")]);
	assert.equal(line, "共 3 条：雾息猎犬、北境王都、血誓仪式");
});

test("设定集索引：无 comment 回落首个关键词；两者皆空则跳过该条", () => {
	const line = formatLoreIndex([entry("", ["Gloomhound", "雾犬"]), entry("", [])]);
	assert.equal(line, "共 1 条：Gloomhound");
});

test("设定集索引：停用条目不进索引", () => {
	const line = formatLoreIndex([entry("在场", [], true), entry("已停用", [], false)]);
	assert.equal(line, "共 1 条：在场");
});

test("设定集索引：空清单返回 undefined（调用方不注入该块）", () => {
	assert.equal(formatLoreIndex([]), undefined);
	assert.equal(formatLoreIndex([entry("", [])]), undefined);
});

test("设定集索引：超预算按条目边界截断并标注剩余条数", () => {
	const many = Array.from({ length: 100 }, (_, i) => entry(`超长条目标题占位符第${String(i).padStart(3, "0")}号`));
	const line = formatLoreIndex(many);
	assert.ok(line);
	assert.match(line, /^共 100 条：/);
	assert.match(line, /另 \d+ 条未列出，同样可检索/);
	// 预算约束：正文部分不应无限膨胀（500 字符预算 + 定语开销）
	assert.ok(line.length < 620, `索引行过长：${line.length}`);
	// 截断发生在条目边界：不得出现被腰斩的标题（每个列出的标题必须完整）
	const listed = line.slice(line.indexOf("：") + 1).split("……")[0].split("、");
	for (const t of listed) assert.match(t, /号$/);
});
