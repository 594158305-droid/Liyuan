/**
 * 绘画面板（生图系统 UI）：三段式
 * - API 管理：生图 provider 注册 / 测试连接 / 默认参数 / 参数预设 / autoConfirm
 * - 服装管理：当前卡角色的外观 tag 与服装档案、当前穿着（状态层）
 * - 画廊：.liyuan-media/ 出图网格 + 点击放大（简单 lightbox）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, type UploadsResponse } from "../api.ts";
import { attachmentUrl, toAttachmentView } from "../attachments.ts";
import type { WorldState } from "../wire.ts";
import { IconClose, IconEdit, IconPlus, IconRefresh, IconTrash, IconUploads } from "./icons.tsx";
import { ConfirmButton, Field, PanelStatus, Toggle, useAction, usePanelData } from "./kit.tsx";

// ---------- 类型（字段与 src/draw-config.ts、src/wardrobe.ts 一致） ----------

interface DrawParams {
	sampler: string;
	scheduler: string;
	steps: number;
	scale: number;
	width: number;
	height: number;
	negativePrompt: string;
	ucPreset: number;
	qualityToggle: boolean;
	autoSmea: boolean;
	cfgRescale: number;
	varietyBoost?: boolean;
}

interface DrawPreset {
	id: string;
	name: string;
	model: string;
	params: Partial<DrawParams>;
}

type DrawProviderType = "novelai" | "sd-webui" | "comfyui";

interface DrawProvider {
	id: string;
	type: DrawProviderType;
	name: string;
	apiKey: string;
	baseUrl: string;
	model: string;
	defaultParams: DrawParams;
	presets: DrawPreset[];
	enabled: boolean;
	autoConfirm: boolean;
}

interface DrawProvidersResponse {
	ok: boolean;
	config: { version: number; defaultProvider: string; autoConfirm: boolean };
	providers: DrawProvider[];
}

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
	defaultOutfit?: string;
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

// ---------- 常量 ----------

const SAMPLERS = [
	"k_euler_ancestral",
	"k_euler",
	"k_dpmpp_2m",
	"k_dpmpp_2m_sde",
	"k_dpmpp_2s_ancestral",
	"k_dpmpp_3m_sde",
	"k_heun",
	"ddpm",
];

const SCHEDULERS = ["karras", "native", "exponential"];

const TYPE_LABEL: Record<DrawProviderType, string> = {
	novelai: "NovelAI",
	"sd-webui": "SD WebUI",
	comfyui: "ComfyUI",
};

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const clampNum = (raw: string, min: number, max: number, fallback: number): number => {
	const n = Number(raw);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const clampInt = (raw: string, min: number, max: number, fallback: number): number =>
	Math.round(clampNum(raw, min, max, fallback));

/** 下拉选择（当前值不在候选里时追加，保证回显） */
function Sel({
	value,
	options,
	onChange,
}: {
	value: string;
	options: string[];
	onChange: (v: string) => void;
}) {
	const all = options.includes(value) ? options : [...options, value];
	return (
		<select className="panel-search" value={value} onChange={(e) => onChange(e.target.value)}>
			{all.map((o) => (
				<option key={o} value={o}>
					{o || "（未设置）"}
				</option>
			))}
		</select>
	);
}

// ---------- 默认参数编辑（完整 DrawParams） ----------

function ParamsFields({ value, onChange }: { value: DrawParams; onChange: (v: DrawParams) => void }) {
	return (
		<>
			<div className="draw-params-grid">
				<Field label="采样器">
					<Sel value={value.sampler} options={SAMPLERS} onChange={(sampler) => onChange({ ...value, sampler })} />
				</Field>
				<Field label="调度器">
					<Sel value={value.scheduler} options={SCHEDULERS} onChange={(scheduler) => onChange({ ...value, scheduler })} />
				</Field>
				<Field label="步数">
					<input
						className="panel-search num"
						type="number"
						min={1}
						max={100}
						value={value.steps}
						onChange={(e) => onChange({ ...value, steps: clampInt(e.target.value, 1, 100, 28) })}
					/>
				</Field>
				<Field label="CFG scale">
					<input
						className="panel-search num"
						type="number"
						min={1}
						max={30}
						step={0.5}
						value={value.scale}
						onChange={(e) => onChange({ ...value, scale: clampNum(e.target.value, 1, 30, 6) })}
					/>
				</Field>
				<Field label="宽">
					<input
						className="panel-search num"
						type="number"
						min={64}
						max={2048}
						step={64}
						value={value.width}
						onChange={(e) => onChange({ ...value, width: clampInt(e.target.value, 64, 2048, 1216) })}
					/>
				</Field>
				<Field label="高">
					<input
						className="panel-search num"
						type="number"
						min={64}
						max={2048}
						step={64}
						value={value.height}
						onChange={(e) => onChange({ ...value, height: clampInt(e.target.value, 64, 2048, 832) })}
					/>
				</Field>
				<Field label="uc 预设">
					<input
						className="panel-search num"
						type="number"
						min={0}
						max={10}
						value={value.ucPreset}
						onChange={(e) => onChange({ ...value, ucPreset: clampInt(e.target.value, 0, 10, 0) })}
					/>
				</Field>
				<Field label="cfg rescale">
					<input
						className="panel-search num"
						type="number"
						min={0}
						max={1}
						step={0.05}
						value={value.cfgRescale}
						onChange={(e) => onChange({ ...value, cfgRescale: clampNum(e.target.value, 0, 1, 0) })}
					/>
				</Field>
			</div>
			<Field label="负面提示词（整图 uc）">
				<textarea
					className="panel-search ta"
					rows={3}
					value={value.negativePrompt}
					onChange={(e) => onChange({ ...value, negativePrompt: e.target.value })}
				/>
			</Field>
			<div className="draw-toggle-row">
				<span>质量开关（V4.5 quality）</span>
				<Toggle checked={value.qualityToggle} onChange={(qualityToggle) => onChange({ ...value, qualityToggle })} />
			</div>
			<div className="draw-toggle-row">
				<span>autoSmea</span>
				<Toggle checked={value.autoSmea} onChange={(autoSmea) => onChange({ ...value, autoSmea })} />
			</div>
			<div className="draw-toggle-row">
				<span>variety_boost</span>
				<Toggle checked={value.varietyBoost ?? false} onChange={(varietyBoost) => onChange({ ...value, varietyBoost })} />
			</div>
		</>
	);
}

// ---------- 参数预设的部分覆盖编辑（留空 = 继承默认参数） ----------

function PartialParamsFields({
	value,
	onChange,
}: {
	value: Partial<DrawParams>;
	onChange: (v: Partial<DrawParams>) => void;
}) {
	const setStr = (k: "sampler" | "scheduler" | "negativePrompt", v: string) => {
		const next = { ...value };
		if (v.trim()) next[k] = v;
		else delete next[k];
		onChange(next);
	};
	const setNum = (k: "steps" | "scale" | "width" | "height" | "ucPreset" | "cfgRescale", v: string) => {
		const next = { ...value };
		const n = Number(v);
		if (v.trim() && Number.isFinite(n)) next[k] = n;
		else delete next[k];
		onChange(next);
	};
	const setBool = (k: "qualityToggle" | "autoSmea" | "varietyBoost", v: boolean | undefined) => {
		const next = { ...value };
		if (v === undefined) delete next[k];
		else next[k] = v;
		onChange(next);
	};
	const boolSel = (k: "qualityToggle" | "autoSmea" | "varietyBoost") => (
		<select
			className="panel-search"
			value={value[k] === undefined ? "" : value[k] ? "on" : "off"}
			onChange={(e) => setBool(k, e.target.value === "" ? undefined : e.target.value === "on")}
		>
			<option value="">（继承）</option>
			<option value="on">开</option>
			<option value="off">关</option>
		</select>
	);
	return (
		<div className="preset-params">
			<div className="draw-params-grid">
				<Field label="采样器">
					<Sel value={value.sampler ?? ""} options={SAMPLERS} onChange={(v) => setStr("sampler", v)} />
				</Field>
				<Field label="调度器">
					<Sel value={value.scheduler ?? ""} options={SCHEDULERS} onChange={(v) => setStr("scheduler", v)} />
				</Field>
				<Field label="步数">
					<input
						className="panel-search num"
						type="number"
						value={value.steps ?? ""}
						onChange={(e) => setNum("steps", e.target.value)}
					/>
				</Field>
				<Field label="CFG scale">
					<input
						className="panel-search num"
						type="number"
						step={0.5}
						value={value.scale ?? ""}
						onChange={(e) => setNum("scale", e.target.value)}
					/>
				</Field>
				<Field label="宽">
					<input
						className="panel-search num"
						type="number"
						value={value.width ?? ""}
						onChange={(e) => setNum("width", e.target.value)}
					/>
				</Field>
				<Field label="高">
					<input
						className="panel-search num"
						type="number"
						value={value.height ?? ""}
						onChange={(e) => setNum("height", e.target.value)}
					/>
				</Field>
				<Field label="uc 预设">
					<input
						className="panel-search num"
						type="number"
						value={value.ucPreset ?? ""}
						onChange={(e) => setNum("ucPreset", e.target.value)}
					/>
				</Field>
				<Field label="cfg rescale">
					<input
						className="panel-search num"
						type="number"
						step={0.05}
						value={value.cfgRescale ?? ""}
						onChange={(e) => setNum("cfgRescale", e.target.value)}
					/>
				</Field>
			</div>
			<Field label="负面提示词">
				<textarea
					className="panel-search ta"
					rows={2}
					value={value.negativePrompt ?? ""}
					onChange={(e) => setStr("negativePrompt", e.target.value)}
				/>
			</Field>
			<div className="draw-params-grid">
				<Field label="质量开关">{boolSel("qualityToggle")}</Field>
				<Field label="autoSmea">{boolSel("autoSmea")}</Field>
				<Field label="variety_boost">{boolSel("varietyBoost")}</Field>
			</div>
		</div>
	);
}

// ---------- provider 编辑视图（名称/Key/默认参数/预设） ----------

function ProviderEditor({
	provider,
	defaultProvider,
	busy,
	onSave,
	onCancel,
}: {
	provider: DrawProvider;
	defaultProvider: string;
	busy: boolean;
	onSave: (p: DrawProvider) => void;
	onCancel: () => void;
}) {
	const [d, setD] = useState<DrawProvider>(() => JSON.parse(JSON.stringify(provider)) as DrawProvider);

	const set = (patch: Partial<DrawProvider>) => setD((prev) => ({ ...prev, ...patch }));
	const setParams = (defaultParams: DrawParams) => setD((prev) => ({ ...prev, defaultParams }));
	const updatePreset = (id: string, patch: Partial<DrawPreset>) =>
		setD((prev) => ({ ...prev, presets: prev.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
	const addPreset = () =>
		setD((prev) => ({ ...prev, presets: [...prev.presets, { id: newId(), name: "新预设", model: prev.model, params: {} }] }));
	const removePreset = (id: string) =>
		setD((prev) => ({ ...prev, presets: prev.presets.filter((p) => p.id !== id) }));

	return (
		<div className="provider-editor">
			<div className="panel-row">
				<button type="button" className="act back-btn" disabled={busy} onClick={onCancel}>
					← 返回列表
				</button>
				{d.id === defaultProvider && <span className="chip chip-cap">当前默认</span>}
			</div>
			<Field label="名称">
				<input className="panel-search" value={d.name} onChange={(e) => set({ name: e.target.value })} />
			</Field>
			<Field label="类型">
				<select className="panel-search" value={d.type} onChange={(e) => set({ type: e.target.value as DrawProviderType })}>
					<option value="novelai">NovelAI（已实现）</option>
					<option value="sd-webui">SD WebUI（预留）</option>
					<option value="comfyui">ComfyUI（预留）</option>
				</select>
			</Field>
			<Field label="API Key">
				<input type="password" className="panel-search" value={d.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
			</Field>
			<Field label="baseUrl（自托管网关可改）">
				<input className="panel-search" value={d.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
			</Field>
			<Field label="模型">
				<input className="panel-search" value={d.model} onChange={(e) => set({ model: e.target.value })} />
			</Field>
			<div className="draw-toggle-row">
				<span>agent 生图前自动确认（autoConfirm）</span>
				<Toggle checked={d.autoConfirm} onChange={(autoConfirm) => set({ autoConfirm })} />
			</div>

			<h5 className="draw-sub-title">默认参数</h5>
			<ParamsFields value={d.defaultParams} onChange={setParams} />

			<div className="sp-section-head" style={{ marginTop: 12 }}>
				<h5 className="draw-sub-title">参数预设（{d.presets.length}）</h5>
				<button type="button" className="act" disabled={busy} onClick={addPreset}>
					<IconPlus size={13} /> 添加预设
				</button>
			</div>
			<div className="preset-list">
				{d.presets.length === 0 && <div className="sp-empty">还没有参数预设。预设只覆盖默认参数里指定的字段。</div>}
				{d.presets.map((p) => (
					<div key={p.id} className="preset-card">
						<div className="preset-head">
							<ConfirmButton className="act" disabled={busy} confirmText="确认删除" title="删除预设" onConfirm={() => removePreset(p.id)}>
								<IconTrash size={12} />
							</ConfirmButton>
						</div>
						<div className="draw-params-grid">
							<Field label="预设名">
								<input className="panel-search" value={p.name} onChange={(e) => updatePreset(p.id, { name: e.target.value })} />
							</Field>
							<Field label="模型">
								<input className="panel-search" value={p.model} onChange={(e) => updatePreset(p.id, { model: e.target.value })} />
							</Field>
						</div>
						<details className="legacy-group" open>
							<summary>参数覆盖（留空 = 继承默认参数）</summary>
							<PartialParamsFields value={p.params} onChange={(params) => updatePreset(p.id, { params })} />
						</details>
					</div>
				))}
			</div>

			<div className="panel-row" style={{ marginTop: 12 }}>
				<button type="button" className="drawer-btn save-btn" disabled={busy || !d.name.trim()} onClick={() => onSave(d)}>
					保存 provider
				</button>
				<button type="button" className="drawer-btn" disabled={busy} onClick={onCancel}>
					取消
				</button>
			</div>
		</div>
	);
}

// ---------- 添加 provider 表单 ----------

function AddProviderForm({
	busy,
	onAdd,
	onCancel,
}: {
	busy: boolean;
	onAdd: (body: { type: DrawProviderType; name: string; apiKey: string; baseUrl: string; model: string }) => void;
	onCancel: () => void;
}) {
	const [type, setType] = useState<DrawProviderType>("novelai");
	const [name, setName] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [model, setModel] = useState("");
	return (
		<div className="codex-add-form">
			<Field label="类型">
				<select className="panel-search" value={type} onChange={(e) => setType(e.target.value as DrawProviderType)}>
					<option value="novelai">NovelAI（已实现）</option>
					<option value="sd-webui">SD WebUI（预留）</option>
					<option value="comfyui">ComfyUI（预留）</option>
				</select>
			</Field>
			<Field label="名称">
				<input className="panel-search" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：我的 NovelAI" />
			</Field>
			<Field label="API Key">
				<input type="password" className="panel-search" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="NovelAI 永久令牌" />
			</Field>
			<Field label="baseUrl（自托管网关可改）">
				<input className="panel-search" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://image.novelai.net" />
			</Field>
			<Field label="模型">
				<input className="panel-search" value={model} onChange={(e) => setModel(e.target.value)} placeholder="nai-diffusion-4-5-full" />
			</Field>
			<div className="panel-row">
				<button
					type="button"
					className="drawer-btn save-btn"
					disabled={busy || !name.trim() || !apiKey.trim()}
					onClick={() => onAdd({ type, name: name.trim(), apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), model: model.trim() })}
				>
					添加
				</button>
				<button type="button" className="drawer-btn" disabled={busy} onClick={onCancel}>
					取消
				</button>
			</div>
		</div>
	);
}

// ---------- 主组件 ----------

export function DrawPanel({
	toast,
	charName,
	worldState,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
	charName?: string;
	worldState?: WorldState | null;
}) {
	const { busy, run } = useAction(toast);
	const providers = usePanelData(() => apiGet<DrawProvidersResponse>("/api/draw/providers"), {
		cacheKey: "/api/draw/providers",
	});
	const wardrobe = usePanelData(() => apiGet<WardrobeResponse>("/api/wardrobe"), { cacheKey: "/api/wardrobe" });
	const media = usePanelData(() => apiGet<UploadsResponse>("/api/uploads"), { watchAgent: true, cacheKey: "/api/uploads" });

	const [editingId, setEditingId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
	const [appearanceDrafts, setAppearanceDrafts] = useState<Record<string, string>>({});
	const [outfitDrafts, setOutfitDrafts] = useState<Record<string, { name: string; tags: string }>>({});
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
	}, [wardrobe.data]);

	// 当前穿着：worldState（账本）里的 outfit 同步进来
	useEffect(() => {
		const next: Record<string, string> = {};
		for (const [name, c] of Object.entries(worldState?.characters ?? {})) {
			if (c && typeof c.outfit === "string" && c.outfit) next[name] = c.outfit;
		}
		if (Object.keys(next).length > 0) setWornMap((m) => ({ ...m, ...next }));
	}, [worldState]);

	const defaultProvider = providers.data?.config.defaultProvider ?? "";
	const defaultProviderName =
		providers.data?.providers.find((p) => p.id === defaultProvider)?.name ?? (defaultProvider ? defaultProvider : "未设置");

	// ---- provider 操作（run 自带防重入 + 错误 toast） ----

	const saveProvider = (body: object) =>
		run(async () => {
			await apiPost("/api/draw/providers", body);
			providers.reload();
		}, "provider 已保存");

	const saveKey = (p: DrawProvider) =>
		run(async () => {
			const key = (keyDrafts[p.id] ?? "").trim();
			if (!key) throw new Error("Key 为空");
			await apiPost("/api/draw/providers", { id: p.id, apiKey: key });
			setKeyDrafts((m) => ({ ...m, [p.id]: key }));
			providers.reload();
		}, "Key 已更新");

	const toggleEnabled = (p: DrawProvider, enabled: boolean) =>
		run(async () => {
			await apiPost("/api/draw/providers", { id: p.id, enabled });
			providers.reload();
		}, enabled ? "已启用" : "已停用");

	const delProvider = (id: string) =>
		run(async () => {
			await apiDelete(`/api/draw/providers?id=${encodeURIComponent(id)}`);
			setEditingId((e) => (e === id ? null : e));
			providers.reload();
		}, "provider 已删除");

	const setDefault = (id: string) =>
		run(async () => {
			await apiPut(`/api/draw/default?id=${encodeURIComponent(id)}`, {});
			providers.reload();
		}, "已设为默认");

	const testProvider = (p: DrawProvider) =>
		run(async () => {
			const r = await apiPost<{ ok: boolean; note?: string }>("/api/draw/test", { id: p.id });
			toast("info", r.note || "连接成功");
		});

	const testByKey = (p: DrawProvider, key: string) =>
		run(async () => {
			const r = await apiPost<{ ok: boolean; note?: string }>("/api/draw/test", { apiKey: key, baseUrl: p.baseUrl });
			toast("info", r.note || "连接成功");
		});

	const addProvider = (body: { type: DrawProviderType; name: string; apiKey: string; baseUrl: string; model: string }) =>
		run(async () => {
			await apiPost("/api/draw/providers", body);
			setAdding(false);
			providers.reload();
		}, "provider 已添加");

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

	const saveAppearance = (c: WardrobeCharacter) =>
		run(async () => {
			const wb = wardrobe.data?.wardrobe;
			if (!wb) return;
			const tags = appearanceDrafts[c.name] ?? c.appearanceTags;
			await persistWardrobe({
				...wb,
				characters: wb.characters.map((x) => (x.name === c.name ? { ...x, appearanceTags: tags } : x)),
			});
			setAppearanceDrafts((m) => ({ ...m, [c.name]: tags }));
		}, `「${c.name}」外观已保存`);

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

	const editingProvider = providers.data?.providers.find((p) => p.id === editingId) ?? null;

	const galleryList = useMemo(
		() => (media.data?.media ?? []).filter((u) => toAttachmentView(u.file).image),
		[media.data],
	);

	return (
		<div className="panel-body">
			{/* ════════ ① API 管理 ════════ */}
			<section className="sp-section">
				<div className="sp-section-head">
					<h4>API 管理（{providers.data?.providers.length ?? 0}）</h4>
					<button
						type="button"
						className="drawer-btn"
						disabled={busy || !!editingProvider}
						onClick={() => setAdding((v) => !v)}
					>
						<IconPlus size={13} /> 添加 provider
					</button>
				</div>
				<div className="field-hint">默认 provider：{defaultProviderName}</div>
				<PanelStatus loading={providers.loading} error={providers.error} hasData={!!providers.data} />
				{providers.data && (
					<>
						{adding && !editingProvider && (
							<AddProviderForm busy={busy} onAdd={(body) => void addProvider(body)} onCancel={() => setAdding(false)} />
						)}
						{editingProvider ? (
							<ProviderEditor
								provider={editingProvider}
								defaultProvider={defaultProvider}
								busy={busy}
								onSave={(p) => {
									setEditingId(null);
									void saveProvider(p);
								}}
								onCancel={() => setEditingId(null)}
							/>
						) : (
							providers.data.providers.map((p) => {
								const isDefault = p.id === defaultProvider;
								const keyDraft = keyDrafts[p.id] ?? p.apiKey;
								return (
									<div key={p.id} className="provider-row">
										<div className="provider-head">
											<span className="provider-name">{p.name}</span>
											<span className="chip">{TYPE_LABEL[p.type]}</span>
											<span className="provider-meta">{p.model}</span>
											{isDefault && <span className="chip chip-cap">默认</span>}
											<Toggle
												checked={p.enabled}
												onChange={(v) => void toggleEnabled(p, v)}
												title={p.enabled ? "已启用（点此停用）" : "已停用（点此启用）"}
											/>
										</div>
										<div className="provider-edit">
											<div className="draw-key-row">
												<input
													type="password"
													className="panel-search"
													value={keyDraft}
													onChange={(e) => setKeyDrafts((m) => ({ ...m, [p.id]: e.target.value }))}
													placeholder="API Key（留空保持原样）"
												/>
												<button type="button" className="act" disabled={busy} onClick={() => void saveKey(p)}>
													保存 Key
												</button>
												<button
													type="button"
													className="act"
													disabled={busy || !keyDraft.trim()}
													onClick={() => void testByKey(p, keyDraft.trim())}
												>
													测试此 Key
												</button>
											</div>
											<div className="panel-row">
												<button type="button" className="act" disabled={busy} onClick={() => void testProvider(p)}>
													测试连接
												</button>
												<button type="button" className="act" disabled={busy || isDefault} onClick={() => void setDefault(p.id)}>
													设为默认
												</button>
												<button type="button" className="act" disabled={busy} onClick={() => setEditingId(p.id)}>
													<IconEdit size={12} /> 编辑
												</button>
												<ConfirmButton
													className="act"
													disabled={busy}
													confirmText="确认删除"
													title="删除 provider"
													onConfirm={() => void delProvider(p.id)}
												>
													<IconTrash size={12} />
												</ConfirmButton>
											</div>
										</div>
									</div>
								);
							})
						)}
						{providers.data.providers.length === 0 && !editingProvider && (
							<div className="sp-empty">还没有生图 provider。点「添加 provider」配置 NovelAI 并测试连接。</div>
						)}
					</>
				)}
			</section>

			{/* ════════ ② 服装管理 ════════ */}
			<section className="sp-section">
				<div className="sp-section-head">
					<h4>服装管理（{wardrobe.data?.wardrobe.characters.length ?? 0} 角色）</h4>
				</div>
				<div className="field-hint">
					按当前角色卡保存档案：{wardrobe.data?.card || "（读取中…）"}。设「当前穿着」写入本会话状态，随世界线回档。
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
							const wornId = wornMap[c.name] !== undefined ? wornMap[c.name] : c.defaultOutfit ?? null;
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
									<div className="panel-row">
										<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={() => void saveAppearance(c)}>
											保存外观
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
			</section>

			{/* ════════ ③ 画廊 ════════ */}
			<section className="sp-section">
				<div className="sp-section-head">
					<h4>画廊（{galleryList.length}）</h4>
					<button type="button" className="drawer-btn" onClick={media.reload}>
						<IconRefresh size={13} /> 刷新
					</button>
				</div>
				<div className="field-hint">本地出图（.liyuan-media/）：AI 生图/展示后落盘的图片，点图放大查看。</div>
				<PanelStatus loading={media.loading} error={media.error} hasData={!!media.data} />
				{media.data && galleryList.length === 0 && (
					<div className="sp-empty">还没有出图。在对话里让 AI 生成或展示图片后，会出现在这里。</div>
				)}
				{galleryList.length > 0 && (
					<div className="upload-grid">
						{galleryList.map((u) => {
							const view = toAttachmentView(u.file);
							const src = attachmentUrl(view);
							return (
								<div key={u.file} className="upload-cell">
									<button type="button" className="upload-cell-btn" onClick={() => setLightbox(src)} title="点击放大">
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
			</section>

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
		</div>
	);
}
