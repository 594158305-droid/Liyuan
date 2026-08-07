/**
 * 正则调试器（P5c）：在「测试」页签下的子视图。
 * - 规则列表：当前选中分类 scope 的组 + 规则（scope=card 时含卡内嵌规则），标注来源与启用状态
 * - 临时排序：HTML5 原生拖拽，仅在组内重排（不落盘；「保存顺序」才写回）
 * - Run Test：样例文本 → 按列表顺序逐条 applyCardSkin（上一步输出 = 下一步输入），
 *   每步显示捕获/新增/移除统计；diff 高亮（命中片段删除线 + 替换结果绿色）
 * - 保存顺序：把拖拽后的目标顺序换算成相邻交换序列，逐次调用 POST /rules/move 写回
 *
 * 已禁用 / 整组关闭的规则不参与测试（与真实管线一致），但列表中仍可见并标注。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "../api.ts";
import { isRuleOff, ruleKey, type DisplayRule, type RuleGroup } from "../../../src/cardfront.ts";
import { applyCardSkin } from "../cardSkin.ts";

type RuleScope = "global" | "card" | "preset";

/** 卡内嵌规则信息（与 RegexPanel 同构裁剪） */
interface CardInfo {
	path: string;
	cardRules: DisplayRule[];
	ruleOff: string[];
}

/** 调试器内的组（规则带原始下标，便于换算交换序列） */
interface DbgRule {
	origIndex: number;
	rule: DisplayRule;
}
interface DbgGroup {
	name: string;
	off?: boolean;
	rules: DbgRule[];
}

interface DebuggerStep {
	rule: DisplayRule;
	groupName: string;
	input: string;
	output: string;
	captured: number;
	added: number;
	removed: number;
}

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function formatFindRegex(rule: DisplayRule): string {
	return `/${rule.source}/${rule.flags}`;
}

function replaceSummary(text: string, limit = 60): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (!single) return "（空）";
	return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

/** 与引擎一致的查找正则源宏替换（substituteRegex 缺省=转义，历史行为） */
function dbgFindSource(rule: DisplayRule, macros: { charName: string; userName: string }): string {
	const mode = rule.substituteRegex ?? 2;
	if (mode === 0) return rule.source;
	const char = mode === 2 ? escapeReg(macros.charName) : macros.charName;
	const user = mode === 2 ? escapeReg(macros.userName) : macros.userName;
	return rule.source.replace(/\{\{\s*char\s*\}\}/gi, char).replace(/\{\{\s*user\s*\}\}/gi, user);
}

/** Captured = 命中字符数（与替换语义一致：g 全量、无 g 只首次） */
function matchedChars(input: string, rule: DisplayRule, macros: { charName: string; userName: string }): number {
	let total = 0;
	try {
		const re = new RegExp(dbgFindSource(rule, macros), rule.flags);
		if (rule.flags.includes("g")) {
			for (const m of input.matchAll(re)) total += m[0].length;
		} else {
			const m = re.exec(input);
			if (m) total += m[0].length;
		}
	} catch {
		/* 坏正则按 0 计 */
	}
	return total;
}

/** 目标顺序 → 相邻交换序列（从 orig 逐元素冒泡到位；每次交换 = move(index, +1)） */
function adjacentSwaps(orig: number[], target: number[]): Array<{ index: number; delta: 1 }> {
	const cur = orig.slice();
	const swaps: Array<{ index: number; delta: 1 }> = [];
	for (let i = 0; i < target.length; i++) {
		let j = cur.indexOf(target[i]);
		while (j > i) {
			swaps.push({ index: j - 1, delta: 1 });
			[cur[j - 1], cur[j]] = [cur[j], cur[j - 1]];
			j -= 1;
		}
	}
	return swaps;
}

// ---------- 轻量 diff（字符级；先切公共前缀/后缀，中间段做 LCS） ----------

type DiffSeg = { type: "same" | "del" | "add"; text: string };

function lcsDiff(a: string, b: string): DiffSeg[] {
	const n = a.length;
	const m = b.length;
	const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const segs: DiffSeg[] = [];
	const push = (t: DiffSeg["type"], ch: string) => {
		const last = segs[segs.length - 1];
		if (last && last.type === t) last.text += ch;
		else segs.push({ type: t, text: ch });
	};
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			push("same", a[i]);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			push("del", a[i]);
			i++;
		} else {
			push("add", b[j]);
			j++;
		}
	}
	while (i < n) {
		push("del", a[i]);
		i++;
	}
	while (j < m) {
		push("add", b[j]);
		j++;
	}
	return segs;
}

function diffText(a: string, b: string): DiffSeg[] {
	let p = 0;
	const cap = Math.min(a.length, b.length);
	while (p < cap && a[p] === b[p]) p++;
	let s = 0;
	const n = Math.min(a.length, b.length) - p;
	while (s < n && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
	const midA = a.slice(p, a.length - s);
	const midB = b.slice(p, b.length - s);
	const head: DiffSeg[] = p > 0 ? [{ type: "same", text: a.slice(0, p) }] : [];
	const tail: DiffSeg[] = s > 0 ? [{ type: "same", text: a.slice(a.length - s) }] : [];
	let middle: DiffSeg[];
	if (midA.length * midB.length <= 1_000_000) {
		middle = lcsDiff(midA, midB);
	} else {
		middle = [
			...(midA ? [{ type: "del" as const, text: midA }] : []),
			...(midB ? [{ type: "add" as const, text: midB }] : []),
		];
	}
	return [...head, ...middle, ...tail];
}

function DiffView({ input, output }: { input: string; output: string }) {
	const segs = useMemo(() => diffText(input, output), [input, output]);
	return (
		<div className="diff-view">
			{segs.map((seg, i) => {
				if (seg.type === "same") return <span key={i}>{seg.text}</span>;
				if (seg.type === "del") {
					return (
						<span key={i} className="diff-del">
							{seg.text}
						</span>
					);
				}
				return (
					<span key={i} className="diff-add">
						{seg.text}
					</span>
				);
			})}
		</div>
	);
}

function DbgRow({
	rule,
	groupName,
	on,
	draggable,
	dragging,
	over,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
}: {
	rule: DisplayRule;
	groupName: string;
	on: boolean;
	draggable: boolean;
	dragging?: boolean;
	over?: boolean;
	onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
	onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
	onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
	onDragEnd?: () => void;
}) {
	return (
		<div
			className={`dbg-row ${draggable ? "" : "dbg-row-readonly"} ${dragging ? "dragging" : ""} ${over ? "over" : ""}`}
			draggable={draggable}
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDrop={onDrop}
			onDragEnd={onDragEnd}
		>
			{draggable && (
				<span className="dbg-grip" title="拖动排序">
					⠿
				</span>
			)}
			<div className="dbg-row-main">
				<div className="dbg-row-top">
					<span className="rule-name">{rule.name || "未命名"}</span>
					<span className={`chip ${on ? "" : "chip-off"}`}>{on ? "开" : "关"}</span>
					<span className="dbg-src">{groupName}</span>
				</div>
				<div className="rule-regex">{formatFindRegex(rule)}</div>
				<div className="rule-replace">{replaceSummary(rule.replace)}</div>
			</div>
		</div>
	);
}

export function RegexDebugger({
	scope,
	groups,
	cardInfo,
	macros,
	busy,
	scopeQueryStr,
	onScopeChange,
	run,
	afterChange,
}: {
	scope: RuleScope;
	groups: RuleGroup[];
	cardInfo: CardInfo | null;
	macros: { charName: string; userName: string };
	busy: boolean;
	scopeQueryStr: string;
	onScopeChange: (scope: RuleScope) => void;
	run: (fn: () => Promise<void>, doneText?: string) => void;
	afterChange: () => Promise<void>;
}) {
	const [dbgGroups, setDbgGroups] = useState<DbgGroup[]>([]);
	const [dirty, setDirty] = useState(false);
	const [sample, setSample] = useState("");
	const [steps, setSteps] = useState<DebuggerStep[] | null>(null);
	const [showDiff, setShowDiff] = useState<"plain" | "highlight">("highlight");
	const dragRef = useRef<{ gi: number; ri: number } | null>(null);
	const [overPos, setOverPos] = useState<{ gi: number; ri: number } | null>(null);

	// 服务端列表（正式顺序）变化 → 重建调试器临时列表（丢弃未保存的拖拽态）
	useEffect(() => {
		setDbgGroups(
			groups.map((g) => ({
				name: g.name,
				off: g.off,
				rules: g.rules.map((r, ri) => ({ origIndex: ri, rule: r })),
			})),
		);
		setDirty(false);
		setSteps(null);
	}, [groups]);

	const reorderWithinGroup = (gi: number, from: number, to: number) => {
		if (from === to) return;
		setDbgGroups((gs) =>
			gs.map((g, i) => {
				if (i !== gi) return g;
				const rules = g.rules.slice();
				const [it] = rules.splice(from, 1);
				rules.splice(to, 0, it);
				return { ...g, rules };
			}),
		);
		setDirty(true);
	};

	// ---- Run Test：按当前列表顺序逐条应用（上一步输出 = 下一步输入） ----
	const runTest = () => {
		const ruleList: Array<{ rule: DisplayRule; groupName: string }> = [];
		if (scope === "card" && cardInfo) {
			for (const r of cardInfo.cardRules) {
				if (cardInfo.ruleOff.includes(ruleKey(r))) continue;
				ruleList.push({ rule: r, groupName: "卡内嵌" });
			}
		}
		for (const g of dbgGroups) {
			if (g.off === true) continue;
			for (const dr of g.rules) {
				if (isRuleOff(dr.rule)) continue;
				ruleList.push({ rule: dr.rule, groupName: g.name || "未分组" });
			}
		}
		if (ruleList.length === 0) {
			setSteps([]);
			return;
		}
		let input = sample;
		const out: DebuggerStep[] = [];
		for (const item of ruleList) {
			const before = input;
			let output: string;
			try {
				output = applyCardSkin(input, [item.rule], macros);
			} catch {
				output = input;
			}
			const captured = matchedChars(before, item.rule, macros);
			out.push({
				rule: item.rule,
				groupName: item.groupName,
				input: before,
				output,
				captured,
				added: Math.max(0, output.length - before.length),
				removed: Math.max(0, before.length - output.length),
			});
			input = output;
		}
		setSteps(out);
	};

	const totals = useMemo(() => {
		if (!steps || steps.length === 0) return null;
		return steps.reduce(
			(acc, s) => ({ captured: acc.captured + s.captured, added: acc.added + s.added, removed: acc.removed + s.removed }),
			{ captured: 0, added: 0, removed: 0 },
		);
	}, [steps]);

	// ---- 保存顺序：拖拽后的目标顺序 → 相邻交换序列 → 逐次 move 写回 ----
	const saveOrder = () => {
		run(async () => {
			for (let gi = 0; gi < dbgGroups.length; gi++) {
				const orig = dbgGroups[gi].rules.slice().sort((a, b) => a.origIndex - b.origIndex).map((r) => r.origIndex);
				const target = dbgGroups[gi].rules.map((r) => r.origIndex);
				const swaps = adjacentSwaps(orig, target);
				for (const { index, delta } of swaps) {
					await apiPost(`/api/cardfront/rules/move${scopeQueryStr}`, { group: gi, index, delta });
				}
			}
			await afterChange();
		}, "已保存规则顺序");
	};

	return (
		<div className="dbg-view">
			<div className="panel-row" style={{ alignItems: "center", flexWrap: "wrap" }}>
				<span className="field-hint">调试作用域：</span>
				<select
					className="panel-search"
					style={{ width: "auto", flex: "1 1 110px" }}
					value={scope}
					disabled={busy}
					onChange={(e) => onScopeChange(e.target.value as RuleScope)}
				>
					<option value="global">全局</option>
					<option value="card">角色</option>
					<option value="preset">预设</option>
				</select>
			</div>

			<div className="dbg-rule-list">
				{scope === "card" && cardInfo && cardInfo.cardRules.length > 0 && (
					<div className="dbg-group">
						<div className="dbg-group-name">卡内嵌规则（只读，不可拖动）</div>
						{cardInfo.cardRules.map((r, i) => (
							<DbgRow
								key={`card-${ruleKey(r)}-${i}`}
								rule={r}
								groupName="卡内嵌"
								on={!cardInfo.ruleOff.includes(ruleKey(r))}
								draggable={false}
							/>
						))}
					</div>
				)}
				{dbgGroups.map((g, gi) => (
					<div key={`${g.name}-${gi}`} className="dbg-group">
						<div className="dbg-group-name">
							{g.name || "未分组"}
							{g.off ? "（整组关闭）" : ""}
						</div>
						{g.rules.length === 0 && <div className="field-hint">组内暂无规则。</div>}
						{g.rules.map((dr, ri) => (
							<DbgRow
								key={`${dr.origIndex}-${ri}`}
								rule={dr.rule}
								groupName={g.name || "未分组"}
								on={!isRuleOff(dr.rule) && g.off !== true}
								draggable={true}
								dragging={dragRef.current?.gi === gi && dragRef.current?.ri === ri}
								over={overPos?.gi === gi && overPos?.ri === ri}
								onDragStart={(e) => {
									dragRef.current = { gi, ri };
									e.dataTransfer.effectAllowed = "move";
								}}
								onDragOver={(e) => {
									e.preventDefault();
									setOverPos({ gi, ri });
								}}
								onDrop={(e) => {
									e.preventDefault();
									const from = dragRef.current;
									if (!from || from.gi !== gi) return;
									reorderWithinGroup(gi, from.ri, ri);
									dragRef.current = null;
									setOverPos(null);
								}}
								onDragEnd={() => {
									dragRef.current = null;
									setOverPos(null);
								}}
							/>
						))}
					</div>
				))}
			</div>

			<div className="panel-row" style={{ flexWrap: "wrap", gap: 6, marginTop: 10 }}>
				<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={runTest}>
					Run Test
				</button>
				<button type="button" className="drawer-btn" disabled={busy || !dirty} title="把拖拽后的顺序写回正式列表" onClick={saveOrder}>
					保存顺序
				</button>
				<label className="field-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<input type="radio" name="dbg-show-mode" checked={showDiff === "plain"} onChange={() => setShowDiff("plain")} />
					纯文本
				</label>
				<label className="field-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<input
						type="radio"
						name="dbg-show-mode"
						checked={showDiff === "highlight"}
						onChange={() => setShowDiff("highlight")}
					/>
					高亮 diff
				</label>
			</div>
			<div className="field-hint" style={{ marginBottom: 6 }}>
				已禁用 / 整组关闭的规则不参与测试；按列表顺序逐条应用，上一步输出 = 下一步输入。
			</div>
			<label className="field">
				<span className="field-label">样例文本</span>
				<textarea
					className="panel-search ta"
					rows={4}
					placeholder="粘贴一段 AI 输出…"
					value={sample}
					onChange={(e) => setSample(e.target.value)}
				/>
			</label>

			{steps && (
				<div className="dbg-steps">
					{steps.length === 0 && <div className="field-hint">没有可执行的规则（列表为空或全部关闭）。</div>}
					{steps.map((s, i) => (
						<div key={i} className="dbg-step">
							<div className="dbg-step-head">
								<span className="dbg-step-name">
									{i + 1}. {s.rule.name || "未命名"}
								</span>
								<span className="dbg-src">{s.groupName}</span>
								<span className="dbg-stats">
									捕获 {s.captured} · 增 +{s.added} · 减 -{s.removed}
								</span>
							</div>
							{showDiff === "highlight" ? (
								<DiffView input={s.input} output={s.output} />
							) : (
								<div className="longtext">{s.output}</div>
							)}
						</div>
					))}
					{totals && (
						<div className="dbg-total">
							合计：捕获 {totals.captured} · 增 +{totals.added} · 减 -{totals.removed}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
