/**
 * 生图设置总览（浮动窗口）：左侧导航 + 右侧内容，元素排布参考 Novel Draw 总览图，
 * 风格用梨园白瓷朱砂主题（app.css .draw-modal-* 令牌）。
 *
 * 板块（去掉 API 配置/提示词模板/世界书）：
 *  快速测试 / 绘图参数 / LLM 配置 / 角色标签 / 图片管理。
 * API 配置仍留在主 DrawPanel（不挪）。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiGet, apiPost, apiPut, type ModelsResponse } from "../api.ts";
import type { WorldState } from "../wire.ts";
import { IconCard, IconClose, IconImage, IconModel, IconPlay, IconPlus, IconPreset, IconTrash } from "./icons.tsx";
import { Field, PanelStatus, useAction, usePanelData } from "./kit.tsx";
import {
	DrawStylesSection,
	ParamsFields,
	PartialParamsFields,
	type DrawParams,
	type DrawPreset,
	type DrawProvider,
} from "./DrawPanel.tsx";
import { CharacterTagsSection } from "./character-tags-section.tsx";
import { GallerySection } from "./gallery-section.tsx";

type ToastFn = (level: "info" | "warning" | "error", text: string) => void;

type SectionId = "quick" | "params" | "llm" | "tags" | "gallery";

// ---------- 快速测试 ----------

interface WardrobeCharLite {
	name: string;
	appearanceTags: string;
}
interface WardrobeLite {
	ok: boolean;
	wardrobe: { characters: WardrobeCharLite[] };
}

function QuickTestSection({ toast }: { toast: ToastFn }) {
	const [tag, setTag] = useState("1girl, smile, upper body, simple background");
	const [charName, setCharName] = useState("");
	const [result, setResult] = useState<string | null>(null);
	const [genBusy, setGenBusy] = useState(false);

	const wardrobe = usePanelData(() => apiGet<WardrobeLite>("/api/wardrobe"), { cacheKey: "/api/wardrobe" });
	const chars = wardrobe.data?.wardrobe?.characters ?? [];

	const gen = async () => {
		if (!tag.trim()) {
			toast("warning", "请输入测试 TAG");
			return;
		}
		setGenBusy(true);
		try {
			const c = chars.find((x) => x.name === charName);
			const prompt = c && c.appearanceTags.trim() ? `${c.appearanceTags.trim()}, ${tag.trim()}` : tag.trim();
			const r = await apiPost<{ ok: boolean; src: string }>("/api/draw/generate", { prompt });
			setResult(r.src);
			toast("info", "生成完成");
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setGenBusy(false);
		}
	};

	return (
		<div className="draw-modal-section">
			<h4 className="draw-modal-sec-title">快速测试</h4>
			<div className="field-hint">验证 API 连接和生成效果</div>

			<div className="sp-section">
				<Field label="测试 TAG">
					<div className="panel-row">
						<input className="panel-search" value={tag} onChange={(e) => setTag(e.target.value)} />
						<button type="button" className="drawer-btn primary" disabled={genBusy} onClick={() => void gen()}>
							{genBusy ? "生成中…" : "生成"}
						</button>
					</div>
				</Field>
			</div>

			<div className="sp-section">
				<div className="draw-sub-title">测试角色参考</div>
				<Field label="选择测试角色">
					<div className="panel-row">
						<select className="panel-search" value={charName} onChange={(e) => setCharName(e.target.value)}>
							<option value="">-- 不指定角色 --</option>
							{chars.map((c) => (
								<option key={c.name} value={c.name}>
									{c.name}
								</option>
							))}
						</select>
						<button type="button" className="drawer-btn" onClick={() => setCharName("")}>
							清除选择
						</button>
					</div>
				</Field>
			</div>

			{result && (
				<div className="sp-section">
					<div className="draw-sub-title">生成结果</div>
					<img className="draw-quick-result" src={result} alt="快速测试生成结果" />
				</div>
			)}

			<div className="draw-modal-tip">
				<div>消息楼层按钮的配图为对应消息生成插图。</div>
				<div>开启自动模式后，AI 回复时会自动配图。</div>
			</div>
		</div>
	);
}

// ---------- 绘图参数（单 provider 的默认参数 + 预设） ----------

function ProviderParamsEditor({
	provider,
	busy,
	onSave,
}: {
	provider: DrawProvider;
	busy: boolean;
	onSave: (p: DrawProvider) => void;
}) {
	const [d, setD] = useState<DrawProvider>(() => JSON.parse(JSON.stringify(provider)) as DrawProvider);
	const setParams = (defaultParams: DrawParams) => setD((prev) => ({ ...prev, defaultParams }));
	const updatePreset = (id: string, patch: Partial<DrawPreset>) =>
		setD((prev) => ({ ...prev, presets: prev.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
	const addPreset = () =>
		setD((prev) => ({ ...prev, presets: [...prev.presets, { id: `${Date.now()}`, name: "新预设", model: prev.model, params: {} }] }));
	const removePreset = (id: string) => setD((prev) => ({ ...prev, presets: prev.presets.filter((p) => p.id !== id) }));

	return (
		<div className="provider-editor">
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
							<button type="button" className="act" disabled={busy} title="删除预设" onClick={() => removePreset(p.id)}>
								<IconTrash size={12} />
							</button>
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
				<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={() => onSave(d)}>
					保存参数
				</button>
			</div>
		</div>
	);
}

interface DrawProvidersLite {
	ok: boolean;
	config: { version: number; defaultProvider: string; autoConfirm: boolean };
	providers: DrawProvider[];
}

function DrawParamsSection({ toast }: { toast: ToastFn }) {
	const { busy, run } = useAction(toast);
	const providers = usePanelData(() => apiGet<DrawProvidersLite>("/api/draw/providers"), { cacheKey: "/api/draw/providers" });
	const [selId, setSelId] = useState("");

	const list = providers.data?.providers ?? [];
	const def = providers.data?.config.defaultProvider ?? "";
	const effId = selId || def || list[0]?.id || "";
	const prov = list.find((p) => p.id === effId) ?? null;

	const save = (p: DrawProvider) =>
		run(async () => {
			await apiPost("/api/draw/providers", p);
			providers.reload();
		}, "绘图参数已保存");

	return (
		<div className="draw-modal-section">
			<h4 className="draw-modal-sec-title">绘图参数</h4>
			<div className="field-hint">编辑 provider 的默认参数与参数预设，以及全局风格预设。</div>

			<div className="sp-section">
				<Field label="选择 provider">
					<select className="panel-search" value={effId} onChange={(e) => setSelId(e.target.value)}>
						{list.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
								{p.id === def ? "（默认）" : ""}
							</option>
						))}
					</select>
				</Field>
				<PanelStatus loading={providers.loading} error={providers.error} hasData={!!providers.data} />
				{prov && <ProviderParamsEditor key={prov.id} provider={prov} busy={busy} onSave={save} />}
				{list.length === 0 && <div className="sp-empty">还没有 provider，请先在主面板「API 管理」添加。</div>}
			</div>

			<DrawStylesSection toast={toast} />
		</div>
	);
}

// ---------- LLM 配置 ----------

interface LlmSel {
	provider?: string;
	model?: string;
}
interface DrawPluginSettings {
	llm?: LlmSel;
	visionLlm?: LlmSel;
	[key: string]: unknown;
}
interface ConfigLite {
	config?: { plugins?: Record<string, { enabled?: boolean; settings?: Record<string, unknown> }> };
}

function LlmPicker({
	value,
	onChange,
	models,
}: {
	value: LlmSel;
	onChange: (v: LlmSel) => void;
	models: ModelsResponse | null;
}) {
	const all = models?.models ?? [];
	const providerNames = [...new Set(all.map((m) => m.provider))];
	const provider = value.provider ?? "";
	const modelOptions = all.filter((m) => m.provider === provider);
	return (
		<div className="draw-params-grid">
			<Field label="provider">
				<select className="panel-search" value={provider} onChange={(e) => onChange({ provider: e.target.value, model: "" })}>
					<option value="">（跟随剧情模型）</option>
					{providerNames.map((p) => (
						<option key={p} value={p}>
							{p}
						</option>
					))}
				</select>
			</Field>
			<Field label="model">
				<select className="panel-search" value={value.model ?? ""} onChange={(e) => onChange({ ...value, model: e.target.value })}>
					<option value="">（默认）</option>
					{modelOptions.map((m) => (
						<option key={m.id} value={m.id}>
							{m.name || m.id}
						</option>
					))}
				</select>
			</Field>
		</div>
	);
}

function DrawLlmSection({ toast }: { toast: ToastFn }) {
	const { busy, run } = useAction(toast);
	const config = usePanelData(() => apiGet<ConfigLite>("/api/config"), { cacheKey: "/api/config" });
	const models = usePanelData(() => apiGet<ModelsResponse>("/api/models"), { cacheKey: "/api/models" });

	const settings = (config.data?.config?.plugins?.["draw-pipeline"]?.settings ?? {}) as DrawPluginSettings;
	const [llm, setLlm] = useState<LlmSel>({});
	const [vision, setVision] = useState<LlmSel>({});
	const seeded = useRef(false);

	// 配置异步到达后初始化草稿（仅一次，避免覆盖用户输入）
	useEffect(() => {
		if (seeded.current || !config.data) return;
		seeded.current = true;
		setLlm(settings.llm ?? {});
		setVision(settings.visionLlm ?? {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [config.data]);

	const save = () =>
		run(async () => {
			const plugins = { ...(config.data?.config?.plugins ?? {}) };
			const dp = { ...(plugins["draw-pipeline"] ?? {}) };
			const curSettings = (dp.settings ?? {}) as DrawPluginSettings;
			dp.settings = { ...curSettings, llm, visionLlm: vision };
			plugins["draw-pipeline"] = dp;
			await apiPut("/api/config", { plugins });
			config.reload();
		}, "LLM 配置已保存");

	return (
		<div className="draw-modal-section">
			<h4 className="draw-modal-sec-title">LLM 配置</h4>
			<div className="field-hint">生图管线规划与增强/识图所用模型；留空跟随剧情模型。</div>

			<div className="sp-section">
				<div className="draw-sub-title">规划 LLM（旁路管线场景规划）</div>
				<LlmPicker value={llm} onChange={setLlm} models={models.data} />
			</div>

			<div className="sp-section">
				<div className="draw-sub-title">增强 / 识图 LLM</div>
				<LlmPicker value={vision} onChange={setVision} models={models.data} />
			</div>

			<div className="panel-row">
				<button type="button" className="drawer-btn save-btn" disabled={busy} onClick={() => void save()}>
					保存 LLM 配置
				</button>
			</div>
		</div>
	);
}

// ---------- 主浮动窗口 ----------

export function DrawSettingsModal({
	toast,
	roleEnabled,
	editEnabled,
	onClose,
	initialSection,
}: {
	toast: ToastFn;
	charName?: string;
	worldState?: WorldState | null;
	roleEnabled: boolean;
	editEnabled: boolean;
	onClose: () => void;
	/** 打开时预选的板块（默认「快速测试」）；若该板块不可见则回退默认 */
	initialSection?: SectionId;
}) {
	const [active, setActive] = useState<SectionId>("quick");

	const nav: { id: SectionId; label: string; icon: typeof IconPlay; show: boolean }[] = [
		{ id: "quick", label: "快速测试", icon: IconPlay, show: true },
		{ id: "params", label: "绘图参数", icon: IconPreset, show: true },
		{ id: "llm", label: "LLM 配置", icon: IconModel, show: true },
		{ id: "tags", label: "角色标签", icon: IconCard, show: roleEnabled },
		{ id: "gallery", label: "图片管理", icon: IconImage, show: editEnabled },
	];
	const visible = nav.filter((n) => n.show);
	const current = visible.some((n) => n.id === active) ? active : "quick";

	// 初始定位：仅挂载一次；传入的板块不可见时保持默认「快速测试」
	const seededRef = useRef(false);
	useEffect(() => {
		if (seededRef.current) return;
		seededRef.current = true;
		if (initialSection && visible.some((n) => n.id === initialSection)) {
			setActive(initialSection);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return createPortal(
		<div className="draw-modal" onClick={onClose}>
			<div className="draw-modal-dialog" onClick={(e) => e.stopPropagation()}>
				<div className="draw-modal-head">
					<span className="draw-modal-title">生图设置</span>
					<span className="chip chip-cap">总览</span>
					<span style={{ flex: 1 }} />
					<button type="button" className="act" title="关闭" onClick={onClose}>
						<IconClose size={15} />
					</button>
				</div>
				<div className="draw-modal-body">
					<nav className="draw-modal-nav">
						{visible.map((n) => {
							const Icon = n.icon;
							return (
								<button
									key={n.id}
									type="button"
									className={`draw-modal-nav-item${current === n.id ? " active" : ""}`}
									onClick={() => setActive(n.id)}
								>
									<Icon size={15} /> {n.label}
								</button>
							);
						})}
					</nav>
					<div className="draw-modal-content">
						{current === "quick" && <QuickTestSection toast={toast} />}
						{current === "params" && <DrawParamsSection toast={toast} />}
						{current === "llm" && <DrawLlmSection toast={toast} />}
						{current === "tags" && roleEnabled && <CharacterTagsSection toast={toast} />}
						{current === "gallery" && editEnabled && <GallerySection />}
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
