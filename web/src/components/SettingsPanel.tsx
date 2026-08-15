/**
 * 设置面板：外观（昼夜）+ 世界书扫描 + agent 行为 + 内置向量记忆。
 * 主题立刻生效、只存本机 localStorage，不写 rp.config。
 * 记忆配置写 `.liyuan-memory/config.json`，不必重载 agent。
 */

import { useEffect, useRef, useState } from "react";
import {
	api,
	apiGet,
	apiPut,
	downloadTraceFile,
	getTraceFiles,
	type RpConfigView,
	type TraceFileInfo,
} from "../api.ts";
import { getTheme, setTheme, type ThemeMode } from "../theme.ts";
import { readSoundSettings, saveSoundSettings, type SoundSettings } from "../sounds.ts";
import { readImageAsCompressedDataUrl } from "../bg-theme.ts";
import { Field, PanelStatus, SliderField, Toggle, useAction, usePanelData } from "./kit.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { IconChevronDown } from "./icons.tsx";
import {
	applyUiCustom,
	getUiCustom,
	UI_CHAT_W_MAX,
	UI_CHAT_W_MIN,
	UI_CHAT_W_STEP,
	UI_DEFAULTS,
	UI_FONT_MAX,
	UI_FONT_MIN,
	UI_FONT_STEP,
	UI_GLASS_MAX,
	UI_GLASS_MIN,
	UI_GLASS_STEP,
	UI_IMAGE_SCALE_MAX,
	UI_IMAGE_SCALE_MIN,
	UI_IMAGE_SCALE_STEP,
	type UiCustom,
} from "../ui-custom.ts";

type MemoryStoreStats = {
	id: string;
	name: string;
	kind: string;
	enabled: boolean;
	everyNTurns: number;
	chunkCount: number;
	maxChunks: number;
};

type MemoryStatus = {
	config: {
		enabled: boolean;
		searchTopK: number;
		injectOnTurn?: boolean;
		embedMode?: "local" | "cloud";
		cloudEmbed?: { baseUrl: string; apiKey: string; model: string };
		cloudEmbedConfigured?: boolean;
		stores: Array<{ id: string; everyNTurns: number; enabled: boolean }>;
	};
	stores: MemoryStoreStats[];
	/** 当前对话作用域（角色卡 + 会话） */
	scope?: { sessionId: string; card?: string; scopeId: string };
};

type MemoryChunkRow = {
	id: string;
	text: string;
	textLen: number;
	meta?: { source?: string; title?: string; fileName?: string; mergeCount?: number };
	createdAt: string;
};

/** 条目管理列表：刷新 + 单条删除 */
function MemoryChunkManager({
	storeId,
	label,
	enabled,
	busy,
	run,
	toast,
	onChanged,
}: {
	storeId: string;
	label: string;
	enabled: boolean;
	busy: boolean;
	run: (fn: () => Promise<void>, doneText?: string) => Promise<void>;
	toast: (level: "info" | "warning" | "error", text: string) => void;
	onChanged: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [chunks, setChunks] = useState<MemoryChunkRow[]>([]);
	const [loading, setLoading] = useState(false);

	const refresh = async () => {
		setLoading(true);
		try {
			const r = await apiGet<{ chunks: MemoryChunkRow[] }>(
				`/api/memory/chunks?storeId=${encodeURIComponent(storeId)}`,
			);
			setChunks(r.chunks ?? []);
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (open) void refresh();
	}, [open, storeId]);

	const del = (id: string) =>
		run(async () => {
			await api("/api/memory/chunk/delete", {
				method: "POST",
				body: JSON.stringify({ storeId, id }),
			});
			setChunks((cs) => cs.filter((c) => c.id !== id));
			onChanged();
		}, "已删除条目");

	return (
		<div className="memory-chunk-mgr" style={{ marginTop: 8 }}>
			<div className="access-actions" style={{ gap: 8 }}>
				<button
					type="button"
					className="drawer-btn"
					disabled={!enabled}
					onClick={() => setOpen((v) => !v)}
				>
					{open ? "收起条目" : `管理「${label}」条目`}
				</button>
				{open ? (
					<button type="button" className="drawer-btn" disabled={busy || loading} onClick={() => void refresh()}>
						刷新列表
					</button>
				) : null}
			</div>
			{open && (
				<div className="memory-chunk-list">
					{loading && !chunks.length ? <div className="field-hint">加载中…</div> : null}
					{!loading && chunks.length === 0 ? <div className="field-hint">暂无条目</div> : null}
					<ul className="memory-hits">
						{chunks.map((c) => {
							const src =
								c.meta?.source === "import"
									? "导入"
									: c.meta?.source === "manual"
										? "手动"
										: c.meta?.source === "narrative"
											? "剧情"
											: c.meta?.source || "";
							const title = c.meta?.title || c.meta?.fileName || "";
							const merge = c.meta?.mergeCount && c.meta.mergeCount > 1 ? ` · 合并×${c.meta.mergeCount}` : "";
							return (
								<li key={c.id} className="memory-chunk-item">
									<div className="memory-chunk-meta">
										<span className="memory-score">
											{src}
											{title ? ` · ${title}` : ""}
											{merge} · {c.textLen}字
										</span>
										<button
											type="button"
											className="drawer-btn"
											disabled={busy}
											onClick={() => void del(c.id)}
											style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }}
										>
											删除
										</button>
									</div>
									<div className="memory-chunk-text">
										{c.text.slice(0, 220)}
										{c.text.length > 220 ? "…" : ""}
									</div>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</div>
	);
}

/** 内置向量记忆：剧情库（agent 合并）+ 额外库（导入/手动 + 条目管理） */
function MemorySection({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const { data, error, loading, reload } = usePanelData(() => apiGet<MemoryStatus>("/api/memory"), {
		cacheKey: "/api/memory",
	});
	const { busy, run } = useAction(toast);
	const [open, setOpen] = useState(false);
	const [enabled, setEnabled] = useState(false);
	const [searchTopK, setSearchTopK] = useState(5);
	const [injectOnTurn, setInjectOnTurn] = useState(true);
	const [embedMode, setEmbedMode] = useState<"local" | "cloud">("local");
	const [cloudBase, setCloudBase] = useState("https://api.openai.com/v1");
	const [cloudKey, setCloudKey] = useState("");
	const [cloudModel, setCloudModel] = useState("text-embedding-3-small");
	const [keyConfigured, setKeyConfigured] = useState(false);
	const [narrativeEvery, setNarrativeEvery] = useState(3);
	const [narrativeOn, setNarrativeOn] = useState(true);
	const [externalOn, setExternalOn] = useState(true);
	const [probeQ, setProbeQ] = useState("");
	const [probeHits, setProbeHits] = useState<Array<{ text: string; score: number }>>([]);
	const [manualText, setManualText] = useState("");
	const [manualTitle, setManualTitle] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!data) return;
		setEnabled(data.config.enabled);
		setSearchTopK(data.config.searchTopK);
		setInjectOnTurn(data.config.injectOnTurn !== false);
		setEmbedMode(data.config.embedMode === "cloud" ? "cloud" : "local");
		setCloudBase(data.config.cloudEmbed?.baseUrl || "https://api.openai.com/v1");
		setCloudModel(data.config.cloudEmbed?.model || "text-embedding-3-small");
		setKeyConfigured(data.config.cloudEmbedConfigured === true);
		setCloudKey("");
		const nar = data.stores.find((s) => s.id === "narrative");
		const ext = data.stores.find((s) => s.id === "external");
		if (nar) {
			setNarrativeOn(nar.enabled);
			setNarrativeEvery(nar.everyNTurns);
		}
		if (ext) setExternalOn(ext.enabled);
		if (data.config.enabled) setOpen(true);
	}, [data]);

	const save = () =>
		run(async () => {
			await apiPut("/api/memory", {
				enabled,
				searchTopK,
				injectOnTurn,
				embedMode,
				cloudEmbed: {
					baseUrl: cloudBase,
					apiKey: cloudKey.trim() || (keyConfigured ? "••••••••" : ""),
					model: cloudModel,
				},
				stores: [
					{ id: "narrative", enabled: narrativeOn, everyNTurns: narrativeEvery },
					{ id: "external", enabled: externalOn },
				],
			});
			reload();
		}, "记忆设置已保存");

	const probeEmbed = () =>
		run(async () => {
			await apiPut("/api/memory", {
				embedMode: "cloud",
				cloudEmbed: {
					baseUrl: cloudBase,
					apiKey: cloudKey.trim() || (keyConfigured ? "••••••••" : ""),
					model: cloudModel,
				},
			});
			const r = await api<{ ok: boolean; dim?: number; error?: string }>("/api/memory/probe-embed", {
				method: "POST",
				body: "{}",
			});
			if (!r.ok) throw new Error(r.error || "探测失败");
			reload();
		}, "云端 embedding 正常");

	const clearStore = (storeId: string, label: string) =>
		run(async () => {
			await api("/api/memory/clear", { method: "POST", body: JSON.stringify({ storeId }) });
			reload();
		}, `已清空「${label}」`);

	const reembedAll = () =>
		run(async () => {
			await apiPut("/api/memory", {
				enabled,
				searchTopK,
				injectOnTurn,
				embedMode,
				cloudEmbed: {
					baseUrl: cloudBase,
					apiKey: cloudKey.trim() || (keyConfigured ? "••••••••" : ""),
					model: cloudModel,
				},
				stores: [
					{ id: "narrative", enabled: narrativeOn, everyNTurns: narrativeEvery },
					{ id: "external", enabled: externalOn },
				],
			});
			const r = await api<{
				totalUpdated?: number;
				totalChunks?: number;
				mode?: string;
				model?: string;
			}>("/api/memory/reembed", {
				method: "POST",
				body: "{}",
			});
			reload();
			const n = r.totalUpdated ?? 0;
			const t = r.totalChunks ?? 0;
			if (t === 0) toast("info", "当前对话库为空，无需重向量化");
			else toast("info", `重向量化完成：${n}/${t} 条（${r.mode === "cloud" ? r.model : "本地"}）`);
		});

	const onImportFile = async (file: File) => {
		const text = await file.text();
		await run(async () => {
			await api("/api/memory/import", {
				method: "POST",
				body: JSON.stringify({ storeId: "external", text, fileName: file.name }),
			});
			reload();
		});
	};

	const manualAdd = () =>
		run(async () => {
			const text = manualText.trim();
			if (text.length < 8) throw new Error("内容太短");
			await api("/api/memory/manual", {
				method: "POST",
				body: JSON.stringify({
					text,
					title: manualTitle.trim() || undefined,
					storeId: "external",
				}),
			});
			setManualText("");
			reload();
		});

	const probe = () =>
		run(async () => {
			const r = await api<{ hits: Array<{ text: string; score: number }> }>("/api/memory/search", {
				method: "POST",
				body: JSON.stringify({ storeId: "narrative", query: probeQ, topK: searchTopK }),
			});
			setProbeHits(r.hits ?? []);
		}, "检索完成");

	const narCount = data?.stores.find((s) => s.id === "narrative")?.chunkCount ?? 0;
	const narMax = data?.stores.find((s) => s.id === "narrative")?.maxChunks ?? "—";
	const extCount = data?.stores.find((s) => s.id === "external")?.chunkCount ?? 0;
	const extMax = data?.stores.find((s) => s.id === "external")?.maxChunks ?? "—";

	return (
		<>
			<div className="field-hint">
				按「当前角色卡 + 当前对话」隔离。
				<strong>剧情数据库</strong>仅 agent 自动<strong>合并</strong>入库；
				<strong>额外数据库</strong>用于导入与手动向量化（每段可成条目，可逐条删除）。
			</div>
			{data?.scope?.sessionId ? (
				<div className="field-hint">
					当前库作用域：会话 {data.scope.sessionId.slice(0, 8)}…
					{data.scope.card ? ` · 卡 ${data.scope.card.split(/[/\\]/).pop()}` : ""}
				</div>
			) : null}
			{loading && !data ? <div className="field-hint">加载中…</div> : null}
			{error ? <div className="field-hint" style={{ color: "var(--danger, #c44)" }}>{error}</div> : null}
			<div className="toggle-row">
				<span>启用向量记忆</span>
				<Toggle
					checked={enabled}
					onChange={(v) => {
						setEnabled(v);
						setOpen(v);
					}}
				/>
			</div>
			{(open || enabled) && data && (
				<div className="memory-panel">
					<div className="field-label" style={{ marginBottom: 6 }}>
						嵌入模式
					</div>
					<div className="access-actions" style={{ gap: 8, marginBottom: 8 }}>
						<button
							type="button"
							className={`drawer-btn ${embedMode === "local" ? "save-btn" : ""}`}
							onClick={() => setEmbedMode("local")}
						>
							本地（免模型）
						</button>
						<button
							type="button"
							className={`drawer-btn ${embedMode === "cloud" ? "save-btn" : ""}`}
							onClick={() => setEmbedMode("cloud")}
						>
							云端 embedding
						</button>
					</div>
					<div className="field-hint">
						换模式后用「重向量化」保留原文只重算向量（云端只花 embedding 费）。
					</div>
					{embedMode === "cloud" && (
						<div className="memory-cloud">
							<input
								className="field-input"
								placeholder="Base URL（如 https://api.openai.com/v1）"
								value={cloudBase}
								onChange={(e) => setCloudBase(e.target.value)}
							/>
							<input
								className="field-input"
								type="password"
								placeholder={keyConfigured ? "API Key（已保存，留空不改）" : "API Key"}
								value={cloudKey}
								autoComplete="off"
								onChange={(e) => setCloudKey(e.target.value)}
							/>
							<input
								className="field-input"
								placeholder="模型名（如 text-embedding-3-small）"
								value={cloudModel}
								onChange={(e) => setCloudModel(e.target.value)}
							/>
							<button type="button" className="drawer-btn" disabled={busy} onClick={() => void probeEmbed()}>
								测试 embedding 连接
							</button>
						</div>
					)}
					<div className="access-actions" style={{ marginTop: 8 }}>
						<button
							type="button"
							className="drawer-btn save-btn"
							disabled={busy || !enabled}
							onClick={() => void reembedAll()}
						>
							按当前模式重向量化
						</button>
					</div>

					{/* —— 剧情数据库 —— */}
					<div className="toggle-row" style={{ marginTop: 14 }}>
						<span>剧情数据库</span>
						<Toggle checked={narrativeOn} onChange={setNarrativeOn} />
					</div>
					<div className="field-hint">
						条数 {narCount} / {narMax}。仅 agent 自动写入：到轮次后<strong>合并进最后一条</strong>
						（约满 1800 字才新开一条），不接受手动/导入。
					</div>
					{narrativeOn && (
						<SliderField
							label="每隔多少轮助手回复合并入库"
							hint="1=每轮尝试合并；3=每 3 轮。0=不自动写"
							value={narrativeEvery}
							min={0}
							max={20}
							onChange={setNarrativeEvery}
						/>
					)}
					<div className="access-actions">
						<button
							type="button"
							className="drawer-btn"
							disabled={busy}
							onClick={() => clearStore("narrative", "剧情数据库")}
						>
							清空剧情库
						</button>
					</div>
					<MemoryChunkManager
						storeId="narrative"
						label="剧情"
						enabled={enabled}
						busy={busy}
						run={run}
						toast={toast}
						onChanged={reload}
					/>

					{/* —— 额外数据库 —— */}
					<div className="toggle-row" style={{ marginTop: 14 }}>
						<span>额外数据库</span>
						<Toggle checked={externalOn} onChange={setExternalOn} />
					</div>
					<div className="field-hint">
						条数 {extCount} / {extMax}。导入文件会切块成多条；手动向量化短文 1 条、长文多条。可逐条删除。
					</div>
					<div className="access-actions">
						<button type="button" className="drawer-btn" disabled={busy || !enabled} onClick={() => fileRef.current?.click()}>
							导入文本文件
						</button>
						<input
							ref={fileRef}
							type="file"
							accept=".txt,.md,.text,text/plain,text/markdown"
							hidden
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) void onImportFile(f);
								if (fileRef.current) fileRef.current.value = "";
							}}
						/>
						<button type="button" className="drawer-btn" disabled={busy} onClick={() => clearStore("external", "额外数据库")}>
							清空额外库
						</button>
					</div>
					<div className="field-label" style={{ marginTop: 10, marginBottom: 4 }}>
						手动向量化（写入额外库）
					</div>
					<input
						className="field-input"
						placeholder="可选标题"
						value={manualTitle}
						onChange={(e) => setManualTitle(e.target.value)}
						disabled={!enabled || busy}
					/>
					<textarea
						className="field-input"
						placeholder="粘贴要记住的设定/摘录…"
						value={manualText}
						onChange={(e) => setManualText(e.target.value)}
						rows={4}
						disabled={!enabled || busy}
						style={{ resize: "vertical", minHeight: 72 }}
					/>
					<div className="access-actions">
						<button
							type="button"
							className="drawer-btn save-btn"
							disabled={busy || !enabled || manualText.trim().length < 8}
							onClick={() => void manualAdd()}
						>
							写入额外库
						</button>
					</div>
					<MemoryChunkManager
						storeId="external"
						label="额外"
						enabled={enabled}
						busy={busy}
						run={run}
						toast={toast}
						onChanged={reload}
					/>

					<div className="toggle-row" style={{ marginTop: 12 }}>
						<span>每轮自动检索并注入模型</span>
						<Toggle checked={injectOnTurn} onChange={setInjectOnTurn} />
					</div>
					<div className="field-hint">
						开=用户发言后检索剧情库+额外库，以【剧情记忆】注入。关=只入库不注入。
					</div>
					<SliderField
						label="检索 / 注入条数 top-k"
						hint="试检索与每轮注入共用上限"
						value={searchTopK}
						min={1}
						max={15}
						onChange={setSearchTopK}
					/>
					<div className="access-actions" style={{ flexWrap: "wrap", gap: 8 }}>
						<input
							className="field-input"
							placeholder="试检索剧情库…"
							value={probeQ}
							onChange={(e) => setProbeQ(e.target.value)}
							style={{ flex: 1, minWidth: 120 }}
						/>
						<button type="button" className="drawer-btn" disabled={busy || !probeQ.trim() || !enabled} onClick={() => void probe()}>
							检索
						</button>
					</div>
					{probeHits.length > 0 && (
						<ul className="memory-hits">
							{probeHits.map((h, i) => (
								<li key={i}>
									<span className="memory-score">{h.score.toFixed(2)}</span> {h.text.slice(0, 160)}
									{h.text.length > 160 ? "…" : ""}
								</li>
							))}
						</ul>
					)}

					<div className="sticky-save" style={{ marginTop: 12 }}>
						<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={() => void save()}>
							保存记忆设置
						</button>
					</div>
				</div>
			)}
		</>
	);
}

/** 访问密码区：未设置=开放（首次零门槛），设置后全端登录才可用 */
function AccessSection({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const [required, setRequired] = useState<boolean | null>(null);
	const [oldPw, setOldPw] = useState("");
	const [newPw, setNewPw] = useState("");
	const [newPw2, setNewPw2] = useState("");
	const { busy, run } = useAction(toast);

	useEffect(() => {
		void api<{ required: boolean }>("/api/access/status")
			.then((r) => setRequired(r.required))
			.catch(() => setRequired(false));
	}, []);

	const submit = (turningOff: boolean) =>
		run(async () => {
			if (!turningOff) {
				if (newPw.length < 4) throw new Error("新密码至少 4 位");
				if (newPw !== newPw2) throw new Error("两次输入的新密码不一致");
			}
			const r = await api<{ required: boolean }>("/api/access/set", {
				method: "POST",
				body: JSON.stringify({ oldPassword: oldPw, newPassword: turningOff ? "" : newPw }),
			});
			setRequired(r.required);
			setOldPw("");
			setNewPw("");
			setNewPw2("");
		}, turningOff ? "已关闭访问密码" : "已设置访问密码（其他设备需重新登录）");

	return (
		<>
			<div className="field-hint">
				{required
					? "已开启：所有设备访问本站都需输入密码。修改或关闭需先验证当前密码。"
					: "未开启：任何能连到本站的人都可直接使用。部署到公网 / 局域网共享时建议设置。"}
			</div>
			{required === null ? null : (
				<>
					{required && (
						<input
							className="field-input"
							type="password"
							placeholder="当前密码"
							value={oldPw}
							autoComplete="current-password"
							onChange={(e) => setOldPw(e.target.value)}
						/>
					)}
					<input
						className="field-input"
						type="password"
						placeholder={required ? "新密码（至少 4 位）" : "设置密码（至少 4 位）"}
						value={newPw}
						autoComplete="new-password"
						onChange={(e) => setNewPw(e.target.value)}
					/>
					<input
						className="field-input"
						type="password"
						placeholder="再输一次新密码"
						value={newPw2}
						autoComplete="new-password"
						onChange={(e) => setNewPw2(e.target.value)}
					/>
					<div className="access-actions">
						<button className="drawer-btn save-btn" disabled={busy || !newPw} onClick={() => submit(false)}>
							{required ? "修改密码" : "设置密码"}
						</button>
						{required && (
							<button className="drawer-btn" disabled={busy || !oldPw} onClick={() => submit(true)}>
								关闭密码
							</button>
						)}
					</div>
				</>
			)}
		</>
	);
}

/** 主聊天「回合窗口化渲染」设置事件：App 监听后重读 localStorage 即时生效 */
const CHAT_WINDOW_SETTINGS_EVENT = "liyuan:chat-window-settings";

/** 界面自定义设置事件：App 监听后重读 localStorage 即时生效（默认收起用户消息） */
const UI_CUSTOM_SETTINGS_EVENT = "liyuan:ui-custom-settings";

/** 读取回合窗口设置（localStorage；未设置/非法值回落默认，clamp 到合法区间） */
function readWindowSetting(key: string, fallback: number, min: number, max: number): number {
	try {
		const s = localStorage.getItem(key);
		if (s === null || s.trim() === "") return fallback; // 未设置——Number(null)=0 会把 M 误判成 0 关闭窗口化
		const raw = Number(s);
		if (Number.isFinite(raw)) return Math.min(max, Math.max(min, Math.round(raw)));
	} catch {
		/* localStorage 不可用 */
	}
	return fallback;
}

/**
 * 自定义 UI（页面宽度 + 字体比例 + 玻璃透明度 + 背景图 + 自动配色 + 默认收起用户消息）：
 * 纯本机显示设置，变更即时生效，不写服务端配置
 */
function UiCustomSection({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const [chatW, setChatW] = useState(() => getUiCustom().chatW);
	const [fontScale, setFontScale] = useState(() => getUiCustom().fontScale);
	const [glass, setGlass] = useState(() => getUiCustom().glass);
	const [bgImage, setBgImage] = useState(() => getUiCustom().bgImage);
	const [bgAutoTheme, setBgAutoTheme] = useState(() => getUiCustom().bgAutoTheme);
	const [collapseUser, setCollapseUser] = useState(() => getUiCustom().collapseUser);
	const [imageScale, setImageScale] = useState(() => getUiCustom().imageScale);
	// 背景图 URL 输入框值：dataURL（本地文件压缩产物）太长不显示，留空
	const [bgUrl, setBgUrl] = useState(() => {
		const b = getUiCustom().bgImage;
		return b.startsWith("data:") ? "" : b;
	});
	const apply = (next: Partial<UiCustom>) => {
		// 以 localStorage 最新值为基础合并：异步路径（文件压缩）与滑块拖动交错时，
		// 若用 React state 闭包合并，旧闭包里的空 bgImage 会覆盖刚选的背景图
		const ui = { ...getUiCustom(), ...next };
		applyUiCustom(ui);
		setChatW(ui.chatW);
		setFontScale(ui.fontScale);
		setGlass(ui.glass);
		setBgImage(ui.bgImage);
		setBgAutoTheme(ui.bgAutoTheme);
		setCollapseUser(ui.collapseUser);
		setImageScale(ui.imageScale);
		// 聊天页监听后重读默认收起状态，即时生效
		window.dispatchEvent(new Event(UI_CUSTOM_SETTINGS_EVENT));
	};
	// URL 输入防抖提交（停止键入 400ms 后生效；Enter/失焦立即提交）
	const bgDebounceRef = useRef(0);
	const bgUrlRef = useRef<HTMLInputElement>(null);
	const commitBgUrl = (v: string) => {
		window.clearTimeout(bgDebounceRef.current);
		bgDebounceRef.current = window.setTimeout(() => {
			// 输入框已变化（如文件选择后置空）则放弃本次提交，防止旧输入覆盖背景图
			const el = bgUrlRef.current;
			if (el && el.value !== v) return;
			apply({ bgImage: v.trim() });
		}, 400);
	};
	useEffect(() => () => window.clearTimeout(bgDebounceRef.current), []);
	const fileRef = useRef<HTMLInputElement>(null);
	const onPickFile = async (f: File | undefined) => {
		if (!f) return;
		try {
			const dataUrl = await readImageAsCompressedDataUrl(f);
			setBgUrl("");
			apply({ bgImage: dataUrl });
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		}
	};
	const atDefaults =
		chatW === UI_DEFAULTS.chatW &&
		fontScale === UI_DEFAULTS.fontScale &&
		glass === UI_DEFAULTS.glass &&
		bgImage === UI_DEFAULTS.bgImage &&
		bgAutoTheme === UI_DEFAULTS.bgAutoTheme &&
		collapseUser === UI_DEFAULTS.collapseUser &&
		imageScale === UI_DEFAULTS.imageScale;
	return (
		<>
			<div className="field-hint">
				页面宽度即聊天列宽度（屏幕两侧留白随之变化）；字体比例用整体缩放（间距/图标一起变，浏览器式缩放）。改动即时生效，仅本机浏览器记住。
			</div>
			<div className="ui-custom-grid">
				<SliderField
					label="页面宽度"
					hint={`聊天列视觉宽度（${UI_CHAT_W_MIN}–${UI_CHAT_W_MAX}px，默认 ${UI_DEFAULTS.chatW}）`}
					value={chatW}
					min={UI_CHAT_W_MIN}
					max={UI_CHAT_W_MAX}
					step={UI_CHAT_W_STEP}
					onChange={(v) => apply({ chatW: v })}
				/>
				<SliderField
					label="字体比例"
					hint={`全局缩放（${UI_FONT_MIN}%–${UI_FONT_MAX}%，默认 ${UI_DEFAULTS.fontScale}%）`}
					value={fontScale}
					min={UI_FONT_MIN}
					max={UI_FONT_MAX}
					step={UI_FONT_STEP}
					onChange={(v) => apply({ fontScale: v })}
				/>
				<SliderField
					label="聊天图片比例"
					hint={`聊天内图片显示缩放（${UI_IMAGE_SCALE_MIN}%–${UI_IMAGE_SCALE_MAX}%，默认 ${UI_DEFAULTS.imageScale}%）：生图占位图 / 插图 / 附件图一起变`}
					value={imageScale}
					min={UI_IMAGE_SCALE_MIN}
					max={UI_IMAGE_SCALE_MAX}
					step={UI_IMAGE_SCALE_STEP}
					onChange={(v) => apply({ imageScale: v })}
				/>
			</div>
			<SliderField
				label="玻璃透明度"
				hint={`主聊天玻璃效果（${UI_GLASS_MIN}–${UI_GLASS_MAX}%，默认 ${UI_DEFAULTS.glass}%=关闭；配合背景图效果最佳）`}
				value={glass}
				min={UI_GLASS_MIN}
				max={UI_GLASS_MAX}
				step={UI_GLASS_STEP}
				onChange={(v) => apply({ glass: v })}
			/>
			<div className="field">
				<span className="field-label">背景图</span>
				<div className="bg-image-row">
					<input
						ref={bgUrlRef}
						className="panel-search"
						type="text"
						placeholder="粘贴图片 URL，或选择本地图片"
						value={bgUrl}
						onChange={(e) => {
							setBgUrl(e.target.value);
							commitBgUrl(e.target.value);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								window.clearTimeout(bgDebounceRef.current);
								// 与「应显示值」一致（如文件选择后留空）时不提交，避免误清空背景图
								const shown = bgImage.startsWith("data:") ? "" : bgImage;
								if (e.currentTarget.value.trim() !== shown) apply({ bgImage: e.currentTarget.value.trim() });
							}
							if (e.key === "Escape" && bgUrl) {
								window.clearTimeout(bgDebounceRef.current);
								setBgUrl(bgImage.startsWith("data:") ? "" : bgImage);
							}
						}}
						onBlur={() => {
							window.clearTimeout(bgDebounceRef.current);
							const shown = bgImage.startsWith("data:") ? "" : bgImage;
							if (bgUrl !== shown) apply({ bgImage: bgUrl.trim() });
						}}
					/>
					<button type="button" className="drawer-btn" onClick={() => fileRef.current?.click()}>
						选择本地图片
					</button>
					<input
						ref={fileRef}
						type="file"
						accept="image/*"
						style={{ display: "none" }}
						onChange={(e) => {
							onPickFile(e.target.files?.[0]);
							e.target.value = "";
						}}
					/>
				</div>
				{bgImage ? (
					<div className="bg-image-preview">
						<img src={bgImage} alt="背景图预览" />
						<button
							type="button"
							className="drawer-btn"
							onClick={() => {
								setBgUrl("");
								apply({ bgImage: "" });
							}}
						>
							移除背景图
						</button>
					</div>
				) : null}
			</div>
			<div className="toggle-row">
				<span>自动按背景图配色</span>
				<Toggle
					checked={bgAutoTheme}
					onChange={(v) => apply({ bgAutoTheme: v })}
					title="按背景图主色自动生成界面底色/表面色与文字颜色（朱砂品牌色不变）；关闭后回到当前主题色"
				/>
			</div>
			<div className="field-hint">
				开启后按背景图主色取样渲染界面颜色（底色/面板/分割线/文字随图明暗自动切换黑白系）。远程图可能受 CORS 限制无法取色，此时仅显示背景图。
			</div>
			<div className="toggle-row">
				<span>默认收起用户消息</span>
				<Toggle
					checked={collapseUser}
					onChange={(v) => apply({ collapseUser: v })}
					title="新加载/新发送的用户消息只显示楼层头，点展开才见正文与操作条"
				/>
			</div>
			<div className="field-hint">
				开=新消息默认收起（只露楼层头）；每条消息仍可在操作条里单独展开/收起，自己的选择即时覆盖默认。改动即时生效。
			</div>
			<div className="access-actions">
				<button
					type="button"
					className="drawer-btn"
					disabled={atDefaults}
					onClick={() => {
						setBgUrl("");
						apply({ ...UI_DEFAULTS });
					}}
				>
					恢复默认
				</button>
			</div>
		</>
	);
}

/**
 * 设置分区收放头：标题行可点击展开/收起，状态记 localStorage（刷新恢复）。
 * 与表格卡同款视觉（tbl-card-fold 箭头旋转）。
 */
function CollapsibleSection({
	title,
	storageKey,
	defaultOpen,
	children,
}: {
	title: string;
	storageKey: string;
	defaultOpen: boolean;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(() => {
		try {
			const s = localStorage.getItem(storageKey);
			if (s === "1") return true;
			if (s === "0") return false;
		} catch {
			/* localStorage 不可用 */
		}
		return defaultOpen;
	});
	const toggle = () => {
		setOpen((v) => {
			const nv = !v;
			try {
				localStorage.setItem(storageKey, nv ? "1" : "0");
			} catch {
				/* 忽略写入失败 */
			}
			return nv;
		});
	};
	return (
		<section className="sp-section">
			<div
				className={`sp-section-head sp-collapsible-head ${open ? "" : "folded"}`}
				onClick={toggle}
				title={open ? "点击收起" : "点击展开"}
			>
				<h4>{title}</h4>
				<span className="tbl-card-fold" aria-hidden="true">
					<IconChevronDown size={14} />
				</span>
			</div>
			{open && children}
		</section>
	);
}

/** 主聊天窗口（两层缓冲）：纯本机显示设置，变更即时生效，不写服务端配置 */
function ChatWindowSection() {
	const [n, setN] = useState(() => readWindowSetting("liyuan.chat.windowRounds", 5, 1, 50));
	const [m, setM] = useState(() => readWindowSetting("liyuan.chat.bufferRounds", 5, 0, 50));
	const apply = (key: string, v: number, min: number, max: number) => {
		const val = Math.min(max, Math.max(min, Math.round(v) || min));
		try {
			localStorage.setItem(key, String(val));
		} catch {
			/* 忽略写入失败 */
		}
		window.dispatchEvent(new Event(CHAT_WINDOW_SETTINGS_EVENT));
		return val;
	};
	return (
		<>
			<div className="field-hint">
				超长会话只渲染最新一段回合，上下滚动时窗口跟随平移，避免整页消息堆在 DOM 里。改动即时生效。
			</div>
			<Field label="主窗口回合数（N）" hint="始终渲染在 DOM 的主窗口回合数（1–50，默认 5）">
				<input
					className="panel-search num"
					type="number"
					min={1}
					max={50}
					value={n}
					onChange={(e) => setN(apply("liyuan.chat.windowRounds", Number(e.target.value), 1, 50))}
				/>
			</Field>
			<Field label="前后缓冲回合数（M）" hint="窗口两侧预渲染的缓冲回合数（0–50，默认 5；0 = 关闭窗口化，全量渲染）">
				<input
					className="panel-search num"
					type="number"
					min={0}
					max={50}
					value={m}
					onChange={(e) => setM(apply("liyuan.chat.bufferRounds", Number(e.target.value), 0, 50))}
				/>
			</Field>
		</>
	);
}

/** 跟踪文件大小显示（开发者模式文件列表用） */
const fmtSize = (n: number): string =>
	n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

export function SettingsPanel({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const { data, error, loading, reload } = usePanelData(() => apiGet<{ config: RpConfigView }>("/api/config"), { cacheKey: "/api/config" });
	const { busy, run } = useAction(toast);

	const [scanDepth, setScanDepth] = useState(4);
	const [maxLore, setMaxLore] = useState(3);
	const [compactEvery, setCompactEvery] = useState(30);
	const [backendControl, setBackendControl] = useState(true);
	const [askMode, setAskMode] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [dark, setDark] = useState(() => getTheme() === "dark");
	// 音效提醒（2026-08-12）：本机偏好（localStorage），播放端惰性读取 → 改动即时生效
	const [sound, setSound] = useState<SoundSettings>(() => readSoundSettings());
	// 旁挂模型 + 破甲（2026-08-10）：sideModelKey = "provider/id" 或 ""（跟随剧情模型）
	const [sideModelKey, setSideModelKey] = useState("");
	const [sideJailbreak, setSideJailbreak] = useState("");
	// 开发者模式 + 主聊天跟踪（2026-08-11）：全局配置（liyuan.config.json），保存后生效
	const [developerMode, setDeveloperMode] = useState(false);
	const [chatTrace, setChatTrace] = useState(false);
	const [traceFiles, setTraceFiles] = useState<TraceFileInfo[] | null>(null);

	useEffect(() => {
		if (data) {
			setScanDepth(data.config.scanDepth);
			setMaxLore(data.config.maxLoreInjections);
			setCompactEvery(data.config.compactEveryNTurns ?? 30);
			setBackendControl(data.config.backendControl !== false);
			setAskMode(data.config.creationMode === "ask");
			setSideModelKey(data.config.sideModel?.provider && data.config.sideModel.id ? `${data.config.sideModel.provider}/${data.config.sideModel.id}` : "");
			setSideJailbreak(data.config.sideJailbreak ?? "");
			setDeveloperMode(data.config.developerMode === true);
			setChatTrace(data.config.chatTrace === true);
			setDirty(false);
		}
	}, [data]);

	// 主聊天跟踪开启时自动拉取跟踪文件列表（关掉则清空）
	useEffect(() => {
		if (developerMode && chatTrace) {
			let alive = true;
			getTraceFiles()
				.then((files) => alive && setTraceFiles(files))
				.catch(() => alive && setTraceFiles([]));
			return () => {
				alive = false;
			};
		}
		setTraceFiles(null);
	}, [developerMode, chatTrace]);

	const reloadTrace = () => {
		setTraceFiles(null);
		getTraceFiles()
			.then(setTraceFiles)
			.catch(() => setTraceFiles([]));
	};

	const touch = () => setDirty(true);

	const onTheme = (on: boolean) => {
		const mode: ThemeMode = on ? "dark" : "light";
		setDark(on);
		setTheme(mode);
		toast("info", on ? "已切换到黑夜模式" : "已切换到白昼模式");
	};

	const updateSound = (patch: Partial<SoundSettings>) =>
		setSound((s) => {
			const next = { ...s, ...patch };
			saveSoundSettings(next);
			return next;
		});

		const save = () =>
			run(async () => {
				// 只改本面板可见项；不碰 lorebook / importStripTags（由别处或默认处理）
				// "provider/id"——id 本身可能含 "/"（如 openrouter 的 google/gemini-3.7-flash）：
				// 第一段是 provider，其余全部拼回 id（2026-08-15 修，与 ModelSelect 同口径）
				const [sm0, ...smRest] = sideModelKey.split("/");
				const smId = smRest.join("/");
				await apiPut("/api/config", {
					greeting: true,
					scanDepth,
					maxLoreInjections: maxLore,
					compactEveryNTurns: compactEvery,
					backendControl,
					creationMode: askMode ? "ask" : "silent",
					sideModel: sm0 && smId ? { provider: sm0, id: smId } : null,
					sideJailbreak: sideJailbreak.trim(),
					developerMode,
					chatTrace,
				});
			reload();
		}, "已保存并重载会话");

	return (
		<div className="panel-body panel-body-sticky">
			<PanelStatus loading={loading} error={error} hasData={!!data} />
			<CollapsibleSection title="外观" storageKey="liyuan.settings.open.appearance" defaultOpen>
				<div className="toggle-row">
					<span>黑夜模式</span>
					<Toggle checked={dark} onChange={onTheme} />
				</div>
				<div className="field-hint">白昼 / 黑夜立刻切换，偏好记在本机浏览器，与会话配置无关。</div>
				</CollapsibleSection>
				<CollapsibleSection title="音效提醒" storageKey="liyuan.settings.open.sound" defaultOpen={false}>
					<div className="toggle-row">
						<span>音效提醒</span>
						<Toggle checked={sound.enabled} onChange={(v) => updateSound({ enabled: v })} />
					</div>
					<div className="field-hint">回答完成 / 出现需要你定夺的选择卡 / LLM 主动播放时响提示音，偏好记在本机浏览器，与会话配置无关。</div>
					<div className="toggle-row">
						<span>主聊天完成</span>
						<Toggle checked={sound.mainChat} disabled={!sound.enabled} onChange={(v) => updateSound({ mainChat: v })} />
					</div>
					<div className="toggle-row">
						<span>助手完成</span>
						<Toggle checked={sound.assistant} disabled={!sound.enabled} onChange={(v) => updateSound({ assistant: v })} />
					</div>
					<div className="toggle-row">
						<span>需要你定夺（ask）</span>
						<Toggle checked={sound.ask} disabled={!sound.enabled} onChange={(v) => updateSound({ ask: v })} />
					</div>
					<div className="toggle-row">
						<span>LLM 主动播放</span>
						<Toggle checked={sound.agent} disabled={!sound.enabled} onChange={(v) => updateSound({ agent: v })} />
					</div>
					<div className="toggle-row">
						<span>仅窗口不可见时提醒</span>
						<Toggle checked={sound.backgroundOnly} disabled={!sound.enabled} onChange={(v) => updateSound({ backgroundOnly: v })} />
					</div>
					<div className="field-hint">开着时只在窗口隐藏 / 最小化时响（前台看着不打扰），关着则总是提醒。</div>
				</CollapsibleSection>
				<CollapsibleSection title="界面自定义" storageKey="liyuan.settings.open.uiCustom" defaultOpen={false}>
				<UiCustomSection toast={toast} />
			</CollapsibleSection>
			<CollapsibleSection title="主聊天窗口" storageKey="liyuan.settings.open.chatWindow" defaultOpen>
				<ChatWindowSection />
			</CollapsibleSection>
			<CollapsibleSection title="访问密码" storageKey="liyuan.settings.open.access" defaultOpen>
				<AccessSection toast={toast} />
			</CollapsibleSection>
			<CollapsibleSection title="向量记忆" storageKey="liyuan.settings.open.memory" defaultOpen={false}>
				<MemorySection toast={toast} />
			</CollapsibleSection>
			{data && (
				<>
					<CollapsibleSection title="世界书" storageKey="liyuan.settings.open.lorebook" defaultOpen>
						<SliderField
							label="关键词扫描深度"
							hint="被动触发回看最近几条消息"
							value={scanDepth}
							min={1}
							max={20}
							onChange={(v) => {
								setScanDepth(v);
								touch();
							}}
						/>
						<SliderField
							label="每轮注入条目上限"
							hint="0 = 关闭被动注入（常驻条目不受影响）"
							value={maxLore}
							min={0}
							max={10}
							onChange={(v) => {
								setMaxLore(v);
								touch();
							}}
						/>
					</CollapsibleSection>

					<CollapsibleSection title="上下文压缩" storageKey="liyuan.settings.open.compact" defaultOpen>
						<SliderField
							label="固定楼层压缩周期"
							hint="每 N 个剧情轮把早期正文压成接力摘要（原文归档进剧情库可召回）；0 = 仅在上下文吃紧时被动压缩"
							value={compactEvery}
							min={0}
							max={100}
							onChange={(v) => {
								setCompactEvery(v);
								touch();
							}}
						/>
					</CollapsibleSection>

					<CollapsibleSection title="agent 行为" storageKey="liyuan.settings.open.agentBehavior" defaultOpen>
						<div className="toggle-row">
							<span>后端操控（bash / 文件等通用工具）</span>
							<Toggle
								checked={backendControl}
								onChange={(v) => {
									setBackendControl(v);
									touch();
								}}
							/>
						</div>
						<div className="field-hint">
							开启后 agent 能操作本机（调用你的其他项目、查资料）；全部调用都会显示在过程条。仅在自己的设备上开启。
						</div>
						<div className="toggle-row">
							<span>决策门禁（戏内选择卡）</span>
							<Toggle
								checked={askMode}
								onChange={(v) => {
									setAskMode(v);
									touch();
								}}
							/>
						</div>
						<div className="field-hint">
							开=询问档：剧情相关（含「我该怎么办」）一律戏内，用选择卡共创；关=静默档自行推进。戏外只办系统事，不处理剧情。
						</div>
					</CollapsibleSection>

						<CollapsibleSection title="旁挂模型" storageKey="liyuan.settings.open.sideModel" defaultOpen>
							<div className="field-row">
								<span className="field-label">旁路模型</span>
								<ModelSelect
									className="field-input"
									value={sideModelKey}
									emptyLabel="跟随剧情模型"
									disabled={busy}
									onChange={(sel) => {
										setSideModelKey(sel ? `${sel.provider}/${sel.id}` : "");
										touch();
									}}
									title="旁路模型（与主聊天共用同一模型列表）"
									ariaLabel="旁路模型"
									style={{ maxWidth: "100%" }}
								/>
							</div>
							<div className="field-hint">
								表格回填 / 导入建账与摘要 / 场记 / 语义评审 / 生图规划等旁路调用统一使用的独立模型；空 = 跟随剧情模型。改动保存后立即生效。
							</div>
							<div className="field-hint">
								模型列表与主聊天 / 助手共用一份（模型配置归一）——「未配 key」= 该渠道还没填 API key，在连接面板的渠道生成器里配置后即可选。旁路模型不必与主模型同一渠道。
							</div>
						<div style={{ marginTop: 8 }}>
							<span className="field-label">破甲提示词（可选）</span>
							<textarea
								className="field-input"
								value={sideJailbreak}
								disabled={busy}
								rows={4}
								placeholder="固定放在旁路提示词最前，用于绕过模型限制；留空不注入"
								onChange={(e) => {
									setSideJailbreak(e.target.value);
									touch();
								}}
								style={{ width: "100%", boxSizing: "border-box" }}
							/>
						</div>
						<div className="field-hint">
							除每轮剧情场记外，所有旁路调用（回填/建账/摘要/规划）的 systemPrompt 最前都会带上这段文本。由你主动配置，谨慎使用。
						</div>
					</CollapsibleSection>

					<CollapsibleSection title="开发者模式" storageKey="liyuan.settings.open.developer" defaultOpen={false}>
						<div className="toggle-row">
							<span>开发者模式</span>
							<Toggle
								checked={developerMode}
								onChange={(v) => {
									setDeveloperMode(v);
									touch();
								}}
							/>
						</div>
						<div className="field-hint">打开后显示开发者选项（调试 / 分析用）。改动随本面板一起保存。</div>
						{developerMode && (
							<>
								<div className="toggle-row">
									<span>主聊天跟踪</span>
									<Toggle
										checked={chatTrace}
										onChange={(v) => {
											setChatTrace(v);
											touch();
										}}
									/>
								</div>
								<div className="field-hint">
									记录当前聊天全过程（送模提示词 / 思考 / 工具调用 / 草稿 / 旁路模型 / 定稿）到本机
									.liyuan-state/trace/&lt;会话id&gt;.jsonl，每条含角色卡 / 预设 / 时间等元信息（JSONL 每事件一行）。
									保存后下一回合生效；切换聊天自动分文件；文件较大且不自动清理。
								</div>
								{chatTrace && (
									<div style={{ marginTop: 8 }}>
										<button className="drawer-btn" onClick={reloadTrace}>
											{traceFiles === null ? "加载跟踪文件…" : "刷新跟踪文件"}
										</button>
										{traceFiles !== null && traceFiles.length === 0 && (
											<div className="field-hint" style={{ marginTop: 6 }}>
												还没有跟踪文件——保存设置后发一条消息，这里会出现当前聊天的记录。
											</div>
										)}
										{traceFiles !== null && traceFiles.length > 0 && (
											<div style={{ marginTop: 6, fontSize: 12 }}>
												{traceFiles.map((f) => (
													<div
														key={f.name}
														className="field-row"
														style={{ justifyContent: "space-between", gap: 8, alignItems: "center" }}
													>
														<span style={{ wordBreak: "break-all" }}>
															{f.name}（{fmtSize(f.size)} · {new Date(f.mtime).toLocaleString()}）
														</span>
														<button
															className="drawer-btn"
															style={{ flexShrink: 0 }}
															onClick={() => {
																downloadTraceFile(f.name).catch((e) =>
																	toast("error", e instanceof Error ? e.message : String(e)),
																);
															}}
														>
															下载
														</button>
													</div>
												))}
											</div>
										)}
									</div>
								)}
							</>
						)}
					</CollapsibleSection>

					<div className="sticky-save">
						<button className="drawer-btn save-btn" disabled={busy || !dirty} onClick={save}>
							{dirty ? "保存并重载会话" : "已保存"}
						</button>
					</div>
				</>
			)}
		</div>
	);
}
