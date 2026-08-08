/**
 * 插件 B draw-pipeline 单测：图片计划解析/合规、锚点定位、管线编排（fake deps 全注入）、
 * assemble 输入侧占位符剥离。
 * 运行：node --test test/draw-pipeline.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enforceLimits, parseImagePlan } from "../src/draw-plugins/draw-pipeline/scene-plan.ts";
import { buildInsertPatch } from "../src/draw-plugins/draw-pipeline/anchor.ts";
import { buildPlannerPrompt } from "../src/draw-plugins/draw-pipeline/planner.ts";
import {
	markEntryProcessed,
	resetPipelineDedupe,
	resetPipelineTimer,
	runPipeline,
	type PipelineDeps,
	type PipelineSettings,
} from "../src/draw-plugins/draw-pipeline/pipeline.ts";
import { stripDrawPlaceholders } from "../src/stage/assemble.ts";

const tmpCwd = (): string => mkdtempSync(join(tmpdir(), "liyuan-pipeline-"));

// ---------- 1. parseImagePlan ----------

test("parseImagePlan：标准 YAML 块解析（多任务/字段）", () => {
	const text = `一些正文\n<image_gen>\n  - index: 1\n    anchor: "他推开酒馆的门"\n    aspect: landscape\n    scene: "1girl, tavern interior"\n    negative: "lowres"\n    characters:\n      - name: 伊利亚斯\n        action: pushing door\n  - index: 2\n    aspect: square\n    scene: "sword, close-up"\n</image_gen>\n收尾`;
	const plan = parseImagePlan(text);
	assert.equal(plan.tasks.length, 2);
	assert.equal(plan.tasks[0].index, 1);
	assert.equal(plan.tasks[0].anchor, "他推开酒馆的门");
	assert.equal(plan.tasks[0].aspect, "landscape");
	assert.equal(plan.tasks[0].scene, "1girl, tavern interior");
	assert.equal(plan.tasks[0].negative, "lowres");
	assert.equal(plan.tasks[0].characters.length, 1);
	assert.equal(plan.tasks[0].characters[0].name, "伊利亚斯");
	assert.equal(plan.tasks[0].characters[0].action, "pushing door");
	assert.equal(plan.tasks[1].aspect, "square");
});

test("parseImagePlan：多个 image_gen 块合并（保序）", () => {
	const text = `<image_gen>\n  - index: 1\n    scene: "a"\n</image_gen>\n中间\n<image_gen>\n  - index: 2\n    scene: "b"\n</image_gen>`;
	const plan = parseImagePlan(text);
	assert.deepEqual(
		plan.tasks.map((t) => t.scene),
		["a", "b"],
	);
});

test("parseImagePlan：畸形输出容错（缩进乱/引号断）", () => {
	// 无缩进 + 缺引号
	const text = `<image_gen>\n- index: 3\naspect: landscape\nscene: 一只猫在窗台上\n- index: 4\nscene: "第二张"\n</image_gen>`;
	const plan = parseImagePlan(text);
	assert.equal(plan.tasks.length, 2);
	assert.equal(plan.tasks[0].aspect, "landscape");
	assert.equal(plan.tasks[0].scene, "一只猫在窗台上");
});

test("parseImagePlan：无块 → 抛错", () => {
	assert.throws(() => parseImagePlan("纯文本没有块"), /image_gen/);
});

// ---------- 2. enforceLimits ----------

test("enforceLimits：maxImages 截断、maxCharactersPerImage 截断、scene 空回退", () => {
	const plan = parseImagePlan(
		`<image_gen>\n  - index: 1\n    scene: "a"\n    characters:\n      - name: 甲\n      - name: 乙\n      - name: 丙\n      - name: 丁\n  - index: 2\n    scene: "b"\n  - index: 3\n    scene: "c"\n  - index: 4\n    scene: ""\n</image_gen>`,
	);
	const limited = enforceLimits(plan, { maxImages: 2, maxCharactersPerImage: 2 });
	assert.equal(limited.tasks.length, 2, "maxImages=2 截断");
	assert.equal(limited.tasks[0].characters.length, 2, "maxCharactersPerImage=2 截断");
	assert.ok(limited.warnings.length > 0);
});

// ---------- 3. buildInsertPatch ----------

test("buildInsertPatch：全文精确匹配 + 段落对齐", () => {
	const text = "他推开酒馆的门，暖光洒进来。\n\n门后传来低语。";
	const r = buildInsertPatch(text, "他推开酒馆的门", "[image:slot-1]");
	assert.ok(r.ok);
	const patch = (r as { patch: { old: string; new: string } }).patch;
	assert.ok(patch.old.length > 0);
	// new = old + 占位符
	assert.ok(patch.new.endsWith("[image:slot-1]"));
	// 段落对齐：插入点推到 \n\n 前
	assert.ok(patch.old.includes("暖光洒进来"));
});

test("buildInsertPatch：anchor 缺省 → append 补丁", () => {
	const r = buildInsertPatch("正文", undefined, "[image:s]");
	assert.ok(r.ok);
	assert.deepEqual((r as { patch: { append: string } }).patch, { append: "[image:s]" });
});

test("buildInsertPatch：无锚点 → ok:false", () => {
	const r = buildInsertPatch("", "不存在的锚点", "[image:s]");
	assert.ok(!r.ok);
});

test("buildInsertPatch：模糊匹配（去标点）命中", () => {
	const text = "雨丝斜落，她把伞收拢。\n\n远处有人喊。";
	const r = buildInsertPatch(text, "她把伞收拢！", "[image:s]");
	assert.ok(r.ok, "标点差异应经模糊匹配命中");
});

// ---------- 4. runPipeline（deps 全注入 fake） ----------

const fakeDeps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
	callPlanner: async () =>
		`<image_gen>\n  - index: 1\n    anchor: "正文第一句"\n    aspect: landscape\n    scene: "test scene"\n</image_gen>`,
	generate: async () => ({ src: "/cache/draw-1.png", slotId: "slot-1" }),
	resolveChars: (names) => names.map((n) => ({ tags: `${n}_tag` })),
	registerSlot: () => {},
	...over,
});

const defaultSettings = (over: Partial<PipelineSettings> = {}): PipelineSettings => ({
	auto: true,
	characters: [],
	minIntervalMs: 5000,
	maxImages: 2,
	maxCharactersPerImage: 3,
	...over,
});

test("runPipeline：全流程（fake）→ ran=true、slots、patches", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	const r = await runPipeline(tmpCwd(), {
		entryId: "e1",
		chatId: "c1",
		messageText: "正文第一句。然后后面还有内容。",
		settings: defaultSettings(),
		deps: fakeDeps(),
	});
	assert.equal(r.ran, true);
	assert.equal(r.slots.length, 1);
	assert.equal(r.slots[0].slotId, "slot-1");
	assert.equal(r.patches.length, 1);
	const p = r.patches[0] as { old: string; new: string };
	assert.ok(p.new.includes("[image:slot-1]"));
});

test("runPipeline：auto=false → ran=false", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	const r = await runPipeline(tmpCwd(), {
		entryId: "e2",
		chatId: "c",
		messageText: "正文",
		settings: defaultSettings({ auto: false }),
		deps: fakeDeps(),
	});
	assert.equal(r.ran, false);
	assert.ok(r.reason?.includes("auto"));
});

test("runPipeline：角色白名单拦截（正文无命中角色）", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	const r = await runPipeline(tmpCwd(), {
		entryId: "e3",
		chatId: "c",
		messageText: "正文不含白名单角色",
		settings: defaultSettings({ characters: ["不存在角色"] }),
		deps: fakeDeps(),
	});
	assert.equal(r.ran, false);
	assert.ok(r.reason?.includes("白名单"));
});

test("runPipeline：同 entryId 去重", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	const opts = {
		entryId: "e-dup",
		chatId: "c",
		messageText: "正文",
		settings: defaultSettings(),
		deps: fakeDeps(),
	};
	const r1 = await runPipeline(tmpCwd(), opts);
	assert.equal(r1.ran, true);
	const r2 = await runPipeline(tmpCwd(), opts);
	assert.equal(r2.ran, false);
	assert.ok(r2.reason?.includes("去重"));
	// 清理去重（避免影响其它用例）
	resetPipelineDedupe();
});

test("runPipeline：callPlanner 首次抛错自动重试一次", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	let calls = 0;
	const deps = fakeDeps({
		callPlanner: async () => {
			calls++;
			if (calls === 1) throw new Error("首次失败");
			return `<image_gen>\n  - index: 1\n    scene: "ok"\n</image_gen>`;
		},
	});
	const r = await runPipeline(tmpCwd(), {
		entryId: "e-retry",
		chatId: "c",
		messageText: "正文",
		settings: defaultSettings(),
		deps,
	});
	assert.equal(r.ran, true);
	assert.equal(calls, 2, "首次失败 + 重试成功 = 2 次调用");
	assert.equal(r.slots.length, 1);
});

test("runPipeline：两次调用均失败 → ran=true + reason（错误优雅捕获）", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	const deps = fakeDeps({
		callPlanner: async () => {
			throw new Error("always fail");
		},
	});
	const r = await runPipeline(tmpCwd(), {
		entryId: "e-fail",
		chatId: "c",
		messageText: "正文",
		settings: defaultSettings(),
		deps,
	});
	assert.equal(r.ran, true);
	assert.equal(r.slots.length, 0);
	assert.ok(r.reason?.includes("两次调用均失败"));
});

test("runPipeline：多图（无 anchor）→ 全部占位符合并进末尾 append 补丁", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	let genCount = 0;
	const deps = fakeDeps({
		callPlanner: async () =>
			`<image_gen>\n  - index: 1\n    scene: "a"\n  - index: 2\n    scene: "b"\n</image_gen>`,
		generate: async () => ({ src: `/cache/draw-${++genCount}.png`, slotId: `slot-${genCount}` }),
	});
	const r = await runPipeline(tmpCwd(), {
		entryId: "e-multi",
		chatId: "c",
		messageText: "正文",
		settings: defaultSettings(),
		deps,
	});
	assert.equal(r.ran, true);
	assert.equal(r.slots.length, 2);
	const lastPatch = r.patches[r.patches.length - 1] as { append?: string };
	assert.ok(lastPatch.append?.includes("[image:slot-1]"));
	assert.ok(lastPatch.append?.includes("[image:slot-2]"));
});

// ---------- 5. 输入侧剥离 ----------

test("stripDrawPlaceholders：删占位符，幂等", () => {
	assert.equal(stripDrawPlaceholders("正文[image:slot-1]结尾"), "正文结尾");
	assert.equal(stripDrawPlaceholders("无占位符"), "无占位符");
	assert.equal(stripDrawPlaceholders("多[image:a][image:b]个"), "多个");
});

// ---------- 6. 管线输入补齐（批 6 对账裁决）：searchLore / summaryText / historyText ----------

test("runPipeline：searchLore 注入后被调用（正文关键词 + 角色名拼接 query）", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	let calls = 0;
	let lastQuery = "";
	let lastLimit = 0;
	const deps = fakeDeps({
		searchLore: (query, limit) => {
			calls++;
			lastQuery = query;
			lastLimit = limit ?? 0;
			return "【设定】\n酒馆是边境最热闹的地方。\n\n【传闻】\n据说地下室藏着旧时代的遗物。";
		},
	});
	const r = await runPipeline(tmpCwd(), {
		entryId: "e-lore",
		chatId: "c",
		messageText: "伊利亚斯在酒馆门口驻足。",
		settings: defaultSettings({ characters: ["伊利亚斯"] }),
		deps,
	});
	assert.equal(r.ran, true);
	assert.ok(calls >= 1, "searchLore 应被调用");
	assert.ok(lastQuery.includes("伊利亚斯在酒馆门口驻足"), "query 应含正文前 100 字符");
	assert.ok(lastQuery.includes("伊利亚斯"), "query 应含白名单角色名");
	assert.equal(lastLimit, 3);
	assert.equal(r.slots.length, 1);
});

test("runPipeline：summaryText 进入提示词（fake callPlanner 断言 system/user 含摘要）", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	let seenUser = "";
	const deps = fakeDeps({
		callPlanner: async (prompt) => {
			seenUser = prompt.user;
			return `<image_gen>\n  - index: 1\n    scene: "ok"\n</image_gen>`;
		},
	});
	const r = await runPipeline(tmpCwd(), {
		entryId: "e-summary",
		chatId: "c",
		messageText: "正文",
		historyText: "更早的前文：他们翻过了山脊。",
		summaryText: "早期剧情：伊利亚斯来到边境酒馆寻找失踪的商队。",
		settings: defaultSettings(),
		deps,
	});
	assert.equal(r.ran, true);
	assert.ok(seenUser.includes("早期剧情：伊利亚斯来到边境酒馆寻找失踪的商队"), "user 提示词应含摘要");
	assert.ok(seenUser.includes("更早的前文"), "user 提示词应含 historyText 段");
	// 顺序：摘要在前、正文在后
	assert.ok(seenUser.indexOf("前情提要") < seenUser.indexOf("当前剧情正文"), "摘要段应在正文之前");
});

// ---------- 7. 批次 2/3：失败落 failed slot + 角色 uc + 角色组 ----------

test("runPipeline：生图失败 → 落 failed slot（src 空、registerSlot 收到 failed）+ 占位符进补丁", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	const registered: Array<{ slotId: string; file: string; tags?: { scene?: string; failed?: { code?: string; reason: string } } }> = [];
	const deps = fakeDeps({
		callPlanner: async () => `<image_gen>\n  - index: 1\n    scene: "boom scene"\n</image_gen>`,
		generate: async () => {
			throw new Error("生成器炸了");
		},
		registerSlot: (slotId, file, tags) => {
			registered.push({ slotId, file, tags });
		},
	});
	const r = await runPipeline(tmpCwd(), {
		entryId: "e-failgen",
		chatId: "c",
		messageText: "正文",
		settings: defaultSettings(),
		deps,
	});
	assert.equal(r.ran, true);
	assert.equal(r.slots.length, 1);
	assert.equal(r.slots[0].src, "", "失败 slot src 为空");
	assert.ok(r.warnings.some((w) => w.includes("生图失败")), "warnings 保留原因文本");
	// registerSlot 收到 failed（file=""，code 由 classifyError(Error) → unknown）
	const reg = registered[0];
	assert.ok(reg);
	assert.equal(reg.file, "");
	assert.equal(reg.tags?.scene, "boom scene");
	assert.equal(reg.tags?.failed?.reason, "生成器炸了");
	assert.equal(reg.tags?.failed?.code, "unknown");
	// 失败占位符进补丁（前端显示失败态）
	assert.ok(r.patches.length > 0, "失败 slot 应进 patches");
	assert.ok(JSON.stringify(r.patches).includes("[image:") || (r.patches[0] as { append?: string }).append?.includes("[image:"), "补丁应含失败占位符");
});

test("runPipeline：角色 uc 并入 negativePrompt（task.negative + uc 逗号连接去重）", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	let seenNegative = "";
	const deps = fakeDeps({
		callPlanner: async () =>
			`<image_gen>\n  - index: 1\n    scene: "scene"\n    negative: "lowres"\n    characters:\n      - name: 甲\n        action: running\n</image_gen>`,
		resolveChars: (names) => names.map((n) => ({ tags: `${n}_tag`, uc: n === "甲" ? "bad_hair" : "" })),
		generate: async (opts) => {
			seenNegative = opts.negativePrompt ?? "";
			return { src: "/cache/draw-1.png", slotId: "slot-1" };
		},
	});
	const r = await runPipeline(tmpCwd(), {
		entryId: "e-uc",
		chatId: "c",
		messageText: "正文",
		settings: defaultSettings(),
		deps,
	});
	assert.equal(r.ran, true);
	assert.equal(seenNegative, "lowres, bad_hair");
});

test("runPipeline：角色 groupTags 并入 prompt（base 与 action 之间）", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	let seenPrompt = "";
	const deps = fakeDeps({
		callPlanner: async () =>
			`<image_gen>\n  - index: 1\n    scene: "scene"\n    characters:\n      - name: 甲\n        action: running\n</image_gen>`,
		resolveChars: (names) => names.map((n) => ({ tags: "appearance_tag", groupTags: "role_group_tag" })),
		generate: async (opts) => {
			seenPrompt = opts.prompt;
			return { src: "/cache/draw-1.png", slotId: "slot-1" };
		},
	});
	const r = await runPipeline(tmpCwd(), {
		entryId: "e-group",
		chatId: "c",
		messageText: "正文",
		settings: defaultSettings(),
		deps,
	});
	assert.equal(r.ran, true);
	assert.ok(seenPrompt.startsWith("appearance_tag, role_group_tag, running, scene"), `顺序应为 base, group, action, scene，实际：${seenPrompt}`);
});

test("runPipeline：无 groupTags / 无 uc 时行为不变（向后兼容）", async () => {
	resetPipelineDedupe();
	resetPipelineTimer();
	let seenPrompt = "";
	let seenNegative = "unset";
	const deps = fakeDeps({
		callPlanner: async () =>
			`<image_gen>\n  - index: 1\n    scene: "scene"\n    characters:\n      - name: 甲\n        action: running\n</image_gen>`,
		resolveChars: (names) => names.map((n) => ({ tags: `${n}_tag` })), // 无 uc / 无 groupTags
		generate: async (opts) => {
			seenPrompt = opts.prompt;
			seenNegative = opts.negativePrompt ?? "";
			return { src: "/cache/draw-1.png", slotId: "slot-1" };
		},
	});
	const r = await runPipeline(tmpCwd(), {
		entryId: "e-compat",
		chatId: "c",
		messageText: "正文",
		settings: defaultSettings(),
		deps,
	});
	assert.equal(r.ran, true);
	assert.equal(seenPrompt, "甲_tag, running, scene");
	assert.equal(seenNegative, "", "无 uc → negativePrompt 为空");
});
