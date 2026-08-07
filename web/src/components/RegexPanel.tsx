/**
 * 正则脚本面板（左侧独立面板）：
 * 全局 / 角色 / 预设 三分类，支持分组管理、规则 CRUD/排序/复制、试运行。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, downloadJson, type CardsResponse } from "../api.ts";
import { isRuleOff, ruleKey, type DisplayRule, type RuleGroup } from "../../../src/cardfront.ts";
import { applyCardSkin } from "../cardSkin.ts";
import { ConfirmButton, PanelStatus, Toggle, useAction, usePanelData } from "./kit.tsx";
import { RegexDebugger } from "./RegexDebugger.tsx";

type RuleScope = "global" | "card" | "preset";
type TabId = RuleScope | "test";
type TestSubTab = "test" | "debug";

interface CardInfo {
	path: string;
	cardRules: DisplayRule[];
	ruleOff: string[];
	/** 当前卡被覆盖的规则键列表（卡内嵌规则展示的是覆盖生效后的版本） */
	overrides: string[];
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

/** 编辑器目标：组规则（新建/编辑）或卡内嵌规则（编辑），保存时按目标分派 */
type EditingTarget =
	| { kind: "group"; groupIndex: number; ruleIndex: number | null }
	| { kind: "card"; key: string };

type RuleDraft = {
	name: string;
	findRegex: string;
	replace: string;
	disabled: boolean;
	trimStrings: string;
	placement: number[];
	runOnEdit: boolean;
	substituteRegex: 0 | 1 | 2;
	minDepth: string;
	maxDepth: string;
	markdownOnly: boolean;
	promptOnly: boolean;
};

/** 新建规则默认值：作用范围缺省 [2]=AI 输出，其余字段缺省 */
const DEFAULT_DRAFT: RuleDraft = {
	name: "",
	findRegex: "/(?:)/g",
	replace: "",
	disabled: false,
	trimStrings: "",
	placement: [2],
	runOnEdit: false,
	substituteRegex: 0,
	minDepth: "",
	maxDepth: "",
	markdownOnly: false,
	promptOnly: false,
};

type SetDraft = (v: RuleDraft | ((prev: RuleDraft) => RuleDraft)) => void;

const SCOPE_LABEL: Record<RuleScope, string> = { global: "全局", card: "角色", preset: "预设" };
const TAB_LABEL: Record<Exclude<TabId, "test">, string> = { global: "全局", card: "角色", preset: "预设" };

/** 作用范围枚举（与 ST placement 一致）：1=用户输入/2=AI输出/3=快捷命令/5=世界信息/6=推理 */
const PLACEMENT_LABEL: Record<number, string> = { 1: "用户输入", 2: "AI输出", 3: "快捷命令", 5: "世界信息", 6: "推理" };
const PLACEMENT_OPTS: Array<{ v: number; label: string }> = [
	{ v: 1, label: "用户输入" },
	{ v: 2, label: "AI输出" },
	{ v: 3, label: "快捷命令" },
	{ v: 5, label: "世界信息" },
	{ v: 6, label: "推理" },
];

/** 查找时宏档位：0=不替换宏 1=raw 2=escaped（缺省按旧行为=转义） */
const SUBSTITUTE_OPTS: Array<{ v: 0 | 1 | 2; label: string }> = [
	{ v: 0, label: "不替换" },
	{ v: 1, label: "替换为原始值" },
	{ v: 2, label: "替换为转义值" },
];

function formatFindRegex(rule: DisplayRule): string {
	return `/${rule.source}/${rule.flags}`;
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

/** 草稿「修剪掉」文本 → 提交数组（按回车切分、trim 后去空行） */
function draftTrimList(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** 草稿深度输入 → number|null（空=无限；负数/非数一律视为空，由 UI 阻止负数） */
function draftDepth(text: string): number | null {
	const t = text.trim();
	if (!t) return null;
	const n = Number(t);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 单条规则全字段 PUT 载荷（翻转开关时也把其余新字段带上，避免写回时丢失） */
function rulePutBody(rule: RuleItem, disabled?: boolean): Record<string, unknown> {
	return {
		name: rule.name || undefined,
		findRegex: formatFindRegex(rule),
		replace: rule.replace,
		disabled: disabled ?? isRuleOff(rule),
		trimStrings: rule.trimStrings ?? [],
		placement: rule.placement && rule.placement.length ? rule.placement : [2],
		runOnEdit: rule.runOnEdit === true,
		substituteRegex: rule.substituteRegex ?? 0,
		minDepth: rule.minDepth ?? null,
		maxDepth: rule.maxDepth ?? null,
		markdownOnly: rule.markdownOnly === true,
		promptOnly: rule.promptOnly === true,
	};
}

/** 草稿 → 全字段规则载荷（POST/PUT 共用） */
function draftToBody(draft: RuleDraft): Record<string, unknown> {
	return {
		name: draft.name.trim() || undefined,
		findRegex: draft.findRegex,
		replace: draft.replace,
		disabled: draft.disabled,
		trimStrings: draftTrimList(draft.trimStrings),
		placement: draft.placement,
		runOnEdit: draft.runOnEdit,
		substituteRegex: draft.substituteRegex,
		minDepth: draftDepth(draft.minDepth),
		maxDepth: draftDepth(draft.maxDepth),
		markdownOnly: draft.markdownOnly,
		promptOnly: draft.promptOnly,
	};
}

/** 规则 → 草稿（编辑回填；组规则与卡内嵌规则共用） */
function draftFromRule(rule: DisplayRule): RuleDraft {
	return {
		name: rule.name || "",
		findRegex: formatFindRegex(rule),
		replace: rule.replace,
		disabled: isRuleOff(rule),
		trimStrings: (rule.trimStrings ?? []).join("\n"),
		placement: rule.placement && rule.placement.length ? rule.placement : [2],
		runOnEdit: rule.runOnEdit === true,
		substituteRegex: rule.substituteRegex ?? 0,
		minDepth: rule.minDepth == null ? "" : String(rule.minDepth),
		maxDepth: rule.maxDepth == null ? "" : String(rule.maxDepth),
		markdownOnly: rule.markdownOnly === true,
		promptOnly: rule.promptOnly === true,
	};
}

/** 导出单条 ST/TT 兼容脚本（平铺字段名），供导入 ST/TT 使用 */
function exportScript(rule: RuleItem): Record<string, unknown> {
	const out: Record<string, unknown> = {
		scriptName: rule.name,
		findRegex: formatFindRegex(rule),
		replaceString: rule.replace,
	};
	if (rule.trimStrings && rule.trimStrings.length > 0) out.trimStrings = rule.trimStrings;
	if (rule.placement && rule.placement.length > 0) out.placement = rule.placement;
	if (isRuleOff(rule)) out.disabled = true;
	if (rule.markdownOnly) out.markdownOnly = true;
	if (rule.promptOnly) out.promptOnly = true;
	if (rule.runOnEdit) out.runOnEdit = true;
	if (rule.substituteRegex != null && rule.substituteRegex !== 0) out.substituteRegex = rule.substituteRegex;
	if (rule.minDepth != null) out.minDepth = rule.minDepth;
	if (rule.maxDepth != null) out.maxDepth = rule.maxDepth;
	return out;
}

/** 规则行摘要 chips：修剪×N / 作用范围 / 仅格式显示 / 仅格式提示词 / 深度 a–b */
function RuleChips({ rule }: { rule: RuleItem }) {
	const chips: string[] = [];
	if (rule.trimStrings && rule.trimStrings.length > 0) chips.push(`修剪×${rule.trimStrings.length}`);
	const placement = rule.placement && rule.placement.length ? rule.placement : [2];
	const nonDefault = placement.length === 1 && placement[0] === 2 ? [] : placement;
	if (nonDefault.length > 0) chips.push(nonDefault.map((p) => PLACEMENT_LABEL[p] ?? String(p)).join("/"));
	if (rule.markdownOnly) chips.push("仅格式显示");
	if (rule.promptOnly) chips.push("仅格式提示词");
	const min = rule.minDepth ?? null;
	const max = rule.maxDepth ?? null;
	if (min != null || max != null) {
		chips.push(`深度 ${min != null && max != null ? `${min}–${max}` : min != null ? `${min}+` : `≤${max}`}`);
	}
	if (chips.length === 0) return null;
	return (
		<div className="rule-row-chips">
			{chips.map((c) => (
				<span key={c} className="chip">
					{c}
				</span>
			))}
		</div>
	);
}

/** 导入文件解析出的单条规则（ST 平铺 / 本工具包格式两种来源） */
interface ImportedRule {
	scriptName?: string;
	findRegex?: string;
	replaceString?: string;
	trimStrings?: string[];
	placement?: number[];
	disabled?: boolean;
	markdownOnly?: boolean;
	promptOnly?: boolean;
	runOnEdit?: boolean;
	substituteRegex?: 0 | 1 | 2;
	minDepth?: number | null;
	maxDepth?: number | null;
}

interface ImportPayload {
	kind: "flat" | "grouped";
	flat?: ImportedRule[];
	groups?: Array<{ name: string; scripts: ImportedRule[] }>;
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
	hideGroup,
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
	/** 隐藏「归属组」选择（卡内嵌规则编辑 / 空组新建时归属不可选） */
	hideGroup?: boolean;
}) {
	const validation = useMemo(() => parseFindRegex(draft.findRegex), [draft.findRegex]);
	const invalid = "error" in validation;
	const placementEmpty = draft.placement.length === 0;

	/** 深度输入：空=无限；负数/非数拒绝（保持原值） */
	const setDepth = (key: "minDepth" | "maxDepth", raw: string) => {
		if (raw === "") {
			setDraft((d) => ({ ...d, [key]: "" }));
			return;
		}
		const n = Number(raw);
		if (!Number.isFinite(n) || n < 0) return;
		setDraft((d) => ({ ...d, [key]: String(Math.trunc(n)) }));
	};

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
					disabled: draft.disabled,
					trimStrings: draftTrimList(draft.trimStrings),
					placement: draft.placement,
					runOnEdit: draft.runOnEdit,
					substituteRegex: draft.substituteRegex,
					minDepth: draftDepth(draft.minDepth),
					maxDepth: draftDepth(draft.maxDepth),
					markdownOnly: draft.markdownOnly,
					promptOnly: draft.promptOnly,
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
			{!hideGroup && (
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
			)}
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
			<label className="field">
				<span className="field-label">修剪掉</span>
				<textarea
					className="panel-search ta"
					rows={3}
					placeholder="每行一个需要剔除的片段"
					value={draft.trimStrings}
					onChange={(e) => setDraft((d) => ({ ...d, trimStrings: e.target.value }))}
				/>
				<span className="field-hint">用回车分隔多个片段；应用本规则前会先从捕获值中剔除这些内容，可含 {`{{char}}`} / {`{{user}}`}。</span>
			</label>

			<div className="field">
				<span className="field-label">作用范围</span>
				<div className="check-grid">
					{PLACEMENT_OPTS.map((o) => (
						<label key={o.v}>
							<input
								type="checkbox"
								checked={draft.placement.includes(o.v)}
								onChange={(e) =>
									setDraft((d) => {
										const has = d.placement.includes(o.v);
										return { ...d, placement: has ? d.placement.filter((p) => p !== o.v) : [...d.placement, o.v] };
									})
								}
							/>
							{o.label}
						</label>
					))}
				</div>
				{placementEmpty && <div className="panel-error">至少勾选一个作用范围。</div>}
			</div>

			<label className="cardfront-toggle field-hint" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
				<input
					type="checkbox"
					checked={draft.disabled}
					disabled={busy}
					onChange={(e) => setDraft((d) => ({ ...d, disabled: e.target.checked }))}
				/>
				已禁用
			</label>

			<label className="cardfront-toggle field-hint" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
				<input
					type="checkbox"
					checked={draft.runOnEdit}
					disabled={busy}
					onChange={(e) => setDraft((d) => ({ ...d, runOnEdit: e.target.checked }))}
				/>
				在编辑时运行
			</label>

			<label className="field">
				<span className="field-label">查找时宏</span>
				<select
					className="panel-search"
					value={draft.substituteRegex}
					onChange={(e) => setDraft((d) => ({ ...d, substituteRegex: Number(e.target.value) as 0 | 1 | 2 }))}
				>
					{SUBSTITUTE_OPTS.map((o) => (
						<option key={o.v} value={o.v}>
							{o.label}
						</option>
					))}
				</select>
				<span className="field-hint">查找正则中的 {`{{char}}`} / {`{{user}}`} 宏处理方式；默认按转义值（正则安全）。</span>
			</label>

			<div className="field">
				<span className="field-label">最小深度 / 最大深度</span>
				<div className="depth-row">
					<input
						className="panel-search num"
						type="number"
						min={0}
						placeholder="不限"
						value={draft.minDepth}
						onChange={(e) => setDepth("minDepth", e.target.value)}
					/>
					<span className="dash">–</span>
					<input
						className="panel-search num"
						type="number"
						min={0}
						placeholder="不限"
						value={draft.maxDepth}
						onChange={(e) => setDepth("maxDepth", e.target.value)}
					/>
				</div>
				<span className="field-hint">空 = 无限；不接受负数。</span>
			</div>

			<div className="field">
				<span className="field-label">短暂</span>
				<div className="check-grid">
					<label>
						<input
							type="checkbox"
							checked={draft.markdownOnly}
							onChange={(e) => setDraft((d) => ({ ...d, markdownOnly: e.target.checked }))}
						/>
						仅格式显示
					</label>
					<label>
						<input
							type="checkbox"
							checked={draft.promptOnly}
							onChange={(e) => setDraft((d) => ({ ...d, promptOnly: e.target.checked }))}
						/>
						仅格式提示词
					</label>
				</div>
			</div>

			<div className="panel-row">
				<button type="button" className="drawer-btn save-btn" disabled={busy || invalid || placementEmpty} onClick={() => void onSave()}>
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
	const [editingRule, setEditingRule] = useState<EditingTarget | null>(null);
	const [draft, setDraft] = useState<RuleDraft>({ ...DEFAULT_DRAFT });
	const [editorTargetGroup, setEditorTargetGroup] = useState(0);
	const [sample, setSample] = useState("");
	const [trialSource, setTrialSource] = useState<"draft" | "active">("draft");

	// 面板级独立测试区
	const [testSubTab, setTestSubTab] = useState<TestSubTab>("test");
	const [testMode, setTestMode] = useState<"draft" | "existing" | "active">("draft");
	const [testDraft, setTestDraft] = useState<{ name: string; findRegex: string; replace: string }>({
		name: "",
		findRegex: "/(?:)/g",
		replace: "",
	});
	const [testExistingKey, setTestExistingKey] = useState<string>("");
	const [testSample, setTestSample] = useState("");

	// 导入 JSON：文件解析后暂存，选择目标作用域再逐条 POST
	const [importPending, setImportPending] = useState<ImportPayload | null>(null);
	const [importTargetScope, setImportTargetScope] = useState<RuleScope>("global");
	const [importTargetCard, setImportTargetCard] = useState<string>("");

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
		if (testTick && testTick > 0) {
			setTab("test");
			setTestSubTab("test");
		}
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
		if (editingRule?.kind === "group") setEditorTargetGroup(editingRule.groupIndex);
	}, [editingRule]);

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
			await apiPost(`/api/cardfront/rules${scopeQuery(scope, cardPath)}`, { group: groupIndex, ...draftToBody(draft) });
			await afterChange();
		}, "已新建规则");

	const updateRule = (groupIndex: number, ruleIndex: number, draft: RuleDraft, toGroup?: number) =>
		void run(async () => {
			const body: Record<string, unknown> = {
				group: groupIndex,
				index: ruleIndex,
				rule: draftToBody(draft),
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
			await apiPut(`/api/cardfront/rules${scopeQuery(scope, cardPath)}`, {
				group: groupIndex,
				index: ruleIndex,
				rule: rulePutBody(rule, !isRuleOff(rule)),
			});
			await afterChange();
		}, "规则状态已更新");

	const toggleCardRule = (key: string, off: boolean) =>
		void run(async () => {
			await apiPut("/api/cardfront/rule-off", { key, off });
			await afterChange();
		}, off ? "已关闭卡内嵌规则" : "已开启卡内嵌规则");

	/** 保存/覆盖一条卡内嵌规则（PUT /api/cardfront/cardrule；key=编辑前规则键，改名不改键） */
	const saveCardRule = (key: string, draft: RuleDraft) =>
		void run(async () => {
			await apiPut("/api/cardfront/cardrule", { key, rule: draftToBody(draft) });
			await afterChange();
		}, "规则已保存");

	/** 还原卡内嵌规则为卡原始版本（DELETE /api/cardfront/cardrule） */
	const restoreCardRule = (key: string) =>
		void run(async () => {
			await apiDelete(`/api/cardfront/cardrule?key=${encodeURIComponent(key)}`);
			await afterChange();
		}, "已还原为卡原始规则");

	// ---- P5a 导入 / 导出 ----

	/** 导出当前作用域的组 + 规则（ST/TT 兼容脚本数组；组信息作包容器） */
	const doExport = () => {
		const count = totalRules;
		const data = {
			version: 1,
			source: "liyuan",
			groups: groups.map((g) => ({
				name: g.name,
				...(g.off ? { off: true } : {}),
				scripts: g.rules.map((r) => exportScript(r as RuleItem)),
			})),
		};
		const slug =
			scope === "card"
				? (cardPath.split(/[\\/]/).pop() ?? "card").replace(/\.[^.]*$/, "") || "card"
				: scope;
		downloadJson(`regex-${slug}.json`, data);
		toast("info", `已导出 ${count} 条规则`);
	};

	/** 文件选择 → 解析为 ST 平铺数组或本工具包格式 */
	const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		void (async () => {
			try {
				const text = await file.text();
				const data: unknown = JSON.parse(text);
				if (Array.isArray(data)) {
					// ST/TT 平铺脚本数组
					const rules = data.filter((s): s is ImportedRule => !!s && typeof s === "object");
					if (rules.length === 0) {
						toast("error", "文件里没有可导入的规则");
						return;
					}
					setImportPending({ kind: "flat", flat: rules });
				} else if (data && typeof data === "object" && Array.isArray((data as { groups?: unknown }).groups)) {
					// 本工具导出包格式：{ groups: [{ name, off, scripts }] }
					const groupsRaw = (data as { groups: Array<{ name?: unknown; off?: unknown; scripts?: unknown }> }).groups;
					const groupsOut = groupsRaw.map((g) => ({
						name: typeof g.name === "string" ? g.name : "",
						scripts: Array.isArray(g.scripts)
							? g.scripts.filter((s): s is ImportedRule => !!s && typeof s === "object")
							: [],
					}));
					const count = groupsOut.reduce((n, g) => n + g.scripts.length, 0);
					if (count === 0) {
						toast("error", "文件里没有可导入的规则");
						return;
					}
					setImportPending({ kind: "grouped", groups: groupsOut });
				} else {
					toast("error", "无法识别的导入文件格式");
					return;
				}
				setImportTargetScope(scope);
				setImportTargetCard(cardPath);
			} catch {
				toast("error", "导入文件解析失败（不是合法 JSON）");
			} finally {
				e.target.value = "";
			}
		})();
	};

	/** 逐条 POST 一条导入规则（ST 字段名 → 接口字段名） */
	const postImportedRule = async (q: string, group: number, s: ImportedRule) => {
		const findRegex = (s.findRegex ?? "").trim();
		if (!findRegex) throw new Error("缺少 findRegex");
		const parsed = parseFindRegex(findRegex);
		if ("error" in parsed) throw new Error("正则无效");
		await apiPost(`/api/cardfront/rules${q}`, {
			group,
			name: (s.scriptName ?? "").trim() || undefined,
			findRegex,
			replace: s.replaceString ?? "",
			disabled: s.disabled === true,
			trimStrings: Array.isArray(s.trimStrings) ? s.trimStrings : [],
			placement: Array.isArray(s.placement) && s.placement.length > 0 ? s.placement : [2],
			runOnEdit: s.runOnEdit === true,
			substituteRegex: s.substituteRegex ?? 0,
			minDepth: s.minDepth ?? null,
			maxDepth: s.maxDepth ?? null,
			markdownOnly: s.markdownOnly === true,
			promptOnly: s.promptOnly === true,
		});
	};

	/** 确认导入：先按目标作用域建/找组，再逐条 POST（串行，避免写并发） */
	const doImport = () =>
		void run(async () => {
			const pending = importPending;
			if (!pending) return;
			const total = pending.kind === "flat" ? (pending.flat ?? []).length : (pending.groups ?? []).reduce((n, g) => n + g.scripts.length, 0);
			if (!window.confirm(`将导入 ${total} 条规则到「${SCOPE_LABEL[importTargetScope]}」作用域，确认继续？`)) return;
			const q = importTargetScope === "card" ? `?scope=card&card=${encodeURIComponent(importTargetCard)}` : `?scope=${importTargetScope}`;
			try {
				// 目标作用域当前组（按名字映射索引；未分组 name="" 恒为组 0）
				const target = await apiGet<GroupsResponse>(`/api/cardfront/groups${q}`, { bypassCache: true });
				const nameToIndex = new Map(target.groups.map((g, i) => [g.name, i]));
				let ok = 0;
				let fail = 0;
				if (pending.kind === "flat") {
					for (const s of pending.flat ?? []) {
						try {
							await postImportedRule(q, 0, s);
							ok++;
						} catch {
							fail++;
						}
					}
				} else {
					for (const g of pending.groups ?? []) {
						let gi = nameToIndex.get(g.name);
						if (gi == null) {
							const created = await apiPost<{ ok: boolean; groups: RuleGroup[] }>(`/api/cardfront/groups${q}`, { name: g.name });
							gi = created.groups.length - 1;
							nameToIndex.set(g.name, gi);
						}
						for (const s of g.scripts) {
							try {
								await postImportedRule(q, gi, s);
								ok++;
							} catch {
								fail++;
							}
						}
					}
				}
				setImportPending(null);
				await afterChange();
				toast(fail > 0 ? "warning" : "info", fail > 0 ? `导入完成：成功 ${ok} 条，失败 ${fail} 条` : `已导入 ${ok} 条规则`);
			} catch (e) {
				toast("error", e instanceof Error ? e.message : String(e));
			}
		}, "");

	// ---- P5b 批量启用 / 禁用 ----

	const setAllRulesDisabled = (disabled: boolean) =>
		void run(async () => {
			let ok = 0;
			let fail = 0;
			for (let gi = 0; gi < groups.length; gi++) {
				for (let ri = 0; ri < groups[gi].rules.length; ri++) {
					try {
						await apiPut(`/api/cardfront/rules${scopeQuery(scope, cardPath)}`, {
							group: gi,
							index: ri,
							rule: rulePutBody(groups[gi].rules[ri] as RuleItem, disabled),
						});
						ok++;
					} catch {
						fail++;
					}
				}
			}
			await afterChange();
			toast(fail > 0 ? "warning" : "info", fail > 0 ? `${disabled ? "禁用" : "启用"}完成：成功 ${ok} 条，失败 ${fail} 条` : `已${disabled ? "禁用" : "启用"} ${ok} 条规则`);
		}, "");

	const openNewRule = (groupIndex: number) => {
		setEditingRule({ kind: "group", groupIndex, ruleIndex: null });
		setDraft({ ...DEFAULT_DRAFT });
		setSample("");
		setTrialSource("draft");
		setEditorOpen(true);
	};

	const openEditRule = (groupIndex: number, ruleIndex: number, rule: RuleItem) => {
		setEditingRule({ kind: "group", groupIndex, ruleIndex });
		setDraft(draftFromRule(rule));
		setSample("");
		setTrialSource("draft");
		setEditorOpen(true);
	};

	/** 编辑卡内嵌规则（保存仍挂原键，改名不改键） */
	const openEditCardRule = (rule: DisplayRule) => {
		setEditingRule({ kind: "card", key: ruleKey(rule) });
		setDraft(draftFromRule(rule));
		setSample("");
		setTrialSource("draft");
		setEditorOpen(true);
	};

	const saveDraft = () => {
		const validation = parseFindRegex(draft.findRegex);
		if ("error" in validation) return;
		if (draft.placement.length === 0) return; // 编辑器已提示并禁用保存
		if (!editingRule) return;
		if (editingRule.kind === "card") {
			saveCardRule(editingRule.key, draft);
		} else if (editingRule.ruleIndex == null) {
			createRule(editorTargetGroup, draft);
		} else {
			updateRule(editingRule.groupIndex, editingRule.ruleIndex, draft, editorTargetGroup);
		}
		setEditorOpen(false);
	};

	const groupNames = useMemo(() => groups.map((g) => g.name), [groups]);
	const locked = scope === "preset" && !presetInfo;
	const totalRules = useMemo(() => groups.reduce((n, g) => n + g.rules.length, 0), [groups]);

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

			{/* P5a / P5b：导出 · 导入 · 全部启用 / 全部禁用（当前作用域工具栏） */}
			<div className="panel-row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
				<button type="button" className="drawer-btn" disabled={busy || locked || totalRules === 0} onClick={doExport}>
					导出
				</button>
				<label
					className="drawer-btn"
					style={{ cursor: locked ? "default" : "pointer", opacity: locked ? 0.45 : 1 }}
					title="导入 JSON"
				>
					导入
					<input
						type="file"
						accept=".json,application/json"
						style={{ display: "none" }}
						disabled={locked}
						onChange={handleImportFile}
					/>
				</label>
				<button type="button" className="drawer-btn" disabled={busy || locked || totalRules === 0} onClick={() => setAllRulesDisabled(false)}>
					全部启用
				</button>
				<button type="button" className="drawer-btn" disabled={busy || locked || totalRules === 0} onClick={() => setAllRulesDisabled(true)}>
					全部禁用
				</button>
			</div>

			{importPending && (
				<div className="rule-editor" style={{ marginTop: 0, marginBottom: 10 }}>
					<h5>导入规则</h5>
					<div className="field-hint" style={{ marginBottom: 6 }}>
						共{" "}
						{importPending.kind === "flat"
							? (importPending.flat ?? []).length
							: (importPending.groups ?? []).reduce((n, g) => n + g.scripts.length, 0)}{" "}
						条规则（{importPending.kind === "flat" ? "平铺到未分组" : "按组导入"}），选择目标作用域：
					</div>
					<div className="panel-row" style={{ flexWrap: "wrap", gap: 6 }}>
						<select
							className="panel-search"
							style={{ width: "auto", flex: "1 1 100px" }}
							value={importTargetScope}
							onChange={(e) => setImportTargetScope(e.target.value as RuleScope)}
						>
							<option value="global">全局</option>
							<option value="card">角色</option>
							<option value="preset">预设</option>
						</select>
						{importTargetScope === "card" && (
							<select
								className="panel-search"
								style={{ width: "auto", flex: "2 1 160px" }}
								value={importTargetCard}
								onChange={(e) => setImportTargetCard(e.target.value)}
							>
								{cards.data?.cards.map((c) => (
									<option key={c.path} value={c.path}>
										{c.name}
									</option>
								))}
							</select>
						)}
					</div>
					<div className="panel-row" style={{ gap: 6, marginTop: 8 }}>
						<button
							type="button"
							className="drawer-btn save-btn"
							disabled={busy || (importTargetScope === "card" && !importTargetCard)}
							onClick={() => void doImport()}
						>
							确认导入
						</button>
						<button type="button" className="drawer-btn" disabled={busy} onClick={() => setImportPending(null)}>
							取消
						</button>
					</div>
				</div>
			)}

			{scope === "card" && cardInfo && cardInfo.cardRules.length > 0 && (
				<div className="rule-section">
					<div className="rule-sec-title">卡内嵌规则</div>
					{cardInfo.cardRules.map((r, i) => {
						const key = ruleKey(r);
						// 关闭判定双重：规则 disabled 或 key 在 ruleOff
						const on = !isRuleOff(r) && !cardInfo.ruleOff.includes(key);
						const modified = (cardInfo.overrides ?? []).includes(key);
						return (
							<div key={key} className="rule-row rule-row-readonly">
								<div className="rule-row-main">
									<span className="rule-name">{r.name || `未命名 #${i + 1}`}</span>
									<span className="rule-regex">{formatFindRegex(r)}</span>
									<span className="rule-replace">{replaceSummary(r.replace)}</span>
									<RuleChips rule={r} />
									{modified && (
										<div className="rule-row-chips">
											<span className="chip chip-modified">已修改</span>
										</div>
									)}
								</div>
								<div className="rule-row-acts">
									{modified && (
										<ConfirmButton
											className="act"
											disabled={busy || locked}
											confirmText="确认还原为卡原始规则？"
											onConfirm={() => void restoreCardRule(key)}
										>
											还原
										</ConfirmButton>
									)}
									<button
										type="button"
										className="act"
										disabled={busy || locked}
										onClick={() => void openEditCardRule(r)}
									>
										编辑
									</button>
									<label className="rule-switch">
										<input
											type="checkbox"
											checked={on}
											disabled={busy}
											onChange={() => void toggleCardRule(key, on)}
										/>
										<span>{on ? "开" : "关"}</span>
									</label>
								</div>
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
				{groups.length === 0 && !loading && (
					<div className="rule-empty">
						<span className="field-hint">暂无正则组，可直接添加正则（将放入未分组）</span>
						<button
							type="button"
							className="act"
							disabled={busy || locked}
							onClick={() => void openNewRule(0)}
						>
							＋ 新建规则
						</button>
					</div>
				)}
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
										const on = !isRuleOff(rule);
										return (
											<div key={`${ruleKey(rule)}-${ri}`} className="rule-row">
												<div className="rule-row-main">
													<span className="rule-name">{rule.name || `未命名 #${ri + 1}`}</span>
													<span className="rule-regex">{formatFindRegex(rule)}</span>
													<span className="rule-replace">{replaceSummary(rule.replace)}</span>
													<RuleChips rule={rule} />
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
							editing={editingRule ? editingRule.kind === "card" || editingRule.ruleIndex != null : false}
							hideGroup={editingRule?.kind === "card" || groupNames.length === 0}
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
				<>
					<div className="regex-tabs regex-subtabs">
						<button
							type="button"
							className={`regex-tab ${testSubTab === "test" ? "active" : ""}`}
							onClick={() => setTestSubTab("test")}
						>
							测试
						</button>
						<button
							type="button"
							className={`regex-tab ${testSubTab === "debug" ? "active" : ""}`}
							onClick={() => setTestSubTab("debug")}
						>
							调试器
						</button>
					</div>
				{testSubTab === "test" ? (
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
				) : (
					<RegexDebugger
						scope={scope}
						groups={groups}
						cardInfo={cardInfo}
						macros={macros}
						busy={busy}
						scopeQueryStr={scopeQuery(scope, cardPath)}
						onScopeChange={(s) => setScope(s)}
						run={run}
						afterChange={afterChange}
					/>
				)}
				</>
			)}
		</div>
	);
}
