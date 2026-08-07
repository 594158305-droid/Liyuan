/**
 * JS Runner 协议契约（M3a）：脚本 iframe ↔ 宿主 window 的 postMessage 消息形状。
 *
 * M3b（TavernHelper 兼容层 / getContext）必须严格遵守本文件定义：
 * - 新增字段只能加「可选」字段，不得改现有字段名或类型；
 * - 所有消息走 `postMessage(msg, "*")`（srcdoc 帧 origin 是 opaque "null"，宿主按 event.source 校验）。
 *
 * 脚本条目存于 `GET/PUT /api/extdata?scope=global&key=scripts`（body `{value: unknown}`），
 * 字段名对齐 ST JS Runner 脚本模型。
 */

/** 脚本条目（与 ST JS Runner 脚本模型对齐） */
export interface ScriptMeta {
	id: string;
	name: string;
	content: string;
	enabled: boolean;
	/** 可选的说明文字 */
	info?: string;
	/** 脚本自定义按钮（name 显示名 + visible 是否可见） */
	buttons?: Array<{ name: string; visible: boolean }>;
}

/**
 * 脚本 iframe → 宿主 window 的 postMessage 请求。
 * - ready：脚本初始化完成，宿主标记该 iframe 可投递事件；
 * - log：脚本侧 console 输出透传（宿主转发到前端 console/面板）；
 * - invoke：调用宿主侧方法（M3b 的 RuntimeHost.onInvoke 分发，callId 用于配对回执）；
 * - event：脚本主动广播事件（如 eventEmit）。
 */
export type ScriptRequest =
	| { kind: "ready" }
	| { kind: "log"; level: "log" | "warn" | "error"; args: unknown[] }
	| { kind: "invoke"; method: string; args: unknown[]; callId: string }
	| { kind: "event"; name: string; args: unknown[] };

/**
 * getContext() 白名单快照（宿主推给 iframe，脚本同步读）。
 * 对齐 ST getContext() 的脚本常用字段；宿主（context.ts）从 hello/message 帧与
 * extdata 组装，脚本侧只读，不感知 wire 通道细节。
 */
export interface ContextSnapshot {
	/** 聊天消息投影：user 通道 is_user=true；narrative/greeting/import/backstage 为角色侧 is_user=false；其余通道 is_system=true */
	chat: Array<{ mes: string; is_user: boolean; is_system: boolean; name?: string; entryId?: string }>;
	/** 聊天级元数据（宿主 context.ts 维护权威值，脚本在快照副本上改后经 updateChatMetadata 显式落盘） */
	chat_metadata: Record<string, unknown>;
	/** 角色名 */
	name1: string;
	/** 用户名 */
	name2: string;
	/** 全局变量（getVar/setVar 同步面） */
	vars: Record<string, unknown>;
	/** 聊天级变量 */
	chatVars: Record<string, unknown>;
	/** 当前会话 id（hello 的 sessionId） */
	currentChatId?: string;
	/** 当前角色卡 id（G1：脚本读 characters[characterId] / this_chid）。Liyuan /api/card 无 id 字段，退而用卡文件路径作稳定标识 */
	characterId?: string;
	/** 人设描述（G1：ST powerUserSettings.persona_description 对应），来自 /api/personas 当前身份的 persona 文本 */
	personaDescription?: string;
	/** 全局扩展设置（G1：ST extensionSettings 面；postMessage 深拷贝，脚本改本地副本后经 saveSettingsDebounced 回传落盘） */
	extensionSettings?: Record<string, unknown>;
	/** 角色卡（当前卡即可，数组形式兼容脚本） */
	characters: Array<{
		name: string;
		description?: string;
		avatar?: string;
		firstMes?: string;
		extensions?: Record<string, unknown>;
	}>;
}

/**
 * 宿主 window → 脚本 iframe 的 postMessage。
 * - event：宿主广播扩展事件（MESSAGE_RECEIVED 等，由 bus 桥接进入）；
 * - invoke-result：对某 callId 的 invoke 回执（ok 决定成功值/错误文本）；
 * - reload：宿主要求脚本整体重载（脚本侧收到后应自复位）；
 * - context：宿主推送 getContext() 白名单快照（脚本同步读的源；也可经 invoke getContext 拉取）。
 */
export type HostMessage =
	| { kind: "event"; name: string; args: unknown[] }
	| { kind: "invoke-result"; callId: string; ok: boolean; value?: unknown; error?: string }
	| { kind: "reload" }
	| { kind: "context"; snapshot: ContextSnapshot };

/**
 * 宿主侧 invoke / log / event 分发器（M3b 注册到 runtime）。
 * 所有回调实现必须 try/catch 自兜底，脚本异常不得冒泡炸宿主。
 */
export interface RuntimeHost {
	/** 脚本 invoke 宿主方法：Promise 结果会回传给调用脚本（错误转成字符串回执） */
	onInvoke: (scriptId: string, method: string, args: unknown[]) => Promise<unknown>;
	/** 脚本 console 输出（level 透传，宿主按级别处理） */
	onLog: (scriptId: string, level: "log" | "warn" | "error", args: unknown[]) => void;
	/** 脚本主动广播事件 */
	onEvent: (scriptId: string, name: string, args: unknown[]) => void;
}
