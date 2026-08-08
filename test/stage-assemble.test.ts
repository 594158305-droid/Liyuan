import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	buildStageInjection,
	buildStageSystemPrompt,
	detectsLanguageMismatch,
	formatLoreIndex,
	rebuildHistory,
	stateFromBranch,
	codexNamesFromBranch,
	type BranchEntryLike,
} from "../src/stage/assemble.ts";
import { constantLoreOf, evalPostHistoryBlocks, loadStageMaterials } from "../src/stage/materials.ts";
import { defaultState } from "../src/state.ts";
import { DEFAULT_CONFIG, type RpConfig } from "../src/types.ts";

// ---------------- 分支 → 历史 ----------------

const userE = (text: string): BranchEntryLike => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const asstE = (text: string): BranchEntryLike => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

test("rebuildHistory：开场白→assistant、补丁套用、过程条目蒸发、同角色合并", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom_message", customType: "rp-greeting", content: "【开场】她回头。" },
		{ type: "custom", customType: "rp-state", data: { scene: "山门" } },
		userE("我上前行礼。"),
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "内心盘算……" },
					{ type: "text", text: "云澜受了半礼，袖口沾着晨露。" },
				],
			},
		},
		// 同拍第二条 assistant（旧会话工具轮之间的散文本）→ 应与上条合并
		asstE("「起来吧。」"),
		// 补丁：定点替换
		{ type: "custom_message", customType: "rp-draft-op", content: JSON.stringify({ old: "晨露", new: "夜霜" }) },
		// 工具回执（旧会话残留）→ 不进历史
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
		userE("说明来意。"),
	];
	const { history, lastUserText, lastNarrativeText } = rebuildHistory(branch);

	assert.equal(history[0].role, "assistant");
	assert.ok(history[0].text.includes("【开场】"));
	assert.equal(history.length, 4); // 开场 / user / assistant(合并) / user
	assert.ok(history[2].text.includes("夜霜"), "补丁应套用");
	assert.ok(!history[2].text.includes("晨露"));
	assert.ok(history[2].text.includes("「起来吧。」"), "同角色相邻合并");
	assert.ok(!history[2].text.includes("内心盘算"), "thinking 不进历史");
	assert.equal(lastUserText, "说明来意。");
	assert.ok(lastNarrativeText.includes("夜霜"), "语言检测源=最后台上叙事（含补丁）");
});

test("rebuildHistory：幕后轮的回复不作语言检测源；rp-import 记为 user 侧", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom_message", customType: "rp-import", content: "【前情提要】旧事一段。" },
		userE("我环顾四周。"),
		asstE("殿内烛影摇动。"),
		userE("//帮我看下配置"),
		asstE("Config check done, everything looks fine and here is a long english reply for you."),
	];
	const { history, lastNarrativeText } = rebuildHistory(branch);
	assert.equal(history[0].role, "user");
	assert.ok(history[0].text.includes("前情提要"));
	assert.ok(lastNarrativeText.includes("烛影"), "幕后轮回复跳过，检测源回溯到台上叙事");
});

test("stateFromBranch：最近快照生效；无快照=初始", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom", customType: "rp-state", data: { scene: "旧场景" } },
		userE("走。"),
		{ type: "custom", customType: "rp-state", data: { scene: "新场景" } },
	];
	assert.equal((stateFromBranch(branch) as { scene?: string }).scene, "新场景");
	assert.deepEqual(stateFromBranch([userE("嗨")]), defaultState());
});

test("codexNamesFromBranch：最近挂载快照生效；随 rewind/fork 走；无快照=空", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom", customType: "rp-codex", data: { mounted: ["旧库"] } },
		userE("走。"),
		{ type: "custom", customType: "rp-codex", data: { mounted: ["甲库", "乙库"] } },
	];
	assert.deepEqual(codexNamesFromBranch(branch), ["甲库", "乙库"]);
	assert.deepEqual(codexNamesFromBranch([userE("嗨")]), []);
	// 卸载记为空数组快照，不是「无快照」
	assert.deepEqual(codexNamesFromBranch([{ type: "custom", customType: "rp-codex", data: { mounted: [] } }]), []);
	// 脏数据不炸：非数组/非字符串元素一律滤掉
	assert.deepEqual(codexNamesFromBranch([{ type: "custom", customType: "rp-codex", data: { mounted: "x" } }]), []);
	assert.deepEqual(
		codexNamesFromBranch([{ type: "custom", customType: "rp-codex", data: { mounted: ["甲", 5, null] } }]),
		["甲"],
	);
});

// ---------------- 提示词装配 ----------------

const card = {
	name: "云澜",
	description: "{{user}}的同门师姐。",
	personality: "冷静自持",
	scenario: "山门月下",
	mesExample: "",
	firstMes: "你来了。",
	alternateGreetings: [],
	systemPrompt: "",
	postHistoryInstructions: "",
	creatorNotes: "",
	tags: [],
	book: [],
};
const config: RpConfig = { ...DEFAULT_CONFIG, userName: "沈舟" };

test("system prompt：状态栏提示词分型——占位符型不引导展开成对写法", () => {
	// 占位符型（自闭合 <Tag/>：界面由卡渲染）：模型只该原样输出占位符，不得填内容
	const placeholder = buildStageSystemPrompt({
		card,
		config,
		constantLore: [],
		statusBarFormats: ["`<StatusPlaceHolderImpl/>`"],
	});
	assert.ok(placeholder.includes("占位符渲染状态栏界面"), "占位符语义说明在场");
	assert.ok(placeholder.includes("原样输出"), "要求原样输出");
	assert.ok(placeholder.includes("不要展开成成对写法"), "明确禁止展开成对（8/05：模型写成对标签导致卡正则打空）");
	assert.ok(placeholder.includes("不要往里填内容"), "明确禁止填内容");
	assert.ok(!placeholder.includes("包住整块写出"), "占位符型不得沿用面板型措辞");

	// 面板型（成对 <state1>…</state1>）：模型用标签包住内容
	const panel = buildStageSystemPrompt({ card, config, constantLore: [], statusBarFormats: ["`<state1>…</state1>`"] });
	assert.ok(panel.includes("包住整块写出"), "面板型保留包住整块的语义");
	assert.ok(panel.includes("字段随本拍剧情更新"), "面板型保留字段更新语义");

	// 末端导演备注同样分型（buildStageInjection）
	const inj = buildStageInjection({
		state: { time: "", location: "", characters: {}, inventory: [], flags: {}, plot_threads: [] },
		activatedLore: [],
		card,
		config,
		statusBarFormats: ["`<StatusPlaceHolderImpl/>`"],
	});
	assert.ok(inj.includes("自闭合占位符"), "导演备注：占位符语义");
});

test("system prompt：字节稳定、宏替换、主权红线随预设让位", () => {	const opts = { card, config, constantLore: [], statusBarFormats: ["state1"] };
	const a = buildStageSystemPrompt(opts);
	const b = buildStageSystemPrompt(opts);
	assert.equal(a, b, "同素材两次装配必须逐字节一致");
	assert.ok(a.includes("沈舟的同门师姐"), "{{user}} 宏应替换");
	assert.ok(a.includes("绝不替 沈舟 说话、行动"), "无预设：harness 兜底纪律在场（叙事与文风节）");
	assert.ok(a.includes("state1"), "状态栏格式线索在场");
	assert.ok(a.includes("停在 沈舟 可以接话"), "演完即停是 harness 缺省（正面祈使句）");
	assert.ok(a.includes("一场长篇沉浸式角色扮演"), "舞台只声明角色扮演（不抢预设身份工作）");

	const withPreset = buildStageSystemPrompt({
		...opts,
		presetActive: true,
		presetResident: {
			aBlocks: [{ id: "s0", content: "破限框架原文。", channel: "system", enabled: true }],
			styleTexts: ["文风块：要生动。"],
			boundaryTexts: ["不替用户做重大决定。"],
		},
	});
	assert.ok(withPreset.includes("扮演规范以用户预设为准"), "预设在场：扮演规范让位");
	assert.ok(!withPreset.includes("用户主权"), "让位后 harness 不重复立规");
	assert.ok(withPreset.includes("破限框架原文。"), "A 类原文进场（预设指令段）");
	assert.ok(withPreset.includes("文风块：要生动。"), "B 类进「文风与写法」节");
	assert.ok(withPreset.indexOf("# 文风与写法") > 0 && !withPreset.includes("不要在思考里逐条自查"), "P10：机械纪律去重，B 节不再重复自查指令");
	assert.ok(withPreset.includes("不替用户做重大决定。"), "C 类进「行为边界」节");
});

test("system prompt：构思成清单 + 最小稿纸循环，其他工具仍由 schema 自我说明", () => {
	const opts = { card, config, constantLore: [], statusBarFormats: [] };
	const without = buildStageSystemPrompt(opts);
	const withSkill = buildStageSystemPrompt({ ...opts, skillTopics: ["general", "nsfw"] });
	for (const p of [without, withSkill]) {
		assert.ok(p.includes("角色扮演"), "先说清在做什么");
		// P2：删「始终思考剧情的发展走向」越权句，全貌思考不再合法化到每一轮
		assert.ok(!p.includes("始终思考剧情"), "不把全貌思考合法化到每一轮");
		assert.ok(p.includes("资深作家"), "身份激活：把自己当成资深作家");
		assert.ok(p.includes("你需要读懂本拍处境"), "第 1 轮祈使句");
		assert.ok(p.includes("发挥自己职业作家的水平"), "每轮开始祈使句（身份激活）");
		assert.ok(p.includes("倾尽所有的去构思"), "写作过程中祈使句（强度上限）");
		assert.ok(p.includes("以注入为准"), "具体步骤以每轮注入的轮次卡为准");
		assert.ok(p.includes("重新评估"), "写完后评估（ask/重拟/seal）");
		for (const tool of ["writing_guide", "draft_write", "lorebook_search"]) {
			assert.ok(!p.includes(tool), `不把无关工具写进工作流 ${tool}`);
		}
	}
});

test("末端注入：世界状态最前、导演备注最后、拆层归拢节各就位、语言自愈", () => {
	const inj = buildStageInjection({
		state: defaultState(),
		activatedLore: [],
		card,
		config,
		presetTail: {
			aBlocks: [{ id: "a", content: "末端破限原文", channel: "postHistory", enabled: true }],
			styleTexts: ["末端文风要点"],
			boundaryTexts: ["末端行为边界"],
		},
		languageMismatch: true,
	});
	assert.ok(inj.startsWith("【世界状态】"));
	assert.ok(inj.trimEnd().includes("【导演备注】"));
	assert.ok(inj.indexOf("【导演备注】") > inj.indexOf("【预设末端指令】"));
	assert.ok(inj.includes("末端破限原文"), "A 类原文在【预设末端指令】");
	assert.ok(inj.includes("末端文风要点") && inj.includes("【文风与写法】"), "B 类归拢节");
	assert.ok(inj.includes("末端行为边界") && inj.includes("【行为边界】"), "C 类归拢节");
	assert.ok(inj.includes("错误的语言"), "语言自愈提醒");
	assert.ok(!inj.includes("【登场名录】"), "无名录不出块");
});

test("末端注入：wordRange 是背景信息，不带验收暗示（8/08 定案：目标可持有，不当考试）", () => {
	const inj = buildStageInjection({
		state: defaultState(),
		activatedLore: [],
		card,
		config,
		presetActive: true,
		wordRange: { min: 500, max: 800 },
	});
	assert.ok(inj.includes("500–800 字"), "篇幅信息仍在场——目标本身不是病");
	assert.ok(inj.includes("心里有数即可"), "口径是背景信息");
	// 「由验收器核验 / 朝这个量落笔」把篇幅变成落笔前要对准的考试：8/08 实弹里模型
	// 逐字引用这一行后当场脑内写完整篇初稿（13587 字思考）。这类措辞不得回归。
	assert.ok(!inj.includes("验收器核验"), "不把篇幅说成待通过的验收");
	assert.ok(!inj.includes("朝这个量落笔"), "不要求落笔前对准总量");
	// 末尾权重留给真纪律（语言/主权/状态栏），篇幅不占最后一句
	const tail = inj.slice(inj.lastIndexOf("【导演备注】"));
	assert.ok(!tail.trimEnd().endsWith("心里有数即可，不必核算。"), "篇幅不是导演备注的最后一句");
});

test("detectsLanguageMismatch：中文目标才判、样本要够长", () => {
	const en = "The moon hangs over the courtyard while she waits in silence for a long time tonight.";
	assert.equal(detectsLanguageMismatch(en, "中文"), true);
	assert.equal(detectsLanguageMismatch("殿内烛影摇动，她伏案未眠，窗外霜色渐重，更漏声一声一声敲在瓦上，夜风穿堂而过带起纸页。", "中文"), false);
	assert.equal(detectsLanguageMismatch("short", "中文"), false);
	assert.equal(detectsLanguageMismatch(en, "English"), false);
});

test("formatLoreIndex：只出标题、超预算截断", () => {
	const entries = Array.from({ length: 80 }, (_, i) => ({
		comment: `条目${i}标题较长一些`,
		keys: [`k${i}`],
		enabled: true,
	}));
	const line = formatLoreIndex(entries) ?? "";
	assert.ok(line.startsWith("共 80 条："));
	assert.ok(line.includes("未列出"));
	assert.ok(line.length < 700);
	assert.equal(formatLoreIndex([]), undefined);
});

// ---------------- 素材装载 ----------------

test("loadStageMaterials：卡+预设宏求值+postHistory 每拍求值", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mat-"));
	try {
		writeFileSync(
			join(cwd, "card.json"),
			JSON.stringify({ data: { name: "云澜", description: "{{user}}的师姐", first_mes: "你来了。" } }),
		);
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({
				blocks: [
					{ id: "s1", channel: "system", enabled: true, content: "{{setvar::tone::清冷}}文风基调：{{getvar::tone}}。" },
					{ id: "s2", channel: "system", enabled: false, content: "不该出现" },
					{ id: "p1", channel: "postHistory", enabled: true, content: "回应「{{lastusermessage}}」，保持{{getvar::tone}}。" },
				],
				samplers: { temperature: 0.9 },
			}),
		);
		writeFileSync(
			join(cwd, "liyuan.config.json"),
			JSON.stringify({ card: "card.json", preset: "preset.json", userName: "沈舟" }),
		);
		mkdirSync(join(cwd, ".liyuan"), { recursive: true });

		const m = loadStageMaterials(cwd);
		assert.equal(m.card.name, "云澜");
		assert.equal(m.presetActive, true);
		assert.equal(m.splitTable, null, "非内置预设走四类兜底");
		assert.equal(m.presetResidentB.length, 1, "文风类兜底入常驻 B");
		assert.ok(m.presetResidentB[0].includes("文风基调：清冷"), "setvar/getvar 链在 system 块内生效");
		assert.equal(m.macroWarnings.length, 0);
		assert.equal(constantLoreOf(m).length, 0);

		const ph = evalPostHistoryBlocks(m, "我上前行礼。") ?? [];
		assert.equal(ph.length, 1);
		assert.ok(ph[0].content.includes("回应「我上前行礼。」"), "lastusermessage 宏用本拍原文");
		assert.ok(ph[0].content.includes("保持清冷"), "postHistory 继承 system 块变量表");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadStageMaterials：纪律块撤出写作上下文（R7）——system prompt 不见禁词表，规则/纪律单独可取", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-pol-"));
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", first_mes: "你来了。" } }));
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({
				blocks: [
					{ id: "style", channel: "system", enabled: true, content: "文风：冷而克制，短句为主。" },
					{ id: "pol", channel: "system", enabled: true, content: '词汇黑名单 = { "闪过", "一丝" }' },
				],
				samplers: {},
			}),
		);
		writeFileSync(
			join(cwd, "liyuan.config.json"),
			JSON.stringify({ card: "card.json", preset: "preset.json", userName: "沈舟" }),
		);
		mkdirSync(join(cwd, ".liyuan"), { recursive: true });

		const m = loadStageMaterials(cwd);
		assert.equal(m.presetResidentB.length, 1, "常驻 B 只剩文风");
		assert.ok(m.presetResidentB[0].includes("文风"));
		assert.equal(m.presetResidentB.join("").includes("词汇黑名单"), false, "纪律块不进常驻（rules-only）");
		assert.equal(m.presetRuleTexts.length, 2, "规则提取仍看全量");

		const sp = buildStageSystemPrompt({
			card: m.card,
			config: m.config,
			constantLore: [],
			presetResident: {
				aBlocks: m.presetResidentA,
				styleTexts: m.presetResidentB,
				boundaryTexts: m.presetResidentC,
			},
			presetActive: m.presetActive,
			statusBarFormats: m.statusBarFormats,
		});
		assert.ok(sp.includes("文风：冷而克制"), "写作块在场");
		assert.ok(!sp.includes("词汇黑名单"), "纪律细则不进写作上下文");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M4.5 给排练断粮（慢因 A） ----------------

const injOpts = (over: Record<string, unknown> = {}) => ({
	state: defaultState(),
	activatedLore: [],
	card: { name: "云澜" } as never,
	config: { ...DEFAULT_CONFIG, userName: "沈舟" } as RpConfig,
	...over,
});

test("断粮注入：明示思考只用于读题与决定，且点名 harness 已接管事后核查", () => {
	const text = buildStageInjection(injOpts({ rehearsalGuard: true }) as never);
	assert.ok(text.includes("【思考的用法】"), "断粮条目在场");
	assert.ok(/不要在思考里起草|预写/.test(text), "禁止在思考里起草正文");
	assert.ok(/不要在思考里逐条复核|程序化核验/.test(text), "明示验算已归 harness");
	// 位置：必须落在末端【导演备注】里（上下文末尾权重最大）
	assert.ok(text.lastIndexOf("【思考的用法】") > text.lastIndexOf("【世界状态】"), "断粮在导演备注段");
});

test("断粮注入：不点名规划区标签——draft_notes 格式栈已随拆层退场（M-C）", () => {
	const without = buildStageInjection(injOpts({ rehearsalGuard: true }) as never);
	assert.ok(!without.includes("draft_notes"), "任何情况下都不点名格式栈标签（8/02 <user> 块事故同理）");
});

test("断粮注入：默认不注入，显式开启才注入", () => {
	// 默认（无 rehearsalGuard 字段）= 不注入（buildStageInjection 层面；
	// 引擎侧 P14 已改为默认开，config.rehearsalGuard !== false）
	const defaultInj = buildStageInjection(injOpts() as never);
	assert.ok(!defaultInj.includes("【思考的用法】"), "默认不注入");

	// 显式 true 才注入
	const on = buildStageInjection(injOpts({ rehearsalGuard: true }) as never);
	assert.ok(on.includes("【思考的用法】"), "显式开启才注入");
});

test("句级过滤接线：写作块摘掉验算行，规则提取仍看未过滤原文", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-audit-"));
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", description: "师姐" } }));
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({
				name: "p",
				samplers: {},
				blocks: [
					{
						id: "style",
						name: "文风",
						channel: "system",
						role: "system",
						enabled: true,
						// 文风块夹带验算指令：块级判定会整块留下（不是纪律块），句级要摘掉那一行
						content: "<style>\n- 以直接对白为主。\n- 每段写完后自检是否出现禁用句式。\n</style>",
					},
					{
						id: "wc",
						name: "字数",
						channel: "system",
						role: "system",
						enabled: true,
						content: "正文字数 800-1200 字。",
					},
				],
			}),
		);
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", preset: "preset.json" }));

		const m = loadStageMaterials(cwd);
		const writing = m.presetResidentB.join("\n");
		assert.ok(writing.includes("以直接对白为主"), "文风指令留在写作台上");
		assert.ok(!writing.includes("自检"), "验算指令已摘出写作上下文");
		assert.equal(m.auditLinesDropped, 1, "摘行数可观测");

		// 规则提取看的是未过滤原文（字数规则不能因过滤而丢）
		assert.ok(m.presetRuleTexts.join("\n").includes("自检"), "规则提取源保留全文");
		assert.ok(m.presetRuleTexts.join("\n").includes("800-1200"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
