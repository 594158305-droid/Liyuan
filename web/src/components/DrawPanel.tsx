/**
 * 绘画面板（生图系统 UI）：底座版（分层设计见 docs/DESIGN-draw.md §2.6）
 * - API 管理：生图 provider 注册 / 测试连接 / 默认参数 / 参数预设 / autoConfirm
 * - 风格预设：全局正/负前缀 tag 串的增删改查、设为默认
 * - 服装管理 / 画廊已抽为独立组件（wardrobe-section.tsx / gallery-section.tsx），
 *   供插件层挂载（依赖方向：插件 → 底座），底座面板暂不渲染，代码保留不删。
 */

import { useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.ts";
import type { WorldState } from "../wire.ts";
import { IconEdit, IconPlus, IconSettings, IconTrash } from "./icons.tsx";
import { ConfirmButton, Field, PanelStatus, Toggle, useAction, usePanelData } from "./kit.tsx";
import { DrawSettingsModal } from "./draw-settings-modal.tsx";

// ---------- 类型（字段与 src/draw-config.ts 一致） ----------

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
export type { DrawParams, DrawPreset, DrawProvider, DrawProviderType };

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

// ---------- 类型（全局风格预设，字段与 src/draw/config.ts styles 一致） ----------

interface DrawStyleType {
	id: string;
	name: string;
	positivePrefix: string;
	negativePrefix: string;
}

interface DrawStylesResponse {
	styles: DrawStyleType[];
	defaultStyleId: string;
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

/** 摘要截断：超长 tag 串折叠显示，悬停 title 看全文 */
const clip = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max)}…` : s || "（空）");

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

export function ParamsFields({ value, onChange }: { value: DrawParams; onChange: (v: DrawParams) => void }) {
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

export function PartialParamsFields({
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

// ---------- 全局风格预设（增删改查 + 设为默认） ----------

export function DrawStylesSection({
	toast,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const { busy, run } = useAction(toast);
	const styles = usePanelData(() => apiGet<DrawStylesResponse>("/api/draw/styles"), {
		cacheKey: "/api/draw/styles",
	});

	const [editingId, setEditingId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	/** 编辑/新增共用表单草稿 */
	const [draft, setDraft] = useState({ name: "", positivePrefix: "", negativePrefix: "" });

	const defaultStyleId = styles.data?.defaultStyleId ?? "";

	const startAdd = () => {
		setDraft({ name: "", positivePrefix: "", negativePrefix: "" });
		setEditingId(null);
		setAdding(true);
	};
	const startEdit = (s: DrawStyleType) => {
		setDraft({ name: s.name, positivePrefix: s.positivePrefix, negativePrefix: s.negativePrefix });
		setEditingId(s.id);
		setAdding(false);
	};
	const cancelForm = () => {
		setEditingId(null);
		setAdding(false);
	};

	const saveStyle = () =>
		run(async () => {
			if (!draft.name.trim()) throw new Error("名称不能为空");
			const body = {
				...(editingId ? { id: editingId } : {}),
				name: draft.name.trim(),
				positivePrefix: draft.positivePrefix,
				negativePrefix: draft.negativePrefix,
			};
			await apiPost("/api/draw/styles", body);
			cancelForm();
			styles.reload();
		}, editingId ? "风格预设已保存" : "风格预设已添加");

	const setDefault = (id: string) =>
		run(async () => {
			await apiPut(`/api/draw/default-style?id=${encodeURIComponent(id)}`, {});
			styles.reload();
		}, "已设为默认风格");

	const delStyle = (id: string) =>
		run(async () => {
			await apiDelete(`/api/draw/styles?id=${encodeURIComponent(id)}`);
			if (editingId === id) setEditingId(null);
			styles.reload();
		}, "风格预设已删除");

	const renderForm = () => (
		<div className="codex-add-form">
			<Field label="名称">
				<input
					className="panel-search"
					value={draft.name}
					onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
					placeholder="如：质量词风格"
				/>
			</Field>
			<Field label="positivePrefix（正向质量词前缀）">
				<textarea
					className="panel-search ta"
					rows={3}
					value={draft.positivePrefix}
					onChange={(e) => setDraft((d) => ({ ...d, positivePrefix: e.target.value }))}
					placeholder="如：1.3::best quality, amazing quality, very aesthetic, highres::"
				/>
			</Field>
			<Field label="negativePrefix（负面词前缀）">
				<textarea
					className="panel-search ta"
					rows={3}
					value={draft.negativePrefix}
					onChange={(e) => setDraft((d) => ({ ...d, negativePrefix: e.target.value }))}
					placeholder="如：lowres, worst quality, jpeg artifacts, ..."
				/>
			</Field>
			<div className="panel-row">
				<button type="button" className="drawer-btn save-btn" disabled={busy || !draft.name.trim()} onClick={() => void saveStyle()}>
					{editingId ? "保存" : "添加"}
				</button>
				<button type="button" className="drawer-btn" disabled={busy} onClick={cancelForm}>
					取消
				</button>
			</div>
		</div>
	);

	return (
		<section className="sp-section">
			<div className="sp-section-head">
				<h4>风格预设（{styles.data?.styles.length ?? 0}）</h4>
				<button type="button" className="drawer-btn" disabled={busy || !!editingId} onClick={startAdd}>
					<IconPlus size={13} /> 添加风格
				</button>
			</div>
			<div className="field-hint">
				全局正/负质量词前缀（与角色无关），生图时与角色特征（插件层）分属不同层级，仅作全局前缀合并。设为默认后未指定风格时生效。
			</div>
			<PanelStatus loading={styles.loading} error={styles.error} hasData={!!styles.data} />
			{styles.data && (
				<>
					{adding && renderForm()}
					{styles.data.styles.map((s) => {
						const isDefault = s.id === defaultStyleId;
						if (editingId === s.id) {
							return <div key={s.id}>{renderForm()}</div>;
						}
						return (
							<div key={s.id} className="provider-row">
								<div className="provider-head">
									<span className="provider-name">{s.name}</span>
									{isDefault && <span className="chip chip-cap">默认</span>}
								</div>
								<div className="field-hint" title={s.positivePrefix}>
									正向前缀：{clip(s.positivePrefix)}
								</div>
								<div className="field-hint" title={s.negativePrefix}>
									负向前缀：{clip(s.negativePrefix)}
								</div>
								<div className="panel-row">
									<button type="button" className="act" disabled={busy || isDefault} onClick={() => void setDefault(s.id)}>
										设为默认
									</button>
									<button type="button" className="act" disabled={busy} onClick={() => startEdit(s)}>
										<IconEdit size={12} /> 编辑
									</button>
									<ConfirmButton
										className="act"
										disabled={busy}
										confirmText="确认删除"
										title="删除风格预设"
										onConfirm={() => void delStyle(s.id)}
									>
										<IconTrash size={12} />
									</ConfirmButton>
								</div>
							</div>
						);
					})}
					{styles.data.styles.length === 0 && !adding && (
						<div className="sp-empty">还没有全局风格预设。点「添加风格」配置正/负质量词前缀。</div>
					)}
				</>
			)}
		</section>
	);
}

// ---------- 全局分辨率（liyuan.draw.json 顶层 aspects：横/纵/方三档宽高） ----------

type AspectKey = "portrait" | "landscape" | "square";

interface DrawAspect {
	width: number;
	height: number;
}

type DrawAspects = Record<AspectKey, DrawAspect>;

interface DrawAspectsResponse {
	ok: boolean;
	aspects: DrawAspects;
}

/** 三档默认分辨率（后端缺省回退值） */
const DEFAULT_ASPECTS: DrawAspects = {
	portrait: { width: 832, height: 1216 },
	landscape: { width: 1216, height: 832 },
	square: { width: 1024, height: 1024 },
};

/** 分辨率合法范围（与 DrawParams 宽高的 clampInt 一致） */
const ASPECT_MIN = 64;
const ASPECT_MAX = 2048;

const ASPECT_ROWS: { key: AspectKey; label: string; hint: string }[] = [
	{ key: "landscape", label: "横图", hint: "landscape" },
	{ key: "portrait", label: "纵图", hint: "portrait" },
	{ key: "square", label: "方图", hint: "square" },
];

/** 分辨率配置区：三档宽高 读取 / 保存 / 恢复默认 */
function DrawAspectsSection({
	toast,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const { busy, run } = useAction(toast);
	const aspects = usePanelData(() => apiGet<DrawAspectsResponse>("/api/draw/aspects"), {
		cacheKey: "/api/draw/aspects",
	});

	/** 编辑草稿：GET 数据到达后回填；用户改动后不再被数据覆盖 */
	const [draft, setDraft] = useState<DrawAspects | null>(null);
	const touched = useRef(false);

	useEffect(() => {
		const d = aspects.data?.aspects;
		if (d && !touched.current) setDraft(d);
	}, [aspects.data]);

	const setSize = (key: AspectKey, dim: "width" | "height", raw: string) => {
		touched.current = true;
		setDraft((prev) => {
			if (!prev) return prev;
			return { ...prev, [key]: { ...prev[key], [dim]: clampInt(raw, ASPECT_MIN, ASPECT_MAX, prev[key][dim]) } };
		});
	};

	/** 保存前校验：输入框已即时夹取到 64–2048，此处兜底后端回填的异常值并给提示 */
	const checkInvalid = (): string | null => {
		if (!draft) return "分辨率数据未就绪";
		for (const { key, label } of ASPECT_ROWS) {
			for (const dim of ["width", "height"] as const) {
				const v = draft[key][dim];
				const dimName = dim === "width" ? "宽度" : "高度";
				if (!Number.isInteger(v)) return `${label}${dimName}不是整数`;
				if (v < ASPECT_MIN || v > ASPECT_MAX) return `${label}${dimName}需在 ${ASPECT_MIN}–${ASPECT_MAX} 之间`;
			}
		}
		return null;
	};

	const save = () =>
		run(async () => {
			const err = checkInvalid();
			if (err) {
				toast("warning", err);
				return;
			}
			const r = await apiPut<DrawAspectsResponse>("/api/draw/aspects", { aspects: draft });
			setDraft(r.aspects);
			aspects.reload();
		}, "分辨率已保存");

	const restore = () =>
		run(async () => {
			touched.current = true;
			setDraft(DEFAULT_ASPECTS);
			const r = await apiPut<DrawAspectsResponse>("/api/draw/aspects", { aspects: DEFAULT_ASPECTS });
			setDraft(r.aspects);
			aspects.reload();
		}, "已恢复默认分辨率");

	return (
		<section className="sp-section">
			<div className="sp-section-head">
				<h4>分辨率</h4>
				<span className="field-hint">动态分辨率（横图 / 纵图 / 方图三档，LLM 出图按档位替换）</span>
			</div>
			<div className="field-hint">修改后点「保存」立即生效；数值范围 64–2048。</div>
			<PanelStatus loading={aspects.loading} error={aspects.error} hasData={!!aspects.data} />
			{draft && (
				<>
					{ASPECT_ROWS.map(({ key, label, hint }) => (
						<div key={key} className="draw-aspect-row">
							<span className="draw-aspect-label">
								{label}
								<small>{hint}</small>
							</span>
							<input
								className="panel-search num"
								type="number"
								min={ASPECT_MIN}
								max={ASPECT_MAX}
								step={64}
								value={draft[key].width}
								onChange={(e) => setSize(key, "width", e.target.value)}
								aria-label={`${label}宽度`}
							/>
							<span className="draw-aspect-x">×</span>
							<input
								className="panel-search num"
								type="number"
								min={ASPECT_MIN}
								max={ASPECT_MAX}
								step={64}
								value={draft[key].height}
								onChange={(e) => setSize(key, "height", e.target.value)}
								aria-label={`${label}高度`}
							/>
						</div>
					))}
					<div className="panel-row" style={{ marginTop: 8 }}>
						<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={() => void save()}>
							保存
						</button>
						<button type="button" className="drawer-btn" disabled={busy} onClick={() => void restore()}>
							恢复默认
						</button>
					</div>
				</>
			)}
		</section>
	);
}

// ---------- D 标签搜索（插件 A draw-role；角色库 7000+ 只读查询） ----------

interface TagSearchHit {
	name: string;
	tags: string[];
}

interface TagSearchResponse {
	characters: TagSearchHit[];
	tags: { tag: string; count: number }[];
}

/** 悬停标题用的完整 tag 串（长列表压成一行） */
const tagTitle = (tags: string[]): string => tags.join(", ");

export function DrawTagsSection({
	toast,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [result, setResult] = useState<TagSearchResponse | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [searching, setSearching] = useState(false);

	const doSearch = async () => {
		const q = query.trim();
		if (!q) {
			toast("warning", "请输入角色名或关键词");
			return;
		}
		setSearching(true);
		try {
			const r = await apiGet<TagSearchResponse>(`/api/draw/tags/search?q=${encodeURIComponent(q)}`);
			setResult(r);
			setExpanded(null);
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setSearching(false);
		}
	};

	// 行内展开：取该角色全部 tag（title 悬停已给全文，这里给可读列表）
	const toggleExpand = async (name: string) => {
		if (expanded === name) {
			setExpanded(null);
			return;
		}
		setExpanded(name);
	};

	return (
		<section className="sp-section">
			<div className="sp-section-head">
				<h4>D 标签搜索</h4>
				<span className="field-hint">7000+ Danbooru 角色（下划线格式）</span>
			</div>
			<div className="panel-row">
				<input
					className="panel-search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void doSearch();
					}}
					placeholder="角色名或关键词，如 miku / 初音"
				/>
				<button type="button" className="act" disabled={searching} onClick={() => void doSearch()}>
					搜索
				</button>
			</div>
			{result && (
				<div className="draw-tags-result">
					{result.characters.length === 0 && result.tags.length === 0 && (
						<div className="sp-empty">未找到匹配项，可尝试其他拼写。</div>
					)}
					{result.characters.map((c) => (
						<div key={c.name} className="draw-tag-row">
							<button
								type="button"
								className="draw-tag-name"
								title={tagTitle(c.tags)}
								onClick={() => void toggleExpand(c.name)}
							>
								{c.name}
								<span className="field-hint"> · {c.tags.length} tags</span>
							</button>
							{expanded === c.name && (
								<div className="draw-tag-full">{c.tags.length > 0 ? c.tags.join(", ") : "（无 tag）"}</div>
							)}
						</div>
					))}
					{result.tags.length > 0 && (
						<div className="draw-tag-meta">
							<span className="field-hint">相关标签：</span>
							{result.tags.slice(0, 10).map((t) => (
								<span key={t.tag} className="chip" title={`${t.tag} · ${t.count} 个角色`}>
									{t.tag} × {t.count}
								</span>
							))}
						</div>
					)}
				</div>
			)}

			<LearnCandidatesArea toast={toast} />
			<TagGroupsArea toast={toast} />
			<OnlineTagsArea toast={toast} />
		</section>
	);
}

// ---------- 待学习角色（二期：未知角色自动学习） ----------

interface LearnCandidate {
	name: string;
	firstSeenAt: number;
	source: "pipeline" | "manual";
	status: "pending" | "learned" | "ignored";
}

function LearnCandidatesArea({
	toast,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const candidates = usePanelData(() => apiGet<{ ok: boolean; candidates: LearnCandidate[] }>("/api/draw/characters/learn-candidates"), {
		cacheKey: "/api/draw/characters/learn-candidates",
	});
	const { busy, run } = useAction(toast);

	const pending = candidates.data?.candidates.filter((c) => c.status === "pending") ?? [];

	const confirm = (name: string) =>
		run(async () => {
			await apiPost("/api/draw/characters/learn", { name });
			candidates.reload();
			toast("info", "已加入服装档案，可在服装管理补外观 tag");
		});
	const dismiss = (name: string) =>
		run(async () => {
			await apiDelete(`/api/draw/characters/learn?name=${encodeURIComponent(name)}`);
			candidates.reload();
		}, "已忽略");

	return (
		<div className="draw-learn-block">
			<div className="field-hint" style={{ marginTop: 10 }}>
				待学习角色（管线检出的未登记角色）：{pending.length === 0 ? "暂无" : `${pending.length} 个`}
			</div>
			{pending.length > 0 && (
				<div className="draw-tag-meta">
					{pending.map((c) => (
						<span key={c.name} className="chip">
							{c.name}
							<span className="field-hint"> · {new Date(c.firstSeenAt).toLocaleString()}</span>
							<button type="button" className="act" disabled={busy} onClick={() => void confirm(c.name)}>
								确认
							</button>
							<button type="button" className="act" disabled={busy} onClick={() => void dismiss(c.name)}>
								忽略
							</button>
						</span>
					))}
				</div>
			)}
		</div>
	);
}

// ---------- 自定义标签组（二期） ----------

interface TagGroup {
	id: string;
	name: string;
	tags: string;
	enabled: boolean;
	createdAt: number;
	/** 绑定的角色名（LWB characterId 语义：生图时仅该角色在场时追加；缺省 = 全局） */
	characterId?: string;
}

function TagGroupsArea({
	toast,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const groups = usePanelData(() => apiGet<{ ok: boolean; groups: TagGroup[] }>("/api/draw/tag-groups"), {
		cacheKey: "/api/draw/tag-groups",
	});
	/** 角色名单（「绑定角色」下拉数据源：/api/wardrobe） */
	const wardrobe = usePanelData(() => apiGet<{ ok: boolean; wardrobe: { characters: { name: string }[] } }>("/api/wardrobe"), {
		cacheKey: "/api/wardrobe",
	});
	const characterNames = wardrobe.data?.wardrobe?.characters?.map((c) => c.name) ?? [];
	const { busy, run } = useAction(toast);
	const [name, setName] = useState("");
	const [tags, setTags] = useState("");

	const save = (id?: string) =>
		run(
			async () => {
				if (!name.trim()) throw new Error("名称不能为空");
				if (id) await apiPut("/api/draw/tag-groups", { id, name: name.trim(), tags });
				else await apiPost("/api/draw/tag-groups", { name: name.trim(), tags });
				setName("");
				setTags("");
				groups.reload();
			},
			id ? "标签组已保存" : "标签组已添加",
		);

	const del = (id: string) =>
		run(async () => {
			await apiDelete(`/api/draw/tag-groups?id=${encodeURIComponent(id)}`);
			groups.reload();
		}, "标签组已删除");

	const toggle = (id: string, enabled: boolean) =>
		run(async () => {
			await apiPut("/api/draw/tag-groups/toggle", { id, enabled });
			groups.reload();
		});

	/** 绑定角色（空串 = 解除绑定走全局；无 characterId 时 body 不传该字段） */
	const bind = (g: TagGroup, characterId: string) =>
		run(async () => {
			const body: { id: string; name: string; tags: string; characterId?: string } = {
				id: g.id,
				name: g.name,
				tags: g.tags,
			};
			if (characterId) body.characterId = characterId;
			await apiPut("/api/draw/tag-groups", body);
			groups.reload();
		}, characterId ? `已绑定角色「${characterId}」` : "已解除绑定（全局）");

	/** 设为全局当前组（PUT /api/draw/tag-groups/select） */
	const setCurrent = (id: string) =>
		run(async () => {
			await apiPut("/api/draw/tag-groups/select", { id });
			groups.reload();
		}, "已设为全局当前组");

	const exportGroups = () => {
		const url = "/api/draw/tag-groups/export";
		const a = document.createElement("a");
		a.href = url;
		a.download = "liyuan-tag-groups.json";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	};

	const importFile = (file: File) =>
		run(async () => {
			const text = await file.text();
			const parsed = JSON.parse(text) as unknown;
			const groupsArr = Array.isArray(parsed) ? parsed : (parsed as { groups?: unknown }).groups;
			if (!Array.isArray(groupsArr)) throw new Error("文件不是标签组 JSON");
			const r = await apiPost<{ imported: number }>("/api/draw/tag-groups/import", { groups: groupsArr });
			toast("info", `已导入 ${r.imported} 个标签组`);
			groups.reload();
		});

	return (
		<div className="draw-tag-groups-block">
			<div className="field-hint" style={{ marginTop: 10 }}>
				自定义标签组（生图时自动追加；可绑定角色、设全局当前组）：
			</div>
			<div className="panel-row">
				<input className="panel-search" value={name} onChange={(e) => setName(e.target.value)} placeholder="组名" style={{ maxWidth: 140 }} />
				<input className="panel-search" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tag 串（空格分隔）" />
				<button type="button" className="act" disabled={busy || !name.trim()} onClick={() => void save()}>
					添加
				</button>
			</div>
			<div className="panel-row">
				<button type="button" className="act" onClick={exportGroups}>
					导出
				</button>
				<label className="act" style={{ cursor: "pointer" }}>
					导入
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
			</div>
			{(groups.data?.groups ?? []).map((g) => (
				<div key={g.id} className="draw-tag-row">
					<span className="draw-tag-name" title={g.tags}>
						{g.name}
						<span className="field-hint"> · {g.tags || "（空）"}</span>
						{g.characterId && <span className="chip">绑定：{g.characterId}</span>}
					</span>
					<div className="panel-row">
						<Toggle checked={g.enabled} onChange={(v) => void toggle(g.id, v)} title={g.enabled ? "已启用" : "已停用"} />
						<select
							className="panel-search"
							value={g.characterId ?? ""}
							onChange={(e) => void bind(g, e.target.value)}
							title="绑定角色：生图时仅该角色在场时自动追加该组 tag"
							style={{ maxWidth: 150, marginBottom: 0 }}
						>
							<option value="">全局</option>
							{characterNames.map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</select>
						<button type="button" className="act" disabled={busy} onClick={() => void setCurrent(g.id)}>
							设为当前组
						</button>
						<button type="button" className="act" disabled={busy} onClick={() => void del(g.id)}>
							删除
						</button>
					</div>
				</div>
			))}
		</div>
	);
}

// ---------- 在线标签库（二期） ----------

function OnlineTagsArea({
	toast,
}: {
	toast: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const status = usePanelData(() => apiGet<{ ok: boolean; status: { lastUpdatedAt: number | null; entries: number } | null }>("/api/draw/tags/online-status"), {
		cacheKey: "/api/draw/tags/online-status",
	});
	const { busy, run } = useAction(toast);

	const update = () =>
		run(async () => {
			const r = await apiPost<{ entries: number }>("/api/draw/tags/online-update", {});
			toast("info", `在线标签库已更新（${r.entries} 条）`);
			status.reload();
		});

	const st = status.data?.status;
	return (
		<div className="draw-online-block">
			<div className="field-hint" style={{ marginTop: 10 }}>
				在线标签库：{st ? `已更新（${new Date(st.lastUpdatedAt ?? 0).toLocaleString()} · ${st.entries} 条）` : "未更新（离线库 7000+ 角色可用）"}
			</div>
			<button type="button" className="act" disabled={busy} onClick={() => void update()}>
				{busy ? "更新中…" : "更新在线标签库"}
			</button>
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
	/** 插件开关：liyuan.config.json plugins.draw-role.enabled（默认关） */
	const configData = usePanelData(() => apiGet<{ config?: { plugins?: Record<string, { enabled?: boolean }> } }>("/api/config"), {
		cacheKey: "/api/config",
	});
	const roleEnabled = configData.data?.config?.plugins?.["draw-role"]?.enabled === true;
	const editEnabled = configData.data?.config?.plugins?.["draw-edit"]?.enabled === true;

	const [editingId, setEditingId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
	const [settingsOpen, setSettingsOpen] = useState(false);

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

	const editingProvider = providers.data?.providers.find((p) => p.id === editingId) ?? null;

	return (
		<div className="panel-body">
			{/* ════════ ① API 管理 ════════ */}
			<section className="sp-section">
				<div className="sp-section-head">
					<h4>API 管理（{providers.data?.providers.length ?? 0}）</h4>
					<button type="button" className="drawer-btn" title="打开生图设置总览" onClick={() => setSettingsOpen(true)}>
						<IconSettings size={13} /> 设置
					</button>
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

			{/* ════════ ② 全局分辨率（三档宽高） ════════ */}
			<DrawAspectsSection toast={toast} />

			{/* ════════ 生图设置总览（浮动窗口；其余板块已迁入） ════════ */}
			{settingsOpen && (
				<DrawSettingsModal
					toast={toast}
					charName={charName}
					worldState={worldState}
					roleEnabled={roleEnabled}
					editEnabled={editEnabled}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
		</div>
	);
}
