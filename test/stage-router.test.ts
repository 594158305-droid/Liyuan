import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStageSystemPrompt } from "../src/stage/assemble.ts";
import { resolveRouterConfig, loadRouterFile } from "../src/router-config.ts";
import {
	cardFor,
	classifyTask,
	CONVERGE_TAIL,
	isComplexTask,
	personaFor,
} from "../src/router-core.ts";
import { DEFAULT_CONFIG, type RpConfig } from "../src/types.ts";

/**
 * 梨园化 router 集成（docs/DESIGN-router §5 P2）：装配层注入 + 引擎「分类→人格→卡」链路
 * （纯函数模拟 engine #turn 的 router 块）。机制在 src/router-core.ts 已单测，本文件
 * 钉死装配输出与默认配置下的完整链路行为。
 */

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

// ---------------- 装配层：routerPersona ----------------

test("buildStageSystemPrompt：不传 routerPersona → 现状零变化（无 # 演出姿态）", () => {
	const p = buildStageSystemPrompt({ card, config, constantLore: [], statusBarFormats: [] });
	assert.ok(!p.includes("# 演出姿态"), "router 关闭/未启用时不得新增 system 段");
	assert.ok(p.includes("# 舞台"));
});

test("buildStageSystemPrompt：routerPersona 插在 # 舞台 之后、# 你扮演的角色 之前", () => {
	const p = buildStageSystemPrompt({
		card,
		config,
		constantLore: [],
		statusBarFormats: [],
		routerPersona: "每一拍落笔前，先判定这一拍的任务类型。",
	});
	assert.ok(p.includes("# 演出姿态"));
	assert.ok(p.includes("先判定这一拍的任务类型"));
	const stageIdx = p.indexOf("# 舞台");
	const personaIdx = p.indexOf("# 演出姿态");
	const charIdx = p.indexOf("# 你扮演的角色");
	assert.ok(stageIdx >= 0 && personaIdx > stageIdx && charIdx > personaIdx, "顺序：# 舞台 → # 演出姿态 → # 你扮演的角色");
});

// ---------------- 引擎链路模拟（engine #turn router 块） ----------------

/** 模拟 engine #turn 的 router 计算（DESIGN-router §2.2）：perTurn 形态 */
function simulateRouter(opts: {
	enabled: boolean;
	modelId: string;
	lastUserText: string;
	personaMode?: "perTurn" | "fixed" | "off";
}): { persona?: string; card?: string | null } {
	const resolved = resolveRouterConfig(undefined, null);
	const router = { ...resolved, enabled: opts.enabled };
	if (!router.enabled) return { persona: undefined, card: undefined };
	const persona = personaFor("weak", opts.modelId, router.personas);
	const task = classifyTask(opts.lastUserText, router.lexicon);
	const complex = isComplexTask(opts.lastUserText, router.lexicon);
	const c = cardFor(task, { complex, modelId: opts.modelId, cards: router.cards });
	return { persona, card: c ? `${c.title}${c.body}` : undefined };
}

test("链路：pro × 构造拍 → weak-pro 人格 + 构造卡", () => {
	const r = simulateRouter({ enabled: true, modelId: "deepseek-v4-pro", lastUserText: "继续演下去，新角色登场" });
	assert.ok(r.persona?.includes("判定这一拍的任务类型"));
	assert.ok(!r.persona?.includes("地毯式检索"), "pro 无防 runaway 锚");
	assert.ok(r.card?.includes("【构造拍】"));
	assert.ok(r.card?.includes("draft_append"));
});

test("链路：flash × 修复拍 → weak-flash 人格（带锚）+ 修复卡", () => {
	const r = simulateRouter({ enabled: true, modelId: "deepseek-v4-flash", lastUserText: "上一拍文风崩了，重写" });
	assert.ok(r.persona?.includes("信息够用就落笔"), "flash 带收敛/防 runaway 锚");
	assert.ok(r.card?.includes("【修复拍】"));
	assert.ok(r.card?.includes("draft_edit"));
});

test("链路：flash × 复杂修复 → 深度卡含防太浅句", () => {
	const r = simulateRouter({ enabled: true, modelId: "deepseek-v4-flash", lastUserText: "这场战役的群像戏太浅了，重写，设定密集" });
	assert.ok(r.card?.includes("【深度拍】"));
	assert.ok(r.card?.includes("宁可多想一步也不要交浅稿"));
	assert.ok(r.card?.includes("按修正节奏演"));
});

test("链路：模糊拍 → weak 人格 + 无模式卡", () => {
	const r = simulateRouter({ enabled: true, modelId: "deepseek-v4-pro", lastUserText: "嗯" });
	assert.ok(r.persona, "system 弱人格仍在");
	assert.equal(r.card, undefined, "weak 带不给模式卡");
});

test("链路：enabled=false → 无人格无卡（零变化）", () => {
	const r = simulateRouter({ enabled: false, modelId: "deepseek-v4-pro", lastUserText: "继续演" });
	assert.equal(r.persona, undefined);
	assert.equal(r.card, undefined);
});

test("链路：默认配置经 resolveRouterConfig + loadRouterFile 解析（真实 router.json 生效）", () => {
	// 仓库 assets/flow/router.json 存在时，文件覆盖不改变默认链路行为（同构校验）
	const file = loadRouterFile(import.meta.dirname + "/..");
	const resolved = resolveRouterConfig(undefined, file);
	assert.equal(resolved.enabled, true);
	const task = classifyTask("继续推进，展开大场面", resolved.lexicon);
	const c = cardFor(task, { complex: isComplexTask("继续推进，展开大场面", resolved.lexicon), modelId: "deepseek-v4-flash", cards: resolved.cards });
	assert.equal(task, "react");
	assert.ok(c?.body.length > 20);
});

// ---------------- 旁路收敛尾注 ----------------

test("CONVERGE_TAIL：信息完备即产出（旁路统一尾注文案）", () => {
	assert.ok(CONVERGE_TAIL.includes("信息完备即产出"));
	assert.ok(CONVERGE_TAIL.includes("以决定或信息需求收尾"));
});
