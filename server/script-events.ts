/**
 * 脚本运行时扩展（JS Runner）事件桥 — pi 会话事件 → SillyTavern 风格事件帧。
 *
 * 纯函数模块：零 pi import、零副作用、可独立测试。
 * 前端脚本总线约定：收到 ServerFrame `{ type: "ext_event"; name; args }` 即转发给脚本；
 * 本模块负责把 pi 会话事件翻译成 ST 脚本习惯的事件名与简化载荷。
 *
 * 事件名以实际源码为准（packages/coding-agent/src/core/extensions/types.ts 的 ExtensionAPI.on
 * 事件清单，以及 node_modules/@liyuan/agent-core/src/types.ts 的 AgentEvent）：
 * session_start / turn_start / turn_end / message_end / input 等。
 * 注：session_start 与 input 只发给扩展处理器（extensionRunner），不流经 session.subscribe；
 * 本模块仍保留映射（函数可直接被调用/测试），session.subscribe 路径实际到账的是
 * turn_start / turn_end / message_end 等 AgentEvent。
 */

/** ST 事件帧：name 为 ST 脚本习惯的事件名，args 为简化投影载荷 */
export type StEventFrame = { name: string; args: unknown[] };

/** 从消息 content（字符串或内容块数组）提取纯文本（仿 wire.ts 的 textOf；thinking/toolCall 块丢弃） */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: unknown }).type === "text"
				? String((p as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

/**
 * 消息投影（MESSAGE_SENT / MESSAGE_RECEIVED 的 args）：{ mes, is_user, name, entryId? }。
 * - mes：content 纯文本；is_user：role 是否为 user
 * - name：事件载荷里没有显示名（角色名/用户名由前端总线持有），给按角色的默认名
 * - entryId：消息载荷无会话树条目 id，暂不输出
 */
function messageProjection(msg: unknown): { mes: string; is_user: boolean; name: string; entryId?: string } {
	const role = (msg as { role?: unknown } | null)?.role;
	const isUser = role === "user";
	return {
		mes: textOf((msg as { content?: unknown } | null)?.content),
		is_user: isUser,
		name: isUser ? "You" : "",
	};
}

/**
 * pi 会话事件 → ST 风格事件帧列表。
 * 一个 pi 事件可展开 0..n 个 ST 事件；无对等映射返回空数组。
 */
export function mapPiEventsToSt(piEvent: { name: string; data: unknown }): StEventFrame[] {
	switch (piEvent.name) {
		// 会话启动/加载/重载 → 前端全量重拉聊天
		case "session_start": {
			const sessionId = (piEvent.data as { sessionId?: unknown } | null)?.sessionId;
			return [{ name: "CHAT_CHANGED", args: [typeof sessionId === "string" ? { sessionId } : {}] }];
		}
		// 回合开始/结束（一次助手回复 + 工具调用）
		case "turn_start":
			return [{ name: "GENERATION_STARTED", args: [] }];
		case "turn_end":
			return [{ name: "GENERATION_ENDED", args: [] }];
		// 消息落定：user → MESSAGE_SENT，assistant → MESSAGE_RECEIVED；其余角色（custom/toolResult 等）无对等
		case "message_end": {
			const msg = (piEvent.data as { message?: unknown } | null)?.message;
			const role = (msg as { role?: unknown } | null)?.role;
			if (role === "user") return [{ name: "MESSAGE_SENT", args: [messageProjection(msg)] }];
			if (role === "assistant") return [{ name: "MESSAGE_RECEIVED", args: [messageProjection(msg)] }];
			return [];
		}
		// 用户输入受理（input 事件只发扩展处理器，不流经 session.subscribe；此处保留映射供直接调用/测试）
		case "input": {
			const text = (piEvent.data as { text?: unknown } | null)?.text;
			return [
				{
					name: "MESSAGE_SENT",
					args: [{ mes: typeof text === "string" ? text : "", is_user: true, name: "You" }],
				},
			];
		}
		// tool_call / tool_result / agent_start / agent_end / message_start / compaction_* 等无 ST 对等
		default:
			return [];
	}
}
