/**
 * JS Runner 脚本管理面板（M4a）。
 *
 * 挂载点：PowersPanel「扩展能力」下的「脚本」tab（与技能/MCP 并列）。
 * 内部自管状态，不依赖 App props 注入数据；唯一外部依赖是 toast 通知（与其它面板一致）。
 *
 * 数据流：
 * - 挂载时 `getExtData("global","scripts")` 读脚本列表；是数组则 `scriptRuntimes.setScripts(list)`
 *   增量启停 iframe（M3a 增量管理：只重建启停 / content 变化的脚本）；
 * - 任何改动走 `saveList`：`putExtData("global","scripts", next)` 持久化 + `scriptRuntimes.setScripts(next)`
 *   即时生效；
 * - 面板卸载（useEffect cleanup）不 dispose 运行时——脚本保持运行（宿主生命周期）。
 *
 * tab 结构：脚本（核心，本文件实现）/ 日志 / 变量。
 * 日志 / 变量组件由并行任务产出（LogViewer.tsx / VariableManager.tsx），此处直接挂载。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGetCacheClear, downloadText, getExtData, putExtData } from "../../api.ts";
import { ConfirmButton } from "../../components/kit.tsx";
import { IconPencil, IconTrash } from "../../components/icons.tsx";
import { scriptRuntimes } from "../runtime.ts";
import type { ScriptMeta } from "../types.ts";
import { LogViewer } from "./LogViewer.tsx";
import { VariableManager } from "./VariableManager.tsx";

/** 脚本持久化键（M1 extdata 通道：GET/PUT /api/extdata?scope=global&key=scripts） */
const SCRIPTS_SCOPE = "global";
const SCRIPTS_KEY = "scripts";

/** 自动脚本 id：crypto.randomUUID 优先，兜底时间戳+随机 */
function newScriptId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `script-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 导入校验 / 字段补默认：非法条目（非对象 / 缺 id）返回 null 由调用方跳过。
 * ScriptMeta：{ id, name, content, enabled, info?, buttons? }
 */
function normalizeScriptMeta(raw: unknown): ScriptMeta | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const id = typeof o.id === "string" && o.id.trim() ? o.id : "";
	if (!id) return null; // 无 id 无法管理，跳过
	const name = typeof o.name === "string" && o.name.trim() ? o.name : "未命名脚本";
	const content = typeof o.content === "string" ? o.content : "";
	const enabled = o.enabled !== false;
	const info = typeof o.info === "string" && o.info.trim() ? o.info : undefined;
	let buttons: ScriptMeta["buttons"];
	if (Array.isArray(o.buttons)) {
		const list = o.buttons
			.filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
			.map((b) => ({
				name: typeof b.name === "string" ? b.name : "",
				visible: b.visible !== false,
			}))
			.filter((b) => b.name);
		if (list.length) buttons = list;
	}
	const meta: ScriptMeta = { id, name, content, enabled };
	if (info) meta.info = info;
	if (buttons) meta.buttons = buttons;
	return meta;
}

/** 单脚本行：启用开关 + 名称 + 编辑/删除；点击展开编辑器（草稿行内自管） */
function ScriptRow({
	script,
	open,
	busy,
	onToggleOpen,
	onToggleEnabled,
	onSave,
	onDelete,
}: {
	script: ScriptMeta;
	open: boolean;
	busy: boolean;
	onToggleOpen: () => void;
	onToggleEnabled: (enabled: boolean) => void;
	onSave: (patch: { name: string; content: string }) => Promise<void>;
	onDelete: () => void;
}) {
	const [name, setName] = useState(script.name);
	const [content, setContent] = useState(script.content);
	const [saving, setSaving] = useState(false);
	// 草稿只初始化一次：外部列表更新（如启停开关、导入）不覆盖未保存的编辑

	const save = async () => {
		if (!name.trim()) return;
		setSaving(true);
		try {
			await onSave({ name: name.trim(), content });
		} finally {
			setSaving(false);
		}
	};

	const cancel = () => {
		// 放弃未保存的草稿，回到已持久化值
		setName(script.name);
		setContent(script.content);
		onToggleOpen();
	};

	return (
		<div className="lore-item">
			<div className="lore-head">
				<label className="expose-toggle" title="开=运行脚本 iframe（事件/日志桥激活）；关=停止">
					<input
						type="checkbox"
						checked={script.enabled}
						disabled={busy || saving}
						onChange={(e) => onToggleEnabled(e.target.checked)}
					/>
					<span className="expose-label">{script.enabled ? "运行中" : "已停用"}</span>
				</label>
				<button type="button" className="dock-name" onClick={onToggleOpen} title="点击展开 / 收起编辑器">
					{script.name}
				</button>
				<div className="skill-acts">
					<button className="act" onClick={onToggleOpen}>
						<IconPencil size={12} /> 编辑
					</button>
					<ConfirmButton confirmText="确认删除" disabled={busy || saving} onConfirm={onDelete}>
						<IconTrash size={12} /> 删除
					</ConfirmButton>
				</div>
			</div>
			{open && (
				<div className="skill-edit">
					<input
						className="panel-search"
						placeholder="脚本名"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<textarea
						className="panel-search ta"
						rows={8}
						spellCheck={false}
						placeholder="// 沙箱 iframe 中运行，可调用 TavernHelper.* / getContext() / $ / YAML / eventOn…"
						value={content}
						onChange={(e) => setContent(e.target.value)}
						style={{
							fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
							minHeight: 160,
						}}
					/>
					<div className="panel-row">
						<button className="drawer-btn" disabled={busy || saving || !name.trim()} onClick={() => void save()}>
							{saving ? "保存中…" : "保存"}
						</button>
						<button className="drawer-btn" onClick={cancel}>
							取消
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

export function JsRunnerPanel({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const [tab, setTab] = useState<"scripts" | "logs" | "vars">("scripts");
	/** null = 首次读取中 */
	const [scripts, setScripts] = useState<ScriptMeta[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/** 当前展开编辑器的脚本 id（点行展开 / 新建自动展开） */
	const [openId, setOpenId] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	/** 挂载 / 刷新：读 extdata → 是数组则同步进运行时；非数组按空列表 */
	const reload = useCallback(async () => {
		// PUT 写后已整表清 GET 缓存；刷新时再显式清一次 extdata 前缀，避免 180s TTL 内吃旧值
		apiGetCacheClear("/api/extdata");
		try {
			const value = await getExtData(SCRIPTS_SCOPE, SCRIPTS_KEY);
			const list = Array.isArray(value)
				? value.map(normalizeScriptMeta).filter((s): s is ScriptMeta => s !== null)
				: [];
			setScripts(list);
			setError(null);
			// 仅数组形状同步运行时（空/首次也同步一次空列表，确保运行时与面板一致）
			scriptRuntimes.setScripts(list);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setScripts((s) => s ?? []);
		}
	}, []);

	useEffect(() => {
		void reload();
		// 卸载不 dispose 运行时：脚本保持运行（宿主生命周期）
	}, [reload]);

	/** 保存：PUT 持久化 + 增量同步运行时（增删 / 启停 / content 变化即时生效）。busy 期间忽略重入 */
	const saveList = async (next: ScriptMeta[], doneText?: string): Promise<void> => {
		if (busy) return;
		setBusy(true);
		try {
			await putExtData(SCRIPTS_SCOPE, SCRIPTS_KEY, next);
			scriptRuntimes.setScripts(next);
			setScripts(next);
			setError(null);
			if (doneText) toast("info", doneText);
		} catch (e) {
			toast("error", `保存失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(false);
		}
	};

	const addScript = async () => {
		const id = newScriptId();
		const entry: ScriptMeta = { id, name: "新脚本", content: "", enabled: true };
		await saveList([...(scripts ?? []), entry]);
		setOpenId(id); // 新建即展开编辑器
	};

	const toggleEnabled = (id: string, enabled: boolean) => {
		void saveList(
			(scripts ?? []).map((s) => (s.id === id ? { ...s, enabled } : s)),
		);
	};

	const saveScript = async (id: string, patch: { name: string; content: string }) => {
		await saveList(
			(scripts ?? []).map((s) => (s.id === id ? { ...s, name: patch.name, content: patch.content } : s)),
			"已保存",
		);
	};

	const removeScript = (id: string) => {
		void saveList(
			(scripts ?? []).filter((s) => s.id !== id),
			"已删除",
		);
	};

	const importFile = async (file: File) => {
		try {
			const body: unknown = JSON.parse(await file.text());
			// 兼容直接数组 与 { scripts: [...] } 导出信封
			const rawArr: unknown = Array.isArray(body)
				? body
				: body && typeof body === "object"
					? (body as { scripts?: unknown }).scripts
					: null;
			if (!Array.isArray(rawArr)) throw new Error("导入文件须为脚本 JSON 数组（或 { scripts: [...] }）");
			const imported = rawArr.map(normalizeScriptMeta).filter((s): s is ScriptMeta => s !== null);
			if (imported.length === 0) throw new Error("文件中没有可用的脚本条目（缺 id 的已跳过）");
			// 合并：按 id 去重，已有 id 保留本地版本
			const merged = new Map((scripts ?? []).map((s) => [s.id, s]));
			let added = 0;
			for (const s of imported) {
				if (!merged.has(s.id)) {
					merged.set(s.id, s);
					added++;
				}
			}
			if (added === 0) {
				toast("info", "没有可合并的新脚本（id 已存在）");
				return;
			}
			await saveList([...merged.values()], `已导入 ${added} 个脚本`);
		} catch (e) {
			toast("error", `导入失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	const exportAll = () => {
		const list = scripts ?? [];
		if (list.length === 0) {
			toast("info", "没有可导出的脚本");
			return;
		}
		// 导出为 JSON 数组，可直接再次导入
		downloadText(
			`liyuan-scripts-${new Date().toISOString().slice(0, 10)}.json`,
			JSON.stringify(list, null, "\t"),
		);
	};

	return (
		<section className="sp-section">
			<div className="seg-row seg-tabs">
				<button type="button" className={`seg ${tab === "scripts" ? "active" : ""}`} onClick={() => setTab("scripts")}>
					脚本{scripts ? `（${scripts.length}）` : ""}
				</button>
				<button type="button" className={`seg ${tab === "logs" ? "active" : ""}`} onClick={() => setTab("logs")}>
					日志
				</button>
				<button type="button" className={`seg ${tab === "vars" ? "active" : ""}`} onClick={() => setTab("vars")}>
					变量
				</button>
			</div>

			{tab === "scripts" && (
				<>
					<div className="field-hint" style={{ marginTop: 10 }}>
						脚本运行在沙箱 iframe 中（ES module，支持顶层 <code>import</code> / <code>import()</code>），
						可调用 <code>TavernHelper.*</code>（宿主方法 invoke）、<code>getContext()</code>、
						<code>$</code> / <code>YAML</code>。保存内容或切换启用开关
						<strong>即时生效</strong>（运行时增量启停 iframe）。
					</div>
					<div className="panel-row" style={{ marginTop: 8 }}>
						<button className="drawer-btn" disabled={busy} onClick={() => void addScript()}>
							＋ 新建脚本
						</button>
						<button className="drawer-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
							导入 JSON
						</button>
						<button className="drawer-btn" disabled={busy || !(scripts ?? []).length} onClick={exportAll}>
							导出 JSON
						</button>
						<input
							ref={fileRef}
							type="file"
							accept=".json,application/json"
							hidden
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) void importFile(f);
								if (fileRef.current) fileRef.current.value = "";
							}}
						/>
					</div>
					{error ? (
						<div className="field-hint" style={{ color: "var(--danger, #c44)" }}>
							{error}
						</div>
					) : null}
					{scripts === null && !error ? <div className="sp-empty">读取中…</div> : null}
					{scripts !== null && scripts.length === 0 && !error ? (
						<div className="sp-empty">
							还没有脚本。脚本运行在沙箱 iframe 中，可调用 <code>TavernHelper</code> API——
							如 <code>eventOn("MESSAGE_RECEIVED", cb)</code>、<code>getContext()</code>、
							<code>console.log</code> 输出会透传到宿主。点「＋ 新建脚本」或导入 JSON 开始。
						</div>
					) : null}
					{scripts !== null
						? scripts.map((s) => (
								<ScriptRow
									key={s.id}
									script={s}
									open={openId === s.id}
									busy={busy}
									onToggleOpen={() => setOpenId((cur) => (cur === s.id ? null : s.id))}
									onToggleEnabled={(en) => toggleEnabled(s.id, en)}
									onSave={(patch) => saveScript(s.id, patch)}
									onDelete={() => removeScript(s.id)}
								/>
							))
						: null}
				</>
			)}

			{tab === "logs" && <LogViewer />}
			{tab === "vars" && <VariableManager />}
		</section>
	);
}
