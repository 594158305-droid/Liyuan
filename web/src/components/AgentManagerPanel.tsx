/**
 * 自定义 Agent 管理面板（右栏）：列表 / 新建 / 编辑 三态。
 * 与 PowersPanel / SettingsPanel 共用同一套表单原子与面板语义。
 */

import { useMemo, useState } from "react";
import { apiGet, apiPut, type ModelsResponse } from "../api.ts";
import { IconClose, IconPencil, IconTrash } from "./icons.tsx";
import { ConfirmButton, Field, PanelStatus, Toggle, useAction, usePanelData } from "./kit.tsx";

/** 桥权限：8 个对剧情世界的操作开关 */
type AgentBridge = {
	readStory?: boolean;
	writePanels?: boolean;
	storyEdit?: boolean;
	queueCommand?: boolean;
	applyStatePatch?: boolean;
	emitMedia?: boolean;
	refreshMaterials?: boolean;
	mountCodex?: boolean;
};

/** 自定义 agent 配置条目（与 liyuan.config.json 的 agents 段对齐） */
type AgentConfig = {
	id: string;
	name: string;
	description?: string;
	model?: { provider: string; id: string };
	prompt?: string;
	promptFile?: string;
	skills?: string[];
	tools?: string[];
	bridge?: AgentBridge;
};

interface AgentManagerPanelProps {
	onClose: () => void;
	onAgentsChanged: () => void;
	toast: (level: "info" | "warning" | "error", text: string) => void;
}

/** 内置助手占位行（仅展示，不可编辑） */
const BUILTIN_ASSISTANT: AgentConfig = {
	id: "assistant",
	name: "助手",
	description: "内置系统助手，处理系统事务与剧情委托。",
};

/** 桥权限定义：显示名 + 说明 + 是否危险 */
const BRIDGE_KEYS: Array<{ key: keyof AgentBridge; label: string; hint: string; danger: boolean }> = [
	{ key: "readStory", label: "读取剧情", hint: "只读，建议开", danger: false },
	{ key: "writePanels", label: "写入面板", hint: "", danger: false },
	{ key: "storyEdit", label: "改写剧情回复", hint: "危险", danger: true },
	{ key: "queueCommand", label: "触发剧情命令", hint: "危险", danger: true },
	{ key: "applyStatePatch", label: "修改状态账本", hint: "危险", danger: true },
	{ key: "emitMedia", label: "发送媒体", hint: "", danger: false },
	{ key: "refreshMaterials", label: "刷新素材", hint: "", danger: false },
	{ key: "mountCodex", label: "挂载知识库", hint: "", danger: false },
];

/** 根据 agentReload 状态生成保存/删除后的提示文案 */
function agentReloadText(
	map: Record<string, "ok" | "busy" | "removed">,
	okText: string,
): string {
	const busy = Object.entries(map)
		.filter(([, v]) => v === "busy")
		.map(([k]) => k);
	if (busy.length) {
		return `已保存；忙碌中的 agent（${busy.join("、")}）将在重启后生效`;
	}
	return okText;
}

export function AgentManagerPanel({ onClose, onAgentsChanged, toast }: AgentManagerPanelProps) {
	const {
		data: configData,
		error: configError,
		loading: configLoading,
		reload: reloadConfig,
	} = usePanelData(() => apiGet<{ config?: { agents?: AgentConfig[] } }>("/api/config"), {
		cacheKey: "/api/config",
	});
	const { data: modelsData } = usePanelData(() => apiGet<ModelsResponse>("/api/models"), {
		cacheKey: "/api/models",
	});
	const { data: toolsData } = usePanelData(() => apiGet<{ tools: string[] }>("/api/agent-tools"), {
		cacheKey: "/api/agent-tools",
	});
	const { busy, run } = useAction(toast);

	const [mode, setMode] = useState<"list" | "create" | "edit">("list");
	const [editingId, setEditingId] = useState<string | null>(null);

	// 表单字段
	const [id, setId] = useState("");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [model, setModel] = useState<{ provider: string; id: string } | undefined>(undefined);
	const [prompt, setPrompt] = useState("");
	const [promptFile, setPromptFile] = useState<string | undefined>(undefined);
	const [tools, setTools] = useState<string[]>(["return_answer", "ask_user", "story_read"]);
	const [bridge, setBridge] = useState<AgentBridge>({
		readStory: true,
		writePanels: false,
		storyEdit: false,
		queueCommand: false,
		applyStatePatch: false,
		emitMedia: false,
		refreshMaterials: false,
		mountCodex: false,
	});

	const customAgents = configData?.config?.agents ?? [];
	const allTools = toolsData?.tools ?? [];

	const modelGroups = useMemo(() => {
		const map = new Map<string, Array<{ value: string; label: string }>>();
		for (const m of modelsData?.models ?? []) {
			const arr = map.get(m.providerName) ?? [];
			arr.push({ value: `${m.provider} ${m.id}`, label: m.name || m.id });
			map.set(m.providerName, arr);
		}
		return [...map.entries()];
	}, [modelsData]);

	const modelValue = model ? `${model.provider} ${model.id}` : "";

	const resetToCreate = () => {
		setEditingId(null);
		setId("");
		setName("");
		setDescription("");
		setModel(undefined);
		setPrompt("");
		setPromptFile(undefined);
		setTools(["return_answer", "ask_user", "story_read"]);
		setBridge({
			readStory: true,
			writePanels: false,
			storyEdit: false,
			queueCommand: false,
			applyStatePatch: false,
			emitMedia: false,
			refreshMaterials: false,
			mountCodex: false,
		});
		setMode("create");
	};

	const startEdit = (agent: AgentConfig) => {
		setEditingId(agent.id);
		setId(agent.id);
		setName(agent.name);
		setDescription(agent.description ?? "");
		setModel(agent.model);
		setPrompt(agent.prompt ?? "");
		setPromptFile(agent.promptFile);
		setTools(agent.tools ?? []);
		setBridge({
			readStory: false,
			writePanels: false,
			storyEdit: false,
			queueCommand: false,
			applyStatePatch: false,
			emitMedia: false,
			refreshMaterials: false,
			mountCodex: false,
			...agent.bridge,
		});
		setMode("edit");
	};

	const toggleTool = (tool: string) => {
		setTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]));
	};

	const handleModelChange = (value: string) => {
		if (!value) {
			setModel(undefined);
			return;
		}
		const idx = value.indexOf(" ");
		const provider = idx > 0 ? value.slice(0, idx) : value;
		const id = idx > 0 ? value.slice(idx + 1) : "";
		setModel({ provider, id });
	};

	const buildAgent = (): AgentConfig => {
		const base = editingId ? customAgents.find((a) => a.id === editingId) : undefined;
		const next: AgentConfig = {
			...(base ? { ...base } : {}),
			id: id.trim(),
			name: name.trim(),
			description: description.trim() || undefined,
			...(model ? { model } : {}),
			prompt,
			tools,
			bridge,
		};
		if (!next.description) delete (next as Record<string, unknown>).description;
		if (!model) delete (next as Record<string, unknown>).model;
		delete (next as Record<string, unknown>).promptFile;
		return next;
	};

	const validate = () => {
		const cleanId = id.trim();
		if (!cleanId) throw new Error("ID 不能为空");
		if (!/^[a-z0-9-]+$/.test(cleanId)) throw new Error("ID 只能包含小写字母、数字和连字符");
		if (cleanId === "assistant") throw new Error("ID 不能为 assistant");
		if (customAgents.some((a) => a.id === cleanId && a.id !== editingId)) {
			throw new Error("ID 已存在");
		}
		if (!name.trim()) throw new Error("显示名不能为空");
	};

	const ensureRequiredTools = (): string[] => {
		const required = ["return_answer", "ask_user"].filter(
			(t) => !tools.includes(t) && allTools.includes(t),
		);
		if (required.length) {
			setTools((prev) => [...prev, ...required]);
			toast("warning", `已自动勾选 ${required.join("、")}（委托回传必需）`);
		}
		return [...tools, ...required];
	};

	const save = () =>
		run(async () => {
			validate();
			const finalTools = ensureRequiredTools();
			const next = buildAgent();
			next.tools = finalTools;
			const nextAgents = editingId
				? customAgents.map((a) => (a.id === editingId ? next : a))
				: [...customAgents, next];
			const r = await apiPut<{ config: { agents?: AgentConfig[] }; agentReload: Record<string, "ok" | "busy" | "removed"> }>("/api/config", {
				agents: nextAgents,
			});
			toast("info", agentReloadText(r.agentReload, "已保存并生效"));
			reloadConfig();
			onAgentsChanged();
			setMode("list");
		});

	const doDelete = () =>
		run(async () => {
			if (!editingId) return;
			const nextAgents = customAgents.filter((a) => a.id !== editingId);
			const r = await apiPut<{ config: { agents?: AgentConfig[] }; agentReload: Record<string, "ok" | "busy" | "removed"> }>("/api/config", {
				agents: nextAgents,
			});
			toast("info", agentReloadText(r.agentReload, "已删除并生效"));
			reloadConfig();
			onAgentsChanged();
			setMode("list");
		});

	const listHeader = (
		<div className="panel-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
			<h4 style={{ margin: 0, border: "none", padding: 0 }}>自定义 Agent</h4>
			<button type="button" className="act" onClick={onClose} title="关闭面板" aria-label="关闭面板">
				<IconClose size={13} />
			</button>
		</div>
	);

	const formHeader = (title: string) => (
		<div className="panel-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
			<h4 style={{ margin: 0, border: "none", padding: 0 }}>{title}</h4>
			<button type="button" className="act" onClick={() => setMode("list")} title="返回列表" aria-label="返回列表">
				<IconClose size={13} />
			</button>
		</div>
	);

	return (
		<div className="panel-body">
			<PanelStatus loading={configLoading} error={configError} hasData={!!configData} />
			{configData && mode === "list" && (
				<section className="sp-section" style={{ marginTop: 0 }}>
					{listHeader}
					<div className="field-hint">
						管理自定义 agent：修改提示词、可用工具与桥权限。内置助手不可编辑。
					</div>
					<div className="panel-row">
						<button type="button" className="drawer-btn primary" onClick={resetToCreate}>
							＋ 新建
						</button>
					</div>

					{/* 内置助手行 */}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 8,
							padding: "8px 0",
							borderBottom: "1px solid var(--hairline)",
							opacity: 0.75,
						}}
					>
						<div style={{ flex: 1, minWidth: 0 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<span style={{ fontSize: 13, fontWeight: 600 }}>{BUILTIN_ASSISTANT.name}</span>
								<span className="chip">内置</span>
							</div>
							<div className="field-hint">{BUILTIN_ASSISTANT.description}</div>
							<code className="field-hint" style={{ fontSize: 11 }}>
								{BUILTIN_ASSISTANT.id}
							</code>
						</div>
					</div>

					{/* 自定义 agent 列表 */}
					{customAgents.length === 0 && (
						<div className="sp-empty">还没有自定义 agent，点上方新建。</div>
					)}
					{customAgents.map((a) => (
						<div
							key={a.id}
							style={{
								display: "flex",
								alignItems: "flex-start",
								gap: 8,
								padding: "8px 0",
								borderBottom: "1px solid var(--hairline)",
							}}
						>
							<div style={{ flex: 1, minWidth: 0 }}>
								<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
									<span style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</span>
									{a.description && (
										<span className="field-hint" style={{ margin: 0 }}>
											{a.description}
										</span>
									)}
								</div>
								<code className="field-hint" style={{ fontSize: 11 }}>
									{a.id}
								</code>
							</div>
							<div className="panel-row" style={{ margin: 0, flexWrap: "nowrap" }}>
								<button type="button" className="act" onClick={() => startEdit(a)}>
									<IconPencil size={12} /> 编辑
								</button>
							</div>
						</div>
					))}
				</section>
			)}

			{configData && (mode === "create" || mode === "edit") && (
				<section className="sp-section" style={{ marginTop: 0 }}>
					{formHeader(mode === "create" ? "新建自定义 Agent" : `编辑：${name || editingId}`)}

					<Field
						label="ID"
						hint="小写字母/数字/连字符，用于剧情委托引用（assistant_run 的 agent 参数），创建后不可改"
					>
						<input
							className="panel-search"
							type="text"
							value={id}
							disabled={mode === "edit" || busy}
							placeholder="如 scene-writer"
							onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
						/>
					</Field>

					<Field label="显示名">
						<input
							className="panel-search"
							type="text"
							value={name}
							disabled={busy}
							placeholder="如 场景写手"
							onChange={(e) => setName(e.target.value)}
						/>
					</Field>

					<Field label="描述">
						<input
							className="panel-search"
							type="text"
							value={description}
							disabled={busy}
							placeholder="一句话说明用途（可选）"
							onChange={(e) => setDescription(e.target.value)}
						/>
					</Field>

					<Field label="模型">
						<select
							className="panel-search"
							value={modelValue}
							disabled={busy}
							onChange={(e) => handleModelChange(e.target.value)}
							style={{ marginBottom: 0 }}
						>
							<option value="">跟随剧情模型</option>
							{modelGroups.map(([providerName, items]) => (
								<optgroup key={providerName} label={providerName}>
									{items.map((it) => (
										<option key={it.value} value={it.value}>
											{it.label}
										</option>
									))}
								</optgroup>
							))}
						</select>
					</Field>

					<Field label="系统提示词" hint="定义该 agent 的职责、风格与边界。会以 system prompt 注入">
						<textarea
							className="panel-search ta"
							rows={10}
							value={prompt}
							disabled={busy}
							placeholder="你是…"
							onChange={(e) => setPrompt(e.target.value)}
						/>
						{promptFile && (
							<div className="field-hint">
								当前使用文件提示词（promptFile: {promptFile}），保存后将改为内联提示词
							</div>
						)}
					</Field>

					<div className="field" style={{ margin: "10px 0" }}>
						<span className="field-label">可用工具</span>
						<span className="field-hint">不勾选 = 不提供该工具</span>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
								gap: 8,
								margin: "8px 0",
							}}
						>
							{allTools.length === 0 && <span className="field-hint">加载中…</span>}
							{allTools.map((t) => (
								<label
									key={t}
									style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}
								>
									<input
										type="checkbox"
										checked={tools.includes(t)}
										disabled={busy}
										onChange={() => toggleTool(t)}
									/>
									<code style={{ fontSize: 12 }}>{t}</code>
								</label>
							))}
						</div>
					</div>

					<div className="field" style={{ margin: "10px 0" }}>
						<span className="field-label">桥权限（对剧情世界的操作权）</span>
						{BRIDGE_KEYS.map(({ key, label, hint, danger }) => (
							<div className="toggle-row" key={key}>
								<div style={{ minWidth: 0 }}>
									<div style={{ fontSize: 13 }}>
										{label}
										{danger && (
											<span style={{ color: "var(--accent-strong)", marginLeft: 6, fontSize: 12 }}>
												⚠ 危险
											</span>
										)}
									</div>
									{hint && (
										<div className="field-hint" style={{ margin: 0 }}>
											{hint}
										</div>
									)}
								</div>
								<Toggle
									checked={!!bridge[key]}
									disabled={busy}
									onChange={(v) => setBridge((b) => ({ ...b, [key]: v }))}
								/>
							</div>
						))}
					</div>

					<div className="panel-row" style={{ flexWrap: "wrap", marginTop: 16 }}>
						<button
							type="button"
							className="drawer-btn primary"
							disabled={busy || !id.trim() || !name.trim()}
							onClick={() => void save()}
						>
							{busy ? "保存中…" : "保存"}
						</button>
						<button type="button" className="drawer-btn" disabled={busy} onClick={() => setMode("list")}>
							取消
						</button>
						{mode === "edit" && editingId && (
							<ConfirmButton
								confirmText={`删除 agent『${name || editingId}』？该操作立即生效，不可撤销`}
								className="drawer-btn danger"
								disabled={busy}
								onConfirm={() => void doDelete()}
							>
								<IconTrash size={12} /> 删除
							</ConfirmButton>
						)}
					</div>
				</section>
			)}
		</div>
	);
}
