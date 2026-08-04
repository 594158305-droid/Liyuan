/**
 * 回合工作区（PLAN-RP-AGENT-EXEC M-A §2.2）——正文成为工件的落点。
 *
 * 一拍一个工作区：模型经 draft_write 交稿、draft_check 验收、world_state_update 记账，
 * harness 只执行与验证，不替模型生成任何内容（控制反转的落地处）。
 *
 * 三条铁律：
 * - draft_write 是唯一交稿入口（宽进严出：直出正文由引擎代为收稿，见 engine #agentLoop）；
 *   已有稿之后的局部修改归 draft_edit（定点补丁，批量原子：任一处定位失败则整批不改）；
 * - world_state_update 只验不改：patch 先在投影账本上干跑，合格才入队，定稿后统一套用；
 * - 工作区只活在引擎单拍内，不跨模块共享（jiti 二象性红线，不触 globalThis）。
 *
 * 纯函数 + 注入依赖，零 pi 依赖、可单测（执行器全部复用 draft.ts / state.ts 现成代码）。
 */

import {
	applyDraftEdits,
	checkDraft,
	checkSovereignty,
	extractDraftBody,
	formatDraftReport,
	searchDraft,
	type DraftEditItem,
	type DraftRules,
} from "../draft.ts";
import { applyPatch, canonicalizeCharacterKeys } from "../state.ts";
import type { WorldState } from "../types.ts";

export interface TurnWorkspace {
	/** 当前稿（draft_write 全量替换语义） */
	draft: string;
	/** 交稿次数（含宽进严出代收；验收统计「思考量 × draft_write 调用数」用） */
	writes: number;
	/** draft_edit 成功套用的次数（M-B KPI：定点改稿是否真替代了全文重交） */
	edits: number;
	/** world_state_update 已验证入队的 patch（定稿后按序统一套用） */
	patches: Record<string, unknown>[];
	/** 最近一次验收是否全绿（谢幕判定用；未验收过 = false） */
	lastGreen: boolean;
	checks: number;
}

export function createWorkspace(): TurnWorkspace {
	return { draft: "", writes: 0, edits: 0, patches: [], lastGreen: false, checks: 0 };
}

export interface WorkspaceDeps {
	rules: DraftRules;
	userName: string;
	charName: string;
	/** 本拍开演前的账本（= f(分支)）；patch 验证在其投影上干跑 */
	baseState: WorldState;
	/**
	 * 预设声明了自定义代言边界（M-C D-C5，如话痨卡「可代写 user 对白」）：
	 * 主权检查降档——放行「代写对白」，保留「代述内心」「代做决定」。
	 */
	relaxSovereignty?: boolean;
}

/** 已入队 patch 依序套在基准账本上的投影——后续 patch 的验证与定稿看到同一个世界 */
export function projectedState(ws: TurnWorkspace, base: WorldState): WorldState {
	let s = base;
	for (const p of ws.patches) s = applyPatch(s, p).state;
	return s;
}

export interface WriteToolResult {
	/** 回给模型的 toolResult 文本 */
	text: string;
	/** 过程条短句（无则不出条） */
	activity?: string;
	/** true = 本次调用是有效交稿/记账（引擎统计与流转用） */
	ok: boolean;
}

/** 验收现稿：报告文本 + 是否全绿（draft_write 收稿后与 draft_check 共用） */
function runCheck(ws: TurnWorkspace, deps: WorkspaceDeps): { text: string; green: boolean } {
	const report = checkDraft(ws.draft, deps.rules);
	let sov = checkSovereignty(ws.draft, deps.userName, deps.charName);
	// D-C5 降档：预设自带 user_boundary（允许代言对白）时不以「代写对白」打回
	if (deps.relaxSovereignty) sov = sov.filter((s) => !s.startsWith("代写对白"));
	ws.checks++;
	const green = report.violations.length === 0 && sov.length === 0;
	ws.lastGreen = green;
	const lines = [formatDraftReport(report)];
	if (sov.length > 0) lines.push(sov.map((s) => `- [主权] ${s}`).join("\n"));
	if (green) lines.push("验收通过：可定稿（停止调用工具即交付此稿），或继续打磨。");
	return { text: lines.join("\n"), green };
}

/**
 * 执行一次写侧工具调用。未知工具/参数缺失都返回可读文本（不抛，不打断本拍）。
 * 读侧三件（lorebook/memory/world_state_get）仍走 tools.ts runStageTool。
 */
export function runWriteTool(
	ws: TurnWorkspace,
	deps: WorkspaceDeps,
	name: string,
	args: Record<string, unknown>,
): WriteToolResult {
	if (name === "draft_write") {
		const content = typeof args.content === "string" ? args.content : "";
		if (!content.trim()) return { text: "content 为空——请提交完整正文。", ok: false };
		ws.draft = content;
		ws.writes++;
		// 收稿即验：省一轮往返（提速 KPI），模型仍可随时显式 draft_check 复验
		const c = runCheck(ws, deps);
		return {
			text: `已收稿（第 ${ws.writes} 稿，${content.length} 字）。验收报告：\n${c.text}`,
			activity: `交稿 ${content.length} 字${c.green ? " · 验收通过" : ""}`,
			ok: true,
		};
	}

	if (name === "draft_check") {
		if (!ws.draft.trim()) return { text: "尚无稿件——先用 draft_write 交稿。", ok: false };
		const c = runCheck(ws, deps);
		return { text: c.text, activity: c.green ? "验收通过" : "验收未过", ok: true };
	}

	if (name === "draft_edit") {
		if (!ws.draft.trim()) return { text: "尚无稿件——先用 draft_write 提交初稿，再定点修改。", ok: false };
		const raw = args.edits;
		if (!Array.isArray(raw) || raw.length === 0) {
			return { text: 'edits 需为非空数组，如 [{"old":"原文","new":"新文"}]。', ok: false };
		}
		const edits = raw as DraftEditItem[];
		const r = applyDraftEdits(ws.draft, edits);
		if (!r.ok || r.text === undefined) {
			// 整批未套用：现稿一字未动，回报每处失败原因供模型修正
			return { text: `改稿未套用：\n${r.details.join("\n")}`, activity: "改稿未套用", ok: false };
		}
		ws.draft = r.text;
		ws.edits++;
		// 改稿即验（与 draft_write 收稿即验同理）：省一轮往返
		const c = runCheck(ws, deps);
		const body = extractDraftBody(ws.draft).replace(/\s+/g, "").length;
		return {
			text: `已改 ${edits.length} 处（正文 ${body} 字）：\n${r.details.join("\n")}\n\n验收报告：\n${c.text}`,
			activity: `定点改稿 ${edits.length} 处${c.green ? " · 验收通过" : ""}`,
			ok: true,
		};
	}

	if (name === "draft_read") {
		if (!ws.draft.trim()) return { text: "工作区还没有稿件——先用 draft_write 提交初稿。", ok: false };
		const body = extractDraftBody(ws.draft).replace(/\s+/g, "").length;
		return {
			text: `当前稿（第 ${ws.writes} 稿，已定点改 ${ws.edits} 次；验收口径正文 ${body} 字）：\n\n${ws.draft}`,
			activity: "读回现稿",
			ok: true,
		};
	}

	if (name === "draft_search") {
		if (!ws.draft.trim()) return { text: "工作区还没有稿件——先用 draft_write 提交初稿。", ok: false };
		const query = typeof args.query === "string" ? args.query.trim() : "";
		if (!query) return { text: "缺少 query 参数。", ok: false };
		const { hits, total } = searchDraft(ws.draft, query);
		if (total === 0) {
			return { text: `现稿中找不到「${query}」。可用 draft_read 通读现稿确认。`, activity: `查现稿「${query}」· 无命中`, ok: true };
		}
		const more = total > hits.length ? `\n（共 ${total} 处，以上仅列前 ${hits.length}）` : "";
		const uniq =
			total > 1 ? `\n\n注意：命中 ${total} 处——draft_edit 的 old 必须唯一，请前后多带一句再引用。` : "";
		return {
			text: `命中 ${total} 处：\n${hits.map((h, i) => `${i + 1}. ${h}`).join("\n")}${more}${uniq}`,
			activity: `查现稿「${query}」· ${total} 处`,
			ok: true,
		};
	}

	if (name === "world_state_update") {
		const raw = args.patch;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return { text: "patch 需为对象（合并补丁语义），例如 {\"location\":\"藏经阁\"}。", ok: false };
		}
		const knownNames = [
			deps.charName,
			deps.userName,
			...Object.keys(projectedState(ws, deps.baseState).characters),
		];
		const patch = canonicalizeCharacterKeys(raw as Record<string, unknown>, knownNames);
		// 只验不改：投影上干跑，合格才入队；真正落账在定稿后（叶守卫下统一套用）
		const dry = applyPatch(projectedState(ws, deps.baseState), patch);
		if (dry.applied.length === 0) {
			const why = dry.warnings.length > 0 ? dry.warnings.join("；") : "补丁未产生任何变更";
			return { text: `记账被拒：${why}。核对字段语义后重试。`, ok: false };
		}
		ws.patches.push(patch);
		const warn = dry.warnings.length > 0 ? `\n警告（相应字段已忽略）：${dry.warnings.join("；")}` : "";
		return {
			text: `已记账（定稿后生效）：\n${dry.applied.map((a) => `- ${a}`).join("\n")}${warn}`,
			activity: `记账 ${dry.applied.length} 项`,
			ok: true,
		};
	}

	return { text: `未知写侧工具 ${name}。`, ok: false };}
