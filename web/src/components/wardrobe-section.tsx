/**
 * 服装管理区（自 DrawPanel 抽离，供插件层挂载，底座面板暂不渲染）。
 * 功能与 DrawPanel 原「② 服装管理」完全一致：当前卡角色的外观 tag 与服装档案、当前穿着（状态层）。
 * props 保持原有签名：toast / charName / worldState。
 */

import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiPut } from "../api.ts";
import type { WorldState } from "../wire.ts";
import { IconClose, IconPlus, IconTrash, IconUploads } from "./icons.tsx";
import { ConfirmButton, Field, PanelStatus, Toggle, useAction, usePanelData } from "./kit.tsx";

// ---------- 类型（字段与 src/wardrobe.ts 一致） ----------

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
	/** 批次 3 字段扩展（LWB {aliases[], type, negativeTags, danbooruTag, useDanbooruTag, hidden, selectedGroupId, id} 对齐） */
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
	format: "liyuan-wardrobe";
	version: 1;
	cardPath: string;
	characters: WardrobeCharacter[];
}

interface WardrobeResponse {
	ok: boolean;
	card: string;
	wardrobe: WardrobeFile;
}

/** 角色特征新增字段的本地草稿（aliases 用逗号分隔字符串编辑，保存时拆分数组） */
interface CharMetaDraft {
	aliases: string;
	type: string;
	negativeTags: string;
	danbooruTag: string;
	useDanbooruTag: boolean;
	hidden: boolean;
	selectedGroupId: string;
}

const emptyCharDraft = (): CharMetaDraft => ({
	aliases: "",
	type: "",
	negativeTags: "",
	danbooruTag: "",
	useDanbooruTag: false,
	hidden: false,
	selectedGroupId: "",
});

/** 角色档案 → 草稿（首次见到角色时用现值初始化） */
const charDraftFrom = (c: WardrobeCharacter): CharMetaDraft => ({
	aliases: (c.aliases ?? []).join(", "),
	type: c.type ?? "",
	negativeTags: c.negativeTags ?? "",
	danbooruTag: c.danbooruTag ?? "",
	useDanbooruTag: c.useDanbooruTag ?? false,
	hidden: c.hidden ?? false,
	selectedGroupId: c.selectedGroupId ?? "",
});

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function WardrobeSection({
	toast,
	charName,
	worldState,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	charName?: string;
	worldState?: WorldState | null;
}) {
	const { busy, run } = useAction(toast);
	const wardrobe = usePanelData(() => apiGet<WardrobeResponse>("/api/wardrobe"), { cacheKey: "/api/wardrobe" });
	/** 标签组（角色卡 selectedGroupId 下拉数据源：characterId === 该角色名的组） */
	const tagGroups = usePanelData(
		() => apiGet<{ ok: boolean; groups: { id: string; name: string; characterId?: string }[] }>("/api/draw/tag-groups"),
		{ cacheKey: "/api/draw/tag-groups" },
	);
	const [appearanceDrafts, setAppearanceDrafts] = useState<Record<string, string>>({});
	const [outfitDrafts, setOutfitDrafts] = useState<Record<string, { name: string; tags: string }>>({});
	/** 角色特征新增字段草稿（首次见到角色用现值初始化） */
	const [charDrafts, setCharDrafts] = useState<Record<string, CharMetaDraft>>({});
	const [newChar, setNewChar] = useState("");
	/** 当前穿着（outfit id）：本地点击覆盖 + worldState 同步；null = 已清除 */
	const [wornMap, setWornMap] = useState<Record<string, string | null>>({});
	const [lightbox, setLightbox] = useState<string | null>(null);
	const [refUploading, setRefUploading] = useState(false);
	/** 后端不托管 .liyuan-wardrobe/refs/ 静态文件：本地上传后用 object URL 缓存做缩略图预览 */
	const refBlobCache = useRef(new Map<string, string>());
	const refTarget = useRef<{ c: WardrobeCharacter; o: WardrobeOutfit } | null>(null);
	const refInputRef = useRef<HTMLInputElement>(null);

	// 服装草稿：首次见到角色/服装时以其当前值初始化（表单改动只在用户输入时覆盖）
	useEffect(() => {
		const wb = wardrobe.data?.wardrobe;
		if (!wb) return;
		setAppearanceDrafts((m) => {
			const next = { ...m };
			for (const c of wb.characters) if (next[c.name] === undefined) next[c.name] = c.appearanceTags;
			return next;
		});
		setOutfitDrafts((m) => {
			const next = { ...m };
			for (const c of wb.characters)
				for (const o of c.outfits)
					if (next[o.id] === undefined) next[o.id] = { name: o.name, tags: o.tags };
			return next;
		});
		setCharDrafts((m) => {
			const next = { ...m };
			for (const c of wb.characters) if (next[c.name] === undefined) next[c.name] = charDraftFrom(c);
			return next;
		});
	}, [wardrobe.data]);

	// 当前穿着：worldState（账本）里的 outfit 同步进来
	useEffect(() => {
		const next: Record<string, string> = {};
		for (const [name, c] of Object.entries(worldState?.characters ?? {})) {
			if (c && typeof c.outfit === "string" && c.outfit) next[name] = c.outfit;
		}
		if (Object.keys(next).length > 0) setWornMap((m) => ({ ...m, ...next }));
	}, [worldState]);

	// ---- 服装操作 ----

	const persistWardrobe = async (next: WardrobeFile) => {
		await apiPut("/api/wardrobe", next);
		wardrobe.reload();
	};

	const addCharacter = (name: string) =>
		run(async () => {
			const wb = wardrobe.data?.wardrobe;
			if (!wb) return;
			if (wb.characters.some((c) => c.name === name)) throw new Error(`角色「${name}」已在档案中`);
			await persistWardrobe({ ...wb, characters: [...wb.characters, { name, appearanceTags: "", outfits: [] }] });
			setNewChar("");
		}, `已建档「${name}」`);

	const deleteCharacter = (name: string) =>
		run(async () => {
			const wb = wardrobe.data?.wardrobe;
			if (!wb) return;
			await persistWardrobe({ ...wb, characters: wb.characters.filter((c) => c.name !== name) });
		}, `「${name}」已从档案删除`);

	/** 局部更新角色特征草稿（未初始化时用空草稿兜底） */
	const patchCharDraft = (name: string, patch: Partial<CharMetaDraft>) =>
		setCharDrafts((m) => ({ ...m, [name]: { ...(m[name] ?? emptyCharDraft()), ...patch } }));

	/** 保存角色特征（外观 tags + 别名/类型/负面/Danbooru tag/隐藏/选中标签组，整文件 PUT） */
	const saveCharacterFeatures = (c: WardrobeCharacter) =>
		run(async () => {
			const wb = wardrobe.data?.wardrobe;
			if (!wb) return;
			const d = charDrafts[c.name] ?? charDraftFrom(c);
			const tags = appearanceDrafts[c.name] ?? c.appearanceTags;
			const next: WardrobeCharacter = {
				...c,
				appearanceTags: tags,
				aliases: d.aliases.split(",").map((s) => s.trim()).filter(Boolean),
				type: d.type.trim(),
				negativeTags: d.negativeTags,
				danbooruTag: d.danbooruTag,
				useDanbooruTag: d.useDanbooruTag,
				hidden: d.hidden,
				selectedGroupId: d.selectedGroupId || undefined,
			};
			await persistWardrobe({ ...wb, characters: wb.characters.map((x) => (x.name === c.name ? next : x)) });
			setAppearanceDrafts((m) => ({ ...m, [c.name]: tags }));
			setCharDrafts((m) => ({ ...m, [c.name]: d }));
		}, `「${c.name}」角色特征已保存`);

	const saveOutfit = (c: WardrobeCharacter, o: WardrobeOutfit) =>
		run(async () => {
			const wb = wardrobe.data?.wardrobe;
			if (!wb) return;
			const draft = outfitDrafts[o.id] ?? { name: o.name, tags: o.tags };
			await persistWardrobe({
				...wb,
				characters: wb.characters.map((x) =>
					x.name === c.name
						? { ...x, outfits: x.outfits.map((y) => (y.id === o.id ? { ...y, name: draft.name, tags: draft.tags } : y)) }
						: x,
				),
			});
			setOutfitDrafts((m) => ({ ...m, [o.id]: draft }));
		}, "服装已保存");

	const addOutfit = (c: WardrobeCharacter) =>
		run(async () => {
			const wb = wardrobe.data?.wardrobe;
			if (!wb) return;
			await persistWardrobe({
				...wb,
				characters: wb.characters.map((x) =>
					x.name === c.name ? { ...x, outfits: [...x.outfits, { id: newId(), name: "新服装", tags: "" }] } : x,
				),
			});
		}, "已添加服装");

	const deleteOutfit = (c: WardrobeCharacter, oid: string) =>
		run(async () => {
			const wb = wardrobe.data?.wardrobe;
			if (!wb) return;
			await persistWardrobe({
				...wb,
				characters: wb.characters.map((x) =>
					x.name === c.name ? { ...x, outfits: x.outfits.filter((y) => y.id !== oid) } : x,
				),
			});
		}, "服装已删除");

	const setCurrent = (name: string, outfitId: string | null) =>
		run(async () => {
			await apiPost("/api/wardrobe/current", { character: name, outfitId });
			setWornMap((m) => ({ ...m, [name]: outfitId }));
		}, outfitId ? `「${name}」已设为当前穿着` : `「${name}」已清除当前穿着`);

	/** 参考图上传：POST 原始字节到 /api/wardrobe/ref（与 PersonaPanel 头像上传同款） */
	const uploadRef = async (file: File, c: WardrobeCharacter, o: WardrobeOutfit) => {
		const card = wardrobe.data?.card ?? "";
		setRefUploading(true);
		try {
			const res = await fetch(`/api/wardrobe/ref?card=${encodeURIComponent(card)}&name=${encodeURIComponent(file.name)}`, {
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: file,
			});
			const data = (await res.json().catch(() => ({}))) as { error?: string; path?: string };
			if (!res.ok || data.error) throw new Error(data.error || `上传失败（HTTP ${res.status}）`);
			if (!data.path) throw new Error("上传未返回路径");
			refBlobCache.current.set(data.path, URL.createObjectURL(file));
			const wb = wardrobe.data?.wardrobe;
			if (wb) {
				await persistWardrobe({
					...wb,
					characters: wb.characters.map((x) =>
						x.name === c.name
							? { ...x, outfits: x.outfits.map((y) => (y.id === o.id ? { ...y, referenceImage: data.path } : y)) }
							: x,
					),
				});
			}
			toast("info", "参考图已上传");
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setRefUploading(false);
		}
	};

	return (
		<section className="sp-section">
			<div className="sp-section-head">
				<h4>服装管理（{wardrobe.data?.wardrobe.characters.length ?? 0} 角色）</h4>
			</div>
			<div className="field-hint">
				按当前角色卡保存档案：{wardrobe.data?.card || "（读取中…）"}。设「当前穿着」写入本会话状态，随世界线回档。
				角色卡可维护别名/类型/负面 tag/Danbooru tag/隐藏/选中标签组（批次 3 扩展），「保存角色特征」整角色提交。
			</div>
			<PanelStatus loading={wardrobe.loading} error={wardrobe.error} hasData={!!wardrobe.data} />
			{wardrobe.data && (
				<>
					{charName && !wardrobe.data.wardrobe.characters.some((c) => c.name === charName) && (
						<button type="button" className="drawer-btn dp-char-add" disabled={busy} onClick={() => void addCharacter(charName)}>
							<IconPlus size={13} /> 建档当前角色「{charName}」
						</button>
					)}
					<div className="char-add-row">
						<input
							className="panel-search"
							value={newChar}
							onChange={(e) => setNewChar(e.target.value)}
							placeholder="新建角色名…"
						/>
						<button
							type="button"
							className="drawer-btn"
							disabled={busy || !newChar.trim()}
							onClick={() => void addCharacter(newChar.trim())}
						>
							新建角色
						</button>
					</div>
					{wardrobe.data.wardrobe.characters.length === 0 && (
						<div className="sp-empty">还没有建档角色。输入角色名新建，或点上方按钮建档当前角色。</div>
					)}
					{wardrobe.data.wardrobe.characters.map((c) => {
						const wornId = wornMap[c.name] !== undefined ? wornMap[c.name] : c.outfits[0]?.id ?? null;
						// 角色卡「选中标签组」下拉：绑定该角色的组；当前选中组不在列表时补入保证回显
						const charSelectableGroups = (() => {
							const bound = (tagGroups.data?.groups ?? []).filter((g) => g.characterId === c.name);
							const cur = charDrafts[c.name]?.selectedGroupId ?? "";
							if (!cur) return bound;
							return bound.some((g) => g.id === cur)
								? bound
								: [...bound, ...(tagGroups.data?.groups ?? []).filter((g) => g.id === cur)];
						})();
						return (
							<div key={c.name} className="char-card">
								<div className="char-card-head">
									<span className="char-card-name">{c.name}</span>
									<span className="lore-meta">{c.outfits.length} 套服装</span>
									<ConfirmButton
										className="act"
										disabled={busy}
										confirmText="确认删除"
										title="删除角色"
										onConfirm={() => void deleteCharacter(c.name)}
									>
										<IconTrash size={12} />
									</ConfirmButton>
								</div>
								<Field label="基础外观 tags（发型/瞳色/体型，生图时并入）">
									<textarea
										className="panel-search ta"
										rows={2}
										value={appearanceDrafts[c.name] ?? c.appearanceTags}
										onChange={(e) => setAppearanceDrafts((m) => ({ ...m, [c.name]: e.target.value }))}
									/>
								</Field>
								{/* 批次 3：角色特征扩展字段（草稿模式，保存角色特征时整角色提交） */}
								<div className="char-features">
									<Field label="别名 aliases（逗号分隔，参与在场角色检出）">
										<input
											className="panel-search"
											value={charDrafts[c.name]?.aliases ?? ""}
											onChange={(e) => patchCharDraft(c.name, { aliases: e.target.value })}
											placeholder="别名，逗号分隔"
										/>
									</Field>
									<Field label="类型 type（短文本）">
										<input
											className="panel-search"
											value={charDrafts[c.name]?.type ?? ""}
											onChange={(e) => patchCharDraft(c.name, { type: e.target.value })}
											placeholder="如：人类 / 精灵 / 恶魔"
										/>
									</Field>
									<Field label="负面 tag negativeTags（生图时并入整图负面）">
										<textarea
											className="panel-search ta"
											rows={1}
											value={charDrafts[c.name]?.negativeTags ?? ""}
											onChange={(e) => patchCharDraft(c.name, { negativeTags: e.target.value })}
											placeholder="如：extra fingers, deformed hands"
										/>
									</Field>
									<Field label="Danbooru tag danbooruTag（角色库查询用）">
										<input
											className="panel-search"
											value={charDrafts[c.name]?.danbooruTag ?? ""}
											onChange={(e) => patchCharDraft(c.name, { danbooruTag: e.target.value })}
											placeholder="如：hatsune_miku"
										/>
									</Field>
									<div className="draw-toggle-row">
										<span>生图时并入 Danbooru tag（useDanbooruTag）</span>
										<Toggle
											checked={charDrafts[c.name]?.useDanbooruTag ?? false}
											onChange={(v) => patchCharDraft(c.name, { useDanbooruTag: v })}
											title="开启后生图时把 danbooruTag 并入角色 tag"
										/>
									</div>
									<div className="draw-toggle-row">
										<span>隐藏（不参与在场角色检出）</span>
										<Toggle
											checked={charDrafts[c.name]?.hidden ?? false}
											onChange={(v) => patchCharDraft(c.name, { hidden: v })}
											title="开启后管线在场检出将忽略该角色"
										/>
									</div>
									<Field label="选中标签组 selectedGroupId（生图时默认追加该组 tag）">
										<select
											className="panel-search"
											value={charDrafts[c.name]?.selectedGroupId ?? ""}
											onChange={(e) => patchCharDraft(c.name, { selectedGroupId: e.target.value })}
										>
											<option value="">（不选）</option>
											{charSelectableGroups.map((g) => (
												<option key={g.id} value={g.id}>
													{g.name}
												</option>
											))}
										</select>
									</Field>
								</div>
								<div className="panel-row">
									<button
										type="button"
										className="drawer-btn save-btn"
										disabled={busy}
										onClick={() => void saveCharacterFeatures(c)}
									>
										保存角色特征
									</button>
									<button type="button" className="drawer-btn" disabled={busy} onClick={() => void setCurrent(c.name, null)}>
										清除当前穿着
									</button>
								</div>
								<div className="outfit-list">
									{c.outfits.map((o) => {
										const isCurrent = o.id === wornId;
										const rurl = o.referenceImage ? refBlobCache.current.get(o.referenceImage) ?? null : null;
										return (
											<div key={o.id} className={`outfit-card ${isCurrent ? "current" : ""}`}>
												<div className="outfit-head">
													<span className="outfit-name">{o.name}</span>
													{isCurrent && <span className="chip chip-cap">当前穿着</span>}
													<div className="outfit-acts">
														<button type="button" className="act" disabled={busy} onClick={() => void setCurrent(c.name, o.id)}>
															设为当前穿着
														</button>
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
												</div>
												<div className="outfit-body">
													<div className="outfit-ref">
														{rurl ? (
															<img className="ref-thumb" src={rurl} alt={o.name} title="点击放大" onClick={() => setLightbox(rurl)} />
														) : (
															<div className="ref-thumb ref-thumb-empty" title="暂无参考图">
																参考图
															</div>
														)}
														<button
															type="button"
															className="drawer-btn"
															disabled={refUploading}
															onClick={() => {
																refTarget.current = { c, o };
																refInputRef.current?.click();
															}}
														>
															<IconUploads size={13} /> {refUploading ? "上传中…" : "上传参考图"}
														</button>
													</div>
													<Field label="名称">
														<input
															className="panel-search"
															value={outfitDrafts[o.id]?.name ?? o.name}
															onChange={(e) =>
																setOutfitDrafts((m) => ({ ...m, [o.id]: { name: e.target.value, tags: m[o.id]?.tags ?? o.tags } }))
															}
														/>
													</Field>
													<Field label="tags（空格分隔，可带 n::tag:: 权重）">
														<textarea
															className="panel-search ta"
															rows={2}
															value={outfitDrafts[o.id]?.tags ?? o.tags}
															onChange={(e) =>
																setOutfitDrafts((m) => ({ ...m, [o.id]: { name: m[o.id]?.name ?? o.name, tags: e.target.value } }))
															}
														/>
													</Field>
													<div className="panel-row">
														<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={() => void saveOutfit(c, o)}>
															保存服装
														</button>
													</div>
												</div>
											</div>
										);
									})}
									<button type="button" className="drawer-btn" disabled={busy} onClick={() => void addOutfit(c)}>
										<IconPlus size={13} /> 添加服装
									</button>
								</div>
							</div>
						);
					})}
				</>
			)}

			<input
				ref={refInputRef}
				type="file"
				accept="image/*"
				hidden
				onChange={(e) => {
					const file = e.target.files?.[0];
					const t = refTarget.current;
					if (file && t) void uploadRef(file, t.c, t.o);
					e.target.value = "";
				}}
			/>

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
					<img src={lightbox} alt="预览" />
				</div>
			)}
		</section>
	);
}
