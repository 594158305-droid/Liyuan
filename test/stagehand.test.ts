import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildStagehandInjection,
	buildStagehandPrompt,
	buildStoryFloors,
	formatStoryRead,
	formatStorySearch,
	STORY_COMMANDS,
} from "../src/stagehand.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

test("助手 system prompt：超集身份/工作语境/唯一红线/作者工具/纪律齐备", () => {
	const sp = buildStagehandPrompt({ config: DEFAULT_CONFIG });
	assert.ok(sp.includes("系统助手"), "自称=助手（大众词）");
	assert.ok(sp.includes("不参与扮演"), "身份切割：不扮演");
	assert.ok(sp.includes("全局视角") || sp.includes("全能作者"), "超集定位");
	assert.ok(sp.includes("工作语境"), "必须有工作语境段（不注入预设时的语境合法性）");
	assert.ok(sp.includes("虚构创作"), "库存定性=用户的虚构创作");
	assert.ok(sp.includes("工作失职"), "拒看库存=失职");
	// 唯一红线=不替剧情模型在剧情流里生成正文（D10），但作者写入全放行
	assert.ok(sp.includes("唯一不能做") || sp.includes("唯一的红线"), "红线是唯一的一件事");
	assert.ok(sp.includes("剧情对话流") || sp.includes("剧情消息流") || sp.includes("剧情对话里生成"), "不塞进剧情流");
	assert.ok(sp.includes("/reroll"), "改稿的正确动作=调生产条件+重生成");
	// 作者权限工具都在
	assert.ok(sp.includes("panel_write"), "写面板");
	assert.ok(sp.includes("lorebook_write"), "写世界书");
	assert.ok(sp.includes("codex_create") || sp.includes("codex_write"), "知识库");
	assert.ok(sp.includes("card_create"), "创建角色卡");
	assert.ok(sp.includes("show_media"), "素材交付到助手对话");
	assert.ok(sp.includes("story_read"), "剧情记录工具");
	assert.ok(sp.includes("story_command"), "剧情命令工具");
	assert.ok(sp.includes("skill_save"), "技能沉淀归助手");
	assert.ok(sp.includes("得到确认再动手") || sp.includes("改前确认"), "变更先确认");
	assert.ok(sp.includes(DEFAULT_CONFIG.language), "对话语言跟配置");
	// SVG 优先于生图（用户撞坑点）
	assert.ok(sp.includes("svg") || sp.includes("SVG"), "地图优先 svg");
	// 命名纪律：用户可见文案禁戏剧隐喻（检场/幕后/舞台监督只许活在代码注释里）
	for (const banned of ["检场", "幕后", "舞台监督", "戏外", "戏内"]) {
		assert.ok(!sp.includes(banned), `提示词不得出现「${banned}」`);
	}
});

test("助手 system prompt：backendControl=false 时不给本机工具段", () => {
	const on = buildStagehandPrompt({ config: { ...DEFAULT_CONFIG, backendControl: true } });
	const off = buildStagehandPrompt({ config: { ...DEFAULT_CONFIG, backendControl: false } });
	assert.ok(on.includes("本机通用工具"));
	assert.ok(!off.includes("本机通用工具"));
});

test("剧情快照注入：模型/占用/独立模型标注", () => {
	const base = {
		sessionId: "abcdef1234567890",
		cardName: "青梧",
		userName: "旅人",
		model: { provider: "deepseek", id: "deepseek-chat" },
		contextPercent: 42.6,
		messageCount: 12,
		streaming: false,
	};
	const s = buildStagehandInjection(base);
	assert.ok(s.includes("【剧情快照】"));
	assert.ok(s.includes("abcdef12"));
	assert.ok(s.includes("deepseek/deepseek-chat"));
	assert.ok(s.includes("43%"));
	assert.ok(!s.includes("你自己运行在"), "跟随模式不标注独立模型");

	const solo = buildStagehandInjection({
		...base,
		streaming: true,
		assistantModel: { provider: "xai", id: "grok-4" },
		assistantFollows: false,
	});
	assert.ok(solo.includes("排队到本轮结束"), "生成中要提示排队语义");
	assert.ok(solo.includes("xai/grok-4"));
});

const msgs = [
	{ role: "custom", customType: "rp-greeting", display: true, content: "【开场 · 青梧】她立在檐下。" },
	{ role: "user", content: "我走近she。" },
	{ role: "assistant", content: [{ type: "text", text: "先查设定" }, { type: "toolCall", id: "t1" }] },
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "推演一下走位" },
			{ type: "text", text: "<draft_notes>草稿</draft_notes>\n她抬头，檐水正落。" },
		],
	},
	{ role: "user", content: "//帮我看看配置" },
	{ role: "assistant", content: "已看完配置。" },
	{ role: "user", content: "第二天呢？" },
	{ role: "assistant", content: "翌日晴。" },
];

test("楼层视图：编号与前端一致，场外轮与工具中间轮不占层", () => {
	const floors = buildStoryFloors(msgs);
	assert.deepEqual(
		floors.map((f) => [f.floor, f.kind]),
		[
			[1, "开场白"],
			[2, "用户"],
			[3, "回复"],
			[4, "用户"],
			[5, "回复"],
		],
	);
	// display 视图剥脚手架
	assert.ok(!floors[2].text.includes("draft_notes"));
	assert.ok(floors[2].text.includes("檐水"));
	// raw 视图保留原文与思维链
	const raw = buildStoryFloors(msgs, "raw");
	assert.ok(raw[2].text.includes("<draft_notes>"));
	assert.equal(raw[2].thinking, "推演一下走位");
});

test("story_read：默认取尾部、from/to 区间、超长截断", () => {
	const tail = formatStoryRead(msgs, { last: 2 });
	assert.ok(tail.includes("#4"));
	assert.ok(tail.includes("#5"));
	assert.ok(!tail.includes("#1【"));

	const range = formatStoryRead(msgs, { from: 1, to: 2 });
	assert.ok(range.includes("#1"));
	assert.ok(range.includes("#2"));
	assert.ok(!range.includes("#3【"));

	const clipped = formatStoryRead(
		[{ role: "user", content: `开头${"很长".repeat(400)}结尾` }],
		{ maxChars: 200 },
	);
	assert.ok(clipped.includes("截断"));

	assert.ok(formatStoryRead([]).includes("为空"));
});

test("story_search：命中给楼层与摘录，未命中如实说", () => {
	const hit = formatStorySearch(msgs, "檐水");
	assert.ok(hit.includes("#3"));
	assert.ok(hit.includes("檐水"));
	const miss = formatStorySearch(msgs, "不存在的词");
	assert.ok(miss.includes("未命中"));
});

test("story_command 白名单包含核心剧情命令", () => {
	for (const c of ["reroll", "rewind", "compact"]) {
		assert.ok((STORY_COMMANDS as readonly string[]).includes(c));
	}
});

test("楼层视图：rp-edited-reply 改稿替换同轮回复（2026-08-12 修复）", () => {
	const msgs = [
		{ role: "user", content: "给最新层配图前先看正文" },
		{ role: "assistant", content: "星辉历332年5月6日，午后。凯尔走进经理室。（原文）" },
		{ role: "custom", customType: "rp-edited-reply", content: "星辉历332年5月6日，午后。凯尔走进经理室。（改稿版）" },
		{ role: "user", content: "第二天呢？" },
		{ role: "assistant", content: "翌日晴。" },
	];
	const floors = buildStoryFloors(msgs);
	assert.deepEqual(
		floors.map((f) => [f.floor, f.kind]),
		[
			[1, "用户"],
			[2, "回复"],
			[3, "用户"],
			[4, "回复"],
		],
	);
	// 改稿覆盖同轮回复：楼层 2 显示改稿版而非原文
	assert.ok(floors[1].text.includes("改稿版"));
	assert.ok(!floors[1].text.includes("原文）"));
});

test("楼层视图：rp-edited-reply 无同轮回复时追加为回复楼层", () => {
	const msgs = [
		{ role: "user", content: "指令" },
		{ role: "custom", customType: "rp-edited-reply", content: "直接改稿的回复" },
	];
	const floors = buildStoryFloors(msgs);
	assert.deepEqual(
		floors.map((f) => [f.floor, f.kind]),
		[
			[1, "用户"],
			[2, "回复"],
		],
	);
	assert.ok(floors[1].text.includes("直接改稿的回复"));
});

test("楼层视图：场外导演指令后的 rp-edited-reply 不被 inBackstage 吞掉（2026-08-16 修复）", () => {
	// 复现故障：story_edit 提交时 sm.branch 切掉原回复，改稿成为前一条（场外/幕后）用户指令的子节点。
	// 旧逻辑 inBackstage 从该指令连坐过来，把 rp-edited-reply 整层跳过 → 助手楼层数掉一层（#80→只剩#79）。
	const msgs = [
		{ role: "user", content: "张三" },
		{ role: "assistant", content: "凯尔先去洗了个澡。" },
		{ role: "user", content: "（编撰者幕后：把这段收尾收掉）" },
		{ role: "custom", customType: "rp-edited-reply", content: "凯尔快速冲了个澡，披上浴袍回到客厅。", display: true },
	];
	const floors = buildStoryFloors(msgs);
	// 改稿层必须保留为「回复」楼，楼层数不掉
	assert.deepEqual(
		floors.map((f) => [f.floor, f.kind]),
		[
			[1, "用户"],
			[2, "回复"],
			[3, "回复"],
		],
	);
	const last = floors[floors.length - 1];
	assert.ok(last.kind === "回复");
	assert.ok(last.text.includes("披上浴袍回到客厅"), "改稿全文应可被助手读到");
	assert.ok(!last.text.includes("场外"), "不应是后台指令文本");
});
