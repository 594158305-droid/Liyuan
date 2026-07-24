import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadCardFile } from "../src/card.ts";
import {
	buildSystemPrompt,
	buildTurnInjection,
	detectsLanguageMismatch,
	userSeeksDirection,
} from "../src/director.ts";
import { defaultState } from "../src/state.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const card = loadCardFile(fileURLToPath(new URL("../assets/cards/default_Qingwu.json", import.meta.url)));

test("system prompt 含角色/纪律/主入口分流/工具分工/语言指令且宏已替换", () => {
	const sp = buildSystemPrompt({ card, config: DEFAULT_CONFIG, constantLore: [] });
	assert.ok(sp.includes("青梧"));
	assert.ok(sp.includes("主入口与分流"), "应有语义分流说明（2026-07-18 合流）");
	assert.ok(sp.includes("assistant_run"), "系统事务走委托助手工具");
	assert.ok(!sp.includes("双重职责"), "戏内/戏外双姿态已退役");
	assert.ok(!sp.includes("戏外"), "不再有戏外通道措辞");
	assert.ok(sp.includes("语义判断"), "分流靠意图而非标记");
	assert.ok(sp.includes("剧情 / 共创") || sp.includes("剧情/共创") || sp.includes("ask_director"), "剧情路径仍在");
	assert.ok(sp.includes("预设只服务剧情") || sp.includes("不走预设"), "预设仅剧情生成");
	assert.ok(sp.includes("800") || sp.includes("1500") || sp.includes("预设"), "篇幅以预设或 harness 缺省为准");
	assert.ok(!sp.includes("篇幅 2–4 段"), "旧短篇幅指令应移除");
	assert.ok(sp.includes("world_state_update"), "记账工具已还给主演（F3 §6.3）");
	assert.ok(sp.includes("lorebook_write"), "补充设定集工具应在剧情工具清单（F3-3）");
	assert.ok(sp.includes("panel_write"), "自建面板工具应在剧情工具清单（Phase4 柱 2）");
	assert.ok(sp.includes("bash") || sp.includes("本机只读"), "backendControl 默认开，应说明本机工具纪律");
	assert.ok(!sp.includes("skill_save"), "技能沉淀已迁助手，剧情侧只留使用权");
	assert.ok(!sp.includes("/api/command"), "自操作接口已整体退役（移交助手工具面）");
	assert.ok(!sp.includes("舞台监督") && !sp.includes("幕后"), "命名纪律：不用戏剧隐喻词（模型会跟着自称）");
	assert.ok(sp.includes("中文"));
	assert.ok(sp.includes("台侧过程") || sp.includes("RP agent"), "应有过程 RP 化纪律");
	assert.ok(sp.includes("可见短句") || sp.includes("短旁白") || sp.includes("1～3"), "应要求工具前可见旁白");
	assert.ok(!sp.includes("{{char}}"), "宏应已替换");
	assert.ok(!sp.includes("{{user}}"), "宏应已替换");
	// 状态栏：默认无卡格式线索时勿禁止 StatusBlock、也勿硬造
	assert.ok(!sp.includes("不要**在正文里写 `<StatusBlock>`") && !sp.includes("不要在正文里写 `<StatusBlock>`"), "不得禁止卡状态栏");
	assert.ok(sp.includes("状态栏是扮演的一部分") || sp.includes("扮演的一部分"), "状态栏应明确为扮演的一部分");
});

test("卡有状态栏格式时 system 与末端要求必出状态栏（与预设无关）", () => {
	const formats = ["`<StatusBlock>…</StatusBlock>`", "`<state1>…</state1>`（或卡约定的 state 序号）"];
	const sp = buildSystemPrompt({
		card,
		config: DEFAULT_CONFIG,
		constantLore: [],
		statusBarFormats: formats,
	});
	assert.ok(sp.includes("本卡定义了状态栏"));
	assert.ok(sp.includes("必须输出状态栏"));
	assert.ok(sp.includes("StatusBlock") || sp.includes("state1"));
	const inj = buildTurnInjection({
		state: defaultState(),
		activatedLore: [],
		card,
		config: DEFAULT_CONFIG,
		statusBarFormats: formats,
		applyStoryPreset: true,
	});
	assert.ok(inj.includes("状态栏是本卡扮演的一部分") || inj.includes("漏写状态栏"));
	assert.ok(!inj.includes("StatusBlock 不计字") || inj.includes("必须输出状态栏") || inj.includes("扮演的一部分"));
});

test("system prompt：backendControl 关闭时不出现通用工具段与技能库", () => {
	const sp = buildSystemPrompt({ card, config: { ...DEFAULT_CONFIG, backendControl: false }, constantLore: [] });
	assert.ok(!sp.includes("bash"), "关闭后不应提及通用工具");
	assert.ok(sp.includes("world_state_update"), "剧情工具不受开关影响");
	assert.ok(!sp.includes("技能清单"), "技能库依赖 read，关闭后不注入");
});

test("末端注入：预设末端指令恒注入（双姿态已退役，无戏外跳过）", () => {
	const base = { state: defaultState(), activatedLore: [], card, config: DEFAULT_CONFIG };
	const withPreset = buildTurnInjection({
		...base,
		presetPostHistoryBlocks: [
			{ id: "x", name: "x", channel: "postHistory" as const, role: "system" as const, content: "预设指令内容", enabled: true },
		],
	});
	assert.ok(withPreset.includes("预设指令内容"), "预设末端指令应注入");
	assert.ok(withPreset.includes("【导演备注】"), "末端导演备注恒在");
	assert.ok(withPreset.includes("assistant_run"), "系统事务指引应钉到 assistant_run");
	assert.ok(withPreset.includes("台侧过程") || withPreset.includes("可见短旁白"), "末端应钉过程 RP 旁白");
	assert.ok(!withPreset.includes("戏外"), "不再有戏外措辞");
});

test("末端注入：applyStoryPreset=false 时不注入预设 postHistory", () => {
	const base = { state: defaultState(), activatedLore: [], card, config: DEFAULT_CONFIG };
	const off = buildTurnInjection({
		...base,
		applyStoryPreset: false,
		presetPostHistoryBlocks: [
			{ id: "x", name: "x", channel: "postHistory" as const, role: "system" as const, content: "正文必须超过1000字", enabled: true },
		],
	});
	assert.ok(!off.includes("正文必须超过1000字"), "非剧情不走预设字数模板");
	assert.ok(off.includes("本轮不走预设"), "应明示本轮跳过预设");
});

test("末端注入：连续性审查已关闭，auditWarnings 不注入", () => {
	const base = { state: defaultState(), activatedLore: [], card, config: DEFAULT_CONFIG };
	const withWarn = buildTurnInjection({ ...base, auditWarnings: ["正文说怀表在她手中 vs 账本记录阿远持有"] });
	assert.ok(!withWarn.includes("连续性提醒"));
	assert.ok(!withWarn.includes("怀表"));
});

test("末端注入：语言与硬边界纪律恒在", () => {
	const text = buildTurnInjection({ state: defaultState(), activatedLore: [], card, config: DEFAULT_CONFIG });
	assert.ok(!text.includes("【剧情记忆】"));
	assert.ok(text.includes("中文"));
	assert.ok(text.includes("旅人"));
	assert.ok(text.includes("【世界状态】"));
	assert.ok(text.includes("不得与之矛盾"), "状态注入应为硬约束措辞");
});

test("末端注入：memoryHits 出【剧情记忆】", () => {
	const text = buildTurnInjection({
		state: defaultState(),
		activatedLore: [],
		card,
		config: DEFAULT_CONFIG,
		memoryHits: [{ text: "主角曾在圣魂村约定三年后再见", score: 0.8, source: "正文剧情" }],
	});
	assert.ok(text.includes("【剧情记忆】"));
	assert.ok(text.includes("圣魂村"));
	assert.ok(text.includes("正文剧情"));
});

test("末端注入：语言失配时出现纠正提醒", () => {
	const base = { state: defaultState(), activatedLore: [], card, config: DEFAULT_CONFIG };
	assert.ok(buildTurnInjection({ ...base, languageMismatch: true }).includes("错误的语言"));
	assert.ok(!buildTurnInjection({ ...base, languageMismatch: false }).includes("错误的语言"));
});

test("末端注入：活跃面板速览随 panelIndex 出现，缺省不出现", () => {
	const base = { state: defaultState(), activatedLore: [], card, config: DEFAULT_CONFIG };
	const withPanels = buildTurnInjection({ ...base, panelIndex: "地图(svg)、装备库(markdown)" });
	assert.ok(withPanels.includes("【活跃面板】地图(svg)、装备库(markdown)"));
	assert.ok(withPanels.includes("panel_write"), "速览应附更新提醒");
	assert.ok(!buildTurnInjection(base).includes("【活跃面板】"), "无面板不出现");
});

test("末端注入：面板快照（### 标题）走当前内容措辞", () => {
	const base = { state: defaultState(), activatedLore: [], card, config: DEFAULT_CONFIG };
	const snap = buildTurnInjection({
		...base,
		panelIndex: "### 角色仓库（markdown）\n- 好感 9",
	});
	assert.ok(snap.includes("【活跃面板·当前内容】"));
	assert.ok(snap.includes("好感 9"));
	assert.ok(snap.includes("手改") || snap.includes("panel_read"));
});

test("末端注入：决策门禁提醒仅 ask 档出现", () => {
	const askConfig = { ...DEFAULT_CONFIG, creationMode: "ask" as const };
	const base = { state: defaultState(), activatedLore: [], card, config: askConfig };
	assert.ok(buildTurnInjection(base).includes("ask_director"), "ask 档每轮末端应有门禁提醒");
	assert.ok(
		!buildTurnInjection({ ...base, config: DEFAULT_CONFIG }).includes("ask_director"),
		"silent 档（缺省）不提醒",
	);
});

test("求方向检测与末端强制 ask_director", () => {
	assert.ok(userSeeksDirection("我该做什么？"));
	assert.ok(userSeeksDirection("文舒婉跪着……我该怎么做"));
	assert.ok(userSeeksDirection("开始生成身份"));
	assert.ok(userSeeksDirection("帮我生成人设"));
	assert.ok(userSeeksDirection("建档"));
	assert.ok(!userSeeksDirection("我伸手接过砚台。"));
	assert.ok(!userSeeksDirection("他的身份是过路商人。"), "叙事里顺带提身份不应强制");
	const askConfig = { ...DEFAULT_CONFIG, creationMode: "ask" as const };
	const force = buildTurnInjection({
		state: defaultState(),
		activatedLore: [],
		card,
		config: askConfig,
		userText: "我该做什么",
	});
	assert.ok(force.includes("强制"), "求方向应升格强制调用");
	assert.ok(force.includes("ask_director"));
	const idForce = buildTurnInjection({
		state: defaultState(),
		activatedLore: [],
		card,
		config: askConfig,
		userText: "开始生成身份",
	});
	assert.ok(idForce.includes("强制"), "生成身份应升格强制调用");
	assert.ok(idForce.includes("身份") || idForce.includes("人设"), "身份强制文案应点明场景");
	assert.ok(idForce.includes("ask_director"));
});

test("语言失配检测：英文正文报警，中文正文与短文本不报", () => {
	const en =
		"*Qingwu sets the teacup down and studies your rain-soaked figure for a moment, her voice calm and clear beneath the steady sound of rain on the roof tiles.*";
	const zh = "*青梧放下茶盏，目光在你被雨水浸透的肩头停了一瞬。她的声音不高，混在瓦上的雨声里，却平静而清晰。*";
	const mixed = "*Qingwu 轻轻点头。*「你醒了，旅人。这里是栖水镇的听雨轩——你已经安全了，好好休息。」";
	assert.equal(detectsLanguageMismatch(en, "中文"), true, "英文正文应报警");
	assert.equal(detectsLanguageMismatch(zh, "中文"), false, "中文正文不应报警");
	assert.equal(detectsLanguageMismatch(mixed, "中文"), false, "夹杂专有名词的中文不应报警");
	assert.equal(detectsLanguageMismatch("Okay.", "中文"), false, "短文本不判定");
	assert.equal(detectsLanguageMismatch(en, "English"), false, "非中文目标 v0 不检测");
});
