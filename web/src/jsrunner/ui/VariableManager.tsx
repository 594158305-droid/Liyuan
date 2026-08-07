/**
 * JS Runner 变量管理器（M4b）。
 *
 * 自足组件：不依赖面板外壳 props，内部直接用 context.ts 的 setVar / deleteVar 与
 * buildSnapshot()。作用域切换（global / chat）后从快照重读对应 vars / chatVars；
 * 编辑 / 删除 / 新增后立即更新本地 state——extdata 持久化是防抖异步的，
 * 本地展示以编辑操作为准，不依赖快照回流。
 *
 * 新增 / 编辑的 value 输入统一：先尝试 JSON.parse，成功按解析值存，失败按字符串存
 * （对齐 getVar「存什么取什么」，脚本侧读到的值类型可预期）。
 *
 * 导出：默认导出 VariableManager（同时提供同名命名导出，两种 import 写法均可）。
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import { buildSnapshot, deleteVar, setVar } from "../context.ts";
import { ConfirmButton } from "../../components/kit.tsx";
import { IconPencil, IconTrash } from "../../components/icons.tsx";

/** 变量作用域（对齐 context.ts 的 getVar/setVar 第二参） */
type Scope = "global" | "chat";

/** 解析输入文本为变量值：JSON.parse 成功用解析结果，失败（含空串）按字符串存 */
function parseValueText(raw: string): unknown {
	const t = raw.trim();
	if (!t) return t;
	try {
		return JSON.parse(t);
	} catch {
		return t;
	}
}

/** 值 → JSON 展示文本（字符串也带引号，与存储语义一致；不可序列化时 String 化兜底） */
function formatValue(v: unknown): string {
	if (typeof v === "string") return JSON.stringify(v);
	try {
		return JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}

/** 单行变量行：展示 key / value / 操作；编辑态换成 inline textarea（JSON） */
function VarRow({
	name,
	value,
	editing,
	draft,
	onDraftChange,
	onEdit,
	onSave,
	onCancelEdit,
	onDelete,
}: {
	name: string;
	value: unknown;
	editing: boolean;
	draft: string;
	onDraftChange: (text: string) => void;
	onEdit: () => void;
	onSave: () => void;
	onCancelEdit: () => void;
	onDelete: () => void;
}) {
	const display = formatValue(value);
	if (editing) {
		return (
			<li className="varman-row" style={{ flexDirection: "column" }}>
				<div className="varman-edit">
					<textarea
						className="panel-search ta"
						rows={4}
						value={draft}
						onChange={(e) => onDraftChange(e.target.value)}
						placeholder="JSON 值（非 JSON 按字符串存）"
					/>
					<div className="panel-row">
						<button type="button" className="drawer-btn" onClick={onSave}>
							保存
						</button>
						<button type="button" className="drawer-btn" onClick={onCancelEdit}>
							取消
						</button>
					</div>
				</div>
			</li>
		);
	}
	return (
		<li className="varman-row">
			<div className="varman-key" title={name}>
				{name}
			</div>
			<div className="varman-value" title={display}>
				{display}
			</div>
			<div className="varman-ops">
				<button type="button" className="act" title="编辑" onClick={onEdit}>
					<IconPencil size={12} /> 编辑
				</button>
				<ConfirmButton confirmText="再点确认" title="删除" onConfirm={onDelete}>
					<IconTrash size={12} /> 删除
				</ConfirmButton>
			</div>
		</li>
	);
}

function VariableManager(): JSX.Element {
	const [scope, setScope] = useState<Scope>("global");
	const [vars, setVars] = useState<Record<string, unknown>>({});
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [editDraft, setEditDraft] = useState("");
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");

	// 从快照重读当前作用域变量（挂载 + 切换作用域时触发；之后本地 state 以编辑操作为准）
	const reload = useCallback(() => {
		const snap = buildSnapshot();
		setVars(scope === "chat" ? snap.chatVars : snap.vars);
	}, [scope]);

	useEffect(() => {
		reload();
	}, [reload]);

	// 键排序展示（稳定、易检索）
	const rows = Object.entries(vars).sort(([a], [b]) => a.localeCompare(b));

	const add = () => {
		const key = newKey.trim();
		if (!key) return;
		const value = parseValueText(newValue);
		setVar(key, value, scope);
		setVars((prev) => ({ ...prev, [key]: value }));
		setNewKey("");
		setNewValue("");
	};

	const startEdit = (key: string) => {
		setEditDraft(formatValue(vars[key]));
		setEditingKey(key);
	};

	const saveEdit = (key: string) => {
		const value = parseValueText(editDraft);
		setVar(key, value, scope);
		setVars((prev) => ({ ...prev, [key]: value }));
		setEditingKey(null);
	};

	const remove = (key: string) => {
		deleteVar(key, scope);
		setVars((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
		if (editingKey === key) setEditingKey(null);
	};

	return (
		<div className="varman">
			<div className="seg-row" role="tablist" aria-label="变量作用域">
				<button
					type="button"
					role="tab"
					aria-selected={scope === "global"}
					className={`seg ${scope === "global" ? "active" : ""}`}
					onClick={() => setScope("global")}
				>
					全局
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={scope === "chat"}
					className={`seg ${scope === "chat" ? "active" : ""}`}
					onClick={() => setScope("chat")}
				>
					聊天
				</button>
			</div>
			<div className="field-hint">
				{scope === "global"
					? "全局变量跨会话共享，所有脚本可读写。"
					: "聊天变量随当前会话隔离，新会话从空开始。"}
				extdata 持久化有 300ms 防抖，编辑后立即生效、无需等待刷新。
			</div>

			{/* 新增变量行：key + value（value 尝试 JSON.parse，失败按字符串存） */}
			<div className="panel-row varman-add">
				<input
					className="panel-search"
					placeholder="变量名（key）"
					value={newKey}
					onChange={(e) => setNewKey(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && add()}
				/>
				<input
					className="panel-search"
					placeholder="值（JSON，非 JSON 按字符串存）"
					value={newValue}
					onChange={(e) => setNewValue(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && add()}
				/>
				<button type="button" className="drawer-btn" disabled={!newKey.trim()} onClick={add}>
					新增
				</button>
			</div>

			{rows.length === 0 ? (
				<div className="sp-empty">该作用域暂无变量。</div>
			) : (
				<ul className="varman-list">
					{rows.map(([key, value]) => (
						<VarRow
							key={key}
							name={key}
							value={value}
							editing={editingKey === key}
							draft={editDraft}
							onDraftChange={setEditDraft}
							onEdit={() => startEdit(key)}
							onSave={() => saveEdit(key)}
							onCancelEdit={() => setEditingKey(null)}
							onDelete={() => remove(key)}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

export default VariableManager;
export { VariableManager };
