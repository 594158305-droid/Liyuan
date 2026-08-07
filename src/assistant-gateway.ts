/**
 * 剧情 agent ↔ 右栏 agent（助手/自定义 agent）的进程内网关
 * （P0：助手工具化；P3：单 runner slot → 按 name 路由的多 agent 注册表）。
 *
 * main 在启动对应 agent Host 后 register；roleplay 的 assistant_run 工具通过本模块调用。
 * 扩展与 server 解耦：扩展不 import server/*，只依赖本纯注册表。
 *
 * 【双模块陷阱】roleplay 由 jiti 加载（tryNative:false），main 走 Node 原生 ESM，
 * 两边对同一文件会各得到一份 module scope。runners / delegateDepth 必须挂在
 * globalThis 上，否则 register 写进 A、execute 读 B → 永远「agent 不可用」。
 */

export type AssistantRunMode = "ops" | "author" | "diagnose" | "auto";

export interface AssistantRunRequest {
	/** 交给助手的任务说明（含用户原意与必要上下文摘要） */
	task: string;
	mode?: AssistantRunMode;
	/** 是否附带剧情快照（默认 true） */
	needStoryContext?: boolean;
	signal?: AbortSignal;
}

export interface AssistantRunMedia {
	src: string;
	kind: "image" | "audio" | "video";
	caption?: string;
}

export interface AssistantRunResult {
	ok: boolean;
	/** 给剧情模型看的摘要（工具结果正文） */
	summary: string;
	/** 本轮助手交付到剧情流的媒体（若有） */
	media: AssistantRunMedia[];
	/** 是否已写入剧情侧面板 */
	panelsWritten: string[];
	/** 用户/助手通过 ask 选择放弃 */
	abandoned?: boolean;
	/** 是否由 return_answer 正式交回（否则为回合结束时的兜底摘录） */
	viaReturnTool?: boolean;
	error?: string;
}

export type AssistantRunner = (req: AssistantRunRequest) => Promise<AssistantRunResult>;

type GatewaySlot = {
	/** name → runner 注册表（"assistant" = 内置助手；自定义 agent 用配置 id，如 "director"） */
	runners: Record<string, AssistantRunner | null>;
	/**
	 * v1 互斥委托：全局深度计数，同一时刻最多一个剧情→agent 委托回合。
	 * v2 扩展方向：按 agent 隔离 delegate 状态，支持多 agent 并发委托。
	 */
	delegateDepth: number;
};

const SLOT_KEY = "__liyuanAssistantGateway__";

function slot(): GatewaySlot {
	const g = globalThis as typeof globalThis & { [SLOT_KEY]?: GatewaySlot };
	if (!g[SLOT_KEY]) {
		g[SLOT_KEY] = { runners: {}, delegateDepth: 0 };
	}
	return g[SLOT_KEY];
}

/** 兼容别名：注册内置助手（= registerAgentRunner("assistant", fn)） */
export function registerAssistantRunner(fn: AssistantRunner | null): void {
	registerAgentRunner("assistant", fn);
}

/** server 启动对应 agent 后注册；测试可注入 mock */
export function registerAgentRunner(name: string, fn: AssistantRunner | null): void {
	slot().runners[name] = fn;
}

/**
 * 注销 runner（agents 热重建删除/重建时调用）：把该 name 置 null，
 * 照「失败注册 null」的惯例——runAgentTask 对 null 会返回「不可用」而非抛错。
 * 未注册的 name 幂等，无副作用。
 */
export function unregisterAgentRunner(name: string): void {
	slot().runners[name] = null;
}

export function hasAssistantRunner(): boolean {
	return slot().runners["assistant"] !== null;
}

export function beginAssistantDelegate(): void {
	slot().delegateDepth++;
}

export function endAssistantDelegate(): void {
	const s = slot();
	s.delegateDepth = Math.max(0, s.delegateDepth - 1);
}

/** 当前是否处于剧情→agent 委托回合（agent 工具可双写剧情流） */
export function isAssistantDelegateActive(): boolean {
	return slot().delegateDepth > 0;
}

/** 兼容别名：委托给内置助手（= runAgentTask("assistant", req)） */
export async function runAssistantTask(req: AssistantRunRequest): Promise<AssistantRunResult> {
	return runAgentTask("assistant", req);
}

/** 按 name 委托给指定 agent（自定义 agent 用配置 id，如 "director"）；未知/未注册 → 错误结果 */
export async function runAgentTask(agent: string, req: AssistantRunRequest): Promise<AssistantRunResult> {
	const runner = slot().runners[agent] ?? null;
	if (!runner) {
		return {
			ok: false,
			summary: `agent「${agent}」未知或不可用（未注册/未启动）。请检查 agent 配置，或改用内置助手。`,
			media: [],
			panelsWritten: [],
			error: "no_runner",
		};
	}
	beginAssistantDelegate();
	try {
		return await runner(req);
	} finally {
		endAssistantDelegate();
	}
}
