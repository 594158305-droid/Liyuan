/**
 * 精修阶段（PLAN-RP-HARNESS M2，R7 阶段供料）。
 *
 * 初稿只见写作素材；纪律块（禁词表/句式禁令/比喻原则）与核验报告在这里
 * 才与模型见面——目标单一：按报告定点替换，不重写、不改剧情。
 * 输出协议：{"edits":[{"old","new"} | {"append"}]}，由 harness 校验并落 rp-draft-op。
 *
 * 纯函数、零 pi 依赖、可单测。
 */

import type { AnyDraftOp } from "../draft.ts";

export interface RevisePromptInput {
	draftText: string;
	/** 核验违规清单（checkDraft violations + 主权红线，已带原文引用） */
	violations: string[];
	/** 成文纪律块全文（isPoliceBlock 滤出；写作阶段刻意不在场的细则） */
	policeTexts: string[];
	charName: string;
	userName: string;
	language: string;
}

export interface RevisePrompt {
	systemPrompt: string;
	userText: string;
}

export function buildRevisePrompt(input: RevisePromptInput): RevisePrompt {
	const { draftText, violations, policeTexts, charName, userName, language } = input;

	const systemPrompt = `你是这份角色扮演剧情稿的精修编辑（稿件的叙述者是${charName}，${userName} 是用户扮演的角色）。任务：按核验报告与成文纪律，对稿件做**定点替换**，绝不重写全文。

规则：
- 只修核验报告点名的问题，以及成文纪律明确禁止的表达；其余文字一个字都不动。
- 每处修改输出一条 {"old":"原文","new":"替换后"}：old 必须逐字引用原稿（含标点与空白）且在原稿中唯一——引用不唯一时扩大引用范围。改动尽量小而准，禁止顺手润色。
- 核验报告说缺整块模块（如状态栏）时，输出 {"append":"完整模块文本"}（将追加到稿末）。
- 不改剧情走向、不加新情节、不替 ${userName} 增写任何言行；替换后的文字保持${language}与原稿文风，读起来须与上下文无缝。
- 只输出一个 JSON 对象：{"edits":[…]}，不要输出任何其他文字或解释。没有可修的就输出 {"edits":[]}。`;

	const parts: string[] = [`【当前稿】\n${draftText}`];
	parts.push(`【核验报告】\n${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}`);
	if (policeTexts.length > 0) {
		parts.push(`【成文纪律】（修订以此为准；写作阶段未提供，现在逐条对照）\n${policeTexts.join("\n\n")}`);
	}
	parts.push(`请输出 {"edits":[…]}。`);

	return { systemPrompt, userText: parts.join("\n\n") };
}

/** 单轮精修最多接受的补丁数（防失控） */
export const MAX_EDITS_PER_ROUND = 16;

/**
 * 模型回复 → 补丁列表。容忍代码围栏与前后杂文（提取首个含 "edits" 的 JSON 对象）；
 * 不合法条目逐条丢弃；超上限截断。解析不出返回 []。
 */
export function parseReviseEdits(text: string): AnyDraftOp[] {
	if (!text) return [];
	const candidates: string[] = [];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
	let fm: RegExpExecArray | null = fenced.exec(text);
	while (fm) {
		candidates.push(fm[1]);
		fm = fenced.exec(text);
	}
	candidates.push(text);
	// 整段不是纯 JSON 时，退回「首个 { 到最后一个 }」的粗提取
	const braceSpan = /\{[\s\S]*\}/.exec(text);
	if (braceSpan) candidates.push(braceSpan[0]);

	for (const c of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(c.trim());
		} catch {
			continue;
		}
		const edits = (parsed as { edits?: unknown })?.edits;
		if (!Array.isArray(edits)) continue;
		const out: AnyDraftOp[] = [];
		for (const e of edits) {
			if (!e || typeof e !== "object") continue;
			const o = e as { old?: unknown; new?: unknown; append?: unknown };
			if (typeof o.old === "string" && o.old.length > 0 && typeof o.new === "string") {
				out.push({ old: o.old, new: o.new });
			} else if (typeof o.append === "string" && o.append.trim().length > 0) {
				out.push({ append: o.append });
			}
			if (out.length >= MAX_EDITS_PER_ROUND) break;
		}
		return out;
	}
	return [];
}
