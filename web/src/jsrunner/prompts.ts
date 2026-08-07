/**
 * ST generateRaw 的 ordered_prompts 解析器（G2）。
 *
 * 纯 TS 模块：不 import 任何 DOM / ws / api / `?raw` 依赖，node --input-type=module
 * 可直跑冒烟（helper.ts 的 import 链含 runtime(`?raw`) 无法 node 加载，故独立成模块，
 * helper.ts 薄包装 re-export，对外接口一致）。
 *
 * ordered_prompts 是 ST 的「提示词槽位数组」：元素要么是 { role, content } 对象，
 * 要么是字符串占位符（'world_info_before' / 'persona_description' 等）。规则：
 * - 对象项：role==='system' → 拼入 systemPrompt（多条 \n\n 连接）；'user'/'assistant' → messages 追加
 * - 字符串占位符 'user_input' → 以哨兵消息标记位置，由调用方注入真实用户输入（见 injectUserInput）
 * - 字符串占位符 'chat_history' → 从 snapshot.chat 取最近 maxChatHistory 条（缺省全量），
 *   按时间序转 user/assistant 消息（只取 mes 正文）
 * - 其余占位符（world_info_before/persona_description/char_description/char_personality/
 *   scenario/world_info_after/dialogue_examples 及未知串）→ 跳过：Liyuan 无对应投影
 * - 结果顺序：systemPrompt 独立返回；messages 保持 ordered 数组顺序
 */

/** 解析结果：systemPrompt 在前（独立字段），messages 按 ordered 数组顺序 */
export interface OrderedPromptResult {
	systemPrompt?: string;
	messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/** 快照聊天投影形状（只读，取 getContext() 的 chat 数组） */
export interface SnapshotChatLike {
	mes: string;
	is_user: boolean;
}

/** 'user_input' 占位符在 messages 中的哨兵：调用方（injectUserInput / implGenerateRaw）替换为真实文本 */
export const USER_INPUT_SENTINEL = "\u0000jsrunner:user_input\u0000";

/** 已知但 Liyuan 无投影、解析时跳过的占位符 */
const SKIPPED_PLACEHOLDERS: ReadonlySet<string> = new Set([
	"world_info_before",
	"persona_description",
	"char_description",
	"char_personality",
	"scenario",
	"world_info_after",
	"dialogue_examples",
]);

export function parseOrderedPrompts(
	ordered: unknown[],
	snapshot: { chat: Array<SnapshotChatLike> },
	maxChatHistory?: number,
): OrderedPromptResult {
	const systemParts: string[] = [];
	const messages: OrderedPromptResult["messages"] = [];
	const limit =
		typeof maxChatHistory === "number" && Number.isFinite(maxChatHistory) && maxChatHistory > 0
			? Math.floor(maxChatHistory)
			: undefined;

	for (const item of ordered) {
		// 对象项：{ role, content }
		if (item && typeof item === "object") {
			const obj = item as { role?: unknown; content?: unknown };
			const role = typeof obj.role === "string" ? obj.role : "user";
			const content = typeof obj.content === "string" ? obj.content : String(obj.content ?? "");
			if (!content) continue;
			if (role === "system") {
				systemParts.push(content);
			} else if (role === "user" || role === "assistant") {
				messages.push({ role, content });
			}
			// 其它 role 忽略
			continue;
		}
		if (typeof item !== "string") continue;
		if (item === "user_input") {
			// 标记位置：调用方注入真实用户输入
			messages.push({ role: "user", content: USER_INPUT_SENTINEL });
			continue;
		}
		if (item === "chat_history") {
			const chat = limit !== undefined ? snapshot.chat.slice(-limit) : snapshot.chat;
			for (const c of chat) {
				messages.push({
					role: c.is_user ? "user" : "assistant",
					content: typeof c.mes === "string" ? c.mes : "",
				});
			}
			continue;
		}
		// 其余占位符（含未知串）：跳过——Liyuan 无对应投影
		if (SKIPPED_PLACEHOLDERS.has(item)) continue;
	}

	return {
		...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
		messages,
	};
}

/**
 * 把用户输入注入 messages：
 * - 有 'user_input' 哨兵 → 替换哨兵（注入该位，保持 ordered 位置）
 * - 无哨兵且 user_input 非空 → 追加末尾
 * - user_input 为空 → 清除哨兵（不注入空消息）
 */
export function injectUserInput(
	messages: OrderedPromptResult["messages"],
	userInput: unknown,
): OrderedPromptResult["messages"] {
	const text = typeof userInput === "string" ? userInput : "";
	if (!text.trim()) return messages.filter((m) => m.content !== USER_INPUT_SENTINEL);
	const hasSentinel = messages.some((m) => m.content === USER_INPUT_SENTINEL);
	if (hasSentinel) {
		return messages.map((m) =>
			m.content === USER_INPUT_SENTINEL ? { role: "user" as const, content: text } : m,
		);
	}
	return [...messages, { role: "user", content: text }];
}
