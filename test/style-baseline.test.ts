import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	DEFAULT_STYLE_BASELINE,
	loadStyleBaselineFile,
	normalizeStyleBaselineCard,
	normalizeStyleBaselineFile,
	renderStyleBaseline,
	resolveStyleBaseline,
} from "../src/style-baseline.ts";

test("数据文件与内嵌默认逐字一致（assets/flow/style-baseline.json ↔ DEFAULT_STYLE_BASELINE）", () => {
	const fromFile = loadStyleBaselineFile(process.cwd());
	assert.ok(fromFile, "style-baseline.json 应可加载（仓库根有 assets/flow/）");
	assert.deepEqual(fromFile, DEFAULT_STYLE_BASELINE);
});

test("normalizeStyleBaselineCard：四要素齐全才合法", () => {
	const ok = normalizeStyleBaselineCard({
		voice: "v",
		reference: "r",
		positive: "p",
		negatives: { shot: "s", prose: "p2", ledger: "l" },
		check: "c",
	});
	assert.ok(ok);
	assert.equal(ok!.negatives.prose, "p2");

	assert.equal(normalizeStyleBaselineCard(null), null);
	assert.equal(normalizeStyleBaselineCard({ voice: "v" }), null);
	assert.equal(
		normalizeStyleBaselineCard({
			voice: "v",
			reference: "r",
			positive: "p",
			negatives: { shot: "s", prose: "", ledger: "l" },
			check: "c",
		}),
		null,
		"反例缺一段不合法",
	);
});

test("normalizeStyleBaselineFile：default 非法整体弃用；presets 只收合法卡", () => {
	assert.equal(normalizeStyleBaselineFile(null), null);
	assert.equal(normalizeStyleBaselineFile({}), null);
	const out = normalizeStyleBaselineFile({
		default: { voice: "v", reference: "r", positive: "p", negatives: { shot: "s", prose: "p", ledger: "l" }, check: "c" },
		presets: { ok: { voice: "v", reference: "r", positive: "p", negatives: { shot: "s", prose: "p", ledger: "l" }, check: "c" }, bad: { voice: "v" } },
	});
	assert.ok(out);
	assert.equal(out!.presets!.ok.voice, "v");
	assert.equal(out!.presets!.bad, undefined, "非法预设卡被忽略");
});

test("resolveStyleBaseline：覆盖 default / presets；未知 key 回落默认卡", () => {
	const base = DEFAULT_STYLE_BASELINE;
	const override = {
		default: { ...base.default, voice: "覆盖后的默认声音" },
		presets: {
			"liyuan-custom": { ...base.presets!["liyuan-custom"], check: "覆盖后的自检问题" },
			"new-preset": { ...base.default, voice: "新预设声音" },
		},
	};
	assert.equal(resolveStyleBaseline(base, undefined, null).voice, base.default.voice);
	assert.equal(resolveStyleBaseline(base, override, null).voice, "覆盖后的默认声音");
	assert.equal(resolveStyleBaseline(base, override, "liyuan-custom").check, "覆盖后的自检问题");
	assert.equal(resolveStyleBaseline(base, override, "new-preset").voice, "新预设声音");
	assert.equal(resolveStyleBaseline(base, override, "no-such-key").voice, "覆盖后的默认声音");
});

test("renderStyleBaseline：四要素齐全且包含三个反例原型", () => {
	const text = renderStyleBaseline(DEFAULT_STYLE_BASELINE.default);
	assert.ok(text.includes("【声音】"));
	assert.ok(text.includes("【参考系】"));
	assert.ok(text.includes("【正例】"));
	assert.ok(text.includes("【反例·分镜腔】"));
	assert.ok(text.includes("【反例·散文腔】"));
	assert.ok(text.includes("【反例·流水账腔】"));
	assert.ok(text.includes("【自检】"));
});

test("harness 去文风化：流程提示词文件不含强文风引导词", () => {
	const files = [
		"src/stage/assemble.ts",
		"src/flow-templates.ts",
		"src/stage/engine.ts",
		"assets/flow/round-cards.json",
	];
	const banned = ["资深作家", "职业作家", "肆意", "倾尽", "写得精彩", "镜头", "点睛", "文笔"];
	for (const f of files) {
		const text = readFileSync(f, "utf8");
		for (const w of banned) {
			assert.ok(!text.includes(w), `${f} 不应再出现「${w}」——harness 只讲机制，不藏文风`);
		}
	}
});
