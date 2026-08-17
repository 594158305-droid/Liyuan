/**
 * 台上引擎（PLAN-RP-HARNESS M1）——RP 原生回合循环（R1 循环自持）。
 *
 * 一拍 = 装配（f(分支)）→ 一次流式生成（M1 零工具）→ assistant 落树 → 谢幕。
 * 没有 steer/followUp 队列，没有续轮判定：harness 知道自己在哪一幕。
 *
 * 竞态两律（R9）在此落地：
 * - 回合互斥：忙时新输入进队列，本拍收尾后依序开演；
 * - 谢幕由 harness 判定：流结束即收轮，不存在模型可续的循环。
 *
 * 依赖全部注入（SessionManager / 模型 / 流函数），可用 faux provider 离线整测。
 */

import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { applyProjectedSamplers } from "../samplers.ts";
import { extractDraftRules } from "../draft.ts";
import {
	appendOverlayEntry,
	loreFingerprint,
	overlayPathFor,
	scanEntries,
	searchEntries,
} from "../lorebook.ts";
import { appendCodexEntry, createCodex, deleteCodexEntry, listCodexes, loadCodexEntries } from "../codex.ts";
import { formatPanelIndex, formatPanelSnapshot, loadPanels } from "../panels.ts";
import { dir } from "../paths.ts";
import { listStageTopics, skillsDir } from "../skills.ts";
import {
	lookupBlockRule,
	reportItemFor,
	splitBlockContent,
	type AssemblyReportItem,
} from "../preset-split.ts";
import { formatRosterIndex, formatState, loadState, saveState, stateHasTableData } from "../state.ts";
import { isBackstageText } from "../stance.ts";
import type { TraceRecorder } from "./trace.ts";
import { configureDebug, debug } from "../debug.ts";
import type { LorebookEntry, WorldState } from "../types.ts";
import {
	buildStageInjection,
	buildStageSystemPrompt,
	codexNamesFromBranch,
	detectsLanguageMismatch,
	formatLoreIndex,
	rebuildHistory,
	stateFromBranch,
	type BranchEntryLike,
	type PresetResidentContent,
} from "./assemble.ts";
import {
	renderRoundCard,
	titlesOf,
	wordRangeHintOf,
	type RoundCardTemplate,
	type RoundCardVars,
} from "../flow-templates.ts";
import {
	constantLoreOf,
	evalPostHistoryBlocks,
	loadStageConfig,
	loadStageMaterials,
	type StageMaterials,
} from "./materials.ts";
import {
	MANUAL_MIN_COMPACT_CHARS,
	runCompaction,
	SUMMARY_ENTRY_TYPE,
	type CompactOutcome,
	type RpSummaryData,
} from "./compact.ts";
import { runScribeTurn, STATE_ENTRY_TYPE } from "./scribe-run.ts";
import {
	buildScribeAgentSystemPrompt,
	buildScribeAgentUserText,
	makeSqlExec,
	scribeAgentToolSchemas,
	tableOfSql,
	type ExecResult,
	type StageToolLike,
} from "./scribe-agent.ts";
import { TablesService } from "../tables/service.ts";
import { collectTableLogs, replayFromCheckpoint, type ReplayOutcome } from "../tables/replay.ts";
import { clearTableVec, removeTableVec, rowText, searchTableRows, syncTableRows, tableVecSize } from "../tables/vector-sync.ts";
import {
	MAX_ROUNDS,
	runSoundFxTool,
	runStageTool,
	soundFxToolNames,
	soundFxTools,
	stageTools,
	validateStageToolSchemas,
	writeTools,
	writingGuideTool,
	type MemoryHitLike,
	type StageTool,
	type StageToolDeps,
	type ToolRunResult,
} from "./tools.ts";
import { unifiedStageToolNames } from "../tools/adapters/stage.ts";
import {
	mcpStageTools,
	mcpStageToolNames,
	runMcpStageTool,
	type McpStageDeps,
} from "./mcp-stage.ts";
import {
	mediaStageToolNames,
	mediaStageTools,
	runMediaStageTool,
	type MediaStageResult,
} from "./media-stage.ts";
import { assistantStageTool, runAssistantStageTool } from "./assistant-stage.ts";
import type { MemoryChunkLike } from "../tools/memory.ts";
import { extractDraftBody, hasFormatTag } from "../draft.ts";
import {
	createWorkspace,
	finalTimeline,
	splitDraftSegments,
	projectedState,
	recordSegment,
	runWriteTool,
	type TurnWorkspace,
	type WorkspaceDeps,
} from "./workspace.ts";
import { buildReviewPrompt } from "./review.ts";
import { isStagedModel, minimalStageTools, TOOL_STAGED_ENTRY_TYPE } from "../tool-staging.ts";
import { cardFor, classifyTask, CONVERGE_TAIL, isComplexTask, personaFor } from "../router-core.ts";

// ---------------- 依赖面（结构类型，不引 @liyuan/agent-runtime） ----------------

export interface StageSessionManager {
	getBranch(): unknown[];
	getLeafId(): string | null;
	appendMessage(message: unknown): string;
	appendCustomMessageEntry(customType: string, content: string, display: boolean): string;
	/** CustomEntry（不进 LLM 上下文）：账本快照用 */
	appendCustomEntry(customType: string, data?: unknown): string;
	getSessionId(): string;
	flush(): void;
}

export interface StageModelLike {
	id: string;
	provider?: string;
	api?: unknown;
	baseUrl?: string;
	[k: string]: unknown;
}

/** @liyuan/ai streamSimple 的结构子集 */
export type StageStreamFn = (
	model: StageModelLike,
	context: { systemPrompt?: string; messages: unknown[] },
	options?: Record<string, unknown>,
) => AsyncIterable<StageStreamEvent> & { result(): Promise<AssistantMsgLike> };

export interface AssistantMsgLike {
	role: "assistant";
	content: Array<{
		type: string;
		text?: string;
		thinking?: string;
		name?: string;
		arguments?: Record<string, unknown>;
	}>;
	stopReason?: string;
	errorMessage?: string;
	[k: string]: unknown;
}

export interface StageStreamEvent {
	type: string;
	delta?: string;
	contentIndex?: number;
	toolCall?: { name?: string; arguments?: Record<string, unknown> };
	partial?: AssistantMsgLike;
	message?: AssistantMsgLike;
	error?: AssistantMsgLike;
}

export interface StageTurnEndInfo {
	aborted: boolean;
	/** 非空 = 本拍以错误收场（已通知，无正文落树） */
	error?: string;
	/** 落树的 assistant 条目 id（错误/空拍时无） */
	entryId?: string;
}

export interface StageEvents {
	onTurnStart?: () => void;
	/** 流式增量（转 WS delta 帧；kind 对应正文/思考通道） */
	/**
	 * 流式增量。draft=true 表示该增量是 draft_write 参数的转发
	 * （稿件流 = 替换语义：多稿重交原地更新，前端不得叠加）；
	 * reset=true 表示本次调用的首个分片（前端据此清掉旧稿）。
	 */
	onDelta?: (kind: "text" | "thinking", delta: string, draft?: boolean, reset?: boolean) => void;
	/**
	 * 中间轮旁白清理：稿落地前的工具轮吐出的 text（读题/计划旁白）已流式上屏，
	 * 但不是正文——通知前端把它收进过程条并从正文区移除（8/09 实弹：读题文字
	 * 先挂在正文顶部、落树后又拼到正文尾部）。
	 */
	onStreamClear?: () => void;
	/**
	 * 稿件分段重同步（修复后）：前端把屏上全部稿段**原位**替换为 segments。
	 * 与 onDelta 的稿件流互补——流式分片管「一段段长出来」，resync 管「原地变新」：
	 * draft_edit 改稿成功后按当前稿全量重切下发，修后的段就是用户看到的段。
	 */
	onDraftResync?: (segments: string[]) => void;
	onTurnEnd?: (info: StageTurnEndInfo) => void;
	/** 面向用户的告警（宏降级等）；每种只发一次 */
	onNotify?: (level: "info" | "warning" | "error", text: string) => void;
	/** 过程条短句（验收/修订进度；kind:"note" 形态，无需工具名） */
	onActivity?: (detail: string) => void;
	/** LLM 主动播放音效（play_sound 工具）：宿主负责校验白名单并广播 play_sound 帧 */
	onPlaySound?: (sound: string, volume?: number) => void;
}

export interface StageEngineDeps {
	cwd: string;
	getSessionManager: () => StageSessionManager;
	getModel: () => StageModelLike | undefined;
	getAuth: (model: StageModelLike) => Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	/**
	 * 旁挂模型（8/14，config.sideModel 接上台）：台上旁路（语义评审/场记/压缩摘要）
	 * 统一「旁挂模型 → 剧情模型」回退。由宿主解析（modelRegistry.find，找不到回退）；
	 * 未注入 = 全部旁路跟随剧情模型（getModel()）。
	 */
	getSideModel?: () => StageModelLike | undefined;
	/** 会话当前思考档（用户自由，引擎透传） */
	getThinking?: () => string | undefined;
	/** 账本磁盘缓存路径（.liyuan-state/<sessionId>.json）；给出则场记落盘（fs.watch → state 帧） */
	getStateFile?: (sessionId: string) => string | undefined;
	/** 剧情库检索（memory_search 工具用）；未注入 = 该工具恒返回无命中 */
	searchMemory?: (sessionId: string, query: string) => Promise<MemoryHitLike[]>;
	/**
	 * 向量库写侧三件（M-D3）。均由宿主按「当前对话 + 当前卡」绑定 MemoryScope 后注入——
	 * **作用域不经模型**（PLAN-RP-TOOLING M-D3：scope 全隐藏），引擎只透传 sessionId。
	 * 未注入 = 台上无对应工具（依赖缺失的工具不上清单）。
	 */
	addMemory?: (
		sessionId: string,
		input: { text: string; title?: string },
	) => Promise<{ added: number; total: number; chunks: number }>;
	listMemory?: (sessionId: string, storeId: string) => MemoryChunkLike[];
	deleteMemory?: (sessionId: string, storeId: string, id: string) => boolean;
	/**
	 * 面板读写（M-D5）。由宿主按当前会话绑定 artifacts 文件后注入。
	 * 未注入 = 台上无面板工具（依赖缺失的工具不上清单）。
	 */
	loadPanels?: (sessionId: string) => Record<string, { name: string; kind: "markdown" | "svg" | "html"; content: string; archived?: boolean }>;
	writePanel?: (sessionId: string, input: { name: string; kind: string; content: string }) => { ok: true; created: boolean; reopened: boolean; activeCount: number; overLimit: boolean } | { ok: false; error: string };
	closePanel?: (sessionId: string, name: string) => { ok: boolean; error?: string };
	/** 被压缩裁掉的早期正文归档进剧情库（供 memory_search 召回细节）；未注入 = 只落摘要不归档 */
	archiveCompacted?: (sessionId: string, text: string) => Promise<void>;
	/**
	 * 世界书条目启停落盘（lorebook_toggle 工具用，M-D2）：写 config.disabledLore 并重装素材。
	 * 由宿主注入——落盘与热重载归 server/ 侧（引擎不碰 server 的 writeJsonWithBackup）。
	 * 未注入 = 台上无 lorebook_toggle 工具。
	 */
	setDisabledLore?: (fingerprints: string[], enabled: boolean) => number;
	/**
	 * 知识库挂载/卸载（codex_mount 工具用）：宿主写 rp-codex 树快照（挂载关系随分支走，rewind/fork 跟随）。
	 * 未注入 = 台上无 codex_mount 工具（依赖缺失的工具不上清单）。
	 */
	mountCodex?: (sessionId: string, name: string, enabled: boolean) => { ok: boolean; error?: string };
	/**
	 * 向用户出选择卡（choice 工具用）：复用宿主 askChoice / uiContext.select；
	 * undefined = 用户停止。未注入 = 台上无 choice 工具。
	 */
	select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
	/**
	 * MCP 外设（8/06 重新接线）：宿主注入 hub 的两个能力，台上据此挂 mcp__ 工具。
	 * 未注入 = 台上无 MCP 工具（依赖缺失的工具不上清单）。
	 * hub 单例由宿主持有——引擎不自建，避免第二个实例（见 src/mcp.ts 的 globalThis 槽）。
	 */
	mcp?: McpStageDeps;
	/**
	 * 媒体交付工具（8/06 重接）：show_image/audio/video/html + tts。
	 * 与 MCP 同源的断链——消费端（wire.ts）一直健在，缺的是台上生产端。
	 * false/省略 = 不挂（tts 另需服务端 TTS 环境，由 ttsAvailable 决定）。
	 */
	media?: boolean;
	/** TTS 环境是否就绪（未就绪则 tts 不上清单——依赖缺失的工具不上清单） */
	ttsAvailable?: () => boolean;
	/**
	 * 剧情决策询问（ask 工具，P7 接回）：弹出选择卡等用户应答。
	 * 应答 = 用户选择的选项原文（作为新输入回喂模型，计划据此重拟）；
	 * undefined = 用户停止（笔还给用户，本拍收束）。
	 * 未注入 = 台上无 ask 工具（依赖缺失的工具不上清单）。
	 */
	askUser?: (question: string, options: string[], signal?: AbortSignal) => Promise<string | undefined>;
	streamFn: StageStreamFn;
	events?: StageEvents;
	/**
	 * 主聊天跟踪记录器（开发者模式，2026-08-11）：注入后引擎按 config.chatTrace
	 * 决定本回合是否记录（每拍现读，保存后下一回合生效）。未注入 = 永不记录。
	 */
	trace?: TraceRecorder;
}

// ---------------- 引擎 ----------------

const nowMsg = (text: string) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
});

const textOfAssistant = (m: AssistantMsgLike | null): string => {
	if (!m) return "";
	return m.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("")
		.trim();
};

/** 从消息 content 提取 thinking 块全文（主聊天跟踪用：每轮完整思考原文） */
const thinkingTextOf = (m: AssistantMsgLike | null | undefined): string =>
	(m?.content ?? [])
		.filter((c) => c.type === "thinking")
		.map((c) => c.thinking ?? "")
		.join("\n");

/** 模型展示名（provider/id；主聊天跟踪元信息用） */
const modelIdOf = (m: StageModelLike): string => `${m.provider}/${m.id}`;

/** DSH 双阶段：分支上是否已有晋升标记（rp-tool-staged 协议条目）——resume/fork 后按条目推导，永不回退 */
const toolStagedOnBranch = (branch: BranchEntryLike[]): boolean =>
	branch.some((e) => e.type === "custom" && e.customType === TOOL_STAGED_ENTRY_TYPE);

/** 写侧草稿工具（主聊天跟踪 draft 事件：交稿全文 + 验收报告） */
const DRAFT_TOOLS = new Set(["draft_write", "draft_append", "draft_edit", "draft_seal", "draft_check", "draft_review"]);

/**
 * 轮次卡（P1 注入层）：按工作区状态给出「你现在在第几步」的显式信号。
 *
 * 对照 opencode 的 plan-mode / build-switch 每轮注入：模型从注入状态知道自己
 * 在流程的哪个位置，而不是从静态系统提示词里猜。卡只在状态切换时注入一轮
 * （见 agentLoop 的 lastCard 去重），不在历史里累积。
 *
 * 文案来自轮次卡模板（assets/flow/round-cards.json + 配置 flowTemplates 覆盖，
 * DESIGN-flow-config §2）；本函数只保留**状态判定与动态变量**，渲染与占位符
 * 填充由 flow-templates.ts 承接。模板缺了某张卡（key 不在表里）则该状态不注入。
 */
function roundCardFor(
	templates: RoundCardTemplate[],
	ws: TurnWorkspace,
	userName: string,
	wordRange?: { min: number; max: number },
	statusBarTags?: string[],
): string | undefined {
	const byKey = new Map(templates.map((t) => [t.key, t]));
	const render = (key: string, vars: RoundCardVars): string | undefined => {
		const t = byKey.get(key);
		return t ? renderRoundCard(t, vars) : undefined;
	};

	if (ws.plan.length === 0 && ws.draft.trim() === "") {
		return render("plan", {
			wordRangeHint: wordRange ? wordRangeHintOf(wordRange.min, wordRange.max) : "",
		});
	}
	if (ws.plan.length > 0 && ws.appends === 0 && ws.draft.trim() === "") {
		return render("open", {});
	}
	// 修复卡（8/09 问题：修复注入缺失）：上一段验收出的违规未修，优先注入修复指令——
	// 否则模型被「演段回看卡」的构思引导带走，把修复攒到末尾统一做（实弹：四段写完才修）。
	// 修复是这一步唯一该做的事：先修干净，再谈下一段。
	if (ws.appends > 0 && ws.pendingViolations.length > 0) {
		return render("fix", {
			violationsCount: String(ws.pendingViolations.length),
			violations: ws.pendingViolations.map((v) => `- ${v}`).join("\n"),
		});
	}
	// 谢幕卡（8/09 review）：已封笔后不再催演/催构思——sealed 语境下回看/续写/
	// 收笔评估卡全部失效（实弹：seal 后的记账轮被回看卡催「构思下一段」）。
	// 封笔后的剩余正务只有记账与谢幕：状态栏等格式块是本拍最后的产出。
	if (ws.appends > 0 && ws.sealed) {
		const statusBarTail =
			statusBarTags && statusBarTags.length > 0
				? `然后输出状态栏（${statusBarTags.map((t) => `<${t}>`).join(" 或 ")}）等格式块——` +
					`状态栏意味着本拍结束，输出完即停`
				: `没有格式块要输出就直接停笔`;
		return render("curtain", { statusBarTail });
	}
	if (ws.appends > 0 && ws.plan.some((s) => !s.done)) {
		return render("review", { appendsCount: String(ws.appends), userName });
	}
	// 路标已全部演完（或本来就没有计划）：这一拍的主体已完成。按字数决定去向——
	// 字数不够 → 续写自然下文（8/09 定案：续写是「用户输入少 + 字数目标高」时的出口，
	// 模型绞尽脑汁扩写不如承接世界书里的下一步；续写会自然走到岔路触发 ask，
	// 也杜绝了「路标演完自由发散」——扶南女王那次就是没有续写出口、卡催构思导致的）。
	// 字数达标 → 收笔评估。
	const draftBodyChars = ws.draft.trim() ? extractDraftBody(ws.draft).replace(/\s+/g, "").length : 0;
	if (ws.appends > 0) {
		if (wordRange && draftBodyChars < wordRange.min) {
			return render("extend", {
				draftBodyChars: String(draftBodyChars),
				wordRangeMin: String(wordRange.min),
				wordRangeMax: String(wordRange.max),
				userName,
			});
		}
		// 收笔评估卡（8/09 卡序纠正）：ask/续写判断必须在 seal **之前**——旧卡把
		// 「到停点就 seal」排在第一步，模型照卡执行：封完笔才评估出「下文是用户的
		// 行动、该 ask」，全成马后炮（实弹：想 ask 却已 seal，转头记账收场，
		// ask 没发、状态栏也没了，还替用户把下一步演进了正文）。卡序 = 行为序。
		return render("seal", { userName });
	}
	return undefined;
}

/**
 * 定稿合并：稿件为主体；text 通道里**格式特征**的尾巴（状态栏占位 / catsay / w2g…）
 * 拼回，纯文本增量（闲聊收笔）丢弃——树上正文 = 用户最终该看到的全部内容。
 *
 * 模型常把 draft_write 理解成「交正文」，把格式栈尾巴走普通 text 通道输出。
 * 旧逻辑 `ws.draft.trim() ? ws.draft : text` 是二选一，尾巴连同 token 一起被丢弃
 * （8/05 实锤：模型思考里宣告「body, status bar, and cat commentary」，
 * draft_write 只交了 679 字正文，状态栏与咪咪点评凭空蒸发）。
 * 但也不能无脑全拼——纯文本尾巴（"就这样吧。"）是收笔闲聊，不该进正文。
 */
const FORMAT_TAIL_RE = /<(?:[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.\-]*)(?:\s[^>]*)?\/?\s*>/;
const looksLikeFormatTail = (tail: string): boolean =>
	FORMAT_TAIL_RE.test(tail) || /^```/m.test(tail);

const mergeFinalText = (draft: string, text: string): string => {
	const d = draft.trim();
	const t = text.trim();
	if (!d) return t;
	if (!t || d === t) return d;
	// 稿件已包含 text（模型边写边交，text 是半截）：稿件已是全量
	if (d.includes(t)) return d;
	// text 含稿件：取稿件之后的增量（尾巴在后）；不含：整段视作尾巴
	const idx = t.indexOf(d);
	const tail = idx >= 0 ? t.slice(idx + d.length) : t;
	if (!looksLikeFormatTail(tail)) return d;
	return [d, tail].filter(Boolean).join("\n\n");
};

/**
 * 收尾放行门控：上一轮（或首轮）思考宣告了「还要写格式栈尾巴」才多给一轮。
 * 无条件放行会多拉一轮 LLM，把场记兜底响应当叙事轮消费（8/05 测试实证）；
 * 而 8/05 实弹里模型确实在思考里宣告过 status bar / cat commentary。
 */
const TAIL_INTENT_RE =
	/(状态栏|点评|选择框|选项|摘要|咪咪|猫猫|吐槽|catsay|w2g|status|summary|choice|comment)/i;
const hasTailIntent = (m: AssistantMsgLike | null): boolean => {
	if (!m || !Array.isArray(m.content)) return false;
	const think = m.content
		.filter((c): c is { type: string; thinking?: string } => c.type === "thinking")
		.map((c) => c.thinking ?? "")
		.join("");
	return TAIL_INTENT_RE.test(think);
};

export class StageEngine {
	#deps: StageEngineDeps;
	#busy = false;
	#queue: string[] = [];
	#abort: AbortController | null = null;
	#warnedMacros = "";
	#warnedAuditDrop = 0;
	#warnedProtocolDrop = "";
	#warnedFlow = "";
	#lastAssemblyJson = "";
	// 梨园化 router（DESIGN-router）：perTurn 形态——每拍 #turn 现算（模型分档弱人格 +
	// 模式卡），旁路统一收敛尾注（#sideText / #compact 共用，enabled=false 恒关）
	#routerPersona: string | undefined = undefined;
	#routerCard: string | undefined = undefined;
	#convergeTailOn = false;
	// SQL 表格服务（DESIGN-tables-sql）：每会话一个 db；写操作经 onWrite 落树 rp-table-log
	#tables: TablesService | null = null;
	#tablesSessionId: string | null = null;
	/** 表写日志缓冲：拍末统一落树（代理期间落树会改变叶 id，误触发场记叶守卫） */
	#tableLogBuffer: import("../tables/service.ts").TableLogEntry[] = [];
	/** 上次物化重放的日志状态键（避免 resyncAll 频繁触发时重复全量重放） */
	#lastReplayKey: string | null = null;
	// 表格向量（DESIGN-tables-vector）：作用域卡路径 / 降级告警一次 / 重同步世代号
	#cardPath: string | null = null;
	#warnedTableVec = false;
	#tableVecGeneration = 0;
	#tableVecBooting = false;

	constructor(deps: StageEngineDeps) {
		this.#deps = deps;
	}

	get isStreaming(): boolean {
		return this.#busy;
	}

	/** 释放 SQL 表格服务的 db 句柄（测试清理 / 显式切换会话用；正常服务生命周期无需调用） */
	closeTables(): void {
		this.#tables?.close();
		this.#tables = null;
		this.#tablesSessionId = null;
	}

	/**
	 * REST/UI 用：当前会话的 TablesService（DESIGN-tables-sql P5）。
	 */
	tablesService(): TablesService {
		return this.#tablesFor(this.#deps.getSessionManager().getSessionId());
	}

	/**
	 * 树导航/rewind/会话加载后，把 SQLite 物化重建为焦点分支状态
	 * （DESIGN-tables-sql §7 二版：检查点增量重放——迁移基线不清空、回退分支不动）。
	 * 相同日志状态时跳过（resyncAll 会频繁触发，重放幂等但没必要）。
	 */
	replayTables(): ReplayOutcome {
		const sm = this.#deps.getSessionManager();
		const branch = sm.getBranch() as Array<Record<string, unknown>>;
		const svc = this.#tablesFor(sm.getSessionId());
		const cp = svc.getCheckpoint();
		const logs = collectTableLogs(branch);
		const key = `${logs.length}:${logs[logs.length - 1]?.at ?? 0}:${cp.throughEntryId ?? ""}`;
		if (key === this.#lastReplayKey) return { kind: "ok", replayed: 0, baseline: false };
		this.#lastReplayKey = key;

		if (!cp.throughEntryId) {
			// 基线锁定：物化有表但无检查点（迁移基线/恢复数据）→ 以当前叶为基线锚点，
			// 不清空不重放（2026-08-16 事故：全量重放把迁移表清空）
			if (svc.listTables().length > 0 && sm.getLeafId()) {
				svc.setCheckpoint(sm.getLeafId());
			}
			void this.#resyncTableVecAllAsync();
			return { kind: "ok", replayed: 0, baseline: true, reason: "物化基线已锁定（不清空不重放）" };
		}

		const r = replayFromCheckpoint(svc, branch, cp.throughEntryId);
		console.log(`[liyuan-trace] [replay] 表格物化 ${r.kind === "ok" ? (r.baseline ? "不动(baseline)" : `重放 ${r.replayed} 条`) : `失败 ${r.error}`}（当前叶 ${(sm.getLeafId() ?? "").slice(0, 8)}，检查点 ${(cp.throughEntryId ?? "").slice(0, 8)}）`);
		if (r.kind === "ok" && r.replayed > 0) {
			const after = collectTableLogs(branch.slice(branch.findIndex((e) => e.id === cp.throughEntryId) + 1));
			const last = after[after.length - 1];
			if (last?.entryId) svc.setCheckpoint(last.entryId);
			void this.#resyncTableVecAllAsync();
		}
		return r;
	}

	/** 用户新输入开一拍：先落 user 消息再开演；忙时排队（流式中送达的输入不打断叙事） */
	async performTurn(userText: string): Promise<void> {
		if (this.#busy) {
			this.#queue.push(userText);
			return;
		}
		await this.#run(userText);
		await this.#drain();
	}

	/** 再生成：叶已钉在 user（swipe/reroll 已 branch），不追加 user 消息直接开演 */
	async regenerate(): Promise<void> {
		if (this.#busy) return;
		await this.#run(null);
		await this.#drain();
	}

	/** 强制停止本拍：已流出的部分正文仍落树可见 */
	abort(): void {
		this.#abort?.abort();
	}

	async #drain(): Promise<void> {
		while (this.#queue.length > 0 && !this.#busy) {
			const next = this.#queue.shift();
			if (next !== undefined) await this.#run(next);
		}
	}

	async #run(userText: string | null): Promise<void> {
		const ev = this.#deps.events ?? {};
		this.#busy = true;
		ev.onTurnStart?.();
		let endInfo: StageTurnEndInfo = { aborted: false };
		try {
			endInfo = await this.#turn(userText);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ev.onNotify?.("error", `本拍开演失败：${msg}`);
			endInfo = { aborted: false, error: msg };
		} finally {
			this.#busy = false;
			this.#abort = null;
			ev.onTurnEnd?.(endInfo);
		}
	}

	async #turn(userText: string | null): Promise<StageTurnEndInfo> {
		const { cwd, events: ev = {} } = this.#deps;
		const sm = this.#deps.getSessionManager();

		// 素材现读：改卡/改预设/挂书即时生效
		const materials = loadStageMaterials(cwd);
		const trace = this.#deps.trace;
		// 主聊天跟踪（开发者模式）：每拍现读配置，保存后下一回合生效；未注入/未开启 = 零开销
		const traceOn = !!trace && materials.config.chatTrace === true;
		// 统一调试接口：每拍按 config.debugLog 现读同步控制台/file 通道（开发者模式可关打印）
		configureDebug({
			console: materials.config.debugLog?.console !== false,
			file: materials.config.debugLog?.file !== false,
		});
		const sessionId = sm.getSessionId();
		const turnT0 = Date.now();
		// 本拍收尾统一写 turn_end（闭包晚绑：entryId/finalText/final 在落树后才定）
		const endTrace = (aborted: boolean, error?: string) => {
			if (!traceOn) return;
			trace!.record(sessionId, {
				kind: "turn_end",
				aborted,
				...(error ? { error } : {}),
				...(entryId !== undefined ? { entryId } : {}),
				...(finalText ? { finalText } : {}),
				elapsedMs: Date.now() - turnT0,
				...(final?.usage ? { usage: final.usage } : {}),
			});
		};
		const { config, card } = materials;
		if (materials.macroWarnings.length > 0) {
			const key = materials.macroWarnings.join(",");
			if (key !== this.#warnedMacros) {
				this.#warnedMacros = key;
				ev.onNotify?.("warning", `预设含未支持的宏（已置空处理）：${materials.macroWarnings.join("、")}`);
			}
		}
		// 流程配置（拆层表/轮次卡）加载警告：非法正则等按内容去重播报一次
		if (materials.flowWarnings.length > 0) {
			const key = materials.flowWarnings.join(",");
			if (key !== this.#warnedFlow) {
				this.#warnedFlow = key;
				ev.onNotify?.("warning", `流程配置加载警告（对应规则已跳过）：${materials.flowWarnings.join("、")}`);
			}
		}

		const model = this.#deps.getModel();
		if (!model) {
			ev.onNotify?.("error", "尚未配置剧情模型——请先在「连接」面板选择模型。");
			return { aborted: false, error: "no-model" };
		}
		// 旁挂模型（8/14，config.sideModel）：台上旁路（评审/场记/压缩）统一用它，
		// 回退剧情模型。每拍解析一次（宿主侧读盘，与素材现读同节奏）。
		const sideModel = this.#deps.getSideModel?.() ?? model;

		// 主聊天跟踪：会话头（角色卡/预设/模型/时间等元信息，只写一次）+ 回合开始
		if (traceOn) {
			trace!.openSession(sessionId, {
				sessionId,
				cardPath: materials.config.card,
				cardName: materials.card.name,
				preset: materials.preset?.name ?? null,
				model: modelIdOf(model),
				thinkingLevel: this.#deps.getThinking?.(),
				language: materials.config.language,
			});
			trace!.record(sessionId, { kind: "turn_start", userText, model: modelIdOf(model) });
		}

		if (userText !== null) {
			sm.appendMessage(nowMsg(userText));
		}

		// 上下文 = f(分支)；全树条目兜底：摘要挂在焦点分支外时仍按覆盖锚点生效（8/15 压缩挂错分支修复）
		const branch = sm.getBranch() as BranchEntryLike[];
		const state = this.#effectiveState(branch);
		const { history, lastUserText, lastNarrativeText, summary } = rebuildHistory(branch, sm.getEntries());
		if (!history.some((m) => m.role === "user")) {
			ev.onNotify?.("error", "没有可开演的用户输入。");
			return { aborted: false, error: "no-user-input" };
		}

		const languageMismatch = lastNarrativeText
			? detectsLanguageMismatch(lastNarrativeText, config.language)
			: false;
		const windowText = history
			.slice(-config.scanDepth)
			.map((m) => m.text)
			.join("\n");
		const activated = scanEntries(materials.entries, windowText, config.maxLoreInjections);

		// 梨园化 router（DESIGN-router）：perTurn 唯一推荐形态——system 区模型分档弱人格
		// （会话内字节稳定，不破前缀缓存）+ 注入区每拍模式卡（近场动态，零缓存代价）。
		// enabled=false 时全部关闭（零变化）；toolStaging 独立于 enabled（现状 staging 保持）。
		const router = materials.router;
		if (router.enabled) {
			this.#convergeTailOn = router.convergeTail;
			// 模型分档弱人格：config.router.models[modelId] 覆盖优先（band/persona）
			const ov = router.modelOverrides[model.id];
			const band = ov?.band ?? "weak";
			this.#routerPersona = ov?.persona ?? personaFor(band, model.id, router.personas);
			// 分类来源：perTurn=当拍用户消息；fixed=首条剧情消息（实验配置，derive from durable history）
			const classifyText =
				router.personaMode === "fixed" ? (history.find((m) => m.role === "user")?.text ?? lastUserText) : lastUserText;
			const task = classifyTask(classifyText, router.lexicon);
			const complex = isComplexTask(classifyText, router.lexicon);
			const card = router.modeCards ? cardFor(task, { complex, modelId: model.id, cards: router.cards }) : null;
			this.#routerCard = card ? `${card.title}${card.body}` : undefined;
		} else {
			this.#convergeTailOn = false;
			this.#routerPersona = undefined;
			this.#routerCard = undefined;
		}

		// 表格向量检索注入（DESIGN-tables-vector §5）：本拍上下文（用户输入 + 最近 2 拍正文）
		// → 余弦命中 →【相关表格】块。无表/未启用/嵌入异常一律降级（不影响主链路）。
		this.#cardPath = config.card ?? null;
		let tableVecBlock: string | undefined;
		const tvc = config.tablesVector;
		if (tvc?.enabled !== false) {
			try {
				const svc = this.#tablesFor(sm.getSessionId());
				if (svc.listTables().length > 0) {
					const scope = { sessionId: sm.getSessionId(), card: config.card };
					// 向量库为空（首拍/文件被清）→ 触发一次初始全量嵌入（本拍检索空，下拍起生效）
					if (tableVecSize(cwd, scope) === 0 && !this.#tableVecBooting) {
						this.#tableVecBooting = true;
						void this.#resyncTableVecAllAsync();
					}
					const recentBody = history.slice(-6).map((m) => m.text).join("\n").slice(-900);
					const query = `${lastUserText}\n${recentBody}`.slice(0, 2400);
					const hits = await searchTableRows(cwd, scope, query, tvc.topK ?? 6, tvc.threshold ?? 0.15);
					if (hits.length > 0) {
						const byTable = new Map<string, string[]>();
						for (const h of hits) {
							const arr = byTable.get(h.table) ?? [];
							if (arr.length < 3) arr.push(h.text);
							byTable.set(h.table, arr);
						}
						tableVecBlock = `【相关表格】以下自定义表行与本拍剧情相关（内容按需查阅，写回用 sql_write）：\n${[...byTable.entries()]
							.map(([t, lines]) => `- ${t}：\n${lines.map((l) => `  - ${l}`).join("\n")}`)
							.join("\n")}`;
					}
				}
			} catch {
				// 嵌入异常：检索注入缺位；sql_read/sql_write 主链路不受影响
			}
		}

		// 面板快照（M1 读磁盘缓存；写侧与分支化随 M3）
		let panelIndex: string | undefined;
		try {
			const panels = loadPanels(join(dir(cwd, "artifacts"), `${sm.getSessionId()}.json`));
			panelIndex = formatPanelSnapshot(panels) ?? formatPanelIndex(panels) ?? undefined;
		} catch {
			panelIndex = undefined;
		}

		// 旧会话遗留的戏外轮：不注预设末端模板（不按剧情模板硬写）
		const legacyBackstage = !!lastUserText && isBackstageText(lastUserText);

		// postHistory 每拍求值（{{lastusermessage}} 在此生效）+ M-C 拆层分流：
		// A 原文/B/C 归拢进末端；D/E 已在装载期静态入 skillPacks（此处跳过）；G/H/I 退场。
		const phAll = legacyBackstage ? [] : (evalPostHistoryBlocks(materials, lastUserText) ?? []);
		const phTail: PresetResidentContent = { aBlocks: [], styleTexts: [], boundaryTexts: [] };
		const phReport: AssemblyReportItem[] = [];
		for (const b of phAll) {
			if (!b.content.trim()) continue;
			const rule = lookupBlockRule(materials.splitTable, b.name);
			const pieces = splitBlockContent(rule, b.name, b.content);
			for (const r of pieces.resident) {
				if (r.section === "A") phTail.aBlocks.push({ ...b, content: r.text });
				else if (r.section === "B") phTail.styleTexts.push(r.text);
				else phTail.boundaryTexts.push(r.text);
			}
			phReport.push(reportItemFor(pieces, b.name, "postHistory", b.content.length));
		}
		if (materials.auditLinesDropped > 0 && materials.auditLinesDropped !== this.#warnedAuditDrop) {
			this.#warnedAuditDrop = materials.auditLinesDropped;
			console.error(`[stage] 拆层句级过滤：摘掉 ${materials.auditLinesDropped} 行验算指令`);
		}
		// M-C2：外部插件协议条目退场（世界书/卡内嵌通道 H 类）——每套组合只播报一次
		if (materials.protocolDrops.length > 0) {
			const key = materials.protocolDrops.map((d) => `${d.family}:${d.title}`).join("|");
			if (key !== this.#warnedProtocolDrop) {
				this.#warnedProtocolDrop = key;
				const chars = materials.protocolDrops.reduce((n, d) => n + d.chars, 0);
				const titles = materials.protocolDrops.map((d) => `${d.label}「${d.title}」`).join("、");
				console.error(
					`[stage] 外部插件协议退场：${materials.protocolDrops.length} 条 / ${chars} 字（${titles}）——梨园以工具记账，无需模型手写格式块`,
				);
			}
		}

		// 装配报告落盘（PLAN §5.3 可视化）：system 侧静态 + postHistory 侧每拍；内容变了才写
		this.#writeAssemblyReport(cwd, materials, phReport, phTail);

		// M-A 工具组 + M-C writing_guide（skill 包非空才挂——不凭空点名）。
		// 回合工作区 = 正文工件的落点；纪律规则在此提取一次，draft_check 全程复用。
		// 读侧依赖先建：统一层按注入情况决定哪些世界书工具上清单（M-D2）。
		// M-C 扩展：主题 = 预设 skillPacks 键 + .liyuan-skills 演出主题（stage-topic 标记）——
		// 写作指南以 Markdown 笔记形态住在技能库，主演经 writing_guide 按需读（getSkill fallback）。
		const stageTopicList = listStageTopics(cwd);
		const skillTopics = [...materials.skillPacks.keys(), ...stageTopicList.map((t) => t.topic)];
		const readDeps = this.#toolDeps(lastUserText);
		// MCP 外设（8/06 重接）：hub 里本会话已连接的工具并入清单。
		// 空数组＝没启用/没连上，与「未注入 mcp 依赖」同效——都不上清单。
		const mcpTools = mcpStageTools(this.#deps.mcp);
		// 媒体交付（8/06 重接）：tts 另需服务端环境，未就绪不上清单
		const mediaOpts = { tts: this.#deps.ttsAvailable?.() === true };
		const mediaTools = this.#deps.media ? mediaStageTools(config.language, mediaOpts) : [];
		// 播放音效（8/12）：不依赖宿主环境，恒上清单
		const soundTools = soundFxTools();
		// 助手委托（8/06 重接）：runner 未注册时不上清单
		const assistantTool = assistantStageTool();
		// P7：ask 工具依赖宿主注入 askUser（选择卡通道）；未注入则从清单剔除
		const askEnabled = !!this.#deps.askUser;
		const tools = [
			...stageTools(config.language, readDeps),
			...(skillTopics.length > 0
				? [writingGuideTool(config.language, [...materials.skillPacks.keys(), ...stageTopicList])]
				: []),
			...writeTools(config.language).filter((t) => t.name !== "ask" || askEnabled),
			...mediaTools,
			...soundTools,
			...(assistantTool ? [assistantTool] : []),
			...mcpTools,
		];
		// 装配期 schema 自检：required 失配 / 数字 enum 都可能导致 Gemini 侧 400（OpenRouter 转换）
		validateStageToolSchemas(tools);
		// DSH 双阶段工具暴露（src/tool-staging.ts）：会话未晋升时首轮只给读侧+规划工具——
		// V4 Pro 强依赖可见工具目录选轨迹，小目录让它先侦查/规划再放开（首次工具调用后的
		// 下一轮请求即全量）。晋升标记 = 会话树 rp-tool-staged 协议条目（rp-summary 同款
		// CustomEntry，不进送模流不进历史）；null = 不启用（非目标模型/已晋升，现状全量）。
		// router.enabled=false 时维持现状 staging（toolStaging 默认 true——零变化铁律）。
		const stagingOn = router.enabled === false ? true : router.toolStaging;
		const stagedTools =
			stagingOn && isStagedModel(model.id) && !toolStagedOnBranch(branch)
				? minimalStageTools(tools, readDeps)
				: null;
		const ws = createWorkspace();
		const wsDeps: WorkspaceDeps = {
			rules: extractDraftRules(
				[...materials.presetRuleTexts, ...phAll.map((b) => b.content)],
				materials.statusBarFormats,
			),
			userName: config.userName,
			charName: card.name,
			baseState: state,
			...(materials.sovereigntyRelaxed ? { relaxSovereignty: true } : {}),
			// 语义评审（8/14，DESIGN-semantic-review）：封笔后旁路模型评审设定/人物/文风
			// 一致性——补机械验收判不了的人格漂移盲区。材料自包含（评审提示词独立于
			// 主演上下文）；失败降级为提示，绝不阻断本拍。
			reviewGate: config.semanticReview?.gate === "all" ? "all" : "major",
			...(config.semanticReview?.enabled !== false
				? {
						runSemanticReview: async (draft) => {
							const m = sideModel;
							if (!m) return { error: "尚未配置剧情模型" };
							const auth = await this.#deps.getAuth(m);
							const { systemPrompt, userText } = buildReviewPrompt({
								draft,
								persona: card.personality ?? "",
								presetA: materials.presetResidentA.map((b) => b.content),
								styleBaseline: materials.styleBaseline,
								worldState: formatState(state),
								language: config.language,
							});
							return this.#sideText(m, systemPrompt, userText, auth, "review", traceOn);
						},
					}
				: {}),
		};

		const builtSystemPrompt = buildStageSystemPrompt({
			card,
			config,
			constantLore: constantLoreOf(materials),
			styleBaseline: materials.styleBaseline,
			presetResident: {
				aBlocks: materials.presetResidentA,
				styleTexts: materials.presetResidentB,
				boundaryTexts: materials.presetResidentC,
			},
			skillTopics,
			presetActive: materials.presetActive,
			statusBarFormats: materials.statusBarFormats,
			tools: tools.length > 0,
			// MCP 外设索引进 system（不进每拍注入）：会话内字节稳定，不破前缀缓存。
			// 与旧 director.ts 同一位置——工具清单里有 mcp__ 工具，这里说明它们是什么。
			mcpTools: mcpTools.map((t) => ({ name: t.name, description: t.description })),
			// 梨园化 router：模型分档弱人格（system 区，会话内字节稳定）
			routerPersona: this.#routerPersona,
		});
		// 固定前缀（2026-08-15，开发者调试用）：非空时拼在剧情模型 systemPrompt **最前**
		// （先于卡作者附加指令等一切内容）。config 每拍现读（loadStageMaterials → 读盘），
		// 保存后下一拍生效；agent 循环各轮复用同一 systemPrompt（#agentLoop 的 o.systemPrompt），
		// 前缀自动继承。旁路 / 助手调用不受影响（它们走 #sideText / backfillSideText 自己的提示词）。
		const storyPrefix = config.storyPrefix?.trim();
		const systemPrompt = storyPrefix ? `${storyPrefix}\n\n${builtSystemPrompt}` : builtSystemPrompt;
		const injection = buildStageInjection({
			state,
			activatedLore: activated,
			card,
			config,
			presetTail: phTail,
			presetActive: materials.presetActive,
			statusBarFormats: materials.statusBarFormats,
			languageMismatch,
			panelIndex,
			// P14：rehearsalGuard 默认开——「思考的用法」是轮次纪律的一部分（只读题、
			// 不排练正文）。显式置 false 才关闭（速度基线对照用）。
			rehearsalGuard: config.rehearsalGuard !== false,
			...(wsDeps.rules.wordRange ? { wordRange: wsDeps.rules.wordRange } : {}),
			loreIndex: formatLoreIndex(materials.entries),
			rosterIndex: formatRosterIndex(state),
			// SQL 化：表索引从 TablesService 生成（结构/数据在 db，state.tables 已停用）
			tableIndex: this.#sqlTableIndex(sessionId),
			tools: tools.length > 0,
		});

		// 末端消息 = 动态注入 + 本拍用户原话。
		// 顺序要紧：用户当拍的话必须落在**整个上下文的最后一句**。
		// 注入块（世界状态/索引/导演备注）压在提问之后时，模型会把提问读成历史里的旧话，
		// 于是既不检索也不正面回应——8/03 实测：同一提问，挪到注入之后立刻触发 lorebook_search。
		const endsWithUser = history[history.length - 1]?.role === "user";
		const past = endsWithUser ? history.slice(0, -1) : history;
		// P1 注入层：首轮（规划轮）卡并入注入块（用户话之前）——用户当拍的话必须保持
		// 上下文最后一句（8/03 教训：注入块压提问之后，模型会把提问读成历史旧话）。
		// 轮次卡是工作指令（如 opencode 的 system-reminder），随注入区在用户话前送达。
		// 梨园化 router 模式卡同通道（近场，每拍一张、不累积）——放轮次卡之后、用户话之前。
		const firstCard = roundCardFor(materials.roundCards, ws, config.userName, wsDeps.rules.wordRange, wsDeps.rules.statusBarTagGroup);
		// 【相关表格】向量命中块与模式卡同通道（近场，每拍一张、不累积）——放轮次卡之后
		const cards = [firstCard, this.#routerCard, tableVecBlock].filter(Boolean).join("\n\n");
		const injWithCard = cards ? `${injection}\n\n${cards}` : injection;
		const tailText = endsWithUser ? `${injWithCard}\n\n${history[history.length - 1].text}` : injWithCard;

		const messages: unknown[] = [
			// M4 前情提要：被 rp-summary 覆盖的早期剧情在此回读（历史里那段已整体不存在）。
			// 以 user 角色打头，措辞与 system「消息流约定」里的【前情提要】对上。
			...(summary
				? [
						{
							role: "user",
							content: [{ type: "text", text: `【前情提要】以下是更早剧情的接力摘要，是既定事实：\n\n${summary}` }],
							timestamp: 0,
						},
					]
				: []),
			...past.map((m) =>
				m.role === "user"
					? { role: "user", content: [{ type: "text", text: m.text }], timestamp: 0 }
					: {
							role: "assistant",
							content: [{ type: "text", text: m.text }],
							api: "openai-completions",
							provider: "history",
							model: "history",
							usage: {
								input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: 0,
						},
			),
			{ role: "user", content: [{ type: "text", text: tailText }], timestamp: Date.now() },
		];

		const { apiKey, headers } = await this.#deps.getAuth(model);
		this.#abort = new AbortController();
		const options: Record<string, unknown> = {
			apiKey,
			headers,
			signal: this.#abort.signal,
			sessionId: sm.getSessionId(),
		};
		const thinking = this.#deps.getThinking?.();
		if (thinking) options.reasoning = thinking;
		const samplers = materials.preset?.samplers;
		if (samplers && Object.keys(samplers).length > 0) {
			options.onPayload = (payload: unknown, m: StageModelLike) => {
				if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
				return applyProjectedSamplers(payload as Record<string, unknown>, samplers, {
					provider: m.provider,
					modelId: m.id,
					baseUrl: m.baseUrl,
					api: typeof m.api === "string" ? m.api : undefined,
				});
			};
		}

		// 首轮工具目录 = 双阶段裁剪后的清单（未启用时全量）
		const firstTools = stagedTools ?? tools;
		// 本拍是否出现过工具调用（DSH 晋升触发：turn 收尾时据此落 rp-tool-staged 标记）
		let turnToolUsed = false;

		// 主聊天跟踪：本拍送模完整上下文（system + messages + tools 全文）
		if (traceOn) {
			trace!.record(sessionId, {
				kind: "prompt",
				systemPrompt,
				messages,
				tools: firstTools,
				...(thinking ? { reasoning: thinking } : {}),
			});
		}

		const s = this.#deps.streamFn(model, { systemPrompt, messages, tools: firstTools }, options);
		let final: AssistantMsgLike | null = null;
		let errored: string | undefined;
		let text = "";
		const fwd = this.#draftForwarder();
		for await (const e of s) {
			if (e.type === "done") {
				final = e.message ?? null;
			} else if (e.type === "error") {
				final = e.error ?? null;
				errored = final?.errorMessage || "provider error";
				// 调试增强：主演流式 provider error 属明确非预期返回——统一接口打 ERROR
				debug.error("main-chat", `主演 LLM 返回 provider 错误：${errored}`, {
					round: 0,
					model: modelIdOf(model),
					stopReason: (final as { stopReason?: string })?.stopReason,
				});
			} else if (e.type === "text_delta" && e.delta) {
				text += e.delta;
				ev.onDelta?.("text", e.delta);
			} else if (e.type === "thinking_delta" && e.delta) {
				recordSegment(ws, { kind: "thinking", text: e.delta });
				ev.onDelta?.("thinking", e.delta);
			} else {
				fwd(e);
			}
		}

		// 主聊天跟踪：首轮完整思考原文（流式增量不逐条记，从最终消息块提取）
		if (traceOn) {
			const t = thinkingTextOf(final);
			if (t) trace!.record(sessionId, { kind: "thinking", round: 0, text: t });
		}

		// 尾巴口径（8/09）：稿落地后的 text 通道产出。稿落地前工具轮的旁白（读题/计划）
		// 不算——旁白曾被 mergeFinalText 当尾巴拼到正文尾部（实弹：读题文字跑进正文）。
		let loopTail = "";
		// M-A agent 循环（PLAN-RP-AGENT-EXEC §2.3）：思考→工具→看结果→再思考，直到交稿定稿。
		// 首轮无论 stopReason 都进循环——模型直出正文不调工具时由循环做宽进严出代收（D2）。
		if (!errored && final && final.stopReason !== "aborted") {
			const turn = await this.#agentLoop({
				model,
				options,
				systemPrompt,
				messages,
				first: final,
				tools,
				stagedTools,
				ws,
				wsDeps,
				roundCards: materials.roundCards,
				language: config.language,
				readDeps,
				directText: text,
				traceOn,
			});
			if (turn.final) final = turn.final;
			if (turn.errored) errored = turn.errored;
			text += turn.text;
			loopTail = turn.tailText ?? turn.text;
			turnToolUsed = turn.toolUsed;
		}

		const aborted = final?.stopReason === "aborted";
		if (!text) text = textOfAssistant(final);

		// M-E 兜底封笔：分段续写完但模型始终没调 draft_seal（催告已给过一轮）。
		// 不封笔的稿从未按完整稿验收过——此处程序化补一次，让字数/模块/主权
		// 与一次性交稿走同一口径；报告只进日志，不再回喂模型（本拍已谢幕）。
		if (ws.appends > 0 && !ws.sealed && ws.draft.trim()) {
			await runWriteTool(ws, wsDeps, "draft_seal", {});
			// 调试增强：模型分段续写但忘了 draft_seal（催告过一轮）——程序化补封笔，属非预期
			debug.warning("main-chat", "主演 LLM 续写完未调 draft_seal，引擎程序化补封笔", {
				model: modelIdOf(model),
				appends: ws.appends,
			});
		}

		// 定稿 = 工作区稿（工件）；工作区空（中断半拍/循环认栽）退回直出正文
		// **但**模型常把格式栈尾巴（状态栏/catsay 等）走 text 通道而非 draft_write 参数：
		// 二选一会把那部分连内容一起扔掉（8/05 实锤：模型宣告要出「正文+状态栏+咪咪点评」，
		// draft_write 只交了正文，屏上流式见过三样、落树只剩一样）。故此处**合并**：
		// 稿件为主体，text 里**格式特征**的尾巴补回（纯文本闲聊不进正文）。
		const finalText = mergeFinalText(ws.draft, ws.draft.trim() ? loopTail : text);

		// 落树：正文以定稿为准（保留思考块，剥离工具调用轨迹）；纯错误/空拍不落
		let entryId: string | undefined;
		if (final && finalText) {
			const keep = (final.content ?? []).filter((c) => c.type === "thinking");
			// 时间线随 details 持久化：定稿只留最后一稿正文，但用户要看的
			// 「思考→工具→正文」全链在此保住——resyncAll 全量重放与刷新后仍在。
			// 稿段以定稿为准（工作区空时退回直出正文，时间线里也可能没有稿段）。
			const timeline = finalTimeline(ws, finalText);
			const prevDetails =
				final.details && typeof final.details === "object" && !Array.isArray(final.details)
					? (final.details as Record<string, unknown>)
					: undefined;
			const details = timeline.length ? { ...prevDetails, rpTimeline: timeline } : prevDetails;
			entryId = sm.appendMessage({
				...final,
				content: [...keep, { type: "text", text: finalText }],
				...(details ? { details } : {}),
			});
			sm.flush();
		}

		// 媒体交付落树（8/06 重接）：wire 只认树上的 toolResult 出 image/audio/video/html 帧。
		// 落在正文**之后**——屏上顺序与演出顺序一致（先看正文，再看图）。
		// 正文空拍时也要落：用户可能只让「把刚才那张图再给我看看」，没有正文照样得交付。
		if (!aborted && ws.mediaDeliveries?.length) {
			for (const d of ws.mediaDeliveries) {
				sm.appendMessage({
					role: "toolResult",
					toolName: d.toolName,
					content: [{ type: "text", text: d.text }],
					details: d.details,
					isError: false,
					timestamp: Date.now(),
				});
			}
			sm.flush();
		}

		// DSH 双阶段晋升落树（rp-summary 同款 CustomEntry，不进送模流不进历史）：
		// 本拍出现过工具调用 → 会话升级为全量工具，此后所有拍直接全量（目录只变一次）。
		// 条件里的 stagedTools 非 null 保证只在「启用且未晋升」时落（非目标模型绝不写）。
		if (turnToolUsed && stagedTools) {
			sm.appendCustomEntry(TOOL_STAGED_ENTRY_TYPE, { model: modelIdOf(model), at: Date.now() });
			sm.flush();
		}

		if (errored && !aborted) {
			ev.onNotify?.("error", `生成失败：${errored}`);
			// 调试增强：整拍以错误收场——统一接口打 ERROR
			debug.error("main-chat", `主演整拍生成失败：${errored}`, {
				model: modelIdOf(model),
				userText: lastUserText,
			});
			endTrace(false, errored);
			return { aborted: false, error: errored, entryId };
		}

		// 空手认栽（循环逼稿一次仍无产出）：明说，不再静默丢拍（实弹三拍 0 字正文的教训）
		if (!errored && !aborted && !finalText) {
			ev.onNotify?.("warning", "本拍模型未交出任何正文（已催稿一次仍空手）——请重试或更换模型。");
			// 调试增强：模型空手（非预期）——统一接口打 WARNING
			debug.warning("main-chat", "主演 LLM 未交出任何正文（no-draft）", {
				model: modelIdOf(model),
				stopReason: (final as { stopReason?: string })?.stopReason ?? "?",
				userText: lastUserText,
			});
			endTrace(false, "no-draft");
			return { aborted: false, error: "no-draft" };
		}

		// M-A：#revise 旁路停用（职责由 draft_check 报告 → 模型自改取代；draft_edit 随 M-B）。
		// 记账（8/13 域分工）：主演 world_state_update 干跑验证过的 patch（顶层域）与
		// 场记补丁（tables 域，或主演未提交时的全域兜底）合并后一次落树——先投影主演 patch
		// 作场记 base，场记在其上应用补丁；落树刚完成、叶即本拍新条目，无叶漂移窗口。
		// 注意：主演落账随场记一起延后到旁路调用结束；若场记窗口内用户 swipe/rewind，
		// 叶守卫丢弃整拍记账——账本 = f(分支)（R4），新分支自会从它自己的最近快照重建，
		// 顶层滞后由下拍主演照常提交自愈。
		if (entryId && !aborted) {
			let finalState: WorldState | null = null;
			let note: string | null = null;
			if (finalText) {
				const r = await runScribeTurn(
					{
						// 4096：tables-only 时输出全为表格 JSON（19 表每轮维护），2048 实测可能截断出半截 JSON（8/03）
						sideText: (sp, ut) => this.#sideText(sideModel, sp, ut, { apiKey, headers }, "scribe", traceOn),
						// DESIGN-router P2：tables 域走场记工具循环（模型按维护规则自主查/写，不再全表下发）
						agentTableMaintain: (o) => this.#scribeAgentForTables({ ...o, traceOn }),
						// 祖先链叶漂移判定（同链追加不算漂移）
						isLeafDrifted: (before) => this.#leafDriftedFrom(before),
						// SQL 化：auto 表清单实时（SQLite），旧快照不含新表
						autoTablesFrom: () => this.#autoTablesFrom(sm.getSessionId()),
						getLeafId: () => sm.getLeafId(),
						onActivity: (d) => ev.onActivity?.(d),
					},
					{
						state,
						baseState: ws.patches.length > 0 ? projectedState(ws, state) : state,
						scope: ws.patches.length > 0 ? "tables-only" : "full",
						userText: lastUserText,
						assistantText: finalText,
						charName: materials.card.name,
						userName: materials.config.userName,
					},
				);
				if (r.kind === "applied") {
					// SQL 化：tables-only 时代理直接写库、不产生 WorldState（r.state 可选）
					if (r.state) finalState = r.state;
					note =
						ws.patches.length > 0
							? `记账 ${ws.patches.length} 笔（主演）${r.applied.length > 0 ? ` + 表格 ${r.applied.length} 项（场记）` : ""}`
							: `表格维护 ${r.applied.length} 项（场记）`;
				} else if (r.kind === "failed") {
					console.error(`[stage-scribe] 记账跳过：${r.error}`);
				}
				// r.kind === "stale"：场记窗口内切换了分支 → 整拍记账丢弃（含主演 patch）
			}
			if (!finalState && ws.patches.length > 0) finalState = projectedState(ws, state);
			// 表写日志统一落树（场记代理期间的写库已完成，此处落树不影响叶守卫）
			this.#flushTableLogs();
			if (finalState) {
				// SQL 化（DESIGN-tables-sql）：tables 已迁 SQLite，rp-state 快照不再带全量表数据
				const leanState = { ...finalState, tables: undefined };
				const eid = sm.appendCustomEntry(STATE_ENTRY_TYPE, leanState);
				console.log(
					`[liyuan-trace] [bookkeep] 落账 rp-state ${eid.slice(0, 8)} time=${String((leanState as { time?: unknown }).time ?? "?").slice(0, 24)} loc=${String((leanState as { location?: unknown }).location ?? "?").slice(0, 24)} applied=${note ?? ""}`,
				);
				const stateFile = this.#deps.getStateFile?.(sm.getSessionId());
				if (stateFile) {
					try {
						saveState(stateFile, leanState);
					} catch {
						// 缓存写失败不影响树上快照（账本权威在树，磁盘只是缓存）
					}
				}
				ev.onActivity?.(note ?? `记账 ${ws.patches.length} 笔（模型提交）`);
				sm.flush();
			}
		}

		// M4 长局压缩：攒够拍数就把早期剧情摘要成 rp-summary（装配时回读为【前情提要】）。
		// 放在谢幕前的最后一步——记账已落，摘要能读到最新账本；叶守卫在 runCompaction 内。
		// 压缩失败/未到期都只是跳过，下一拍会再判一次。
		if (entryId && !aborted && finalText) {
			await this.#compact(sideModel, { apiKey, headers }, config.compactEveryNTurns ?? 30);
		}
		endTrace(aborted);
		return { aborted, entryId };
	}

	/**
	 * 手动压缩（/compact）：不等周期，立刻把早期剧情摘要成 rp-summary。
	 * everyNTurns=1 + 更低的字数地板 = 「只要真有可裁的早期剧情就压」
	 * （仍守最近 KEEP_RECENT_BEATS 拍原文，续演点不动）。
	 * 流式中拒绝——压缩要改上下文，不能与正在装配的一拍打架。
	 */
	async compactNow(): Promise<CompactOutcome> {
		if (this.#busy) return { kind: "skipped", reason: "busy" };
		// 手动压缩同口径：旁挂模型 → 剧情模型回退
		const model = this.#deps.getSideModel?.() ?? this.#deps.getModel();
		if (!model) return { kind: "failed", error: "尚未配置剧情模型" };
		this.#busy = true;
		try {
			const { apiKey, headers } = await this.#deps.getAuth(model);
			return await this.#compact(model, { apiKey, headers }, 1, MANUAL_MIN_COMPACT_CHARS);
		} catch (err) {
			return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
		} finally {
			this.#busy = false;
		}
	}

	/** 压缩一次（自动/手动共用）。失败只记日志不抛——压缩从不影响正文。 */
	async #compact(
		model: StageModelLike,
		auth: { apiKey?: string; headers?: Record<string, string> },
		everyNTurns: number,
		minChars?: number,
	): Promise<CompactOutcome> {
		const ev = this.#deps.events ?? {};
		const sm = this.#deps.getSessionManager();
		const materials = loadStageMaterials(this.#deps.cwd);
		const { config, card } = materials;
		// 手动压缩路径（/compact，流式外）：router 收敛尾注随素材现读刷新
		this.#convergeTailOn = materials.router.enabled !== false && materials.router.convergeTail;
		const trace = this.#deps.trace;
		const traceOn = !!trace && config.chatTrace === true;
		try {
			const branch = sm.getBranch() as BranchEntryLike[];
			const c = await runCompaction(
				{
					// 4096：摘要要装下前情/人物/伏笔/事实账五节，且要合并上一份摘要
					sideText: (sp, ut) => this.#sideText(model, sp, ut, auth, "compact", traceOn),
					appendSummaryEntry: (data: RpSummaryData) => sm.appendCustomEntry(SUMMARY_ENTRY_TYPE, data),
					getLeafId: () => sm.getLeafId(),
					isLeafDrifted: (before) => this.#leafDriftedFrom(before),
					archive: this.#deps.archiveCompacted
						? (text) => this.#deps.archiveCompacted!(sm.getSessionId(), text)
						: undefined,
					onActivity: (d) => ev.onActivity?.(d),
				},
				{
					branch,
					state: this.#effectiveState(branch),
					language: config.language,
					userName: config.userName,
					charName: card.name,
					everyNTurns,
					...(minChars !== undefined ? { minChars } : {}),
					// 8/16：压缩侧摘要锚点兜底——regenerate/reroll 切分支后 rp-summary 挂旧叶链，
					// 不带全树会导致每次压缩从会话头全量重摘（实弹：两次压缩输入 742KB 几乎原样重复）
					allEntries: sm.getEntries(),
				},
			);
			if (c.kind === "failed") console.error(`[stage-compact] 压缩跳过：${c.error}`);
			if (c.kind === "compacted") sm.flush();
			return c;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[stage-compact] 压缩异常：${msg}`);
			return { kind: "failed", error: msg };
		}
	}

	/**
	 * 装配用账本：焦点分支有 rp-state 快照（且带表格行数据）用链上的——保持 rewind/fork 分支语义；
	 * 无快照或快照只有空表结构（物化骨架/空账本）时回落磁盘账本（.liyuan-state/<sessionId>.json，
	 * 分支无关的最新账本）。2026-08-11 兜底：编辑回复/导航/回退后焦点分支可能不带有效快照，
	 * 裸装配会读到空账本，场记以空为 base 记账会把表格数据整体顶掉。
	 */
	#effectiveState(branch: BranchEntryLike[]): WorldState {
		const state = stateFromBranch(branch);
		if (stateHasTableData(state)) return state;
		const stateFile = this.#deps.getStateFile?.(this.#deps.getSessionManager().getSessionId());
		if (stateFile) {
			const disk = loadState(stateFile);
			if (stateHasTableData(disk)) return disk;
		}
		return state;
	}

	/**
	 * M-A agent 循环（开放式，PLAN-RP-AGENT-EXEC §2.3）。取代 M3 的检索封顶循环。
	 * 谢幕条件 = 模型停调工具且工作区有稿。宽进严出（D2）：直出正文自动代收为 draft_write
	 * （跑验收，未全绿则报告喂回一轮）；无稿也无正文 → 逼稿一次；MAX_ROUNDS 安全阀，
	 * 触阀撤工具强制收笔。返回续轮累计直出正文（首轮由调用方持有）。
	 */
	async #agentLoop(o: {
		model: StageModelLike;
		options: Record<string, unknown>;
		systemPrompt: string;
		messages: unknown[];
		first: AssistantMsgLike;
		tools: StageTool[];
		/** DSH 双阶段：非 null 时未晋升的轮次只给该 Minimal 目录（读侧+规划），首次工具调用后放开全量 */
		stagedTools: StageTool[] | null;
		ws: TurnWorkspace;
		wsDeps: WorkspaceDeps;
		/** 轮次卡模板（assets/flow/round-cards.json + 配置覆盖，每拍素材现读） */
		roundCards: RoundCardTemplate[];
		/** 剧情语言（统一工具层按面装配描述/schema，M-D1） */
		language: string;
		/** 读侧工具依赖（装配清单与执行同源，M-D2） */
		readDeps: StageToolDeps;
		/** 首轮直出正文（调用方已流式外发） */
		directText: string;
		/** 主聊天跟踪（本拍开关，调用方按 config.chatTrace 现读） */
		traceOn: boolean;
	}): Promise<{ final: AssistantMsgLike | null; errored?: string; text: string; tailText?: string; toolUsed: boolean }> {
		const ev = this.#deps.events ?? {};
		const readDeps = o.readDeps;
		const trace = this.#deps.trace;
		const sessionId = this.#deps.getSessionManager().getSessionId();
		// 走 tools.ts 派发的工具（统一层世界书族/向量库族 + 台上读侧两件）；其余归工作区执行器。
		// 统一层含写侧（lorebook_write/toggle、memory_add/delete），但它们写的是设定集/记忆库
		// 而不是本拍草稿，故仍走 tools.ts 而非 workspace——「读/写」在此不是路由依据，工件归属才是。
		const READ_TOOLS = new Set([
			...unifiedStageToolNames(readDeps),
			"world_state_get",
			"sql_read",
			"writing_guide",
		]);
		// MCP 外设（8/06 重接）：只认**本会话已连接**的限定名——不能只看 mcp__ 前缀，
		// 否则模型幻觉出的服务器名会被当成 MCP 调用，错过「未知工具」的正常报错路径。
		const MCP_TOOLS = mcpStageToolNames(this.#deps.mcp);
		// 媒体交付（8/06 重接）：结果带 details.rp*，收尾时落成 toolResult 条目供 wire 出帧
		const MEDIA_TOOLS = this.#deps.media
			? mediaStageToolNames({ tts: this.#deps.ttsAvailable?.() === true })
			: new Set<string>();
		// 播放音效（8/12）：走实时事件（onPlaySound → play_sound 帧），不落树
		const SOUND_TOOLS = soundFxToolNames();
		const convo = [...o.messages];
		let last: AssistantMsgLike = o.first;
		let text = "";
		let nudged = false; // 逼稿/报告喂回各只给一轮机会，防空转
		let tailPass = false; // 收尾放行（模型停手且有稿时，给一轮机会写格式栈尾巴）
		let sealNudged = false; // 封笔催告（M-E：分段续写完但忘了 draft_seal），只给一轮
		let askEarlyNudged = false; // ask 时机门禁：首轮无上文时暂缓一次，坚持再调放行（求选项例外）
		let userStopped = false; // P7：用户在 ask 选择卡上点了停止——本拍收束
		let lastConsumed = 0; // 本轮开始时 text 长度——判定「本轮新产出文本」用
		// 稿首次落地时的 text 长度：之前的 text 是读题/计划旁白（工具轮的 text 通道产出），
		// 不算正文也不算尾巴；之后的 text 才是尾巴候选（状态栏等）。-1 = 稿未落地。
		let tailStart = -1;
		// 尾巴口径：稿落地后的 text 通道产出（未落地=全量，直出正文路径要整段保留）
		const tailOf = () => (tailStart >= 0 ? text.slice(tailStart) : text);
		// P1 注入层：轮次卡去重——只在工作区状态跨卡类型切换时注入，历史不累积。
		// 首轮（规划卡）已在装配时随 tailText 送达，这里从「开工」状态起跟踪。
		let lastCard = o.ws.plan.length > 0 ? "open" : "plan";
		// DSH 双阶段：本拍是否已出现工具调用（首次调用后的下一轮请求起放开全量）
		let promoted = false;

		for (let round = 0; round < MAX_ROUNDS; round++) {
			lastConsumed = text.length; // 本轮之前的累计文本
			const calls = (last.content ?? []).filter(
				(c): c is { type: string; id?: string; name?: string; arguments?: Record<string, unknown> } =>
					c.type === "toolCall",
			);

			// DSH 双阶段晋升：检测到工具调用（含首轮模型直调）即置位——本轮的请求
			// 就是「首次工具调用后的下一请求」，此后每轮都放开全量目录。
			if (calls.length > 0) promoted = true;

			if (calls.length === 0) {
				// 模型停手：有稿即谢幕——但先确认它不是「还打算写尾巴」。
				//
				// 预设格式栈（状态栏 / catsay 等）常被模型放在 draft_write **之后**的
				// 一轮里输出。旧逻辑在此直接 break，那一轮流式从未发起，模型思考里
				// 「Now the status bar and cat commentary」的意图永远兑现不了——
				// 同一输入 roll 三次，写在同轮的两次有、留到下轮的那次没有（8/05 实锤）。
				// 故：有稿、本轮零产出、且上一轮思考宣告过写尾巴的意图时，
				// 放行一轮收尾（tailPass 只给一次，防空转）。
				if (o.ws.draft.trim()) {
					// M-E：分段续写忘了封笔——稿在但从未按完整稿验收过。催一次封笔
					// （只给一次，防空转）；仍不封则谢幕时兜底封笔，不让本拍丢正文。
					if (o.ws.appends > 0 && !o.ws.sealed && !sealNudged) {
						sealNudged = true;
						convo.push(last);
						convo.push({
							role: "user",
							content: [
								{
									type: "text",
									text:
										`你用 draft_append 续写了 ${o.ws.appends} 段但还没封笔。` +
										`正文写完了就调用 draft_seal 按完整稿验收（字数/禁词/格式/主权全量判定）；还没写完就接着续写。`,
								},
							],
							timestamp: Date.now(),
						});
						continue;
					}
					// 长大纲/多路标：还有未演完的路标时，模型空手停住也不能谢幕——
					// 否则会像 8/15 实弹那样：思考里已经决定写第 3 条，下一轮却空手，
					// 引擎没拦，直接走谢幕把后半截大纲丢了。这里点名剩余路标，催它继续。
					if (o.ws.appends > 0 && !o.ws.sealed && o.ws.plan.some((s) => !s.done)) {
						const left = o.ws.plan.filter((s) => !s.done).length;
						const next = o.ws.plan.find((s) => !s.done)?.text ?? "";
						convo.push(last);
						convo.push({
							role: "user",
							content: [
								{
									type: "text",
									text:
										`路标还剩 ${left} 条没演完（下一条：${next}）。` +
										`用 draft_append 接着演下一条，禁止停在半路；全部演完后再 draft_seal 收笔。`,
								},
							],
							timestamp: Date.now(),
						});
						continue;
					}
					if (tailPass) break; // 谢幕轮只给一次，防空转
					// 程序化谢幕（8/09 输出形式定案）：状态栏 = 本拍结束的标志，必须最后出现。
					// 卡/预设定义了格式块而稿与 text 通道都还没出现过 → 必开一轮谢幕并点名清单，
					// 不再靠思考关键词（hasTailIntent）碰运气——实弹：模型记完账思考里没提
					// 状态栏三个字，直接收场，状态栏整拍蒸发。关键词判定仅兜「rules 没
					// 提取到但模型自己宣告了尾巴」的残余场景。
					// 首轮直出的正文（o.directText）也算已产出——寒暄拍模型第一轮就带状态栏时不再重催
					const producedSoFar = `${o.ws.draft}\n${o.directText}\n${text}`;
					const missingReq = o.wsDeps.rules.requiredTags.filter((t) => !hasFormatTag(producedSoFar, t));
					const sbGroup = o.wsDeps.rules.statusBarTagGroup;
					const sbMissing = sbGroup.length > 0 && !sbGroup.some((t) => hasFormatTag(producedSoFar, t));
					const wanted = [
						...(sbMissing ? [`状态栏（${sbGroup.map((t) => `<${t}>`).join(" 或 ")}）`] : []),
						...missingReq.map((t) => `<${t}>`),
					];
					// 缺格式块时无论本轮有无产出都催（产出里已有就不算缺）；不缺按旧逻辑收场
					if (wanted.length === 0) {
						if (text.trim()) break; // 本轮已有产出（可能正是尾巴）→ 正常谢幕
						if (!hasTailIntent(last) && !hasTailIntent(o.first)) break;
					}
					tailPass = true;
					convo.push(last);
					convo.push({
						role: "user",
						content: [
							{
								type: "text",
								text: wanted.length
									? `剧情已收笔。最后一步：输出 ${wanted.join("、")}——预设定义的谢幕格式块，` +
										`在正文之外直接输出（不进稿纸），输出完本拍结束。不要再写正文。`
									: `正文已收稿。若本拍还有正文之外的收尾内容（状态栏、点评等预设格式块），` +
										`现在直接输出；没有则回空，本拍就此收束。`,
							},
						],
						timestamp: Date.now(),
					});
				} else {
				const direct = `${o.directText}${text}`.trim();
				if (direct) {
					// 宽进严出：直出正文代收（已流式外发过，不重复上屏）。
					// 有计划 = 这拍有戏：代收为 draft_append（第一段）而不是 draft_write——
					// draft_write 全量交稿即天然封笔，会在大纲/路标只演到第一段时提前 sealed，
					// 后续 draft_append 被【谢幕】卡截停，大纲后半截被丢下（8/15 实弹）。
					// internal=true 跳过门禁——代收是兜底，被拦下就等于把这拍正文丢了。
					const asAppend = o.ws.plan.length > 0;
					const r = await runWriteTool(
						o.ws,
						o.wsDeps,
						asAppend ? "draft_append" : "draft_write",
						asAppend ? { segment: direct } : { content: direct },
						true,
					);
					ev.onActivity?.(asAppend ? "直出正文已代收为 draft_append（第 1 段）" : "直出正文已代收为 draft_write");
					// 有计划 = 这拍有戏（8/09 实弹：列了 3 条路标却 385 字一次直出，代收全绿
						// 静默放行，又短又糙还没状态栏）——即使全绿也喂一轮让模型自决续/收
						if ((o.ws.lastGreen && o.ws.plan.length === 0) || nudged) break;
					nudged = true;
					convo.push(last);
					convo.push({
						role: "user",
						content: [
							{
								type: "text",
								text:
									(asAppend
										? `你的正文已被代收为 draft_append（第 1 段，正文应经此工具提交）。验收报告：\n${r.text}\n` +
											`你列了路标却把第一段直出——已代收，不推倒重来。接下来：` +
											`戏还没演完就用 draft_append 接着演，演完 draft_seal 收笔。`
										: `你的正文已被代收为 draft_write（正文本应经此工具提交）。验收报告：\n${r.text}\n` +
											`如需修改请调用 draft_write 重新提交完整正文；无需修改则直接结束。`),
							},
						],
						timestamp: Date.now(),
					});
				} else {
					// 空手停笔（实弹三拍 0 字正文的病灶）：逼稿一次，仍空手才认栽
					if (nudged) break;
					nudged = true;
					convo.push(last);
					convo.push({
						role: "user",
						content: [
							{
							type: "text",
							text:
								o.ws.lookups > 0
									? "你还没有落笔——用 draft_append 一段一段演（一段约一个自然段），演完 draft_seal 收笔，否则本拍无产出。"
									: "你还没有落笔——用 draft_append 演一段（这一拍没有戏才用 draft_write 一次交完），否则本拍无产出。",
						},
						],
						timestamp: Date.now(),
					});
				}
				}
			} else {
				convo.push(last);
				// 演段轮连发门禁（8/08 晚定案）：同一轮生成里只允许演**一段**。
				// 模型连发 append+done+append 时，轮次卡（下一轮才注入）追不上它——
				// 「回看→重新评估→再演」必须在两次生成之间发生，不能靠工具连发绕过。
				// 故：本轮已 append 过后，再来的 draft_append 拒收，回喂四问，强制停下思考。
				let appendedThisRound = false;
				for (const call of calls) {
					const name = call.name ?? "";
					const callT0 = Date.now();
					// 主聊天跟踪：工具调用（含被门禁拦下的——配对 tool_result 缺失即被拦）
					if (o.traceOn) {
						trace?.record(sessionId, { kind: "tool_call", name, arguments: call.arguments ?? {}, round });
					}
					// P7：ask 工具——弹出选择卡等用户应答，答案作为新输入回喂（计划据此重拟）。
					// 用户停止（undefined）→ 本拍收束：不再续轮，直接以现稿定稿。
					let r: ToolRunResult | MediaStageResult;
					if (name === "ask" && this.#deps.askUser) {
						// ask 时机门禁（8/09 三分类）：①主动触发（用户在求方向/递笔）随时可问，含第 1 轮；
						// ②变量触发需要正文上文——没落笔时暂缓一次，导向「记着变量，演到跟前再问」。
						// 引擎分不清 ①②（意图在用户输入里），故软硬结合：首拦一次；模型坚持再调
						// ＝它判断属于①类（拒收文案已给出该例外），放行。
						if (o.ws.appends === 0 && !o.ws.draft.trim() && !askEarlyNudged) {
							askEarlyNudged = true;
							r = {
								text:
									`还没落笔，暂缓一步：**变量类**的拍板要等用户看到段落上文才好选——记着这个变量，` +
									`演到它实际影响剧情的段落之前再 ask。` +
									`但如果用户本轮输入本身就是在求方向/递笔（「接下来去找谁」「给个选项」「让我选」），` +
									`那属于主动触发、不需要上文——再调一次 ask 即可，会照常弹给用户。`,
								activity: "ask 被暂缓（变量类需演出上文）",
								ok: false,
							};
							ev.onActivity?.(r.activity);
							recordSegment(o.ws, {
								kind: "tool",
								activity: { kind: "tool_start", name: "ask", detail: r.activity },
							});
							convo.push({
								role: "toolResult",
								toolCallId: call.id,
								toolName: "ask",
								content: [{ type: "text", text: r.text }],
								isError: false,
								timestamp: Date.now(),
							});
							continue;
						}
						const q = String(call.arguments?.question ?? "").trim() || "请你定夺";
						const raw = call.arguments?.options;
						const options = Array.isArray(raw)
							? raw.map((s) => String(s).trim()).filter(Boolean)
							: [];
						// 停下来等用户：回合制共创，不设超时；abort 信号透传（用户点停止即收敛）
						const answer = await this.#deps.askUser(q, options, this.#abort?.signal);
						o.ws.lookups++; // 用户参与选择＝这一拍有戏（draft_write 门禁判据）
						if (answer === undefined) {
							// 用户停止：笔还给用户，本拍收束——标记后跳出循环
							ev.onActivity?.(`ask「${q.slice(0, 24)}」· 用户停止`);
							userStopped = true;
							recordSegment(o.ws, {
								kind: "tool",
								activity: { kind: "tool_start", name: "ask", detail: "用户停止——笔还给用户" },
							});
							break;
						}
						r = {
							text:
								`用户已作答：「${answer}」。按这个答案继续演——` +
								`如果它改变了剧情走向，先 beat_plan 重拟剩下的步骤再往下写。`,
							activity: `ask「${q.slice(0, 24)}」· 用户作答`,
						};
						ev.onActivity?.(r.activity);
						recordSegment(o.ws, {
							kind: "tool",
							activity: { kind: "tool_start", name: "ask", detail: r.activity },
						});
						convo.push({
							role: "toolResult",
							toolCallId: call.id,
							toolName: "ask",
							content: [{ type: "text", text: r.text }],
							timestamp: Date.now(),
						});
						continue;
					}
					// 演段轮连发门禁（8/08 晚定案）：同一轮生成里只允许演**一段**。
					// 模型连发 append+done+append 时，轮次卡（下一轮才注入）追不上——
					// 「回看→重新评估→再演」必须在两次生成之间发生。本轮已 append 过，
					// 再来的 draft_append 拒收并回喂四问，强制模型停下思考再生成。
					if (name === "draft_append" && appendedThisRound) {
						r = {
							text:
								`已收上一段。同一轮里只演一段——先回看刚写下的，重新评估：` +
								`这段的戏接下去怎么演、要不要 \`ask\` 用户（剧情到岔路了吗）、` +
								`剩余路标还成立吗（不成立就 \`beat_plan\` 重拟）、戏到停点了吗。` +
								`想清楚，下一轮再落下一段。`,
							activity: "同轮连演被拦下（需回看思考）",
							ok: false,
						};
						ev.onActivity?.(r.activity);
						recordSegment(o.ws, {
							kind: "tool",
							activity: { kind: "tool_start", name, detail: r.activity },
						});
						convo.push({
							role: "toolResult",
							toolCallId: call.id,
							toolName: name,
							content: [{ type: "text", text: r.text }],
							isError: false,
							timestamp: Date.now(),
						});
						continue;
					}
					// 演段轮零思考门禁（8/08 晚定案）：上一条消息没有思考就 append，
					// 说明没承接路标想「这段怎么演」——拒收一次，回喂承接指引。
					// 判定看 last.content 是否含 thinking 块（思考+工具同轮输出也算有思考——
					// 8/08 修：thinking_delta 可能不走流式而随消息到达，上一轮 stream 统计会漏判）。
					// 只拦「续写第二段及以后」：首段前有第 1 轮的大构思，不算零思考。
					const lastHadThink = (last.content ?? []).some(
						(c) => c.type === "thinking" && (c.thinking ?? "").trim().length > 0,
					);
					if (name === "draft_append" && o.ws.appends > 0 && !lastHadThink) {
						r = {
							text:
								`未收段。你上一轮没有思考就直接落笔——路标只说「发生什么」，` +
								`这一段要在落笔前想清楚：发生什么、动作怎么推进、人物此刻的状态与反应、` +
								`有没有一个细节立住这一段（文风按 \`# 文风基准\` 执行）。` +
								`回看刚写下的，承接路标把这一段写好，想好了再交。`,
							activity: "零思考落笔被拦下（需承接路标）",
							ok: false,
						};
						ev.onActivity?.(r.activity);
						recordSegment(o.ws, {
							kind: "tool",
							activity: { kind: "tool_start", name, detail: r.activity },
						});
						convo.push({
							role: "toolResult",
							toolCallId: call.id,
							toolName: name,
							content: [{ type: "text", text: r.text }],
							isError: false,
							timestamp: Date.now(),
						});
						continue;
					}
					// 演段轮未修违规门禁（8/08 晚定案 + 8/09 收紧）：
					// 上一段验收出的违规未修掉就不许**任何推进**（append/done/seal）——
					// 用户看到的每一段，在他看下一段之前必须是最终形态。
					// 8/09：原来只拦 append，模型照样勾步/封笔把修复拖走；现在
					// 只放行修复相关（draft_edit/draft_write）与只读（read/search/check）。
					// 修复是写段后的固定下一步：写完 → 报告 → 只能修 → 替换上屏 → 才继续。
					const ADVANCE_TOOLS = new Set(["draft_append", "beat_step_done", "draft_seal"]);
					if (ADVANCE_TOOLS.has(name) && o.ws.pendingViolations.length > 0) {
						r = {
							text:
								`${name === "draft_append" ? "未收段" : name === "draft_seal" ? "未封笔" : "未勾步"}。` +
								`上一段还有 ${o.ws.pendingViolations.length} 处未修：\n` +
								o.ws.pendingViolations.map((v) => `- ${v}`).join("\n") +
								`\n先用 \`draft_edit\` 逐处修掉（old 逐字引用现稿原文、须唯一，可一次给多处），` +
								`验收过了再继续——已经交给用户看的段落必须是定稿。`,
							activity: `推进被拦下（${o.ws.pendingViolations.length} 处未修）`,
							ok: false,
						};
						ev.onActivity?.(r.activity);
						recordSegment(o.ws, {
							kind: "tool",
							activity: { kind: "tool_start", name, detail: r.activity },
						});
						convo.push({
							role: "toolResult",
							toolCallId: call.id,
							toolName: name,
							content: [{ type: "text", text: r.text }],
							isError: false,
							timestamp: Date.now(),
						});
						continue;
					}
					if (name === "draft_append") appendedThisRound = true;
					// 三态路由 +MCP：统一层/台上读侧 → tools.ts；MCP 外设 → hub；其余 → 工作区。
					// MCP 走网络/子进程，可能很慢——把本拍 abort 信号透传下去，用户点停止能立刻中断。
					r = name === "assistant_run"
						? ((await runAssistantStageTool(name, call.arguments ?? {}, this.#abort?.signal)) ?? {
								text: `未知工具「${name}」。`,
								isError: true,
							})
						: MCP_TOOLS.has(name)
							? ((await runMcpStageTool(
									this.#deps.mcp!,
									name,
									call.arguments ?? {},
									this.#abort?.signal,
								)) ?? { text: `未知工具「${name}」。`, isError: true })
							: MEDIA_TOOLS.has(name)
								? ((await runMediaStageTool(this.#deps.cwd, name, call.arguments ?? {})) ?? {
										text: `未知工具「${name}」。`,
										isError: true,
									})
								: SOUND_TOOLS.has(name)
									? runSoundFxTool(
											(sound, volume) => ev.onPlaySound?.(sound, volume),
											name,
											call.arguments ?? {},
										)
						: READ_TOOLS.has(name)
						? await this.#runReadTool(o, readDeps, name, call.arguments ?? {})
						: await runWriteTool(o.ws, o.wsDeps, name, call.arguments ?? {});
					// 主聊天跟踪：工具执行结果（含耗时）+ 写侧草稿动作（交稿全文与验收）
					if (o.traceOn) {
						trace?.record(sessionId, {
							kind: "tool_result",
							name,
							text: r.text,
							isError: (r as { isError?: boolean }).isError === true,
							elapsedMs: Date.now() - callT0,
							round,
						});
						if (DRAFT_TOOLS.has(name)) {
							trace?.record(sessionId, {
								kind: "draft",
								action: name,
								args: (call.arguments ?? {}) as Record<string, unknown>,
								ok: (r as { ok?: boolean }).ok !== false,
								result: r.text,
							});
						}
					}
					// 媒体交付要落成 toolResult 条目（wire 只认树上的 toolResult 出媒体帧）——
					// 台上引擎默认剥离工具轨迹，故在此单独收集，谢幕后随正文一起落树。
					const mediaDetails = (r as MediaStageResult).details;
					if (MEDIA_TOOLS.has(name) && mediaDetails && (r as MediaStageResult).isError !== true) {
						o.ws.mediaDeliveries = o.ws.mediaDeliveries ?? [];
						o.ws.mediaDeliveries.push({ toolName: name, details: mediaDetails, text: r.text });
					}
					// 每轮修复可见性（8/09 输出形式定案）：draft_edit 修改后**分段重同步**——
					// 前端把全部稿段原位替换成修后分段，该段原地变新，无重复、不塌段。
					// （旧做法发「全稿 + reset」只替换末段，前面稿段还在屏上 → 正文重复。）
					if (name === "draft_edit" && r.ok !== false && o.ws.draft.trim()) {
						ev.onDraftResync?.(splitDraftSegments(o.ws.draft));
					}
					// 时间线：工具按调用位置入档（draft_write/edit 的正文另由 #recordDraft 记）
					recordSegment(o.ws, { kind: "tool", activity: { kind: "tool_start", name, detail: r.activity ?? "" } });
					if (r.activity) ev.onActivity?.(r.activity);
					convo.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: name,
						content: [{ type: "text", text: r.text }],
						// MCP 失败必须如实标记：模型据此改道或如实告知用户，而不是当成功往下演
						isError: (r as { isError?: boolean }).isError === true,
						timestamp: Date.now(),
					});
				}
			}

			// P7：用户停止（ask 卡上点了停止）——本拍收束，不再续轮
			if (userStopped) break;

			// 中间轮旁白（8/09 实弹）：稿落地前、工具轮里流出的 text 是读题/计划旁白——
			// 通知前端清掉（收进过程条）；tailStart 一旦标记（稿已落地），之后的 text
			// 归尾巴候选，不再清（状态栏后调记账的场景，状态栏不能被当旁白删掉）。
			// round 0 的旁白在 performTurn 首轮流里（o.directText），不在本层 text 统计中。
			if (tailStart < 0) {
				const talked = text.length > lastConsumed || (round === 0 && o.directText.trim().length > 0);
				if (calls.length > 0 && talked) ev.onStreamClear?.();
				if (o.ws.draft.trim()) tailStart = text.length;
			}

			// 安全阀最后一轮撤掉工具：模型只能收笔（触阀后以现稿/直出定稿）
			const lastRound = round >= MAX_ROUNDS - 1;
			const ctx: Record<string, unknown> = { systemPrompt: o.systemPrompt, messages: convo };
			if (!lastRound) {
				// DSH 双阶段：未晋升时每轮只给 Minimal 目录（读侧+规划）；首次工具调用后的
				// 下一轮请求起放开全量。末轮安全阀撤工具逻辑不变。
				ctx.tools = o.stagedTools && !promoted ? o.stagedTools : o.tools;
			}
			else {
				// 8/09：撤工具的同时必须告知收场（实弹：轮次耗尽后模型不明所以干想一轮
				// 散场，状态栏没了）——点名输出格式块，这一轮产出走 text 通道拼进定稿。
				const sbG = o.wsDeps.rules.statusBarTagGroup;
				const sbNote =
					sbG.length > 0 && !sbG.some((t) => hasFormatTag(`${o.ws.draft}\n${text}`, t))
						? `直接输出状态栏（${sbG.map((t) => `<${t}>`).join(" 或 ")}）等格式块收场——不要再写正文。`
						: `就此收场，不要再写正文。`;
				convo.push(nowMsg(`【收场】本拍轮次已达上限，工具已收起。${sbNote}`));
			}

			// P1 注入层：按工作区状态注入当前轮次卡。
			// 规划/开工卡：状态切换才注入一次（一次性指令）。
			// 演段回看卡 / 收笔评估卡：**每轮都注入**——循环指令，每轮重新看到
			// （8/08 修：旧逻辑只切一次，模型后面几轮看不到评估指令）。
			// 用替换语义防累积：推新卡前把上一张卡从 convo 里移除（匹配前缀 = 模板 title）。
			const card = roundCardFor(o.roundCards, o.ws, o.wsDeps.userName, o.wsDeps.rules.wordRange, o.wsDeps.rules.statusBarTagGroup);
			const hasPending = o.ws.plan.some((s) => !s.done);
			const draftBodyChars = o.ws.draft.trim() ? extractDraftBody(o.ws.draft).replace(/\s+/g, "").length : 0;
			const wordRange = o.wsDeps.rules.wordRange;
			// 修复态优先：有未修违规 → "fix"（修复卡，先修再演）
			const fixing = o.ws.appends > 0 && o.ws.pendingViolations.length > 0;
			// 续写态：路标演完但字数未达标——cardKind 归 "extend"，走替换语义
			const extending = !fixing && o.ws.appends > 0 && !hasPending && !!wordRange && draftBodyChars < wordRange.min;
			const cardKind = o.ws.appends > 0
				? fixing ? "fix" : o.ws.sealed ? "curtain" : extending ? "extend" : hasPending ? "review" : "seal"
				: o.ws.plan.length > 0 ? "open" : "plan";
			if (card) {
				if (cardKind === "review" || cardKind === "seal" || cardKind === "extend" || cardKind === "fix" || cardKind === "curtain") {
					// 替换上一张卡（找最后一个 role=user 且以循环卡 title 开头）
					const cycleTitles = titlesOf(o.roundCards, ["review", "seal", "extend", "fix", "curtain"]);
					for (let k = convo.length - 1; k >= 0; k--) {
						const msg = convo[k] as { role?: string; content?: Array<{ type?: string; text?: string }> };
						const txt = Array.isArray(msg.content)
							? msg.content.map((c) => c.text ?? "").join("")
							: "";
						if (msg.role === "user" && cycleTitles.some((t) => t && txt.includes(t))) {
							convo.splice(k, 1);
							break;
						}
					}
					convo.push(nowMsg(card));
				} else if (cardKind !== lastCard) {
					lastCard = cardKind;
					convo.push(nowMsg(card));
				}
			}

			const s = this.#deps.streamFn(o.model, ctx as never, o.options);
			let final: AssistantMsgLike | null = null;
			const fwd = this.#draftForwarder();
			// thinking_delta 入时间线（思考→工具→正文全链）。零思考门禁的判定
			// 看 last.content 是否含 thinking 块（见 append 拦截处），不在流式层统计。
				for await (const e of s) {
					if (e.type === "done") final = e.message ?? null;
					else if (e.type === "error") {
						return { final: e.error ?? null, errored: e.error?.errorMessage || "provider error", text, tailText: tailOf(), toolUsed: promoted };
					} else if (e.type === "text_delta" && e.delta) {
					text += e.delta;
					// 稿已存在后的正文外产出（状态栏/catsay 等格式尾巴）入时间线按序记档；
					// 定稿时由 finalTimeline 吸收进稿段（内容以 mergeFinalText 为准）。
					if (o.ws.draft.trim()) recordSegment(o.ws, { kind: "text", text: e.delta });
					ev.onDelta?.("text", e.delta);
				} else if (e.type === "thinking_delta" && e.delta) {
					recordSegment(o.ws, { kind: "thinking", text: e.delta });
					ev.onDelta?.("thinking", e.delta);
				} else {
					fwd(e);
				}
			}
			// 主聊天跟踪：本轮完整思考原文（round+1：0 是首轮，已在 #turn 记）
			if (o.traceOn) {
				const t = thinkingTextOf(final);
				if (t) trace?.record(sessionId, { kind: "thinking", round: round + 1, text: t });
			}
			if (!final) return { final: last, text, tailText: tailOf(), toolUsed: promoted };
			last = final;
			if (final.stopReason === "aborted") break;
		}
		return { final: last, text, tailText: tailOf(), toolUsed: promoted };
	}

	/**
	 * 台上读侧工具，并把「查过世界」记进工作区。
	 *
	 * lookups 是 draft_write 门禁的判据（见 workspace.ts runWriteTool）：查过设定/旧账/
	 * 账本＝这一拍中途确实有要停下来处理的事＝有戏，本该一段一段演。
	 * writing_guide 读的是写作方法论而非世界事实，不计入。
	 */
	async #runReadTool(
		o: { ws: TurnWorkspace; language: string },
		readDeps: StageToolDeps,
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolRunResult> {
		if (name !== "writing_guide") o.ws.lookups++;
		return runStageTool(readDeps, name, args, o.language);
	}

	/**
	 * D1：draft_write / draft_append 的正文参数流式转发——工件正文照常逐字上屏。
	 * toolcall_delta 用渐进解析的 arguments（openai-completions 每帧重解 partialArgs）；
	 * toolcall_end 兜底补齐后缀（faux 等不做渐进解析的 provider 在此整段上屏）。
	 * 每条流各建一个（sent 按 contentIndex 记已发长度，保证不重发）。
	 *
	 * M-E：draft_append 是**追加**语义，reset 必须为 false——已上屏的段落是
	 * 已经发生的事，续写不能把它擦掉重排（那正是分段续写要消除的体验）。
	 */
	#draftForwarder(): (e: StageStreamEvent) => void {
		const ev = this.#deps.events ?? {};
		const sent = new Map<number, number>();
		const forward = (idx: number, content: unknown, append = false) => {
			if (typeof content !== "string") return;
			const prev = sent.get(idx) ?? 0;
			if (content.length <= prev) return;
			// draft=true：稿件流是替换语义（重交不叠加）——与 runWriteTool 的
			// replaceDraftSegment 同语义，wire 层透传给前端时间线。
			// reset=true：本次 draft_write 调用的首个分片——前端用它清掉旧稿。
			const isFirst = !append && !sent.has(idx);
			ev.onDelta?.("text", content.slice(prev), true, isFirst);
			sent.set(idx, content.length);
		};
		/** 取正文参数：draft_write 用 content，draft_append 用 segment */
		const pick = (name: string | undefined, args: Record<string, unknown> | undefined) => {
			if (name === "draft_write") return { text: args?.content, append: false };
			if (name === "draft_append") return { text: args?.segment, append: true };
			return undefined;
		};
		return (e) => {
			const idx = e.contentIndex;
			if (typeof idx !== "number") return;
			if (e.type === "toolcall_delta") {
				const block = e.partial?.content?.[idx];
				if (block?.type !== "toolCall") return;
				const p = pick(block.name, block.arguments);
				if (p) forward(idx, p.text, p.append);
			} else if (e.type === "toolcall_end") {
				const p = pick(e.toolCall?.name, e.toolCall?.arguments);
				if (p) forward(idx, p.text, p.append);
			}
		};
	}

	/**
	 * 台上工具的执行依赖（每次取用现读素材/账本——工具看到的世界与装配同源）。
	 * lastUserText 供写入门禁判定（M-D2）：门禁问的是「用户本拍有没有要求记录」。
	 */
	#toolDeps(lastUserText = ""): StageToolDeps {
		const cwd = this.#deps.cwd;
		const sm = this.#deps.getSessionManager();
		/** 台上补充设定集路径（写侧落点；卡未装载时为空＝无 lorebook_write） */
		const overlayOf = (): string => {
			try {
				const m = loadStageMaterials(cwd);
				return overlayPathFor(cwd, m.card.name);
			} catch {
				return "";
			}
		};
		return {
			searchLore: (query, limit) => {
				const m = loadStageMaterials(cwd);
				// 语料 = 世界书 + 补充设定集（materials 已剥离外部插件协议条目）+ 当前分支挂载的知识库。
				// 知识库此前只有扩展侧搜得到，台上描述却一直承诺「已挂载知识库」——M-D1 补齐（PLAN-RP-TOOLING）。
				const codex: LorebookEntry[] = [];
				for (const name of codexNamesFromBranch(sm.getBranch() as BranchEntryLike[])) {
					try {
						codex.push(...(loadCodexEntries(cwd, name) ?? []));
					} catch {
						// 单个库读不出不该拖垮整次检索
					}
				}
				return searchEntries(codex.length > 0 ? [...m.entries, ...codex] : m.entries, query, limit);
			},
			// ---- M-D2 世界书族 ----
			writeLore: (input) => {
				const overlay = overlayOf();
				if (!overlay) return null;
				return appendOverlayEntry(overlay, input);
			},
			listLore: () => loadStageMaterials(cwd).entries,
			fingerprint: loreFingerprint,
			...(this.#deps.setDisabledLore ? { toggleLore: this.#deps.setDisabledLore } : {}),
			gate: () => ({ lastUserText, creationMode: loadStageConfig(cwd).creationMode }),
			searchMemory: async (query) => {
				const search = this.#deps.searchMemory;
				if (!search) return [];
				return search(sm.getSessionId(), query);
			},
			// ---- M-D3 向量库写侧：scope 由宿主绑定，模型只给内容（作用域不经模型） ----
			...(this.#deps.addMemory
				? { addMemory: (input: { text: string; title?: string }) => this.#deps.addMemory!(sm.getSessionId(), input) }
				: {}),
			...(this.#deps.listMemory
				? { listMemory: (storeId: string) => this.#deps.listMemory!(sm.getSessionId(), storeId) }
				: {}),
			...(this.#deps.deleteMemory
				? { deleteMemory: (storeId: string, id: string) => this.#deps.deleteMemory!(sm.getSessionId(), storeId, id) }
				: {}),
			// ---- M-D4 角色库：只读卡面 ----
			readCard: () => {
				const m = loadStageMaterials(cwd);
				const c = m.card;
				if (!c) return null;
				return {
					name: c.name,
					description: c.description,
					personality: c.personality,
					scenario: c.scenario,
					firstMes: c.firstMes,
					mesExample: c.mesExample,
					systemPrompt: c.systemPrompt,
					creatorNotes: c.creatorNotes,
					tags: c.tags,
					alternateGreetings: c.alternateGreetings,
				};
			},
			// ---- M-D5 面板：读/写/关（依赖由宿主按 session 注入） ----
			...(this.#deps.loadPanels
				? {
						loadPanels: () => this.#deps.loadPanels!(sm.getSessionId()),
						writePanel: (input: { name: string; kind: string; content: string }) =>
							this.#deps.writePanel!(sm.getSessionId(), input),
						closePanel: (name: string) => this.#deps.closePanel!(sm.getSessionId(), name),
					}
				: {}),
			// ---- codex 族：读/写直接走 src/codex.ts 纯函数（只依赖 cwd）；挂载走宿主回调 ----
			listCodexes: () => listCodexes(cwd),
			readCodex: (name) => loadCodexEntries(cwd, name),
			createCodexFn: (name, description) => createCodex(cwd, name, description),
			writeCodex: (name, input) => appendCodexEntry(cwd, name, input),
			deleteCodexEntryFn: (name, fingerprint) => deleteCodexEntry(cwd, name, fingerprint),
			// fingerprint 已由世界书族提供（同一 loreFingerprint），codex 族复用，不重复声明
			...(this.#deps.mountCodex
				? {
						mountedCodexes: () => codexNamesFromBranch(sm.getBranch() as BranchEntryLike[]),
						mountCodex: (name: string, enabled: boolean) => this.#deps.mountCodex!(sm.getSessionId(), name, enabled),
					}
				: {}),
			// ---- choice：宿主出选择卡（透传引擎 abort 信号，停止即结算为「用户停止」） ----
			...(this.#deps.select
				? {
						select: (title: string, options: string[], opts?: { signal?: AbortSignal }) =>
							this.#deps.select!(title, options, { ...(opts ?? {}), signal: opts?.signal ?? this.#abort?.signal }),
					}
				: {}),
			getState: () => this.#effectiveState(sm.getBranch() as BranchEntryLike[]),
			// SQL 表格服务（DESIGN-tables-sql）：主演 sql_read/sql_write 执行入口
			tables: {
				execRead: async (sql) => {
					const svc = this.#tablesFor(sm.getSessionId());
					const r = svc.execRead(sql);
					return r.ok ? { ok: true, rows: r.rows ?? [] } : { ok: false, error: r.error };
				},
				execWrite: async (sql) => {
					const svc = this.#tablesFor(sm.getSessionId());
					const r = svc.execWrite(sql);
					return r.ok ? { ok: true, changes: r.changes, lastInsertRowid: r.lastInsertRowid } : { ok: false, error: r.error };
				},
			},
			formatState,
			getSkill: (topic) => {
				// 1) 预设 skillPacks（拆层产物）
				const pack = loadStageMaterials(cwd).skillPacks.get(topic);
				if (pack) return pack;
				// 2) 演出主题 fallback：读 .liyuan-skills/<topic>.md（仅限技能库内文件名，防路径穿越）
				if (!/^[A-Za-z0-9\u4e00-\u9fa5-]+$/.test(topic)) return undefined;
				try {
					return readFileSync(join(skillsDir(cwd), `${topic}.md`), "utf8");
				} catch {
					return undefined;
				}
			},
		};
	}

	/** 装配报告写盘（.liyuan/preset-assembly.json）——每块预设去向可查；内容不变不写 */
	#writeAssemblyReport(
		cwd: string,
		materials: StageMaterials,
		phReport: AssemblyReportItem[],
		phTail: PresetResidentContent,
	): void {
		try {
			const report = {
				preset: materials.preset?.name ?? null,
				splitTable: materials.splitTable?.key ?? null,
				sovereigntyRelaxed: materials.sovereigntyRelaxed,
				// 常驻字数 = system 静态 + postHistory 每拍归拢（两通道合计才是真常驻）
				residentChars: {
					A:
						materials.presetResidentA.reduce((n, b) => n + b.content.length, 0) +
						phTail.aBlocks.reduce((n, b) => n + b.content.length, 0),
					B: materials.presetResidentB.join("").length + phTail.styleTexts.join("").length,
					C: materials.presetResidentC.join("").length + phTail.boundaryTexts.join("").length,
				},
				skillChars: Object.fromEntries([...materials.skillPacks].map(([t, s]) => [t, s.length])),
				// M-C2：世界书/卡内嵌通道被判死的外部插件协议条目（判据可回溯）
				protocolDrops: materials.protocolDrops,
				blocks: [...materials.presetAssembly, ...phReport],
			};
			const json = JSON.stringify(report, null, "\t");
			if (json === this.#lastAssemblyJson) return;
			this.#lastAssemblyJson = json;
			const outDir = join(cwd, ".liyuan");
			mkdirSync(outDir, { recursive: true });
			writeFileSync(join(outDir, "preset-assembly.json"), json, "utf8");
		} catch {
			// 报告写失败不影响演出
		}
	}

	// M-A 起 #revise 精修旁路退役：职责由「draft_check 报告 → 模型自改重交」结构性取代。
	// revise.ts 的补丁解析函数保留给 M-B 的 draft_edit 工具复用。

	/** 旁路文本调用（评审/场记/压缩）：静默收集，不外发增量；失败返回 {error} */
	async #sideText(
		model: StageModelLike,
		systemPrompt: string,
		userText: string,
		auth: { apiKey?: string; headers?: Record<string, string> },
		/** 用途（主聊天跟踪 side 事件；评审/场记/压缩）。maxTokens 由调用方按需覆盖 */
		purpose = "side",
		traceOn = false,
	): Promise<string | { error: string }> {
		const t0 = Date.now();
		// 旁路参数统一（2026-08-10 用户裁决，与 backfill/规划同口径）：中等思考 + 大预算。
		// maxTokens 优先用模型档案配置（连接面板「最大回复 tokens」，用户 8/15 指出档案为 16K）；
		// 档案未配才落到 81920 兜底（backfill/规划同值）。
		const modelMax = typeof (model as { maxTokens?: unknown }).maxTokens === "number" ? ((model as { maxTokens: number }).maxTokens) : 0;
		const options: Record<string, unknown> = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			// 旧口径 reasoning off + 4096 曾导致场记输出截断/空输出（8/15 实弹，trace 见
			// .liyuan-state/trace/019fec6e…：side 事件 ok=false 无 text）。思考计入 token，
			// 预算给足（档案 16K 或 81920 兜底）；超限由 API 拒绝（逐表派发/回填的重试兜底）。
			maxTokens: modelMax > 0 ? modelMax : 81920,
			reasoning: "medium",
			signal: this.#abort?.signal,
		};
		try {
			// 梨园化 router（DESIGN-router §3 A 类旁路）：统一收敛尾注（信息完备即产出，
			// 防旁路飘；enabled=false 时 #convergeTailOn 恒 false = 零变化）。reasoning 档位不动。
			const sys = this.#convergeTailOn ? `${systemPrompt}${CONVERGE_TAIL}` : systemPrompt;
			const s = this.#deps.streamFn(
				model,
				{
					systemPrompt: sys,
					messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
				},
				options,
			);
			let final: AssistantMsgLike | null = null;
			for await (const e of s) {
				if (e.type === "done") final = e.message ?? null;
				else if (e.type === "error") {
					const msg = e.error?.errorMessage || `stopReason=${e.error?.stopReason ?? "?"}`;
					this.#sideTrace(purpose, model, sys, userText, false, msg, t0, traceOn);
					// 调试增强：旁路返回 provider error——统一接口打 ERROR
					debug.error("side-text", `旁路(${purpose}) LLM 返回 provider 错误：${msg}`, {
						model: modelIdOf(model),
						elapsedMs: Date.now() - t0,
					});
					return { error: msg };
				}
			}
			if (!final) {
				this.#sideTrace(purpose, model, sys, userText, false, "流未产出最终消息", t0, traceOn);
				// 调试增强：旁路流未产出最终消息（非预期）——统一接口打 ERROR
				debug.error("side-text", `旁路(${purpose}) LLM 流未产出最终消息`, {
					model: modelIdOf(model),
					elapsedMs: Date.now() - t0,
				});
				return { error: "流未产出最终消息" };
			}
			const text = textOfAssistant(final);
			this.#sideTrace(purpose, model, sys, userText, !!text, text || undefined, t0, traceOn);
			if (!text) {
				// 调试增强：旁路最终消息无文本（非预期，如场记截断/空输出）——统一接口打 WARNING
				debug.warning("side-text", `旁路(${purpose}) LLM 最终消息无文本`, {
					model: modelIdOf(model),
					stopReason: (final as { stopReason?: string })?.stopReason ?? "?",
					elapsedMs: Date.now() - t0,
				});
			}
			return text || { error: "最终消息无文本" };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.#sideTrace(purpose, model, systemPrompt, userText, false, msg, t0, traceOn);
			// 调试增强：旁路调用异常（throw）——统一接口打 ERROR
			debug.error("side-text", `旁路(${purpose}) LLM 调用异常：${msg}`, {
				model: modelIdOf(model),
				elapsedMs: Date.now() - t0,
			});
			return { error: msg };
		}
	}

	/**
	 * 旁路工具循环（DESIGN-router 接口化 P2）：模型可发工具调用 → 执行 → 回喂 → 再调，
	 * 直到停止调用或达到轮数上限。用于场记表格维护代理（#scribeAgentForTables）。
	 * reasoning 用 medium（与 backfillSideText 同款：填表需按表规则推理，关思考质量差）。
	 * 叶守卫由调用方在执行器里检查（每次写后）。
	 */
	async #sideAgent(opts: {
		model: StageModelLike;
		auth: { apiKey?: string; headers?: Record<string, string> };
		systemPrompt: string;
		messages: unknown[];
		tools: StageToolLike[];
		execTool: (name: string, args: Record<string, unknown>) => Promise<ExecResult>;
		maxRounds?: number;
		maxTokens?: number;
		purpose?: string;
		traceOn: boolean;
	}): Promise<{ text: string; rounds: number; toolUsed: number; reads: number; writes: number } | { error: string }> {
		const t0 = Date.now();
		const maxRounds = opts.maxRounds ?? 12;
		const maxTokens = opts.maxTokens ?? 8192;
		const convo = [...opts.messages];
		let text = "";
		let toolUsed = 0;
		let reads = 0;
		let writes = 0;
		for (let round = 0; round < maxRounds; round++) {
			const options: Record<string, unknown> = {
				apiKey: opts.auth.apiKey,
				headers: opts.auth.headers,
				maxTokens,
				signal: this.#abort?.signal,
				reasoning: "medium",
			};
			let final: AssistantMsgLike | null = null;
			let errored: string | undefined;
			try {
				const s = this.#deps.streamFn(
					opts.model,
					{ systemPrompt: opts.systemPrompt, messages: convo, tools: opts.tools },
					options,
				);
				for await (const e of s) {
					if (e.type === "done") final = e.message ?? null;
					else if (e.type === "error") {
						final = e.error ?? null;
						errored = final?.errorMessage || `stopReason=${final?.stopReason ?? "?"}`;
					}
				}
			} catch (err) {
				errored = err instanceof Error ? err.message : String(err);
			}
			if (errored) {
				this.#sideTrace(opts.purpose ?? "side-agent", opts.model, opts.systemPrompt, "", false, errored, t0, opts.traceOn);
				// 调试增强：旁路代理返回 provider 错误——统一接口打 ERROR
				debug.error("side-agent", `旁路代理(${opts.purpose ?? "side-agent"}) LLM 返回错误：${errored}`, {
					model: modelIdOf(opts.model),
					round,
					elapsedMs: Date.now() - t0,
				});
				return { error: errored };
			}
			if (!final) {
				this.#sideTrace(opts.purpose ?? "side-agent", opts.model, opts.systemPrompt, "", false, "流未产出最终消息", t0, opts.traceOn);
				// 调试增强：旁路代理流未产出最终消息——统一接口打 ERROR
				debug.error("side-agent", `旁路代理(${opts.purpose ?? "side-agent"})流未产出最终消息`, {
					model: modelIdOf(opts.model),
					round,
					elapsedMs: Date.now() - t0,
				});
				return { error: "流未产出最终消息" };
			}
			text += textOfAssistant(final);
			const calls = (final.content ?? []).filter(
				(c): c is { type: string; name?: string; arguments?: Record<string, unknown> } =>
					c.type === "toolCall",
			);
			if (calls.length === 0) {
				this.#sideTrace(opts.purpose ?? "side-agent", opts.model, opts.systemPrompt, "", true, text || undefined, t0, opts.traceOn, { toolUsed, rounds: round + 1, reads, writes });
				return { text, rounds: round + 1, toolUsed, reads, writes };
			}
			convo.push(final);
			for (const call of calls) {
				const name = call.name ?? "";
				const args = (call.arguments ?? {}) as Record<string, unknown>;
				let r: ExecResult;
				try {
					r = await opts.execTool(name, args);
				} catch (err) {
					r = { text: `工具执行异常：${err instanceof Error ? err.message : String(err)}`, isError: true };
				}
				toolUsed++;
				if (name === "sql_write") writes++;
				else reads++; // sql_read 及任何其它只读工具都算 read
				convo.push({
					role: "toolResult",
					toolCallId: call.id ?? String(toolUsed),
					toolName: name,
					content: [{ type: "text", text: r.text }],
					isError: r.isError === true,
					timestamp: Date.now(),
				});
				if (r.isError) {
					// 叶已变（会话切换分支）：本代理停止——调用方处理丢弃
					if (/叶已变化/.test(r.text)) {
						this.#sideTrace(opts.purpose ?? "side-agent", opts.model, opts.systemPrompt, "", false, r.text, t0, opts.traceOn, { toolUsed, rounds: round + 1, reads, writes });
						return { text, rounds: round + 1, toolUsed, reads, writes };
					}
				}
			}
		}
		// 调试增强：旁路代理打满轮数上限（未自然终止）——统一接口打 WARNING
		this.#sideTrace(opts.purpose ?? "side-agent", opts.model, opts.systemPrompt, "", true, `${text}\n（已达 ${maxRounds} 轮上限）`, t0, opts.traceOn, { toolUsed, rounds: maxRounds, reads, writes });
		debug.warning("side-agent", `旁路代理(${opts.purpose ?? "side-agent"})打满 ${maxRounds} 轮上限`, {
			model: modelIdOf(opts.model),
			toolUsed,
			reads,
			writes,
			textLen: text.length,
			elapsedMs: Date.now() - t0,
		});
		return { text: `${text}\n（已达轮数上限）`, rounds: maxRounds, toolUsed, reads, writes };
	}

	/**
	 * 当前会话的 TablesService（DESIGN-tables-sql §4）：按 sessionId 懒建并缓存；
	 * 写操作经 onWrite 落树 rp-table-log（分支回溯权威）。
	 */
	#tablesFor(sessionId: string): TablesService {
		if (this.#tables && this.#tablesSessionId === sessionId) return this.#tables;
		this.#tables?.close();
		const svc = new TablesService(join(this.#deps.cwd, ".liyuan-state", "tables", `${sessionId}.db`));
		// 日志先缓冲：拍末 #flushTableLogs 统一落树（写库期间落树会改变叶 id，
		// 与场记叶守卫冲突——代理写库不改树，日志落树才算分支痕迹）
		svc.onWrite = (entry) => {
			this.#tableLogBuffer.push(entry);
		};
		this.#tables = svc;
		this.#tablesSessionId = sessionId;
		return svc;
	}

	/** 把本拍缓冲的表写日志落树（rp-table-log，分支回溯权威）；拍末调用一次 */
	#flushTableLogs(): void {
		const n = this.#tableLogBuffer.length;
		if (n === 0) return;
		const sm = this.#deps.getSessionManager();
		const written = new Set<string>();
		for (const entry of this.#tableLogBuffer) {
			try {
				const id = sm.appendCustomEntry("rp-table-log", entry);
				if (typeof id === "string") entry.entryId = id;
			} catch {
				// 树不可写：日志丢失仅影响该分支的回溯粒度
			}
			const t = tableOfSql(entry.sql);
			if (t !== "?") written.add(t);
		}
		this.#tableLogBuffer = [];
		console.log(`[liyuan-trace] [tableLog] 写表日志落树 ${n} 条（表：${[...written].join("、") || "无"}）`);
		// 向量同步（DESIGN-tables-vector §4）：本拍写过的表异步重同步（不阻塞主链路）
		if (written.size > 0) void this.#syncTablesVecAsync([...written]);
	}

	/**
	 * 表格向量同步（DESIGN-tables-vector §4）：对给定表做全量行重嵌入。
	 * 异步 + 降级：嵌入异常告警一次，表数据/检索注入照常降级。
	 */
	async #syncTablesVecAsync(tables: string[]): Promise<void> {
		try {
			const sm = this.#deps.getSessionManager();
			const svc = this.#tablesFor(sm.getSessionId());
			const scope = { sessionId: sm.getSessionId(), card: this.#cardPath ?? undefined };
			for (const name of [...new Set(tables)]) {
				if (!name) continue;
				const read = svc.execRead(`SELECT rowid AS __rowid, * FROM "${name}" LIMIT 5000`);
				if (!read.ok) {
					// 表已不存在（drop）→ 清 chunks
					removeTableVec(this.#deps.cwd, scope, name);
					continue;
				}
				const rows = (read.rows ?? []).map((r) => ({
					rowid: Number((r as Record<string, unknown>)["__rowid"] ?? 0),
					text: rowText(name, r as Record<string, unknown>),
				}));
				await syncTableRows(this.#deps.cwd, scope, name, rows);
			}
		} catch (err) {
			if (!this.#warnedTableVec) {
				this.#warnedTableVec = true;
				console.warn(`[tables-vec] 表格向量同步跳过（嵌入异常，检索注入降级）：${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * rewind/重放后全量重同步（DESIGN-tables-vector §6）：异步；世代号防竞态
	 * （重同步期间又切分支 → 旧任务作废，以最后一次为准）。
	 */
	async #resyncTableVecAllAsync(): Promise<void> {
		const gen = ++this.#tableVecGeneration;
		try {
			const sm = this.#deps.getSessionManager();
			const svc = this.#tablesFor(sm.getSessionId());
			const scope = { sessionId: sm.getSessionId(), card: this.#cardPath ?? undefined };
			clearTableVec(this.#deps.cwd, scope);
			const tables = svc.listTables().map((t) => t.name);
			for (const name of tables) {
				if (gen !== this.#tableVecGeneration) return; // 世代已变：作废
				const read = svc.execRead(`SELECT rowid AS __rowid, * FROM "${name}" LIMIT 5000`);
				if (!read.ok) continue;
				const rows = (read.rows ?? []).map((r) => ({
					rowid: Number((r as Record<string, unknown>)["__rowid"] ?? 0),
					text: rowText(name, r as Record<string, unknown>),
				}));
				await syncTableRows(this.#deps.cwd, scope, name, rows);
			}
		} catch (err) {
			if (!this.#warnedTableVec) {
				this.#warnedTableVec = true;
				console.warn(`[tables-vec] 全量重同步跳过：${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * 自定义表索引单行（SQL 化）：从 TablesService 的 __meta 生成
	 * （`[auto] 表名` 列表；结构与数据都在 db，state.tables 已停用）。
	 */
	#sqlTableIndex(sessionId: string): string | undefined {
		try {
			const list = this.#tablesFor(sessionId).listTables();
			if (list.length === 0) return undefined;
			return list.map((t) => `${t.auto ? "[auto] " : ""}${t.name}`).join("、");
		} catch {
			return undefined;
		}
	}

	/**
	 * 叶漂移判定（2026-08-16）：leafBefore 不在当前叶的**祖先链**上才是真漂移（swipe/rewind
	 * 分叉）；同链追加（model_change/日志/快照等新条目改叶 id）不算——曾误判：用户在场记
	 * 代理运行中切换模型 → 两条 model_change 落树 → 严格相等判定「叶已变化」→ 整拍记账丢弃。
	 */
	#leafDriftedFrom(leafBefore: string | null): boolean {
		const sm = this.#deps.getSessionManager();
		const leaf = sm.getLeafId();
		if (leaf === leafBefore) return false;
		if (leafBefore === null) return true;
		try {
			const entries = sm.getEntries() as Array<{ id?: string; parentId?: string | null }>;
			const byId = new Map<string, { parentId?: string | null }>();
			for (const e of entries) {
				if (e.id) byId.set(e.id, e);
			}
			let cur: string | null = leaf;
			let guard = 0;
			while (cur && guard++ < 600) {
				if (cur === leafBefore) return false;
				const e = byId.get(cur);
				if (!e) return true;
				cur = e.parentId ?? null;
			}
			console.log(`[liyuan-trace] [leafDrift] 叶漂移→记账丢弃 leafBefore=${(leafBefore ?? "").slice(0, 8)} leaf=${(leaf ?? "").slice(0, 8)}`);
			return true;
		} catch {
			// catch 分支的「leaf !== leafBefore」true 也是一次漂移；这里不额外打，外层调用方有产出时已看得到
			return leaf !== leafBefore;
		}
	}

	/**
	 * 旁路重记账（story_edit 润色后自动刷场记，SQL 化旁路版，2026-08-16）：
	 * 走 runScribeTurn 全链路（顶层兜底 + 表格维护代理写 SQLite），结果落树
	 * （rp-state lean + rp-table-log）并写磁盘 state 缓存；叶守卫 = 祖先链判定。
	 * 插画类占位符改动不应走这里（调用方 skipScribe）。
	 */
	async rescribeTurn(userText: string, assistantText: string): Promise<{ ok: boolean; applied?: string[]; error?: string }> {
		try {
			const sm = this.#deps.getSessionManager();
			const materials = loadStageMaterials(this.#deps.cwd);
			const config = materials.config;
			const branch = sm.getBranch() as BranchEntryLike[];
			const state = this.#effectiveState(branch);
			const sideModel = this.#deps.getSideModel?.() ?? this.#deps.getModel();
			if (!sideModel) return { ok: false, error: "尚无可用旁挂/剧情模型" };
			const auth = await this.#deps.getAuth(sideModel);
			const traceOn = this.#deps.getTraceOn?.() === true;
			const r = await runScribeTurn(
				{
					sideText: (sp, ut) => this.#sideText(sideModel, sp, ut, auth, "scribe", traceOn),
					agentTableMaintain: (o) => this.#scribeAgentForTables({ ...o, traceOn }),
					isLeafDrifted: (before) => this.#leafDriftedFrom(before),
					autoTablesFrom: () => this.#autoTablesFrom(sm.getSessionId()),
					getLeafId: () => sm.getLeafId(),
					onActivity: () => undefined,
				},
				{
					state,
					baseState: state,
					scope: "full", // 旁路无主演 patch：顶层 + 表格全域兜底
					userText,
					assistantText,
					charName: materials.card.name,
					userName: config.userName,
				},
			);
			if (r.kind === "stale") return { ok: false, error: "叶已变化，重记账丢弃" };
			if (r.kind === "failed") return { ok: false, error: r.error };
			if (r.kind === "applied") {
				console.log(`[liyuan-trace] [bookkeep] 旁路重记账(编辑后) applied=${r.applied.join("、") || "无"}`);
				if (r.state) {
					const leanState = { ...r.state, tables: undefined };
					const eid = sm.appendCustomEntry(STATE_ENTRY_TYPE, leanState);
					console.log(
						`[liyuan-trace] [bookkeep] 旁路落账 rp-state ${eid.slice(0, 8)} time=${String((leanState as { time?: unknown }).time ?? "?").slice(0, 24)} loc=${String((leanState as { location?: unknown }).location ?? "?").slice(0, 24)}`,
					);
					const stateFile = this.#deps.getStateFile?.(sm.getSessionId());
					if (stateFile) {
						try {
							saveState(stateFile, leanState);
						} catch {
							// 缓存写失败不影响树上快照
						}
					}
				}
				this.#flushTableLogs();
				sm.flush();
				return { ok: true, applied: r.applied };
			}
			return { ok: true, applied: [] };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * SQL 化 auto 表清单（场记 todo 来源）：表名 + 列名 + 首列实体（≥2 字字符串）。
	 * 旧 state.tables 快照不含 SQLite 新建的表——todo 判定必须实时。
	 */
	#autoTablesFrom(sessionId: string): Array<{ name: string; columns: string[]; keyValues: string[] }> {
		try {
			const svc = this.#tablesFor(sessionId);
			const out: Array<{ name: string; columns: string[]; keyValues: string[] }> = [];
			for (const t of svc.listTables()) {
				if (!t.auto) continue;
				const meta = svc.getMeta(t.name);
				const cols = meta?.columns.map((c) => c.name) ?? [];
				const keyVals: string[] = [];
				if (cols.length > 0) {
					const read = svc.execRead(`SELECT "${cols[0]}" FROM "${t.name}" LIMIT 200`);
					if (read.ok) {
						for (const r of read.rows ?? []) {
							const v = (r as Record<string, unknown>)[cols[0]];
							if (typeof v === "string" && v.length >= 2) keyVals.push(v);
						}
					}
				}
				out.push({ name: t.name, columns: cols, keyValues: keyVals });
			}
			return out;
		} catch {
			return [];
		}
	}

	/**
	 * 场记表格维护代理（DESIGN-tables-sql §5）：一次工具循环维护全部 todo 表。
	 * 模型按各表【维护规则】用 sql_read/sql_write 自主查写，写库即持久（TablesService
	 * 落日志）；返回 applied 摘要。叶守卫在每次写后检查。
	 */
	async #scribeAgentForTables(opts: {
		todo: string[];
		dialogue: string;
		leafBefore: string | null;
		traceOn: boolean;
	}): Promise<{ applied: string[]; error?: string }> {
		const { todo, dialogue, leafBefore, traceOn } = opts;
		const sessionId = this.#deps.getSessionManager().getSessionId();
		const svc = this.#tablesFor(sessionId);
		const applied: string[] = [];
		const exec = makeSqlExec(
			{
				execRead: async (sql) => {
					const r = svc.execRead(sql);
					return r.ok ? { ok: true, rows: r.rows ?? [] } : { ok: false, error: r.error };
				},
				execWrite: async (sql) => {
					const r = svc.execWrite(sql);
					return r.ok ? { ok: true, changes: r.changes, lastInsertRowid: r.lastInsertRowid } : { ok: false, error: r.error };
				},
			},
			(sql, changes) => applied.push(`表 ${tableOfSql(sql)} 写入 ${changes} 行`),
		);
		const execTool = async (name: string, args: Record<string, unknown>): Promise<ExecResult> => {
			const r = await exec(name, args);
			// 每次写后叶守卫（祖先链判定：同链追加不算漂移；真分叉 swipe/rewind 才丢弃）
			if (this.#leafDriftedFrom(leafBefore)) {
				return { text: "叶已变化（会话切换分支），本代理停止。", isError: true };
			}
			return r;
		};
		const sideModel = this.#deps.getSideModel?.() ?? this.#deps.getModel();
		if (!sideModel) return { applied, error: "尚无可用旁挂/剧情模型" };
		const auth = await this.#deps.getAuth(sideModel);
		const sys = buildScribeAgentSystemPrompt(todo, (name) => svc.getMeta(name));
		const res = await this.#sideAgent({
			model: sideModel,
			auth,
			systemPrompt: sys,
			messages: [{ role: "user", content: [{ type: "text", text: buildScribeAgentUserText(dialogue) }], timestamp: Date.now() }],
			tools: scribeAgentToolSchemas(),
			execTool,
			maxRounds: 16,
			maxTokens: 8192,
			purpose: "scribe-agent",
			traceOn,
		});
		if (typeof res === "object" && "error" in res) return { applied, error: res.error };
		if (applied.length > 0) console.log(`[liyuan-trace] [scribeTable] 场记表格维护 applied=${applied.join("、") || "无"}（LLM ${res.rounds} 轮 / SQL ${res.toolUsed} 次：读 ${res.reads} 写 ${res.writes}）`);
		else console.log(`[liyuan-trace] [scribeTable] 场记表格维护：本轮无写表（LLM ${res.rounds} 轮 / SQL ${res.toolUsed} 次：读 ${res.reads} 写 ${res.writes}）`);
		return { applied };
	}

	/** 旁路调用落 trace（side 事件：用途/提示词/结果/耗时）；开关关闭或未注入时零开销 */
	#sideTrace(
		purpose: string,
		model: StageModelLike,
		systemPrompt: string,
		userText: string,
		ok: boolean,
		text: string | undefined,
		t0: number,
		traceOn: boolean,
		meta?: { toolUsed?: number; rounds?: number; reads?: number; writes?: number },
	): void {
		if (!traceOn) return;
		this.#deps.trace?.record(this.#deps.getSessionManager().getSessionId(), {
			kind: "side",
			purpose,
			systemPrompt,
			userText,
			model: modelIdOf(model),
			ok,
			...(text ? { text } : {}),
			...(meta && typeof meta.toolUsed === "number" ? { toolUsed: meta.toolUsed } : {}),
			...(meta && typeof meta.rounds === "number" ? { rounds: meta.rounds } : {}),
			...(meta && typeof meta.reads === "number" ? { reads: meta.reads } : {}),
			...(meta && typeof meta.writes === "number" ? { writes: meta.writes } : {}),
			elapsedMs: Date.now() - t0,
		});
	}
}
