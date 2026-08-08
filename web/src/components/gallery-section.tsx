/**
 * 画廊区（自 DrawPanel 抽离，插件 D draw-edit 挂载）。
 *
 * 两个分区：
 * ① 生图槽位（slots）：GET /api/draw/slots（无参，含版本摘要）→ 每 slot 一组：
 *    大图（服务端选中版本 / 本地预览）+ 版本行（discarded 弱化、selectedVersionIndex 标「当前」）；
 *    操作：保存（未保存时）/ 删除（组删除）/「使用此图」（把预览版本持久化为当前显示版本）；
 *    增强 / 放大（参数弹窗，LWB enhance-image-custom）；
 *    点击缩略图 → 本地预览切换大图；大图点击 → Lightbox（跨 slot 导航）。
 * ② 本地出图（uploads）：/api/uploads 保留（既有媒体库展示，网格原样，Lightbox 单图）。
 *
 * 头部操作：刷新 / 保存所有（进度条）/ 删除所有（含从正文剥离占位符）。
 * 批次 2.1（LWB 对齐）：跨 slot Lightbox 导航 + 保存所有进度条 + 删除所有 + 增强/放大参数弹窗 + hasFailed 徽标。
 */

import { useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, type UploadsResponse } from "../api.ts";
import { attachmentUrl, toAttachmentView } from "../attachments.ts";
import { IconClose, IconRefresh } from "./icons.tsx";
import { ConfirmButton, Field, PanelStatus, usePanelData } from "./kit.tsx";

/** GET /api/draw/slots 无参摘要的 slot 版本视图（与 rest.ts slots 路由 versions 字段对齐） */
interface SlotVersionView {
	src: string;
	saved: boolean;
	discarded: boolean;
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
	versions: SlotVersionView[];
}
interface DrawSlotsResponse {
	total: number;
	unsaved: number;
	slots: SlotSummaryView[];
}

/** 槽位当前显示 src：本地预览优先 → 服务端 selectedVersionIndex → 最新非 discarded */
function slotShownSrc(s: SlotSummaryView, preview: { slotId: string; versionIndex: number } | null): string | null {
	if (preview && preview.slotId === s.slotId) {
		const v = s.versions[preview.versionIndex];
		if (v && !v.discarded && v.src) return v.src;
	}
	if (s.selectedVersionIndex !== undefined) {
		const v = s.versions[s.selectedVersionIndex];
		if (v && !v.discarded && v.src) return v.src;
	}
	const cur = [...s.versions].reverse().find((v) => !v.discarded);
	return cur?.src ?? null;
}

/** Lightbox 状态：跨 slot 导航用 src 列表 + 当前下标；本地出图用单元素列表 */
interface LightboxState {
	srcs: string[];
	index: number;
}

/** 增强/放大自定义参数弹窗（LWB enhance-image-custom）：增强 strength / 放大 scaleBy */
function DrawEnhanceModal({
	op,
	busy,
	error,
	onCancel,
	onConfirm,
}: {
	op: "enhance" | "upscale";
	busy: boolean;
	error?: string | null;
	onCancel: () => void;
	onConfirm: (params: { strength?: number; scaleBy?: number }) => void;
}) {
	const [strength, setStrength] = useState("0.15");
	const [scaleBy, setScaleBy] = useState("2");

	const confirm = () => {
		if (op === "enhance") {
			const n = Number(strength);
			onConfirm(Number.isFinite(n) ? { strength: Math.min(1, Math.max(0.05, n)) } : {});
		} else {
			const n = Number(scaleBy);
			onConfirm(Number.isFinite(n) && n > 0 ? { scaleBy: n } : {});
		}
	};

	return (
		<div className="inpaint-modal" role="dialog" aria-modal="true" aria-labelledby="draw-enhance-title">
			<div className="inpaint-dialog draw-enhance-dialog">
				<h3 id="draw-enhance-title">{op === "enhance" ? "增强自定义" : "放大自定义"}</h3>
				<p className="inpaint-hint">
					{op === "enhance" ? "增强细节强度（0.05–1.0，默认 0.15）" : "放大倍数（1.5–4，默认 2）"}
				</p>
				{op === "enhance" ? (
					<Field label="strength（强度）">
						<input
							className="panel-search num"
							type="number"
							min={0.05}
							max={1}
							step={0.05}
							value={strength}
							onChange={(e) => setStrength(e.target.value)}
						/>
					</Field>
				) : (
					<Field label="scaleBy（放大倍数）">
						<input
							className="panel-search num"
							type="number"
							min={1.5}
							max={4}
							step={0.5}
							value={scaleBy}
							onChange={(e) => setScaleBy(e.target.value)}
						/>
					</Field>
				)}
				{error && (
					<p className="draw-enhance-error" role="alert">
						生成失败：{error}
					</p>
				)}
				<div className="panel-row inpaint-actions">
					<button type="button" className="drawer-btn" disabled={busy} onClick={onCancel}>
						取消
					</button>
					<button type="button" className={`drawer-btn save-btn${busy ? " btn-spin" : ""}`} disabled={busy} onClick={confirm}>
						{busy ? "生成中…" : "确定"}
					</button>
				</div>
			</div>
		</div>
	);
}

export function GallerySection() {
	const media = usePanelData(() => apiGet<UploadsResponse>("/api/uploads"), { watchAgent: true, cacheKey: "/api/uploads" });
	const slots = usePanelData(() => apiGet<DrawSlotsResponse>("/api/draw/slots"), { watchAgent: true, cacheKey: "/api/draw/slots" });
	const [lightbox, setLightbox] = useState<LightboxState | null>(null);
	const [busy, setBusy] = useState(false);
	/** 本地预览选中版本（数组下标；null = 跟随服务端选中）；「使用此图」持久化 */
	const [selected, setSelected] = useState<{ slotId: string; versionIndex: number } | null>(null);
	/** 增强/放大参数弹窗的目标 */
	const [enhanceModal, setEnhanceModal] = useState<{ slotId: string; src: string; op: "enhance" | "upscale" } | null>(null);
	/** 增强/放大请求失败信息（弹窗内展示；成功或关闭时清空） */
	const [enhanceErr, setEnhanceErr] = useState<string | null>(null);
	/** 保存所有进度：{ 总量, 已完成 }；null = 不在进行中 */
	const [saveAll, setSaveAll] = useState<{ total: number; done: number } | null>(null);
	/** 瞬时提示（无全局 toast 通道时的轻量替代） */
	const [notice, setNotice] = useState<string | null>(null);
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flash = (msg: string) => {
		setNotice(msg);
		if (noticeTimer.current) clearTimeout(noticeTimer.current);
		noticeTimer.current = setTimeout(() => setNotice(null), 2600);
	};

	const galleryList = useMemo(
		() => (media.data?.media ?? []).filter((u) => toAttachmentView(u.file).image),
		[media.data],
	);

	/** 全部槽位当前显示 src（按 slot 顺序，非空才入列；本地出图分区不入列）——Lightbox 跨 slot 导航数据源 */
	const slotLightboxList = useMemo(
		() => slotGroupsToSrcs(slots.data?.slots ?? [], selected),
		[slots.data, selected],
	);

	/** 防重入：操作中禁用全部按钮；onError 供弹窗等调用方就地展示失败信息 */
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

	/** 点大图打开 Lightbox：定位该 slot 在当前 src 列表中的下标 */
	const openSlotLightbox = (shown: string) => {
		const i = slotLightboxList.indexOf(shown);
		setLightbox({ srcs: slotLightboxList, index: i >= 0 ? i : 0 });
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

	return (
		<section className="sp-section">
			<div className="sp-section-head">
				<h4>画廊（生图槽位 {slotGroups.length} · 本地出图 {galleryList.length}）</h4>
				<div className="gallery-head-acts">
					<button
						type="button"
						className="drawer-btn"
						disabled={busy || slotGroups.filter((s) => !s.saved).length === 0}
						title="保存所有未保存的槽位"
						onClick={() => void saveAllSlots()}
					>
						保存所有
					</button>
					<ConfirmButton
						className="drawer-btn"
						disabled={busy || slotGroups.length === 0}
						confirmText="确认删除全部图片？将从正文剥离占位符"
						title="删除全部生图槽位（含从正文剥离占位符）"
						onConfirm={() => void deleteAllSlots()}
					>
						删除所有
					</ConfirmButton>
					<button
						type="button"
						className="drawer-btn"
						onClick={() => {
							slots.reload();
							media.reload();
						}}
					>
						<IconRefresh size={13} /> 刷新
					</button>
				</div>
			</div>

			{/* 保存所有进度条（LWB saveAllGalleryImages 的 #nd-gallery-progress 对齐） */}
			{saveAll && (
				<div className="draw-gallery-progress" aria-label={`保存中 ${saveAll.done}/${saveAll.total}`}>
					<div
						className="draw-gallery-progress-fill"
						style={{ width: `${Math.round((saveAll.done / Math.max(1, saveAll.total)) * 100)}%` }}
					/>
					<span className="draw-gallery-progress-text">
						保存中 {saveAll.done}/{saveAll.total}
					</span>
				</div>
			)}

			{/* ── ① 生图槽位（插件 D 版本网格） ── */}
			<div className="field-hint">
				生图槽位：占位符 `[image:slotId]` 关联的图；版本行带「当前」标记（服务端选中），点击缩略图预览大图，「使用此图」把预览版本持久化为当前显示版本。
			</div>
			<PanelStatus loading={slots.loading} error={slots.error} hasData={!!slots.data} />
			{slots.data && slotGroups.length === 0 && <div className="sp-empty">还没有生图槽位。在对话里让 AI 配图后，会出现在这里。</div>}
			{slotGroups.length > 0 && (
				<div className="upload-grid">
					{slotGroups.map((s) => (
						<div key={s.slotId} className="upload-cell">
							{/* 大图：服务端选中版本 / 本地预览；点击 → Lightbox（跨 slot 导航） */}
							{(() => {
								const shown = slotShownSrc(s, selected);
								return shown ? (
									<button
										type="button"
										className="upload-cell-btn"
										onClick={() => openSlotLightbox(shown)}
										title={`${s.slotId}${s.saved ? "" : "（未保存）"} · 点击放大`}
									>
										<img src={shown} alt={s.slotId} loading="lazy" />
									</button>
								) : (
									<div className="draw-slot draw-slot-gone">[已清理]</div>
								);
							})()}
							<div className="upload-cell-name" title={s.slotId}>
								{s.slotId.slice(0, 18)}
								{!s.saved && <span className="draw-slot-badge-inline">未保存</span>}
								{s.hasFailed && <span className="draw-slot-badge-failed">生成失败</span>}
							</div>
							{/* 版本行（discarded 弱化；selectedVersionIndex 标「当前」；点击预览，再点已预览版本取消预览） */}
							{s.versions.length > 0 && (
								<div className="upload-ver-row">
									{s.versions.map((v, i) => (
										<div
											key={i}
											className="upload-ver-cell"
											title={`版本 ${i + 1}${v.discarded ? "（已废弃）" : ""}${i === s.selectedVersionIndex ? "（当前）" : ""}`}
										>
											<button
												type="button"
												className={`upload-ver-thumb${v.discarded ? " is-discarded" : ""}${i === s.selectedVersionIndex ? " is-current" : ""}${selected && selected.slotId === s.slotId && selected.versionIndex === i ? " is-selected" : ""}`}
												onClick={() =>
													setSelected((prev) =>
														prev && prev.slotId === s.slotId && prev.versionIndex === i
															? null // 再点已预览版本 → 取消预览（跟随服务端选中）
															: { slotId: s.slotId, versionIndex: i },
													)
												}
											>
												<img src={v.src} alt={`v${i + 1}`} loading="lazy" />
											</button>
											{i === s.selectedVersionIndex && <span className="upload-ver-current-tag">当前</span>}
										</div>
									))}
								</div>
							)}
							{/* 预览了非服务端选中版本时：提供「使用此图」持久化 */}
							{selected &&
								selected.slotId === s.slotId &&
								selected.versionIndex !== s.selectedVersionIndex && (
									<div className="panel-row">
										<button
											type="button"
											className="act"
											disabled={busy}
											title="把预览版本设为当前显示版本（POST /api/draw/slots/select）"
											onClick={() =>
												void run(async () => {
													await apiPost("/api/draw/slots/select", {
														slotId: s.slotId,
														versionIndex: selected.versionIndex,
													});
													setSelected(null);
													slots.reload();
													flash("已设为当前显示版本");
												})
											}
										>
											使用此图
										</button>
									</div>
								)}
							{/* 操作：保存（未保存时）/ 增强 / 放大 / 删除（组删除） */}
							<div className="upload-cell-acts">
								{!s.saved && (
									<button
										type="button"
										className="act"
										disabled={busy}
										title="保存当前显示版本到图库"
										onClick={() =>
											void run(async () => {
												await apiPost("/api/draw/slots/save", { slotId: s.slotId });
												slots.reload();
											})
										}
									>
										保存
									</button>
								)}
								<button
									type="button"
									className="act"
									disabled={busy}
									title="增强自定义（参数弹窗）"
									onClick={() => {
										const shown = slotShownSrc(s, selected);
										if (shown) {
											setEnhanceErr(null);
											setEnhanceModal({ slotId: s.slotId, src: shown, op: "enhance" });
										}
									}}
								>
									增强
								</button>
								<button
									type="button"
									className="act"
									disabled={busy}
									title="放大自定义（参数弹窗）"
									onClick={() => {
										const shown = slotShownSrc(s, selected);
										if (shown) {
											setEnhanceErr(null);
											setEnhanceModal({ slotId: s.slotId, src: shown, op: "upscale" });
										}
									}}
								>
									放大
								</button>
								<ConfirmButton
									className="act"
									disabled={busy}
									confirmText="确认删除"
									title="删除整个槽位"
									onConfirm={() =>
										void run(async () => {
											await apiDelete(`/api/draw/slots?slotId=${encodeURIComponent(s.slotId)}`);
											slots.reload();
										})
									}
								>
									删除
								</ConfirmButton>
							</div>
						</div>
					))}
				</div>
			)}

			{/* ── ② 本地出图（/api/uploads 媒体库，既有网格；Lightbox 单图） ── */}
			<div className="field-hint" style={{ marginTop: 12 }}>
				本地出图（.liyuan-media/）：AI 展示/保存后落盘的图片。
			</div>
			<PanelStatus loading={media.loading} error={media.error} hasData={!!media.data} />
			{media.data && galleryList.length === 0 && <div className="sp-empty">还没有本地出图。</div>}
			{galleryList.length > 0 && (
				<div className="upload-grid">
					{galleryList.map((u) => {
						const view = toAttachmentView(u.file);
						const src = attachmentUrl(view);
						return (
							<div key={u.file} className="upload-cell">
								<button
									type="button"
									className="upload-cell-btn"
									onClick={() => setLightbox({ srcs: [src], index: 0 })}
									title="点击放大"
								>
									<img src={src} alt={view.label} loading="lazy" />
								</button>
								<div className="upload-cell-name" title={u.file}>
									{view.label}
								</div>
							</div>
						);
					})}
				</div>
			)}

			{/* 增强/放大参数弹窗 */}
			{enhanceModal && (
				<DrawEnhanceModal
					op={enhanceModal.op}
					busy={busy}
					error={enhanceErr}
					onCancel={() => {
						setEnhanceModal(null);
						setEnhanceErr(null);
					}}
					onConfirm={(params) =>
						void run(
							async () => {
								await apiPost("/api/draw/enhance", {
									source: enhanceModal.src,
									op: enhanceModal.op,
									...params,
									slotId: enhanceModal.slotId,
								});
								setEnhanceErr(null);
								setEnhanceModal(null);
								slots.reload();
								flash(enhanceModal.op === "enhance" ? "增强完成" : "放大完成");
							},
							(e) => setEnhanceErr(e instanceof Error ? e.message : String(e)),
						)
					}
				/>
			)}

			{/* Lightbox：跨 slot 导航（« n/total »），边界禁用；本地出图单图不显示导航 */}
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
		</section>
	);
}

/** 由 slot 列表提取全部当前显示 src（非空入列，保持 slot 顺序） */
function slotGroupsToSrcs(
	slots: SlotSummaryView[],
	preview: { slotId: string; versionIndex: number } | null,
): string[] {
	const out: string[] = [];
	for (const s of slots) {
		const src = slotShownSrc(s, preview);
		if (src) out.push(src);
	}
	return out;
}
