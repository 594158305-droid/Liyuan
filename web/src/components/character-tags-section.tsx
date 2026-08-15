/**
 * 角色标签（重设计，双栏布局，参考 Novel Draw 角色标签总览图，风格用梨园令牌）。
 * 左栏：角色概览 / 搜索与筛选 / 批量操作 / 智能辅助；右栏：角色列表；底部：标签缓存管理。
 * 数据源：/api/wardrobe（角色档案）、/api/draw/characters/learn-candidates（自动学习）、
 *         /api/draw/tags/online-status 与 /online-update（在线标签缓存）。
 */

import { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.ts";
import { ConfirmButton, Field, PanelStatus, Toggle, useAction, usePanelData } from "./kit.tsx";
import { IconDownload, IconPlus, IconRefresh, IconTrash, IconUploads } from "./icons.tsx";

type ToastFn = (level: "info" | "warning" | "error", text: string) => void;

interface WardrobeOutfit {
	id: string;
	name: string;
	tags: string;
	referenceImage?: string;
	notes?: string;
}
interface WardrobeCharacter {
	name: string;
	appearanceTags: string;
	outfits: WardrobeOutfit[];
	id?: string;
	aliases?: string[];
	type?: string;
	negativeTags?: string;
	danbooruTag?: string;
	useDanbooruTag?: boolean;
	hidden?: boolean;
	selectedGroupId?: string;
}
interface WardrobeFile {
	format: string;
	version: number;
	cardPath: string;
	characters: WardrobeCharacter[];
}
interface WardrobeResponse {
	ok: boolean;
	card: string;
	wardrobe: WardrobeFile;
}
interface LearnCandidate {
	name: string;
	firstSeenAt: number;
	source: "pipeline" | "manual";
	status: "pending" | "learned" | "ignored";
}
interface OnlineStatus {
	ok: boolean;
	status: { lastUpdatedAt: number | null; entries: number } | null;
}

const TYPE_OPTIONS = ["", "girl", "boy", "man", "woman"];

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/** 行内状态徽标：外貌已设置 / 未设置 */
function AppearanceBadge({ c }: { c: WardrobeCharacter }) {
	return c.appearanceTags.trim() ? (
		<span className="ct-badge ok">✔ 外貌</span>
	) : (
		<span className="ct-badge warn">⚠ 未设置</span>
	);
}

export function CharacterTagsSection({ toast }: { toast: ToastFn }) {
	const { busy, run } = useAction(toast);
	const wardrobe = usePanelData(() => apiGet<WardrobeResponse>("/api/wardrobe"), { cacheKey: "/api/wardrobe" });
	const candidates = usePanelData(() => apiGet<{ ok: boolean; candidates: LearnCandidate[] }>("/api/draw/characters/learn-candidates"), {
		cacheKey: "/api/draw/characters/learn-candidates",
	});
	const online = usePanelData(() => apiGet<OnlineStatus>("/api/draw/tags/online-status"), { cacheKey: "/api/draw/tags/online-status" });

	const [kw, setKw] = useState("");
	const [typeF, setTypeF] = useState("");
	const [statusF, setStatusF] = useState("");
	const [expanded, setExpanded] = useState<string | null>(null);
	const [addName, setAddName] = useState("");
	const [drafts, setDrafts] = useState<Record<string, Partial<WardrobeCharacter>>>({});
	const [outfitDrafts, setOutfitDrafts] = useState<Record<string, { name: string; tags: string }>>({});

	const chars = wardrobe.data?.wardrobe?.characters ?? [];

	// 服装草稿：首次见到服装时用档案当前值初始化（用户输入才覆盖）
	useEffect(() => {
		const wb = wardrobe.data?.wardrobe;
		if (!wb) return;
		setOutfitDrafts((m) => {
			const next = { ...m };
			for (const c of wb.characters)
				for (const o of c.outfits) if (next[o.id] === undefined) next[o.id] = { name: o.name, tags: o.tags };
			return next;
		});
	}, [wardrobe.data]);

	// ---- 概览统计 ----
	const stats = useMemo(() => {
		const total = chars.length;
		const configured = chars.filter((c) => c.appearanceTags.trim()).length;
		const dbBound = chars.filter((c) => (c.danbooruTag ?? "").trim()).length;
		const hidden = chars.filter((c) => c.hidden).length;
		return { total, configured, pending: total - configured, dbBound, hidden };
	}, [chars]);

	// ---- 筛选 ----
	const filtered = useMemo(() => {
		const q = kw.trim().toLowerCase();
		return chars.filter((c) => {
			if (q) {
				const hay = [c.name, ...(c.aliases ?? []), c.appearanceTags, c.danbooruTag ?? ""].join(" ").toLowerCase();
				if (!hay.includes(q)) return false;
			}
			if (typeF && (c.type ?? "") !== typeF) return false;
			if (statusF === "configured" && !c.appearanceTags.trim()) return false;
			if (statusF === "pending" && c.appearanceTags.trim()) return false;
			if (statusF === "hidden" && !c.hidden) return false;
			return true;
		});
	}, [chars, kw, typeF, statusF]);

	const resetFilter = () => {
		setKw("");
		setTypeF("");
		setStatusF("");
	};

	// ---- 持久化（整文件 PUT） ----
	const persist = (next: WardrobeCharacter[], done?: string) =>
		run(async () => {
			const wb = wardrobe.data?.wardrobe;
			if (!wb) throw new Error("档案未加载");
			await apiPut("/api/wardrobe", { ...wb, characters: next });
			wardrobe.reload();
		}, done);

	const patchChar = (name: string, patch: Partial<WardrobeCharacter>) =>
		setDrafts((m) => ({ ...m, [name]: { ...m[name], ...patch } }));

	const draftOf = (c: WardrobeCharacter): WardrobeCharacter => ({ ...c, ...drafts[c.name] });

	const saveChar = (c: WardrobeCharacter) => {
		const d = draftOf(c);
		persist(
			chars.map((x) => (x.name === c.name ? { ...x, ...d } : x)),
			`已保存「${c.name}」`,
		);
	};

	const addCharacter = () => {
		const name = addName.trim();
		if (!name) return;
		if (chars.some((c) => c.name === name)) {
			toast("warning", `角色「${name}」已在档案中`);
			return;
		}
		persist([...chars, { name, appearanceTags: "", outfits: [] }], `已添加「${name}」`);
		setAddName("");
	};

	const deleteChar = (name: string) => persist(chars.filter((c) => c.name !== name), `已删除「${name}」`);

	// ---- 服装编辑（在角色标签内维护每套服装的 name/tags） ----
	const patchOutfitDraft = (o: WardrobeOutfit, patch: Partial<{ name: string; tags: string }>) =>
		setOutfitDrafts((m) => ({ ...m, [o.id]: { name: m[o.id]?.name ?? o.name, tags: m[o.id]?.tags ?? o.tags, ...patch } }));

	const saveOutfit = (c: WardrobeCharacter, o: WardrobeOutfit) => {
		const draft = outfitDrafts[o.id] ?? { name: o.name, tags: o.tags };
		persist(
			chars.map((x) =>
				x.name === c.name
					? { ...x, outfits: x.outfits.map((y) => (y.id === o.id ? { ...y, name: draft.name, tags: draft.tags } : y)) }
					: x,
			),
			`已保存服装「${draft.name}」`,
		);
	};

	const addOutfit = (c: WardrobeCharacter) =>
		persist(
			chars.map((x) => (x.name === c.name ? { ...x, outfits: [...x.outfits, { id: newId(), name: "新服装", tags: "" }] } : x)),
			"已添加服装",
		);

	const deleteOutfit = (c: WardrobeCharacter, oid: string) =>
		persist(chars.map((x) => (x.name === c.name ? { ...x, outfits: x.outfits.filter((y) => y.id !== oid) } : x)), "服装已删除");

	const clearAll = () => persist([], "已清除全部角色");

	const exportJson = () => {
		const wb = wardrobe.data?.wardrobe;
		if (!wb) return;
		const blob = new Blob([JSON.stringify(wb, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "liyuan-wardrobe.json";
		a.click();
		URL.revokeObjectURL(url);
	};

	const importFile = (file: File) =>
		run(async () => {
			const text = await file.text();
			const parsed = JSON.parse(text) as Partial<WardrobeFile> & { characters?: WardrobeCharacter[] };
			const arr = Array.isArray(parsed.characters) ? parsed.characters : Array.isArray(parsed as unknown[]) ? (parsed as unknown as WardrobeCharacter[]) : [];
			if (!Array.isArray(arr)) throw new Error("文件不是角色档案 JSON");
			const wb = wardrobe.data?.wardrobe;
			if (!wb) throw new Error("档案未加载");
			await apiPut("/api/wardrobe", { ...wb, characters: arr });
			wardrobe.reload();
			toast("info", `已导入 ${arr.length} 个角色`);
		});

	// ---- 智能辅助：待学习角色 ----
	const pendingCandidates = candidates.data?.candidates.filter((c) => c.status === "pending") ?? [];
	const learnConfirm = (name: string) =>
		run(async () => {
			await apiPost("/api/draw/characters/learn", { name });
			candidates.reload();
			wardrobe.reload();
		}, `已学习「${name}」`);
	const learnDismiss = (name: string) =>
		run(async () => {
			await apiDelete(`/api/draw/characters/learn?name=${encodeURIComponent(name)}`);
			candidates.reload();
		}, "已忽略");

	const updateOnline = () =>
		run(async () => {
			const r = await apiPost<{ entries: number }>("/api/draw/tags/online-update", {});
			toast("info", `在线标签库已更新（${r.entries} 条）`);
			online.reload();
		});

	const st = online.data?.status;

	return (
		<div className="ct-wrap">
			{/* ════════ 左栏 ════════ */}
			<div className="ct-left">
				<div className="ct-card">
					<h5 className="ct-card-title">角色概览</h5>
					<div className="ct-stats-grid">
						<div className="ct-stat">
							<div className="ct-stat-label">总角色数</div>
							<div className="ct-stat-num accent">{stats.total}</div>
						</div>
						<div className="ct-stat">
							<div className="ct-stat-label">已配置外貌</div>
							<div className="ct-stat-num">{stats.configured}</div>
						</div>
						<div className="ct-stat">
							<div className="ct-stat-label">待完善</div>
							<div className="ct-stat-num">{stats.pending}</div>
						</div>
						<div className="ct-stat">
							<div className="ct-stat-label">Danbooru 已绑定</div>
							<div className="ct-stat-num">{stats.dbBound}</div>
						</div>
						<div className="ct-stat">
							<div className="ct-stat-label">已隐藏</div>
							<div className="ct-stat-num">{stats.hidden}</div>
						</div>
					</div>
				</div>

				<div className="ct-card">
					<h5 className="ct-card-title">搜索与筛选</h5>
					<Field label="关键词">
						<input className="panel-search" value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索名称、别名、外貌、Danbooru 标签" />
					</Field>
					<div className="draw-params-grid">
						<Field label="角色类型">
							<select className="panel-search" value={typeF} onChange={(e) => setTypeF(e.target.value)}>
								<option value="">全部类型</option>
								{TYPE_OPTIONS.filter(Boolean).map((t) => (
									<option key={t} value={t}>
										{t}
									</option>
								))}
							</select>
						</Field>
						<Field label="状态筛选">
							<select className="panel-search" value={statusF} onChange={(e) => setStatusF(e.target.value)}>
								<option value="">全部状态</option>
								<option value="configured">已配置外貌</option>
								<option value="pending">待完善</option>
								<option value="hidden">已隐藏</option>
							</select>
						</Field>
					</div>
					<button type="button" className="drawer-btn" onClick={resetFilter}>
						重置筛选
					</button>
					<div className="field-hint" style={{ marginTop: 8 }}>
						当前显示 {filtered.length} / {chars.length} 个角色
					</div>
				</div>

				<div className="ct-card">
					<h5 className="ct-card-title">批量操作</h5>
					<div className="panel-row" style={{ flexWrap: "wrap" }}>
						<input className="panel-search" style={{ maxWidth: 140 }} value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="角色名" />
						<button type="button" className="drawer-btn primary" disabled={busy || !addName.trim()} onClick={addCharacter}>
							<IconPlus size={13} /> 添加角色
						</button>
						<button type="button" className="drawer-btn" onClick={exportJson}>
							<IconDownload size={13} /> 导出
						</button>
						<label className="drawer-btn" style={{ cursor: "pointer" }}>
							<IconUploads size={13} /> 导入
							<input
								type="file"
								accept=".json,application/json"
								style={{ display: "none" }}
								onChange={(e) => {
									const f = e.target.files?.[0];
									if (f) void importFile(f);
									e.target.value = "";
								}}
							/>
						</label>
						<ConfirmButton className="drawer-btn danger" disabled={busy || chars.length === 0} confirmText="确认清除全部" title="清除全部角色" onConfirm={() => void clearAll()}>
							<IconTrash size={13} /> 清除全部
						</ConfirmButton>
					</div>
				</div>

				<div className="ct-card">
					<h5 className="ct-card-title">智能辅助 · 自动学习</h5>
					<div className="field-hint">管线检出的未登记角色，确认后加入档案。</div>
					{pendingCandidates.length === 0 && <div className="sp-empty">暂无待学习角色。</div>}
					{pendingCandidates.map((c) => (
						<div key={c.name} className="ct-learn-row">
							<span className="ct-char-name">{c.name}</span>
							<span className="field-hint">{new Date(c.firstSeenAt).toLocaleString()}</span>
							<span style={{ flex: 1 }} />
							<button type="button" className="act" disabled={busy} onClick={() => void learnConfirm(c.name)}>
								确认
							</button>
							<button type="button" className="act" disabled={busy} onClick={() => void learnDismiss(c.name)}>
								忽略
							</button>
						</div>
					))}
				</div>
			</div>

			{/* ════════ 右栏：角色列表 ════════ */}
			<div className="ct-right">
				<div className="ct-card">
					<div className="sp-section-head">
						<h5 className="ct-card-title">角色列表</h5>
						<span className="chip chip-cap">
							{filtered.length} / {chars.length}
						</span>
					</div>
					<div className="field-hint">预设角色外貌，LLM 只需补充动作和互动标签。</div>
					<PanelStatus loading={wardrobe.loading} error={wardrobe.error} hasData={!!wardrobe.data} />
					<div className="ct-list">
						{filtered.length === 0 && <div className="sp-empty">没有匹配的角色。</div>}
						{filtered.map((c) => {
							const d = draftOf(c);
							const open = expanded === c.name;
							return (
								<div key={c.name} className={`ct-char-row${open ? " open" : ""}`}>
									<button type="button" className="ct-char-head" onClick={() => setExpanded(open ? null : c.name)}>
										<span className="ct-char-name">{c.name}</span>
										{c.type && <span className="ct-chip">{c.type}</span>}
										{c.danbooruTag?.trim() && <span className="ct-chip accent">D站</span>}
										<AppearanceBadge c={c} />
										{c.outfits.length > 0 && <span className="ct-badge">👗 {c.outfits.length}套</span>}
										{c.hidden && <span className="ct-badge warn">已隐藏</span>}
										<span className="ct-chevron">{open ? "▾" : "▸"}</span>
									</button>
									{open && (
										<div className="ct-char-edit">
											<Field label="基础外观 tags（发型/瞳色/体型，生图时并入）">
												<textarea
													className="panel-search ta"
													rows={2}
													value={d.appearanceTags}
													onChange={(e) => patchChar(c.name, { appearanceTags: e.target.value })}
												/>
											</Field>
											<div className="draw-params-grid">
												<Field label="类型">
													<select className="panel-search" value={d.type ?? ""} onChange={(e) => patchChar(c.name, { type: e.target.value })}>
														<option value="">（未设置）</option>
														{TYPE_OPTIONS.filter(Boolean).map((t) => (
															<option key={t} value={t}>
																{t}
															</option>
														))}
													</select>
												</Field>
												<Field label="Danbooru tag">
													<input className="panel-search" value={d.danbooruTag ?? ""} onChange={(e) => patchChar(c.name, { danbooruTag: e.target.value })} />
												</Field>
											</div>
											<div className="draw-toggle-row">
												<span>隐藏（生图时忽略）</span>
												<Toggle checked={!!d.hidden} onChange={(hidden) => patchChar(c.name, { hidden })} />
											</div>
											<div className="ct-outfit-list">
												<div className="sp-section-head">
													<div className="draw-sub-title">服装（{d.outfits.length}）</div>
													<button type="button" className="act" disabled={busy} onClick={() => addOutfit(c)}>
														<IconPlus size={13} /> 添加服装
													</button>
												</div>
												{d.outfits.length === 0 && <div className="sp-empty">还没有服装，点「添加服装」为角色建一套。</div>}
												{d.outfits.map((o) => {
													const od = outfitDrafts[o.id] ?? { name: o.name, tags: o.tags };
													return (
														<div key={o.id} className="ct-outfit-card">
															<div className="ct-outfit-head">
																<span className="ct-char-name">{od.name}</span>
																<ConfirmButton
																	className="act"
																	disabled={busy}
																	confirmText="确认删除"
																	title="删除服装"
																	onConfirm={() => void deleteOutfit(c, o.id)}
																>
																	<IconTrash size={12} />
																</ConfirmButton>
															</div>
															<Field label="服装名称">
																<input
																	className="panel-search"
																	value={od.name}
																	onChange={(e) => patchOutfitDraft(o, { name: e.target.value })}
																/>
															</Field>
															<Field label="服装 tags（空格分隔，可带 n::tag:: 权重，生图时并入当前穿着）">
																<textarea
																	className="panel-search ta"
																	rows={2}
																	value={od.tags}
																	onChange={(e) => patchOutfitDraft(o, { tags: e.target.value })}
																/>
															</Field>
															<div className="panel-row">
																<button type="button" className="drawer-btn" disabled={busy} onClick={() => saveOutfit(c, o)}>
																	保存服装
																</button>
															</div>
														</div>
													);
												})}
											</div>
											<div className="panel-row">
												<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={() => saveChar(c)}>
													保存
												</button>
												<ConfirmButton className="act" disabled={busy} confirmText="确认删除" title="删除角色" onConfirm={() => void deleteChar(c.name)}>
													<IconTrash size={12} /> 删除
												</ConfirmButton>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>

				<div className="ct-card">
					<h5 className="ct-card-title">标签缓存管理</h5>
					<div className="field-hint">缓存状态：{st ? `已加载 ${st.entries} 个标签（${new Date(st.lastUpdatedAt ?? 0).toLocaleString()}）` : "未加载（离线库 7000+ 角色可用）"}</div>
					<div className="panel-row">
						<button type="button" className="drawer-btn primary" disabled={busy} onClick={() => void updateOnline()}>
							<IconRefresh size={13} /> 刷新标签库
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
