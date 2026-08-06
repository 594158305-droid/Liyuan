import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	mediaStageToolNames,
	mediaStageTools,
	runMediaStageTool,
} from "../src/stage/media-stage.ts";

/**
 * 台上媒体交付（8/06 重接）。与 MCP 同源的断链：消费端 server/wire.ts:344-394
 * 一直健在，缺的是台上生产端。本文件钉死**交付契约与 wire 逐字对齐**——
 * details 的键名/结构错一个字，前端就收不到媒体帧。
 */

// 1×1 PNG（真实字节，走 md5 内容寻址）
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const makeCwd = (): string => mkdtempSync(join(tmpdir(), "liyuan-media-"));

test("工具清单：默认四件；TTS 环境未就绪时 tts 不上清单", () => {
	const names = mediaStageTools("中文").map((t) => t.name).sort();
	assert.deepEqual(names, ["show_audio", "show_html", "show_image", "show_video"]);
	// 依赖缺失的工具不上清单——恒回「本环境不支持」是最糟形态，模型会反复试
	assert.ok(!names.includes("tts"));
	const withTts = mediaStageTools("中文", { tts: true }).map((t) => t.name);
	assert.ok(withTts.includes("tts"));
	assert.equal(mediaStageToolNames({ tts: true }).size, 5);
});

test("schema 合法且必填项正确", () => {
	for (const t of mediaStageTools("中文", { tts: true })) {
		assert.equal((t.parameters as { type: string }).type, "object");
		assert.ok(t.description.length > 20, `${t.name} 要有像样的描述`);
	}
	const byName = new Map(mediaStageTools("中文", { tts: true }).map((t) => [t.name, t]));
	assert.deepEqual((byName.get("show_image")!.parameters as { required: string[] }).required, ["source"]);
	assert.deepEqual((byName.get("show_html")!.parameters as { required: string[] }).required, ["html"]);
	assert.deepEqual((byName.get("tts")!.parameters as { required: string[] }).required, ["text"]);
});

test("非媒体工具名返回 null（回落其他派发，不吞掉 draft_write）", async () => {
	const cwd = makeCwd();
	assert.equal(await runMediaStageTool(cwd, "draft_write", { content: "x" }), null);
	assert.equal(await runMediaStageTool(cwd, "lorebook_search", {}), null);
});

// ---- 交付契约：details 键名必须与 server/wire.ts 逐字对齐 ----

test("show_image：http 源直传，details.rpImage={src,caption}", async () => {
	const cwd = makeCwd();
	const r = await runMediaStageTool(cwd, "show_image", {
		source: "https://example.com/a.png",
		caption: "夜色下的城门",
	});
	assert.equal(r?.isError ?? false, false);
	// wire.ts:349 读 details.rpImage.src —— 键名错一个字前端就收不到
	const img = r?.details?.rpImage as { src: string; caption?: string };
	assert.equal(img.src, "https://example.com/a.png");
	assert.equal(img.caption, "夜色下的城门");
});

test("show_image：本机文件复制进 .liyuan-media 并以 /media/<hash> 交付", async () => {
	const cwd = makeCwd();
	writeFileSync(join(cwd, "pic.png"), PNG_1X1);
	const r = await runMediaStageTool(cwd, "show_image", { source: "pic.png" });
	const img = r?.details?.rpImage as { src: string };
	assert.match(img.src, /^\/media\/[0-9a-f]{16}\.png$/);
	// 副本真的落盘了（原文件删了也能回看，这是内容寻址的意义）
	const mediaDir = join(cwd, ".liyuan-media");
	assert.ok(existsSync(mediaDir));
	assert.equal(readdirSync(mediaDir).length, 1);
	// 同一文件再交付一次：内容寻址不产生第二份
	await runMediaStageTool(cwd, "show_image", { source: "pic.png" });
	assert.equal(readdirSync(mediaDir).length, 1);
});

test("show_image：无 caption 时不塞空字段（wire 读到 undefined 走空串）", async () => {
	const cwd = makeCwd();
	const r = await runMediaStageTool(cwd, "show_image", { source: "https://x.com/a.png" });
	const img = r?.details?.rpImage as Record<string, unknown>;
	assert.ok(!("caption" in img));
});

test("show_image：文件不存在 / 格式不支持 → isError，且不产出 details", async () => {
	const cwd = makeCwd();
	const missing = await runMediaStageTool(cwd, "show_image", { source: "nope.png" });
	assert.equal(missing?.isError, true);
	assert.equal(missing?.details, undefined);

	writeFileSync(join(cwd, "a.txt"), "not an image");
	const badExt = await runMediaStageTool(cwd, "show_image", { source: "a.txt" });
	assert.equal(badExt?.isError, true);
	assert.ok(badExt?.text.includes("不支持"));

	// 空 source 也要拦（模型偶尔传空串）
	const empty = await runMediaStageTool(cwd, "show_image", { source: "  " });
	assert.equal(empty?.isError, true);
});

test("show_video：details.rpVideo；扩展名白名单生效", async () => {
	const cwd = makeCwd();
	const r = await runMediaStageTool(cwd, "show_video", { source: "https://x.com/v.mp4", caption: "回放" });
	const vid = r?.details?.rpVideo as { src: string; caption?: string };
	assert.equal(vid.src, "https://x.com/v.mp4");
	assert.equal(vid.caption, "回放");

	writeFileSync(join(cwd, "v.exe"), "x");
	assert.equal((await runMediaStageTool(cwd, "show_video", { source: "v.exe" }))?.isError, true);
});

test("show_audio：details.rpAudio（与 tts 同一通道）", async () => {
	const cwd = makeCwd();
	const r = await runMediaStageTool(cwd, "show_audio", { source: "https://x.com/a.mp3" });
	const aud = r?.details?.rpAudio as { src: string };
	assert.equal(aud.src, "https://x.com/a.mp3");
});

test("show_html：details.rpHtml={html,title,scripts}；scripts 默认 false", async () => {
	const cwd = makeCwd();
	const r = await runMediaStageTool(cwd, "show_html", { html: "<div>手机</div>", title: "短信" });
	const h = r?.details?.rpHtml as { html: string; title?: string; scripts: boolean };
	assert.equal(h.html, "<div>手机</div>");
	assert.equal(h.title, "短信");
	// wire.ts:391 读 scripts===true；默认必须是 false 而非 undefined（沙箱默认不给 JS）
	assert.equal(h.scripts, false);

	const withJs = await runMediaStageTool(cwd, "show_html", { html: "<b>x</b>", scripts: true });
	assert.equal((withJs?.details?.rpHtml as { scripts: boolean }).scripts, true);
});

test("show_html：空 / 超限拒收（wire 对空 html 本就返回 null，早拦早报错）", async () => {
	const cwd = makeCwd();
	assert.equal((await runMediaStageTool(cwd, "show_html", { html: "   " }))?.isError, true);
	const huge = await runMediaStageTool(cwd, "show_html", { html: "x".repeat(500_001) });
	assert.equal(huge?.isError, true);
	assert.ok(huge?.text.includes("过大"));
});

test("tts：未配置环境时给配置指引而非静默失败", async () => {
	const cwd = makeCwd();
	// 清掉可能存在的真实 env，确保测的是「未配置」路径
	const saved = { ...process.env };
	delete process.env.LIYUAN_TTS_API_KEY;
	delete process.env.OPENAI_API_KEY;
	try {
		const r = await runMediaStageTool(cwd, "tts", { text: "你好" });
		assert.equal(r?.isError, true);
		assert.ok(r!.text.length > 10, "要给可操作的配置指引");
		assert.equal(r?.details, undefined);
	} finally {
		process.env = saved;
	}
});

test("tts：空文本拒收", async () => {
	const cwd = makeCwd();
	assert.equal((await runMediaStageTool(cwd, "tts", { text: "" }))?.isError, true);
});

test("媒体目录不存在时自动建（首次交付不该失败）", async () => {
	const cwd = makeCwd();
	const sub = join(cwd, "deep");
	mkdirSync(sub);
	writeFileSync(join(sub, "p.png"), PNG_1X1);
	const r = await runMediaStageTool(cwd, "show_image", { source: join("deep", "p.png") });
	assert.equal(r?.isError ?? false, false);
	assert.ok(existsSync(join(cwd, ".liyuan-media")));
});

test("成功交付都带 activity（过程条要有话说）", async () => {
	const cwd = makeCwd();
	for (const [name, args] of [
		["show_image", { source: "https://x.com/a.png" }],
		["show_audio", { source: "https://x.com/a.mp3" }],
		["show_video", { source: "https://x.com/a.mp4" }],
		["show_html", { html: "<i>x</i>" }],
	] as const) {
		const r = await runMediaStageTool(cwd, name, args as Record<string, unknown>);
		assert.ok(r?.activity, `${name} 应有 activity`);
	}
});
