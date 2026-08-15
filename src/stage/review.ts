/**
 * 语义评审（2026-08-14，NeuroBook 借鉴：评审 agent 带 outputSchema + 证据+改法）。
 *
 * 机械验收（checkDraft）只判字面规则——人格/文风一致性程序层零兜底，漂移无人管。
 * 本模块在封笔后由旁路模型做一次独立评审（主演对话外的单轮调用，非自我评审）：
 * 设定一致性 / 人物一致性 / 文风与 AI 味三维，输出结构化问题清单（证据引文 +
 * 可执行改法），major 问题并入修复门禁，主演用 draft_edit 定点修（与机械违规
 * 同一通道、同一修复卡、同一安全阀）。
 *
 * 与 scribe.ts 同构：纯函数 + 注入依赖，零 pi 依赖、可单测。
 */

import { renderStyleBaseline } from "../style-baseline.ts";
import type { StyleBaselineCard } from "../types.ts";

/** 拦推进的问题门槛：major 只拦 major；all 全拦（minor 也拦） */
export type ReviewGate = "major" | "all";

export interface ReviewIssue {
	/** 维度名（设定一致性 / 人物一致性 / 文风与AI味） */
	dimension: string;
	/** major = 拦推进（崩人设/吃设定/明显 AI 味）；minor = 提示不拦 */
	severity: "major" | "minor";
	/** 现稿中的原文（逐字引用，供 draft_edit 定位） */
	evidence: string;
	/** 问题描述（一句话说清哪里不对） */
	problem: string;
	/** 可执行改法（改成什么方向，可直接照着改） */
	suggestion: string;
}

export interface ReviewReport {
	issues: ReviewIssue[];
}

export interface ReviewPromptInput {
	/** 现稿全文 */
	draft: string;
	/** 角色卡 personality（可为空） */
	persona: string;
	/** 预设 A 层原文（人格/身份契约，常驻原文） */
	presetA: string[];
	/** 文风卡（DESIGN-style-baseline）：文风维度的唯一对照基准；缺省回退 styleTexts 原文 */
	styleBaseline?: StyleBaselineCard;
	/** 预设 B 层文风（仅当 styleBaseline 未提供时作为文风基准） */
	styleTexts?: string[];
	/** 世界状态（formatState 后的文本） */
	worldState: string;
	language: string;
}

const REVIEW_DIMENSIONS = `- 设定一致性：与基准设定/世界状态冲突（吃设定：地点、时间、物品归属、人物关系记错）
- 人物一致性：人物行为、语气、性格与角色设定不符（崩人设），或对白不符合该角色的说话方式
- 文风一致性：现稿读起来是否像【文风基准】里的那个声音（叙述姿态、句子节奏、用词倾向）；跑出反例原型（分镜腔 / 散文腔 / 流水账腔）即按严重度报问题`;

export function buildReviewPrompt(input: ReviewPromptInput): { systemPrompt: string; userText: string } {
	const { draft, persona, presetA, styleBaseline, styleTexts, worldState, language } = input;
	const personaBlock = [persona, ...presetA].filter((s) => s && s.trim()).join("\n\n");
	const styleBlock = styleBaseline
		? renderStyleBaseline(styleBaseline)
		: (styleTexts ?? []).filter((s) => s && s.trim()).join("\n\n");

	const systemPrompt = `你是一场${language}角色扮演的独立评审。阅读【人设与文风基准】【世界状态】【现稿】，检查现稿是否有以下三类问题：

${REVIEW_DIMENSIONS}

只输出一个 JSON 对象，字段唯一：
"issues"：问题数组，元素结构：
{ "dimension": "维度名", "severity": "major 或 minor", "evidence": "现稿原文逐字引用（供定点修改定位，须唯一）", "problem": "问题描述（一句话说清哪里不对）", "suggestion": "可执行改法（改成什么方向，可直接照着改）" }

规则：
- 宁漏勿误：拿不准的不报——误报会把主演拖进无谓修改，浪费一次修复循环；
- severity 判定：major 只留给真正破坏体验的问题（明显吃设定、明显崩人设、整段 AI 味）；轻微倾向一律 minor；
- 每条必须给 evidence（现稿逐字原文，找不到原文的不要报）与 suggestion（可执行改法）；
- 没有问题时 "issues" 为 []。

只输出 JSON 对象，不要输出任何其他文字。`;

	const material = [
		personaBlock && `【人设与文风基准】\n${personaBlock}`,
		styleBlock && `【文风基准】\n${styleBlock}`,
		`【世界状态】\n${worldState}`,
	].filter(Boolean);
	const parts = [material.join("\n\n"), `【现稿】\n${draft}`, "请按系统指令评审，输出 JSON。"];
	return { systemPrompt, userText: parts.join("\n\n") };
}

/**
 * 宽容解析评审输出：剥代码围栏后，逐个「{」为起点试切（与 parseScribeResult 同款——
 * 模型常在最前写一句前言，前言里的孤「{」会让按首 { 切分从错位开始）。
 * 只收 evidence/problem 齐全的问题（缺证据的不要——修不了）；解析失败返回 null。
 */
export function parseReviewResult(text: string): ReviewReport | null {
	let t = text.trim();
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) t = fence[1].trim();
	let idx = 0;
	while (true) {
		const start = t.indexOf("{", idx);
		if (start === -1) break;
		// 从候选起点向后找平衡的右括号（跳过字符串里的「}」）
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		for (let i = start; i < t.length; i++) {
			const ch = t[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) break;
		try {
			const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
			if (obj && typeof obj === "object" && !Array.isArray(obj) && Array.isArray(obj.issues)) {
				const issues: ReviewIssue[] = [];
				for (const raw of obj.issues) {
					if (!raw || typeof raw !== "object") continue;
					const it = raw as Record<string, unknown>;
					const dimension = typeof it.dimension === "string" ? it.dimension.trim() : "";
					const severity = it.severity === "minor" ? "minor" : "major";
					const evidence = typeof it.evidence === "string" ? it.evidence.trim() : "";
					const problem = typeof it.problem === "string" ? it.problem.trim() : "";
					const suggestion = typeof it.suggestion === "string" ? it.suggestion.trim() : "";
					if (!dimension || !evidence || !problem) continue; // 缺证据/缺描述的不收
					issues.push({ dimension, severity, evidence, problem, suggestion });
				}
				return { issues };
			}
		} catch {
			// 本候选不成（前言里的孤 {），试下一个
		}
		idx = start + 1;
	}
	return null;
}

/** pendingViolations 里评审项的前缀（修复卡/门禁/安全阀据此识别与继承） */
export const REVIEW_PREFIX = "[评审·";

/** 评审项 → 拦推进的违规串（证据截断防爆修复卡；问题与改法保留全文） */
export function formatReviewViolation(issue: ReviewIssue, maxEvidence = 40): string {
	const ev = issue.evidence.length > maxEvidence ? issue.evidence.slice(0, maxEvidence) : issue.evidence;
	const fix = issue.suggestion ? `；改法：${issue.suggestion}` : "";
	return `[评审·${issue.dimension}] ${issue.problem}（证据：「${ev}」${fix}）`;
}

/**
 * 从评审违规串里提取证据引文（formatReviewViolation 的反向）。
 * 修复感知（runCheck 继承评审项时）用它核对「引文还在不在现稿里」——
 * draft_edit 定点改动了该处（或附近）即视为已修；提取不到保守保留。
 */
export function reviewEvidenceOf(violation: string): string | null {
	const m = /证据：「([^」]*)」/.exec(violation);
	return m ? m[1] : null;
}

/** 评审报告 → 回喂主演的文本（seal / draft_review 的 toolResult 追加段） */
export function formatReviewReport(report: ReviewReport, gate: ReviewGate): string {
	if (report.issues.length === 0) return "【语义评审】通过：未发现设定/人物/文风问题。";
	const blocking = gate === "all" ? report.issues : report.issues.filter((i) => i.severity === "major");
	const minor = report.issues.filter((i) => i.severity !== "major");
	const lines: string[] = [];
	if (blocking.length > 0) {
		lines.push(`【语义评审】发现 ${blocking.length} 处需处理（评审视角：设定/人物/文风一致性）：`);
		blocking.forEach((i, idx) => lines.push(`${idx + 1}. ${formatReviewViolation(i)}`));
		lines.push("逐处用 draft_edit 定点替换修正（old 引用现稿原文、须唯一）——不要重交全文；改完会自动复验。");
	}
	if (minor.length > 0) {
		const minorLines = minor.map((i) => `- ${formatReviewViolation(i, 60)}`).join("\n");
		lines.push(`（另有 ${minor.length} 处轻微提示，可选修，不拦推进：\n${minorLines}）`);
	}
	return lines.join("\n");
}
