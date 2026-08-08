/**
 * 图片管理（自 DrawPanel 抽离，插件 D draw-edit 挂载；重设计对齐 LWB）。
 *
 * 结构（保留全部既有行为）：
 * ① 统计卡：图片数量（金，= 全部平铺图块数）/ 占用空间 / 自动清理（retentionDays 1–30 + autoClean，PUT /api/config 持久化）
 *   + 刷新 / 清理过期（POST /api/draw/slots/cleanup）/ 清空全部（ConfirmButton 二次确认）。
 * ② 分组按「角色卡」（= 角色卡文件，LWB 一级维度）：确定性 emoji 头像 + 可读卡名 + "X 张 · Y 组 · Z MB"，
 *   默认收起（template `.gallery-char-section.collapsed`）；分组 key = 当前显示版本 tags.card
 *   （生成时快照进 params 的角色卡路径，如 assets/cards/StarMini.png），缺省回退首个非废弃版本；
 *   旧槽位无 card 字段 → 归入「未指定角色卡」。本地出图（📁）保留为 Liyuan 独立分区。
 * ③ 平铺网格：每个有 src 的版本一张纯预览图块（含 discarded；src 缺失不渲染），
 *   左下日期 + 右下已保存绿色勾（v.saved / 本地出图恒已保存）；点击 → 全局 Lightbox
 *   （所有图块按渲染顺序入列，「« n/total »」跨组导航）。
 * ④ 空态：两个数据源都为空 → 居中图标 + 暂无图片 + 提示。
 *
 * 保留能力：保存所有（全局进度条）、删除全部、清理过期、自动清理设置、刷新、跨组 Lightbox。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost, apiPut, type UploadsResponse } from "../api.ts";
import { attachmentUrl, toAttachmentView } from "../attachments.ts";
import { IconBroom, IconCheck, IconClose, IconImage, IconRefresh, IconTrash } from "./icons.tsx";
import { ConfirmButton, PanelStatus, usePanelData } from "./kit.tsx";

/** GET /api/draw/slots 无参摘要的 slot 版本视图（与 rest.ts slots 路由 versions 字段对齐） */
interface SlotVersionView {
	src: string;
	saved: boolean;
	discarded: boolean;
	/** 版本 TAG 分栏（服务端 tagsFromParams 透出；角色卡分组取 tags.card 路径） */
	tags?: {
		scene?: string;
		characterPrompts?: { name: string; prompt: string; uc?: string }[];
		positive?: string;
		/** 生成时快照的角色卡路径（如 assets/cards/StarMini.png）；旧槽位无此字段 → 归入「未指定角色卡」 */
		card?: string;
	};
}
interface SlotSummaryView {
	slotId: string;
	saved: boolean;
	createdAt: number;
	versionCount: number;
	/** 选中版本数组下标（缺省 undefined = 最新非 discarded） */
	selectedVersionIndex?: number;
	/** slot 是否有失败版本（LWB storeFailedPlaceholder；失败态渲染判断） */
	hasFailed?: boolean;
	/** 槽位占用字节（服务端新增；缺失时按 0 忽略） */
	bytes?: number;
	versions: SlotVersionView[];
}
interface DrawSlotsResponse {
	total: number;
	unsaved: number;
	slots: SlotSummaryView[];
}

/** draw-slot 插件设置（自动清理用） */
interface DrawSlotSettings {
	retentionDays?: number;
	autoClean?: boolean;
}
interface ConfigLite {
	config?: { plugins?: Record<string, { enabled?: boolean; settings?: Record<string, unknown> }> };
}

/** 平铺图块：每个有 src 的版本 / 每张本地出图一图块；纯预览，点击 → Lightbox */
interface GalleryTile {
	/** 唯一 key（槽位 `${slotId}:${版本下标}` / 本地 `media:${file}`） */
	key: string;
	src: string;
	/** 保存态（槽位版本 v.saved；本地出图恒 true） */
	saved: boolean;
	/** 日期毫秒（槽位版本用 slot createdAt；本地出图用 mtimeMs） */
	dateMs: number;
	alt?: string;
	/** 所属角色卡组 key（角色卡路径；本地出图无） */
	charKey?: string;
}

/** Lightbox 状态：全部图块 src 列表 + 当前下标 */
interface LightboxState {
	srcs: string[];
	index: number;
}

/** 毫秒 → "YYYY/M/D"（如 2026/8/2） */
function formatDate(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const d = new Date(ms);
	return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 字节 → "2108.05 MB" */
function formatMB(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 无角色卡归属的兜底组名 */
const UNSPECIFIED_CHAR = "未指定角色卡";

/** LWB 确定性头像 emoji 表（novel-draw.html getCharEmoji 同表） */
const CHAR_EMOJIS = ["👤", "👩", "👨", "🧑", "👧", "👦", "👸", "🤴", "🧙", "🧝", "🧛", "🦸"];

/** LWB 确定性头像 emoji：角色卡可读名各字符码之和 % emojis.length */
function getCharEmoji(name: string): string {
	const sum = String(name || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
	return CHAR_EMOJIS[sum % CHAR_EMOJIS.length];
}

/** 角色卡路径 → 可读卡名：取 basename（兼容 / 与 \）并去掉图片扩展名（png/jpg/jpeg/webp/gif，不区分大小写）；解析为空回退原字符串 */
function cardDisplayName(card: string): string {
	const base = String(card || "").split(/[/\\]/).pop() ?? "";
	const m = /\.([a-z]+)$/i.exec(base);
	if (m && /^(png|jpe?g|webp|gif)$/i.test(m[1])) {
		return base.slice(0, -(m[1].length + 1)) || card;
	}
	return base || card;
}

/**
 * 槽位当前显示版本下标（服务端选中 → 最新非 discarded）。
 * 角色卡分组用：不含本地预览，避免预览版本时分组随之重排。
 */
function slotShownIndex(s: SlotSummaryView): number | null {
	if (s.selectedVersionIndex !== undefined) {
		const v = s.versions[s.selectedVersionIndex];
		if (v && !v.discarded && v.src) return s.selectedVersionIndex;
	}
	for (let i = s.versions.length - 1; i >= 0; i -= 1) {
		if (!s.versions[i].discarded) return i;
	}
	return null;
}

/** 角色卡分组 key：当前显示版本 tags.card（角色卡路径） → 首个非废弃版本 tags.card → 「未指定角色卡」 */
function slotCardPath(s: SlotSummaryView): string {
	const shown = slotShownIndex(s);
	if (shown != null) {
		const card = s.versions[shown]?.tags?.card;
		if (card && card.trim()) return card.trim();
	}
	const first = s.versions.findIndex((v) => !v.discarded);
	if (first >= 0) {
		const card = s.versions[first]?.tags?.card;
		if (card && card.trim()) return card.trim();
	}
	return UNSPECIFIED_CHAR;
}

/** 平铺图块：图片 + 左下日期 + 右下已保存绿色勾；点击打开 Lightbox */
function GalleryTileView({ tile, onOpen }: { tile: GalleryTile; onOpen: () => void }) {
	return (
		<div className="draw-gallery-card">
			<div className="draw-gallery-card-media">
				<button type="button" className="upload-cell-btn" onClick={onOpen} title="点击放大">
					<img src={tile.src} alt={tile.alt ?? ""} loading="lazy" />
				</button>
				<span className="draw-gallery-card-date">{formatDate(tile.dateMs)}</span>
				{tile.saved && (
					<span className="draw-gallery-card-check" title="已保存">
						<IconCheck size={12} />
					</span>
				)}
			</div>
		</div>
	);
}

export function GallerySection() {
	const media = usePanelData(() => apiGet<UploadsResponse>("/api/uploads"), { watchAgent: true, cacheKey: "/api/uploads" });
	const slots = usePanelData(() => apiGet<DrawSlotsResponse>("/api/draw/slots"), { watchAgent: true, cacheKey: "/api/draw/slots" });
	const configData = usePanelData(() => apiGet<ConfigLite>("/api/config"), { cacheKey: "/api/config" });
	const [lightbox, setLightbox] = useState<LightboxState | null>(null);
	const [busy, setBusy] = useState(false);
	/** 保存所有进度：{ 总量, 已完成 }；null = 不在进行中 */
	const [saveAll, setSaveAll] = useState<{ total: number; done: number } | null>(null);
	/** 瞬时提示（无全局 toast 通道时的轻量替代） */
	const [notice, setNotice] = useState<string | null>(null);
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** 分组展开状态（Record<string, boolean>：char:<角色卡名> / media；缺失 = 收起）。角色卡组默认收起（LWB），本地出图默认展开 */
	const [expanded, setExpanded] = useState<Record<string, boolean>>({ media: true });

	const toggleGroup = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

	/** 自动清理草稿：draw-slot 插件 retentionDays（默认 3，LWB 限 1–30）/ autoClean（默认关）；配置异步到达后仅初始化一次 */
	const [retentionDays, setRetentionDays] = useState(3);
	const [autoClean, setAutoClean] = useState(false);
	const cleanSeeded = useRef(false);
	useEffect(() => {
		if (cleanSeeded.current || !configData.data) return;
		cleanSeeded.current = true;
		const s = (configData.data.config?.plugins?.["draw-slot"]?.settings ?? {}) as DrawSlotSettings;
		if (typeof s.retentionDays === "number" && Number.isFinite(s.retentionDays)) {
			setRetentionDays(Math.min(30, Math.max(1, Math.round(s.retentionDays))));
		}
		setAutoClean(s.autoClean === true);
	}, [configData.data]);

	const flash = (msg: string) => {
		setNotice(msg);
		if (noticeTimer.current) clearTimeout(noticeTimer.current);
		noticeTimer.current = setTimeout(() => setNotice(null), 2600);
	};

	const galleryList = useMemo(
		() => (media.data?.media ?? []).filter((u) => toAttachmentView(u.file).image),
		[media.data],
	);

	/** 防重入：操作中禁用全部按钮；onError 供调用方就地展示失败信息 */
	const run = async (fn: () => Promise<void>, onError?: (e: unknown) => void) => {
		if (busy) return;
		setBusy(true);
		try {
			await fn();
		} catch (e) {
			console.error(e);
			onError?.(e);
		} finally {
			setBusy(false);
		}
	};

	const slotGroups = slots.data?.slots ?? [];

	/** 全部槽位版本平铺图块（含 discarded；src 缺失的版本不渲染），按槽位顺序 */
	const slotTiles = useMemo<GalleryTile[]>(() => {
		const out: GalleryTile[] = [];
		for (const s of slotGroups) {
			const charKey = slotCardPath(s);
			for (let i = 0; i < s.versions.length; i += 1) {
				const v = s.versions[i];
				if (v.src && v.src.trim()) {
					out.push({
						key: `${s.slotId}:${i}`,
						src: v.src,
						saved: v.saved,
						dateMs: s.createdAt,
						alt: s.slotId,
						charKey,
					});
				}
			}
		}
		return out;
	}, [slotGroups]);

	/** 角色卡（路径）→ 该组图块列表 */
	const tilesByGroup = useMemo(() => {
		const map = new Map<string, GalleryTile[]>();
		for (const t of slotTiles) {
			const key = t.charKey ?? UNSPECIFIED_CHAR;
			const arr = map.get(key) ?? [];
			arr.push(t);
			map.set(key, arr);
		}
		return map;
	}, [slotTiles]);

	/** 角色卡分组（LWB 一级维度）：角色卡路径 → 组内 slots；组内按 createdAt 降序，组间按组内最新 createdAt 降序 */
	const charGroups = useMemo(() => {
		const map = new Map<string, SlotSummaryView[]>();
		for (const s of slotGroups) {
			const key = slotCardPath(s);
			const arr = map.get(key) ?? [];
			arr.push(s);
			map.set(key, arr);
		}
		return [...map.entries()]
			.map(([key, arr]) => {
				const list = [...arr].sort((a, b) => b.createdAt - a.createdAt);
				return {
					key,
					name: cardDisplayName(key),
					slots: list,
					latest: Math.max(0, ...list.map((s) => s.createdAt || 0)),
				};
			})
			.sort((a, b) => b.latest - a.latest);
	}, [slotGroups]);

	/** 本地出图平铺图块（已落盘即视为已保存） */
	const mediaTiles = useMemo<GalleryTile[]>(
		() =>
			galleryList.map((u) => {
				const view = toAttachmentView(u.file);
				return {
					key: `media:${u.file}`,
					src: attachmentUrl(view),
					saved: true,
					dateMs: u.mtimeMs,
					alt: view.label,
				};
			}),
		[galleryList],
	);

	/** 全局 Lightbox 数据源：按渲染顺序（角色卡组序 → 本地出图）平铺全部图块 */
	const lightboxTiles = useMemo(() => {
		const out: GalleryTile[] = [];
		for (const g of charGroups) {
			const arr = tilesByGroup.get(g.key) ?? [];
			for (const t of arr) out.push(t);
		}
		for (const t of mediaTiles) out.push(t);
		return out;
	}, [charGroups, tilesByGroup, mediaTiles]);

	/** 角色卡组元信息："{张} 张 · {组} 组 · {MB} MB"（张 = 组内图块数，MB = Σ bytes，组 = slot 数） */
	const charGroupMeta = (g: { key: string; slots: SlotSummaryView[] }) => {
		const count = tilesByGroup.get(g.key)?.length ?? 0;
		const bytes = g.slots.reduce((sum, s) => sum + (typeof s.bytes === "number" && s.bytes > 0 ? s.bytes : 0), 0);
		return `${count} 张 · ${g.slots.length} 组 · ${formatMB(bytes)}`;
	};

	/** 统计：图片数量（= 平铺图块数：槽位版本含 src + 本地出图）、占用空间（bytes 求和；服务端未下发时按 0） */
	const stats = useMemo(() => {
		const slotBytes = slotGroups.reduce((sum, s) => sum + (typeof s.bytes === "number" && s.bytes > 0 ? s.bytes : 0), 0);
		const mediaBytes = galleryList.reduce(
			(sum, u) => sum + (typeof u.bytes === "number" && u.bytes > 0 ? u.bytes : 0),
			0,
		);
		return {
			tileCount: slotTiles.length,
			slotBytes,
			mediaCount: galleryList.length,
			mediaBytes,
			totalImages: slotTiles.length + galleryList.length,
			totalBytes: slotBytes + mediaBytes,
		};
	}, [slotTiles, slotGroups, galleryList]);

	/** 点击任一图块 → 全局 Lightbox（定位该图块下标，« n/total » 跨组导航） */
	const openLightbox = (tile: GalleryTile) => {
		const i = lightboxTiles.findIndex((t) => t.key === tile.key);
		setLightbox({ srcs: lightboxTiles.map((t) => t.src), index: i >= 0 ? i : 0 });
	};

	/** 保存所有未保存槽位（逐个 POST save，带进度条） */
	const saveAllSlots = () =>
		run(async () => {
			const target = slotGroups.filter((s) => !s.saved);
			if (target.length === 0) {
				flash("没有未保存的槽位");
				return;
			}
			setSaveAll({ total: target.length, done: 0 });
			let done = 0;
			for (const s of target) {
				await apiPost("/api/draw/slots/save", { slotId: s.slotId });
				done += 1;
				setSaveAll({ total: target.length, done });
			}
			setSaveAll(null);
			slots.reload();
			flash(`已保存 ${target.length} 张`);
		});

	/** 删除全部（不传 slotIds = 全部）；后端同时从正文剥离占位符 */
	const deleteAllSlots = () =>
		run(async () => {
			const r = await apiPost<{ ok: boolean; removedFiles: number; stripped: number }>("/api/draw/slots/delete-all", {});
			slots.reload();
			flash(`已删除 ${r.removedFiles} 张，正文剥离 ${r.stripped} 处`);
		});

	/** 清理过期：POST /api/draw/slots/cleanup（按当前输入天数），完成后重拉 */
	const cleanupExpired = () =>
		run(async () => {
			const r = await apiPost<{ ok: boolean; removedSlots: number; removedFiles: number }>("/api/draw/slots/cleanup", {
				retentionDays,
			});
			slots.reload();
			flash(`已清理 ${r.removedSlots} 个槽位（${r.removedFiles} 个文件）`);
		});

	/** 持久化自动清理设置：plugins["draw-slot"].settings = { ...cur, retentionDays(1–30), autoClean } */
	const saveCleanSettings = (days: number, clean: boolean) => {
		const clamped = Math.min(30, Math.max(1, days));
		void (async () => {
			try {
				const plugins = { ...(configData.data?.config?.plugins ?? {}) };
				const ds = { ...(plugins["draw-slot"] ?? {}) };
				ds.settings = { ...((ds.settings ?? {}) as DrawSlotSettings), retentionDays: clamped, autoClean: clean };
				plugins["draw-slot"] = ds;
				await apiPut("/api/config", { plugins });
				configData.reload();
				flash("自动清理设置已保存");
			} catch (e) {
				console.error(e);
				flash(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	const reloadAll = () => {
		slots.reload();
		media.reload();
	};

	const unsavedCount = slotGroups.filter((s) => !s.saved).length;
	const mediaMeta = `${stats.mediaCount} 张 · ${formatMB(stats.mediaBytes)}`;
	/** 两个数据源都已加载且都为空 → 空态 */
	const bothEmpty = !!slots.data && !!media.data && slotGroups.length === 0 && galleryList.length === 0;

	return (
		<div className="draw-gallery">
			{/* ══════════ 统计卡：左统计 / 中自动清理 / 右操作 ══════════ */}
			<div className="draw-gallery-stats">
				<div className="draw-gallery-stats-left">
					<div className="draw-gallery-stat">
						<div className="draw-gallery-stat-num gold">{stats.totalImages}</div>
						<div className="draw-gallery-stat-label">图片数量</div>
					</div>
					<div className="draw-gallery-stat">
						<div className="draw-gallery-stat-num">{formatMB(stats.totalBytes)}</div>
						<div className="draw-gallery-stat-label">占用空间</div>
					</div>
				</div>

				<div className="draw-gallery-clean">
					<div className="draw-gallery-clean-row">
						<input
							className="draw-gallery-clean-input"
							type="number"
							min={1}
							max={30}
							step={1}
							value={retentionDays}
							title="过期清理天数（1–30）"
							onChange={(e) => {
								const n = Number.parseInt(e.target.value, 10);
								if (Number.isInteger(n) && n >= 1) {
									const d = Math.min(30, Math.max(1, n));
									setRetentionDays(d);
									saveCleanSettings(d, autoClean);
								}
							}}
						/>
						<span className="draw-gallery-clean-unit">天</span>
						<label className="draw-gallery-clean-check" title="到期自动清理未保存槽位">
							<input
								type="checkbox"
								checked={autoClean}
								onChange={(e) => {
									setAutoClean(e.target.checked);
									saveCleanSettings(retentionDays, e.target.checked);
								}}
							/>
							自动清理
						</label>
					</div>
					<div className="draw-gallery-clean-foot">
						<button type="button" className="draw-gallery-iconbtn" title="刷新图片列表" onClick={reloadAll}>
							<IconRefresh size={15} />
						</button>
						<span className="draw-gallery-clean-hint">超过此天数的未保存图片会被清理</span>
					</div>
				</div>

				<div className="draw-gallery-stats-right">
					<button
						type="button"
						className="draw-gallery-clean-btn"
						disabled={busy}
						title="清理到期未保存的槽位"
						onClick={() => void cleanupExpired()}
					>
						<IconBroom size={14} /> 清理过期
					</button>
					<ConfirmButton
						className="draw-gallery-danger-btn"
						disabled={busy || slotGroups.length === 0}
						confirmText="确认清空全部？将从正文剥离占位符"
						title="删除全部生图槽位（含从正文剥离占位符）"
						onConfirm={() => void deleteAllSlots()}
					>
						<IconTrash size={14} /> 清空全部
					</ConfirmButton>
				</div>
			</div>

			{/* 首拉失败/读取中（无任何数据时） */}
			{!slots.data && !media.data && (
				<PanelStatus loading={slots.loading || media.loading} error={slots.error || media.error} hasData={false} />
			)}

			{/* ══════════ 空态：生图槽位 + 本地出图都为空 ══════════ */}
			{bothEmpty && (
				<div className="draw-gallery-empty">
					<IconImage size={64} className="draw-gallery-empty-icon" />
					<div className="draw-gallery-empty-title">暂无图片</div>
					<div className="draw-gallery-empty-hint">在对话里让 AI 配图后，会出现在这里</div>
				</div>
			)}

			{/* ══════════ ① 角色卡分组（LWB 语义：按角色卡文件分组，旧槽位无卡归「未指定角色卡」；默认收起；平铺纯预览图块） ══════════ */}
			{charGroups.length > 0 && (
				<>
					{/* 保存所有（跨角色卡全局操作；右侧进度条同行显示） */}
					<div className="draw-gallery-toolbar">
						<button
							type="button"
							className="drawer-btn"
							disabled={busy || unsavedCount === 0}
							title="保存所有未保存的槽位"
							onClick={() => void saveAllSlots()}
						>
							保存所有
						</button>
						{saveAll && (
							<div
								className="draw-gallery-progress"
								style={{ flex: 1, margin: 0 }}
								aria-label={`保存中 ${saveAll.done}/${saveAll.total}`}
							>
								<div
									className="draw-gallery-progress-fill"
									style={{ width: `${Math.round((saveAll.done / Math.max(1, saveAll.total)) * 100)}%` }}
								/>
								<span className="draw-gallery-progress-text">
									保存中 {saveAll.done}/{saveAll.total}
								</span>
							</div>
						)}
					</div>

					{charGroups.map((g) => {
						const gid = `char:${g.key}`;
						const isOpen = !!expanded[gid];
						const tiles = tilesByGroup.get(g.key) ?? [];
						if (tiles.length === 0) return null;
						return (
							<div key={gid} className="draw-gallery-group">
								<button
									type="button"
									className="draw-gallery-group-head"
									aria-expanded={isOpen}
									onClick={() => toggleGroup(gid)}
								>
									<span className="draw-gallery-group-avatar">{getCharEmoji(g.name)}</span>
									<span className="draw-gallery-group-title">{g.name}</span>
									<span className="draw-gallery-group-meta">{charGroupMeta(g)}</span>
									<span className="draw-gallery-group-chevron">{isOpen ? "v" : "›"}</span>
								</button>
								{isOpen && (
									<div className="draw-gallery-group-body">
										<div className="draw-gallery-grid">
											{tiles.map((tile) => (
												<GalleryTileView key={tile.key} tile={tile} onOpen={() => openLightbox(tile)} />
											))}
										</div>
									</div>
								)}
							</div>
						);
					})}
				</>
			)}

			{/* ══════════ ② 本地出图（Liyuan 独立分区；无 LWB 对应，保持可折叠） ══════════ */}
			{mediaTiles.length > 0 && (
				<div className="draw-gallery-group">
					<button
						type="button"
						className="draw-gallery-group-head"
						aria-expanded={!!expanded.media}
						onClick={() => toggleGroup("media")}
					>
						<span className="draw-gallery-group-avatar">📁</span>
						<span className="draw-gallery-group-title">本地出图</span>
						<span className="draw-gallery-group-meta">{mediaMeta}</span>
						<span className="draw-gallery-group-chevron">{expanded.media ? "v" : "›"}</span>
					</button>
					{!!expanded.media && (
						<div className="draw-gallery-group-body">
							<div className="draw-gallery-grid">
								{mediaTiles.map((tile) => (
									<GalleryTileView key={tile.key} tile={tile} onOpen={() => openLightbox(tile)} />
								))}
							</div>
						</div>
					)}
				</div>
			)}

			{/* Lightbox：全局图块导航（« n/total »），边界禁用 */}
			{lightbox && (
				<div className="lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setLightbox(null)}>
					<button
						type="button"
						className="icon-btn lightbox-x"
						title="关闭"
						aria-label="关闭预览"
						onClick={() => setLightbox(null)}
					>
						<IconClose size={20} />
					</button>
					{lightbox.srcs.length > 1 && (
						<span className="draw-lb-nav">
							<button
								type="button"
								className="act"
								disabled={lightbox.index <= 0}
								title="上一张"
								onClick={(e) => {
									e.stopPropagation();
									setLightbox((p) => (p && p.index > 0 ? { ...p, index: p.index - 1 } : p));
								}}
							>
								«
							</button>
							<span className="draw-lb-idx">
								{lightbox.index + 1}/{lightbox.srcs.length}
							</span>
							<button
								type="button"
								className="act"
								disabled={lightbox.index >= lightbox.srcs.length - 1}
								title="下一张"
								onClick={(e) => {
									e.stopPropagation();
									setLightbox((p) => (p && p.index < p.srcs.length - 1 ? { ...p, index: p.index + 1 } : p));
								}}
							>
								»
							</button>
						</span>
					)}
					<img src={lightbox.srcs[lightbox.index]} alt="预览" />
				</div>
			)}
			{notice && <div className="draw-notice">{notice}</div>}
		</div>
	);
}
