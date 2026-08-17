import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import {
	DEFAULT_RESOLVED,
	loadRouterFile,
	normalizeRouterFile,
	resolveRouterConfig,
	type ResolvedRouter,
} from "../src/router-config.ts";
import { DEFAULT_CARDS, DEFAULT_LEXICON, DEFAULT_PERSONAS } from "../src/router-core.ts";

/**
 * 梨园化 router 配置装载（docs/DESIGN-router.md §4）：代码内嵌默认 → assets/flow/router.json
 * 文件覆盖 → liyuan.config.json router 段覆盖。非法条目跳过、缺省回退内置。
 */

const CWD = join(import.meta.dirname, "..");

// ---------------- normalizeRouterFile ----------------

test("normalizeRouterFile：合法数据归一化（cards 为数组形态）", () => {
	const raw = {
		personas: { pro: "自定义 pro", flash: "自定义 flash" },
		cards: [
			{ key: "router-build", title: "【构造拍·改】", body: "直接演" },
			{ key: "router-deep", title: "【深度拍·改】", body: "深想后收敛" },
		],
		classify: { build: ["喵"], fix: ["汪"], complex: ["嗷"] },
	};
	const f = normalizeRouterFile(raw);
	assert.ok(f);
	assert.equal(f?.personas?.pro, "自定义 pro");
	assert.equal(f?.cards?.build?.key, "router-build");
	assert.equal(f?.cards?.build?.title, "【构造拍·改】");
	assert.equal(f?.cards?.deep?.title, "【深度拍·改】");
	assert.deepEqual(f?.classify?.build, ["喵"]);
});

test("normalizeRouterFile：结构非法 → null（回退内置）；缺失字段跳过", () => {
	assert.equal(normalizeRouterFile(null), null);
	assert.equal(normalizeRouterFile("x"), null);
	assert.equal(normalizeRouterFile({}), null);
	const partial = normalizeRouterFile({ personas: { pro: 123 } });
	assert.equal(partial, null); // personas 有键但类型错 → 该段不产出 → 全空 → null
	const onlyCards = normalizeRouterFile({ cards: [{ key: "router-fix", title: "T", body: "B" }] });
	assert.equal(onlyCards?.cards?.fix?.title, "T");
	assert.equal(onlyCards?.personas, undefined);
	// 数组里 key 不在 build/fix/deep → 忽略
	const unknownKey = normalizeRouterFile({ cards: [{ key: "router-other", title: "T", body: "B" }] });
	assert.equal(unknownKey, null);
});

test("loadRouterFile：读仓库 assets/flow/router.json 成功，且与内置默认同构（key 集合一致）", () => {
	const f = loadRouterFile(CWD);
	assert.ok(f, "assets/flow/router.json 应可加载");
	assert.deepEqual(Object.keys(f?.personas ?? {}).sort(), Object.keys(DEFAULT_PERSONAS).sort());
	assert.deepEqual(
		(f?.cards ? Object.keys(f.cards).sort() : []),
		Object.keys(DEFAULT_CARDS).sort(),
	);
	for (const key of Object.keys(DEFAULT_LEXICON)) {
		const arr = f?.classify?.[key as "build" | "fix" | "complex"];
		assert.ok(Array.isArray(arr) && arr.length > 0, `classify.${key} 应非空`);
	}
});

// ---------------- resolveRouterConfig（默认值） ----------------

test("resolveRouterConfig：无配置无文件 → 用户拍板默认（enabled=true, perTurn, 全开）", () => {
	const r = resolveRouterConfig(undefined, null);
	assert.equal(r.enabled, true);
	assert.equal(r.personaMode, "perTurn");
	assert.equal(r.toolStaging, true);
	assert.equal(r.modeCards, true);
	assert.equal(r.convergeTail, true);
	assert.equal(r.agentsEnabled, false);
	assert.deepEqual(r.personas, DEFAULT_PERSONAS);
	assert.deepEqual(r.cards, DEFAULT_CARDS);
	assert.deepEqual(r.lexicon, DEFAULT_LEXICON);
	assert.deepEqual(r.modelOverrides, {});
});

test("resolveRouterConfig：配置段覆盖（总开关 / 形态 / 旁路 / 助手）", () => {
	const r = resolveRouterConfig(
		{
			enabled: false,
			stage: { personaMode: "off", toolStaging: false, modeCards: false },
			side: { convergeTail: false },
			agents: { enabled: true },
		},
		null,
	);
	assert.equal(r.enabled, false);
	assert.equal(r.personaMode, "off");
	assert.equal(r.toolStaging, false);
	assert.equal(r.modeCards, false);
	assert.equal(r.convergeTail, false);
	assert.equal(r.agentsEnabled, true);
});

test("resolveRouterConfig：文件覆盖段、配置覆盖文件（更高优先级）", () => {
	const file = normalizeRouterFile({
		personas: { pro: "文件 pro" },
		cards: [{ key: "router-build", title: "【构造拍·文件】", body: "B" }],
		classify: { build: ["文件词"] },
	})!;
	const r = resolveRouterConfig(undefined, file);
	assert.equal(r.personas.pro, "文件 pro");
	assert.equal(r.cards.build.title, "【构造拍·文件】");
	assert.deepEqual(r.lexicon.build, ["文件词"]);

	// 配置段优先于文件
	const r2 = resolveRouterConfig(
		{ classify: { build: ["配置词"] }, models: { "deepseek-v4-pro": { persona: "配置 pro" } } },
		file,
	);
	assert.deepEqual(r2.lexicon.build, ["配置词"]);
	assert.equal(r2.modelOverrides["deepseek-v4-pro"]?.persona, "配置 pro");
	// 未覆盖的仍继承文件
	assert.equal(r2.personas.pro, "文件 pro");
});

test("resolveRouterConfig：models 覆盖只接受合法 band", () => {
	const r = resolveRouterConfig(
		{
			models: {
				"deepseek-v4-pro": { band: "spec", persona: "P" },
				"bad-model": { band: "transition" as never }, // 非法 band 丢弃
			},
		},
		null,
	);
	assert.deepEqual(r.modelOverrides["deepseek-v4-pro"], { band: "spec", persona: "P" });
	assert.equal(r.modelOverrides["bad-model"], undefined);
});

test("DEFAULT_RESOLVED：引用语义（resolved 不复用同一数组实例）", () => {
	const r = resolveRouterConfig(undefined, null) as ResolvedRouter;
	r.lexicon.build.push("污染");
	assert.ok(!DEFAULT_RESOLVED.lexicon.build.includes("污染"));
	assert.ok(!DEFAULT_LEXICON.build.includes("污染"));
});
