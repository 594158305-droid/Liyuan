/**
 * 占位符图片组件（插件 C draw-slot + 插件 D draw-edit）：
 * 消息正文里的 `[image:slotId]` 渲染为实际图片 + 悬浮操作条 + 版本导航胶囊。
 *
 * LWB 黑盒对齐（批次 1）：
 * - 版本导航胶囊 ‹ n/total ›：n 0=最新（LWB currentIndex 语义；versions 数组 0=最旧，
 *   显示 n = versions.length-1-arrayIndex）；‹/› 本地切换显示 + POST /api/draw/slots/select 持久化
 * - 编辑 TAG 分栏弹窗（🎬场景 + 👤每角色）：PUT /api/draw/slots/tags 保存不重绘
 * - 「保存」保存当前显示版：POST /api/draw/slots/save {slotId, versionIndex}
 *
 * LWB 黑盒对齐（批次 2）：
 * - 失败态（info.failed / hasFailed）：⚠ 生成失败 + 「保存并重试」（POST /api/draw/slots/retry）
 * - busy 蒙层 + 转圈：.draw-slot-busy-overlay（蒙住图片区域，不只在操作条）
 * - AI 微调弹窗：指令输入 + 提示词分解预览 + 生成（POST /api/draw/refine）→ 结果可编辑
 *   →「应用」PUT /api/draw/slots/tags 保存不重绘 /「复制」剪贴板
 *
 * 渲染：
 * - 已保存（saved=true）→ ZoomImg(src=/media/...)（无「未保存」徽标）
 * - 未保存（saved=false，映射存在）→ 同 ZoomImg(src=/cache/...) + 右上角小徽标「未保存」
 * - 失败态（failed/hasFailed）→ ⚠ 生成失败 + 保存并重试
 * - 映射不存在/已清理（getSlotInfo 返回 null）→ 灰底占位「[图片已清理]」
 *
 * 操作条（hover 时右上角显示）：
 * - 保存（仅未保存，保存当前显示版本）：POST /api/draw/slots/save
 * - 删除：DELETE /api/draw/slots?slotId=（二次确认）
 * - 重新生成：调 POST /api/draw/enhance {source, op:"redraw", slotId}
 * - 增强 / 放大 / 局部重绘：POST /api/draw/enhance（作用于当前显示版本）
 * - 编辑TAG：分栏弹窗 → PUT /api/draw/slots/tags（保存不重绘）
 * - AI 微调：弹窗（指令 → refine → 应用/复制；保存不重绘）
 */

import { useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.ts";
import { ZoomImg } from "./Messages.tsx";
import { InpaintModal } from "./InpaintModal.tsx";
import { ConfirmButton } from "./kit.tsx";
import { IconRefresh } from "./icons.tsx";

/** 版本 tag（LWB 编辑 TAG 的数据源：场景 + 每角色 tag，保存不重绘） */
export interface DrawSlotTagCharacter {
	name?: string;
	prompt?: string;
}

/** 版本 tag 结构（场景 / 每角色 / 正向质量前缀 / 负面；AI 微调分解预览也用） */
export interface DrawSlotTags {
	scene?: string;
	characterPrompts?: DrawSlotTagCharacter[];
	positive?: string;
	negative?: string;
}

/** GET /api/draw/slots?slotId= 返回（扩展契约：versions + selectedVersionIndex + tags + failed/hasFailed） */
export interface DrawSlotVersionView {
	file?: string;
	src: string;
	saved: boolean;
	discarded: boolean;
	/** 版本 tag（编辑 TAG 弹窗预填数据源 / AI 微调分解预览） */
	tags?: DrawSlotTags;
	/** 版本级失败记录（失败态渲染） */
	failed?: { code?: string; reason?: string };
}

export interface DrawSlotInfo {
	slotId: string;
	saved: boolean;
	/** 当前版本文件 URL（/cache/ 或 /media/ 前缀） */
	src: string;
	versionCount: number;
	createdAt: number;
	/** 选中版本数组下标（缺省 undefined = 最新非 discarded） */
	selectedVersionIndex?: number;
	/** 全部版本（数组下标 0 = 最旧） */
	versions?: DrawSlotVersionView[];
	/** slot 级失败记录（LWB storeFailedPlaceholder） */
	failed?: { code?: string; reason?: string };
	/** slot 是否有失败版本（src 为空但 hasFailed 时也按失败态渲染） */
	hasFailed?: boolean;
}

/** 有效版本（非 discarded 且有 src），保留原数组下标（0=最旧） */
function validVersions(info: DrawSlotInfo): { index: number; view: DrawSlotVersionView }[] {
	return (info.versions ?? []).map((view, index) => ({ index, view })).filter((x) => !x.view.discarded && !!x.view.src);
}

/** 显示位置换算：LWB currentIndex 0=最新 → 显示 n = versions.length-1 - arrayIndex */
function displayIndex(info: DrawSlotInfo, arrayIndex: number): number {
	return (info.versions?.length ?? 0) - 1 - arrayIndex;
}

/**
 * 编辑 TAG 分栏弹窗（LWB 对齐）：🎬场景 textarea + 👤每角色 textarea。
 * 预填：scene ← tags.scene（无则回退 tags.positive）；角色 ← characterPrompts[i].prompt。
 * 保存走 PUT /api/draw/slots/tags——只保存 tags 不重绘；scene 为空阻止保存。
 */
function TagEditPanelModal({
	slotId,
	versionIndex,
	tags,
	busy,
	onCancel,
	onSaved,
}: {
	slotId: string;
	versionIndex: number;
	tags?: DrawSlotTags;
	busy: boolean;
	onCancel: () => void;
	onSaved: (msg: string) => void;
}) {
	const [scene, setScene] = useState(tags?.scene ?? tags?.positive ?? "");
	const chars = (tags?.characterPrompts ?? []).filter((c) => typeof c?.name === "string" && c.name);
	const [roles, setRoles] = useState<{ name: string; prompt: string }[]>(
		chars.map((c) => ({ name: c.name ?? "", prompt: c.prompt ?? "" })),
	);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState("");

	const save = async () => {
		if (!scene.trim()) {
			setErr("场景 TAG 不能为空");
			return;
		}
		setSaving(true);
		setErr("");
		try {
			await apiPut("/api/draw/slots/tags", {
				slotId,
				versionIndex,
				scene: scene.trim(),
				characterPrompts: roles.map((r) => ({ name: r.name, prompt: r.prompt.trim() })),
			});
			onSaved(`TAG 已保存（场景 + ${roles.length} 个角色）`);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="inpaint-modal" role="dialog" aria-modal="true" aria-labelledby="draw-tag-edit-title">
			<div className="inpaint-dialog draw-tag-edit-dialog">
				<h3 id="draw-tag-edit-title">编辑 TAG</h3>
				<p className="inpaint-hint">分栏编辑场景与各角色 tag，保存到该版本（不重新生成）</p>
				<label className="draw-tag-edit-field">
					<span className="draw-tag-edit-label">🎬 场景</span>
					<textarea
						className="draw-tag-edit-textarea"
						value={scene}
						onChange={(e) => setScene(e.target.value)}
						disabled={saving || busy}
						placeholder="画面描述 / Danbooru tag…"
						rows={6}
					/>
				</label>
				{roles.map((r, i) => (
					<label key={i} className="draw-tag-edit-field">
						<span className="draw-tag-edit-label">
							👤 {r.name || `角色 ${i + 1}`}
							<button
								type="button"
								className="draw-tag-edit-del"
								disabled={saving || busy}
								onClick={() => setRoles((prev) => prev.filter((_, j) => j !== i))}
								title="删除该角色"
							>
								×
							</button>
						</span>
						<textarea
							className="draw-tag-edit-textarea draw-tag-edit-role-ta"
							value={r.prompt}
							onChange={(e) =>
								setRoles((prev) => prev.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)))
							}
							disabled={saving || busy}
							placeholder="角色 tag…"
							rows={3}
						/>
					</label>
				))}
				<button
					type="button"
					className="drawer-btn draw-tag-add-role"
					disabled={saving || busy}
					onClick={() => setRoles((prev) => [...prev, { name: `角色 ${prev.length + 1}`, prompt: "" }])}
				>
					＋ 添加角色
				</button>
				{err && <div className="draw-tag-edit-err">{err}</div>}
				<div className="panel-row inpaint-actions">
					<button type="button" className="drawer-btn" disabled={saving || busy} onClick={onCancel}>
						取消
					</button>
					<button type="button" className="drawer-btn save-btn" disabled={saving || busy} onClick={() => void save()}>
						{saving ? "保存中…" : "保存"}
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * AI 微调弹窗（LWB 批次 2.3 对齐，替代旧「改写→重生成」）：
 * - 打开时已由父组件取到当前显示版本 tags（scene/characterPrompts/positive）→ 本地分解预览五段只读
 * - 指令输入 → POST /api/draw/refine（不再自动重生成）→ 显示 refined.scene（可编辑 textarea）
 * - 「应用」→ PUT /api/draw/slots/tags 保存不重绘（scene 用编辑后值，角色沿用原 characterPrompts）
 * - 「复制」→ 剪贴板
 */
function AiRefineModal({
	slotId,
	versionIndex,
	tags,
	busy,
	onCancel,
	onFlash,
	onClose,
}: {
	slotId: string;
	versionIndex: number;
	tags?: DrawSlotTags;
	busy: boolean;
	onCancel: () => void;
	onFlash: (msg: string) => void;
	onClose: () => void;
}) {
	const [instruction, setInstruction] = useState("");
	const [running, setRunning] = useState(false);
	const [err, setErr] = useState("");
	const [result, setResult] = useState<string | null>(null);
	const [editing, setEditing] = useState("");

	const chars = (tags?.characterPrompts ?? []).filter((c) => typeof c?.name === "string" && c.name);
	const sceneView = tags?.scene ?? tags?.positive ?? "";
	const qualityPrefix = tags?.positive ?? "";
	const negative = tags?.negative ?? "";

	const generate = async () => {
		setRunning(true);
		setErr("");
		try {
			const r = await apiPost<{ ok: boolean; refined: { scene: string } }>("/api/draw/refine", {
				slotId,
				instruction: instruction.trim() || undefined,
			});
			const scene = r.refined?.scene ?? "";
			setResult(scene);
			setEditing(scene);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setRunning(false);
		}
	};

	const apply = async () => {
		setRunning(true);
		setErr("");
		try {
			await apiPut("/api/draw/slots/tags", {
				slotId,
				versionIndex,
				scene: editing.trim(),
				characterPrompts: chars.map((c) => ({ name: c.name, prompt: c.prompt })),
			});
			onFlash("已应用（未重绘）");
			onClose();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
			setRunning(false);
		}
	};

	const copy = async () => {
		if (!editing) return;
		try {
			await navigator.clipboard.writeText(editing);
			onFlash("已复制");
		} catch {
			onFlash("复制失败");
		}
	};

	return (
		<div className="inpaint-modal" role="dialog" aria-modal="true" aria-labelledby="draw-refine-title">
			<div className="inpaint-dialog draw-refine-dialog">
				<h3 id="draw-refine-title">AI 微调</h3>
				<p className="inpaint-hint">管线模型改写画面描述；「应用」保存到该版本但不重绘</p>
				{/* 当前提示词分解预览（五段只读；本地简化 decomposeTags 逻辑） */}
				<div className="draw-refine-preview">
					<div className="draw-refine-seg">
						<span className="draw-refine-seg-label">模式</span>
						<span className="draw-refine-seg-val">portrait（默认）</span>
					</div>
					<div className="draw-refine-seg">
						<span className="draw-refine-seg-label">质量前缀</span>
						<span className="draw-refine-seg-val">{qualityPrefix || "（空）"}</span>
					</div>
					<div className="draw-refine-seg">
						<span className="draw-refine-seg-label">场景</span>
						<span className="draw-refine-seg-val">{sceneView || "（空）"}</span>
					</div>
					<div className="draw-refine-seg">
						<span className="draw-refine-seg-label">角色</span>
						<span className="draw-refine-seg-val">{chars.length ? chars.map((c) => c.name).join("、") : "（无）"}</span>
					</div>
					<div className="draw-refine-seg">
						<span className="draw-refine-seg-label">负面</span>
						<span className="draw-refine-seg-val">{negative || "（空）"}</span>
					</div>
				</div>
				<label className="draw-refine-field">
					<span className="draw-refine-label">指令</span>
					<input
						className="panel-search"
						value={instruction}
						onChange={(e) => setInstruction(e.target.value)}
						disabled={running || busy}
						placeholder="输入微调指令，如：加强光影氛围…"
					/>
				</label>
				<div className="panel-row" style={{ marginBottom: 0 }}>
					<button type="button" className="drawer-btn" disabled={running || busy} onClick={() => void generate()}>
						{running ? "生成中…" : "生成"}
					</button>
				</div>
				{result !== null && (
					<label className="draw-refine-field">
						<span className="draw-refine-label">微调结果（可编辑）</span>
						<textarea
							className="panel-search ta draw-refine-ta"
							rows={6}
							value={editing}
							onChange={(e) => setEditing(e.target.value)}
							disabled={running || busy}
						/>
					</label>
				)}
				{err && <div className="draw-tag-edit-err">{err}</div>}
				<div className="panel-row inpaint-actions">
					<button type="button" className="drawer-btn" disabled={running || busy} onClick={onCancel}>
						取消
					</button>
					<button type="button" className="drawer-btn" disabled={running || busy || !result} onClick={() => void copy()}>
						复制
					</button>
					<button type="button" className="drawer-btn save-btn" disabled={running || busy || !result} onClick={() => void apply()}>
						应用
					</button>
				</div>
			</div>
		</div>
	);
}

export function DrawSlotImage({ slotId }: { slotId: string }) {
	const [info, setInfo] = useState<DrawSlotInfo | null | "loading">("loading");
	const [busy, setBusy] = useState(false);
	const [inpaintOpen, setInpaintOpen] = useState(false);
	const [tagEditOpen, setTagEditOpen] = useState(false);
	const [refineOpen, setRefineOpen] = useState(false);
	/** 本地显示版本数组下标（undefined = 跟随服务端 selectedVersionIndex / 最新非 discarded） */
	const [displayIdx, setDisplayIdx] = useState<number | undefined>(undefined);
	/** 瞬时提示（保存/选择成功等；无全局 toast 通道时的轻量替代） */
	const [notice, setNotice] = useState<string | null>(null);
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flash = (msg: string) => {
		setNotice(msg);
		if (noticeTimer.current) clearTimeout(noticeTimer.current);
		noticeTimer.current = setTimeout(() => setNotice(null), 2600);
	};

	const reload = () => {
		setInfo("loading");
		apiGet<DrawSlotInfo>(`/api/draw/slots?slotId=${encodeURIComponent(slotId)}`)
			.then((d) => {
				console.log("[draw-slot] 加载成功", slotId, d?.src);
				setInfo(d);
			})
			.catch((e) => {
				console.warn("[draw-slot] 加载失败", slotId, e instanceof Error ? e.message : String(e));
				setInfo(null);
			});
	};

	useEffect(() => {
		let alive = true;
		setInfo("loading");
		setDisplayIdx(undefined);
		apiGet<DrawSlotInfo>(`/api/draw/slots?slotId=${encodeURIComponent(slotId)}`)
			.then((d) => {
				console.log("[draw-slot] 挂载加载成功", slotId, d?.src);
				if (alive) setInfo(d);
			})
			.catch((e) => {
				console.warn("[draw-slot] 挂载加载失败", slotId, e instanceof Error ? e.message : String(e));
				if (alive) setInfo(null);
			});
		return () => {
			alive = false;
		};
	}, [slotId]);

	/** 防重入包装：操作中禁用全部按钮 */
	const run = async (fn: () => Promise<void>, doneText?: string) => {
		if (busy) return;
		setBusy(true);
		try {
			await fn();
			if (doneText) console.log(doneText);
		} catch (e) {
			console.error(e);
		} finally {
			setBusy(false);
		}
	};

	/** 失败版本「保存并重试」（LWB storeFailedPlaceholder + saveTagsAndRetry）：重新生成后刷新 */
	const retry = () =>
		run(async () => {
			await apiPost("/api/draw/slots/retry", { slotId });
			reload();
			flash("已重新生成");
		});

	if (info === "loading") {
		return <div className="draw-slot draw-slot-loading" />;
	}
	if (!info) {
		// 映射不存在 / 加载失败：灰底失效占位
		return <div className="draw-slot draw-slot-gone">[图片已清理]</div>;
	}
	if (info.failed || (!info.src && info.hasFailed)) {
		// 失败态（LWB storeFailedPlaceholder）：不显示图，给「保存并重试」
		const reason = info.failed?.reason || info.failed?.code || "未知错误";
		return (
			<span className="draw-slot-wrap">
				<div className="draw-slot draw-slot-failed">
					<span className="draw-slot-failed-msg">⚠ 生成失败：{reason}</span>
					<button type="button" className="act" disabled={busy} onClick={() => void retry()}>
						保存并重试
					</button>
				</div>
				{notice && <div className="draw-notice">{notice}</div>}
			</span>
		);
	}
	if (!info.src) {
		// 无 src 且非失败态：已清理占位
		return <div className="draw-slot draw-slot-gone">[图片已清理]</div>;
	}

	const valid = validVersions(info);
	/** 当前显示版本：本地选中优先 → 服务端 selectedVersionIndex → 最新非 discarded */
	const displayed = (() => {
		const idx = displayIdx ?? info.selectedVersionIndex;
		if (idx !== undefined) {
			const v = info.versions?.[idx];
			if (v && !v.discarded && v.src) return { index: idx, view: v };
		}
		const last = valid[valid.length - 1];
		return last ? { index: last.index, view: last.view } : null;
	})();
	const showSrc = displayed?.view.src ?? info.src;
	const total = valid.length;
	const navN = displayed ? displayIndex(info, displayed.index) : 0;

	/** 持久化选中版本（本地先切显示，POST select，再刷新 info 同步 selectedVersionIndex） */
	const selectVersion = (versionIndex: number) =>
		run(async () => {
			await apiPost("/api/draw/slots/select", { slotId, versionIndex });
			setDisplayIdx(versionIndex);
			reload();
		});

	/** 版本导航：dir=-1 更旧（n 增大），dir=1 更新（n 减小）；仅在有 ≥2 个有效版本时可用 */
	const stepVersion = (dir: -1 | 1) => {
		if (busy || !displayed || total < 2) return;
		const pos = valid.findIndex((x) => x.index === displayed.index);
		const target = valid[pos + dir];
		if (!target) return;
		void selectVersion(target.index);
	};

	const enhance = (op: "redraw" | "enhance" | "upscale" | "inpaint", extra: Record<string, unknown> = {}) =>
		run(async () => {
			// 作用于当前显示版本
			await apiPost("/api/draw/enhance", { source: showSrc, op, slotId, ...extra });
			setDisplayIdx(undefined); // 追加新版本 → 回到最新
			reload();
		});

	return (
		<span className="draw-slot-wrap">
			<ZoomImg src={showSrc} alt={`插图 ${slotId}`} title={`插图 ${slotId}`} />
			{/* busy 蒙层 + 转圈（批次 2.4：蒙住图片区域，不只在操作条） */}
			{busy && <span className="draw-slot-busy-overlay" />}
			{!info.saved && <span className="draw-slot-badge">未保存</span>}
			{/* 版本导航胶囊（LWB：n 0=最新；‹ 更旧 › 更新；点击同步 POST select 持久化） */}
			{total > 0 && (
				<span className="draw-ver-nav">
					<button
						type="button"
						className="act"
						disabled={busy || navN >= total - 1}
						title="上一个版本（更旧）"
						onClick={() => stepVersion(-1)}
					>
						‹
					</button>
					<span className="draw-ver-nav-idx">
						{navN}/{total}
					</span>
					<button
						type="button"
						className="act"
						disabled={busy || navN <= 0}
						title="下一个版本（更新）"
						onClick={() => stepVersion(1)}
					>
						›
					</button>
				</span>
			)}
			{/* 操作条：hover 显示（CSS .draw-slot-actions），busy 期间禁用 */}
			<span className="draw-slot-actions">
				{!info.saved && (
					<button
						type="button"
						className="act"
						disabled={busy}
						title={displayed ? "保存当前显示版本到图库" : "保存到图库"}
						onClick={() =>
							void run(async () => {
								// 有版本数据 → 保存当前显示版（LWB 语义）；无版本数据（后端未合入前）→ 不带 versionIndex 走默认
								await apiPost(
									"/api/draw/slots/save",
									displayed ? { slotId, versionIndex: displayed.index } : { slotId },
								);
								reload();
								flash("已保存当前显示版本");
							})
						}
					>
						保存
					</button>
				)}
				<ConfirmButton
					className="act"
					disabled={busy}
					confirmText="确认删除"
					title="删除"
					onConfirm={() =>
						void run(async () => {
							await apiDelete(`/api/draw/slots?slotId=${encodeURIComponent(slotId)}`);
							setInfo(null);
						})
					}
				>
					删除
				</ConfirmButton>
				<button type="button" className="act" disabled={busy} title="同图重绘（换 seed）" onClick={() => void enhance("redraw")}>
					<IconRefresh size={11} /> 重新生成
				</button>
				<button type="button" className="act" disabled={busy} title="增强细节" onClick={() => void enhance("enhance")}>
					增强
				</button>
				<button type="button" className="act" disabled={busy} title="放大 2x" onClick={() => void enhance("upscale")}>
					放大
				</button>
				<button type="button" className="act" disabled={busy} title="局部重绘" onClick={() => setInpaintOpen(true)}>
					局部重绘
				</button>
				<button
					type="button"
					className="act"
					disabled={busy || !displayed}
					title="分栏编辑场景与角色 tag（保存不重绘）"
					onClick={() => setTagEditOpen(true)}
				>
					编辑TAG
				</button>
				<button
					type="button"
					className="act"
					disabled={busy || !displayed}
					title="AI 微调：指令 → 管线改写场景 → 应用保存不重绘"
					onClick={() => setRefineOpen(true)}
				>
					AI微调
				</button>
			</span>

			{inpaintOpen && (
				<InpaintModal
					src={showSrc}
					busy={busy}
					onCancel={() => setInpaintOpen(false)}
					onConfirm={(maskBase64) => {
						void run(async () => {
							await apiPost("/api/draw/enhance", { source: showSrc, op: "inpaint", maskBase64, slotId });
							setInpaintOpen(false);
							setDisplayIdx(undefined);
							reload();
						});
					}}
				/>
			)}
			{tagEditOpen && displayed && (
				<TagEditPanelModal
					slotId={slotId}
					versionIndex={displayed.index}
					tags={displayed.view.tags}
					busy={busy}
					onCancel={() => setTagEditOpen(false)}
					onSaved={(msg) => {
						setTagEditOpen(false);
						flash(msg);
						reload();
					}}
				/>
			)}
			{refineOpen && displayed && (
				<AiRefineModal
					slotId={slotId}
					versionIndex={displayed.index}
					tags={displayed.view.tags}
					busy={busy}
					onCancel={() => setRefineOpen(false)}
					onFlash={(msg) => flash(msg)}
					onClose={() => setRefineOpen(false)}
				/>
			)}
			{notice && <div className="draw-notice">{notice}</div>}
		</span>
	);
}
