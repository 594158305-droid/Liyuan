/**
 * 会话面板（左栏，PLAN-PANELS §2.1）：
 * 「当前会话」卡（改名/上下文占用/压缩）＋会话列表（末条预览、重命名/导出/删除）
 * ＋全文搜索（回车搜会话内容，借鉴 ST）＋ST 聊天记录导入（从设置面板迁入）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiDelete, apiGet, apiPost, type SessionSearchHit } from "../api.ts";
import type { WireSessionInfo, WireStats } from "../wire.ts";
import { subscribeFrames } from "../ws.ts";
import { IconClose, IconDownload, IconHistory, IconPencil, IconTrash } from "./icons.tsx";
import { ConfirmButton, Field, SearchInput, useAction } from "./kit.tsx";

function timeAgo(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 90_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
	if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`;
	return new Date(ms).toLocaleDateString();
}

export interface SessionsPanelProps {
	sessions: WireSessionInfo[] | null;
	stats: WireStats | null;
	onOpen: (path: string) => void;
	onNew: () => void;
	onCompact: () => void;
	/** 打开世界线时间线面板 */
	onWorldline?: () => void;
	/** 打开存档命名弹窗 */
	onStore?: () => void;
	/** 重命名/删除后重拉列表（ws sessions 请求） */
	onRefresh: () => void;
	toast: (level: "info" | "warning" | "error", text: string) => void;
	/** 是否在欢迎主页（用于当前会话点击提示：进对话 / 回主页） */
	atHome?: boolean;
}

const exportUrl = (path: string) => `/api/sessions/export?path=${encodeURIComponent(path)}`;

function sessionTitle(s: { name?: string; firstMessage: string }): string {
	return s.name || s.firstMessage.slice(0, 40) || "（空会话）";
}

function RenameBox({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
	const [value, setValue] = useState(initial);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => ref.current?.select(), []);
	return (
		<input
			ref={ref}
			className="panel-search rename-input"
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") onDone(value.trim() || null);
				if (e.key === "Escape") onDone(null);
			}}
			onBlur={() => onDone(null)}
		/>
	);
}

function Item({
	s,
	busy,
	onOpen,
	onRename,
	onDelete,
	/** 当前会话再点：回主页 / 进对话，由父组件决定 */
	currentHint,
}: {
	s: WireSessionInfo;
	busy: boolean;
	onOpen: (path: string) => void;
	onRename: (path: string, name: string) => void;
	onDelete: (path: string) => void;
	currentHint?: string;
}) {
	const [renaming, setRenaming] = useState(false);
	return (
		<div className={`session-row ${s.current ? "current" : ""}`}>
			{renaming ? (
				<div className="session-item">
					<RenameBox
						initial={s.name ?? ""}
						onDone={(name) => {
							setRenaming(false);
							if (name) onRename(s.path, name);
						}}
					/>
					<span className="session-meta">回车确认，Esc 取消</span>
				</div>
			) : (
				<button
					className="session-item"
					type="button"
					title={s.current ? currentHint : undefined}
					onClick={() => onOpen(s.path)}
				>
					<span className="session-title">{sessionTitle(s)}</span>
					{s.preview && <span className="session-preview">{s.preview}</span>}
					<span className="session-meta">
						{timeAgo(s.modified)} · {s.messageCount} 条
						{s.current ? <span className="session-current-badge">当前</span> : ""}
					</span>
				</button>
			)}
			<span className="session-acts">
				<button
					className="act"
					title="重命名"
					aria-label="重命名会话"
					onClick={(e) => {
						e.stopPropagation();
						setRenaming(true);
					}}
				>
					<IconPencil size={13} />
				</button>
				<a className="act" href={exportUrl(s.path)} download title="导出 .jsonl" aria-label="导出会话">
					<IconDownload size={13} />
				</a>
				{!s.current && (
					<ConfirmButton
						disabled={busy}
						title="删除会话（含其全部分支，不可恢复）"
						aria-label="删除会话"
						confirmText="确认删除"
						onConfirm={() => onDelete(s.path)}
					>
						<IconTrash size={13} />
					</ConfirmButton>
				)}
			</span>
		</div>
	);
}

export function SessionsPanel({
	sessions,
	stats,
	onOpen,
	onNew,
	onCompact,
	onWorldline,
	onStore,
	onRefresh,
	toast,
	atHome = false,
}: SessionsPanelProps) {
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SessionSearchHit[] | null>(null);
	const [searching, setSearching] = useState(false);
	const { busy, run } = useAction(toast);
	// 相对时间不冻结：分钟级心跳重渲染
	const [, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((n) => n + 1), 60_000);
		return () => clearInterval(t);
	}, []);

	/** 服务端只下发当前卡会话；优先 current 标记，否则取列表首条（避免顶栏「当前会话」空白） */
	const current = useMemo(() => {
		if (!sessions?.length) return null;
		return sessions.find((s) => s.current) ?? sessions[0] ?? null;
	}, [sessions]);

	/** 服务端只下发当前卡会话；全部按卡绑定，无「未标记」分组 */
	const matched = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filter = (s: WireSessionInfo) =>
			!q || (s.name ?? "").toLowerCase().includes(q) || s.firstMessage.toLowerCase().includes(q);
		return (sessions ?? []).filter(filter);
	}, [sessions, query]);

	const others = useMemo(() => {
		if (!current) return matched;
		return matched.filter((s) => s.path !== current.path && s.id !== current.id);
	}, [matched, current]);

	const currentHint = atHome ? "点击进入当前对话" : "再次点击回到主页";

	const doSearch = async () => {
		const q = query.trim();
		if (!q) {
			setHits(null);
			return;
		}
		setSearching(true);
		try {
			const r = await apiGet<{ hits: SessionSearchHit[] }>(`/api/sessions/search?q=${encodeURIComponent(q)}`);
			setHits(r.hits);
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setSearching(false);
		}
	};

	const rename = (path: string, name: string) =>
		run(async () => {
			await apiPost("/api/sessions/rename", { path, name });
			onRefresh();
		}, "已重命名");

	const remove = (path: string) =>
		run(async () => {
			await apiDelete(`/api/sessions?path=${encodeURIComponent(path)}`);
			onRefresh();
		});

	// ---- 导入 ST 聊天记录（从设置面板迁入：它产出的是一个会话） ----
	const fileRef = useRef<HTMLInputElement>(null);
	const [importTag, setImportTag] = useState("");
	const [importing, setImporting] = useState(false);

	const doImport = async (file: File) => {
		setImporting(true);
		try {
			const content = await file.text();
			await apiPost("/api/import", { content, tag: importTag.trim() });
			toast("info", "导入完成（前情块已注入会话）");
			onRefresh();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setImporting(false);
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	// ---- 原始导入（POST /api/import-raw：原始楼层逐层回放建会话，可选物化模板；
	//      后端广播 activity note 帧 {"current","total","stage"} 报进度） ----
	const [rawOpen, setRawOpen] = useState(false);
	const rawFileRef = useRef<HTMLInputElement>(null);
	const [rawFileName, setRawFileName] = useState("");
	const [rawContent, setRawContent] = useState("");
	const [rawTemplates, setRawTemplates] = useState<Array<{ name: string }> | null>(null);
	const [rawTemplate, setRawTemplate] = useState(""); // "" = [无]
	const [rawBatchN, setRawBatchN] = useState(1);
	const [rawRunning, setRawRunning] = useState(false); // 蒙版显示中
	const [rawStage, setRawStage] = useState("");
	const [rawCurrent, setRawCurrent] = useState(0);
	const [rawTotal, setRawTotal] = useState(0);
	const [rawScribeCalls, setRawScribeCalls] = useState(0); // 已合并记账次数（进度帧 detail.scribeCalls）
	const rawAbortRef = useRef<AbortController | null>(null);

	const openRawModal = () => {
		setRawOpen(true);
		setRawFileName("");
		setRawContent("");
		setRawTemplate("");
		setRawBatchN(1);
		// 模板下拉列表（[无] 不物化）；失败静默（下拉留空即可）
		void apiGet<{ templates: Array<{ name: string }> }>("/api/templates")
			.then((r) => setRawTemplates(r.templates))
			.catch(() => setRawTemplates(null));
	};

	// 进度监听：WS activity 帧（name=import-raw）→ 更新蒙版 current/total/stage/scribeCalls
	useEffect(() => {
		if (!rawRunning) return;
		const unsub = subscribeFrames((frame) => {
			if (frame.type !== "activity" || frame.activity?.kind !== "note" || frame.activity.name !== "import-raw") return;
			try {
				const d = JSON.parse(frame.activity.detail ?? "{}") as {
					current?: number;
					total?: number;
					stage?: string;
					scribeCalls?: number;
				};
				if (typeof d.current === "number") setRawCurrent(d.current);
				if (typeof d.total === "number") setRawTotal(d.total);
				if (typeof d.stage === "string" && d.stage) setRawStage(d.stage);
				if (typeof d.scribeCalls === "number") setRawScribeCalls(d.scribeCalls);
			} catch {
				// 非 JSON detail 忽略（退化为固定文案）
			}
		});
		return unsub;
	}, [rawRunning]);

	const startRawImport = async () => {
		if (!rawContent.trim()) {
			toast("error", "请先选择要导入的 .jsonl 文件");
			return;
		}
		const ctrl = new AbortController();
		rawAbortRef.current = ctrl;
		setRawOpen(false);
		setRawRunning(true);
		setRawCurrent(0);
		setRawTotal(0);
		setRawStage("");
		setRawScribeCalls(0);
		try {
			const r = await apiPost<{ ok: boolean; floors?: number; scribeCalls?: number; error?: string; aborted?: boolean }>(
				"/api/import-raw",
				{
					content: rawContent,
					tag: importTag.trim() || undefined,
					templateName: rawTemplate || undefined,
					batchN: rawBatchN,
					fileName: rawFileName,
				},
				{ signal: ctrl.signal },
			);
			if (!r.ok) throw new Error(r.error ?? "原始导入失败");
			toast("info", `已回放 ${r.floors ?? 0} 层${r.scribeCalls ? `（记账 ${r.scribeCalls} 次）` : ""}`);
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") {
				toast("warning", "已停止回放");
			} else {
				toast("error", e instanceof Error ? e.message : String(e));
			}
		} finally {
			setRawRunning(false);
			rawAbortRef.current = null;
			onRefresh();
		}
	};

	const stopRawImport = () => rawAbortRef.current?.abort();

	return (
		<div className="panel-body">
			{current && (
				<section className="sp-section">
					<h4>当前会话</h4>
					<div className="current-session-card" title={currentHint}>
						<Item s={current} busy={busy} onOpen={onOpen} onRename={rename} onDelete={remove} currentHint={currentHint} />
						{stats?.contextPercent !== null && stats !== null && (
							<div className="ctx-bar-row" title={`上下文占用 ${Math.round(stats.contextPercent)}%`}>
								<div className="ctx-bar">
									<div
										className={`ctx-bar-fill ${stats.contextPercent >= 85 ? "danger" : stats.contextPercent >= 65 ? "warn" : ""}`}
										style={{ width: `${Math.min(100, Math.round(stats.contextPercent))}%` }}
									/>
								</div>
								<span className="ctx-bar-num">{Math.round(stats.contextPercent)}%</span>
							</div>
						)}
						<div className="panel-row">
							<button className="drawer-btn" onClick={onNew}>
								＋ 新建会话
							</button>
							<button className="drawer-btn" onClick={onCompact} title="把较早的对话压缩成摘要，腾出上下文空间">
								压缩上下文
							</button>
						</div>
						<div className="panel-row">
							{onStore && (
								<button className="drawer-btn" onClick={onStore} title="在当前剧情点钉存档（世界线节点）">
									存档
								</button>
							)}
							{onWorldline && (
								<button className="drawer-btn" onClick={onWorldline} title="查看世界线时间线">
									世界线
								</button>
							)}
						</div>
					</div>
				</section>
			)}
			{!current && (
				<div className="panel-row">
					<button className="drawer-btn" onClick={onNew}>
						＋ 新建会话
					</button>
				</div>
			)}

			<section className="sp-section">
				<h4>会话列表</h4>
				<SearchInput
					value={query}
					onChange={(v) => {
						setQuery(v);
						if (!v.trim()) setHits(null);
					}}
					placeholder="过滤标题；回车搜全文…"
					onEnter={() => void doSearch()}
				/>
				{searching && <div className="sp-empty">全文搜索中…</div>}
				{hits !== null && !searching && (
					<div className="session-list">
						<div className="field-hint">全文命中 {hits.length} 个会话（清空搜索框恢复列表）</div>
						{hits.map((h) => (
							<button
								key={h.path}
								type="button"
								className={`session-item ${h.current ? "current" : ""}`}
								title={h.current ? currentHint : undefined}
								onClick={() => onOpen(h.path)}
							>
								<span className="session-title">{sessionTitle(h)}</span>
								<span className="session-preview">{h.snippet}</span>
								<span className="session-meta">
									{timeAgo(h.modified)} · {h.messageCount} 条
									{h.current ? <span className="session-current-badge">当前</span> : ""}
								</span>
							</button>
						))}
					</div>
				)}
				{hits === null && (
					<div className="session-list">
						{sessions === null && <div className="info-line">读取中…</div>}
						{sessions !== null && matched.length === 0 && <div className="info-line">暂无会话</div>}
						{others.map((s) => (
							<Item key={s.path} s={s} busy={busy} onOpen={onOpen} onRename={rename} onDelete={remove} currentHint={currentHint} />
						))}
					</div>
				)}
			</section>

			<section className="sp-section">
				<h4>导入 ST 聊天记录</h4>
				<div className="field-hint">
					选择 SillyTavern 导出的聊天 .jsonl：旧剧情自动摘要、世界状态自动建账，然后从断点继续。建议先新建会话再导入。
				</div>
				<Field label="正文标签名（可选）" hint="预设约定正文包在如 <content> 标签内时填 content；留空按默认规则剥离">
					<input className="panel-search" placeholder="content" value={importTag} onChange={(e) => setImportTag(e.target.value)} />
				</Field>
				<input
					ref={fileRef}
					type="file"
					accept=".jsonl,.json,application/json"
					hidden
					onChange={(e) => {
						const f = e.target.files?.[0];
						if (f) void doImport(f);
					}}
				/>
				<div className="panel-row">
					<button className="drawer-btn" disabled={importing} onClick={() => fileRef.current?.click()}>
						{importing ? "导入中（解析→摘要→建账）…" : "选择 .jsonl 文件导入"}
					</button>
					<button className="drawer-btn" onClick={openRawModal} title="原始楼层逐层回放建会话，可选物化模板">
						<IconHistory size={13} />
						原始导入
					</button>
				</div>
			</section>

			{/* ── 原始导入弹窗（portal 到 body，避免面板容器 transform 使 fixed 退化） ── */}
			{rawOpen &&
				createPortal(
					<div className="raw-modal-scrim" onClick={() => setRawOpen(false)}>
						<div className="raw-modal" role="dialog" aria-label="原始导入" onClick={(e) => e.stopPropagation()}>
							<div className="raw-modal-head">
								<span>原始导入</span>
								<button type="button" className="icon-btn" aria-label="关闭" onClick={() => setRawOpen(false)}>
									<IconClose size={15} />
								</button>
							</div>
							<div className="raw-modal-body">
								<div className="field-hint">
									选择要导入的 .jsonl/.json 原始楼层文件：按顺序逐层建会话并回放；可选物化模板、每 N 层合并记账。回放可能耗时较长，期间会锁定界面。
								</div>
								<div className="panel-row">
									<button className="drawer-btn" onClick={() => rawFileRef.current?.click()}>
										选择文件
									</button>
									<input
										ref={rawFileRef}
										type="file"
										accept=".jsonl,.json,application/json"
										hidden
										onChange={(e) => {
											const f = e.target.files?.[0];
											if (!f) return;
											setRawFileName(f.name);
											void f
												.text()
												.then((t) => setRawContent(t))
												.catch(() => toast("error", "读取文件失败"));
											e.target.value = "";
										}}
									/>
									{rawFileName && <span className="raw-file-name">{rawFileName}</span>}
								</div>
								<Field label="模板（可选）" hint="选中模板则在回放前物化到新会话（[无] = 不物化）">
									<select className="panel-search" value={rawTemplate} onChange={(e) => setRawTemplate(e.target.value)}>
										<option value="">[无]</option>
										{rawTemplates?.map((t) => (
											<option key={t.name} value={t.name}>
												{t.name}
											</option>
										))}
									</select>
								</Field>
								<Field label="每 N 层合并记账" hint="回放时每 N 层触发一次记账（1–30，默认 1 = 逐层记账）">
									<input
										className="panel-search num"
										type="number"
										min={1}
										max={30}
										value={rawBatchN}
										onChange={(e) => setRawBatchN(Math.min(30, Math.max(1, Number(e.target.value) || 1)))}
									/>
								</Field>
							</div>
							<div className="raw-modal-foot">
								<button type="button" className="act" onClick={() => setRawOpen(false)}>
									取消
								</button>
								<button
									type="button"
									className="drawer-btn"
									disabled={!rawContent.trim()}
									onClick={() => void startRawImport()}
								>
									开始导入
								</button>
							</div>
						</div>
					</div>,
					document.body,
				)}

			{/* ── 原始导入进度蒙版（portal 到 body，锁死一切点击） ── */}
			{rawRunning && (
				<RawImportOverlay
					stage={rawStageText(rawStage, rawCurrent, rawTotal, rawScribeCalls)}
					// 有楼层总数 → 百分比进度；监听不到进度帧（total=0）→ 不确定态（转圈退化）
					percent={rawTotal > 0 ? Math.min(100, Math.round((rawCurrent / rawTotal) * 100)) : -1}
					onStop={stopRawImport}
				/>
			)}
		</div>
	);
}

/** 原始导入阶段文字（stage → 中文；replay 显示层数与已合并记账次数；无进度帧时退化「正在回放…」） */
function rawStageText(stage: string, current: number, total: number, scribeCalls: number): string {
	switch (stage) {
		case "create":
			return "建会话…";
		case "materialize":
			return "物化模板…";
		case "replay":
			return total > 0
				? `正在回放第 ${current}/${total} 层 · 已合并记账 ${scribeCalls} 次`
				: "正在回放…";
		case "done":
			return "完成";
		case "":
			return "正在回放…";
		default:
			return stage;
	}
}

/**
 * 原始导入进度蒙版：portal 到 body、fixed 全屏、高 z-index 锁死一切点击。
 * 进度条按 current/total 百分比；停止按钮 abort fetch（后端收到中断后广播收尾）。
 */
function RawImportOverlay({
	stage,
	percent,
	onStop,
}: {
	stage: string;
	percent: number;
	onStop: () => void;
}) {
	return createPortal(
		<div className="raw-overlay" role="dialog" aria-label="原始导入进度" aria-modal="true">
			<div className="raw-overlay-card">
				<div className="raw-overlay-title">原始导入中…</div>
				<div className="raw-overlay-stage" title={stage}>
					{stage}
				</div>
				{percent < 0 ? (
					/* 监听不到进度帧：不确定态转圈（后端补进度帧后自动切到进度条） */
					<div className="raw-overlay-unknown">
						<span className="raw-overlay-spin" aria-hidden="true" />
						<span>正在回放…</span>
					</div>
				) : (
					<>
						<div
							className="raw-overlay-bar"
							role="progressbar"
							aria-valuenow={percent}
							aria-valuemin={0}
							aria-valuemax={100}
						>
							<div className="raw-overlay-fill" style={{ width: `${percent}%` }} />
						</div>
						<div className="raw-overlay-num">{percent}%</div>
					</>
				)}
				<button type="button" className="drawer-btn" onClick={onStop}>
					停止回放
				</button>
			</div>
		</div>,
		document.body,
	);
}
