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

test("system prompt：字节稳定、宏替换、主权红线随预设让位", () => {
	const opts = { card, config, constantLore: [], statusBarFormats: ["state1"] };
	const a = buildStageSystemPrompt(opts);
	const b = buildStageSystemPrompt(opts);
	assert.equal(a, b, "同素材两次装配必须逐字节一致");
	assert.ok(a.includes("沈舟的同门师姐"), "{{user}} 宏应替换");
	assert.ok(a.includes("用户主权"), "无预设：harness 兜底纪律在场");
	assert.ok(a.includes("state1"), "状态栏格式线索在场");
	assert.ok(a.includes("一拍演完即停"), "一拍即停是 harness 缺省");

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
	assert.ok(withPreset.indexOf("# 文风与写法") > 0 && withPreset.includes("不要在思考里逐条自查"), "B 节引导语点明纪律归验收器");
	assert.ok(withPreset.includes("不替用户做重大决定。"), "C 类进「行为边界」节");
});

test("system prompt：writing_guide 主题在场才提，空则只字不提（不凭空点名）", () => {
	const opts = { card, config, constantLore: [], statusBarFormats: [] };
	const without = buildStageSystemPrompt(opts);
	assert.ok(!without.includes("writing_guide"), "无 skill 包不点名工具");
	const withSkill = buildStageSystemPrompt({ ...opts, skillTopics: ["general", "nsfw"] });
	assert.ok(withSkill.includes("writing_guide"), "有 skill 包才提");
	assert.ok(withSkill.includes("general / nsfw"), "主题列表写进契约");
	assert.ok(/参考不是验收清单/.test(withSkill), "skill 定位：参考非验收");
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

test("末端注入：wordRange 显式注入目标字数（构成性目标写作时在场，验算归代码）", () => {
	const inj = buildStageInjection({
		state: defaultState(),
		activatedLore: [],
		card,
		config,
		presetActive: true,
		wordRange: { min: 500, max: 800 },
	});
	assert.ok(inj.includes("500–800 字"), "目标字数一行在导演备注");
	assert.ok(inj.includes("验收器核验"), "点明验算归代码");
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

test("断粮注入：默认不注入，显式开启才注入（2026-08-03 high 档实测证伪后默认关）", () => {
	// 默认（无 rehearsalGuard 字段）= 不注入
	const defaultInj = buildStageInjection(injOpts() as never);
	assert.ok(!defaultInj.includes("【思考的用法】"), "默认不注入（证伪后默认关）");

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
