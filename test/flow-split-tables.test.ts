import assert from "node:assert/strict";
import { test } from "node:test";

import {
	BUILTIN_SPLIT_TABLES,
	findSplitTable,
	loadBuiltinSplitTables,
	normalizeSplitTable,
	resolveSplitTables,
} from "../src/preset-split.ts";

/** 运行时表 ↔ 配置 JSON 形态：正则字段互转辅助（仅测试用） */
const toConfig = (t: (typeof BUILTIN_SPLIT_TABLES)[number]) => ({
	key: t.key,
	fingerprints: t.fingerprints,
	blocks: t.blocks.map((b) => ({
		name: b.name,
		nature: b.nature,
		fate: b.fate,
		...(b.section ? { section: b.section } : {}),
		...(b.topic ? { topic: b.topic } : {}),
		...(b.stripLines ? { stripLines: b.stripLines.map((r) => r.source) } : {}),
		...(b.segments
			? {
					segments: b.segments.map((s) => ({
						match: s.match.source,
						fate: s.fate,
						...(s.section ? { section: s.section } : {}),
						...(s.topic ? { topic: s.topic } : {}),
					})),
				}
			: {}),
		...(b.sovereigntyOverride ? { sovereigntyOverride: true } : {}),
		...(b.note !== undefined ? { note: b.note } : {}),
	})),
	vars: t.vars.map((v) => ({
		name: v.name,
		fate: v.fate,
		...(v.section ? { section: v.section } : {}),
		...(v.topic ? { topic: v.topic } : {}),
		...(v.stripLines ? { stripLines: v.stripLines.map((r) => r.source) } : {}),
	})),
	supplements: t.supplements,
});

test("数据文件与内嵌默认逐字一致（assets/flow/split-tables.json ↔ BUILTIN_SPLIT_TABLES）", () => {
	const fromFile = loadBuiltinSplitTables(process.cwd());
	assert.equal(fromFile.length, BUILTIN_SPLIT_TABLES.length, "5 张内置表齐");
	for (let i = 0; i < fromFile.length; i++) {
		const a = fromFile[i];
		const b = BUILTIN_SPLIT_TABLES[i];
		assert.equal(a.key, b.key, `表 ${i} key 一致（顺序：0=liyuan-custom,1=tgbreak,2=shuangren,3=xiajin,4=dreamwhale）`);
		assert.deepEqual(a.fingerprints, b.fingerprints, `${a.key} 指纹一致`);
		assert.deepEqual(a.blocks.map((x) => x.name), b.blocks.map((x) => x.name), `${a.key} 块名序列一致`);
		assert.deepEqual(a.vars.map((x) => x.name), b.vars.map((x) => x.name), `${a.key} 变量名序列一致`);
		assert.deepEqual(a.supplements, b.supplements, `${a.key} supplements 一致`);
		for (let j = 0; j < a.blocks.length; j++) {
			const x = a.blocks[j];
			const y = b.blocks[j];
			assert.equal(x.nature, y.nature, `${a.key}/${x.name} nature`);
			assert.equal(x.fate, y.fate, `${a.key}/${x.name} fate`);
			assert.equal(x.section, y.section, `${a.key}/${x.name} section`);
			assert.equal(x.topic, y.topic, `${a.key}/${x.name} topic`);
			assert.equal(x.sovereigntyOverride, y.sovereigntyOverride, `${a.key}/${x.name} sovereigntyOverride`);
			assert.deepEqual(
				(x.stripLines ?? []).map((r) => r.source),
				(y.stripLines ?? []).map((r) => r.source),
				`${a.key}/${x.name} stripLines 正则 source 一致`,
			);
			assert.deepEqual(
				(x.segments ?? []).map((s) => [s.match.source, s.fate, s.section, s.topic]),
				(y.segments ?? []).map((s) => [s.match.source, s.fate, s.section, s.topic]),
				`${a.key}/${x.name} segments 一致`,
			);
		}
	}
});

test("normalizeSplitTable：配置形态 ↔ 运行时形态 roundtrip（正则字符串 → RegExp 语义等价）", () => {
	for (const t of BUILTIN_SPLIT_TABLES) {
		const normalized = normalizeSplitTable(toConfig(t) as never);
		assert.ok(normalized, `${t.key} 可归一化`);
		assert.equal(normalized!.key, t.key);
		assert.deepEqual(normalized!.blocks.map((x) => x.name), t.blocks.map((x) => x.name));
		for (let j = 0; j < t.blocks.length; j++) {
			const x = normalized!.blocks[j];
			const y = t.blocks[j];
			assert.deepEqual(
				(x.stripLines ?? []).map((r) => r.source),
				(y.stripLines ?? []).map((r) => r.source),
				`${t.key}/${x.name} stripLines roundtrip`,
			);
			assert.deepEqual(
				(x.segments ?? []).map((s) => s.match.source),
				(y.segments ?? []).map((s) => s.match.source),
				`${t.key}/${x.name} segments.match roundtrip`,
			);
		}
	}
});

test("normalizeSplitTable：非法正则跳过对应规则并计入警告；结构非法返回 null", () => {
	const warnings: string[] = [];
	const t = normalizeSplitTable(
		{
			key: "custom",
			blocks: [
				{ name: "好块", nature: "B", fate: "resident", section: "B" },
				{ name: "坏正则", nature: "F", fate: "rules-only", stripLines: ["([unclosed"] },
				{ name: "坏段", nature: "C", fate: "resident", section: "C", segments: [{ match: "[unclosed", fate: "drop" }] },
			],
		} as never,
		warnings,
	);
	assert.ok(t);
	assert.equal(warnings.length, 2, "两条非法正则计入警告");
	assert.equal(t!.blocks.length, 3, "块仍在");
	assert.equal(t!.blocks[1].stripLines, undefined, "坏 stripLines 整条跳过（宁漏勿伤）");
	assert.equal(t!.blocks[2].segments, undefined, "坏 segment 跳过");
	assert.equal(normalizeSplitTable(null as never), null);
	assert.equal(normalizeSplitTable({ key: "" } as never), null, "空 key 非法");
});

test("resolveSplitTables：同 key 增改合并、新 key 追加、非法表忽略", () => {
	const overrides = [
		{ key: "tgbreak-v2", blocks: [{ name: "改过的块", nature: "A", fate: "resident", section: "A" }] },
		{ key: "my-custom-table", fingerprints: ["我的预设块A", "我的预设块B"], blocks: [] },
		{ key: "broken", blocks: "不是数组" as never },
	];
	const out = resolveSplitTables(BUILTIN_SPLIT_TABLES, overrides as never);
	assert.equal(out.length, BUILTIN_SPLIT_TABLES.length + 1, "5 内置 + 1 新表");
	const tg = out.find((t) => t.key === "tgbreak-v2")!;
	assert.equal(tg.blocks.length, BUILTIN_SPLIT_TABLES[1].blocks.length + 1, "增改不删：内置 41 块全保留 + 1 新块");
	assert.ok(tg.blocks.some((b) => b.name === "改过的块"), "新块追加");
	assert.deepEqual(tg.fingerprints, BUILTIN_SPLIT_TABLES[1].fingerprints, "覆盖未提供指纹 → 继承内置（认表不破）");
	assert.equal(out.find((t) => t.key === "my-custom-table")?.fingerprints.length, 2, "新表追加");
	assert.ok(!out.some((t) => t.key === "broken"), "结构非法表忽略");
	// 合并后的表参与认表
	assert.equal(findSplitTable(["我的预设块A", "我的预设块B"], out)?.key, "my-custom-table");
	assert.equal(findSplitTable(["😀话痨抢话", "👻TG推荐文风"], out)?.key, "tgbreak-v2", "内置表覆盖后仍可认");
});

test("loadBuiltinSplitTables：文件缺失回退内嵌默认", () => {
	const fromFile = loadBuiltinSplitTables(process.cwd());
	assert.ok(fromFile.length > 0);
	// 不存在的目录 → 回退常量（不抛）
	const fallback = loadBuiltinSplitTables("Z:/definitely-not-a-dir");
	assert.equal(fallback, BUILTIN_SPLIT_TABLES, "缺失回退内嵌默认");
});
