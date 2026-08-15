/**
 * 场记调度（PLAN-RP-HARNESS M3，R8 记账独占 + R9 叶守卫）。
 *
 * 8/13 域分工：主演每拍经 world_state_update 提交顶层字段（time/location/…），
 * 场记专职 tables 域（scope="tables-only"）；主演本拍完全没调 world_state_update
 * 时场记全域兜底（scope="full"，旧行为）。
 *
 * 8/15 逐表派发：tables 域不再一次全量注入全部 auto 表（19 表 JSON ≈ 21 万字符/拍，
 * 输入过大导致旁路模型空输出、单表失败拖累整拍——实测见 plan_doc/token-slimming.md），
 * 改为 buildTableTodo 文本匹配出本轮相关表，逐表独立旁路调用（每表输入 = 该表
 * description + 现有行 + 关联表 + 本轮对话，见 src/table-backfill.ts 的提取器提示词），
 * 失败/输出不可解析只跳过该表。full 时顶层仍走 buildScribeTurnPrompt 全域兜底，
 * 其输出里的 tables 补丁剥掉（表格统一由逐表通道维护，避免双重写）。
 *
 * 叶守卫：旁路调用是异步的，期间用户可能 swipe/rewind/切世界线。落账前核对叶位置，
 * 变了就整体丢弃本次记账——快照绝不能写到导航后的分支上（8/02 账本泄漏事故的结构性解法）。
 * 丢弃是安全的：账本 = f(分支)（R4），新分支自会从它自己的最近快照重建。
 *
 * 纯函数 + 注入依赖，零 pi 依赖、可单测。
 */

import { applyPatch, canonicalizeCharacterKeys } from "../state.ts";
import { buildScribeTurnPrompt, parseScribeResult } from "../scribe.ts";
import { applyOps, buildTableBackfillPrompt, parseTableBackfillOps, relatedTableNames } from "../table-backfill.ts";
import { buildTableTodo } from "../table-todo.ts";
import type { CustomTable, WorldState } from "../types.ts";

/** 场记快照的会话树条目类型（CustomEntry，不进 LLM 上下文） */
export const STATE_ENTRY_TYPE = "rp-state";

export interface ScribeRunDeps {
	/** 旁路文本调用：返回文本，或 {error} */
	sideText: (systemPrompt: string, userText: string) => Promise<string | { error: string }>;
	/** 叶守卫读数：调用前后各取一次，不等则丢弃 */
	getLeafId: () => string | null;
	onActivity?: (detail: string) => void;
}

export interface ScribeRunInput {
	/** 本拍开演前的账本（= f(分支)） */
	state: WorldState;
	/** 补丁应用基底（缺省 = state）：域分工时传主演 patch 投影后的账本，场记在其上叠 tables 补丁 */
	baseState?: WorldState;
	/** 记账域分工（8/13）："tables-only" = 只维护表格（主演已提交顶层）；缺省 "full" = 全域兜底 */
	scope?: "tables-only" | "full";
	userText: string;
	/** 本拍定稿正文（补丁已套） */
	assistantText: string;
	charName: string;
	userName: string;
}

export type ScribeRunOutcome =
	| { kind: "skipped"; reason: string }
	| { kind: "stale" }
	| { kind: "failed"; error: string }
	| { kind: "applied"; state: WorldState; applied: string[] };

/**
 * 一拍记账（8/13 域分工 + 8/15 逐表派发）。调用方保证：只对干净收笔的台上拍调用
 * （中断半拍/戏外轮不记账）。任何失败都只跳过本拍记账，不影响正文——账本滞后一拍
 * 可由下拍补上。落账（appendStateEntry/saveState）由调用方统一执行：返回 applied
 * 的 state 即最终账本。
 */
export async function runScribeTurn(deps: ScribeRunDeps, input: ScribeRunInput): Promise<ScribeRunOutcome> {
	const { state, userText, assistantText, charName, userName, scope = "full" } = input;
	if (!assistantText.trim()) return { kind: "skipped", reason: "no-text" };

	const baseState = input.baseState ?? state;
	const tables = baseState.tables ?? {};
	const autoTables: Record<string, CustomTable> = {};
	for (const [name, t] of Object.entries(tables)) if (t.auto === true) autoTables[name] = t;
	const hasAuto = Object.keys(autoTables).length > 0;

	// tables-only 且账本无 auto 表：无事可做，省一次旁路调用
	if (scope === "tables-only" && !hasAuto) return { kind: "skipped", reason: "no-auto-tables" };

	const leafBefore = deps.getLeafId();
	// 对话（带角色标签，供模型阅读）与纯正文（TODO 匹配用——「正文提及」不含「角色：」标签头）
	const dialogue = `${userName}：${userText}\n\n${charName}：${assistantText}`;
	const todo = hasAuto ? buildTableTodo(`${userText}\n\n${assistantText}`, autoTables) : [];

	if (scope === "tables-only") {
		if (todo.length === 0) return { kind: "skipped", reason: "no-related-tables" };
		return runPerTablePass(deps, baseState, todo, dialogue, leafBefore);
	}

	// full：顶层兜底（主演未提交 world_state_update 时的全域记账）
	const prompt = buildScribeTurnPrompt({ state, scope: "full", userText, assistantText, charName, userName });
	const resp = await deps.sideText(prompt.systemPrompt, prompt.userText);
	if (typeof resp !== "string") return { kind: "failed", error: resp.error };

	const parsed = parseScribeResult(resp);
	if (!parsed) {
		// 短响应直接给全文（多半是格式跑偏）；长响应给尾部（多半是 maxTokens 截断）
		const flat = resp.trim().replace(/\s+/g, " ");
		const detail = flat.length <= 400 ? flat : `…${flat.slice(-160)}`;
		return { kind: "failed", error: `输出不可解析（${resp.length} 字）：${detail}` };
	}

	let finalState: WorldState = baseState;
	const applied: string[] = [];
	// 顶层 patch（剥掉 tables——表格统一由逐表通道维护，避免双重写）
	const topPatch = { ...parsed.patch };
	delete topPatch.tables;
	if (Object.keys(topPatch).length > 0) {
		// R9 叶守卫：调用期间树动过（swipe/rewind/切线）→ 整体丢弃
		if (deps.getLeafId() !== leafBefore) {
			deps.onActivity?.("记账已丢弃（本拍期间切换了分支）");
			return { kind: "stale" };
		}
		const knownNames = [charName, userName, ...Object.keys(state.characters)];
		const result = applyPatch(baseState, canonicalizeCharacterKeys(topPatch, knownNames));
		finalState = result.state;
		applied.push(...result.applied);
	}

	// 表格域逐表派发（full 时顶层已记账，表格照常逐表维护）
	if (todo.length > 0) {
		const tableOutcome = await runPerTablePass(deps, finalState, todo, dialogue, leafBefore);
		if (tableOutcome.kind === "stale") return tableOutcome;
		if (tableOutcome.kind === "applied") applied.push(...tableOutcome.applied);
	}

	if (applied.length === 0) return { kind: "skipped", reason: "empty-patch" };
	if (applied.length > 0) deps.onActivity?.(`记账 ${summarizeApplied(applied)}`);
	return { kind: "applied", state: finalState, applied };
}

/**
 * 表格域逐表派发：TODO 表列表逐表独立旁路调用（每表 = 提取器提示词 + 该表状态 +
 * 关联表 + 本轮对话），parseTableBackfillOps → applyOps 直接改 state。
 * 单表调用失败 / 输出不可解析只跳过该表，不拖累其他表；每表应用前核对叶守卫。
 */
async function runPerTablePass(
	deps: ScribeRunDeps,
	state: WorldState,
	todo: string[],
	dialogue: string,
	leafBefore: string | null,
): Promise<ScribeRunOutcome> {
	const applied: string[] = [];
	for (const name of todo) {
		const table = state.tables?.[name];
		if (!table) continue;
		// 表说明引用的其他表（只读核对一致性，不写入）
		let related: Record<string, CustomTable> | undefined;
		const names = relatedTableNames(table.description, state.tables ?? {}, name);
		if (names.length > 0) {
			related = {};
			for (const n of names) {
				const rt = state.tables?.[n];
				if (rt) related[n] = rt;
			}
		}
		const prompt = buildTableBackfillPrompt(table, JSON.stringify(table), dialogue, related, "本轮对话");
		const resp = await deps.sideText(prompt.systemPrompt, prompt.userText);
		if (typeof resp !== "string") continue; // 单表调用失败 → 跳过该表
		const ops = parseTableBackfillOps(resp);
		if (!ops) continue; // 输出不可解析 → 跳过该表
		// R9 叶守卫：应用前核对（每表一次，中途 swipe 立即丢弃，省后续调用）
		if (deps.getLeafId() !== leafBefore) {
			deps.onActivity?.("记账已丢弃（本拍期间切换了分支）");
			return { kind: "stale" };
		}
		applied.push(...applyOps(state, name, ops).applied);
	}
	if (applied.length === 0) return { kind: "skipped", reason: "empty-patch" };
	if (applied.length > 0) deps.onActivity?.(`记账 ${summarizeApplied(applied)}`);
	return { kind: "applied", state, applied };
}

/** 过程条用的记账摘要：条数 + 前两条中文化字段名 */
function summarizeApplied(applied: string[]): string {
	const label = (s: string): string => {
		if (s.startsWith("time")) return "时间";
		if (s.startsWith("location")) return "地点";
		if (s.startsWith("characters.")) return s.slice("characters.".length).split(" ")[0];
		if (s.startsWith("flags.")) return s.slice("flags.".length).split(" ")[0];
		if (s.startsWith("inventory")) return "物品";
		if (s.startsWith("plot_threads")) return "剧情线";
		if (s.startsWith("表 ")) return s.slice(2).split(" ")[0]; // 「表 X 插入 1 行」→ X
		return s.split(" ")[0];
	};
	const names = [...new Set(applied.map(label))];
	const shown = names.slice(0, 3).join("、");
	return names.length > 3 ? `${shown} 等 ${names.length} 项` : shown;
}
