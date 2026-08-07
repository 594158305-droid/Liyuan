/**
 * 正则脚本面板（左侧独立面板）：
 * 全局 / 角色 / 预设 三分类，支持分组管理、规则 CRUD/排序/复制、试运行。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, type CardsResponse } from "../api.ts";
import type { DisplayRule } from "../../../src/cardfront.ts";
import { applyCardSkin } from "../cardSkin.ts";
import { ConfirmButton, PanelStatus, Toggle, useAction, usePanelData } from "./kit.tsx";

type RuleScope = "global" | "card" | "preset";
type TabId = RuleScope | "test";

interface RuleGroup {
	name: string;
	off?: boolean;
	rules: DisplayRule[];
}

interface CardInfo {
	path: string;
	cardRules: DisplayRule[];
	ruleOff: string[];
}

interface PresetInfo {
	file: string;
	name: string;
}

interface GroupsResponse {
	ok: boolean;
	groups: RuleGroup[];
	card?: CardInfo;
	preset?: PresetInfo | null;
}

interface FrontSnapshot {
	rules: DisplayRule[];
	charName: string;
	userName: string;
}

type RuleItem = DisplayRule & { id?: string; off?: boolean };

type RuleDraft = { name: string; findRegex: string; replace: string; off: boolean };

type SetDraft = (v: RuleDraft | ((prev: RuleDraft) => RuleDraft)) => void;

const SCOPE_LABEL: Record<RuleScope, string> = { global: "全局", card: "角色", preset: "预设" };
const TAB_LABEL: Record<Exclude<TabId, "test">, string> = { global: "全局", card: "角色", preset: "预设" };

function formatFindRegex(rule: DisplayRule): string {
	return `/${rule.source}/${rule.flags}`;
}

function ruleKey(rule: RuleItem): string {
	return rule.id ?? rule.name ?? rule.source;
}

function replaceSummary(text: string, limit = 60): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (!single) return "（空）";
	return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

function parseFindRegex(find: string): { source: string; flags: string } | { error: string } {
	const trimmed = find.trim();
	const m = /^\/([\s\S]+)\/([a-z]*)$/.exec(trimmed);
	if (!m) return { error: "正则须以 /pattern/flags 形式填写" };
	const source = m[1];
	const flags = m[2] || "g";
	try {
		new RegExp(source, flags);
	} catch (e) {
		return { error: `正则语法错误：${e instanceof Error ? e.message : String(e)}` };
	}
	return { source, flags };
}

function scopeQuery(scope: RuleScope, cardPath = ""): string {
	if (scope === "card") return `?scope=${scope}&card=${encodeURIComponent(cardPath)}`;
	return `?scope=${scope}`;
}

function RuleEditor({
	editing,
	draft,
	setDraft,
	groupNames,
	targetGroup,
	setTargetGroup,
	onSave,
	onCancel,
	busy,
	sample,
	setSample,
	trialSource,
	setTrialSource,
	previewRules,
	macros,
}: {
	editing: boolean;
	draft: RuleDraft;
	setDraft: SetDraft;
	groupNames: string[];
	targetGroup: number;
	setTargetGroup: (v: number) => void;
	onSave: () => void;
	onCancel: () => void;
	busy: boolean;
	sample: string;
	setSample: (v: string) => void;
	trialSource: "draft" | "active";
	setTrialSource: (v: "draft" | "active") => void;
	previewRules: DisplayRule[];
	macros: { charName: string; userName: string };
}) {
	const validation = useMemo(() => parseFindRegex(draft.findRegex), [draft.findRegex]);
	const invalid = "error" in validation;

	const preview = useMemo(() => {
		if (!sample.trim()) return "（输入样例文本以查看效果）";
		try {
			if (trialSource === "draft") {
				if (invalid) return `（草稿正则无效：${validation.error}）`;
				const rule: DisplayRule = {
					name: draft.name || "草稿",
					source: validation.source,
					flags: validation.flags,
					replace: draft.replace,
				};
				return applyCardSkin(sample, [rule], macros);
			}
			return applyCardSkin(sample, previewRules, macros);
		} catch (e) {
			return `（应用出错：${e instanceof Error ? e.message : String(e)}）`;
		}
	}, [sample, draft, trialSource, previewRules, macros, invalid, validation]);

	return (
		<div className="rule-editor">
			<h5>{editing ? "编辑规则" : "新建规则"}</h5>
			<label className="field">
				<span className="field-label">名称（可选）</span>
				<input
					className="panel-search"
					placeholder="规则名称"
					value={draft.name}
					onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
				/>
			</label>
			<label className="field">
				<span className="field-label">归属组</span>
				<select
					className="panel-search"
					value={targetGroup}
					onChange={(e) => setTargetGroup(Number(e.target.value))}
				>
					{groupNames.map((name, i) => (
						<option key={i} value={i}>
							{name || "未分组"}
						</option>
					))}
				</select>
			</label>
			<label className="field">
				<span className="field-label">查找正则</span>
				<input
					className="panel-search"
					placeholder="/\\[.*\\]/g"
					value={draft.findRegex}
					onChange={(e) => setDraft((d) => ({ ...d, findRegex: e.target.value }))}
				/>
				<span className="field-hint">格式 /pattern/flags；裸串默认 flags 为 g。</span>
			</label>
			{invalid && <div className="panel-error">{(validation as { error: string }).error}</div>}
			<label className="field">
				<span className="field-label">替换为</span>
				<textarea
					className="panel-search ta"
					rows={5}
					value={draft.replace}
					onChange={(e) => setDraft((d) => ({ ...d, replace: e.target.value }))}
				/>
				<span className="field-hint">支持 $1…$n、$&、{`{{match}}`}、{`{{char}}`} / {`{{user}}`}。</span>
			</label>
			<label className="cardfront-toggle field-hint" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
				<input
					type="checkbox"
					checked={!draft.off}
					disabled={busy}
					onChange={(e) => setDraft((d) => ({ ...d, off: !e.target.checked }))}
				/>
				启用
			</label>
			<div className="panel-row">
				<button type="button" className="drawer-btn save-btn" disabled={busy || invalid} onClick={() => void onSave()}>
					保存
				</button>
				<button type="button" className="drawer-btn" disabled={busy} onClick={onCancel}>
					取消
				</button>
			</div>
			<div className="rule-trial">
				<div className="trial-head">
					<span className="rule-sec-title">试运行</span>
					<label className="field-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<input type="checkbox" checked={trialSource === "draft"} onChange={() => setTrialSource("draft")} />
						草稿规则
					</label>
					<label className="field-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<input type="checkbox" checked={trialSource === "active"} onChange={() => setTrialSource("active")} />
						全部生效规则
					</label>
				</div>
				<label className="field">
					<span className="field-label">样例文本</span>
					<textarea
						className="panel-search ta"
						rows={3}
						placeholder="粘贴一段 AI 输出…"
						value={sample}
						onChange={(e) => setSample(e.target.value)}
					/>
				</label>
				<label className="field">
					<span className="field-label">输出</span>
					<div className="longtext">{preview}</div>
				</label>
			</div>
		</div>
	);
}

export function RegexPanel({
	toast,
	onFrontChange,
	testTick,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	onFrontChange?: () => void;
	testTick?: number;
}) {
	const { busy, run } = useAction(toast);
	const cards = usePanelData(() => apiGet<CardsResponse>("/api/cards"), { cacheKey: "/api/cards" });

	const [scope, setScope] = useState<RuleScope>("global");
	const [tab, setTab] = useState<TabId>("global");
	const [cardPath, setCardPath] = useState<string>("");
	const [groups, setGroups] = useState<RuleGroup[]>([]);
	const [cardInfo, setCardInfo] = useState<CardInfo | null>(null);
	const [presetInfo, setPresetInfo] = useState<PresetInfo | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [front, setFront] = useState<FrontSnapshot | null>(null);

	const [editorOpen, setEditorOpen] = useState(false);
	const [editingRule, setEditingRule] = useState<{ groupIndex: number; ruleIndex: number | null } | null>(null);
	const [draft, setDraft] = useState<RuleDraft>({ name: "", findRegex: "/(?:)/g", replace: "", off: false });
	const [editorTargetGroup, setEditorTargetGroup] = useState(0);
	const [sample, setSample] = useState("");
	const [trialSource, setTrialSource] = useState<"draft" | "active">("draft");

	// 面板级独立测试区
	const [testMode, setTestMode] = useState<"draft" | "existing" | "active">("draft");
	const [testDraft, setTestDraft] = useState<{ name: string; findRegex: string; replace: string }>({
		name: "",
		findRegex: "/(?:)/g",
		replace: "",
	});
	const [testExistingKey, setTestExistingKey] = useState<string>("");
	const [testSample, setTestSample] = useState("");

	const [expanded, setExpanded] = useState<Set<number>>(new Set());
	const [renaming, setRenaming] = useState<number | null>(null);
	const [renameText, setRenameText] = useState("");
	const [copying, setCopying] = useState<number | null>(null);
	const [copyTargetScope, setCopyTargetScope] = useState<RuleScope>("global");
	const [copyTargetCard, setCopyTargetCard] = useState<string>("");

	// 当前分类生效规则 / 宏（给试运行用）
	const refreshFront = useCallback(async () => {
		try {
			const r = await apiGet<FrontSnapshot>("/api/cardfront", { bypassCache: true });
			setFront(r);
		} catch {
			/* 忽略：试运行可降级为空宏 */
		}
	}, []);

	useEffect(() => {
		void refreshFront();
	}, [refreshFront]);

	useEffect(() => {
		if (testTick && testTick > 0) setTab("test");
	}, [testTick]);

	const fetchGroups = useCallback(
		async (bypass = false) => {
			setLoading(true);
			setError(null);
			try {
				const r = await apiGet<GroupsResponse>(`/api/cardfront/groups${scopeQuery(scope, cardPath)}`, {
					bypassCache: bypass,
				});
				setGroups(r.groups);
				setCardInfo(r.card ?? null);
				setPresetInfo(r.preset ?? null);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[scope, cardPath],
	);

	useEffect(() => {
		void fetchGroups(true);
	}, [fetchGroups]);

	useEffect(() => {
		if (scope === "card" && cards.data?.current && !cardPath) {
			setCardPath(cards.data.current);
		}
	}, [scope, cards.data?.current, cardPath]);

	useEffect(() => {
		setExpanded(new Set(groups.map((_, i) => i)));
	}, [groups.length]);

	useEffect(() => {
		if (editingRule) setEditorTargetGroup(editingRule.groupIndex);
	}, [editingRule?.groupIndex]);

	const afterChange = useCallback(async () => {
		await fetchGroups(true);
		await refreshFront();
		onFrontChange?.();
	}, [fetchGroups, refreshFront, onFrontChange]);

	const createGroup = (name: string) =>
		void run(async () => {
			await apiPost(`/api/cardfront/groups${scopeQuery(scope, cardPath)}`, { name });
			await afterChange();
		}, "已新建组");

	const renameGroup = (index: number, name: string) =>
		void run(async () => {
			await apiPut(`/api/cardfront/groups${scopeQuery(scope, cardPath)}`, { index, group: { name } });
			await afterChange();
		}, "组名已修改");

	const toggleGroupOff = (index: number, off: boolean) =>
		void run(async () => {
			await apiPut(`/api/cardfront/groups${scopeQuery(scope, cardPath)}`, { index, group: { off } });
			await afterChange();
		}, off ? "已关闭组" : "已开启组");

	const deleteGroup = (index: number) =>
		void run(async () => {
			await apiDelete(`/api/cardfront/groups${scopeQuery(scope, cardPath)}&index=${index}`);
			await afterChange();
		}, "已删除组");

	const moveGroup = (index: number, delta: -1 | 1) =>
		void run(async () => {
			await apiPost(`/api/cardfront/groups/move${scopeQuery(scope, cardPath)}`, { index, delta });
			await afterChange();
		}, "组顺序已调整");

	const copyGroup = (fromGroup: number, toScope: RuleScope, toCard?: string) =>
		void run(async () => {
			const body = {
				from: { scope, card: scope === "card" ? cardPath : undefined, group: fromGroup },
				to: { scope: toScope, card: toScope === "card" ? toCard : undefined },
			};
			await apiPost("/api/cardfront/groups/copy", body);
			await afterChange();
		}, `已复制组到${SCOPE_LABEL[toScope]}`);

	const createRule = (groupIndex: number, draft: RuleDraft) =>
		void run(async () => {
			const body = {
				group: groupIndex,
				name: draft.name.trim() || undefined,
				findRegex: draft.findRegex,
				replace: draft.replace,
				off: draft.off,
			};
			await apiPost(`/api/cardfront/rules${scopeQuery(scope, cardPath)}`, body);
			await afterChange();
		}, "已新建规则");

	const updateRule = (groupIndex: number, ruleIndex: number, draft: RuleDraft, toGroup?: number) =>
		void run(async () => {
			const body: Record<string, unknown> = {
				group: groupIndex,
				index: ruleIndex,
				rule: {
					name: draft.name.trim() || undefined,
					findRegex: draft.findRegex,
					replace: draft.replace,
					off: draft.off,
				},
			};
			if (toGroup != null && toGroup !== groupIndex) body.toGroup = toGroup;
			await apiPut(`/api/cardfront/rules${scopeQuery(scope, cardPath)}`, body);
			await afterChange();
		}, "规则已保存");

	const deleteRule = (groupIndex: number, ruleIndex: number) =>
		void run(async () => {
			await apiDelete(`/api/cardfront/rules${scopeQuery(scope, cardPath)}&group=${groupIndex}&index=${ruleIndex}`);
			await afterChange();
		}, "已删除规则");

	const moveRule = (groupIndex: number, ruleIndex: number, delta: -1 | 1) =>
		void run(async () => {
			await apiPost(`/api/cardfront/rules/move${scopeQuery(scope, cardPath)}`, { group: groupIndex, index: ruleIndex, delta });
			await afterChange();
		}, "规则顺序已调整");

	const toggleRule = (groupIndex: number, ruleIndex: number, rule: RuleItem) =>
		void run(async () => {
			const body = {
				group: groupIndex,
				index: ruleIndex,
				rule: {
					name: rule.name || undefined,
					findRegex: formatFindRegex(rule),
					replace: rule.replace,
					off: !rule.off,
				},
			};
			await apiPut(`/api/cardfront/rules${scopeQuery(scope, cardPath)}`, body);
			await afterChange();
		}, "规则状态已更新");

	const toggleCardRule = (key: string, off: boolean) =>
		void run(async () => {
			await apiPut("/api/cardfront/rule-off", { key, off });
			await afterChange();
		}, off ? "已关闭卡内嵌规则" : "已开启卡内嵌规则");

	const openNewRule = (groupIndex: number) => {
		setEditingRule({ groupIndex, ruleIndex: null });
		setDraft({ name: "", findRegex: "/(?:)/g", replace: "", off: false });
		setSample("");
		setTrialSource("draft");
		setEditorOpen(true);
	};

	const openEditRule = (groupIndex: number, ruleIndex: number, rule: RuleItem) => {
		setEditingRule({ groupIndex, ruleIndex });
		setDraft({ name: rule.name || "", findRegex: formatFindRegex(rule), replace: rule.replace, off: !!rule.off });
		setSample("");
		setTrialSource("draft");
		setEditorOpen(true);
	};

	const saveDraft = () => {
		const validation = parseFindRegex(draft.findRegex);
		if ("error" in validation) return;
		if (!editingRule) return;
		if (editingRule.ruleIndex == null) {
			createRule(editorTargetGroup, draft);
		} else {
			updateRule(editingRule.groupIndex, editingRule.ruleIndex, draft, editorTargetGroup);
		}
		setEditorOpen(false);
	};

	const groupNames = useMemo(() => groups.map((g) => g.name), [groups]);
	const locked = scope === "preset" && !presetInfo;

	const testValidation = useMemo(() => parseFindRegex(testDraft.findRegex), [testDraft.findRegex]);
	const testInvalid = "error" in testValidation;
	const testError = testInvalid ? (testValidation as { error: string }).error : "";

	const existingOptions = useMemo(() => {
		const opts: { key: string; label: string; rule: DisplayRule }[] = [];
		groups.forEach((g, gi) => {
			g.rules.forEach((r, ri) => {
				opts.push({
					key: `group-${gi}-${ri}`,
					label: `${g.name || "未分组"} / ${r.name || "未命名 #" + (ri + 1)}`,
					rule: r,
				});
			});
		});
		if (cardInfo) {
			cardInfo.cardRules.forEach((r, i) => {
				opts.push({
					key: `card-${i}`,
					label: `卡内嵌 / ${r.name || "未命名 #" + (i + 1)}`,
					rule: r,
				});
			});
		}
		return opts;
	}, [groups, cardInfo]);

	const selectedExistingRule = useMemo(() => {
		if (testMode !== "existing") return null;
		return existingOptions.find((o) => o.key === testExistingKey)?.rule ?? null;
	}, [testMode, testExistingKey, existingOptions]);

	useEffect(() => {
		if (testMode === "existing" && !existingOptions.some((o) => o.key === testExistingKey)) {
			setTestExistingKey(existingOptions[0]?.key ?? "");
		}
	}, [testMode, existingOptions, testExistingKey]);

	const macros = useMemo(() => ({ charName: front?.charName ?? "", userName: front?.userName ?? "" }), [front]);

	const testOutput = useMemo(() => {
		if (!testSample.trim()) return "输入样例文本以查看效果";
		try {
			let rules: DisplayRule[];
			if (testMode === "draft") {
				if (testInvalid) return `正则无效：${testError}`;
				rules = [
					{
						name: testDraft.name || "草稿",
						source: (testValidation as { source: string; flags: string }).source,
						flags: (testValidation as { source: string; flags: string }).flags,
						replace: testDraft.replace,
					},
				];
			} else if (testMode === "existing") {
				if (!selectedExistingRule) return "请选择一条现有规则";
				rules = [selectedExistingRule];
			} else {
				rules = front?.rules ?? [];
			}
			return applyCardSkin(testSample, rules, macros);
		} catch (e) {
			return `应用出错：${e instanceof Error ? e.message : String(e)}`;
		}
	}, [testMode, testDraft, testExistingKey, testSample, testInvalid, testError, testValidation, selectedExistingRule, front, macros]);

	return (
		<div className="panel-body">
			<div className="regex-tabs">
				{(["global", "card", "preset"] as RuleScope[]).map((t) => (
					<button
						key={t}
						type="button"
						className={`regex-tab ${tab === t ? "active" : ""}`}
						onClick={() => {
							setTab(t);
							setScope(t);
						}}
					>
						{TAB_LABEL[t]}
					</button>
				))}
			</div>

			{tab !== "test" && (
				<>
					{scope === "card" && (
						<div className="panel-row" style={{ marginBottom: 10 }}>
							<select
								className="panel-search"
								value={cardPath}
								disabled={busy}
								onChange={(e) => setCardPath(e.target.value)}
								aria-label="选择角色卡"
							>
						{cards.data?.cards.map((c) => (
							<option key={c.path} value={c.path}>
								{c.name}
							</option>
						))}
					</select>
				</div>
			)}

			{scope === "preset" && (
				<div className="field-hint" style={{ marginBottom: 10 }}>
					{presetInfo ? `当前预设：${presetInfo.name}` : "尚未选择预设：请先到左侧「预设」面板选择或创建"}
				</div>
			)}

			<PanelStatus loading={loading} error={error} hasData={groups.length > 0 || !!cardInfo || !!presetInfo} />

			{scope === "card" && cardInfo && cardInfo.cardRules.length > 0 && (
				<div className="rule-section">
					<div className="rule-sec-title">卡内嵌规则</div>
					{cardInfo.cardRules.map((r, i) => {
						const key = ruleKey(r);
						const on = !cardInfo.ruleOff.includes(key);
						return (
							<div key={key} className="rule-row rule-row-readonly">
								<div className="rule-row-main">
									<span className="rule-name">{r.name || `未命名 #${i + 1}`}</span>
									<span className="rule-regex">{formatFindRegex(r)}</span>
									<span className="rule-replace">{replaceSummary(r.replace)}</span>
								</div>
								<label className="rule-switch">
									<input
										type="checkbox"
										checked={on}
										disabled={busy}
										onChange={() => void toggleCardRule(key, !on)}
									/>
									<span>{on ? "开" : "关"}</span>
								</label>
							</div>
						);
					})}
				</div>
			)}

			<div className="rule-section">
				<div className="rule-sec-head">
					<span className="rule-sec-title">正则组</span>
					<button
						type="button"
						className="act"
						disabled={busy || locked}
						onClick={() => {
							const name = window.prompt("新组名称");
							if (name?.trim()) createGroup(name.trim());
						}}
					>
						＋ 新建组
					</button>
				</div>
				{groups.length === 0 && !loading && <div className="field-hint">暂无正则组。</div>}
				{groups.map((g, gi) => {
					const isUngrouped = g.name === "";
					return (
						<div key={`${g.name}-${gi}`} className={`rule-group ${g.off ? "off" : ""}`}>
							<div className="rule-group-head">
								<button
									type="button"
									className="group-caret"
									onClick={() =>
										setExpanded((prev) => {
											const next = new Set(prev);
											if (next.has(gi)) next.delete(gi);
											else next.add(gi);
											return next;
										})
									}
								>
									{expanded.has(gi) ? "▾" : "▸"}
								</button>
								{renaming === gi ? (
									<>
										<input
											className="panel-search"
											value={renameText}
											onChange={(e) => setRenameText(e.target.value)}
										/>
										<button
											type="button"
											className="act"
											disabled={busy || locked}
											onClick={() => {
												renameGroup(gi, renameText);
												setRenaming(null);
											}}
										>
											保存
										</button>
										<button type="button" className="act" onClick={() => setRenaming(null)}>
											取消
										</button>
									</>
								) : (
									<span
										className="rule-group-name"
										onClick={() =>
											setExpanded((prev) => {
												const next = new Set(prev);
												if (next.has(gi)) next.delete(gi);
												else next.add(gi);
												return next;
											})
										}
									>
										{g.name || "未分组"}
									</span>
								)}
								<Toggle
									checked={!g.off}
									disabled={busy || locked}
									onChange={(v) => void toggleGroupOff(gi, !v)}
									title={g.off ? "整组已禁用" : "整组启用中"}
								/>
								{renaming !== gi && (
									<button
										type="button"
										className="act"
										disabled={busy || locked || isUngrouped}
										onClick={() => {
											setRenaming(gi);
											setRenameText(g.name);
										}}
									>
										重命名
									</button>
								)}
								<button
									type="button"
									className="act"
									disabled={busy || locked}
									onClick={() => {
										setCopying(gi);
										setCopyTargetScope("global");
										setCopyTargetCard(cards.data?.current ?? "");
									}}
								>
									复制到
								</button>
								{!isUngrouped && (
									<ConfirmButton
										className="act"
										disabled={busy || locked}
										confirmText="确认删除组与组内全部规则"
										onConfirm={() => void deleteGroup(gi)}
									>
										删除
									</ConfirmButton>
								)}
								<button
									type="button"
									className="act"
									disabled={busy || locked}
									title="上移"
									onClick={() => void moveGroup(gi, -1)}
								>
									↑
								</button>
								<button
									type="button"
									className="act"
									disabled={busy || locked}
									title="下移"
									onClick={() => void moveGroup(gi, 1)}
								>
									↓
								</button>
								<button
									type="button"
									className="act"
									disabled={busy || locked}
									onClick={() => void openNewRule(gi)}
								>
									＋ 规则
								</button>
							</div>
							{copying === gi && (
								<div className="copy-target-menu">
									<span className="field-hint">复制到：</span>
									<select
										className="panel-search"
										style={{ width: "auto", flex: "1 1 100px" }}
										value={copyTargetScope}
										onChange={(e) => setCopyTargetScope(e.target.value as RuleScope)}
									>
										<option value="global">全局</option>
										<option value="card">角色</option>
										<option value="preset">预设</option>
									</select>
									{copyTargetScope === "card" && (
										<select
											className="panel-search"
											style={{ width: "auto", flex: "2 1 140px" }}
											value={copyTargetCard}
											onChange={(e) => setCopyTargetCard(e.target.value)}
										>
											{cards.data?.cards.map((c) => (
												<option key={c.path} value={c.path}>
													{c.name}
												</option>
											))}
										</select>
									)}
									<button
										type="button"
										className="act"
										disabled={busy}
										onClick={() => {
											void copyGroup(gi, copyTargetScope, copyTargetScope === "card" ? copyTargetCard : undefined);
											setCopying(null);
										}}
									>
										确认
									</button>
									<button type="button" className="act" onClick={() => setCopying(null)}>
										取消
									</button>
								</div>
							)}
							{expanded.has(gi) && (
								<div className="rule-group-body">
									{g.rules.length === 0 && <div className="field-hint">组内暂无规则。</div>}
									{g.rules.map((r, ri) => {
										const rule = r as RuleItem;
										const on = !rule.off;
										return (
											<div key={`${ruleKey(rule)}-${ri}`} className="rule-row">
												<div className="rule-row-main">
													<span className="rule-name">{rule.name || `未命名 #${ri + 1}`}</span>
													<span className="rule-regex">{formatFindRegex(rule)}</span>
													<span className="rule-replace">{replaceSummary(rule.replace)}</span>
												</div>
												<div className="rule-row-acts">
													<Toggle
														checked={on}
														disabled={busy || locked}
														onChange={() => void toggleRule(gi, ri, rule)}
														title={on ? "启用中" : "已禁用"}
													/>
													<button
														type="button"
														className="act"
														disabled={busy || locked}
														onClick={() => void openEditRule(gi, ri, rule)}
													>
														编辑
													</button>
													<ConfirmButton
														className="act"
														disabled={busy || locked}
														confirmText="确认删除"
														onConfirm={() => void deleteRule(gi, ri)}
													>
														删除
													</ConfirmButton>
													<button
														type="button"
														className="act"
														disabled={busy || locked}
														title="上移"
														onClick={() => void moveRule(gi, ri, -1)}
													>
														↑
													</button>
													<button
														type="button"
														className="act"
														disabled={busy || locked}
														title="下移"
														onClick={() => void moveRule(gi, ri, 1)}
													>
														↓
													</button>
												</div>
											</div>
										);
									})}
								</div>
							)}
						</div>
					);
				})}
			</div>

					{editorOpen && (
						<RuleEditor
							editing={editingRule?.ruleIndex != null}
							draft={draft}
							setDraft={setDraft}
							groupNames={groupNames}
							targetGroup={editorTargetGroup}
							setTargetGroup={setEditorTargetGroup}
							onSave={saveDraft}
							onCancel={() => setEditorOpen(false)}
							busy={busy}
							sample={sample}
							setSample={setSample}
							trialSource={trialSource}
							setTrialSource={setTrialSource}
							previewRules={front?.rules ?? []}
							macros={{ charName: front?.charName ?? "", userName: front?.userName ?? "" }}
						/>
					)}
				</>
			)}

			{tab === "test" && (
				<div className="rule-trial regex-test-area">
					<div className="rule-sec-title" style={{ marginBottom: 8 }}>
						正则测试
					</div>
					<div className="panel-row" style={{ alignItems: "center", flexWrap: "wrap" }}>
						<label className="field-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
							<input
								type="radio"
								name="regex-test-mode"
								checked={testMode === "draft"}
								onChange={() => setTestMode("draft")}
							/>
							草稿规则
						</label>
						<label className="field-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
							<input
								type="radio"
								name="regex-test-mode"
								checked={testMode === "existing"}
								onChange={() => setTestMode("existing")}
							/>
							现有规则
						</label>
						<label className="field-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
							<input
								type="radio"
								name="regex-test-mode"
								checked={testMode === "active"}
								onChange={() => setTestMode("active")}
							/>
							全部生效规则
						</label>
					</div>

					{testMode === "draft" && (
						<>
							<label className="field">
								<span className="field-label">名称（可选）</span>
								<input
									className="panel-search"
									placeholder="规则名称"
									value={testDraft.name}
									onChange={(e) => setTestDraft((d) => ({ ...d, name: e.target.value }))}
								/>
							</label>
							<label className="field">
								<span className="field-label">查找正则</span>
								<input
									className="panel-search"
									placeholder="/\\[.*\\]/g"
									value={testDraft.findRegex}
									onChange={(e) => setTestDraft((d) => ({ ...d, findRegex: e.target.value }))}
								/>
								<span className="field-hint">格式 /pattern/flags；裸串默认 flags 为 g。</span>
							</label>
							{testInvalid && <div className="panel-error">{testError}</div>}
							<label className="field">
								<span className="field-label">替换为</span>
								<textarea
									className="panel-search ta"
									rows={3}
									value={testDraft.replace}
									onChange={(e) => setTestDraft((d) => ({ ...d, replace: e.target.value }))}
								/>
							</label>
						</>
					)}

					{testMode === "existing" && (
						<label className="field">
							<span className="field-label">选择规则</span>
							<select
								className="panel-search"
								value={testExistingKey}
								onChange={(e) => setTestExistingKey(e.target.value)}
							>
								{existingOptions.length === 0 && <option value="">暂无可用规则</option>}
								{existingOptions.map((o) => (
									<option key={o.key} value={o.key}>
										{o.label}
									</option>
								))}
							</select>
							{selectedExistingRule && (
								<span className="field-hint">
									{formatFindRegex(selectedExistingRule)} → {replaceSummary(selectedExistingRule.replace)}
								</span>
							)}
						</label>
					)}

					{testMode === "active" && (
						<div className="field-hint">含卡内嵌/全局/角色/预设全部生效规则</div>
					)}

					<label className="field">
						<span className="field-label">样例文本</span>
						<textarea
							className="panel-search ta"
							rows={4}
							placeholder="粘贴一段 AI 输出…"
							value={testSample}
							onChange={(e) => setTestSample(e.target.value)}
						/>
					</label>
					<label className="field">
						<span className="field-label">输出</span>
						<div className="longtext">{testOutput}</div>
					</label>
				</div>
			)}
		</div>
	);
}
