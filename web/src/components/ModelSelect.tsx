/**
 * 模型选择（2026-08-15，模型配置归一）：主聊天 / 旁路 / 助手三处共用的模型选择。
 *
 * 数据源：/api/models 的 allModels（全量渠道 + ready 标记）——「一份列表」：
 * 已配 key 的渠道正常可选，未配 key 的置灰标注「（未配 key）」（当前已选中的
 * 未认证项不置灰，保持可见可保存）。选哪个渠道/模型，对主聊天、旁路、助手都可见。
 *
 * 用法：
 * - 下拉形态：`<ModelSelect value={key} onChange={...} />`
 * - 列表形态（主聊天 ConnectPanel 用）：`useModelList()` 取同一份分组数据自行渲染
 */

import type { CSSProperties } from "react";
import { apiGet, type ModelsResponse } from "../api.ts";
import { usePanelData } from "./kit.tsx";

/** 按渠道分组的模型项（value 统一 "provider/id"） */
export interface ModelSelectItem {
	value: string;
	label: string;
	/** 该模型所属渠道是否已配 key（false = 置灰不可选） */
	ready: boolean;
}

export interface ModelGroup {
	/** 渠道键（provider id） */
	provider: string;
	providerName: string;
	/** 该渠道是否有任一已配 key 的模型（组标签用） */
	anyReady: boolean;
	items: ModelSelectItem[];
}

/** 共享模型列表 hook：三处模型选择的数据源（主聊天 / 旁路 / 助手） */
export function useModelList(): {
	groups: ModelGroup[];
	loading: boolean;
	reload: () => void;
} {
	const modelsData = usePanelData<ModelsResponse>(() => apiGet<ModelsResponse>("/api/models"), {
		cacheKey: "/api/models",
	});
	// allModels = 全量（含未配 key 的渠道）；旧服务端无该字段时回退 models（已认证）
	const list = modelsData.data?.allModels ?? modelsData.data?.models ?? [];
	const map = new Map<string, ModelGroup>();
	for (const m of list) {
		let g = map.get(m.provider);
		if (!g) {
			g = { provider: m.provider, providerName: m.providerName ?? m.provider, anyReady: false, items: [] };
			map.set(m.provider, g);
		}
		const ready = m.ready !== false;
		g.items.push({ value: `${m.provider}/${m.id}`, label: m.name || m.id, ready });
		if (ready) g.anyReady = true;
	}
	return { groups: [...map.values()], loading: modelsData.loading, reload: modelsData.reload };
}

export interface ModelSelectProps {
	/** 当前选中 "provider/id"；空串 = 跟随剧情/对话模型 */
	value: string;
	/** 用户选了可用模型（provider/id）；传 null = 回到跟随 */
	onChange: (sel: { provider: string; id: string } | null) => void;
	/** 空选项文案（跟随剧情模型 / 跟随对话模型） */
	emptyLabel?: string;
	disabled?: boolean;
	className?: string;
	title?: string;
	ariaLabel?: string;
	style?: CSSProperties;
}

/** 统一模型下拉（旁路 / 助手用；主聊天列表形态见 ConnectPanel 同源渲染） */
export function ModelSelect({
	value,
	onChange,
	emptyLabel = "跟随剧情模型",
	disabled,
	className,
	title,
	ariaLabel,
	style,
}: ModelSelectProps) {
	const { groups } = useModelList();
	return (
		<select
			className={className}
			value={value}
			disabled={disabled}
			onChange={(e) => {
				const v = e.target.value;
				if (!v) {
					onChange(null);
					return;
				}
				// value 形如 "provider/id"——但 id 本身可能含 "/"（如 openrouter 的
				// google/gemini-3.7-flash）：第一段是 provider，其余全部拼回 id
				const [provider, ...rest] = v.split("/");
				const id = rest.join("/");
				if (provider && id) onChange({ provider, id });
			}}
			title={title}
			aria-label={ariaLabel}
			style={style}
		>
			<option value="">{emptyLabel}</option>
			{groups.map((g) => (
				<optgroup key={g.provider} label={`${g.providerName}（${g.anyReady ? "已配 key" : "未配 key"}）`}>
					{g.items.map((it) => (
						<option key={it.value} value={it.value} disabled={!it.ready && it.value !== value}>
							{it.label}
							{!it.ready ? "（未配 key）" : ""}
						</option>
					))}
				</optgroup>
			))}
		</select>
	);
}
