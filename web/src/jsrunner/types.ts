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
import type { WorldState } from "../wire.ts";

/** 脚本条目（与 ST JS Runner 脚本模型对齐） */
export interface ScriptMeta {
	id: string;
	name: string;
	enabled: boolean;
	/**
	 * 脚本本体文件引用（/uploads/jsrunner/<id>.js 的文件名或完整相对路径，P0 拆文件存储）。
	 * 与 content 二选一：新导入脚本走 file（extdata 只存元数据 + 引用，绕开 1MB 上限）；
	 * content 为旧数据迁移兼容字段。
	 */
	file?: string;
	/** 附带数据文件列表（导入时登记；脚本 fetch('/uploads/jsrunner/<id>/assets/<name>') 引用） */
	assets?: string[];
	/** 共享区文件引用（V2-3：引用的 /uploads/ 共享文件；所有权全局，删除脚本不级联清理） */
	sharedAssets?: string[];
	/** 兼容字段（旧数据迁移后删除；V1 保留 content 可选，读取时 file 优先） */
	content?: string;
	/** 可选的说明文字 */
	info?: string;
	/** 脚本自定义按钮（name 显示名 + visible 是否可见） */
	buttons?: Array<{ name: string; visible: boolean }>;
}

/**
 * 账本面板注册规格（D4 §2.1，脚本经 registerLedgerPanel 上报，宿主 LedgerScriptViews 渲染）。
 * 所有字段可选（title 除外——helper 侧强制非空）；V2 扩展区域（V2-4）与 tab 位置（V2-5）。
 */
export interface LedgerPanelSpec {
	/** 面板标题（面板头显示；helper 侧 trim + 非空校验） */
	title: string;
	/** 可选：标题栏图标（emoji/文本，宿主渲染） */
	icon?: string;
	/** 挂载区域，默认 "status"（V2-4：扩展 left/top/right 顶栏/侧栏挂载点） */
	area?: "status" | "roster" | "left" | "top" | "right";
	/**
	 * 位置（V2-5）："append" 追加面板（默认）；"tab" 进入 status 区域账本卡片顶部
	 * tab 条接管视图（[标准] [脚本A] [脚本B]；同一 status 区域至多一个 tab 面板）。
	 */
	position?: "append" | "tab";
	/**
	 * 可选，覆盖默认高度上限（status/roster 默认 480px；left/top/right 区域默认自然高，
	 * 指定本值才钳制；tab 面板永不钳制）。
	 */
	maxHeight?: number;
}

/**
 * 状态栏内容槽（C 路径 L2，宿主 React 原生渲染脚本推送的结构化内容——非 iframe 内嵌）。
 * 脚本经 TavernHelper.setStatusCardSlots 推送；宿主在 StatusStrip .status-card 内容槽区
 * 按序渲染：fields→只读 kv 行、badges→徽章行、buttons→动作按钮行（点击回传脚本
 * STATUS_CARD_ACTION 事件，args `{ key }`）。
 */
export type StatusCardSlot =
	| { type: "fields"; items: Array<{ label: string; value: string }> }
	| { type: "badges"; items: Array<{ label: string; icon?: string }> }
	| { type: "buttons"; items: Array<{ label: string; key: string; icon?: string }> };

/**
 * 脚本 iframe → 宿主 window 的 postMessage 请求。
 * - ready：脚本初始化完成，宿主标记该 iframe 可投递事件；
 * - log：脚本侧 console 输出透传（宿主转发到前端 console/面板）；
 * - invoke：调用宿主侧方法（M3b 的 RuntimeHost.onInvoke 分发，callId 用于配对回执）；
 * - event：脚本主动广播事件（如 eventEmit）；
 * - resize：bridge ResizeObserver 上报 iframe 内容高度（宿主驱动面板容器高度）；
 * - storage：脚本 localStorage 代理落盘（V2-6 sandbox 加固——opaque origin 无 storage，
 *   桥内内存副本 + 异步落宿主；op="get" 时宿主经 invoke-result 通道回执）。
 */
export type ScriptRequest =
	| { kind: "ready" }
	| { kind: "log"; level: "log" | "warn" | "error"; args: unknown[] }
	| { kind: "invoke"; method: string; args: unknown[]; callId: string }
	| { kind: "event"; name: string; args: unknown[] }
	| { kind: "resize"; height: number }
	| {
			kind: "storage";
			op: "get" | "set" | "remove" | "clear";
			/** set/remove/get 的目标键（get 时 "*" = 请求全量脚本可读快照） */
			key?: string;
			/** set 的写入值 */
			value?: string;
			/** op="get" 时携带：宿主经 invoke-result 回执配对（桥内 getItem 走缓存，通常不用） */
			callId?: string;
	  };

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
	/** 世界状态账本快照（hello/state 帧投影；未就绪时缺省） */
	worldState?: WorldState;
}

/**
 * 宿主 window → 脚本 iframe 的 postMessage。
 * - event：宿主广播扩展事件（MESSAGE_RECEIVED 等，由 bus 桥接进入）；
 * - invoke-result：对某 callId 的 invoke 回执（ok 决定成功值/错误文本）；
 * - reload：宿主要求脚本整体重载（脚本侧收到后应自复位）；
 * - context：宿主推送 getContext() 白名单快照（脚本同步读的源；也可经 invoke getContext 拉取）。
 * - theme：宿主推送主题 token（--ly-* CSS 变量，bridge 侧写进自身 documentElement）。
 * - storage-snapshot：宿主推送脚本可读 localStorage 快照（V2-6：桥内内存副本初始化源）。
 */
export type HostMessage =
	| { kind: "event"; name: string; args: unknown[] }
	| { kind: "invoke-result"; callId: string; ok: boolean; value?: unknown; error?: string }
	| { kind: "reload" }
	| { kind: "context"; snapshot: ContextSnapshot }
	| { kind: "theme"; tokens: Record<string, string> }
	| { kind: "storage-snapshot"; data: Record<string, string> };

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
