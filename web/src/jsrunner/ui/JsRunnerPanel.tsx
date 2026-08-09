/**
 * JS Runner 脚本管理面板（M4a，P0 拆文件存储改造）。
 *
 * 挂载点：PowersPanel「扩展能力」下的「脚本」tab（与技能/MCP 并列）。
 * 内部自管状态，不依赖 App props 注入数据；唯一外部依赖是 toast 通知（与其它面板一致）。
 *
 * P0 拆文件存储（D3 §3.3 / D4 §2.9）：
 * - ScriptMeta 引用化：content 不再内联进 extdata；主脚本文件与附带数据走 /api/upload，
 *   登记 file（主脚本引用）与 assets（附带数据引用）；
 * - 导入 = 多文件：第一个 .js = 主脚本（R4-② 强制校验），其余 = 附带数据（R2-①）；
 * - 导出 = 主脚本单文件下载（R2-①，assets 不并回）；编辑 = 统一外部编辑（只读查看 + 下载，R2-②）；
 * - 删除 = 级联清理登记文件（R2-③，失败仅 console.warn 不阻塞）。
 *
 * 数据流：
 * - 挂载时 `getExtData("global","scripts")` 读脚本列表；是数组则 `scriptRuntimes.setScripts(list)`
 *   增量启停 iframe（M3a 增量管理）；
 * - 任何改动走 `saveList`：`putExtData("global","scripts", next)` 持久化 + `scriptRuntimes.setScripts(next)`
 *   即时生效；
 * - 面板卸载（useEffect cleanup）不 dispose 运行时——脚本保持运行（宿主生命周期）。
 *
 * tab 结构：脚本（核心，本文件实现）/ 日志 / 变量。
 * 日志 / 变量组件由并行任务产出（LogViewer.tsx / VariableManager.tsx），此处直接挂载。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiGetCacheClear, downloadText, getExtData, putExtData, uploadFile } from "../../api.ts";
import { ConfirmButton } from "../../components/kit.tsx";
import { IconPencil, IconTrash } from "../../components/icons.tsx";
import { scriptRuntimes } from "../runtime.ts";
import type { ScriptMeta } from "../types.ts";
import { LogViewer } from "./LogViewer.tsx";
import { VariableManager } from "./VariableManager.tsx";

/** 脚本持久化键（M1 extdata 通道：GET/PUT /api/extdata?scope=global&key=scripts） */
const SCRIPTS_SCOPE = "global";
const SCRIPTS_KEY = "scripts";

/** 上传区相对路径前缀（服务端 saveUpload 返回的 file 字段）与静态托管 URL 前缀 */
const UPLOAD_PREFIX = ".liyuan-uploads/";
const UPLOAD_URL_PREFIX = "/uploads/";

/**
 * 上传引用换算：
 * - `uploadFile` 返回的 `file` 字段是服务端相对路径 `.liyuan-uploads/<时间戳>-<安全名>`；
 *   服务端 `sanitizeUploadName` 用 basename 剥目录 → 传 name 带 `jsrunner/` 子目录不可行，
 *   故登记引用统一用可访问的相对路径 `/uploads/<时间戳>-<安全名>`（`/uploads/` 静态托管 = .liyuan-uploads/）。
 * - `DELETE /api/uploads` 只接受 `.liyuan-uploads/<文件名>`（顶层，无子目录），删除时反向拼回。
 */
function uploadRef(file: string): string {
	return UPLOAD_URL_PREFIX + file.replace(/^\.liyuan-uploads\//, "");
}
function toDeleteParam(ref: string): string {
	return ref.replace(/^\/uploads\//, UPLOAD_PREFIX);
}

/** 自动脚本 id：crypto.randomUUID 优先，兜底时间戳+随机 */
function newScriptId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `script-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 导入校验 / 字段补默认：非法条目（非对象 / 缺 id）返回 null 由调用方跳过。
 * ScriptMeta 引用化（P0）：{ id, name, file?, assets?, enabled, info?, buttons? }——
 * file 优先于 content；content 保留兼容旧数据（读取时 file 优先）。
 */
function normalizeScriptMeta(raw: unknown): ScriptMeta | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const id = typeof o.id === "string" && o.id.trim() ? o.id : "";
	if (!id) return null; // 无 id 无法管理，跳过
	const name = typeof o.name === "string" && o.name.trim() ? o.name : "未命名脚本";
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
	const meta: ScriptMeta = { id, name, enabled };
	const file = typeof o.file === "string" && o.file.trim() ? o.file : undefined;
	if (file) meta.file = file;
	if (Array.isArray(o.assets)) {
		const assets = o.assets.filter((a): a is string => typeof a === "string" && !!a.trim());
		if (assets.length) meta.assets = assets;
	}
	// 旧数据内联 content 保留（兼容）；file 存在时运行时取 file，忽略 content
	const content = typeof o.content === "string" && o.content ? o.content : undefined;
	if (content) meta.content = content;
	if (info) meta.info = info;
	if (buttons) meta.buttons = buttons;
	return meta;
}

/** 单脚本行：启用开关 + 名称 + 查看(只读)/下载/删除；点击展开查看器（草稿行内自管） */
function ScriptRow({
	script,
	open,
	busy,
	onToggleOpen,
	onToggleEnabled,
	onSave,
	onDelete,
	onDownload,
}: {
	script: ScriptMeta;
	open: boolean;
	busy: boolean;
	onToggleOpen: () => void;
	onToggleEnabled: (enabled: boolean) => void;
	onSave: (patch: { name: string }) => Promise<void>;
	onDelete: () => void;
	onDownload: () => Promise<void>;
}) {
	const [name, setName] = useState(script.name);
	/** 只读查看内容：file 存在时展开拉取；否则旧版内联 content */
	const [view, setView] = useState<string>(script.content ?? "");
	const [viewLoading, setViewLoading] = useState(false);
	const [viewError, setViewError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// 展开时加载只读内容（R2-② 统一外部编辑：面板内不可改内容）
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		const load = async () => {
			if (script.file) {
				setViewLoading(true);
				setViewError(null);
				try {
					const res = await fetch(script.file);
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const text = await res.text();
					if (!cancelled) setView(text);
				} catch (e) {
					if (!cancelled) setViewError(e instanceof Error ? e.message : String(e));
				} finally {
					if (!cancelled) setViewLoading(false);
				}
			} else {
				setView(script.content ?? "");
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [open, script.file, script.content]);

	const save = async () => {
		if (!name.trim()) return;
		setSaving(true);
		try {
			await onSave({ name: name.trim() });
		} finally {
			setSaving(false);
		}
	};

	const cancel = () => {
		// 放弃未保存的名称草稿，回到已持久化值
		setName(script.name);
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
				<button type="button" className="dock-name" onClick={onToggleOpen} title="点击展开 / 收起查看器">
					{script.name}
				</button>
				<div className="skill-acts">
					<button className="act" onClick={onToggleOpen}>
						<IconPencil size={12} /> 查看
					</button>
					<button
						className="act"
						disabled={!script.file}
						title={script.file ? "下载脚本文件" : "该脚本没有文件（旧版内联 / 空脚本）"}
						onClick={() => void onDownload()}
					>
						下载
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
						readOnly
						spellCheck={false}
						placeholder={
							script.file
								? "脚本内容从 /uploads/ 加载（只读）"
								: "空脚本：暂无文件内容（创建/导入后以空 iframe 运行）"
						}
						value={viewLoading ? "加载中…" : view}
						style={{
							fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
							minHeight: 160,
						}}
					/>
					{viewError ? (
						<div className="field-hint" style={{ color: "var(--danger, #c44)" }}>
							读取失败：{viewError}（可下载失败原文件后重新导入覆盖）
						</div>
					) : null}
					<div className="field-hint" style={{ marginTop: 6 }}>
						编辑：下载后修改，重新导入覆盖（统一外部编辑）。
						{script.file ? (
							<>
								{" "}
								脚本文件：<code>{script.file}</code>
							</>
						) : null}
						{script.assets?.length ? (
							<>
								{" "}
								附带数据（{script.assets.length}）：<code>{script.assets.join("、")}</code>
							</>
						) : null}
					</div>
					<div className="panel-row">
						<button className="drawer-btn" disabled={busy || saving || !name.trim()} onClick={() => void save()}>
							{saving ? "保存中…" : "保存名称"}
						</button>
						<button className="drawer-btn" disabled={!script.file} onClick={() => void onDownload()}>
							下载 .js
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
	/** 当前展开查看器的脚本 id（点行展开 / 新建自动展开） */
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

	/** 保存：PUT 持久化 + 增量同步运行时（增删 / 启停即时生效）。busy 期间忽略重入 */
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
		// 空脚本：file 为空 → 运行时回退 content（无则空 iframe）
		const entry: ScriptMeta = { id, name: "新脚本", enabled: true };
		await saveList([...(scripts ?? []), entry]);
		setOpenId(id); // 新建即展开
	};

	const toggleEnabled = (id: string, enabled: boolean) => {
		void saveList(
			(scripts ?? []).map((s) => (s.id === id ? { ...s, enabled } : s)),
		);
	};

	/** 保存仅剩元数据（name/enabled/info/buttons）：内容走文件通道，不在面板内编辑（R2-②） */
	const saveScript = async (id: string, patch: { name: string }) => {
		await saveList(
			(scripts ?? []).map((s) => (s.id === id ? { ...s, name: patch.name } : s)),
			"已保存",
		);
	};

	/**
	 * 删除（R2-③ 级联清理）：先逐个 DELETE /api/uploads 清理登记文件（file + assets），
	 * 失败仅 console.warn 不阻塞；再从元数据移除 → setScripts → toast「已删除」。
	 */
	const removeScript = async (id: string) => {
		const target = (scripts ?? []).find((s) => s.id === id);
		if (target) {
			const refs = [target.file, ...(target.assets ?? [])];
			for (const ref of refs) {
				if (!ref) continue;
				try {
					await apiDelete(`/api/uploads?file=${encodeURIComponent(toDeleteParam(ref))}`);
				} catch (e) {
					console.warn("[jsrunner] 删除上传文件失败（忽略，孤儿文件可手动清理）", ref, e);
				}
			}
		}
		await saveList(
			(scripts ?? []).filter((s) => s.id !== id),
			"已删除",
		);
	};

	/** 下载主脚本单文件（R2-①：assets 不并回；R2-② 外部编辑入口） */
	const downloadScript = async (s: ScriptMeta) => {
		if (!s.file) {
			toast("info", "该脚本没有文件可下载（空脚本 / 旧版内联）");
			return;
		}
		try {
			const res = await fetch(s.file);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const text = await res.text();
			const fname = /\.js$/i.test(s.name) ? s.name : `${s.name}.js`;
			downloadText(fname, text);
		} catch (e) {
			toast("error", `下载失败：${e instanceof Error ? e.message : String(e)}`);
		}
	};

	/**
	 * 导入 = 多文件（R2-①）：第一个 .js 文件 = 主脚本（R4-② 强制校验，无 .js 报错）；
	 * 其余文件 = 附带数据（assets，任意扩展名）。
	 * 流程：生成 scriptId → 主脚本 uploadFile（重命名为 jsrunner-<id>.js）→ assets 逐个上传 →
	 * 元数据登记（file/assets 记 /uploads/ 相对路径）→ saveList → toast「脚本已导入」。
	 */
	const importFiles = async (files: File[]) => {
		if (busy) return;
		try {
			const main = files.find((f) => /\.js$/i.test(f.name));
			if (!main) throw new Error("主脚本须为 .js 文件");
			const assets = files.filter((f) => f !== main);
			const id = newScriptId();
			// 主脚本重命名为 jsrunner-<id>.js（服务端再加时间戳前缀，落 .liyuan-uploads/ 顶层）
			const mainUpload = await uploadFile(new File([main], `jsrunner-${id}.js`, { type: "text/javascript" }));
			const assetRefs: string[] = [];
			for (const a of assets) {
				const up = await uploadFile(a);
				assetRefs.push(uploadRef(up.file));
			}
			const entry: ScriptMeta = { id, name: main.name, file: uploadRef(mainUpload.file), enabled: true };
			if (assetRefs.length) entry.assets = assetRefs;
			await saveList([...(scripts ?? []), entry], "脚本已导入");
			setOpenId(id);
		} catch (e) {
			toast("error", `导入失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			if (fileRef.current) fileRef.current.value = "";
		}
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
						<code>$</code> / <code>YAML</code>。脚本内容经文件存储（<code>/uploads/</code>，含附带数据文件），
						编辑统一走「下载 → 修改 → 重新导入」覆盖。切换启用开关<strong>即时生效</strong>
						（运行时增量启停 iframe）。
					</div>
					<div className="panel-row" style={{ marginTop: 8 }}>
						<button className="drawer-btn" disabled={busy} onClick={() => void addScript()}>
							＋ 新建脚本
						</button>
						<button className="drawer-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
							导入文件
						</button>
						<input
							ref={fileRef}
							type="file"
							multiple
							hidden
							onChange={(e) => {
								const files = e.target.files ? [...e.target.files] : [];
								if (files.length) void importFiles(files);
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
							<code>console.log</code> 输出会透传到宿主。点「＋ 新建脚本」创建空脚本，
							或「导入文件」上传 <code>.js</code> 主脚本（可附带任意扩展名的数据文件）。
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
									onDelete={() => void removeScript(s.id)}
									onDownload={() => downloadScript(s)}
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
