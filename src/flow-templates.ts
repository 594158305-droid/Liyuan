/**
 * 流程提示词模板（DESIGN-flow-config §2）：主聊天的轮次卡文案外置。
 *
 * 数据源优先级：assets/flow/round-cards.json（正式数据源，随发布包分发）
 * → 本文件 DEFAULT_ROUND_CARDS（内嵌默认，文件缺失/损坏时兜底，内容须与 JSON 逐字一致，
 *    test/flow-templates.test.ts 有逐字比对兜底）→ liyuan.config.json 的 flowTemplates
 *    按 key 同名覆盖（只改不删：覆盖缺了某张卡时用内嵌默认补回，保证流程信号不缺）。
 *
 * 占位符 {name} 由引擎按工作区状态填充（见 engine.ts roundCardFor）：
 *   {userName} {wordRangeHint} {wordRangeMin} {wordRangeMax} {violations} {violationsCount}
 *   {statusBarTail} {appendsCount} {draftBodyChars}
 * 未知/缺失占位符保留原样（宁可露馅不丢上下文）。
 *
 * 纯函数 + 常量表，零模块级可变状态（jiti 二象性红线）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowTemplateConfig } from "./types.ts";

/** 一张轮次卡：key 是程序判定键（plan/open/fix/curtain/review/extend/seal），title 含【】卡名 */
export interface RoundCardTemplate {
	key: string;
	/** 卡名（含【】）：渲染前缀 + 引擎替换语义的匹配前缀 */
	title: string;
	/** 模板正文；占位符 {name} 由 renderRoundCard 填充 */
	body: string;
}

/** 内置默认轮次卡（assets/flow/round-cards.json 的兜底镜像——改文案必须两处同步） */
export const DEFAULT_ROUND_CARDS: RoundCardTemplate[] = [
	{
		key: "plan",
		title: "【第 1 步·规划】",
		body:
			"你还没有落笔、也还没有计划。这一轮思考只做三件事：读题（谁在场、上文到哪、用户要什么）、探索（拿不准就查设定/记忆/账本）、列路标（`beat_plan`）{wordRangeHint}。`beat_plan` 被接受前，不要落任何正文。预设的文风与行为边界从落笔起生效，这一轮不用逐条读。\n" +
			"用户输入本身在求方向/递笔的（「接下来去找谁」「给个选项」）——直接 `ask`，那不需要上文。读题发现的**未定型重大变量**（如新人物还没定的性格/立场）——不要脑补定型：记着它，演到它实际影响剧情的段落之前再 `ask` 请用户定（那时用户手里有上文才好选；哪些变量值得问是动态的，看它此刻对剧情的影响程度，不是新的就要问）。\n" +
			"**路标只写到「发生什么」的抽象层**（如「被值守弟子拦下」「褪衣取砚」）——具体怎么演（动作的先后、神态的变化、对白的语气、情绪的流转）留给演到那一段时再想，不要在这一轮预演各段的细节。\n" +
			"思考全程用中文，与正文同语言。",
	},
	{
		key: "open",
		title: "【开工】",
		body:
			"计划已接受。从现在起进入演出：按第一条未完成的演，一段一段交（`draft_append`，一个自然段就交）。正文只在稿纸上诞生。文风按系统 `# 文风基准` 执行。思考全程用中文，与正文同语言。",
	},
	{
		key: "fix",
		title: "【修复】",
		body:
			"上一段还有 {violationsCount} 处未修：\n{violations}\n先用 `draft_edit` 逐处修掉（old 逐字引用现稿原文、须唯一，可一次给多处），验收过了再构思下一段——已经交给用户看的段落必须是定稿。\n思考全程用中文。",
	},
	{
		key: "curtain",
		title: "【谢幕】",
		body: "已封笔，不要再写正文。世界有变动就先 `world_state_update` 记账；{statusBarTail}。",
	},
	{
		key: "review",
		title: "【演段回看】",
		body:
			"已演 {appendsCount} 段。你需要在落笔前完成这一轮的工作：\n" +
			"① 回看：读一遍刚写下的段落，从上一拍结尾处直接继续，禁止重新铺陈环境——接住它的气口。\n" +
			"② 构思剧情走向：思考这一段剧情往哪走、人物此刻的状态与下一步的抉择。\n" +
			"③ 按 `# 文风基准` 构思这一段怎么演：这段发生什么、落在哪个画面 / 动作 / 对白上。\n" +
			"④ 按需调写作方法论：按预设「写作·技能触发表」查本拍场景该读的主题，调 `writing_guide` 读对应主题，读完照着写。\n" +
			"⑤ 重新评估：剧情到岔路就用 `ask` 问用户；路标不成立就重拟 `beat_plan`；戏到停点就收笔——收笔前先确认自然下文是否涉及 {userName} 的行动或选择，涉及就先 `ask`，再 `draft_seal`（清单没勾完也没关系）。\n" +
			"思考全程用中文。正文只在稿纸上写——思考里想戏，落笔交给 `draft_append`。",
	},
	{
		key: "extend",
		title: "【续写】",
		body:
			"路标已全部演完，但本拍正文还没到目标（当前约 {draftBodyChars} 字 / 目标 {wordRangeMin}–{wordRangeMax} 字）。承接刚写下的，续写这一拍的自然下文——设定/世界书里的下一步（如「润墨之后的试墨」）。一段一段演。\n" +
			"续写中涉及 {userName} 的行动或选择，用 `ask` 停下来问；写到字数达标、戏到停点，用 `draft_seal` 收笔。状态栏等格式块是本拍**最后**的产出——续写全部完成之前不要输出。思考全程用中文。",
	},
	{
		key: "seal",
		title: "【收笔评估】",
		body:
			"路标已全部演完，戏到了一个停点。按顺序评估，评估完再动手：\n" +
			"① 这一拍的自然下文是否涉及 {userName} 的行动或选择（如「润墨之后该试墨」）——涉及就先用 `ask` 问用户、按答案续写，此时不要收笔；\n" +
			"② 不涉及，再看剧情是否停在 {userName} 可以接话、可以行动的位置——不在就续写到停点；\n" +
			"③ 以上都满足，`draft_seal` 收笔；\n" +
			"④ 封笔之后最后一步：输出状态栏等格式块——状态栏意味着本拍结束，必须是这拍的最后产出（续写/ask 全部完成之前不要输出）。\n" +
			"思考全程用中文。",
	},
];

/** 轮次卡渲染变量（引擎按工作区状态生成） */
export type RoundCardVars = Record<string, string>;

/** 占位符填充：{name} → 值；变量缺失保留占位符原样（宁可露馅不丢上下文） */
export function fillTemplate(body: string, vars: RoundCardVars): string {
	return body.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? vars[name] : m));
}

/** 渲染一张轮次卡：title + 填充后的正文 */
export function renderRoundCard(t: RoundCardTemplate, vars: RoundCardVars): string {
	return `${t.title}${fillTemplate(t.body, vars)}`;
}

/** 规划卡的「本拍字数」提示句（有字数区间才注入——{wordRangeHint} 占位符的默认填充） */
export function wordRangeHintOf(min: number, max: number): string {
	return `，本拍总字数约 ${min}–${max} 字，列路标时把字数分配到每一步（几步就分几份，心里有数）`;
}

/** 取指定 key 的卡名列表（引擎替换语义的前缀匹配用；key 缺失时给空串不参与匹配） */
export function titlesOf(templates: RoundCardTemplate[], keys: string[]): string[] {
	const byKey = new Map(templates.map((t) => [t.key, t]));
	return keys.map((k) => byKey.get(k)?.title ?? "");
}

/** 从 JSON 校验模板数组；结构非法返回 null（调用方回退默认） */
export function normalizeRoundCards(raw: unknown): RoundCardTemplate[] | null {
	if (!raw || typeof raw !== "object") return null;
	const arr = (raw as { cards?: unknown }).cards;
	if (!Array.isArray(arr)) return null;
	const out: RoundCardTemplate[] = [];
	for (const item of arr) {
		if (!item || typeof item !== "object") return null;
		const { key, title, body } = item as Record<string, unknown>;
		if (typeof key !== "string" || typeof title !== "string" || typeof body !== "string") return null;
		if (!key || !title) return null;
		out.push({ key, title, body });
	}
	return out.length > 0 ? out : null;
}

/** 读 assets/flow/round-cards.json（cwd 相对仓库根）；缺失/损坏返回 null（调用方回退内嵌默认） */
export function loadRoundCardsFile(cwd: string): RoundCardTemplate[] | null {
	try {
		const p = join(cwd, "assets", "flow", "round-cards.json");
		if (!existsSync(p)) return null;
		return normalizeRoundCards(JSON.parse(readFileSync(p, "utf8")));
	} catch {
		return null;
	}
}

/**
 * 合并覆盖：配置的 flowTemplates 按 key 替换内置模板；配置删掉的 key 用内置补回
 * （流程信号不缺——引擎按 7 个固定 key 出卡，只改不删）。返回内置顺序的完整模板表。
 */
export function resolveRoundCardTemplates(
	builtin: RoundCardTemplate[],
	overrides?: FlowTemplateConfig[],
): RoundCardTemplate[] {
	const map = new Map(builtin.map((t) => [t.key, t]));
	if (Array.isArray(overrides)) {
		for (const o of overrides) {
			if (o && typeof o === "object" && typeof o.key === "string" && typeof o.title === "string" && typeof o.body === "string") {
				map.set(o.key, { key: o.key, title: o.title, body: o.body });
			}
		}
	}
	return builtin.map((t) => map.get(t.key) ?? t);
}
