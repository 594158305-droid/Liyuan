/**
 * 场记调度（PLAN-RP-HARNESS M3，R8 记账独占 + R9 叶守卫）。
 *
 * 定稿之后一次旁路调用：读【当前账本 + 本拍对白】→ 出 patch → applyPatch →
 * 返回应用后的账本（落树/落盘由调用方统一做，8/13 域分工后合并单次落账）。
 *
 * 域分工（8/13）：主演每拍经 world_state_update 提交顶层字段（time/location/characters/…），
 * 场记专职 tables 域（scope="tables-only"，base 为主演 patch 投影后的账本）；
 * 主演本拍完全没调 world_state_update 时场记全域兜底（scope="full"，旧行为）。
 *
 * 叶守卫：旁路调用是异步的，期间用户可能 swipe/rewind/切世界线。落账前核对叶位置，
 * 变了就整体丢弃本次记账——快照绝不能写到导航后的分支上（8/02 账本泄漏事故的结构性解法）。
 * 丢弃是安全的：账本 = f(分支)（R4），新分支自会从它自己的最近快照重建。
 *
 * 纯函数 + 注入依赖，零 pi 依赖、可单测。
 */

import { applyPatch, canonicalizeCharacterKeys } from "../state.ts";
import { buildScribeTurnPrompt, parseScribeResult } from "../scribe.ts";
import type { WorldState } from "../types.ts";

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
 * 一拍记账（8/13 域分工）。调用方保证：只对干净收笔的台上拍调用（中断半拍/戏外轮不记账）。
 * 任何失败都只跳过本拍记账，不影响正文——账本滞后一拍可由下拍补上。
 * 落账（appendStateEntry/saveState）由调用方统一执行：返回 applied 的 state 即最终账本。
 */
export async function runScribeTurn(deps: ScribeRunDeps, input: ScribeRunInput): Promise<ScribeRunOutcome> {
	const { state, userText, assistantText, charName, userName, scope = "full" } = input;
	if (!assistantText.trim()) return { kind: "skipped", reason: "no-text" };

	const baseState = input.baseState ?? state;
	// tables-only 且账本无 auto 表：无事可做，省一次旁路调用
	if (scope === "tables-only" && !Object.values(baseState.tables ?? {}).some((t) => t.auto === true)) {
		return { kind: "skipped", reason: "no-auto-tables" };
	}

	const leafBefore = deps.getLeafId();
	const prompt = buildScribeTurnPrompt({ state, scope, userText, assistantText, charName, userName });
	const resp = await deps.sideText(prompt.systemPrompt, prompt.userText);
	if (typeof resp !== "string") return { kind: "failed", error: resp.error };

	const parsed = parseScribeResult(resp);
	if (!parsed) {
		// 短响应直接给全文（多半是格式跑偏）；长响应给尾部（多半是 maxTokens 截断）
		const flat = resp.trim().replace(/\s+/g, " ");
		const detail = flat.length <= 400 ? flat : `…${flat.slice(-160)}`;
		return { kind: "failed", error: `输出不可解析（${resp.length} 字）：${detail}` };
	}
	if (Object.keys(parsed.patch).length === 0) return { kind: "skipped", reason: "empty-patch" };

	// R9 叶守卫：调用期间树动过（swipe/rewind/切线）→ 整体丢弃
	if (deps.getLeafId() !== leafBefore) {
		deps.onActivity?.("记账已丢弃（本拍期间切换了分支）");
		return { kind: "stale" };
	}

	const knownNames = [charName, userName, ...Object.keys(state.characters)];
	const result = applyPatch(baseState, canonicalizeCharacterKeys(parsed.patch, knownNames));
	if (result.applied.length > 0) deps.onActivity?.(`记账 ${summarizeApplied(result.applied)}`);
	return { kind: "applied", state: result.state, applied: result.applied };
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
		return s.split(" ")[0];
	};
	const names = [...new Set(applied.map(label))];
	const shown = names.slice(0, 3).join("、");
	return names.length > 3 ? `${shown} 等 ${names.length} 项` : shown;
}
