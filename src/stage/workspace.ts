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
	/** 当前稿（draft_write 全量替换语义；draft_append 追加语义） */
	draft: string;
	/**
	 * 已封笔（M-E）：正文写完了，可以按完整稿验收。
	 *
	 * 分段续写下「稿子存在」不等于「稿子写完」——首段 300 字不该被预设的 800 字
	 * 下限判违规。故未封笔时字数一项降为提示，封笔后（或走 draft_write 全量交稿）
	 * 才按完整稿口径验收。
	 */
	sealed: boolean;
	/** 交稿次数（含宽进严出代收；验收统计「思考量 × draft_write 调用数」用） */
	writes: number;
	/** draft_append 追加段数（M-E KPI：分段续写是否真发生） */
	appends: number;
	/** draft_edit 成功套用的次数（M-B KPI：定点改稿是否真替代了全文重交） */
	edits: number;
	/** world_state_update 已验证入队的 patch（定稿后按序统一套用） */
	patches: Record<string, unknown>[];
	/** 最近一次验收是否全绿（谢幕判定用；未验收过 = false） */
	lastGreen: boolean;
	checks: number;
	/**
	 * 本拍时间线（思考/工具/正文按**发生顺序**）。
	 *
	 * 定稿只落最后一稿正文，中间轮的思考与工具轨迹本会丢失——但用户要看的
	 * 正是「思考→工具→正文→思考」这条链。故在此按序记档，落树时随 details
	 * 持久化，刷新与 resync 后仍在。
	 */
	timeline: TurnSegment[];
	/**
	 * 本拍的媒体交付（show_image/audio/video/html、tts，8/06 重接）。
	 *
	 * wire 层只把树上的 `role:"toolResult"` 条目翻成媒体帧，而台上引擎落树时
	 * 剥离工具轨迹——故媒体结果在此收集，谢幕后随正文一起落成 toolResult 条目，
	 * 让 live 推送与刷新重放走同一条路径。
	 */
	mediaDeliveries?: Array<{ toolName: string; details: Record<string, unknown>; text: string }>;
}

/** 时间线段：与前端 web/src/timeline.ts 的 TurnSegment 同构（跨边界只走 JSON） */
export type TurnSegment =
	| { kind: "thinking"; text: string }
	/** draft=true 标记「这段是工作区稿件」，重交/改稿时原地替换而非叠加 */
	| { kind: "text"; text: string; draft?: boolean }
	| { kind: "tool"; activities: Array<{ kind: string; name: string; detail?: string; isError?: boolean }> };

export function createWorkspace(): TurnWorkspace {
	return { draft: "", sealed: false, writes: 0, appends: 0, edits: 0, patches: [], lastGreen: false, checks: 0, timeline: [] };
}

/** 时间线追加：同类并入末段（连续工具聚成一组），异类开新段 */
export function recordSegment(
	ws: TurnWorkspace,
	seg:
		| { kind: "thinking"; text: string }
		| { kind: "text"; text: string }
		| { kind: "tool"; activity: { kind: string; name: string; detail?: string; isError?: boolean } },
): void {
	const last = ws.timeline[ws.timeline.length - 1];
	if (seg.kind === "tool") {
		if (last && last.kind === "tool") last.activities.push(seg.activity);
		else ws.timeline.push({ kind: "tool", activities: [seg.activity] });
		return;
	}
	if (!seg.text) return;
	if (last && last.kind === seg.kind) last.text += seg.text;
	else ws.timeline.push({ kind: seg.kind, text: seg.text });
}

/**
 * 定稿时间线：**所有** text 段统一收拢为一个稿段（内容 = finalText），清掉空壳段。
 *
 * 落树的正文是 finalText（工作区空时退回直出正文；稿件 + 格式尾巴由引擎合并），
 * 时间线里的正文段必须与它一致，否则屏上会出现「时间线里的稿」与「消息正文」
 * 两份不同的文本。尾巴段（状态栏 / catsay，收尾轮按序记入）已并入 finalText，
 * 故只保留第一个正文段的位置、内容替换为 finalText，其余 text 段吸收掉不重复上屏。
 * 工作区从未记过稿段（直出正文路径）时，用 finalText 补在末尾。
 */
export function finalTimeline(ws: TurnWorkspace, finalText: string): TurnSegment[] {
	const out: TurnSegment[] = [];
	let textPlaced = false;
	for (const s of ws.timeline) {
		if (s.kind === "tool") {
			if (s.activities.length > 0) out.push(s);
			continue;
		}
		if (s.kind === "text") {
			if (!textPlaced) {
				textPlaced = true;
				out.push({ kind: "text", text: finalText, draft: true });
			}
			continue;
		}
		if (s.text.trim().length > 0) out.push(s);
	}
	if (!textPlaced && finalText.trim()) out.push({ kind: "text", text: finalText, draft: true });
	return out;
}

/**
 * 稿件入时间线：**替换**已记的稿，而不是再追加一段。
 *
 * 多稿重交（M-B 实弹的 882→849→838）与定点改稿都作用在同一份稿上，
 * 逐次追加会让同一段正文在屏上叠出几份（EXEC §4.5.4 记的重复上屏欠账）。
 * 故先摘掉此前记过的稿段，再把最新稿记在当前位置——位置随最后一次动笔走，
 * 前面的思考与工具轨迹不动。
 */
function replaceDraftSegment(ws: TurnWorkspace, content: string): void {
	ws.timeline = ws.timeline.filter((s) => !(s.kind === "text" && s.draft === true));
	ws.timeline.push({ kind: "text", text: content, draft: true });
}

/**
 * 定点改稿后同步时间线（M-E）：分段续写时**保持分段**，只把整稿重新切回各段。
 *
 * 续写形态下屏上是「一段段长出来的故事」，若改一处就塌成一整块，
 * 已经上屏的部分会在用户眼前重排——那正是 draft_append 要消除的体验。
 * 故按段落边界重切：稿件以 `\n\n` 分段，逐段替换已记的稿段。
 */
function resyncDraftSegments(ws: TurnWorkspace): void {
	const firstIdx = ws.timeline.findIndex((s) => s.kind === "text" && s.draft === true);
	ws.timeline = ws.timeline.filter((s) => !(s.kind === "text" && s.draft === true));
	const parts = ws.draft.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
	const segs: TurnSegment[] = parts.map((p) => ({ kind: "text" as const, text: p, draft: true }));
	if (firstIdx >= 0) ws.timeline.splice(Math.min(firstIdx, ws.timeline.length), 0, ...segs);
	else ws.timeline.push(...segs);
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
	// 未封笔（分段续写中）：字数与缺模块都不算违规——稿子还没写完，
	// 拿完整稿口径判在写的段落，只会把模型逼回「一次交完」。降为提示。
	const pending = ws.appends > 0 && !ws.sealed;
	const violations = pending
		? report.violations.filter((v) => !v.startsWith("正文 ") && !v.startsWith("缺模块") && !v.startsWith("缺状态栏"))
		: report.violations;
	const green = violations.length === 0 && sov.length === 0;
	ws.lastGreen = green && !pending;
	const lines = [formatDraftReport({ ...report, violations })];
	if (sov.length > 0) lines.push(sov.map((s) => `- [主权] ${s}`).join("\n"));
	if (pending) {
		const body = extractDraftBody(ws.draft).replace(/\s+/g, "").length;
		lines.push(
			`续写中（已 ${ws.appends} 段，正文 ${body} 字，未封笔）：` +
				`接着 draft_append 往下写；写到头了用 draft_seal 封笔并按完整稿验收。`,
		);
	} else if (green) {
		lines.push("验收通过：可定稿（停止调用工具即交付此稿），或继续打磨。");
	}
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
		ws.sealed = true; // 全量交稿即完整稿，天然封笔
		// 时间线：正文按交稿位置入档。重交是**替换**不是追加——
		// 末段若已是本工作区写过的正文，改写它，避免多稿在屏上叠成几份。
		replaceDraftSegment(ws, content);
		// 收稿即验：省一轮往返（提速 KPI），模型仍可随时显式 draft_check 复验
		const c = runCheck(ws, deps);
		return {
			text: `已收稿（第 ${ws.writes} 稿，${content.length} 字）。验收报告：\n${c.text}`,
			activity: `交稿 ${content.length} 字${c.green ? " · 验收通过" : ""}`,
			ok: true,
		};
	}

	if (name === "draft_append") {
		const seg = typeof args.segment === "string" ? args.segment : "";
		if (!seg.trim()) return { text: "segment 为空——请提交要续写的段落。", ok: false };
		const sep = ws.draft.trim().length > 0 ? "\n\n" : "";
		ws.draft += sep + seg;
		ws.appends++;
		const body = extractDraftBody(ws.draft).replace(/\s+/g, "").length;
		// 续写的正文入时间线：追加一段（不是替换——已写的部分是已经发生的事，不推翻）
		ws.timeline.push({ kind: "text", text: seg, draft: true });
		// 收段即验：报告当前状态（字数/禁词），但未封笔不判字数违规
		const c = runCheck(ws, deps);
		return {
			text: `已续写（第 ${ws.appends} 段，正文 ${body} 字）。当前状态：\n${c.text}`,
			activity: `续写第 ${ws.appends} 段 · ${body} 字`,
			ok: true,
		};
	}

	if (name === "draft_seal") {
		if (!ws.draft.trim()) return { text: "工作区还没有稿件——先用 draft_write / draft_append 写正文。", ok: false };
		ws.sealed = true;
		const c = runCheck(ws, deps);
		return {
			text: `已封笔。按完整稿验收：\n${c.text}`,
			activity: c.green ? "封笔 · 验收通过" : "封笔 · 需修改",
			ok: true,
		};
	}

	if (name === "draft_check") {
		if (!ws.draft.trim()) return { text: "尚无稿件——先用 draft_write 交稿。", ok: false };
		const c = runCheck(ws, deps);
		return { text: c.text, activity: c.green ? "验收通过" : "验收未过", ok: true };
	}

	if (name === "draft_edit") {
		if (!ws.draft.trim()) return { text: "尚无稿件——先写正文（draft_append 续写 / draft_write 全量交稿），再定点修改。", ok: false };
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
		// 时间线：定点改稿后正文原地更新（改的是同一份稿，不新开一段）。
		// 续写形态下按段重切，保住「一段段长出来」的形态不塌成一整块。
		if (ws.appends > 0) resyncDraftSegments(ws);
		else replaceDraftSegment(ws, ws.draft);
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
