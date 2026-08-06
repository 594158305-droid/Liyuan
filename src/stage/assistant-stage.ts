/**
 * 台上 assistant_run 工具（8/06 重接）：剧情 agent 委托右栏助手执行系统事务。
 *
 * 与 show_* / MCP 同源的断链——原本只挂在 `.liyuan/extensions/roleplay.ts`。
 * 领域层 `src/assistant-gateway.ts` 完好（globalThis 安全的 runner 注册表），
 * 缺的只是台上的工具定义和路由。
 *
 * 降级说明：旧实现有 `terminate: true`（pi API：纯办事后不再强制第二轮 LLM），
 * 台上 #agentLoop 无此机制——委托回来后模型还会走一轮空循环。实测影响很小
 * （模型看到「本轮可结束」就会停手），且用户随时可点停止。
 */

import { hasAssistantRunner, runAssistantTask, type AssistantRunResult } from "../assistant-gateway.ts";

/** StageTool 同形 */
export interface AssistantStageTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface AssistantStageResult {
	text: string;
	activity?: string;
	isError?: boolean;
	details?: Record<string, unknown>;
}

const STR = { type: "string" } as const;

/**
 * 工具定义。**助手 runner 未注册时不上清单**——依赖缺失的工具不上清单。
 */
export function assistantStageTool(): AssistantStageTool | null {
	if (!hasAssistantRunner()) return null;
	return {
		name: "assistant_run",
		description:
			"把一件**系统/运维/创作**事务委托给右栏助手执行（API 调用、生图、配置修改、诊断、技能笔记等）。" +
			"**不要用于剧情内创作**（角色性格、台词、场景设计由你自己写）。" +
			"传一段清晰的任务说明（含用户原意和必要上下文）。" +
			"如果用户同时要求继续剧情，把 continue_story 设为 true。",
		parameters: {
			type: "object",
			properties: {
				task: { ...STR, description: "交给助手的任务说明（含用户原意与所需上下文）" },
				mode: {
					type: "string",
					enum: ["ops", "author", "diagnose", "auto"],
					description: "ops=API/媒体/bash；author=面板/设定/状态；diagnose=调试配置；auto=默认",
				},
				continue_story: {
					type: "boolean",
					description: "true=助手做完后你还要续写剧情（混合请求）；false/省略=纯系统事务，做完即结束",
				},
			},
			required: ["task"],
		},
	};
}

/**
 * 执行。工具名不是 assistant_run 返回 null。
 *
 * 媒体交付的串联：助手如果生了图/音，结果里带 media[]。旧实现在扩展侧
 * 各自调 show_image/show_audio 落树——台上简化为把 media 附在 details 里，
 * 由引擎统一落 toolResult 条目（与 show_* 同一管线）。
 */
export async function runAssistantStageTool(
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<AssistantStageResult | null> {
	if (name !== "assistant_run") return null;

	const task = typeof args.task === "string" ? args.task.trim() : "";
	if (!task) return { text: "task 不能为空。", isError: true };

	const mode = typeof args.mode === "string" ? args.mode : "auto";
	const continueStory = args.continue_story === true;

	let r: AssistantRunResult;
	try {
		r = await runAssistantTask({ task, mode: mode as "ops", signal });
	} catch (err) {
		return {
			text: `助手委托失败：${err instanceof Error ? err.message : String(err)}`,
			isError: true,
			activity: "助手委托失败",
		};
	}

	const head = r.abandoned
		? "助手委托已放弃。"
		: r.ok
			? r.viaReturnTool
				? "助手已正式交回结果。"
				: "助手回合结束（未走 return_answer，以下为摘录）。"
			: "助手委托未成功。";
	const hint = continueStory
		? "（你要求继续剧情：可根据结果续写。）"
		: "（纯系统事务：结果已交回；本轮可结束。）";

	return {
		text: `${head}\n${r.summary}\n${hint}`,
		activity: r.ok ? "助手委托完成" : "助手委托未成功",
		details: {
			assistantRun: {
				ok: r.ok,
				abandoned: r.abandoned,
				viaReturnTool: r.viaReturnTool,
				continueStory,
			},
		},
	};
}
