/**
 * 自定义表格 + 模板管理（全屏页，DESIGN-custom-tables §7 / DESIGN-template-system §5 UI）。
 *
 * 布局（参考截图三栏）：左侧模板/表列表 + 顶部导航（面包屑、数据/结构标签、保存、导入）+ 右侧内容区。
 * 视觉独立于主主题的「工具页」观感：深青黑底 + 青绿强调（.tbl-page 作用域令牌，见 app.css）。
 *
 * 数据流：
 * - 读：世界状态（WorldState.tables，由 App 经 WS state 帧实时下发 → 本页只读 prop）+ GET /api/templates
 *   + GET /api/templates/:name + GET /api/config（cardTemplates 按卡绑定）+ GET /api/card（当前卡名）。
 * - 写：POST /api/state/tables（单元格/行/auto）、POST/DELETE /api/templates、POST /api/templates/apply、
 *   PUT /api/config。写后 WS 自动推 state 帧 / api.ts 缓存失效规则清 GET 缓存。
 *
 * 两个编辑面（避免混淆）：
 * - 「数据」标签 = 当前聊天的**实表**行数据（worldState.tables[name]），单元格即改即存（auto-commit）。
 * - 「结构」标签 = **模板定义**（列名/类型/auto），本地草稿，点「保存」才写回模板文件。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.ts";
import type {
	CustomTable,
	CustomTableColumn,
	TableColumnType,
	TableOp,
	TableTemplate,
	TableTemplateDef,
	WorldState,
} from "../wire.ts";
import {
	IconBack,
	IconCheck,
	IconChevronDown,
	IconClose,
	IconDownload,
	IconFolderOpen,
	IconLink,
	IconPlus,
	IconRefresh,
	IconTable,
	IconTrash,
} from "./icons.tsx";
import { ConfirmButton, Toggle, useAction, usePanelData } from "./kit.tsx";

// ---------- 小工具 ----------

type Toast = (level: "info" | "warning" | "error", text: string) => void;

/** 单元格显示文本（null/undefined → 空串；对象 → JSON） */
function cellText(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

const TYPE_LABEL: Record<TableColumnType, string> = {
	text: "text · 文本",
	integer: "integer · 整数",
	number: "number · 数字",
	boolean: "boolean · 布尔",
};

/**
 * 后端并行任务新增字段（DESIGN-template-system 扩展：note / 四触发器 / 列说明 / 初始行）。
 * src/types.ts 尚未同步，这里先本地扩展；同步后并入 web/src/wire.ts 再导出即可（类型结构一致）。
 * instructions 字段已废弃，旧模板可能带——读时原样保留，不主动删。
 */
type DraftColumn = CustomTableColumn & { description?: string };
type DraftTable = Omit<TableTemplate, "columns"> & {
	columns: DraftColumn[];
	/** 表格说明（note，参考图） */
	note?: string;
	/** 初始化触发：建表/物化时执行 */
	initNode?: string;
	/** 新增触发：插入行时执行 */
	insertNode?: string;
	/** 更新触发：更新行时执行 */
	updateNode?: string;
	/** 删除触发：删除行时执行 */
	deleteNode?: string;
	/** 模板初始行（物化时填入） */
	rows?: Record<string, unknown>[];
	/** 旧模板字段（废弃；读时兼容保留） */
	instructions?: string;
};
type DraftDef = Omit<TableTemplateDef, "tables"> & { tables: DraftTable[] };

/** 四触发器区块定义（结构页渲染用） */
const TRIGGER_BLOCKS: Array<{ key: "initNode" | "insertNode" | "updateNode" | "deleteNode"; label: string; hint: string }> = [
	{ key: "initNode", label: "初始化触发", hint: "建表/物化时执行的规则（对应 TavernDB initNode）" },
	{ key: "insertNode", label: "新增触发", hint: "插入行时执行的规则" },
	{ key: "updateNode", label: "更新触发", hint: "更新行时执行的规则（旧模板的 instructions 常合并于此）" },
	{ key: "deleteNode", label: "删除触发", hint: "删除行时执行的规则" },
];

const isTruthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";

/**
 * 网格单元格：单击进入编辑（回车/失焦提交、Esc 取消）；boolean 列渲染成打勾钮。
 * 提交的是用户输入原文（字符串），由服务端按列类型做 advisory 转换。
 */
function DataCell({
	value,
	type,
	onCommit,
	disabled,
}: {
	value: unknown;
	type?: TableColumnType;
	onCommit: (v: unknown) => void;
	disabled?: boolean;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const ref = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		if (editing) {
			setDraft(cellText(value));
			ref.current?.focus();
			ref.current?.select();
		}
	}, [editing, value]);

	if (type === "boolean") {
		const on = isTruthy(value);
		return (
			<button
				type="button"
				className={`tbl-cell tbl-cell-bool ${on ? "on" : ""}`}
				disabled={disabled}
				title={on ? "true（点击改为 false）" : "false（点击改为 true）"}
				onClick={() => onCommit(!on)}
			>
				{on ? "✓" : ""}
			</button>
		);
	}
	if (!editing) {
		const text = cellText(value);
		return (
			<button type="button" className="tbl-cell" disabled={disabled} title="点击编辑" onClick={() => setEditing(true)}>
				{text ? text : <span className="tbl-cell-empty">空</span>}
			</button>
		);
	}
	const commit = () => {
		setEditing(false);
		if (draft !== cellText(value)) onCommit(draft);
	};
	return (
		<input
			ref={ref}
			className="tbl-cell-input"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					commit();
				}
				if (e.key === "Escape") setEditing(false);
			}}
		/>
	);
}

// ---------- 主页面 ----------

export function TablesPage({
	worldState,
	toast,
	onClose,
}: {
	worldState: WorldState | null;
	toast: Toast;
	onClose: () => void;
}) {
	// ---- 只读数据（usePanelData：网络直拉 + 内存缓存秒开；api.ts 失效规则保证写后刷新） ----
	const templates = usePanelData(
		() => apiGet<{ templates: Array<{ name: string; description?: string; tableCount: number }> }>("/api/templates"),
		{ cacheKey: "/api/templates" },
	);
	const config = usePanelData(
		() => apiGet<{ config: { cardTemplates?: Record<string, string[]> } }>("/api/config"),
		{ cacheKey: "/api/config" },
	);
	const card = usePanelData(() => apiGet<{ name: string }>("/api/card"), { cacheKey: "/api/card" });

	// ---- 交互状态 ----
	const [tab, setTab] = useState<"data" | "structure">("data");
	const [selTemplate, setSelTemplate] = useState<string | null>(null);
	const [selTable, setSelTable] = useState<string | null>(null);
	const [detail, setDetail] = useState<TableTemplateDef | null>(null); // 已加载的模板原文（脏比对基准）
	const [detailErr, setDetailErr] = useState<string | null>(null);
	const [draft, setDraft] = useState<DraftDef | null>(null); // 结构标签的本地草稿（含 note/触发器/列说明等扩展字段）
	const [showNew, setShowNew] = useState(false);
	const [showImport, setShowImport] = useState(false);
	const [newName, setNewName] = useState("");
	const [newDesc, setNewDesc] = useState("");
	const [importText, setImportText] = useState("");
	const [importName, setImportName] = useState("");
	/** 导入：文件选择（主交互）+ 粘贴 JSON（高级兜底）。选中文件即解析出对象与表数预览 */
	const importInputRef = useRef<HTMLInputElement | null>(null);
	const [importFile, setImportFile] = useState<File | null>(null);
	const [parsedImport, setParsedImport] = useState<unknown | null>(null);
	const [importPreview, setImportPreview] = useState<string | null>(null);
	/** 内容区卡片的折叠态（键：desc/basic/cols/grid） */
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const toggleCard = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

	// ---- 派生 ----
	const cardName = card.data?.name ?? null;
	const bound = useMemo(() => {
		const list = config.data?.config?.cardTemplates?.[cardName ?? ""] ?? [];
		return new Set(list);
	}, [config.data, cardName]);

	const liveTables: Record<string, CustomTable> = worldState?.tables ?? {};
	const curTableDef = useMemo(
		() => draft?.tables.find((t) => t.name === selTable) ?? null,
		[draft, selTable],
	);
	/** 左栏「表」列表：有模板 → 模板的表定义；无模板 → 当前聊天里全部实表 */
	const sectionTables = useMemo(() => {
		if (selTemplate) return draft?.tables ?? [];
		return Object.values(liveTables).sort((a, b) => a.name.localeCompare(b.name, "zh"));
	}, [selTemplate, draft, liveTables]);

	// 脏比对：草稿 ≠ 已加载原文（JSON 全等）
	const dirty = useMemo(() => {
		if (!detail || !draft) return false;
		return JSON.stringify(detail) !== JSON.stringify(draft);
	}, [detail, draft]);

	// ---- 异步动作（两个独立 busy：表格数据操作 / 模板管理） ----
	const opAct = useAction(toast); // 单元格、行、auto 开关（POST /api/state/tables）
	const tmplAct = useAction(toast); // 模板 CRUD / 物化 / 绑定 / 保存（POST/DELETE /api/templates、PUT /api/config）

	const gridTable = liveTables[selTable ?? ""];

	// ---- 模板详情加载 ----
	useEffect(() => {
		if (!selTemplate) {
			setDetail(null);
			setDetailErr(null);
			setDraft(null);
			setSelTable(null);
			return;
		}
		let alive = true;
		setDetail(null);
		setDetailErr(null);
		apiGet<{ template: TableTemplateDef }>(`/api/templates/${encodeURIComponent(selTemplate)}`)
			.then((r) => {
				if (!alive) return;
				setDetail(r.template);
				// 深拷贝为草稿（含 note/触发器/列说明等扩展字段；instructions 旧字段原样保留）
				setDraft(JSON.parse(JSON.stringify(r.template)) as DraftDef);
				setSelTable((cur) => {
					if (cur && r.template.tables.some((t) => t.name === cur)) return cur;
					return r.template.tables[0]?.name ?? null;
				});
			})
			.catch((e: unknown) => {
				if (alive) setDetailErr(e instanceof Error ? e.message : String(e));
			});
		return () => {
			alive = false;
		};
	}, [selTemplate]);

	// 打开时自动选中：优先当前卡已绑定的模板，否则第一个
	useEffect(() => {
		const list = templates.data?.templates ?? [];
		if (!list.length) return;
		if (selTemplate && list.some((t) => t.name === selTemplate)) return;
		const firstBound = cardName ? list.find((t) => bound.has(t.name)) : undefined;
		setSelTemplate(firstBound?.name ?? list[0].name);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 只在列表/绑定态变化时补选，不追 selTemplate 自身
	}, [templates.data, bound, cardName]);

	// ---- 表格数据操作 ----
	const runTableOp = useCallback(async (op: TableOp) => {
		const r = await apiPost<{ ok: boolean; error?: string; applied?: string[]; warnings?: string[] }>(
			"/api/state/tables",
			{ op },
		);
		if (!r.ok) throw new Error(r.error ?? "操作失败");
		return r;
	}, []);

	/** 用行的全部已声明列值作 match（行无唯一 id，靠全等匹配定位） */
	const rowMatch = useCallback((table: CustomTable, row: Record<string, unknown>): Record<string, unknown> => {
		const m: Record<string, unknown> = {};
		for (const c of table.columns) {
			if (row[c.name] !== undefined) m[c.name] = row[c.name];
		}
		return m;
	}, []);

	const updateCell = (row: Record<string, unknown>, colName: string, value: unknown) => {
		if (!gridTable) return;
		const table = gridTable;
		void opAct.run(async () => {
			await runTableOp({ kind: "update", table: table.name, match: rowMatch(table, row), changes: { [colName]: value } });
		});
	};

	const addRow = () => {
		if (!gridTable) return;
		const table = gridTable;
		const row: Record<string, unknown> = {};
		for (const c of table.columns) row[c.name] = "";
		void opAct.run(async () => {
			await runTableOp({ kind: "insert", table: table.name, row });
		});
	};

	const deleteRow = (row: Record<string, unknown>) => {
		if (!gridTable) return;
		const table = gridTable;
		void opAct.run(async () => {
			await runTableOp({ kind: "delete", table: table.name, match: rowMatch(table, row) });
		});
	};

	/** 删除表（drop）：从当前聊天移除表与数据 = 取消表与聊天的关联；模板定义保留 */
	const dropTable = (name: string) => {
		void opAct.run(async () => {
			await runTableOp({ kind: "drop", name });
			// 删的是当前选中表 → 清掉选中，避免指向已不存在的表
			setSelTable((cur) => (cur === name ? null : cur));
			toast("info", `表「${name}」已从当前聊天删除（模板定义保留）`);
		});
	};

	/** auto 开关：单步 setAuto（后端 TableOp 直接改表 auto 标志，WS 推帧回显） */
	const toggleLiveAuto = () => {
		if (!gridTable) return;
		const table = gridTable;
		const nextAuto = !table.auto;
		void opAct.run(async () => {
			await runTableOp({ kind: "setAuto", table: table.name, auto: nextAuto });
			toast("info", `表「${table.name}」已${nextAuto ? "开启" : "关闭"}场记自动维护`);
		});
	};

	// ---- 模板管理 ----
	const selectTemplate = (name: string) => {
		if (name === selTemplate) return;
		if (dirty && !window.confirm("当前模板「结构」页有未保存的修改，切换将丢弃。继续？")) return;
		setSelTemplate(name);
	};

	const saveTemplate = () => {
		if (!draft || !selTemplate) return;
		if (draft.tables.length === 0) {
			toast("error", "模板至少要有一张表");
			return;
		}
		void tmplAct.run(async () => {
			const r = await apiPost<{ ok: boolean; name: string }>("/api/templates", draft);
			setDetail(JSON.parse(JSON.stringify(draft)) as TableTemplateDef);
			toast("info", `模板「${r.name}」已保存`);
			templates.reload();
		});
	};

	const deleteTemplate = (name: string) => {
		void tmplAct.run(async () => {
			await apiDelete(`/api/templates/${encodeURIComponent(name)}`);
			if (selTemplate === name) setSelTemplate(null);
			toast("info", `模板「${name}」已删除`);
			templates.reload();
		});
	};

	const applyToChat = (name: string) => {
		void tmplAct.run(async () => {
			const r = await apiPost<{ ok: boolean; applied?: string[]; warnings?: string[] }>("/api/templates/apply", { name });
			toast("info", r.applied?.length ? `已应用到当前聊天：${r.applied.join("；")}` : "已应用到当前聊天");
			if (r.warnings?.length) toast("warning", r.warnings.join("；"));
		});
	};

	const toggleBind = (name: string) => {
		if (!cardName) {
			toast("error", "尚未取得当前卡信息，无法绑定");
			return;
		}
		const cur = config.data?.config?.cardTemplates ?? {};
		const list = cur[cardName] ?? [];
		const next = new Set(list);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		void tmplAct.run(async () => {
			await apiPut("/api/config", { cardTemplates: { ...cur, [cardName]: [...next] } });
			toast("info", next.has(name) ? `模板「${name}」已绑定到当前卡` : `模板「${name}」已解除绑定`);
			config.reload();
		});
	};

	const createTemplate = () => {
		const name = newName.trim();
		if (!name) {
			toast("error", "模板名不能为空");
			return;
		}
		void tmplAct.run(async () => {
			await apiPost("/api/templates", {
				name,
				...(newDesc.trim() ? { description: newDesc.trim() } : {}),
				// 模板至少要一张表：带一个占位表，后续在「结构」页里改
				tables: [{ name: "新表", columns: [{ name: "列1" }] }],
			});
			setShowNew(false);
			setNewName("");
			setNewDesc("");
			toast("info", `模板「${name}」已创建`);
			templates.reload();
			setSelTemplate(name);
			setTab("structure");
		});
	};

	/** 选择导入文件：读文本 → JSON.parse → 数 sheet_ 表做预览（主交互） */
	const onPickImportFile = async (file: File) => {
		if (!/\.json$/i.test(file.name) && file.type !== "application/json") {
			toast("error", "请选择 JSON 文件（TavernDB 导出为 .json）");
			return;
		}
		try {
			const text = await file.text();
			const obj: unknown = JSON.parse(text);
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("JSON 根不是对象");
			const sheetCount = Object.keys(obj as Record<string, unknown>).filter((k) => k.startsWith("sheet_")).length;
			setImportFile(file);
			setParsedImport(obj);
			setImportPreview(sheetCount > 0 ? `解析出 ${sheetCount} 张表` : "未找到 sheet_ 表（可能不是 TavernDB 导出）");
			toast("info", `已读取「${file.name}」${sheetCount > 0 ? `，含 ${sheetCount} 张表` : ""}`);
		} catch (e) {
			toast("error", `文件解析失败：${e instanceof Error ? e.message : String(e)}`);
			setImportFile(null);
			setParsedImport(null);
			setImportPreview(null);
		}
	};

	const importTemplate = () => {
		if (!parsedImport && !importText.trim()) {
			toast("error", "请先选择 TavernDB 导出的 JSON 文件（或展开「高级」粘贴 JSON）");
			return;
		}
		void tmplAct.run(async () => {
			const body: Record<string, unknown> = { tavernDB: parsedImport ?? importText.trim() };
			if (importName.trim()) body.name = importName.trim();
			const r = await apiPost<{ ok: boolean; name: string }>("/api/templates", body);
			setShowImport(false);
			setImportText("");
			setImportName("");
			setImportFile(null);
			setParsedImport(null);
			setImportPreview(null);
			toast("info", `已导入模板「${r.name}」`);
			templates.reload();
			setSelTemplate(r.name);
			setTab("data");
		});
	};

	const addTableToTemplate = () => {
		if (!draft) return;
		const name = `新表${draft.tables.length + 1}`;
		setDraft({ ...draft, tables: [...draft.tables, { name, columns: [{ name: "列1" }] }] });
		setSelTable(name);
		setTab("structure");
	};

	// ---- 结构草稿编辑 ----
	const setCurTable = (patch: Partial<DraftTable>) => {
		if (!draft || !selTable) return;
		setDraft({
			...draft,
			tables: draft.tables.map((t) => (t.name === selTable ? { ...t, ...patch } : t)),
		});
	};
	const renameTableInDraft = (name: string) => {
		setCurTable({ name });
		setSelTable(name);
	};
	const setColumn = (idx: number, patch: Partial<DraftColumn>) => {
		if (!curTableDef) return;
		setCurTable({ columns: curTableDef.columns.map((c, i) => (i === idx ? { ...c, ...patch } : c)) });
	};
	const addColumn = () => {
		if (!curTableDef) return;
		setCurTable({ columns: [...curTableDef.columns, { name: `列${curTableDef.columns.length + 1}` }] });
	};
	const removeColumn = (idx: number) => {
		if (!curTableDef || curTableDef.columns.length <= 1) return;
		setCurTable({ columns: curTableDef.columns.filter((_, i) => i !== idx) });
	};
	/** 触发器/表格说明的通用写入（note 与四触发器字段） */
	const setTableField = (key: "note" | "initNode" | "insertNode" | "updateNode" | "deleteNode", value: string) => {
		setCurTable({ [key]: value.trim() ? value : undefined });
	};

	// ---- 渲染 ----
	return createPortal(
		<div className="tbl-page">
			<header className="tbl-top">
				<button
					type="button"
					className="tbl-top-close"
					aria-label="返回聊天"
					title="返回聊天"
					onClick={() => {
						if (dirty && !window.confirm("当前模板有未保存的修改，确定关闭？")) return;
						onClose();
					}}
				>
					<IconBack size={18} />
				</button>
				<div className="tbl-crumb">
					<span className="tbl-crumb-main">{selTemplate ?? "未选择模板"}</span>
					{selTemplate && <span className="tbl-crumb-sep">/</span>}
					<span className="tbl-crumb-sub">{selTable ?? ""}</span>
				</div>
				<div className="tbl-tabs" role="tablist" aria-label="视图">
					<button type="button" role="tab" aria-selected={tab === "data"} className={tab === "data" ? "on" : ""} onClick={() => setTab("data")}>
						数据
					</button>
					<button type="button" role="tab" aria-selected={tab === "structure"} className={tab === "structure" ? "on" : ""} onClick={() => setTab("structure")}>
						结构
					</button>
				</div>
				<div className="tbl-top-actions">
					<button type="button" className="tbl-btn" onClick={() => setShowImport(true)} title="粘贴 TavernDB 导出的 JSON 生成模板">
						导入
					</button>
					<button
						type="button"
						className="tbl-btn tbl-btn-primary"
						disabled={!dirty || !selTemplate || tmplAct.busy}
						title={dirty ? "保存「结构」页的模板修改" : "「结构」页有修改时才可保存"}
						onClick={saveTemplate}
					>
						保存
						{dirty && <span className="tbl-dirty-dot" aria-hidden="true" />}
					</button>
				</div>
			</header>

			<div className="tbl-body">
				<aside className="tbl-side">
					{/* ── 模板列表 ── */}
					<section className="tbl-side-sec">
						<div className="tbl-side-head">
							<span>模板</span>
							<button type="button" className="tbl-icon-btn" title="新建模板" onClick={() => setShowNew(true)}>
								<IconPlus size={14} />
							</button>
						</div>
						<div className="tbl-side-list">
							{templates.loading && !templates.data && <div className="tbl-side-empty">读取中…</div>}
							{templates.error && <div className="tbl-side-empty tbl-side-err">{templates.error}</div>}
							{templates.data?.templates.map((t) => {
								const isBound = bound.has(t.name);
								const isSel = selTemplate === t.name;
								return (
									<div key={t.name} className={`tbl-tmpl ${isSel ? "on" : ""}`} onClick={() => selectTemplate(t.name)}>
										<div className="tbl-tmpl-line">
											<span className="tbl-tmpl-name">{t.name}</span>
											<span className="tbl-count-badge" title="模板内的表数量">
												{t.tableCount}
											</span>
											{isBound && (
												<span className="tbl-badge" title="已绑定到当前卡，用该卡开聊会自动建表">
													已绑定
												</span>
											)}
										</div>
										<div className="tbl-tmpl-sub">
											{t.tableCount} 张表{t.description ? ` · ${t.description}` : ""}
										</div>
										<div className="tbl-tmpl-acts" onClick={(e) => e.stopPropagation()}>
											<button
												type="button"
												className={`tbl-icon-btn ${isBound ? "on" : ""}`}
												title={isBound ? "解除当前卡绑定" : "绑定到当前卡（开聊自动建表）"}
												disabled={tmplAct.busy}
												onClick={() => toggleBind(t.name)}
											>
												<IconLink size={13} />
											</button>
											<button
												type="button"
												className="tbl-icon-btn"
												title="应用到当前聊天（立即建表）"
												disabled={tmplAct.busy}
												onClick={() => applyToChat(t.name)}
											>
												<IconDownload size={13} />
											</button>
											<ConfirmButton
												className="tbl-icon-btn danger"
												confirmText="确认删除"
												title="删除模板（已物化到当前聊天的表不受影响）"
												disabled={tmplAct.busy}
												onConfirm={() => deleteTemplate(t.name)}
											>
												<IconTrash size={13} />
											</ConfirmButton>
										</div>
									</div>
								);
							})}
							{!templates.loading && templates.data && templates.data.templates.length === 0 && (
								<div className="tbl-side-empty">还没有模板，点右上「＋」新建，或点顶栏「导入」粘贴 TavernDB JSON。</div>
							)}
						</div>
					</section>

					{/* ── 表列表 ── */}
					<section className="tbl-side-sec">
						<div className="tbl-side-head">
							<span>
								{selTemplate ? "表" : "当前聊天的表"}
								<span className="tbl-count-badge">{sectionTables.length}</span>
							</span>
							{selTemplate && (
								<button type="button" className="tbl-icon-btn" title="向模板添加一张表" onClick={addTableToTemplate}>
									<IconPlus size={14} />
								</button>
							)}
						</div>
						<div className="tbl-side-list">
							{detailErr && <div className="tbl-side-empty tbl-side-err">{detailErr}</div>}
							{sectionTables.length === 0 && !detailErr && (
								<div className="tbl-side-empty">{selTemplate ? "模板暂无表" : "当前聊天还没有自定义表"}</div>
							)}
							{sectionTables.map((t) => {
								const live = liveTables[t.name];
								const isSel = selTable === t.name;
								return (
									<div key={t.name} className={`tbl-tbl ${isSel ? "on" : ""}`} onClick={() => setSelTable(t.name)}>
										<span className="tbl-tbl-name" title={t.name}>
											{t.name}
										</span>
										<span className="tbl-tbl-right">
											<span className="tbl-tbl-meta">
												{live ? `${live.rows.length} 行` : selTemplate ? "未物化" : "—"}
												{(live?.auto || (selTemplate && t.auto)) && (
													<span className="tbl-badge-auto" title="场记自动维护，每轮全量注入">
														auto
													</span>
												)}
											</span>
											{/* 已物化的表可删除：drop = 从当前聊天取消关联（模板定义保留） */}
											{live && (
												<span onClick={(e) => e.stopPropagation()}>
													<ConfirmButton
														className="tbl-icon-btn danger tbl-tbl-del"
														confirmText="确认删除"
														title="从当前聊天删除此表（模板定义保留）"
														disabled={opAct.busy}
														onConfirm={() => dropTable(t.name)}
													>
														<IconTrash size={13} />
													</ConfirmButton>
												</span>
											)}
										</span>
									</div>
								);
							})}
						</div>
					</section>
				</aside>

				<main className="tbl-main">
					{tab === "data" ? (
						<div className="tbl-data-view">
							{!selTable ? (
								<div className="tbl-empty">
									<IconTable size={40} />
									<div>从左侧选择一张表</div>
									<p>「数据」页编辑当前聊天里的行数据（即改即存）；「结构」页编辑模板定义。</p>
								</div>
							) : !gridTable ? (
								<div className="tbl-empty">
									<IconTable size={40} />
									<div>表「{selTable}」尚未建在当前聊天中</div>
									<p>
										{selTemplate
											? "可把模板物化到当前聊天（立即建表），或绑定到当前卡（下次开聊自动建表）。"
											: "此表仅存在于模板中，尚未物化到当前聊天。"}
									</p>
									{selTemplate && (
										<button
											type="button"
											className="tbl-btn tbl-btn-primary"
											disabled={tmplAct.busy}
											onClick={() => applyToChat(selTemplate)}
										>
											<IconDownload size={14} />
											应用到当前聊天
										</button>
									)}
								</div>
							) : (
								<div className="tbl-card">
									<div className="tbl-card-head" onClick={() => toggleCard("grid")} title="点击折叠/展开">
										<span>数据记录 · {gridTable.name}</span>
										<span className="tbl-card-head-right">
											<span className="tbl-auto-row" title="场记每轮自动维护并全量注入上下文；非 auto 表只注入索引">
												<span>场记自动维护</span>
												<Toggle checked={!!gridTable.auto} disabled={opAct.busy} onChange={toggleLiveAuto} />
											</span>
											<button
												type="button"
												className={`tbl-card-fold ${collapsed["grid"] ? "folded" : ""}`}
												aria-label="折叠/展开"
												onClick={(e) => {
													e.stopPropagation();
													toggleCard("grid");
												}}
											>
												<IconChevronDown size={14} />
											</button>
										</span>
									</div>
									{!collapsed["grid"] && (
										<div className="tbl-card-body">
											<div className="tbl-toolbar">
												<span className="tbl-row-count">
													{gridTable.rows.length} 行 · {gridTable.auto ? "auto（每轮全量注入）" : "静态（内容走查询）"}
												</span>
												<div className="tbl-toolbar-actions">
													<button type="button" className="tbl-btn tbl-btn-sm" disabled={opAct.busy} onClick={addRow}>
														<IconPlus size={13} />
														新增一行
													</button>
													<ConfirmButton
														className="tbl-btn tbl-btn-sm tbl-btn-danger"
														confirmText="确认删除"
														title="从当前聊天删除此表：表与数据一并移除 = 取消表与聊天的关联（模板定义保留）"
														disabled={opAct.busy}
														onConfirm={() => dropTable(gridTable.name)}
													>
														<IconTrash size={13} />
														删除此表
													</ConfirmButton>
												</div>
											</div>
											{/* 行数据 = 竖向卡片网格（参考图：一行最多 3 张，竖向排列 + 外层滚动） */}
											<div className="tbl-records">
												{gridTable.rows.length === 0 && (
													<div className="tbl-records-empty">还没有行数据，点「新增一行」开始录入。</div>
												)}
												{gridTable.rows.map((row, ri) => {
													// 该记录已填写（非空）的字段数
													const filled = gridTable.columns.filter((c) => {
														const v = row[c.name];
														return v !== undefined && v !== null && v !== "";
													}).length;
													return (
														<div key={ri} className="tbl-record">
															<div className="tbl-record-head">
																<span className="tbl-record-title" title={`第 ${ri + 1} 条记录`}>
																	#{ri + 1} · {filled} 个字段
																</span>
																<ConfirmButton
																	className="tbl-icon-btn danger"
																	confirmText="确认删除"
																	title="删除此行"
																	disabled={opAct.busy}
																	onConfirm={() => deleteRow(row)}
																>
																	<IconTrash size={13} />
																</ConfirmButton>
															</div>
															<div className="tbl-record-fields">
																{gridTable.columns.map((c) => {
																	// 长文本跨满整行，短字段（如姓名/性别）并排各占 50%
																	const span = cellText(row[c.name]).length > 16;
																	return (
																		<div key={c.name} className={`tbl-record-field ${span ? "span" : ""}`}>
																			<span className="tbl-record-label" title={c.name}>
																				{c.name}
																			</span>
																			<span className="tbl-record-value">
																				<DataCell
																					value={row[c.name]}
																					type={c.type}
																					disabled={opAct.busy}
																					onCommit={(v) => updateCell(row, c.name, v)}
																				/>
																			</span>
																		</div>
																	);
																})}
															</div>
														</div>
													);
												})}
											</div>
										</div>
									)}
								</div>
							)}
						</div>
					) : (
						<div className="tbl-structure-view">
							{!selTable ? (
								<div className="tbl-empty">
									<IconTable size={40} />
									<div>从左侧选择一张表</div>
									<p>「结构」页编辑模板定义：列名、类型与 auto 标记，点「保存」写回模板文件。</p>
								</div>
							) : !curTableDef ? (
								<div className="tbl-empty">
									<IconTable size={40} />
									<div>表「{selTable}」不属于当前模板</div>
									<p>结构编辑基于模板。未选模板时只能浏览当前聊天实表的数据；模板内的表在左侧「模板」里选。</p>
								</div>
							) : (
								<>
									<div className="tbl-card">
										<div className="tbl-card-head" onClick={() => toggleCard("desc")} title="点击折叠/展开">
											<span>模板说明</span>
											<button
												type="button"
												className={`tbl-card-fold ${collapsed["desc"] ? "folded" : ""}`}
												aria-label="折叠/展开"
												onClick={(e) => {
													e.stopPropagation();
													toggleCard("desc");
												}}
											>
												<IconChevronDown size={14} />
											</button>
										</div>
										{!collapsed["desc"] && (
											<div className="tbl-card-body">
												<textarea
													className="tbl-input tbl-input-ta"
													rows={2}
													placeholder="模板描述（可选，随模板保存）"
													value={draft?.description ?? ""}
													onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value.trim() ? e.target.value : undefined } : d))}
												/>
											</div>
										)}
									</div>

									<div className="tbl-card">
										<div className="tbl-card-head" onClick={() => toggleCard("basic")} title="点击折叠/展开">
											<span>表基本信息</span>
											<button
												type="button"
												className={`tbl-card-fold ${collapsed["basic"] ? "folded" : ""}`}
												aria-label="折叠/展开"
												onClick={(e) => {
													e.stopPropagation();
													toggleCard("basic");
												}}
											>
												<IconChevronDown size={14} />
											</button>
										</div>
										{!collapsed["basic"] && (
											<div className="tbl-card-body">
												<div className="tbl-form-grid">
													<label className="tbl-form-field">
														<span>表名</span>
														<input
															className="tbl-input"
															value={curTableDef.name}
															onChange={(e) => renameTableInDraft(e.target.value)}
														/>
													</label>
													<label className="tbl-form-field">
														<span>描述</span>
														<input
															className="tbl-input"
															placeholder="（可选）"
															value={curTableDef.description ?? ""}
															onChange={(e) => setCurTable({ description: e.target.value })}
														/>
													</label>
													<label className="tbl-form-field tbl-form-field-toggle">
														<span>场记自动维护</span>
														<Toggle
															checked={!!curTableDef.auto}
															onChange={(v) => setCurTable({ auto: v })}
															title="物化时写入 auto 标记：每轮自动维护 + 全量注入"
														/>
													</label>
												</div>
											</div>
										)}
									</div>

									<div className="tbl-card">
										<div className="tbl-card-head" onClick={() => toggleCard("cols")} title="点击折叠/展开">
											<span>列定义（{curTableDef.columns.length}）</span>
											<span className="tbl-card-head-right">
												<button
													type="button"
													className="tbl-btn tbl-btn-sm"
													title="在末尾添加一列"
													onClick={(e) => {
														e.stopPropagation();
														addColumn();
													}}
												>
													<IconPlus size={12} />
													添加列
												</button>
												<button
													type="button"
													className={`tbl-card-fold ${collapsed["cols"] ? "folded" : ""}`}
													aria-label="折叠/展开"
													onClick={(e) => {
														e.stopPropagation();
														toggleCard("cols");
													}}
												>
													<IconChevronDown size={14} />
												</button>
											</span>
										</div>
										{!collapsed["cols"] && (
											<div className="tbl-card-body">
												<div className="tbl-cols">
													{curTableDef.columns.map((c, i) => (
														<div className="tbl-col-item" key={i}>
															<div className="tbl-col-row">
																<span className="tbl-col-idx">#{i + 1}</span>
																<input
																	className="tbl-input"
																	value={c.name}
																	placeholder="列名"
																	onChange={(e) => setColumn(i, { name: e.target.value })}
																/>
																<select
																	className="tbl-input tbl-input-select"
																	value={c.type ?? "text"}
																	onChange={(e) => setColumn(i, { type: e.target.value as TableColumnType })}
																>
																	{(Object.keys(TYPE_LABEL) as TableColumnType[]).map((k) => (
																		<option key={k} value={k}>
																			{TYPE_LABEL[k]}
																		</option>
																	))}
																</select>
																<button
																	type="button"
																	className="tbl-icon-btn danger"
																	title={curTableDef.columns.length <= 1 ? "至少保留一列" : "删除此列"}
																	disabled={curTableDef.columns.length <= 1}
																	onClick={() => removeColumn(i)}
																>
																	<IconTrash size={13} />
																</button>
															</div>
															{/* 列说明（参考图：每列带说明字段） */}
															<div className="tbl-col-desc">
																<input
																	className="tbl-input"
																	value={c.description ?? ""}
																	placeholder={`「${c.name || `列${i + 1}`}」的说明（可选，随模板保存）`}
																	onChange={(e) => setColumn(i, { description: e.target.value.trim() ? e.target.value : undefined })}
																/>
															</div>
														</div>
													))}
												</div>
												<div className="tbl-card-hint">
													类型为提示性（advisory）：integer/number 会尝试转数字，boolean 认 true/false/1/0；text 原样保存。
												</div>
											</div>
										)}
									</div>

									{/* 表格说明（note，参考图：列定义下方） */}
									<div className="tbl-card">
										<div className="tbl-card-head" onClick={() => toggleCard("note")} title="点击折叠/展开">
											<span>表格说明</span>
											<button
												type="button"
												className={`tbl-card-fold ${collapsed["note"] ? "folded" : ""}`}
												aria-label="折叠/展开"
												onClick={(e) => {
													e.stopPropagation();
													toggleCard("note");
												}}
											>
												<IconChevronDown size={14} />
											</button>
										</div>
										{!collapsed["note"] && (
											<div className="tbl-card-body">
												<textarea
													className="tbl-input tbl-input-ta"
													rows={3}
													placeholder="表内数据的用途、维护约定等（可选，随模板保存）"
													value={curTableDef.note ?? ""}
													onChange={(e) => setTableField("note", e.target.value)}
												/>
											</div>
										)}
									</div>

									{/* 四个触发器区块（参考图：初始化/新增/更新/删除触发） */}
									<div className="tbl-card">
										<div className="tbl-card-head" onClick={() => toggleCard("triggers")} title="点击折叠/展开">
											<span>维护规则（触发器）</span>
											<button
												type="button"
												className={`tbl-card-fold ${collapsed["triggers"] ? "folded" : ""}`}
												aria-label="折叠/展开"
												onClick={(e) => {
													e.stopPropagation();
													toggleCard("triggers");
												}}
											>
												<IconChevronDown size={14} />
											</button>
										</div>
										{!collapsed["triggers"] && (
											<div className="tbl-card-body">
												{TRIGGER_BLOCKS.map((t) => (
													<label className="tbl-trigger" key={t.key}>
														<span className="tbl-trigger-label">
															{t.label}
															<span className="tbl-trigger-hint">{t.hint}</span>
														</span>
														<textarea
															className="tbl-input tbl-input-ta"
															rows={3}
															placeholder={`${t.label}规则（可选）`}
															value={curTableDef[t.key] ?? ""}
															onChange={(e) => setTableField(t.key, e.target.value)}
														/>
													</label>
												))}
											</div>
										)}
									</div>
								</>
							)}
						</div>
					)}
				</main>
			</div>

			{/* ── 底部操作栏：保存状态提示 + 保存按钮 ── */}
			<footer className="tbl-footer">
				<span className="tbl-save-status">
					{!selTemplate ? (
						"选择左侧模板后，可在「结构」页编辑并保存"
					) : dirty ? (
						<span className="tbl-save-dirty">● 有未保存的修改</span>
					) : (
						<span className="tbl-save-clean">✓ 已保存</span>
					)}
				</span>
				<div className="tbl-footer-actions">
					<button
						type="button"
						className="tbl-btn tbl-btn-sm"
						title="重新拉取模板列表 / 配置 / 当前卡"
						disabled={opAct.busy || tmplAct.busy}
						onClick={() => {
							templates.reload();
							config.reload();
							card.reload();
						}}
					>
						<IconRefresh size={13} />
						刷新
					</button>
					<button
						type="button"
						className="tbl-btn tbl-btn-primary"
						disabled={!dirty || !selTemplate || tmplAct.busy}
						title={dirty ? "保存「结构」页的模板修改" : "「结构」页有修改时才可保存"}
						onClick={saveTemplate}
					>
						<IconCheck size={14} />
						保存
					</button>
				</div>
			</footer>

			{/* ── 新建模板 ── */}
			{showNew && (
				<div className="tbl-modal-scrim" onClick={() => setShowNew(false)}>
					<div className="tbl-modal" role="dialog" aria-label="新建模板" onClick={(e) => e.stopPropagation()}>
						<div className="tbl-modal-head">
							<span>新建模板</span>
							<button type="button" className="tbl-icon-btn" aria-label="关闭" onClick={() => setShowNew(false)}>
								<IconClose size={15} />
							</button>
						</div>
						<div className="tbl-modal-body">
							<label className="tbl-form-field">
								<span>模板名</span>
								<input
									className="tbl-input"
									value={newName}
									placeholder="如：主角信息表"
									onChange={(e) => setNewName(e.target.value)}
									onKeyDown={(e) => e.key === "Enter" && createTemplate()}
								/>
							</label>
							<label className="tbl-form-field">
								<span>描述（可选）</span>
								<input className="tbl-input" value={newDesc} placeholder="一句话说明用途" onChange={(e) => setNewDesc(e.target.value)} />
							</label>
							<div className="tbl-modal-hint">创建后自带一张「新表」，可在「结构」页改列名/类型或再加表。</div>
						</div>
						<div className="tbl-modal-foot">
							<button type="button" className="tbl-btn" onClick={() => setShowNew(false)}>
								取消
							</button>
							<button
								type="button"
								className="tbl-btn tbl-btn-primary"
								disabled={!newName.trim() || tmplAct.busy}
								onClick={createTemplate}
							>
								创建
							</button>
						</div>
					</div>
				</div>
			)}

			{/* ── 导入 TavernDB ── */}
			{showImport && (
				<div className="tbl-modal-scrim" onClick={() => setShowImport(false)}>
					<div className="tbl-modal" role="dialog" aria-label="导入模板" onClick={(e) => e.stopPropagation()}>
						<div className="tbl-modal-head">
							<span>导入 TavernDB 模板</span>
							<button type="button" className="tbl-icon-btn" aria-label="关闭" onClick={() => setShowImport(false)}>
								<IconClose size={15} />
							</button>
						</div>
						<div className="tbl-modal-body">
							<label className="tbl-form-field">
								<span>模板名（可选，默认取 TavernDB 自带名）</span>
								<input
									className="tbl-input"
									value={importName}
									placeholder="留空自动取名"
									onChange={(e) => setImportName(e.target.value)}
								/>
							</label>
							<div className="tbl-form-field">
								<span>选择 TavernDB 导出文件（.json）</span>
								<div className="tbl-file-row">
									<button type="button" className="tbl-btn" onClick={() => importInputRef.current?.click()}>
										<IconFolderOpen size={13} />
										选择文件
									</button>
									<input
										ref={importInputRef}
										type="file"
										accept=".json,application/json"
										hidden
										onChange={(e) => {
											const f = e.target.files?.[0];
											if (f) void onPickImportFile(f);
											e.target.value = "";
										}}
									/>
									{importFile && (
										<span className="tbl-file-name" title={importFile.name}>
											{importFile.name}
											{importPreview && <span className="tbl-file-preview"> · {importPreview}</span>}
										</span>
									)}
								</div>
							</div>
							<details className="tbl-import-advanced">
								<summary>高级：直接粘贴 JSON</summary>
								<textarea
									className="tbl-input tbl-input-ta tbl-import-ta"
									rows={6}
									placeholder='{"mate": {...}, "sheet_主角": {...}, ...}'
									value={importText}
									onChange={(e) => setImportText(e.target.value)}
								/>
							</details>
							<div className="tbl-modal-hint">只导入表结构（列名/类型/auto），不含行数据；带维护规则的表自动标 auto。</div>
						</div>
						<div className="tbl-modal-foot">
							<button type="button" className="tbl-btn" onClick={() => setShowImport(false)}>
								取消
							</button>
							<button
								type="button"
								className="tbl-btn tbl-btn-primary"
								disabled={(!parsedImport && !importText.trim()) || tmplAct.busy}
								onClick={importTemplate}
							>
								导入
							</button>
						</div>
					</div>
				</div>
			)}
		</div>,
		document.body,
	);
}
