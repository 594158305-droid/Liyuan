/**
 * 生图服务编排单测：generateImage 落盘 + src/slotId 格式 + 风格/aspect/参数覆盖；
 * enhance 的 op → strength/scaleBy/mask 映射；错误分支。
 *
 * 注意：src/draw/service.ts 内置全局单例队列（默认冷却 15-30s），为避开冷却等待，
 * 每个用例用不同 query 的动态 import 拉取独立模块实例（独立队列）。
 * 运行：node --test test/draw-service.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyDrawConfig, normalizeDrawProvider, saveDrawConfig } from "../src/draw/config.ts";
import { DrawError } from "../src/draw/errors.ts";

// ---------- helpers ----------

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

/** 构造返回 zip 的假 fetch，并捕获请求体 */
function fakeFetchZip(png: Buffer, captured: { body?: any }) {
	const zip = makeStoreZip([{ name: "image_0.png", data: png }]);
	return async (_url: string, init: any) => {
		captured.body = JSON.parse(init.body);
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
		} as any;
	};
}

/** 写最小 novelai 配置（可追加 styles） */
function setupConfig(cwd: string, extra?: (cfg: ReturnType<typeof emptyDrawConfig>) => void): void {
	const cfg = emptyDrawConfig();
	cfg.providers.push(normalizeDrawProvider({ id: "n1", name: "N", apiKey: "k", model: "nai-diffusion-4-5-full" })!);
	cfg.defaultProvider = "n1";
	if (extra) extra(cfg);
	saveDrawConfig(cwd, cfg);
}

const PNGBYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

// ---------- generateImage ----------

test("service: generateImage 落盘 + src/slotId 格式 + 风格/aspect/参数覆盖", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
	setupConfig(dir, (cfg) => {
		cfg.styles.push({ id: "3d", name: "3D", positivePrefix: "masterpiece, best quality", negativePrefix: "bad hands" });
		cfg.defaultStyleId = "3d";
	});
	const captured: { body?: any } = {};
	const fetchImpl = fakeFetchZip(PNGBYTES, captured);

	const { generateImage } = await import("../src/draw/service.ts?gen1");
	const r = await generateImage(dir, {
		prompt: "solo, girl",
		negativePrompt: "lowres",
		aspect: "portrait",
		params: { steps: 20, seed: -1 },
		fetchImpl: fetchImpl as any,
	});

	// src / slotId / providerId 格式
	assert.match(r.src, /^\/cache\/draw-\d+-[0-9a-f]{6}\.png$/);
	assert.match(r.slotId, /^slot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	assert.equal(r.providerId, "n1");
	// 生效参数快照：steps 覆盖 + portrait 尺寸
	assert.equal(r.params.steps, 20);
	assert.equal(r.params.width, 832);
	assert.equal(r.params.height, 1216);
	// 落盘（.liyuan-cache 目录）
	const file = r.src.slice("/cache/".length);
	assert.ok(existsSync(join(dir, ".liyuan-cache", file)));
	assert.deepEqual(readFileSync(join(dir, ".liyuan-cache", file)), PNGBYTES);
	// 请求体：风格前缀合并 + negative 合并 + seed -1 → 随机
	assert.ok(captured.body);
	assert.equal(captured.body.action, "generate");
	const p = captured.body.parameters;
	assert.equal(p.v4_prompt.caption.base_caption, "masterpiece, best quality, solo, girl");
	assert.equal(p.negative_prompt, "bad hands, lowres");
	assert.ok(p.seed >= 0 && p.seed <= 0xffffffff);
	// 缺省不传 characterPrompts → 空分栏（保持原行为）
	assert.deepEqual(p.characterPrompts, []);
	assert.deepEqual(p.v4_prompt.caption.char_captions, []);
});

test("service: generateImage 带 characterPrompts → V4.5 请求体含角色分栏（char_captions + 参考图）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
	setupConfig(dir);
	const captured: { body?: any } = {};
	const fetchImpl = fakeFetchZip(PNGBYTES, captured);

	const { generateImage } = await import("../src/draw/service.ts?gen-char");
	const r = await generateImage(dir, {
		prompt: "solo, girl",
		characterPrompts: [
			{ prompt: "blonde hair, blue eyes", uc: "barefoot", center: { x: 0.5, y: 0.5 } },
			{ prompt: "red dress", center: { x: 0.5, y: 0.5 } },
		],
		fetchImpl: fetchImpl as any,
	});
	assert.match(r.src, /^\/cache\/draw-\d+-[0-9a-f]{6}\.png$/);
	assert.equal(r.providerId, "n1");
	const p = captured.body.parameters;
	// 角色分栏进 V4.5 请求：characterPrompts 数组 + v4_prompt 的 char_captions
	assert.equal(p.characterPrompts.length, 2);
	assert.equal(p.characterPrompts[0].prompt, "blonde hair, blue eyes");
	assert.equal(p.characterPrompts[0].uc, "barefoot");
	assert.equal(p.characterPrompts[0].center.x, 0.5);
	assert.equal(p.characterPrompts[1].prompt, "red dress");
	// 正负 caption：base_caption 仍是 scene，char_captions 按角色分栏
	assert.equal(p.v4_prompt.caption.base_caption, "solo, girl");
	assert.equal(p.v4_prompt.caption.char_captions[0].char_caption, "blonde hair, blue eyes");
	assert.equal(p.v4_prompt.caption.char_captions[1].char_caption, "red dress");
	assert.equal(p.v4_negative_prompt.caption.char_captions[0].char_caption, "barefoot");
});

test("service: generateImage 带 characterPrompts → V3 模型角色 tag 合并进 input + 负面合并", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
	setupConfig(dir, (cfg) => {
		cfg.providers[0].model = "nai-diffusion-3-5";
	});
	const captured: { body?: any } = {};
	const fetchImpl = fakeFetchZip(PNGBYTES, captured);

	const { generateImage } = await import("../src/draw/service.ts?gen-char-v3");
	await generateImage(dir, {
		prompt: "solo, girl",
		negativePrompt: "lowres",
		characterPrompts: [
			{ prompt: "blonde hair, blue eyes", uc: "barefoot", center: { x: 0.5, y: 0.5 } },
			{ prompt: "red dress", center: { x: 0.5, y: 0.5 } },
		],
		fetchImpl: fetchImpl as any,
	});
	assert.equal(captured.body.input, "solo, girl, blonde hair, blue eyes, red dress");
	assert.equal(captured.body.parameters.negative_prompt, "lowres, barefoot");
});

test("service: generateImage 无 provider 抛 DrawError(unknown)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
	const { generateImage } = await import("../src/draw/service.ts?no-provider");
	await assert.rejects(
		generateImage(dir, { prompt: "x" }),
		(e: any) => e instanceof DrawError && e.code === "unknown",
	);
});

test("service: generateImage 非 novelai provider 抛预留错误", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
	const cfg = emptyDrawConfig();
	cfg.providers.push(normalizeDrawProvider({ id: "sd1", type: "sd-webui" })!);
	cfg.defaultProvider = "sd1";
	saveDrawConfig(dir, cfg);
	const { generateImage } = await import("../src/draw/service.ts?no-sd");
	await assert.rejects(
		generateImage(dir, { prompt: "x" }),
		(e: any) => e instanceof DrawError && e.code === "unknown" && e.message.includes("预留"),
	);
});

test("service: 外部 signal 已中止 → 直接拒绝", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
	setupConfig(dir);
	const { generateImage } = await import("../src/draw/service.ts?abort");
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(
		generateImage(dir, { prompt: "x", signal: ac.signal, fetchImpl: fakeFetchZip(PNGBYTES, {}) as any }),
		(e: any) => e instanceof DrawError && e.code === "timeout",
	);
});

// ---------- enhanceImage ----------

test("service: enhanceImage 源图解析（/cache/ 前缀 → .liyuan-cache）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
	mkdirSync(join(dir, ".liyuan-cache"), { recursive: true });
	writeFileSync(join(dir, ".liyuan-cache", "src.png"), Buffer.from("fakeimage"));
	setupConfig(dir);
	const captured: { body?: any } = {};
	const fetchImpl = fakeFetchZip(PNGBYTES, captured);

	const { enhanceImage } = await import("../src/draw/service.ts?enh-base");
	const r = await enhanceImage(dir, { source: "/cache/src.png", op: "redraw", fetchImpl: fetchImpl as any });
	assert.match(r.src, /^\/cache\/draw-\d+-[0-9a-f]{6}\.png$/);
	assert.equal(r.providerId, "n1");
	assert.ok(existsSync(join(dir, ".liyuan-cache", r.src.slice("/cache/".length))));
	assert.equal(captured.body.action, "img2img");
});

test("service: enhanceImage 绝对路径源图", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
	const absSrc = join(dir, "abs.png");
	writeFileSync(absSrc, Buffer.from("fakeimage"));
	setupConfig(dir);
	const captured: { body?: any } = {};
	const fetchImpl = fakeFetchZip(PNGBYTES, captured);

	const { enhanceImage } = await import("../src/draw/service.ts?enh-abs");
	const r = await enhanceImage(dir, { source: absSrc, op: "enhance", fetchImpl: fetchImpl as any });
	assert.match(r.src, /^\/cache\/draw-\d+-[0-9a-f]{6}\.png$/);
	assert.equal(captured.body.parameters.strength, 0.15); // enhance 默认 0.15
});

test("service: enhanceImage op 映射（redraw/enhance/upscale/inpaint）", async () => {
	const cases: Array<{
		op: "redraw" | "enhance" | "upscale" | "inpaint";
		q: string;
		strength: number;
		scaleBy?: number;
		mask?: string;
	}> = [
		{ op: "redraw", q: "op1", strength: 0.55 },
		{ op: "enhance", q: "op2", strength: 0.15 },
		{ op: "upscale", q: "op3", strength: 0.1, scaleBy: 2 },
		{ op: "inpaint", q: "op4", strength: 0.55, mask: "TUFTSw==" },
	];
	for (const c of cases) {
		await test(`service: enhance ${c.op} → strength=${c.strength} scaleBy=${c.scaleBy ?? 1} mask=${c.mask ? "有" : "无"}`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
			mkdirSync(join(dir, ".liyuan-cache"), { recursive: true });
			writeFileSync(join(dir, ".liyuan-cache", "src.png"), Buffer.from("fakeimage"));
			setupConfig(dir);
			const captured: { body?: any } = {};
			const fetchImpl = fakeFetchZip(PNGBYTES, captured);
			const { enhanceImage } = await import(`../src/draw/service.ts?${c.q}`);
			const r = await enhanceImage(dir, {
				source: "/cache/src.png",
				op: c.op,
				...(c.mask ? { maskBase64: c.mask } : {}),
				fetchImpl: fetchImpl as any,
			});
			assert.match(r.src, /^\/cache\/draw-\d+-[0-9a-f]{6}\.png$/);
			const p = captured.body.parameters;
			assert.equal(p.strength, c.strength);
			assert.equal(p.scaleBy, c.scaleBy ?? 1);
			if (c.mask) assert.equal(p.mask_image, c.mask);
			else assert.equal(p.mask_image, undefined);
		});
	}
});

test("service: enhanceImage 源图不存在抛 DrawError(parse)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-svc-"));
	setupConfig(dir);
	const { enhanceImage } = await import("../src/draw/service.ts?enh-missing");
	await assert.rejects(
		enhanceImage(dir, { source: "/cache/missing.png", op: "enhance" }),
		(e: any) => e instanceof DrawError && e.code === "parse",
	);
});
