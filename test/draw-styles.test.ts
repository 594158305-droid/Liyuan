/**
 * 生图领域层单测：全局风格预设（styles / defaultStyleId）规范化、默认回退、保存往返；
 * 以及 provider type 专属配置（sd-webui / comfyui）规范化。
 * 运行：node --test test/draw-styles.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	emptyDrawConfig,
	loadDrawConfig,
	normalizeDrawProvider,
	normalizeDrawStyle,
	saveDrawConfig,
} from "../src/draw/config.ts";

// ---------- 全局风格 ----------

test("styles: 规范化单条风格（name/prefix 缺省回默认）", () => {
	const s = normalizeDrawStyle({ id: "anime", positivePrefix: "masterpiece, best quality" });
	assert.ok(s);
	assert.equal(s!.id, "anime");
	assert.equal(s!.name, "anime"); // name 缺省 = id
	assert.equal(s!.positivePrefix, "masterpiece, best quality");
	assert.equal(s!.negativePrefix, ""); // negativePrefix 缺省 ""
});

test("styles: 非法风格丢弃", () => {
	assert.equal(normalizeDrawStyle(null), null);
	assert.equal(normalizeDrawStyle("x"), null);
	assert.equal(normalizeDrawStyle({ name: "无 id" }), null);
	assert.equal(normalizeDrawStyle({ id: "  " }), null);
});

test("styles: 读配置过滤非法风格 + defaultStyleId 回退到第一套", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-style-"));
	writeFileSync(
		join(dir, "liyuan.draw.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			styles: [
				{ id: "s1", name: "3D", positivePrefix: "n::3d::", negativePrefix: "bad 3d" },
				{ id: "", name: "非法" },
				"垃圾",
			],
			defaultStyleId: "不存在",
		}),
	);
	const cfg = loadDrawConfig(dir);
	assert.equal(cfg.styles.length, 1);
	assert.equal(cfg.styles[0]!.id, "s1");
	assert.equal(cfg.styles[0]!.name, "3D");
	// defaultStyleId 不在 styles 中 → 回退 styles[0].id
	assert.equal(cfg.defaultStyleId, "s1");
});

test("styles: 显式 defaultStyleId 命中保留；无 styles 回退空串", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-style-"));
	writeFileSync(
		join(dir, "liyuan.draw.json"),
		JSON.stringify({ version: 1, providers: [], styles: [{ id: "a" }, { id: "b" }], defaultStyleId: "b" }),
	);
	assert.equal(loadDrawConfig(dir).defaultStyleId, "b");

	writeFileSync(join(dir, "liyuan.draw.json"), JSON.stringify({ version: 1, providers: [], styles: [] }));
	assert.equal(loadDrawConfig(dir).defaultStyleId, "");
});

test("styles: 保存往返保留 styles + defaultStyleId", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-style-"));
	const cfg = emptyDrawConfig();
	cfg.styles.push(
		{ id: "s1", name: "3D", positivePrefix: "masterpiece", negativePrefix: "bad hands" },
		{ id: "s2", name: "插画", positivePrefix: "illustration", negativePrefix: "" },
	);
	cfg.defaultStyleId = "s2";
	saveDrawConfig(dir, cfg);
	const loaded = loadDrawConfig(dir);
	assert.equal(loaded.styles.length, 2);
	assert.equal(loaded.styles[0]!.positivePrefix, "masterpiece");
	assert.equal(loaded.defaultStyleId, "s2");
});

test("styles: emptyDrawConfig 含空 styles 与空 defaultStyleId", () => {
	const cfg = emptyDrawConfig();
	assert.deepEqual(cfg.styles, []);
	assert.equal(cfg.defaultStyleId, "");
});

// ---------- provider type 专属配置 ----------

test("provider: sd-webui 专属配置规范化（缺省回默认）", () => {
	const p = normalizeDrawProvider({ id: "sd", type: "sd-webui" });
	assert.ok(p);
	assert.equal(p!.type, "sd-webui");
	assert.deepEqual(p!.sd, { host: "http://127.0.0.1:7860", auth: "", transport: "st-proxy", model: "" });
	// novelai 类型忽略 sd 字段
	const n = normalizeDrawProvider({ id: "n", type: "novelai", sd: { host: "h" } });
	assert.equal(n!.sd, undefined);
});

test("provider: comfyui 专属配置规范化（缺省回默认 + nodeIds 过滤）", () => {
	const p = normalizeDrawProvider({
		id: "c",
		type: "comfyui",
		comfy: { connectionMode: "direct", url: "http://x:8188", nodeIds: { positive: "6", bad: 42 } },
	});
	assert.ok(p);
	assert.equal(p!.type, "comfyui");
	assert.equal(p!.comfy!.connectionMode, "direct");
	assert.equal(p!.comfy!.url, "http://x:8188");
	assert.deepEqual(p!.comfy!.nodeIds, { positive: "6" }); // 非字符串值丢弃

	const d = normalizeDrawProvider({ id: "c2", type: "comfyui" });
	assert.deepEqual(d!.comfy, {
		connectionMode: "proxy",
		url: "http://127.0.0.1:8188",
		auth: "",
		workflow: "",
		nodeIds: {},
	});
});
