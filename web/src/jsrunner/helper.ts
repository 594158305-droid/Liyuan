/**
 * JS Runner 宿主侧 TavernHelper 兼容实现（M3b）。
 *
 * tavernHelperImpl 是脚本 invoke 宿主方法的分发表：runtime 的 RuntimeHost.onInvoke
 * 查表执行。只注册 Liyuan 有对等物的 P0/P1 子集；未注册的方法回执 error
 * （「未实现的 TavernHelper 方法: xxx」）。
 *
 * 模块加载时的副作用：
 * - 注册 ext_gen 帧监听（sink）：generate/generateRaw 的流式回执按 reqId 配对
 * - 组装并注册 RuntimeHost 到 scriptRuntimes（onInvoke / onLog / onEvent）
 *
 * 脚本元信息（getScriptName/getScriptInfo）：直接查 runtime 自身
 * （scriptRuntimes.getMeta(id)），避免 helper ↔ runtime 循环依赖。
 */
import { scriptRuntimes } from "./runtime.ts";
import { jsrunnerBus } from "./bus.ts";
import { sendFrame } from "../ws.ts";
import { apiGet, apiPost, apiPut, getExtData, putExtData, type StatePatchResult } from "../api.ts";
import { triggerSlash } from "../tavernShim.ts";
import { addVar, buildSnapshot, getVar, saveExtensionSettings as persistExtensionSettings, setVar, updateChatMetadata as applyChatMetadata } from "./context.ts";
import { pushLog, stringifyLogArgs } from "./log.ts";
import { injectUserInput, parseOrderedPrompts } from "./prompts.ts";
import { ledger, notifyToast } from "./ledger.ts";
import type { ContextSnapshot, LedgerPanelSpec, RuntimeHost, ScriptMeta, StatusCardSlot } from "./types.ts";
import type { ClientFrame, ExtGenerateParams } from "../wire.ts";

// ---------- 脚本元信息读取（getScriptName / getScriptInfo）：查 runtime 自身 ----------

// ---------- App 启动加载（D4 冒烟修复：脚本生命周期不绑定管理面板挂载） ----------

/** 脚本持久化键（与 JsRunnerPanel 同源：global scope / scripts key） */
const SCRIPTS_SCOPE = "global";
const SCRIPTS_KEY = "scripts";

/**
 * App 启动时加载已启用脚本：读 extdata scripts → setScripts 增量启停 iframe。
 * - 幂等：runtime 的 planScriptSync 增量比对（file/content 键），未变化脚本不动；
 * - JsRunnerPanel 挂载时也会 reload（同源逻辑），两者交错调用安全；
 * - 非法条目由 planScriptSync 内部过滤（缺 id 忽略）。
 */
export async function bootstrapScripts(): Promise<void> {
	try {
		const value = await getExtData(SCRIPTS_SCOPE, SCRIPTS_KEY);
		if (Array.isArray(value)) {
			scriptRuntimes.setScripts(value as ScriptMeta[]);
		}
	} catch (e) {
		console.warn("[jsrunner] bootstrap 加载脚本失败", e);
	}
}

// ---------- 程序化生成（ext_generate / ext_gen） ----------

/** 进行中的程序化生成：reqId → 累计文本 + 收尾（end resolve / error reject，均只发生一次） */
interface PendingGenerate {
	text: string;
	resolve: (v: string) => void;
	reject: (e: Error) => void;
}
const pendingGenerates = new Map<string, PendingGenerate>();

/** 监听 ext_gen 帧：按 reqId 配对，累计 delta，end 返回文本 / error 拒绝 */
jsrunnerBus.registerSink({
	onWireFrame(frame) {
		if (frame.type !== "ext_gen") return;
		const p = pendingGenerates.get(frame.reqId);
		if (!p) return;
		switch (frame.kind) {
			case "start":
				return;
			case "delta":
				p.text += frame.delta;
				return;
			case "end":
				// 收尾即删表：后续迟到帧找不到条目，天然防重复结算
				pendingGenerates.delete(frame.reqId);
				p.resolve(p.text);
				return;
			case "error":
				pendingGenerates.delete(frame.reqId);
				p.reject(new Error(frame.error || "生成失败"));
				return;
		}
	},
});

function randomReqId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function generateViaWs(reqId: string, params: ExtGenerateParams): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		pendingGenerates.set(reqId, { text: "", resolve, reject });
		const frame: ClientFrame = { type: "ext_generate", reqId, params };
		sendFrame(frame);
	});
}

/** 采样参数透传（只收数字 / 合法档位，其余忽略） */
function pickSamplingParams(p: Record<string, unknown>): {
	temperature?: number;
	maxTokens?: number;
	reasoning?: "none" | "low" | "medium" | "high";
	systemPrompt?: string;
} {
	const systemPrompt =
		typeof p.systemPrompt === "string" && p.systemPrompt.trim() ? p.systemPrompt : undefined;
	const temperature = typeof p.temperature === "number" ? p.temperature : undefined;
	const maxTokens = typeof p.maxTokens === "number" ? p.maxTokens : undefined;
	const reasoning =
		p.reasoning === "none" || p.reasoning === "low" || p.reasoning === "medium" || p.reasoning === "high"
			? p.reasoning
			: undefined;
	return { ...(systemPrompt ? { systemPrompt } : {}), ...(temperature !== undefined ? { temperature } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}), ...(reasoning ? { reasoning } : {}) };
}

/**
 * generate(prompt, params?)：兼容两种入口——
 * - 字符串 prompt（ST 基础形态）→ 直接作文本
 * - 对象参数（shujuku 钩子形态：args[0] = { user_input, prompt, quiet_prompt, automatic_trigger, injects }）
 *   → 取 user_input ?? prompt 作文本，其余字段（injects/quiet_prompt/automatic_trigger）记日志后忽略
 */
async function implGenerate(prompt: unknown, params?: Record<string, unknown>): Promise<string> {
	const p = typeof params === "object" && params !== null ? params : {};
	let text = "";
	if (typeof prompt === "string") {
		text = prompt;
	} else if (prompt && typeof prompt === "object") {
		const obj = prompt as {
			user_input?: unknown;
			prompt?: unknown;
			quiet_prompt?: unknown;
			automatic_trigger?: unknown;
			injects?: unknown;
		};
		text =
			typeof obj.user_input === "string" && obj.user_input
				? obj.user_input
				: typeof obj.prompt === "string"
					? obj.prompt
					: "";
		if (obj.injects !== undefined || obj.quiet_prompt !== undefined || obj.automatic_trigger !== undefined) {
			console.log("[jsrunner] generate 对象参数含 injects/quiet_prompt/automatic_trigger，暂未支持（已忽略）");
		}
	}
	const sampled = pickSamplingParams(p);
	const payload: ExtGenerateParams = {
		...sampled,
		messages: [{ role: "user", content: text }],
	};
	return generateViaWs(randomReqId(), payload);
}

/** ST custom_api 载荷形状（apiMode==='tavern' 时脚本传 undefined，不进直连路径） */
interface CustomApiParams {
	apiurl?: unknown;
	key?: unknown;
	model?: unknown;
	max_tokens?: unknown;
	temperature?: unknown;
	frequency_penalty?: unknown;
	presence_penalty?: unknown;
	top_p?: unknown;
	top_k?: unknown;
}

/**
 * custom_api 前端直连（非流式）：脚本指定外部 OpenAI 兼容端点，不走 ws ext_generate（当前会话模型）。
 * POST apiurl；headers Content-Type + Bearer key（key 有才加）；body 只传有值字段；
 * 返回 data.choices?.[0]?.message?.content；非 2xx 抛错。
 */
async function implCustomApiDirect(
	customApi: CustomApiParams,
	messages: ExtGenerateParams["messages"],
	systemPrompt?: string,
): Promise<string> {
	const url = typeof customApi.apiurl === "string" ? customApi.apiurl.trim() : "";
	if (!url) throw new Error("custom_api.apiurl 缺失");
	const key = typeof customApi.key === "string" && customApi.key.trim() ? customApi.key.trim() : undefined;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (key) headers["authorization"] = `Bearer ${key}`;

	const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	const body: Record<string, unknown> = {
		model: typeof customApi.model === "string" && customApi.model.trim() ? customApi.model : "gpt-4o-mini",
		messages: [
			...(systemPrompt && systemPrompt.trim() ? [{ role: "system", content: systemPrompt }] : []),
			...messages,
		],
	};
	if (num(customApi.max_tokens) !== undefined) body.max_tokens = num(customApi.max_tokens);
	if (num(customApi.temperature) !== undefined) body.temperature = num(customApi.temperature);
	if (num(customApi.frequency_penalty) !== undefined) body.frequency_penalty = num(customApi.frequency_penalty);
	if (num(customApi.presence_penalty) !== undefined) body.presence_penalty = num(customApi.presence_penalty);
	if (num(customApi.top_p) !== undefined) body.top_p = num(customApi.top_p);
	if (num(customApi.top_k) !== undefined) body.top_k = num(customApi.top_k);

	const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`custom_api 请求失败 ${res.status} ${res.statusText}`);
	const data = (await res.json().catch(() => null)) as {
		choices?: Array<{ message?: { content?: unknown } }>;
	} | null;
	const content = data?.choices?.[0]?.message?.content;
	return typeof content === "string" ? content : "";
}

/**
 * generateRaw(params)：ST 语义参数对象。载荷优先级：
 * 1. ordered_prompts（ST 主载荷：系统提示 + 占位符 + 聊天历史）→ parseOrderedPrompts 解析，
 *    'user_input' 由 injectUserInput 注入（有占位符则注入该位，否则追加末尾）
 * 2. { messages } / { user_input }（既有兼容写法）
 * 通道：custom_api 有 apiurl → 前端 fetch 直连；否则 ws ext_generate → ext_gen 流式回执。
 * should_stream / should_silence 忽略（与现有行为一致）。
 */
async function implGenerateRaw(params: Record<string, unknown>): Promise<string> {
	const p = typeof params === "object" && params !== null ? params : {};
	const sampled = pickSamplingParams(p);
	const customApi =
		typeof p.custom_api === "object" && p.custom_api !== null
			? (p.custom_api as CustomApiParams)
			: undefined;
	const userInput = typeof p.user_input === "string" ? p.user_input : "";
	const maxChatHistory =
		typeof p.max_chat_history === "number" && Number.isFinite(p.max_chat_history)
			? p.max_chat_history
			: undefined;

	// 1. 载荷解析
	let messages: ExtGenerateParams["messages"] = [];
	let systemPrompt = sampled.systemPrompt;
	if (Array.isArray(p.ordered_prompts)) {
		const parsed = parseOrderedPrompts(p.ordered_prompts, buildSnapshot(), maxChatHistory);
		systemPrompt = parsed.systemPrompt ?? sampled.systemPrompt;
		// user_input 注入：有 'user_input' 占位符（哨兵）则替换该位，否则追加末尾；无输入则清除哨兵
		messages = injectUserInput(parsed.messages, userInput);
	} else if (Array.isArray(p.messages)) {
		messages = p.messages
			.filter((m) => m && typeof m === "object")
			.map((m) => {
				const mm = m as { role?: unknown; content?: unknown };
				return {
					role: mm.role === "assistant" ? ("assistant" as const) : ("user" as const),
					content: typeof mm.content === "string" ? mm.content : String(mm.content ?? ""),
				};
			});
	} else if (userInput.trim()) {
		messages = [{ role: "user", content: userInput }];
	}
	if (messages.length === 0) {
		throw new Error("generateRaw 缺少有效载荷（请传 { ordered_prompts } / { messages } / { user_input }）");
	}

	// 2. custom_api 前端直连（脚本指定外部端点，不走 ws 当前会话模型）
	if (customApi && typeof customApi.apiurl === "string" && customApi.apiurl.trim()) {
		return implCustomApiDirect(customApi, messages, systemPrompt);
	}

	// 3. 默认 ws 通道：ext_generate → ext_gen 流式回执（当前会话模型）
	const payload: ExtGenerateParams = {
		...(systemPrompt ? { systemPrompt } : {}),
		...(sampled.temperature !== undefined ? { temperature: sampled.temperature } : {}),
		...(sampled.maxTokens !== undefined ? { maxTokens: sampled.maxTokens } : {}),
		...(sampled.reasoning ? { reasoning: sampled.reasoning } : {}),
		messages,
	};
	return generateViaWs(randomReqId(), payload);
}

// ---------- 事件 API：宿主侧不实现（事件桥是 F2 iframe 内的事），占位防误调 ----------

function eventPlaceholder(): never {
	throw new Error("事件 API 在脚本内部桥接，见 bridge.ts");
}

// ---------- setMessage / deleteMessage：快照索引 → 后端 lastRoleIndex ----------

/**
 * 快照 chat 数组索引 → 后端 lastRoleIndex（从分支末尾倒数第 N 条角色消息）。
 * - index 指向角色消息（is_user=false，含角色侧与系统标记条目）：反推其在角色消息中的倒序位
 * - index 指向 user 消息：回退到其后的第一条角色消息（没有则抛错）
 * 纯函数，可 node 直跑冒烟。
 */
export function chatIndexToLastRoleIndex(
	chat: ReadonlyArray<{ is_user?: boolean }>,
	index: number,
): number {
	if (!Number.isInteger(index) || index < 0 || index >= chat.length) {
		throw new Error(`setMessage/deleteMessage 索引越界（0..${Math.max(0, chat.length - 1)}）`);
	}
	const roleSeq: number[] = [];
	for (let i = 0; i < chat.length; i++) {
		if (chat[i] && chat[i].is_user === false) roleSeq.push(i);
	}
	let targetIdx = index;
	if (chat[index].is_user !== false) {
		// user 消息：取其后第一条角色消息
		const next = roleSeq.find((i) => i > index);
		if (next === undefined) throw new Error("该 user 消息之后没有可编辑的角色消息");
		targetIdx = next;
	}
	const seq = roleSeq.indexOf(targetIdx);
	if (seq < 0) throw new Error("索引处没有角色消息");
	return roleSeq.length - 1 - seq;
}

async function implSetMessage(index: number, text: string): Promise<void> {
	const lastRoleIndex = chatIndexToLastRoleIndex(buildSnapshot().chat, index);
	await apiPost<{ ok: boolean }>("/api/script/message", {
		op: "edit",
		lastRoleIndex,
		text: String(text ?? ""),
	});
}

async function implDeleteMessage(index: number): Promise<void> {
	const lastRoleIndex = chatIndexToLastRoleIndex(buildSnapshot().chat, index);
	await apiPost<{ ok: boolean }>("/api/script/message", { op: "delete", lastRoleIndex });
}

// ---------- 其它宿主方法 ----------

async function implTriggerSlash(raw: string): Promise<void> {
	await triggerSlash(String(raw ?? ""));
}

/** GET /api/card → { name, description } 简化对象（失败回落快照角色名） */
async function implGetCharData(): Promise<{ name: string; description?: string }> {
	try {
		const card = await apiGet<{ name?: unknown; description?: unknown }>("/api/card", {
			bypassCache: true,
		});
		const name = typeof card?.name === "string" ? card.name : buildSnapshot().name1;
		const description = typeof card?.description === "string" ? card.description : undefined;
		return { name, ...(description ? { description } : {}) };
	} catch {
		return { name: buildSnapshot().name1 };
	}
}

function implGetCurrentChatId(): string {
	return buildSnapshot().currentChatId ?? "";
}

function implGetScriptName(scriptId: string): string {
	return scriptRuntimes.getMeta(scriptId)?.name ?? "";
}

function implGetScriptInfo(scriptId: string): string {
	return scriptRuntimes.getMeta(scriptId)?.info ?? "";
}

function implGetContext(): ContextSnapshot {
	return buildSnapshot();
}

// ---------- 账本面板 / 写面 / 通知 / 自由键 / 管理界面（D4 §2.5） ----------

/** P2：注册账本面板（校验 title 非空、area 合法；重复注册 = 覆盖 spec）。V2-4：area 支持
 * status/roster/left/top/right（区域扩展），白名单与 types.ts LedgerPanelSpec 枚举对齐。 */
function implRegisterLedgerPanel(scriptId: string, args: unknown[]): { ok: true } {
	const raw = args[0];
	const s = (raw !== null && typeof raw === "object" ? raw : {}) as Partial<LedgerPanelSpec>;
	if (typeof s.title !== "string" || !s.title.trim()) {
		throw new Error("registerLedgerPanel 需要 title");
	}
	if (
		s.area &&
		s.area !== "status" &&
		s.area !== "roster" &&
		s.area !== "left" &&
		s.area !== "top" &&
		s.area !== "right"
	) {
		throw new Error(`非法 area: ${String(s.area)}`);
	}
	ledger.upsert(scriptId, { area: "status", position: "append", ...s, title: s.title.trim() });
	return { ok: true };
}

/** P2：注销面板（脚本卸载/停用时调用；destroy 也会自动清理） */
function implUnregisterLedgerPanel(scriptId: string): { ok: true } {
	ledger.remove(scriptId);
	return { ok: true };
}

/** P3：写账本——与 StatusStrip 同封装（REST 校验面自带；流式生成中拒绝由 REST 面返回） */
function implApplyStatePatch(args: unknown[]): Promise<StatePatchResult> {
	const patch = (args[0] as Record<string, unknown> | undefined) ?? {};
	return apiPut<StatePatchResult>("/api/state", { patch });
}

/** P3：脚本通知 → 宿主 toast（level 白名单校验；success 归入 info；非法级别按 info 兜底） */
function implNotify(args: unknown[]): void {
	const raw = String(args[0] ?? "");
	const level: "info" | "warning" | "error" =
		raw === "error" ? "error" : raw === "warning" ? "warning" : "info";
	notifyToast(level, String(args[1] ?? ""));
}

/** P4：自由 extdata 键读（scope 缺省 global；命名空间约定 <scriptId>:<key> 由脚本自行遵守） */
function implGetExtData(args: unknown[]): Promise<unknown> {
	const key = String(args[0] ?? "");
	const scope = String(args[1] ?? "global");
	return getExtData(scope, key);
}

/** P4：自由 extdata 键写（scope 缺省 global；setExtData 语义上返回 undefined） */
function implSetExtData(args: unknown[]): Promise<void> {
	const key = String(args[0] ?? "");
	const value = args[1];
	const scope = String(args[2] ?? "global");
	return putExtData(scope, key, value);
}

/**
 * P4 + C 路径延伸：请求宿主弹出该脚本的独立管理界面（模态；ledger.requestManager →
 * ModalPanel）。args[0] 为 "fullscreen" 或 { fullscreen: true } 时按全屏模态打开，
 * 否则普通居中模态（与既有 openManager() 行为一致）。
 */
function implOpenManager(scriptId: string, args: unknown[]): { ok: true } {
	const raw = args[0];
	const fullscreen =
		raw === "fullscreen" ||
		(raw !== null && typeof raw === "object" && (raw as { fullscreen?: unknown }).fullscreen === true);
	ledger.requestManager(scriptId, fullscreen ? { fullscreen: true } : undefined);
	return { ok: true };
}

// ---------- TavernHelper 方法分发表（对照 JS-Slash-Runner function/index.ts 的 P0/P1 子集） ----------

/** 宿主方法：scriptId 为发起脚本 id（getScriptName/getScriptInfo 需要），args 为脚本传入参数 */
export type TavernHelperMethod = (
	scriptId: string,
	args: unknown[],
) => Promise<unknown> | unknown;

export const tavernHelperImpl: Record<string, TavernHelperMethod> = {
	// 变量：走 context.ts（同步；setVar 返回写入值，兼容脚本链式使用）
	getVar(scriptId, args) {
		return getVar(String(args[0] ?? ""), (args[1] as "global" | "chat") ?? "global");
	},
	setVar(scriptId, args) {
		setVar(String(args[0] ?? ""), args[1], (args[2] as "global" | "chat") ?? "global");
		return args[1];
	},
	addVar(scriptId, args) {
		return addVar(
			String(args[0] ?? ""),
			typeof args[1] === "number" ? args[1] : 0,
			(args[2] as "global" | "chat") ?? "global",
		);
	},
	// 程序化生成：ws ext_generate → ext_gen 流式回执
	generate(scriptId, args) {
		// args[0] 兼容字符串与对象（shujuku 钩子传 { user_input, prompt, ... }）
		return implGenerate(args[0], (args[1] as Record<string, unknown>) ?? {});
	},
	generateRaw(scriptId, args) {
		return implGenerateRaw((args[0] as Record<string, unknown>) ?? {});
	},
	// 事件：宿主侧不实现（F2 iframe 内桥接），占位防误调
	eventOn: () => eventPlaceholder(),
	eventOnce: () => eventPlaceholder(),
	eventOff: () => eventPlaceholder(),
	// 斜杠命令：走现有聊天桥（App 已注册 TavernChatBridge）
	triggerSlash(scriptId, args) {
		return implTriggerSlash(args[0] as string);
	},
	// 角色卡 / 会话 / 脚本元信息
	getCharData() {
		return implGetCharData();
	},
	getCurrentChatId() {
		return implGetCurrentChatId();
	},
	getScriptName(scriptId) {
		return implGetScriptName(scriptId);
	},
	getScriptInfo(scriptId) {
		return implGetScriptInfo(scriptId);
	},
	// 改稿 / 删稿：快照 chat 索引 → 后端 lastRoleIndex（按角色消息定位）
	setMessage(scriptId, args) {
		return implSetMessage(args[0] as number, args[1] as string);
	},
	deleteMessage(scriptId, args) {
		return implDeleteMessage(args[0] as number);
	},
	// 上下文快照（同步读）
	getContext() {
		return implGetContext();
	},
	// 账本面板注册（P2）
	registerLedgerPanel(scriptId, args) {
		return implRegisterLedgerPanel(scriptId, args);
	},
	unregisterLedgerPanel(scriptId) {
		return implUnregisterLedgerPanel(scriptId);
	},
	// 写账本（P3）：PUT /api/state { patch }
	applyStatePatch(scriptId, args) {
		return implApplyStatePatch(args);
	},
	// 通知（P3，R2-④）：宿主 toast
	notify(scriptId, args) {
		return implNotify(args);
	},
	// P4：自由 extdata 键（scope 缺省 global）
	getExtData(scriptId, args) {
		return implGetExtData(args);
	},
	setExtData(scriptId, args) {
		return implSetExtData(args);
	},
	// P4：独立管理界面（模态；C 路径延伸：args[0]="fullscreen"/{fullscreen:true} 全屏）
	openManager(scriptId, args) {
		return implOpenManager(scriptId, args);
	},
	// C 路径延伸：程序化关闭当前模态（脚本侧关闭通道；与 ✕/遮罩/Esc 同关闭路径）
	closeManager(scriptId, args) {
		ledger.requestManagerClose(scriptId);
		return { ok: true };
	},
	// C 路径 L1：状态栏默认编辑区显隐（只有显式 false 才隐藏；恢复显示传 true 或缺省）
	setStatusCardEditorVisible(scriptId, args) {
		const visible = args[0] !== false;
		ledger.setEditorVisible(scriptId, visible);
		return { ok: true };
	},
	// C 路径 L2：状态栏内容槽（宿主原生渲染；过滤非对象/无 type 元素，校验由 ledger 兜底）
	setStatusCardSlots(scriptId, args) {
		const raw = args[0];
		const slots = Array.isArray(raw)
			? raw.filter((s) => s && typeof s === "object" && typeof (s as { type?: unknown }).type === "string")
			: [];
		ledger.setSlots(scriptId, slots as StatusCardSlot[]);
		return { ok: true };
	},
	// G1：聊天元数据落盘（脚本在快照副本上改，传 partial 显式合并 + 落盘）
	updateChatMetadata(scriptId, args) {
		applyChatMetadata((args[0] as Record<string, unknown>) ?? {}, args[1] === true);
		return undefined;
	},
	// G1：扩展设置落盘（payload 为 iframe 内可变副本当前值，postMessage 深拷贝须回传才持久化）
	saveExtensionSettings(scriptId, args) {
		return persistExtensionSettings((args[0] as Record<string, unknown>) ?? undefined);
	},
	// G2：宏替换桩——Liyuan 宏在后端处理，原样透传（拼写保持 ST 原样 substitudeMacros，状态栏脚本 10 处调用）
	substitudeMacros(scriptId, args) {
		return String(args[0] ?? "");
	},
	// G2：扩展提示词注入——Liyuan 无扩展提示词注入面，no-op + 日志（脚本多为探测性调用）
	injectPrompts(scriptId, args) {
		console.log("[jsrunner] injectPrompts 未实现（Liyuan 无扩展提示词注入面），已忽略");
		return undefined;
	},
	// G2：模型列表——空数组（可后续接 provider registry）
	async getModelList() {
		return [] as unknown[];
	},
	// G2：停止程序化生成——abort 当前第一个 pending 生成（无 pending 则 no-op；Promise 由 ext_gen error 收尾）
	stopGeneration(scriptId, args) {
		const first = pendingGenerates.keys().next();
		if (first.done) return;
		const frame: ClientFrame = { type: "ext_abort", reqId: first.value };
		sendFrame(frame);
	},
	// G2：批量改稿——复杂，暂不实现，no-op + 日志
	setMessages(scriptId, args) {
		console.log("[jsrunner] setMessages 未实现（批量改稿暂不提供），已忽略");
		return undefined;
	},
};

// ---------- RuntimeHost 接线（模块加载即生效） ----------

function registerHelperHost(): void {
	const host: RuntimeHost = {
		/** invoke：查表执行；未注册方法 / 实现抛错 → 转成 error 回执（runtime 侧已 try/catch） */
		async onInvoke(scriptId, method, args) {
			const impl = tavernHelperImpl[method];
			if (!impl) throw new Error(`未实现的 TavernHelper 方法: ${method}`);
			return impl(scriptId, args);
		},
		/** 脚本 console 输出 → 宿主 console + 日志环形缓存（M4b LogViewer 读），格式 [jsrunner:<scriptId>] */
		onLog(scriptId, level, args) {
			const prefix = `[jsrunner:${scriptId}]`;
			if (level === "warn") console.warn(prefix, ...args);
			else if (level === "error") console.error(prefix, ...args);
			else console.log(prefix, ...args);
			// 保留现有 console 转发的同时，序列化入环形缓存并通知订阅者（实现见 ./log.ts）
			pushLog({ scriptId, level, text: stringifyLogArgs(args) });
		},
		/** 脚本 eventEmit → 总线广播（其它脚本 / 宿主可订阅） */
		onEvent(scriptId, name, args) {
			jsrunnerBus.emitExt(name, ...args);
		},
	};
	scriptRuntimes.setHost(host);
}

registerHelperHost();

// ---------- 日志查看器数据面（M4b）：实现在 ./log.ts，helper 只做薄包装，对外接口一致 ----------
export { clearLogs, getLogs, subscribeLogs } from "./log.ts";
export type { JsLogEntry } from "./log.ts";

// ---------- G2：ordered_prompts 解析器（实现在 ./prompts.ts，纯模块可 node 直跑冒烟） ----------
export { injectUserInput, parseOrderedPrompts } from "./prompts.ts";
export type { OrderedPromptResult, SnapshotChatLike } from "./prompts.ts";
