/**
 * 梨园化 router 核心（纯函数，零 pi 依赖）——dsh-router-standard 调用模式移植
 * （docs/DESIGN-router.md，2026-08-16，用户拍板：perTurn 唯一推荐形态、enabled 默认开）。
 *
 * 调用模式：当拍用户消息 → 任务分类（构造 react / 修复 spec / 模糊 weak）→
 * 复杂度判定（isComplexTask）→ 系统区模型分档弱人格（会话内字节稳定，保前缀缓存）
 * + 注入区每拍模式卡（近场动态，零缓存代价）。
 *
 * 双模型分轨：
 * - V4 Pro：目录敏感 → 走 tool-staging.ts 的 Minimal 起步（现状已有，本模块不重复）；
 * - V4 Flash：目录免疫 → 不做 staging，靠 w7 风格弱人格（中性 + classify +
 *   召回/收敛/防 runaway 锚）与深度卡（防过度自信/太浅，P30 实测）。
 *
 * 机制照搬 router-core（净命中多者胜、平局回 weak、复杂度 = 长度或关键词），
 * 词表按 RP 语境重标定（build/fix 词表在剧情语境会全误判，故不照搬原文案）。
 */

// ---------------- 类型 ----------------

export type RouterBand = "spec" | "react" | "weak";
export type RouterTask = "react" | "spec" | "weak";

/** 分类词表（字符串子串匹配，命中计数） */
export interface RouterLexicon {
	build: string[];
	fix: string[];
	complex: string[];
}

/** 一张模式卡（title + body；body 支持 {direction} {flashGuard} 占位符） */
export interface RouterCard {
	key: string;
	title: string;
	body: string;
}

/** 内置分档人格与卡的可覆盖形态（assets/flow/router.json 同构） */
export interface RouterPersonas {
	/** system 区弱人格（perTurn 形态只用这两个） */
	pro: string;
	flash: string;
	/** 强人格（fixed 模式/将来备用） */
	spec: string;
	react: string;
}

// ---------------- 内置词表（RP 语境重标定，可覆盖） ----------------

export const DEFAULT_LEXICON: RouterLexicon = {
	// 构造：推进意图 / 新内容 / 剧情动作（场景规模词归 complex——是复杂度信号不是方向信号）
	build: [
		"推进",
		"继续",
		"接着",
		"继续演",
		"接着演",
		"推进剧情",
		"写下去",
		"往下写",
		"开演",
		"开写",
		"然后写",
		"开始",
		"新场景",
		"新角色",
		"登场",
		"开局",
		"导入",
		"发展",
		"展开",
		"下一幕",
		"高潮",
		"决战",
		"转折",
		"续写",
		"写一段",
		"演",
		"行动",
		"动作",
		"对白",
	],
	// 修复/维护：改上一拍 / 纠偏 / 文风 / 一致性 / 补充丰富
	fix: [
		"修",
		"改稿",
		"重写",
		"重来",
		"不对",
		"错了",
		"别这样",
		"太短",
		"太长",
		"太浅",
		"太水",
		"复读",
		"文风",
		"崩",
		"乱",
		"回退",
		"重新",
		"调整",
		"润色",
		"精简",
		"扩写",
		"重roll",
		"重Roll",
		"撤回",
		"一致性",
		"逻辑",
		"ooc",
		"人设",
		"出戏",
		"状态栏",
		"格式",
		"评审",
		"验收",
		"改一下",
		"改一改",
		"改改",
		"补充",
		"细节",
		"丰富",
		"多写",
		"加一些",
	],
	// 复杂度：多线/大场面/长文本/设定密集（与方向词正交）
	complex: [
		"多线",
		"大场面",
		"群像",
		"多角色",
		"战役",
		"攻城",
		"万字",
		"长文",
		"设定密集",
		"世界书",
		"持续",
		"长篇",
	],
};

// ---------------- 内置人格文案（RP 演出语义；assets/flow/router.json 可覆盖） ----------------

export const DEFAULT_PERSONAS: RouterPersonas = {
	// w6c 风格（Pro 最优：spec 句 + classify 指令，无锚——P24：锚对 Pro 有害）
	pro: [
		"你是一部长篇角色扮演的创作者。",
		"每一拍落笔前，先判定这一拍的任务类型：推进新剧情（直接演）还是修正上一拍（先回看定位再动笔），按类型选择演出节奏。判定不出就按剧情自然推进。",
	].join("\n"),
	// w7 风格（Flash 最优：中性 + classify + 召回/收敛/防 runaway 锚——P23：单任务完成 100%）
	flash: [
		"你是一部长篇角色扮演的创作者。",
		"每一拍落笔前，先判定这一拍的任务类型：推进新剧情（直接演）还是修正上一拍（先回看定位再动笔）。",
		"动手前简短回看本拍已写下的段落，从上次停下的地方继续，不重复已完成的部分。",
		"不要在思考里做地毯式检索（把设定集从头翻到尾）或反复确认已确认的信息；信息够用就落笔，落笔后自然收束。",
	].join("\n"),
	// 强人格（fixed 模式/将来备用，perTurn 形态不注入 system）
	spec: [
		"你是一部长篇角色扮演的创作者，本拍以修正为主：先读题回看刚写下的段落，定位问题所在，",
		"beat_plan 列定点修改计划，确认理解后再用 draft_edit 逐处修改，不推倒重来。文风按 # 文风基准 执行。",
	].join("\n"),
	react: [
		"你是一部长篇角色扮演的创作者，本拍以推进为主：读题 → beat_plan 列路标 → 一段一段 draft_append 直接演。",
		"先落笔再回头补细节，不搞仪式。文风按 # 文风基准 执行。",
	].join("\n"),
};

// ---------------- 内置模式卡（近场指导；assets/flow/router.json 可覆盖） ----------------

export const DEFAULT_CARDS: Record<"build" | "fix" | "deep", RouterCard> = {
	build: {
		key: "router-build",
		title: "【构造拍】",
		body: "本拍是推进型：读题 → beat_plan 列路标 → 一段一段 draft_append 直接演。先落笔再回头补细节，不搞仪式。文风按 # 文风基准 执行。",
	},
	fix: {
		key: "router-fix",
		title: "【修复拍】",
		body: "本拍是修正型：先读题回看刚写下的段落，定位问题（用户指出的 / 验收报告 / 你自己的判断），beat_plan 列定点修改计划，再用 draft_edit 逐处修。确认理解后再动笔，不推倒重来。",
	},
	deep: {
		key: "router-deep",
		title: "【深度拍】",
		body: "本拍信息量大：{direction}。先想清楚本拍的结构与人物状态再落笔。不要在思考上反复确认环境或工具，信息完备就产出；每一段思考以「决定或信息需求」收尾。{flashGuard}",
	},
};

/** 深度卡占位符：任务方向句（构造/修复） */
const DIRECTION_BUILD =
	"按推进节奏演：beat_plan 列路标后一段一段 draft_append，先落笔再回头补细节";
const DIRECTION_FIX =
	"按修正节奏演：先回看定位、列定点计划再 draft_edit，确认理解后再动笔";

/** 深度卡占位符：Flash 防太浅句（8/11 用户反馈：flash 复杂任务过度自信/太浅） */
const FLASH_GUARD =
	"宁可多想一步也不要交浅稿——先深想后收敛，再一段一段演。";

/** 旁路统一收敛尾注（server/main.ts backfillSideText / registerPlannerCaller、engine #sideText 共用） */
export const CONVERGE_TAIL =
	"\n\n信息完备即产出：不要反复确认环境或工具，以决定或信息需求收尾。";

// ---------------- 纯函数 ----------------

/** True when the routed model id is a Flash-family model（梨园 deepseek-v4-flash 命中） */
export function isFlashModel(modelId: string | undefined): boolean {
	return typeof modelId === "string" && /flash/i.test(modelId);
}

/** 命中计数（子串匹配，大小写不敏感；中文无大小写问题，英文词保留小写前缀匹配） */
export function countHits(hints: readonly string[], text: string): number {
	if (!hints || hints.length === 0 || !text) return 0;
	let hits = 0;
	for (const h of hints) {
		if (!h) continue;
		if (text.includes(h)) hits++;
	}
	return hits;
}

/**
 * 任务分类：构造（react）vs 修复（spec）净命中比较。
 * - 净命中明确 → 对应带；
 * - 平局（两边都有命中）→ weak（真模糊，模型自判）；
 * - 无命中 → 长文本（≥40 字，RP 里几乎都是剧情行动/对话 = 构造）→ react；
 *   短文本（寒暄「嗯」「好的」）→ weak（不硬推，靠 system 弱人格自然演）。
 * 兜底方向 = 构造是修复的反面风险考量（DESIGN-router §8.1）：构造误判成修复 = 白回看
 * 一轮（小代价）；修复误判成构造 = 直接演歪要重写（大代价）。
 */
export function classifyTask(text: string | undefined, lex: RouterLexicon = DEFAULT_LEXICON): RouterTask {
	const t = (text ?? "").trim();
	if (!t) return "weak";
	const build = countHits(lex.build, t);
	const fix = countHits(lex.fix, t);
	if (build > fix) return "react";
	if (fix > build) return "spec";
	if (build > 0 && fix > 0) return "weak"; // 平局：真模糊，模型自判
	return t.length >= 40 ? "react" : "weak"; // 无命中：长剧情输入兜底构造，寒暄不强推
}

/** 复杂度：长文本（>120 字）或复杂关键词命中 */
export function isComplexTask(text: string | undefined, lex: RouterLexicon = DEFAULT_LEXICON): boolean {
	const t = (text ?? "").trim();
	if (!t) return false;
	if (t.length > 120) return true;
	return countHits(lex.complex, t) > 0;
}

/** 三带量化（router 原版过渡带 0.2–0.49 不稳定、永不自动选；梨园无 numeric 界面，简化两带） */
export function bandOf(mode: RouterBand | number | "auto" | null | undefined): RouterBand {
	if (mode === "weak" || mode === "auto" || mode === null || mode === undefined) return "weak";
	if (typeof mode === "string") return mode === "spec" ? "spec" : mode === "react" ? "react" : "weak";
	const m = Math.min(1, Math.max(0, Number(mode) || 0));
	return m < 0.2 ? "spec" : "react";
}

/** 解析模式 token（自省/配置用；数字 0-100 或 0.0-1.0 均支持） */
export function parseMode(token: string | undefined): RouterBand | "auto" | null {
	if (token === undefined || token === null) return null;
	const t = String(token).trim().toLowerCase();
	if (t === "auto") return "auto";
	if (t === "weak" || t === "router") return "weak";
	if (t === "spec" || t === "spec-lean") return "spec";
	if (t === "react" || t === "react-lean") return "react";
	const n = Number(t);
	if (!Number.isFinite(n)) return null;
	return bandOf(t.includes(".") ? n : n / 100);
}

/**
 * 取模型分档人格：weak 带按模型（pro/flash），强人格按 band。
 * personas 覆盖（assets/flow/router.json / 配置）优先于内置。
 */
export function personaFor(
	band: RouterBand,
	modelId?: string,
	personas: Partial<RouterPersonas> = {},
): string {
	if (band === "weak") {
		return isFlashModel(modelId) ? (personas.flash ?? DEFAULT_PERSONAS.flash) : (personas.pro ?? DEFAULT_PERSONAS.pro);
	}
	return band === "spec"
		? (personas.spec ?? DEFAULT_PERSONAS.spec)
		: (personas.react ?? DEFAULT_PERSONAS.react);
}

/**
 * 模式卡：weak 无卡（靠 system 弱人格 + 轮次卡自然演）；构造/修复出普通卡；
 * complex 出深度卡（{direction} 按任务方向、{flashGuard} 按模型填充）。
 * cards 覆盖（assets/flow/router.json）优先于内置。
 */
export function cardFor(
	task: RouterTask,
	opts: {
		complex?: boolean;
		modelId?: string;
		cards?: Partial<Record<"build" | "fix" | "deep", RouterCard>>;
	} = {},
): RouterCard | null {
	if (task === "weak") return null;
	const cards = { ...DEFAULT_CARDS, ...(opts.cards ?? {}) };
	if (opts.complex) {
		const deep = cards.deep;
		// flashGuard 恒提供：pro → 空串（占位符必须清掉，不留模板残留）；flash → 防太浅句
		const vars: Record<string, string> = {
			direction: task === "react" ? DIRECTION_BUILD : DIRECTION_FIX,
			flashGuard: isFlashModel(opts.modelId) ? FLASH_GUARD : "",
		};
		return { ...deep, body: deep.body.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? vars[name] : m)) };
	}
	return task === "react" ? cards.build : cards.fix;
}

/**
 * Agent（内置助手/自定义 agent）分档工作姿态（DESIGN-router §P4，2026-08-16）：
 * 与剧情弱人格（personaFor）分开——助手是操作型 agent，不是创作者。
 * Pro → 审题规划型；Flash → 快动作收敛型。文本字节稳定（system 区，不破前缀缓存）。
 */
export function agentPersonaFor(band: RouterBand, modelId?: string): string {
	// 显式 band 优先；weak（调用方未指定分档）时按 modelId 兜底
	const isFlash =
		band === "flash"
			? true
			: band === "pro"
				? false
				: isFlashModel(modelId);
	if (isFlash) {
		return `# 工作姿态（快动作）
你是快动作执行型：分步动手、及时回报。一次只推进一个明确动作（读/改/查/写），工具结果到手就继续下一步，不在思考里反复勘察或重读已确认的信息。信息够用就产出结论。长任务主动拆解、小步交付，避免一次吞太多，不空转。`;
	}
	return `# 工作姿态（审题规划）
你是审题规划型：动手前先看清目标、边界与现状（涉及的剧情资产/配置/外部服务），需要时先读相关数据再动手。一次做一个完整且正确的动作（该验证的验证、该收尾的收尾），产出可靠、可回滚。改动前想清楚影响面，不贸然破坏既有资产。`;
}
