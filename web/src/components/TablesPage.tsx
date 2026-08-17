/**
 * 表编辑器（SQL 版，DESIGN-tables-sql §2 UI，2026-08-16）。
 *
 * 数据源：GET /api/tables（清单 + meta）、GET /api/tables/rows（分页行，带 __rowid）、
 * POST /api/tables（create/drop/updateMeta）、POST /api/tables/rows（SQL 写入）。
 * 行编辑由前端构造 SQL（UPDATE/DELETE 用 rowid 定位、INSERT 用列名+值），
 * 经后端 SQL 校验器与 SQLite 执行，报错原样外露。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiGet, apiPost } from "../api.ts";
import { IconTrash } from "./icons.tsx";

/** 顶部气泡（App 传入） */
type ToastFn = (level: "info" | "warning" | "error", text: string) => void;

// ---------------- 类型 ----------------

type ColType = "text" | "number" | "integer" | "real" | "boolean";

interface ColDef {
	name: string;
	type: ColType;
	description?: string;
	primary?: boolean;
	ref?: { table: string; column: string };
}

interface TableMeta {
	name: string;
	auto: boolean;
	group?: string | null;
	description?: string;
	columns: ColDef[];
}

interface TableSummary {
	name: string;
	auto: boolean;
	group: string | null;
	rowCount: number;
}

interface TablesPayload {
	tables: TableSummary[];
	metas: Record<string, TableMeta>;
}

interface RowsPayload {
	rows: Array<Record<string, unknown>>;
}

// ---------------- 工具 ----------------

/** SQL 字面量转义（单引号双写） */
const esc = (v: string): string => v.replace(/'/g, "''");

/** 值 → SQL 字面量（number/boolean 不带引号） */
const lit = (v: unknown, type?: ColType): string => {
	if (type === "number" || type === "integer" || type === "real") {
		const n = Number(v);
		return Number.isFinite(n) ? String(n) : "NULL";
	}
	if (type === "boolean") {
		return v === true || v === 1 || v === "1" ? "1" : "0";
	}
	if (v === null || v === undefined) return "NULL";
	return `'${esc(String(v))}'`;
};

const cellText = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** 单元格编辑：单击进入，回车/失焦提交、Esc 取消；boolean 打勾钮 */
function DataCell({
	value,
	type,
	onCommit,
}: {
	value: unknown;
	type?: ColType;
	onCommit: (v: string | boolean) => void;
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
		const on = value === true || value === 1 || value === "1";
		return (
			<button type="button" className={`tbl-cell tbl-cell-bool ${on ? "on" : ""}`} title={on ? "true（点击改为 false）" : "false（点击改为 true）"} onClick={() => onCommit(!on)}>
				{on ? "✓" : ""}
			</button>
		);
	}
	if (!editing) {
		const text = cellText(value);
		return (
			<button type="button" className="tbl-cell" title="点击编辑" onClick={() => setEditing(true)}>
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

// ---------------- 主页面 ----------------

export function TablesPage({ toast, onClose }: { worldState?: unknown; toast: ToastFn; onClose: () => void }) {
	const [data, setData] = useState<TablesPayload | null>(null);
	const [selTable, setSelTable] = useState<string | null>(null);
	const [tab, setTab] = useState<"data" | "rule">("data");
	const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
	const [offset, setOffset] = useState(0);
	const [rowsErr, setRowsErr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// 建表向导
	const [showNew, setShowNew] = useState(false);
	const [newName, setNewName] = useState("");
	const [newDesc, setNewDesc] = useState("");
	const [newAuto, setNewAuto] = useState(true);
	const [newCols, setNewCols] = useState<Array<{ name: string; type: ColType; description: string; primary: boolean }>>([]);
	// 说明与规则草稿
	const [ruleDraft, setRuleDraft] = useState("");
	const [ruleDirty, setRuleDirty] = useState(false);

	const PAGE = 50;

	const loadTables = useCallback(async () => {
		try {
			// bypassCache：建/删表后必须拿最新清单（否则删完还选中已删表，报 no such table）
			const d = await apiGet<TablesPayload>("/api/tables", { bypassCache: true });
			setData(d);
			return d;
		} catch {
			return null;
		}
	}, []);

	useEffect(() => {
		void loadTables().then((d) => {
			if (d && d.tables.length > 0) setSelTable(d.tables[0]!.name);
		});
	}, [loadTables]);

	// 自动刷新：场记每拍写表后 UI 跟随（5 秒轮询；表格小、开销可忽略）
	useEffect(() => {
		const t = setInterval(() => {
			void loadTables().catch(() => undefined);
			if (selTable) {
				void apiGet<RowsPayload>(`/api/tables/rows?table=${encodeURIComponent(selTable)}&limit=${PAGE}&offset=${offset}`, { bypassCache: true })
					.then((r) => setRows(r.rows))
					.catch(() => undefined);
			}
		}, 5000);
		return () => clearInterval(t);
	}, [selTable, offset, loadTables]);

	const meta = useMemo(() => (selTable && data ? data.metas[selTable] : undefined), [selTable, data]);

	// 选中表/翻页 → 加载行（offset 参与依赖；bypassCache：写后立即读必须拿新数据，否则「改了又变回去」）
	useEffect(() => {
		if (!selTable) return;
		setRows(null);
		setRowsErr(null);
		void apiGet<RowsPayload>(`/api/tables/rows?table=${encodeURIComponent(selTable)}&limit=${PAGE}&offset=${offset}`, { bypassCache: true })
			.then((r) => setRows(r.rows))
			.catch((e) => setRowsErr(e instanceof Error ? e.message : String(e)));
	}, [selTable, offset]);

	useEffect(() => {
		if (!meta) return;
		setRuleDraft(meta.description ?? "");
		setRuleDirty(false);
	}, [meta]);

	const refresh = useCallback(async () => {
		if (!selTable) return;
		setBusy(true);
		try {
			const r = await apiGet<RowsPayload>(`/api/tables/rows?table=${encodeURIComponent(selTable)}&limit=${PAGE}&offset=${offset}`, { bypassCache: true });
			setRows(r.rows);
			setRowsErr(null);
			await loadTables();
		} catch (e) {
			setRowsErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [selTable, offset, loadTables]);

	/** 行写入：构造 SQL 提交，报错外露 */
	const writeSql = useCallback(
		async (sql: string): Promise<boolean> => {
			setBusy(true);
			try {
				const r = await apiPost<{ ok: boolean; changes?: number; error?: string }>("/api/tables/rows", { sql });
				if (!r.ok) {
					setRowsErr(r.error ?? "写入失败");
					toast("error", r.error ?? "写入失败");
					return false;
				}
				await refresh();
				return true;
			} catch (e) {
				const m = e instanceof Error ? e.message : String(e);
				setRowsErr(m);
				toast("error", m);
				return false;
			} finally {
				setBusy(false);
			}
		},
		[refresh, toast],
	);

	const cellCommit = useCallback(
		(row: Record<string, unknown>, col: ColDef, v: string | boolean) => {
			const rid = row["__rowid"];
			if (rid === undefined) return;
			void writeSql(`UPDATE "${selTable}" SET "${col.name}" = ${lit(v, col.type)} WHERE rowid = ${rid}`);
		},
		[selTable, writeSql],
	);

	const addRow = useCallback(() => {
		void writeSql(`INSERT INTO "${selTable}" DEFAULT VALUES`);
	}, [selTable, writeSql]);

	const delRow = useCallback(
		(row: Record<string, unknown>) => {
			const rid = row["__rowid"];
			if (rid === undefined) return;
			void writeSql(`DELETE FROM "${selTable}" WHERE rowid = ${rid}`);
		},
		[selTable, writeSql],
	);

	const saveRule = useCallback(async () => {
		if (!meta) return;
		setBusy(true);
		try {
			const r = await apiPost<{ ok: boolean; error?: string }>("/api/tables", {
				action: "updateMeta",
				def: { ...meta, description: ruleDraft },
			});
			if (!r.ok) toast("error", r.error ?? "保存失败");
			else {
				setRuleDirty(false);
				toast("info", "表格说明已保存（下一拍场记按新规则）");
			}
			await loadTables();
		} finally {
			setBusy(false);
		}
	}, [meta, ruleDraft, toast, loadTables]);

	const createTable = useCallback(async () => {
		if (!newName.trim() || newCols.length === 0) {
			toast("error", "需要表名和至少一列");
			return;
		}
		setBusy(true);
		try {
			const r = await apiPost<{ ok: boolean; error?: string }>("/api/tables", {
				action: "create",
				def: {
					name: newName.trim(),
					auto: newAuto,
					description: newDesc,
					columns: newCols.map((c) => ({ name: c.name.trim(), type: c.type, description: c.description, primary: c.primary })),
				},
			});
			if (!r.ok) toast("error", r.error ?? "建表失败");
			else {
				setShowNew(false);
				setNewName("");
				setNewDesc("");
				setNewAuto(true);
				setNewCols([]);
				const d = await loadTables();
				if (d) setSelTable(newName.trim());
			}
		} finally {
			setBusy(false);
		}
	}, [newName, newCols, newDesc, newAuto, loadTables, toast]);

	const dropTable = useCallback(
		async (tableName: string) => {
			if (!window.confirm(`删除表「${tableName}」？表结构与数据将不可恢复。`)) return;
			setBusy(true);
			try {
				const r = await apiPost<{ ok: boolean; error?: string }>("/api/tables", { action: "drop", name: tableName });
				if (!r.ok) toast("error", r.error ?? "删表失败");
				else {
					if (selTable === tableName) {
						setSelTable(null);
						setRows(null);
					}
					const d = await loadTables();
					if (d && d.tables.length > 0) setSelTable(d.tables[0]!.name);
					else setSelTable(null);
				}
			} finally {
				setBusy(false);
			}
		},
		[selTable, loadTables, toast],
	);

	const gridCols = useMemo(() => (meta ? meta.columns.filter((c) => c.name !== "__rowid") : []), [meta]);

	// 分页派生：总行数（表清单）+ 页码
	const summary = useMemo(() => data?.tables.find((t) => t.name === selTable) ?? null, [data, selTable]);
	const totalPages = summary ? Math.max(1, Math.ceil(summary.rowCount / PAGE)) : 1;
	const pageNo = Math.min(totalPages, Math.floor(offset / PAGE) + 1);

	return (
		<div className="tbl-page">
			<div className="tbl-top">
				<span className="tbl-crumb">
					<span className="tbl-crumb-main">表格（SQL）</span>
				</span>
				<div className="tbl-top-actions">
					<button type="button" className="tbl-btn tbl-btn-primary tbl-btn-sm" disabled={busy} onClick={() => setShowNew(true)}>
						＋ 建表
					</button>
					<button type="button" className="tbl-btn tbl-btn-sm" disabled={!selTable || busy} onClick={() => void refresh()}>
						刷新
					</button>
					<button type="button" className="tbl-top-close" aria-label="关闭" onClick={onClose}>
						✕
					</button>
				</div>
			</div>

			<div className="tbl-body">
				{/* 表列表 */}
				<div className="tbl-side">
					<div className="tbl-side-sec">
						<div className="tbl-side-head">
							当前会话的表 <span className="tbl-count-badge">{data?.tables.length ?? 0}</span>
						</div>
						<div className="tbl-side-list">
							{(data?.tables ?? []).map((t) => (
								<button key={t.name} type="button" className={`tbl-tbl ${selTable === t.name ? "on" : ""}`} onClick={() => { setSelTable(t.name); setOffset(0); setTab("data"); }}>
									<span className="tbl-tbl-line">
										<span className="tbl-tbl-name">{t.name}</span>
										<span className="tbl-tbl-right">
											{t.auto ? <span className="tbl-badge tbl-badge-auto">auto</span> : null}
											<span className="tbl-tbl-meta">{t.rowCount} 行</span>
										</span>
									</span>
									<span
										role="button"
										tabIndex={0}
										className="tbl-tbl-del"
										title={`删除表「${t.name}」`}
										onClick={(e) => {
											e.stopPropagation();
											void dropTable(t.name);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.stopPropagation();
												void dropTable(t.name);
											}
										}}
									>
										<IconTrash size={12} />
									</span>
								</button>
							))}
							{!data || data.tables.length === 0 ? <div className="tbl-side-empty">还没有表——点「建表」创建第一张。</div> : null}
						</div>
					</div>
				</div>

				{/* 详情 */}
				<div className="tbl-main">
					{!meta ? (
						<div className="tbl-empty">
							<div>选择左侧的一张表，或新建一张。</div>
						</div>
					) : (
						<>
							<div className="tbl-tabs">
								<button type="button" className={tab === "data" ? "on" : ""} onClick={() => setTab("data")}>
									数据
								</button>
								<button type="button" className={tab === "rule" ? "on" : ""} onClick={() => setTab("rule")}>
									说明与规则
								</button>
							</div>

							{tab === "data" ? (
								<div className="tbl-data-view">
									<div className="tbl-toolbar">
										<span className="tbl-row-count">
											{meta.name} · {meta.columns.length} 列{meta.auto ? " · 场记自动维护" : " · 手动维护"}
										</span>
										<div className="tbl-toolbar-actions">
											<button type="button" className="tbl-btn tbl-btn-sm" disabled={busy} onClick={addRow}>
												＋ 加行
											</button>
											<button type="button" className="tbl-btn tbl-btn-sm" disabled={offset === 0 || busy} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
												上一页
											</button>
											<span className="tbl-row-count">
												第 {pageNo} / {totalPages} 页（共 {summary?.rowCount ?? 0} 行）
											</span>
											<button type="button" className="tbl-btn tbl-btn-sm" disabled={pageNo >= totalPages || busy} onClick={() => setOffset((o) => o + PAGE)}>
												下一页
											</button>
											<input
												className="tbl-input tbl-jump-input"
												type="number"
												min={1}
												max={totalPages}
												placeholder="跳页"
												title="输入页码回车跳转"
												onKeyDown={(e) => {
													if (e.key !== "Enter") return;
													const n = Number((e.target as HTMLInputElement).value);
													if (Number.isFinite(n) && n >= 1 && n <= totalPages) setOffset((n - 1) * PAGE);
												}}
											/>
										</div>
									</div>
									{rowsErr ? <div className="tbl-side-err">SQL 报错：{rowsErr}</div> : null}
									<div className="tbl-grid-wrap">
										{rows === null ? (
											<div className="tbl-grid-empty">加载中…</div>
										) : rows.length === 0 ? (
											<div className="tbl-records-empty">还没有行数据，点「＋ 加行」开始录入。</div>
										) : (
											<div className="tbl-records">
												{rows.map((row, i) => (
													<div key={String(row["__rowid"] ?? i)} className="tbl-record">
														<div className="tbl-record-head">
															<span className="tbl-record-title" title={`第 ${offset + i + 1} 条记录`}>
																#{offset + i + 1}
															</span>
															<button type="button" className="tbl-icon-btn danger" title="删除此行" onClick={() => delRow(row)}>
																<IconTrash size={12} />
															</button>
														</div>
														<div className="tbl-record-fields">
															{gridCols.map((c) => {
																// 长文本跨满整行，短字段并排
																const span = String(row[c.name] ?? "").length > 40;
																return (
																	<div key={c.name} className={`tbl-record-field ${span ? "span" : ""}`}>
																		<span className="tbl-record-label" title={c.name}>
																			{c.name}
																		</span>
																		<span className="tbl-record-value">
																			<DataCell value={row[c.name]} type={c.type} onCommit={(v) => cellCommit(row, c, v)} />
																		</span>
																	</div>
																);
															})}
														</div>
													</div>
												))}
											</div>
										)}
									</div>
								</div>
							) : (
								<div className="tbl-structure-view">
									<div className="tbl-card">
										<div className="tbl-card-head">
											<span>表格说明与维护规则</span>
											{ruleDirty ? <span className="tbl-save-dirty">未保存</span> : <span className="tbl-save-clean">已同步</span>}
										</div>
										<div className="tbl-card-body">
											<textarea
												className="tbl-input tbl-input-ta"
												rows={14}
												placeholder="表格说明 / 维护规则（场记代理按此规则用 SQL 维护本表）"
												value={ruleDraft}
												onChange={(e) => {
													setRuleDraft(e.target.value);
													setRuleDirty(true);
												}}
											/>
											<div className="tbl-card-hint">
												保存后下一拍场记按新规则执行，无需重建表。维护规则里可以直接写 SQL 工具用法（sql_read / sql_write）。
											</div>
											<button type="button" className="tbl-btn tbl-btn-primary tbl-btn-sm" disabled={!ruleDirty || busy} onClick={() => void saveRule()}>
												保存
											</button>
										</div>
									</div>
									<div className="tbl-card">
										<div className="tbl-card-head">
											<span>结构（列定义）</span>
										</div>
										<div className="tbl-card-body">
											<div className="tbl-grid-wrap">
												<table className="tbl-grid">
													<thead>
														<tr>
															<th className="tbl-rowno">#</th>
															<th>列名</th>
															<th>类型</th>
															<th>主键</th>
															<th>引用</th>
															<th>说明</th>
														</tr>
													</thead>
													<tbody>
														{meta.columns.map((c, i) => (
															<tr key={c.name}>
																<td className="tbl-rowno">{i + 1}</td>
																<td>{c.name}</td>
																<td>{c.type}</td>
																<td>{c.primary ? "✓" : ""}</td>
																<td>{c.ref ? `${c.ref.table}.${c.ref.column}` : ""}</td>
																<td>{c.description ?? ""}</td>
															</tr>
														))}
													</tbody>
												</table>
											</div>
											<div className="tbl-card-hint">改列结构 = 重建表（SQLite 限制）；当前版本请删表重建。</div>
										</div>
									</div>
								</div>
							)}
						</>
					)}
				</div>
			</div>

			{/* 建表向导 */}
			{showNew ? (
				<div className="tbl-modal-scrim" role="presentation" onClick={() => setShowNew(false)}>
					<div className="tbl-modal" role="dialog" aria-label="建表" onClick={(e) => e.stopPropagation()}>
						<div className="tbl-modal-head">建表</div>
						<div className="tbl-modal-body">
							<div className="tbl-form-grid">
								<label className="tbl-form-field">
									<span>表名</span>
									<input className="tbl-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如 好感度表（中文/字母/数字/下划线）" />
								</label>
								<label className="tbl-form-field tbl-form-field-toggle">
									<span>场记每轮自动维护（auto）</span>
									<input type="checkbox" checked={newAuto} onChange={(e) => setNewAuto(e.target.checked)} />
								</label>
							</div>
							<div className="tbl-cols">
								{newCols.map((c, i) => (
									<div key={i} className="tbl-col-row">
										<span className="tbl-col-idx">{i + 1}</span>
										<input className="tbl-input tbl-col-name" placeholder="列名" value={c.name} onChange={(e) => setNewCols((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
										<select
											className="tbl-input tbl-input-select tbl-col-type-select"
											value={c.type}
											onChange={(e) => setNewCols((cs) => cs.map((x, j) => (j === i ? { ...x, type: e.target.value as ColType } : x)))}
										>
											<option value="text">text</option>
											<option value="number">number</option>
											<option value="integer">integer</option>
											<option value="real">real</option>
											<option value="boolean">boolean</option>
										</select>
										<label className="tbl-form-field-toggle">
											<input type="checkbox" checked={c.primary} onChange={(e) => setNewCols((cs) => cs.map((x, j) => (j === i ? { ...x, primary: e.target.checked } : x)))} />
											主键
										</label>
										<input className="tbl-input tbl-col-desc" placeholder="列说明（可选）" value={c.description} onChange={(e) => setNewCols((cs) => cs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
										<button type="button" className="tbl-icon-btn danger" title="移除列" onClick={() => setNewCols((cs) => cs.filter((_, j) => j !== i))}>
											<IconTrash size={12} />
										</button>
									</div>
								))}
								<button type="button" className="tbl-btn tbl-btn-sm" onClick={() => setNewCols((cs) => [...cs, { name: "", type: "text", description: "", primary: false }])}>
									＋ 加一列
								</button>
							</div>
							<label className="tbl-form-field">
								<span>表格说明 / 维护规则（可选）</span>
								<textarea className="tbl-input tbl-input-ta" rows={4} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="维护规则：场记按此规则用 sql_read/sql_write 维护本表" />
							</label>
						</div>
						<div className="tbl-modal-foot">
							<button type="button" className="tbl-btn" onClick={() => setShowNew(false)}>
								取消
							</button>
							<button type="button" className="tbl-btn tbl-btn-primary" disabled={busy} onClick={() => void createTable()}>
								创建
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
