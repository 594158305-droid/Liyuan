/**
 * DSH 式双阶段工具暴露（参照 xiaobright/dsh-anchored-standard）。
 *
 * 背景：DeepSeek V4 Pro 强依赖 API 中**可见的工具目录**选择执行轨迹——全量工具
 * 一上来就摆满时它会纠结/选错路径（评测：全量起步 91/92 分，Minimal 起步 98/99）。
 * 故：会话早期只暴露最小工具集，等会话历史里出现**首次工具调用**后，下一轮请求
 * 放开全量工具；状态从持久会话记录推导（resume/reload 不丢），目录全程只变一次。
 *
 * 两侧共用本模块的判定：
 * - 剧情侧（src/stage/engine.ts）：晋升标记 = 会话树 `rp-tool-staged` 协议条目
 *   （rp-summary 同款 CustomEntry，不进送模流、不进历史）；Minimal 集 = 读侧 + 规划。
 * - 助手/自定义 agent 侧（server/assistant.ts）：晋升判据 = 消息历史里的 toolCall 块；
 *   Minimal 集 = read/bash/return_answer。
 *
 * 本模块只放纯函数与常量，测试可离线单测（test/tool-staging.test.ts）。
 */

import { unifiedStageToolNames } from "./tools/adapters/stage.ts";
import type { StageTool, StageToolDeps } from "./stage/tools.ts";

/** 启用双阶段工具暴露的模型 id（集中管理，将来可提配置） */
export const STAGED_MODELS: ReadonlySet<string> = new Set(["deepseek-v4-pro"]);

/** 是否对某模型启用 staging——非目标模型一律 false，行为与现状完全一致 */
export const isStagedModel = (modelId: string | undefined): boolean => !!modelId && STAGED_MODELS.has(modelId);

/** 剧情侧晋升标记的会话树条目类型（CustomEntry：不进 pi 上下文，装配由引擎自管） */
export const TOOL_STAGED_ENTRY_TYPE = "rp-tool-staged";

/**
 * 助手/自定义 agent 侧最小工具集（DSH 原版 read/bash 语义）。
 * return_answer 必须保留——委托交回通道，去掉会致剧情侧永久等待。
 */
export const MINIMAL_STAGEHAND_TOOLS: readonly string[] = ["read", "bash", "return_answer"];

/**
 * 助手侧晋升判据：会话消息历史里是否已出现工具调用（DSH「从持久记录推导」，
 * resume/reload 后同一判据自动恢复全量，不丢状态）。
 * assistant 消息里的 toolCall 块是主判据；toolResult 消息（工具已执行）同样
 * 视为痕迹——异常树里丢失了发起消息时仍能推导。
 */
export function historyHasToolCall(messages: readonly unknown[]): boolean {
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const msg = m as { role?: string; content?: unknown; toolName?: string };
		if (msg.role === "toolResult" && msg.toolName) return true;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block && typeof block === "object" && (block as { type?: string }).type === "toolCall") return true;
		}
	}
	return false;
}

/**
 * 助手侧：计算当前应激活的工具名清单。
 * - 非目标模型 / 已晋升（历史已有工具调用）→ null = 维持现状全量；
 * - 未晋升 → 最小集与注册表（registry）的交集——白名单没放 read/bash/return_answer
 *   时交集变小，为空则 null（防激活空工具集，维持现状）。
 */
export function stagedToolNames(opts: {
	modelId: string | undefined;
	registryNames: readonly string[];
	promoted: boolean;
}): string[] | null {
	if (!isStagedModel(opts.modelId) || opts.promoted) return null;
	const minimal = MINIMAL_STAGEHAND_TOOLS.filter((n) => opts.registryNames.includes(n));
	return minimal.length > 0 ? minimal : null;
}

/**
 * 剧情侧：把当拍装配的全量工具裁剪成 Minimal 集——
 * 读侧（统一层世界书族/向量库族按注入裁剪 + 台上读侧两件 + writing_guide）+
 * 规划侧（beat_plan/beat_step_done）。
 * 规划工具必须保留：装配提示词点名「第 1 轮用 beat_plan 记路标」（assemble.ts），
 * 目录里没有会与提示词矛盾。写侧（draft_* / ask）与媒体 / 音效 / MCP / 助手委托
 * 全隐藏——首轮 V4 Pro 只能侦查与规划，首次工具调用后下一轮放开全量。
 */
export function minimalStageTools(tools: readonly StageTool[], readDeps?: StageToolDeps): StageTool[] {
	const keep = new Set<string>([
		...(readDeps ? [...unifiedStageToolNames(readDeps)] : []),
		"world_state_get",
		"table_query",
		"writing_guide",
		"beat_plan",
		"beat_step_done",
	]);
	return tools.filter((t) => keep.has(t.name));
}
