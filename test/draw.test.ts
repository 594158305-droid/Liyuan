/**
 * 生图系统领域层单测：draw-config / novelai / wardrobe / ziplite 内存解图。
 * 运行：node --test test/draw.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	emptyDrawConfig,
	loadDrawConfig,
	saveDrawConfig,
	normalizeDrawProvider,
	effectiveParams,
	activeProvider,
	DEFAULT_DRAW_PARAMS,
} from "../src/draw-config.ts";
import {
	buildGenerateBody,
	buildEnhanceBody,
	gridToCenter,
	resolveAspectSize,
	parseApiError,
	classifyError,
	DrawError,
	extractImageFromZip,
	sendDrawRequest,
	testNovelAiConnection,
} from "../src/novelai.ts";
import {
	loadWardrobe,
	saveWardrobe,
	upsertCharacter,
	addOutfit,
	removeOutfit,
	resolveOutfit,
	wardrobeKey,
} from "../src/wardrobe.ts";
import { readZipEntryBytes } from "../src/ziplite.ts";

// ---------- draw-config ----------

test("draw-config: 规范化 provider 缺失字段回默认", () => {
	const p = normalizeDrawProvider({ id: "x1", name: "测试", apiKey: "k" });
	assert.ok(p);
	assert.equal(p!.type, "novelai");
	assert.equal(p!.model, "nai-diffusion-4-5-full");
	assert.deepEqual(p!.defaultParams.sampler, DEFAULT_DRAW_PARAMS.sampler);
	assert.equal(p!.enabled, true);
	assert.equal(p!.autoConfirm, false);
});

test("draw-config: 非法 provider 丢弃", () => {
	assert.equal(normalizeDrawProvider(null), null);
	assert.equal(normalizeDrawProvider("x"), null);
	assert.equal(normalizeDrawProvider({ name: "无 id" }), null);
});

test("draw-config: 读写出入一致", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-draw-"));
	const cfg = emptyDrawConfig();
	cfg.providers.push(
		normalizeDrawProvider({ id: "a", name: "A", apiKey: "k1", defaultParams: { steps: 30 } })!,
	);
	cfg.defaultProvider = "a";
	saveDrawConfig(dir, cfg);
	const loaded = loadDrawConfig(dir);
	assert.equal(loaded.providers.length, 1);
	assert.equal(loaded.providers[0]!.defaultParams.steps, 30);
	assert.equal(loaded.defaultProvider, "a");
	assert.equal(activeProvider(loaded)!.id, "a");
});

test("draw-config: 坏文件安静降级", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-draw-"));
	writeFileSync(join(dir, "liyuan.draw.json"), "{ not json", "utf8");
	const cfg = loadDrawConfig(dir);
	assert.equal(cfg.providers.length, 0);
});

test("draw-config: preset 部分覆盖 defaultParams", () => {
	const p = normalizeDrawProvider({
		id: "a",
		name: "A",
		presets: [{ id: "p1", name: "3D", model: "nai-diffusion-4-5-full", params: { steps: 20, scale: 7 } }],
	})!;
	const eff = effectiveParams(p, "p1");
	assert.equal(eff.steps, 20);
	assert.equal(eff.scale, 7);
	assert.equal(eff.sampler, DEFAULT_DRAW_PARAMS.sampler); // 未覆盖字段保留默认
	assert.equal(effectiveParams(p, "nope").steps, DEFAULT_DRAW_PARAMS.steps); // 未知 preset 回默认
});

// ---------- novelai ----------

test("novelai: V4.5 generate 请求体结构", () => {
	const body = buildGenerateBody({
		scene: "nsfw, solo, girl in center, outdoors, night",
		characterPrompts: [
			{ prompt: "long silver hair, blue eyes, cheongsam", uc: "bra", center: { x: 0.5, y: 0.5 } },
		],
		negativePrompt: "lowres, bad anatomy",
		params: { ...DEFAULT_DRAW_PARAMS },
		seed: 12345,
	});
	assert.equal(body.action, "generate");
	assert.equal(body.model, "nai-diffusion-4-5-full");
	const p = body.parameters as Record<string, any>;
	assert.equal(p.params_version, 3);
	assert.equal(p.seed, 12345);
	assert.equal(p.n_samples, 1);
	assert.equal(p.image_format, "png");
	assert.equal(p.use_coords, false);
	assert.equal(p.characterPrompts.length, 1);
	assert.equal(p.v4_prompt.caption.base_caption, "nsfw, solo, girl in center, outdoors, night");
	assert.equal(p.v4_prompt.caption.char_captions[0].char_caption, "long silver hair, blue eyes, cheongsam");
	assert.equal(p.v4_negative_prompt.caption.base_caption, "lowres, bad anatomy");
	assert.equal(p.negative_prompt, "lowres, bad anatomy");
});

test("novelai: 非中心坐标触发 use_coords", () => {
	const body = buildGenerateBody({
		scene: "solo",
		characterPrompts: [{ prompt: "a", uc: "", center: { x: 0.3, y: 0.7 } }],
		negativePrompt: "",
		params: { ...DEFAULT_DRAW_PARAMS },
		seed: 1,
	});
	const p = body.parameters as Record<string, any>;
	assert.equal(p.use_coords, true);
	assert.equal(p.v4_prompt.use_coords, true);
});

test("novelai: V3 模型走旧结构（提示词合并）", () => {
	const body = buildGenerateBody({
		scene: "solo, forest",
		characterPrompts: [{ prompt: "elf ears, green eyes", uc: "hat", center: { x: 0.5, y: 0.5 } }],
		negativePrompt: "lowres",
		params: { ...DEFAULT_DRAW_PARAMS },
		model: "nai-diffusion-3",
		seed: 7,
	});
	assert.equal(body.model, "nai-diffusion-3");
	const p = body.parameters as Record<string, any>;
	assert.equal(body.input, "solo, forest, elf ears, green eyes");
	assert.equal(p.negative_prompt, "lowres, hat");
	assert.equal(p.params_version, undefined);
});

test("novelai: img2img 增强请求体（image/strength/noise/scaleBy）", () => {
	const body = buildEnhanceBody({
		scene: "solo, same scene",
		characterPrompts: [{ prompt: "long hair", uc: "", center: { x: 0.5, y: 0.5 } }],
		negativePrompt: "lowres",
		params: { ...DEFAULT_DRAW_PARAMS },
		imageBase64: "QUJD",
		strength: 0.1,
		noise: 0,
		scaleBy: 1.5,
		seed: 3,
	});
	assert.equal(body.action, "img2img");
	const p = body.parameters as Record<string, any>;
	assert.equal(p.image, "QUJD");
	assert.equal(p.strength, 0.1);
	assert.equal(p.noise, 0);
	assert.equal(p.scaleBy, 1.5);
	assert.equal(p.params_version, 3);
});

test("novelai: 参考图去 data: 前缀", () => {
	const body = buildGenerateBody({
		scene: "solo",
		characterPrompts: [
			{ prompt: "a", uc: "", center: { x: 0.5, y: 0.5 }, referenceImage: "data:image/png;base64,REF" },
		],
		negativePrompt: "",
		params: { ...DEFAULT_DRAW_PARAMS },
		seed: 2,
	});
	const p = body.parameters as Record<string, any>;
	assert.equal(p.characterPrompts[0].reference_image, "REF");
	assert.equal(p.characterPrompts[0].reference_image_strength, 0.8);
	assert.equal(p.characterPrompts[0].reference_image_type, "character");
});

test("novelai: 5×5 网格坐标 → 归一化中心", () => {
	assert.deepEqual(gridToCenter("C3"), { x: 0.5, y: 0.5 });
	assert.deepEqual(gridToCenter("A1"), { x: 0.1, y: 0.1 });
	assert.deepEqual(gridToCenter("E5"), { x: 0.9, y: 0.9 });
	assert.deepEqual(gridToCenter("B2"), { x: 0.3, y: 0.3 });
	assert.deepEqual(gridToCenter("啥"), { x: 0.5, y: 0.5 });
});

test("novelai: aspect 分辨率映射", () => {
	assert.deepEqual(resolveAspectSize("portrait", { ...DEFAULT_DRAW_PARAMS }), {
		...DEFAULT_DRAW_PARAMS,
		width: 832,
		height: 1216,
	});
	assert.deepEqual(resolveAspectSize("landscape", { ...DEFAULT_DRAW_PARAMS }), {
		...DEFAULT_DRAW_PARAMS,
		width: 1216,
		height: 832,
	});
	assert.deepEqual(resolveAspectSize("square", { ...DEFAULT_DRAW_PARAMS }), {
		...DEFAULT_DRAW_PARAMS,
		width: 1024,
		height: 1024,
	});
	assert.equal(resolveAspectSize(undefined, { ...DEFAULT_DRAW_PARAMS }).width, DEFAULT_DRAW_PARAMS.width);
});

test("novelai: 错误分类", () => {
	assert.equal(parseApiError(401, "").code, "auth");
	assert.equal(parseApiError(402, "").code, "quota");
	assert.equal(parseApiError(429, "").code, "busy");
	assert.equal(parseApiError(503, "").code, "network");
	assert.equal(classifyError(new Error("timeout")).code, "timeout");
	assert.equal(classifyError(new DrawError("auth", "x")).code, "auth");
	assert.equal(classifyError("乱七八糟").code, "unknown");
});

test("novelai: zip 响应解出图片（store 方法最小 zip）", () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
	const zip = makeStoreZip([{ name: "image_0.png", data: png }]);
	const img = readZipEntryBytes(zip, (n) => n.endsWith(".png"));
	assert.ok(img);
	assert.deepEqual(img!, png);
	assert.deepEqual(extractImageFromZip(zip), png);
});

test("novelai: sendDrawRequest 走注入 fetch（zip 响应）", async () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
	const zip = makeStoreZip([{ name: "image_0.png", data: png }]);
	const calls: any[] = [];
	const fakeFetch = async (url: string, init: any) => {
		calls.push({ url, init });
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
		} as any;
	};
	const r = await sendDrawRequest({
		apiKey: "k",
		baseUrl: "https://image.novelai.net",
		body: { action: "generate" },
		fetchImpl: fakeFetch as any,
	});
	assert.deepEqual(r.buffer, png);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://image.novelai.net/ai/generate-image");
	assert.equal(calls[0].init.headers.Authorization, "Bearer k");
});

test("novelai: sendDrawRequest 错误映射（401/429）", async () => {
	for (const [status, code] of [[401, "auth"], [429, "busy"], [402, "quota"]] as const) {
		const fakeFetch = async () => ({ ok: false, status, text: async () => "err" }) as any;
		await assert.rejects(
			sendDrawRequest({ apiKey: "k", baseUrl: "https://x", body: {}, fetchImpl: fakeFetch as any }),
			(e: any) => e instanceof DrawError && e.code === code,
		);
	}
});

test("novelai: 无 key 直接报认证错误", async () => {
	await assert.rejects(
		sendDrawRequest({ apiKey: "", baseUrl: "https://x", body: {} }),
		(e: any) => e instanceof DrawError && e.code === "auth",
	);
});

test("novelai: testNovelAiConnection 最小请求", async () => {
	let body: any = null;
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
	const zip = makeStoreZip([{ name: "image_0.png", data: png }]);
	const fakeFetch = async (_u: string, init: any) => {
		body = JSON.parse(init.body);
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
		} as any;
	};
	await testNovelAiConnection({ apiKey: "k", fetchImpl: fakeFetch as any });
	assert.equal(body.action, "generate");
	assert.equal(body.parameters.width, 64);
	assert.equal(body.parameters.steps, 1);
});

// ---------- wardrobe ----------

test("wardrobe: CRUD 往返", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-wb-"));
	const card = "assets/cards/青梧.png";
	let wb = loadWardrobe(dir, card);
	assert.equal(wb.characters.length, 0);
	wb = upsertCharacter(wb, "青梧");
	wb = setAppearanceTagsPublic(wb, "青梧", "long silver hair");
	wb = addOutfit(wb, "青梧", { id: "o1", name: "青色长裙", tags: "cheongsam, green dress" });
	wb = addOutfit(wb, "青梧", { id: "o2", name: "便服", tags: "casual, t-shirt" });
	saveWardrobe(dir, wb);

	const loaded = loadWardrobe(dir, card);
	assert.equal(loaded.characters.length, 1);
	assert.equal(loaded.characters[0]!.outfits.length, 2);
	// defaultOutfit 已废弃（2026-08-16 检修）：落盘不再读/写该字段
	assert.equal((loaded.characters[0] as Record<string, unknown>).defaultOutfit, undefined);

	// 当前穿着指定 → 命中；否则回退第一套（defaultOutfit 不再参与）
	const r1 = resolveOutfit(loaded, "青梧", "o2");
	assert.equal(r1.outfit!.id, "o2");
	const r2 = resolveOutfit(loaded, "青梧", undefined);
	assert.equal(r2.outfit!.id, "o1");
	// 未知角色
	assert.equal(resolveOutfit(loaded, "路人", undefined).outfit, null);

	// 删除某套服装后仍回退剩余第一套
	wb = removeOutfit(loaded, "青梧", "o1");
	assert.equal(wb.characters[0]!.outfits.length, 1);
	assert.equal(wb.characters[0]!.outfits[0]!.id, "o2");
});

test("wardrobe: 卡路径哈希稳定且无非法字符", () => {
	assert.equal(wardrobeKey("assets/cards/a.png"), wardrobeKey("assets/cards/a.png"));
	assert.match(wardrobeKey("中文/卡!.png"), /^[0-9a-f]{12}$/);
});

// ---------- helpers ----------

function setAppearanceTagsPublic(wb: any, name: string, tags: string) {
	// 直接操作（避免 import 太多）
	return {
		...wb,
		characters: wb.characters.map((c: any) => (c.name === name ? { ...c, appearanceTags: tags } : c)),
	};
}

/** 构造 store（无压缩）zip：entries: { name, data }[] */
function makeStoreZip(entries: { name: string; data: Buffer }[]): Buffer {
	const locs: Buffer[] = [];
	const cens: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, "utf8");
		const loc = Buffer.alloc(30);
		loc.writeUInt32LE(0x04034b50, 0);
		loc.writeUInt16LE(20, 4);
		loc.writeUInt16LE(0, 8); // store
		loc.writeUInt16LE(name.length, 26);
		locs.push(loc, name, e.data);
		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0, 10); // store
		cen.writeUInt32LE(0, 16); // crc 忽略
		cen.writeUInt32LE(e.data.length, 20);
		cen.writeUInt32LE(e.data.length, 24);
		cen.writeUInt16LE(name.length, 28);
		cen.writeUInt32LE(offset, 42);
		cens.push(cen, name);
		offset += 30 + name.length + e.data.length;
	}
	const cenSize = cens.reduce((n, b) => n + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cenSize, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locs, ...cens, eocd]);
}

// 防止 readFileSync 未使用告警（zip 测试用真实文件路径的场景保留）
void readFileSync;
