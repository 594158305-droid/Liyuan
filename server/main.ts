/**
 * 梨园 Web 宿主（PLAN-PHASE3 §2）：进程内嵌 pi SDK，向浏览器暴露 wire 协议。
 *
 * D3 扩展条款：本文件是接线层之外唯一允许接触 pi API 的地方，且只许碰
 * 会话托管面（runtime 创建 / 事件订阅 / prompt / abort / bindExtensions / 树导航桥接）；
 * 领域逻辑在 .liyuan/extensions/roleplay.ts；本文件只碰会话托管面。
 * 前端只见 wire 协议（server/wire.ts）。
 *
 * 用法：node server/main.ts [--new]        （cwd 必须是 Liyuan/ 产品根）
 *   HOST=0.0.0.0 PORT=7620 可经环境变量覆盖。默认绑 0.0.0.0：手机可连，勿暴露公网。
 *   --new 开新会话；默认续接最近会话。同一会话勿同时开 TUI（无文件锁）。
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
} from "@liyuan/agent-runtime";

import {
	ACCESS_COOKIE,
	clearPassword,
	issueToken,
	loadAccess,
	parseCookies,
	revokeToken,
	setPassword,
	verifyPassword,
	verifyToken,
	type AccessData,
} from "../src/access.ts";
import { listProfiles, loadAgentConfig, loadProfile, normalizeAgentConfig, syncAgentConfigToRuntime } from "../src/agent-config.ts";
import { streamSimple } from "@liyuan/ai/compat";
import { loadCardFile } from "../src/card.ts";
import { buildGreeting } from "../src/greeting.ts";
import { StageEngine, type AssistantMsgLike, type StageStreamFn } from "../src/stage/engine.ts";
import { isSoundFxName } from "../src/stage/tools.ts";
import { TraceRecorder } from "../src/stage/trace.ts";
import { configureDebug, debug } from "../src/debug.ts";
import { stateFromBranch, type BranchEntryLike } from "../src/stage/assemble.ts";
import { buildStoryFloors } from "../src/stagehand.ts";
import { CONVERGE_TAIL } from "../src/router-core.ts";
import { mapPiEventsToSt } from "./script-events.ts";
import {
	activePanels,
	closePanel as closePanelInMap,
	loadPanels,
	savePanels,
	writePanel,
} from "../src/panels.ts";
import {
	DIRS,
	dir,
	migrateLegacyLayout,
	preferLiyuanAgentHome,
	resolveConfigPath,
	takeAgentMergeLog,
} from "../src/paths.ts";
import { applyPatch, loadState, saveState, stateHasTableData } from "../src/state.ts";
import { buildTableDescription, loadTemplate, type TableTemplateDef } from "../src/templates.ts";
import { runTableBackfill } from "../src/table-backfill.ts";
import { parseStChat, cleanChat, DEFAULT_STRIP_TAGS } from "../src/chatlog.ts";
import { replayFloors, type ReplayFloor } from "../src/import-raw.ts";
import { DEFAULT_CONFIG, type AgentConfig, type RpConfig, type WorldState } from "../src/types.ts";
import {
	loadTtsConfig,
	saveAudioBuffer,
	synthesizeSpeech,
	ttsConfigHint,
} from "../src/tts.ts";
import {
	buildAncestryIndex,
	buildWorldlineView,
	extractSaves,
	hasUnsavedStoryAfterSave,
	loadWorldlineMeta,
	metaPath,
	renameWorldline as renameWorldlineMeta,
	saveWorldlineMeta,
	softDeleteSave,
	type TreeEntryLite,
} from "../src/worldline.ts";
import {
	lastStoryUserEntryId,
	listReplyVariants,
	swipeMetaForUser,
	type SwipeEntry,
} from "../src/swipe.ts";
import {
	memoryArchiveCompacted,
	memoryDeleteChunk,
	memoryListChunks,
	memoryManualAdd,
	memorySearch,
	onNarrativeTurnEnd,
} from "../src/memory/index.ts";
import { handleApiRequest, loadCardFrontSnapshot, loadConfig, loadMergedLore, type CurrentModelInfo, type RestHost } from "./rest.ts";
import { searchEntries } from "../src/lorebook.ts";

// 用户级 agent 目录 → ~/.liyuan/agent（须在 getAgentDir / 建会话之前）
// 并合并 fork 改名后遗留的 ~/.pi/agent（会话/配置，不覆盖更新的新树）
const agentHome = preferLiyuanAgentHome();
import {
	assistantMediaOfToolResult,
	isBackstageText,
	parseCardFromSessionHead,
	summarizeToolResult,
	toAssistantHistory,
	toWireHistory,
	toWireMsg,
	type ClientFrame,
	type ServerFrame,
	type WireNames,
	type WireStats,
} from "./wire.ts";
import { createAgentHost, stagehandPluginToolNames, STAGEHAND_TOOL_NAMES, type AssistantHost, type StoryBridge } from "./assistant.ts";
import { turnEndHooks } from "../src/draw-plugins/registry.ts";
import { registerLoreSearcher, registerPlannerCaller } from "../src/draw-plugins/draw-pipeline/index.ts";
import { buildInsertPatch, resolveEmbedTarget, resolveIllustrateTarget, illustrateTargetObstruction } from "../src/draw-plugins/draw-pipeline/anchor.ts";
import { createSlot } from "../src/draw-plugins/draw-slot/slot-store.ts";
import { resolveCharacterTags } from "../src/draw-plugins/draw-role/resolver.ts";
import { createStoryBridge, FULL_BRIDGE_PERMISSIONS } from "./bridge.ts";
import { registerAgentRunner, unregisterAgentRunner, type AssistantRunner } from "../src/assistant-gateway.ts";
import { sameCardPath } from "../src/paths.ts";
import { toggleDisabledLore } from "../src/lorebook.ts";
import { syncStoryPanelsFromDisk, syncStoryStateFromDisk } from "../src/story-sync.ts";
import { toolStartDetail } from "../src/activity-format.ts";
import {
	checkLatestRelease,
	downloadAndStage,
	discardPendingUpdate,
	readPendingUpdate,
	type UpdateCheckResult,
} from "../src/update.ts";
import type { UpdateWire } from "./wire.ts";
import {
	defaultSessionEnabledIds,
	getMcpHub,
	RP_MCP_TYPE,
} from "../src/mcp.ts";
import { mcpEnabledFromBranch } from "../src/stage/mcp-stage.ts";

const cwd = process.cwd();
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 7620);
const newSessionFlag = process.argv.includes("--new");

// 数据目录/配置文件：.rp-* → .liyuan-*，rp.config.json → liyuan.config.json
for (const line of migrateLegacyLayout(cwd)) {
	console.log(`[liyuan] 迁移 ${line}`);
}

// 自操作接口（LIYUAN_HTTP → 剧情 system prompt）已退役（2026-07-14）：
// 系统自操作整体移交右栏「助手」的工具面（server/assistant.ts），剧情模型不再 curl 自家 API。

// Windows 环境修补（F3 实测缺陷，2026-07-10）：pi 以非登录模式启动 bash，PATH 里没有
// Git 的 usr/bin，agent 的 bash 工具找不到 cat/sed/grep 等 coreutils（python3 还会撞上
// 微软商店 stub）。从 .liyuan/settings.json 的 shellPath 推导 usr/bin 前置进 PATH，子进程继承。
try {
	const settings = JSON.parse(readFileSync(join(cwd, ".liyuan", "settings.json"), "utf8")) as { shellPath?: string };
	if (settings.shellPath) {
		const usrBin = dirname(settings.shellPath);
		if (existsSync(usrBin) && !(process.env.PATH ?? "").split(";").includes(usrBin)) {
			process.env.PATH = `${usrBin};${process.env.PATH ?? ""}`;
		}
	}
} catch {
	// 无 settings.json 或不可读：跳过（非 Windows/标准安装不需要修补）
}

// ---------- 显示名（角色/用户）：直接读配置与卡（领域层，合法） ----------

const names: WireNames = { charName: "角色", userName: "用户" };
/** 当前卡标识（liyuan.config.json 的 card 路径原文，会话过滤用） */
let cardPath = "";

/** 从项目配置刷新显示名与当前卡（启动时与每次配置写入/会话重载后调用） */
const refreshNamesFromConfig = () => {
	names.charName = "角色";
	names.userName = "用户";
	cardPath = "";
	try {
		const config = JSON.parse(readFileSync(resolveConfigPath(cwd), "utf8")) as {
			card?: string;
			userName?: string;
			displayName?: string;
		};
		if (config.userName) names.userName = config.userName;
		if (config.card) {
			cardPath = config.card;
			const abs = isAbsolute(config.card) ? config.card : join(cwd, config.card);
			names.charName = loadCardFile(abs).name;
		}
		// 显示名覆盖（仅显示层；{{char}} 宏与提示词仍用卡名）
		if (config.displayName) names.charName = config.displayName;
	} catch (err) {
		console.error(`[liyuan] 读取角色显示名失败（用占位名继续）：${err instanceof Error ? err.message : String(err)}`);
	}
};
refreshNamesFromConfig();

// ---------- pi 会话宿主 ----------

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd });
	return {
		...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
		services,
		diagnostics: services.diagnostics,
	};
};

const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd,
	agentDir: getAgentDir(),
	sessionManager: newSessionFlag ? SessionManager.create(cwd) : SessionManager.continueRecent(cwd),
});

let session: AgentSession = runtime.session;
let unsubscribe: (() => void) | undefined;

// ---------- WS 广播 ----------

const clients = new Set<WebSocket>();
const broadcast = (frame: ServerFrame) => {
	const data = JSON.stringify(frame);
	// 诊断日志（正文嵌入链路）：hello 帧广播目标数——确认前端是否收到
	if (frame.type === "hello") {
		const n = [...clients].filter((c) => c.readyState === c.OPEN).length;
		console.log("[ws] broadcast hello 发送给 " + n + " 个客户端（messages=" + (frame.messages?.length ?? 0) + "）");
	}
	for (const ws of clients) {
		if (ws.readyState === ws.OPEN) ws.send(data);
	}
};

// ---------- 在线更新（主页 chip → 弹窗 → toast 进度；替换由启动脚本完成） ----------

const APP_VERSION: string = (() => {
	try {
		return (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

let updateState: UpdateWire = { phase: "none", currentVersion: APP_VERSION };
let updateCheck: UpdateCheckResult | null = null;
let updateBusy = false;

const UPDATE_SUPERVISED = process.env.LIYUAN_SUPERVISED === "1";
const pushUpdate = () => broadcast({ type: "update", update: { ...updateState, supervised: UPDATE_SUPERVISED } });

/** 启动后静默检查一次；失败不提示（manual 时才把 error 带给 UI） */
const runUpdateCheck = async (manual: boolean): Promise<void> => {
	// 已有暂存包：直接就绪态（跨重启持久；旧暂存版本低于当前版则丢弃）
	const pending = readPendingUpdate(cwd);
	if (pending) {
		if (pending.version === APP_VERSION || pending.version < APP_VERSION) {
			discardPendingUpdate(cwd);
		} else {
			updateState = {
				phase: "ready",
				currentVersion: APP_VERSION,
				latestVersion: pending.version,
				verified: pending.verified,
			};
			pushUpdate();
			return;
		}
	}
	const r = await checkLatestRelease(APP_VERSION);
	updateCheck = r;
	if (r.error) {
		if (manual) {
			updateState = { ...updateState, phase: updateState.phase === "ready" ? "ready" : "none", error: r.error };
			pushUpdate();
		}
		return; // 静默降级：启动检查失败不打扰
	}
	if (r.hasUpdate && r.asset) {
		updateState = {
			phase: "available",
			currentVersion: APP_VERSION,
			latestVersion: r.latestVersion ?? undefined,
			releaseName: r.releaseName,
			releaseNotes: r.releaseNotes,
			releaseUrl: r.releaseUrl,
			publishedAt: r.publishedAt,
			assetSize: r.asset.size,
		};
	} else {
		updateState = { phase: "none", currentVersion: APP_VERSION, latestVersion: r.latestVersion ?? undefined };
	}
	pushUpdate();
};

/** 下载并暂存（进度限流 500ms 一帧）；完成后 ready，失败回 available 带 error */
const startUpdateDownload = async (mirror?: string): Promise<void> => {
	if (updateBusy) throw new Error("已在下载中");
	if (!updateCheck?.hasUpdate || !updateCheck.asset) throw new Error("没有可下载的更新");
	updateBusy = true;
	const base = updateState;
	updateState = { ...base, phase: "downloading", received: 0, total: updateCheck.asset.size, error: undefined };
	pushUpdate();
	let lastPush = 0;
	try {
		const pending = await downloadAndStage({
			cwd,
			check: updateCheck,
			mirror,
			onProgress: (p) => {
				const now = Date.now();
				if (now - lastPush < 500) return;
				lastPush = now;
				updateState = { ...updateState, received: p.received, total: p.total || updateCheck?.asset?.size || 0 };
				pushUpdate();
			},
		});
		updateState = {
			phase: "ready",
			currentVersion: APP_VERSION,
			latestVersion: pending.version,
			releaseUrl: base.releaseUrl,
			verified: pending.verified,
		};
		pushUpdate();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		updateState = { ...base, phase: "available", error: msg };
		pushUpdate();
		throw new Error(`下载更新失败：${msg}`);
	} finally {
		updateBusy = false;
	}
};

// 启动 3s 后后台静默检查（不卡启动、不打扰；失败无声）
setTimeout(() => void runUpdateCheck(false).catch(() => {}), 3000);

// ---------- 会话统计与世界状态（右栏信息面板的数据源） ----------

// 会话统计（2026-08-16 重构）：直接走会话树计算，不再依赖 pi runtime 的 getSessionStats——
// ① StageEngine 直连 streamFn 驱动主剧情，pi runtime 的 state.messages 是空壳，数字恒为 0；
// ② 迁移导入的 assistant 消息缺 usage 会让 getSessionStats 抛 TypeError（曾致 stats 整条 null、
//    前端统计栏/上下文进度条消失）。树侧计算对两者都免疫：
//    - 消息数 = 当前分支实际条目（user/assistant）；
//    - tokens/cost = 树内 assistant.usage 容错求和；
//    - contextTokens = 最近一条 assistant 的 usage.input（API 实测的上一轮 prompt 侧占用，
//      比 pi 的估算准），percent = input / contextWindow。
const safeStats = (): WireStats | null => {
	try {
		const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
		let userMessages = 0;
		let assistantMessages = 0;
		let totalTokens = 0;
		let cost = 0;
		let lastPromptTokens: number | null = null;
		for (const e of branch) {
			if (e.type !== "message") continue;
			const m = e.message as
				| { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } }
				| undefined;
			if (!m || typeof m !== "object") continue;
			if (m.role === "user") userMessages++;
			else if (m.role === "assistant") {
				assistantMessages++;
				const u = m.usage ?? {};
				totalTokens += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				cost += u.cost?.total ?? 0;
				// openai-completions 语义：input 只含未命中部分，缓存命中的 prompt 在 cacheRead——
				// 上下文占用 = input + cacheRead（取最近一条，= 上一轮实际装进窗口的 prompt 量）
				if (typeof u.input === "number" || typeof u.cacheRead === "number") {
					lastPromptTokens = (u.input ?? 0) + (u.cacheRead ?? 0);
				}
			}
		}
		const contextWindow = session.model?.contextWindow ?? null;
		const contextPercent =
			lastPromptTokens !== null && contextWindow && contextWindow > 0 ? (lastPromptTokens / contextWindow) * 100 : null;
		return {
			userMessages,
			assistantMessages,
			totalTokens,
			cost,
			contextPercent,
			contextTokens: lastPromptTokens,
			contextWindow,
		};
	} catch {
		return null;
	}
};

const stateDir = dir(cwd, "state");
mkdirSync(stateDir, { recursive: true });

// 统一调试接口（src/debug.ts）：日志文件固定落 .liyuan-state/debug.log；控制台/file 通道
// 随 config.debugLog 现读（host 侧每回合/每请求同步，主聊天主演走 engine 注入面，两处都 sync）。
configureDebug({ filePath: join(stateDir, "debug.log") });
/** 把 config.debugLog 同步进统一调试接口（开发者模式可关打印；每回合/每请求现读） */
const syncDebugConfig = (config: RpConfig): void => {
	configureDebug({
		console: config.debugLog?.console !== false,
		file: config.debugLog?.file !== false,
	});
};
/**
 * 展示用账本。权威是会话树（R4：世界 = f(分支)）——swipe/rewind/切世界线后
 * 磁盘缓存仍是旧分支的账本，只有树快照能给出当前分支的正确值。
 * 树上无快照（未记账的新会话）时回落磁盘缓存：旧会话与导入建账都只有文件。
 */
const currentState = (): WorldState => {
	try {
		const branch = session.sessionManager.getBranch() as BranchEntryLike[];
		if (branch.some((e) => e.type === "custom" && e.customType === "rp-state")) {
			const s = stateFromBranch(branch);
			// 链上快照只有空表结构（物化骨架/空账本）不算有效——回落磁盘，与装配 #effectiveState 同判据（2026-08-11）
			if (stateHasTableData(s)) return s;
		}
	} catch {
		// 树不可读（极早期生命周期）→ 磁盘缓存
	}
	return loadState(join(stateDir, `${session.sessionId}.json`));
};

// 场记记账落盘即推送（PLAN-PHASE3 §4：fs.watch 目录级监听，零扩展改动；
// Windows 下同一次写可能触发多次事件，200ms 去抖）
let stateDebounce: ReturnType<typeof setTimeout> | undefined;
watch(stateDir, (_evt, filename) => {
	if (filename !== `${session.sessionId}.json`) return;
	clearTimeout(stateDebounce);
	stateDebounce = setTimeout(() => {
		try {
			broadcast({ type: "state", state: currentState() });
		} catch {
			// 读取竞态（写入未完成）：下次事件再推
		}
	}, 200);
});

// agent 自建面板（柱 2）：与 state 同款——扩展落盘 .rp-artifacts/<sessionId>.json，
// 这里 fs.watch 监听并推送活跃面板全量（panel_write/close 与 rewind 回退同一条路径）
const artifactsDir = dir(cwd, "artifacts");
mkdirSync(artifactsDir, { recursive: true });
const currentPanels = () => activePanels(loadPanels(join(artifactsDir, `${session.sessionId}.json`)));

let panelsDebounce: ReturnType<typeof setTimeout> | undefined;
watch(artifactsDir, (_evt, filename) => {
	if (filename !== `${session.sessionId}.json`) return;
	clearTimeout(panelsDebounce);
	panelsDebounce = setTimeout(() => {
		try {
			broadcast({ type: "panels", panels: currentPanels() });
		} catch {
			// 读取竞态（写入未完成）：下次事件再推
		}
	}, 200);
});

/** 会话树条目 → swipe 纯函数输入 */
const swipeEntriesFromSession = (): SwipeEntry[] => {
	const raw = session.sessionManager.getEntries() as Array<Record<string, unknown>>;
	return raw.map((e) => {
		const id = String(e.id);
		const parentId = (e.parentId as string | null) ?? null;
		const type = String(e.type);
		const timestamp = typeof e.timestamp === "string" ? e.timestamp : undefined;
		if (type === "message" && e.message && typeof e.message === "object") {
			const m = e.message as { role?: unknown; customType?: unknown };
			return {
				id,
				parentId,
				type: "message",
				role: typeof m.role === "string" ? m.role : undefined,
				customType: typeof m.customType === "string" ? m.customType : undefined,
				timestamp,
			};
		}
		return {
			id,
			parentId,
			type,
			customType: typeof e.customType === "string" ? e.customType : undefined,
			timestamp,
		};
	});
};

const extractEntryText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: unknown }).type === "text"
				? String((p as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
};

/**
 * 取消息条目的「当前显示全文」：该 message 之后最近的 rp-edited-reply（custom_message 覆盖，
 * 含占位符/改稿内容）优先，无覆盖回退 message 原始 content。
 * 背景：占位符经 storyEdit 通道（rp-edited-reply 分支注入）写入，message 原始 content 不含；
 * 二次嵌入若基于原文构造新文本会把旧 rp-edited-reply 裁剪掉 → 旧占位符丢失（旧图消失）。
 * 分支裁剪后目标之后至多保留一条覆盖；遇到下一 message 条目即停止（覆盖不再属于目标）。
 */
function currentDisplayTextOf(
	branch: Array<{ id?: string; type?: string; customType?: string; message?: { content?: unknown }; content?: unknown }>,
	entryId: string,
): string {
	let raw = "";
	let seen = false;
	for (const e of branch) {
		if (e.id === entryId) {
			seen = true;
			raw = extractEntryText(e.type === "message" ? e.message?.content : e.content);
			continue;
		}
		if (!seen) continue;
		if (e.type === "message") break; // 已到下一消息：覆盖不再属于目标
		if (e.type === "custom_message" && e.customType === "rp-edited-reply") {
			const t = extractEntryText(e.content);
			if (t) return t; // 分支顺序即时间顺序，取最近一条覆盖
		}
	}
	return raw;
}

/**
 * reroll/编辑输入的「回退叶」：branch 前记录旧叶；生成失败或停止无产出时
 * 回退到它（8/05：reroll 链上停止，当前分支只剩 user、旧回复全部消失）。
 * onTurnEnd 消费后清空。
 */
let rerollFallbackLeaf: string | null = null;

/** 当前分支上最后一条剧情用户消息 entry id（戏外轮不计） */
const lastStoryUserId = (): string | null => {
	const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
	const lite = branch.map((e) => {
		const type = String(e.type);
		if (type === "message" && e.message && typeof e.message === "object") {
			const m = e.message as { role?: unknown; content?: unknown };
			return {
				id: String(e.id),
				type: "message",
				role: typeof m.role === "string" ? m.role : undefined,
				text: extractEntryText(m.content),
			};
		}
		return { id: String(e.id), type };
	});
	return lastStoryUserEntryId(lite, isBackstageText);
};

/**
 * 给历史 wire 消息挂上 ST swipe 元数据：仅「当前分支最后一轮剧情角色回复」一条。
 * total=0 时不挂（尚无回复，箭头由前端在空状态决定是否展示——目前只在有 narrative 时显示）。
 */
const annotateSwipes = (messages: import("./wire.ts").WireMsg[]): import("./wire.ts").WireMsg[] => {
	const userId = lastStoryUserId();
	if (!userId) return messages;
	const leafId = session.sessionManager.getLeafId();
	const meta = swipeMetaForUser(swipeEntriesFromSession(), userId, leafId);
	// total=0 也挂上（仅 user 尚无回复时 UI 可点右生成；有 narrative 时至少 1）
	// 找最后一条 narrative（非 backstage 流里的角色回复）
	let lastNar = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].channel === "narrative") {
			lastNar = i;
			break;
		}
	}
	if (lastNar < 0) return messages;
	const total = Math.max(1, meta?.total ?? 1);
	const index = meta && meta.total > 0 ? meta.index : 0;
	return messages.map((m, i) => (i === lastNar ? { ...m, swipe: { index, total } } : m));
};

/** 当前卡显示向皮肤（wire 上屏：先正则再 unwrap） */
const currentDisplaySkin = () => {
	try {
		const snap = loadCardFrontSnapshot(cwd);
		if (!snap.enabled || !snap.hasSkin || !snap.rules.length) return null;
		return {
			rules: snap.rules,
			charName: snap.charName || names.charName,
			userName: snap.userName || names.userName,
		};
	} catch {
		return null;
	}
};

/**
 * 会话树当前分支 → 显示层消息列表。
 * 台上引擎直接写树（R1 循环自持），AgentSession 的内存副本不再是权威——
 * 显示层一律以 SessionManager 分支为准（含 rp-greeting/rp-draft-op 等 custom_message）。
 */
const branchMessages = (): unknown[] => {
	try {
		const out: unknown[] = [];
		for (const e of session.sessionManager.getBranch() as Array<Record<string, unknown>>) {
			if (e.type === "message" && e.message) out.push({ ...(e.message as object), id: e.id as string });
			else if (e.type === "custom_message") {
				// details 必须透传：开场白序号（rpGreeting）等元数据只存在于树条目上，
				// 丢了就让 resyncAll 后的角标退回 /api/card 轮询（切换开场白时角标卡住不动）
				out.push({
					role: "custom",
					customType: e.customType,
					content: e.content,
					display: e.display,
					details: e.details,
					// 条目 id：配图按钮回传「点的是哪层」用（2026-08-14 事故修复）
					id: e.id as string,
				});
			}
		}
		return out;
	} catch {
		return session.messages;
	}
};

const helloFrame = (): ServerFrame => {
	const cardfront = loadCardFrontSnapshot(cwd);
	const skin =
		cardfront.enabled && cardfront.hasSkin && cardfront.rules.length
			? {
					rules: cardfront.rules,
					charName: cardfront.charName || names.charName,
					userName: cardfront.userName || names.userName,
				}
			: null;
	return {
		type: "hello",
		sessionId: session.sessionId,
		charName: names.charName,
		userName: names.userName,
		messages: annotateSwipes(toWireHistory(branchMessages(), names, { skin })),
		state: currentState(),
		stats: safeStats(),
		panels: currentPanels(),
		// 一档皮肤与消息同帧:首屏不得依赖二次 REST(缓存/竞态会让 StatusBlock 回落统一面板)
		cardfront,
	};
};

/** 全量重放（斜杠命令 / 树导航 / 压缩后：让所有端与会话文件对齐） */
const resyncAll = () => {
	// SQL 化（DESIGN-tables-sql §7）：树导航/全量重放后，把表格物化重建为焦点分支（带跳过保护）
	try {
		stage.replayTables();
	} catch {
		// 表格服务异常不阻断全量重放
	}
	const frame = helloFrame();
	// 诊断日志（正文嵌入链路）：hello 帧含占位符文本时打印——确认前端重放时服务端发出的内容
	try {
		const ph = (frame.messages ?? []).filter(
			(m) => m && typeof (m as { text?: unknown }).text === "string" && /\[image:/.test((m as { text: string }).text),
		).length;
		if (ph > 0) console.log("[draw-slot] resyncAll hello 帧含占位符消息 " + ph + " 条");
	} catch {
		/* 诊断日志不阻断 */
	}
	broadcast(frame);
};

/** 会话树条目是否为开场白 */
const isGreetingTreeEntry = (e: Record<string, unknown>): boolean => {
	const t = String(e.type ?? "");
	if (t === "custom_message" && e.customType === "rp-greeting") return true;
	const msg = e.message as { role?: unknown; customType?: unknown } | undefined;
	if (t === "message" && msg?.role === "custom" && msg?.customType === "rp-greeting") return true;
	return false;
};

/**
 * 宿主层切换开场白：await 导航 + 注入 + resync，避免叠楼。
 * （扩展里 pi.sendMessage 是 fire-and-forget，resync 会抢跑；且 custom_message 识别曾漏检）
 */
const hostSwitchGreeting = async (rawArg: string): Promise<void> => {
	const configPath = resolveConfigPath(cwd);
	let cfg: RpConfig = { ...DEFAULT_CONFIG };
	try {
		if (existsSync(configPath)) {
			cfg = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, "utf8")) as Partial<RpConfig>) };
		}
	} catch {
		/* default */
	}
	if (!cfg.card) {
		broadcast({ type: "notify", level: "error", text: "未配置角色卡" });
		return;
	}
	let card;
	try {
		const cardPath = isAbsolute(cfg.card) ? cfg.card : join(cwd, cfg.card);
		card = loadCardFile(cardPath);
	} catch (err) {
		broadcast({
			type: "notify",
			level: "error",
			text: `角色卡装载失败：${err instanceof Error ? err.message : String(err)}`,
		});
		return;
	}
	// 全量下标（与 buildGreeting / 配置 greetingIndex 一致）+ 非空槽位（切换时跳过空开场白）
	const fullPool = [card.firstMes, ...card.alternateGreetings].map((t, i) => ({
		i,
		t: typeof t === "string" ? t : "",
	}));
	const nonempty = fullPool.filter((x) => x.t.trim());
	if (nonempty.length === 0) {
		broadcast({ type: "notify", level: "error", text: "本卡没有开场白" });
		return;
	}
	const raw = rawArg.trim().toLowerCase();
	const curFull = cfg.greetingIndex ?? 0;
	let pos = nonempty.findIndex((x) => x.i === curFull);
	if (pos < 0) pos = 0;
	if (!raw || raw === "next") pos = (pos + 1) % nonempty.length;
	else if (raw === "prev") pos = (pos - 1 + nonempty.length) % nonempty.length;
	else {
		const n = Number.parseInt(raw, 10);
		if (!Number.isFinite(n)) {
			broadcast({ type: "notify", level: "error", text: "用法：/greeting [序号|next|prev]" });
			return;
		}
		// 数字按「全量下标」理解（与配置 / 卡面板一致）
		const hit = nonempty.findIndex((x) => x.i === n);
		pos = hit >= 0 ? hit : Math.max(0, Math.min(nonempty.length - 1, n));
	}
	const idx = nonempty[pos].i; // 写入配置与 buildGreeting 的全量下标
	const displayOrdinal = pos + 1; // 角标用非空序位 1..N
	const displayTotal = nonempty.length;
	try {
		const disk = existsSync(configPath)
			? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
			: {};
		disk.greetingIndex = idx;
		writeFileSync(configPath, `${JSON.stringify(disk, null, "\t")}\n`, "utf8");
	} catch (err) {
		broadcast({
			type: "notify",
			level: "error",
			text: `写入配置失败：${err instanceof Error ? err.message : String(err)}`,
		});
		return;
	}
	cfg = { ...cfg, greetingIndex: idx };

	const sm = session.sessionManager;
	const branch = sm.getBranch() as Array<Record<string, unknown>>;
	const hasUser = branch.some((e) => {
		if (e.type !== "message") return false;
		const msg = e.message as { role?: string; content?: unknown } | undefined;
		if (msg?.role !== "user") return false;
		return !isBackstageText(extractEntryText(msg.content));
	});
	if (hasUser) {
		broadcast({
			type: "notify",
			level: "info",
			text: `已选定开场白 ${displayOrdinal}/${displayTotal}，当前会话已开聊，下次新会话生效。`,
		});
		return;
	}

	const greets = branch.filter(isGreetingTreeEntry);
	if (greets.length > 0) {
		const first = greets[0];
		const parentId = (first.parentId as string | null) ?? null;
		if (parentId) {
			const result = await session.navigateTree(parentId, { summarize: false });
			if (result.cancelled) return;
		} else {
			// 树根开场白：resetLeaf，新开场白与旧的并列 sibling，当前只显示新的
			sm.resetLeaf();
			const ctx = sm.buildSessionContext();
			session.agent.state.messages = ctx.messages;
		}
	}

	const text = buildGreeting(card, cfg);
	// details 带序号 → wire greetingPick，前端角标与正文同源
	await session.sendCustomMessage({
		customType: "rp-greeting",
		content: text,
		display: true,
		details: { rpGreeting: { index: pos, total: displayTotal, fullIndex: idx } },
	});
	resyncAll();
	broadcast({ type: "notify", level: "info", text: `已切换开场白 ${displayOrdinal}/${displayTotal}` });
};

/**
 * ST 式再生成：叶指针落在「最后一条剧情 user」上，再 agent.continue()。
 * 新 assistant 作为该 user 的 sibling 子树；旧变体保留在旁支。
 *
 * 注意：session.navigateTree(userId) 对 user 会退到 parent 并把文案放进 editor，
 * 不适合 swipe（会拆成多条 user）。这里用 branch(userId) 固定挂在同一 user 下。
 * 不写 /store → 不产生世界线分叉。
 */
const regenerateSwipe = async (): Promise<void> => {
	const userId = lastStoryUserId();
	if (!userId) {
		broadcast({ type: "notify", level: "error", text: "没有可重新生成的剧情轮（需要先有一条用户输入）" });
		return;
	}
	const sm = session.sessionManager;
	// 记录 reroll 前的叶：生成失败/停止无产出时回退到旧回复（8/05：reroll 链上停止，前版本全消失）
	rerollFallbackLeaf = sm.getLeafId();
	// 叶钉回 user：引擎在 user 下挂新的 assistant sibling（swipe 语义）。
	// 世界状态/历史均为 f(分支)（R3/R4），无需旧的 navigateTree 恢复舞蹈——
	// 废弃分支上的场记快照天然不在新分支上，账本不会泄漏（8/02 A 雷的结构性解法）。
	if (sm.getLeafId() !== userId) {
		sm.branch(userId);
	}
	// 展示层立刻去掉旧回复（只显示到 user）
	resyncAll();
	await stage.regenerate();
};

/**
 * ST 式变体切换 / 再生成。
 * - prev：上一条 sibling（到头则提示）
 * - next：下一条；已在末条则再生成
 * - new：强制再生成
 */
const handleSwipe = async (dir: "prev" | "next" | "new"): Promise<void> => {
	if (dir === "new") {
		await regenerateSwipe();
		return;
	}
	const userId = lastStoryUserId();
	if (!userId) {
		broadcast({ type: "notify", level: "error", text: "没有可切换的回复变体" });
		return;
	}
	const entries = swipeEntriesFromSession();
	const leafId = session.sessionManager.getLeafId();
	const variants = listReplyVariants(entries, userId, leafId);
	if (variants.length === 0) {
		// 尚无回复：next/new 等价生成
		if (dir === "next") await regenerateSwipe();
		else broadcast({ type: "notify", level: "info", text: "还没有角色回复可切换" });
		return;
	}
	const meta = swipeMetaForUser(entries, userId, leafId);
	const idx = meta?.index ?? 0;
	if (dir === "prev") {
		if (idx <= 0) {
			broadcast({ type: "notify", level: "info", text: "已经是第一条变体" });
			return;
		}
		const target = variants[idx - 1].leafId;
		const result = await session.navigateTree(target, { summarize: false });
		if (!result.cancelled) resyncAll();
		return;
	}
	// next
	if (idx >= variants.length - 1) {
		await regenerateSwipe();
		return;
	}
	const target = variants[idx + 1].leafId;
	const result = await session.navigateTree(target, { summarize: false });
	if (!result.cancelled) resyncAll();
};

// ---------- 扩展绑定：headless UI 上下文 + 命令动作桥（参考 dist/modes/rpc/rpc-mode.js） ----------

const noop = () => {};

// ---------- 剧情决策门禁通道（Phase 4 柱 1）：uiContext.select/input ↔ 前端选择卡 ----------
//
// 扩展的 ask_director 工具调用 ctx.ui.select(question, options) 停笔询问；这里把它翻成
// choice 帧广播给所有端，挂起等待应答。语义（用户定调 2026-07-10）：
//   - 应答（选项原文 / 自由输入）→ resolve 该字符串，模型据此续写；
//   - 停止 → resolve undefined + abort 本回合（笔还给用户）；
//   - 无限等待（RP 本是回合制，不设超时）；
//   - 断线重连：hello 补发未决卡；多端先答先得，其余端收 choice_resolved 收敛留痕。

interface PendingChoice {
	question: string;
	options: string[];
	placeholder?: string;
	/** value=字符串应答；undefined=停止本回合 */
	resolve: (value: string | undefined) => void;
	settled: boolean;
}
const pendingChoices = new Map<string, PendingChoice>();
let choiceSeq = 0;

/** play_sound 帧发射（白名单 + 音量校验 + 广播）：uiContext 与台上引擎事件共用 */
const emitPlaySound = (sound: string, volume?: number) => {
	if (!isSoundFxName(sound)) return;
	const vol = typeof volume === "number" && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : undefined;
	broadcast({ type: "play_sound", sound, ...(vol !== undefined ? { volume: vol } : {}) });
};

/** JS Runner 程序化生成（ext_generate）进行中流：reqId → AbortController（ext_abort 用） */
const extGenerateControllers = new Map<string, AbortController>();

/** 未决卡帧（hello 补发 / 首次广播共用） */
const choiceFrame = (id: string, p: PendingChoice): ServerFrame => ({
	type: "choice",
	id,
	question: p.question,
	options: p.options,
	...(p.placeholder ? { placeholder: p.placeholder } : {}),
});

/** 收敛一张未决卡：resolve 扩展侧的挂起 Promise，并广播留痕态给所有端 */
const settleChoice = (id: string, outcome: { value?: string; stop?: boolean }) => {
	const p = pendingChoices.get(id);
	if (!p || p.settled) return;
	p.settled = true;
	pendingChoices.delete(id);
	broadcast({ type: "choice_resolved", id, ...(outcome.stop ? { stopped: true } : { answer: outcome.value }) });
	p.resolve(outcome.stop ? undefined : outcome.value);
};

/** 挂起一次询问，等前端应答（signal 触发或主动 abort 时按停止处理） */
const askChoice = (question: string, options: string[], placeholder: string | undefined, signal?: AbortSignal) =>
	new Promise<string | undefined>((resolve) => {
		const id = `c${Date.now().toString(36)}-${++choiceSeq}`;
		const pending: PendingChoice = { question, options, placeholder, resolve, settled: false };
		pendingChoices.set(id, pending);
		broadcast(choiceFrame(id, pending));
		// 回合被外部中止（主 Stop 按钮 / 压缩等）：未决卡按停止收敛，避免悬挂
		signal?.addEventListener("abort", () => settleChoice(id, { stop: true }), { once: true });
	});

const uiContext = {
	// 有实义的部分：通知直达 Web（审计告警零改动上屏）
	notify(message: string, type?: "info" | "warning" | "error") {
		broadcast({ type: "notify", level: type ?? "info", text: message });
	},
	// LLM 主动播放音效（play_sound 工具）：白名单校验后广播，前端按名合成提示音
	playSound(sound: string, volume?: number) {
		emitPlaySound(sound, volume);
	},
	// 决策门禁：选择卡（有选项）/ 自由输入卡（无选项）——均带自由输入框与停止按钮（前端渲染）
	select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) =>
		askChoice(title, Array.isArray(options) ? options : [], undefined, opts?.signal),
	confirm: async () => false,
	input: async (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) =>
		askChoice(title, [], placeholder, opts?.signal),
	editor: async () => undefined,
	custom: async () => undefined,
	// 其余 TUI 专属能力：no-op stub
	onTerminalInput: () => noop,
	setStatus: noop,
	setWorkingMessage: noop,
	setWorkingVisible: noop,
	setWorkingIndicator: noop,
	setHiddenThinkingLabel: noop,
	setWidget: noop,
	setFooter: noop,
	setHeader: noop,
	setTitle: noop,
	pasteToEditor: noop,
	setEditorText: noop,
	getEditorText: () => "",
	addAutocompleteProvider: noop,
	setEditorComponent: noop,
	getEditorComponent: () => undefined,
	get theme() {
		return undefined;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: () => ({ success: false, error: "Web 模式不支持主题切换" }),
	getToolsExpanded: () => false,
	setToolsExpanded: noop,
};

const bindSession = async () => {
	session = runtime.session;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- headless stub 集合，形状对齐 rpc-mode 的实现
	await session.bindExtensions({
		uiContext: uiContext as any,
		mode: "rpc",
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: (options: unknown) => runtime.newSession(options as never),
			fork: async (entryId: string, options: unknown) => {
				const result = await runtime.fork(entryId, options as never);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId: string, options: unknown) => {
				const result = await session.navigateTree(targetId, options as never);
				return { cancelled: result.cancelled };
			},
			switchSession: (sessionPath: string, options: unknown) => runtime.switchSession(sessionPath, options as never),
			reload: () => session.reload(),
		} as never,
		onError: (err: { extensionPath: string; event: string; error: string }) => {
			broadcast({ type: "error", text: `扩展错误（${err.event}）：${err.error}` });
		},
	});

	unsubscribe?.();
	unsubscribe = session.subscribe((event) => {
		// 流式防御：模型偶发把工具调用写成正文 XML 标签（<tool_calls><invoke …>），
		// 引擎不识别（只认结构化 toolCall），直播路径原样广播会让用户看到原始标签。
		// 此处按会话维护跨 delta 状态机，把 <tool_calls>…</tool_calls> 块从直播文本中剥掉
		//（定稿路径 postprocess 已有 unwrap 兜底；直播路径这里先拦）。
		let streamingToolCallTag = false;
		const stripStreamingToolCallTags = (delta: string): string => {
			if (streamingToolCallTag) {
				const close = delta.indexOf("</tool_calls>");
				if (close < 0) return "";
				streamingToolCallTag = false;
				return delta.slice(close + "</tool_calls>".length);
			}
			// 触发词双查：<tool_calls 或 <invoke(标签被流式切分时,<tool_calls 可能被切成
			// <tool_c + alls>,后半截也能靠 <invoke 命中进入吞标签状态,减少泄漏)
			let open = delta.indexOf("<tool_calls");
			if (open < 0) open = delta.indexOf("<invoke");
			if (open < 0) return delta;
			const before = delta.slice(0, open);
			const rest = delta.slice(open);
			const closeIdx = rest.indexOf("</tool_calls>");
			if (closeIdx < 0) {
				streamingToolCallTag = true;
				return before;
			}
			return before + rest.slice(closeIdx + "</tool_calls>".length);
		};
		switch (event.type) {
			case "agent_start":
				broadcast({ type: "agent", state: "start" });
				break;
			case "agent_end":
				if (!event.willRetry) {
					broadcast({ type: "agent", state: "end" });
					const stats = safeStats();
					if (stats) broadcast({ type: "stats", stats });
					// 挂上 swipe 序号（流式 message 帧无树元数据）
					resyncAll();
					// 内置向量记忆：按策略把本轮助手正文入库（异步，失败不影响叙事）
					void (async () => {
						try {
							const msgs = branchMessages() as Array<{ role?: string; content?: unknown }>;
							let lastText = "";
							for (let i = msgs.length - 1; i >= 0; i--) {
								const m = msgs[i];
								if (m?.role !== "assistant") continue;
								const c = m.content;
								if (typeof c === "string") lastText = c;
								else if (Array.isArray(c)) {
									lastText = c
										.map((p) =>
											p && typeof p === "object" && (p as { type?: string }).type === "text"
												? String((p as { text?: string }).text ?? "")
												: "",
										)
										.join("");
								}
								if (lastText.trim()) break;
							}
							const mem = await onNarrativeTurnEnd(
								cwd,
								{ sessionId: session.sessionId, card: cardPath || undefined },
								lastText,
							);
							if (mem.error) {
								broadcast({
									type: "notify",
									level: "warning",
									text: `向量记忆：入库失败 · ${mem.error}`,
								});
							} else if (mem.stored) {
								const how = mem.merged ? "合并入已有条目" : "新开条目";
								broadcast({
									type: "notify",
									level: "info",
									text: `向量记忆：剧情库${how}（第 ${mem.counter} 轮 · 当前对话）`,
								});
							}
						} catch (e) {
							console.warn("[memory] auto ingest failed", e);
						}
					})();
				}
				break;
			case "message_update": {
				const e = event.assistantMessageEvent;
				if (e.type === "text_delta") {
					const clean = stripStreamingToolCallTags(e.delta);
					if (clean) broadcast({ type: "delta", kind: "text", delta: clean });
				} else if (e.type === "thinking_delta") broadcast({ type: "delta", kind: "thinking", delta: e.delta });
				break;
			}
			case "message_end": {
				const wire = toWireMsg(event.message, names, { skin: currentDisplaySkin() });
				// user 消息在 prompt 受理时已回显，这里跳过防重
				if (wire && wire.channel !== "user") {
					broadcast({ type: "message", message: wire });
				} else if ((event.message as { role?: string } | undefined)?.role === "assistant") {
					// 中间 tool 轮 / 纯工具轮被过滤：清掉前端流式半成品，整轮只保留一个角色气泡
					broadcast({ type: "stream", state: "clear" });
				}
				break;
			}
			case "tool_execution_start": {
				// RP 人话摘要（非 JSON）；模型台侧旁白另由 stream→note 捕获
				const detail = toolStartDetail(event.toolName, event.args);
				broadcast({ type: "activity", activity: { kind: "tool_start", name: event.toolName, detail } });
				break;
			}
			case "tool_execution_end":
				broadcast({
					type: "activity",
					activity: {
						kind: "tool_end",
						name: event.toolName,
						detail: summarizeToolResult(event.result),
						isError: event.isError === true,
					},
				});
				break;
			case "compaction_start":
				broadcast({ type: "compaction", state: "start" });
				break;
			case "compaction_end":
				broadcast({ type: "compaction", state: "end", ok: !event.aborted && !event.errorMessage });
				resyncAll();
				break;
			case "auto_retry_start":
				broadcast({ type: "notify", level: "warning", text: `模型请求失败，自动重试 ${event.attempt}/${event.maxAttempts}…` });
				break;
			default:
				break;
		}
	});
};

runtime.setRebindSession(async () => {
	await bindSession();
	resyncAll(); // /branch 等替换会话后，所有端对齐新会话
});
await bindSession();

// ---------- REST 宿主接口（rest.ts 经此触碰 pi；pi 类型不出本文件） ----------

const currentModelInfo = (): CurrentModelInfo | null => {
	const m = session.model;
	if (!m) return null;
	return {
		provider: m.provider,
		id: m.id,
		name: m.name || m.id,
		thinkingLevel: session.thinkingLevel,
		availableLevels: session.getAvailableThinkingLevels(),
		contextWindow: m.contextWindow ?? 0,
		maxTokens: typeof m.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : undefined,
	};
};

// ---------- 分支角色消息编辑共用（scriptEditMessage / storyEdit） ----------

type RoleEditTarget =
	| { ok: true; targetId: string; targetIdx: number }
	| { ok: false; error: string };

/**
 * 分支目标定位（scriptEditMessage / storyEdit 共用）：
 * 二选一定位目标回复的「前驱」entry id。
 * - lastRoleIndex：从分支末尾倒数第 N 条「叙事条目」（assistant 回复 / rp-edited-reply 改稿），0=最后一条；
 * - branchIndex：分支数组下标（原语义）。
 * 前驱 = 目标条目的上一条 entry；目标即分支首（无前驱）时钉到分支根自身（目标回复移出当前分支）。
 */
const resolveRoleEditTarget = (
	branch: Array<{
		id: string;
		type?: unknown;
		customType?: string;
		message?: { role?: unknown };
	}>,
	input: { lastRoleIndex?: number; branchIndex?: number },
): RoleEditTarget => {
	if (input.lastRoleIndex !== undefined) {
		// lastRoleIndex 定位：收集分支中全部「叙事条目」下标（assistant 回复 + rp-edited-reply
		// 改稿——2026-08-12 二次修复：此前只收 message/assistant，改稿楼层被跳过 →
		// 目标回跳更早楼层，story_edit 改错楼层），从末尾往前取第 N+1 个
		if (!Number.isInteger(input.lastRoleIndex) || input.lastRoleIndex < 0) {
			return { ok: false, error: "lastRoleIndex 必须是非负整数" };
		}
		const roleIdx: number[] = [];
		branch.forEach((e, i) => {
			if (e.type === "message") {
				const role = e.message?.role;
				// 只收 assistant——custom 角色消息（rp-edited-reply 转义等）不该被当改稿目标
				if (role === "assistant") roleIdx.push(i);
				return;
			}
			if (e.type === "custom_message" && e.customType === "rp-edited-reply") {
				roleIdx.push(i);
			}
		});
		const target = roleIdx[roleIdx.length - 1 - input.lastRoleIndex];
		if (target === undefined) {
			return { ok: false, error: `lastRoleIndex 超出角色消息范围（0..${Math.max(0, roleIdx.length - 1)}）` };
		}
		// 前驱锚点：跳过 runtime 生成过程记的 model_change 等纯元数据节点——钉到它们
		// 下面会让改稿楼层挂在生成中间节点上（事故：润色后原回复被移出主路径、
		// 改稿版挂到 model_change 层，前端刷新前后状态不一致）。只跳 model_change：
		// user 消息/rp-state 快照等其余类型都是稳定锚点，维持「紧邻前驱」原语义。
		let anchorIdx = target - 1;
		while (anchorIdx > 0 && branch[anchorIdx].type === "model_change") anchorIdx--;
		return { ok: true, targetId: target <= 0 ? branch[0].id : branch[anchorIdx].id, targetIdx: target };
	}
	const branchIndex = input.branchIndex;
	if (
		typeof branchIndex !== "number" ||
		!Number.isInteger(branchIndex) ||
		branchIndex < 0 ||
		branchIndex >= branch.length
	) {
		return { ok: false, error: `branchIndex 超出会话分支范围（0..${Math.max(0, branch.length - 1)}）` };
	}
	// 前驱 = 目标条目的上一条 entry；branchIndex===0（分支根无前驱）时导航到分支根自身
	return {
		ok: true,
		targetId: branchIndex === 0 ? branch[0].id : branch[branchIndex - 1].id,
		targetIdx: branchIndex,
	};
};

/**
 * 钉叶到分支目标前驱 + 同步 agent 内存消息（scriptEditMessage / storyEdit 共用）。
 * 不用 session.navigateTree——它对 user/assistant 目标有副作用语义
 * （实测导致分支回退到开场白、改写丢失）。sm.branch 是同步叶指针移动
 * （无 session_tree 事件、无 editor 副作用）；entry 不存在会抛错（REST 层兜底 400）。
 */
const branchCommitToTarget = (targetId: string): void => {
	const sm = session.sessionManager;
	const from = sm.getLeafId();
	sm.branch(targetId);
	// 2026-08-12 排查日志：story_edit / embedStoryImage / regenerateSwipe 等所有 sm.branch 调用点经此记录
	console.log(`[liyuan-trace] [leafSwitch] ${from?.slice(0, 8) ?? "none"} → ${targetId.slice(0, 8)}`);
	const ctx = sm.buildSessionContext();
	session.agent.state.messages = ctx.messages;
};

// ---------- 模型配置归一（2026-08-15） ----------
// 模型列表 = 用户自己的渠道（配置仓库档案 ∪ 当前启用的 liyuan.agent.json），
// 而不是 pi 内置 provider 目录（amazon-bedrock 等 1000+ 项）。做法：
// 把仓库全部档案的渠道（含 apiKey/models）注册进主会话 modelRegistry——
// 列表里每个渠道都 find 得到、key 判定成立；当前启用配置最后注册（优先级最高）。

/** 用户渠道键集合：配置仓库全部档案 ∪ 当前启用的 liyuan.agent.json */
function listUserProviders(): Set<string> {
	const set = new Set<string>();
	for (const p of listProfiles(cwd)) {
		const rec = loadProfile(cwd, p.id);
		if (!rec) continue;
		for (const k of Object.keys(rec.config.providers ?? {})) set.add(k);
	}
	const cur = loadAgentConfig(cwd);
	for (const k of Object.keys(cur.config?.providers ?? {})) set.add(k);
	return set;
}

/** 把配置仓库 + 当前启用的渠道全部注册进主会话 modelRegistry（含 apiKey/models） */
function registerUserProviders(): void {
	// 注册前给模型条目补 input 默认值：pi 的 registerProvider 构造模型对象时 input/cost 无默认
	// （registerProvider 路径 vs loadModels 路径有 ?? ["text"]/?? defaultCost）——缺 input 时
	// 历史含图片 toolResult 触发 openai-completions.ts:1076 `model.input.includes` 崩
	// （2026-08-15 实测「生成失败：Cannot read properties of undefined (reading 'includes')」）；
	// 缺 cost 时流式响应带 usage 触发 models.ts:389 `model.cost.input` 崩（同日晚实测 reading 'input'）。
	// pi 侧已于 2026-08-15 在 registerProvider 补两处默认（model-registry.ts），此处兜底保留作防御。
	const fixInput = (pc: Record<string, unknown>): Record<string, unknown> =>
		Array.isArray(pc.models)
			? { ...pc, models: pc.models.map((m) => (m && typeof m === "object" ? { ...(m as object), input: (m as { input?: unknown }).input ?? ["text"] } : m)) }
			: pc;

	const seen = new Set<string>();
	for (const p of listProfiles(cwd)) {
		const rec = loadProfile(cwd, p.id);
		if (!rec) continue;
		for (const [pk, pc] of Object.entries(rec.config.providers ?? {})) {
			if (seen.has(pk)) continue;
			seen.add(pk);
			try {
				session.modelRegistry.registerProvider(pk, fixInput(pc as Record<string, unknown>) as never);
			} catch (err) {
				console.warn(
					`[liyuan] 注册配置仓库渠道「${pk}」（档案 ${rec.name}）失败：${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
	// 当前启用的配置最后注册（优先级最高，覆盖同名档案）
	const cur = loadAgentConfig(cwd);
	for (const [pk, pc] of Object.entries(cur.config?.providers ?? {})) {
		try {
			session.modelRegistry.registerProvider(pk, fixInput(pc as Record<string, unknown>) as never);
		} catch (err) {
			console.warn(`[liyuan] 注册当前渠道「${pk}」失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ---- 表格 SQL 字面量/列类型 helper（applyTableOp 与模板物化共用；SQL 化 2026-08-16）----
const tableEsc = (v: string): string => v.replace(/'/g, "''");
const tableLit = (v: unknown, type?: string): string => {
	if (v === null || v === undefined) return "NULL";
	const t = type ?? "text";
	if (t === "number" || t === "integer" || t === "real") {
		const n = Number(v);
		return Number.isFinite(n) ? String(n) : "NULL";
	}
	if (t === "boolean") return v === true || v === 1 || v === "1" ? "1" : "0";
	return `'${tableEsc(String(v))}'`;
};
const tableColType = (meta: { columns?: Array<{ name: string; type?: string }> }, name: string): string =>
	meta.columns?.find((c) => c.name === name)?.type ?? "text";

/**
 * SQL 化模板物化（2026-08-16）：模板表建进 SQLite（旧 materializeTemplate 写
 * state.tables 快照，剧情侧不可见）。幂等：表已存在 → 增量加列 + 覆写说明；初始行可填。
 */
async function materializeTemplateToSql(def: TableTemplateDef): Promise<{ applied: string[]; warnings: string[] }> {
	const svc = stage.tablesService();
	const applied: string[] = [];
	const warnings: string[] = [];
	for (const t of def.tables) {
		const r = svc.createTable({
			name: t.name,
			auto: !!t.auto,
			description: buildTableDescription(t),
			columns: (t.columns ?? []).map((c) => ({
				name: c.name,
				type: (c.type ?? "text") as "text" | "number" | "integer" | "real" | "boolean",
				description: c.description,
			})),
		});
		if (!r.ok) {
			warnings.push(`表「${t.name}」：${r.error}`);
			continue;
		}
		applied.push(`表「${t.name}」已就绪`);
		if (t.rows?.length) {
			let inserted = 0;
			for (const row of t.rows) {
				const cols = Object.keys(row).filter((k) => (t.columns ?? []).some((c) => c.name === k));
				if (cols.length === 0) continue;
				const sql = `INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((c) => tableLit(row[c])).join(", ")})`;
				const ir = svc.execWrite(sql);
				if (ir.ok) inserted++;
				else warnings.push(`表「${t.name}」初始行：${ir.error}`);
			}
			if (inserted) applied.push(`表「${t.name}」填充初始数据 ${inserted} 行`);
		}
	}
	return { applied, warnings };
}

// -*- 编辑正文 / 树操作 / 记账的可观测日志（DESIGN-story-edit + 方案 B 加固，2026-08-16） -*-
// 统一 [liyuan-trace] 前缀：叶切换 / 记账(rp-state 落账) / 回滚(replayTables) / 写表(落树) /
// 编辑槽复用 / 旁路重记账 / 助手写表 —— 全部打点，服务器端后台可见，方便跟踪。
export const tlog = (...args: unknown[]): void => {
	console.log("[liyuan-trace]", ...args);
};

/**
 * 编辑正文（rp-edited-reply 槽复用，方案 B 2026-08-16）：
 * 对同一目标楼，复用其下已存在的一条 rp-edited-reply 槽（原位 setEntryContent 覆写，
 * 旧值进槽 details.history 留档可回滚），而非每次 append 新叶——树不膨胀、账本 f(分支) 稳定。
 */
function writeEditReplySlot(
	sm: { getChildren(id: string): Array<Record<string, unknown>>; appendCustomMessageEntry(...a: unknown[]): unknown; setEntryContent?(id: string, content: unknown, details?: unknown): boolean },
	mode: string,
	targetId: string,
	text: string,
): string | null {
	try {
		const children = (sm.getChildren(targetId) ?? []).filter(
			(e) => (e as { customType?: string }).customType === "rp-edited-reply",
		);
		const slot = children[0] as
			| { id?: string; content?: unknown; details?: { history?: Array<{ at: number; text: string }> } }
			| undefined;
		// 槽复用仅当底层 sessionManager 真的支持原位覆写（setEntryContent）才走——
		// api 的 runtime session manager（packages/agent harness）没有 setEntryContent，
		// 只有 appendCustomMessageEntry。若强行调用会抛「setEntryContent is not a function」，
		// 而此刻叶已被 branchCommitToTarget 切到目标前驱，槽写入失败=不注入任何回复
		// → 最新楼层被删（真实日志 floors=84→83，尾部停在「用户」楼）。
		// 该场景改为「追加新槽」兜底（等价改动前行为，楼层保留、原文留旧槽可回滚）。
		if (slot?.id && typeof sm.setEntryContent === "function") {
			const cur =
				Array.isArray(slot.content)
					? (slot.content as Array<{ type?: string; text?: string }>)
							.map((c) => (typeof c?.text === "string" ? c.text : ""))
							.join("\n")
					: typeof slot.content === "string"
						? slot.content
						: "";
			const history = Array.isArray(slot.details?.history) ? slot.details!.history!.slice() : [];
			history.push({ at: Date.now(), text: cur });
			const ok = sm.setEntryContent(slot.id, [{ type: "text", text }], { history, source: mode });
			tlog(`[editReply] ${mode} 覆写槽 ${slot.id?.slice(0, 8)} -> 目标 ${targetId.slice(0, 8)} history=${history.length + 1} ok=${ok}`);
			return slot.id;
		}
		// 首次建槽 / 或槽复用不可用（pi sessionManager 无 setEntryContent）时追加新槽：
		// 追加一定能注入正文，绝不静默失败导致楼层被删。
		const id = sm.appendCustomMessageEntry("rp-edited-reply", [{ type: "text", text }], true, { source: mode });
		tlog(`[editReply] ${mode} ${slot?.id && typeof sm.setEntryContent !== "function" ? "槽复用不可用，追加" : "首次建槽"} ${typeof id === "string" ? id.slice(0, 8) : "?"} -> 目标 ${targetId.slice(0, 8)}`);
		return typeof id === "string" ? id : null;
	} catch (err) {
		tlog(`[editReply] ${mode} 槽写入异常：${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

const restHost: RestHost = {
	cwd,
	isStreaming: () => session.isStreaming,
	listModels: () => {
		// models = 已认证（可直选）；allModels = 用户自己的渠道（配置仓库档案 ∪ 当前启用，
		// 每项带 ready——未配 key 的渠道置灰展示「看得见但用不了」）
		const userProviders = listUserProviders();
		const toInfo = (m: { provider: string; id: string; name?: string; reasoning?: boolean; input?: unknown[]; contextWindow?: number; maxTokens?: number }) => ({
			provider: m.provider,
			providerName: session.modelRegistry.getProviderDisplayName(m.provider),
			id: m.id,
			name: m.name || m.id,
			reasoning: m.reasoning === true,
			vision: Array.isArray(m.input) && m.input.includes("image"),
			contextWindow: m.contextWindow ?? 0,
			maxTokens: typeof m.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : undefined,
			ready: session.modelRegistry.hasConfiguredAuth(m as never),
		});
		return {
			current: currentModelInfo(),
			models: session.modelRegistry.getAvailable().map(toInfo),
			// 模型配置归一：列表 = 用户自己的渠道（配置仓库档案 ∪ 当前启用），
			// 不暴露 pi 内置 provider 目录（amazon-bedrock 等未配置渠道）
			allModels: session.modelRegistry
				.getAll()
				.filter((m) => userProviders.has(m.provider))
				.map(toInfo),
		};
	},
	async selectModel(provider, id) {
		const m = session.modelRegistry.find(provider, id);
		if (!m) throw new Error(`模型不存在：${provider}/${id}`);
		await session.setModel(m);
		const current = currentModelInfo();
		if (!current) throw new Error("模型切换后状态异常");
		return current;
	},
	setThinkingLevel(level) {
		// 各模型档位名不同（off/low/high/xhigh/max…），由用户按模型文档自填英文，不做固定白名单
		const lv = level.trim();
		if (!lv) throw new Error("思考档位不能为空");
		session.setThinkingLevel(lv as never);
		const current = currentModelInfo();
		if (!current) throw new Error("会话未就绪");
		return current;
	},
	authProviders() {
		const counts = new Map<string, number>();
		for (const m of session.modelRegistry.getAll()) {
			counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
		}
		// 当前会话模型所属 provider 置顶，便于在「现有渠道」里看见
		const currentProvider = session.model?.provider;
		return [...counts.entries()]
			.map(([provider, modelCount]) => {
				const status = session.modelRegistry.getProviderAuthStatus(provider);
				// pi：环境变量渠道 configured 恒 false，但 hasAuth 为真且模型可用
				const ready = session.modelRegistry.authStorage.hasAuth(provider);
				return {
					provider,
					displayName: session.modelRegistry.getProviderDisplayName(provider),
					configured: status.configured,
					ready,
					...(ready || status.configured
						? {
								source: status.configured ? status.source : "environment",
								...(status.label ? { label: status.label } : {}),
							}
						: status.source === "environment" && status.label
							? { label: status.label } // 未就绪也提示可配哪个环境变量
							: {}),
					modelCount,
				};
			})
			.sort((a, b) => {
				if (currentProvider) {
					if (a.provider === currentProvider && b.provider !== currentProvider) return -1;
					if (b.provider === currentProvider && a.provider !== currentProvider) return 1;
				}
				return Number(b.ready) - Number(a.ready) || Number(b.configured) - Number(a.configured) || a.displayName.localeCompare(b.displayName);
			});
	},
	setAuthKey(provider, key) {
		session.modelRegistry.authStorage.set(provider, { type: "api_key", key });
	},
	removeAuth(provider) {
		session.modelRegistry.authStorage.remove(provider);
	},
	agentDir: () => getAgentDir(),
	providerSnapshot(provider) {
		const all = session.modelRegistry.getAll().filter((m) => m.provider === provider);
		if (all.length === 0) return null;
		const sample = all[0] as { baseUrl?: string; api?: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number };
		const status = session.modelRegistry.getProviderAuthStatus(provider);
		const envKey =
			status.source === "environment" && status.label
				? status.label
				: provider === "deepseek"
					? "DEEPSEEK_API_KEY"
					: undefined;
		return {
			provider,
			baseUrl: typeof sample.baseUrl === "string" ? sample.baseUrl : undefined,
			api: typeof sample.api === "string" ? sample.api : undefined,
			envKey,
			models: all.map((m) => ({
				id: m.id,
				name: m.name || m.id,
				reasoning: m.reasoning === true,
				contextWindow: m.contextWindow ?? undefined,
				maxTokens: (m as { maxTokens?: number }).maxTokens,
			})),
		};
	},
	refreshModels: () => {
		// 配置归一（2026-08-15）：刷新前先注册配置仓库的全部渠道——refresh 会重放
		// registeredProviders（apiKey 随渠道配置走），新档案/新 key 即时生效
		registerUserProviders();
		session.modelRegistry.refresh();
	},
	async reloadSession() {
		await session.reload();
		refreshNamesFromConfig();
		resyncAll();
	},
	/** 身份/配置/世界书挂载等：走扩展 /rprefresh，不整会话 reload */
	async softRefreshConfig() {
		if (session.isStreaming) {
			// 流式中改设定：排队到本轮结束，避免与 prompt 抢通道
			void session
				.prompt("/rprefresh", { streamingBehavior: "followUp" })
				.then(() => {
					refreshNamesFromConfig();
					resyncAll();
				})
				.catch((err) => {
					broadcast({
						type: "notify",
						level: "error",
						text: err instanceof Error ? err.message : String(err),
					});
				});
			return;
		}
		await session.prompt("/rprefresh");
		refreshNamesFromConfig();
		resyncAll();
	},
	/** 自定义 agent 管理界面工具清单：stagehand 工具 + 启用插件工具 + 内置工具（read/bash/edit/write） */
	listAgentTools: () => [...STAGEHAND_TOOL_NAMES, ...stagehandPluginToolNames(), "read", "bash", "edit", "write"],
	/**
	 * agents 热重建（PUT /api/config 的 agents 段写盘后触发，DESIGN-custom-agents §4/§6）：
	 * - 删除：不再存在于新配置的自定义 agent → dispose + 注销 runner + 出表（记 removed）；
	 * - 变更/新增：配置签名（JSON.stringify）与 lastAgentConfigs 不同 → dispose 旧 host、
	 *   照启动循环同样参数重建（另加 tools 内置工具白名单），更新注册表与签名（记 ok）；相同 → 跳过（记 ok）；
	 * - 忙碌（isStreaming）中的 agent → busy，本轮跳过，等下次热重建再处理；
	 * - 内置助手（assistant）不在管理范围：永不删除/重建（行为零变化）；
	 * - 每个 agent 独立 try/catch，单个失败仅 log 警告并记 busy，不影响其余 agent；
	 * - 完成后对所有 host 批量对齐当前剧情会话（syncAllAgentStories，switchToStory 幂等）。
	 */
	async reloadAgents() {
		const result: Record<string, "ok" | "busy" | "removed"> = {};
		const next = loadConfig(cwd).agents ?? [];
		const nextById = new Map(next.map((c) => [c.id, c] as const));

		// 第一步删除：不再配置的自定义 agent → dispose + 注销 + 出表
		for (const id of [...agentHosts.keys()]) {
			if (id === "assistant") continue; // 内置助手不在管理范围
			if (nextById.has(id)) continue;
			const host = agentHosts.get(id);
			if (!host) continue;
			try {
				if (host.isStreaming()) {
					result[id] = "busy"; // 忙碌中：保留，等下次热重建
					continue;
				}
				await host.dispose();
			} catch (err) {
				console.warn(
					`[liyuan] 热重建删除 agent「${id}」失败（保留，记 busy）：${err instanceof Error ? err.message : String(err)}`,
				);
				result[id] = "busy";
				continue;
			}
			agentHosts.delete(id);
			unregisterAgentRunner(id);
			lastAgentConfigs.delete(id);
			result[id] = "removed";
		}

		// 第二步创建/更新：签名比对，变更/新增则重建
		for (const cfg of next) {
			const id = cfg.id;
			if (id === "assistant") continue; // 内置助手名保留（loadConfig 归一化已剔除，这里兜底）
			const sig = JSON.stringify(cfg);
			if (lastAgentConfigs.get(id) === sig) {
				result[id] = "ok"; // 配置未变：跳过
				continue;
			}
			const existing = agentHosts.get(id);
			try {
				if (existing?.isStreaming()) {
					result[id] = "busy"; // 忙碌中：不重建，等下次热重建
					continue;
				}
				// prompt 与 promptFile 二选一（照启动循环同规则）
				let systemPrompt = cfg.prompt;
				if (!systemPrompt && cfg.promptFile) {
					systemPrompt = readFileSync(
						isAbsolute(cfg.promptFile) ? cfg.promptFile : join(cwd, cfg.promptFile),
						"utf8",
					);
				}
				if (existing) await existing.dispose();
				const host = await createAgentHost({
					cwd,
					// 桥按各自配置裁剪（只读组 readStory 一键开关；写权限默认 false，配错最多「委托报无权限」）
					bridge: createStoryBridge(storyBridgeBase, cfg.bridge),
					agentId: id,
					agentName: cfg.name,
					sessionDirName: `.liyuan-agents/${id}`,
					systemPrompt,
					toolsAllow: cfg.tools,
					tools: cfg.tools, // 内置工具白名单：与 stagehand 同清单，两端一起裁剪
					model: cfg.model ?? null,
					followsStoryModel: !cfg.model,
					// 与主聊天共享 modelRegistry/authStorage（2026-08-15，同内置助手）
					modelRegistry: runtime.services.modelRegistry,
					authStorage: runtime.services.authStorage,
					uiContext,
					onEvent: onAssistantEvent,
					onError: (text) => broadcast({ type: "error", text }),
				});
				agentHosts.set(id, host);
				registerAgentRunner(id, buildAgentRunner(id));
				lastAgentConfigs.set(id, sig);
				result[id] = "ok";
			} catch (err) {
				console.warn(
					`[liyuan] 热重建 agent「${id}」失败（保留旧 host，记 busy）：${err instanceof Error ? err.message : String(err)}`,
				);
				result[id] = "busy";
			}
		}

		// 全部重建 host 对齐当前剧情会话（有绑定则打开，无则新建；switchToStory 幂等）
		try {
			await syncAllAgentStories();
		} catch (err) {
			console.error(
				`[liyuan] 热重建后对齐剧情会话失败：${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return result;
	},
	async scriptEditMessage(input) {
		const branch = session.sessionManager.getBranch() as Array<{
			id: string;
			parentId?: string | null;
			type?: unknown;
			message?: { role?: unknown };
		}>;
		const resolved = resolveRoleEditTarget(branch, input);
		if (!resolved.ok) throw new Error(resolved.error);
		// 钉叶到前驱：不用 session.navigateTree——它对 user/assistant 目标有副作用语义
		// （user 会退回 parent 并把文案塞进 editor，实测导致分支回退到开场白、改写丢失）。
		// 与 regenerateSwipe 同款纪律：sm.branch 直钉叶指针 + 同步 agent.state.messages。
		// sm.branch 是同步叶指针移动（无 session_tree 事件、无 editor 副作用）；entry 不存在会抛错（REST 层兜底 400）。
		branchCommitToTarget(resolved.targetId);
		if (input.op === "edit" && input.text) {
			// 编辑正文（方案 B：槽复用——同楼多次编辑复用同一条 rp-edited-reply，不新增叶）
			writeEditReplySlot(session.sessionManager as never, "scriptEditMessage", resolved.targetId, input.text);
		}
		// op=delete：只导航到前驱（目标回复退出当前分支），不注入任何内容
		resyncAll();
	},
	async switchToCard() {
		refreshNamesFromConfig(); // rest.ts 已写盘新 card，先让会话过滤对准新卡
		// 清卡缓存：换卡后列表必须按新 cardPath 重读 rp-card
		cardCache.clear();
		const frame = await listSessions();
		const list = (frame as { type: "sessions"; list: Array<{ path: string; current: boolean; card?: string }> }).list;
		// 只在本卡会话里挑「最近非当前」；没有则新建（不把其它卡的 current 误当目标）
		const target = list.find((s) => !s.current && (!s.card || sameCardPath(s.card, cardPath, cwd)));
		let result: "switched" | "created";
		if (target) {
			await runtime.switchSession(target.path);
			result = "switched";
		} else {
			await runtime.newSession();
			result = "created";
		}
		broadcast(await listSessions());
		// agent：换卡后按新剧情会话对齐（新建绑定，不误接旧卡/旧聊上下文；switchToStory 幂等）
		await syncAllAgentStories();
		if (agentHosts.has("assistant")) broadcast(assistantHelloFrame());
		return result;
	},
	promptCommand: (text) => handlePrompt(text),
	queueCommand(text) {
		const queued = storyStreaming();
		// 不等待执行完成（流式中排队到本轮结束；/import 等长操作进度经 notify 推送）
		void handlePrompt(text).catch((err) => {
			broadcast({ type: "error", text: err instanceof Error ? err.message : String(err) });
		});
		return queued;
	},
	// 面板导入：写盘 + 进程内直达收编（不经 /panelsync prompt，避免 assistant_run 内死锁）
	async importPanels(list) {
		const file = join(artifactsDir, `${session.sessionId}.json`);
		let panels = loadPanels(file);
		let imported = 0;
		const names: string[] = [];
		const errors: string[] = [];
		for (const item of list) {
			const name = String(item?.name ?? "");
			const r = writePanel(panels, {
				name,
				kind: String(item?.kind ?? ""),
				content: String(item?.content ?? ""),
			});
			if (r.ok) {
				panels = r.panels;
				imported++;
				names.push(name.trim());
			} else {
				errors.push(`「${name || "?"}」：${r.error}`);
			}
		}
		if (imported > 0) {
			savePanels(file, panels);
			syncStoryPanelsFromDisk();
		}
		return { imported, names, errors };
	},
	// 用户删除面板：写盘 + 进程内收编
	async closePanel(name) {
		const file = join(artifactsDir, `${session.sessionId}.json`);
		const panels = loadPanels(file);
		const r = closePanelInMap(panels, name);
		if (!r.ok) throw new Error(r.error);
		savePanels(file, r.panels);
		syncStoryPanelsFromDisk();
	},
	// 用户手改面板源码：同 import 写路径，但要求面板已存在且未归档
	async savePanel(input) {
		const name = String(input?.name ?? "").trim();
		if (!name) throw new Error("面板名不能为空");
		const file = join(artifactsDir, `${session.sessionId}.json`);
		const panels = loadPanels(file);
		const prev = panels[name];
		if (!prev) throw new Error(`没有名为「${name}」的面板`);
		if (prev.archived) throw new Error(`面板「${name}」已归档，请先由 agent 同名写入重开`);
		const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : prev.kind;
		const r = writePanel(panels, { name, kind, content: String(input.content ?? "") });
		if (!r.ok) throw new Error(r.error);
		savePanels(file, r.panels);
		syncStoryPanelsFromDisk();
		const saved = r.panels[name];
		return { name: saved.name, kind: saved.kind, updatedAt: saved.updatedAt };
	},
	// 挂载知识库：与扩展 restoreCodexFromBranch 同规则——当前分支上最近的 rp-codex 快照
	mountedCodexes() {
		try {
			const branch = session.sessionManager.getBranch() as Array<{
				type: string;
				customType?: string;
				data?: { mounted?: unknown };
			}>;
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e.type === "custom" && e.customType === "rp-codex") {
					const mounted = e.data?.mounted;
					return Array.isArray(mounted) ? mounted.filter((n): n is string => typeof n === "string") : [];
				}
			}
		} catch {
			// 树读取失败按无挂载处理
		}
		return [];
	},
	// ---- 世界状态编辑（PLAN-PANELS §2.11）：用户主权 applyPatch，落盘即广播，命令桥收编进树 ----
	async applyStatePatch(patch) {
		const file = join(stateDir, `${session.sessionId}.json`);
		const r = applyPatch(loadState(file), patch);
		saveState(file, r.state); // fs.watch 自动广播 state 帧
		syncStoryStateFromDisk();
		return { applied: r.applied, warnings: r.warnings };
	},
	// ---- 自定义表格操作（SQL 化，DESIGN-tables-sql）：旧 TableOp 接口翻译成 SQL 走 TablesService。
	// 旧实现写 WorldState.tables 磁盘缓存——与剧情侧（SQLite）脱节，助手写表「返回成功但剧情看不到」。
	async applyTableOp(op) {
		const opKey = `${op.kind}:${"name" in op ? op.name : op.kind === "query" || op.kind === "insert" || op.kind === "update" || op.kind === "delete" ? op.table : ""}`;
		try {
			const svc = stage.tablesService();
			tlog(`[tableOp] ${opKey} 开始`);

			if (op.kind === "create") {
				const r = svc.createTable({
					name: op.name,
					auto: !!op.auto,
					description: op.description ?? "",
					columns: (op.columns ?? []).map((c) => ({
						name: c.name,
						type: (c.type ?? "text") as "text" | "number" | "integer" | "real" | "boolean",
						description: c.description,
					})),
				});
				return r.ok ? { ok: true, applied: [`表 ${op.name} 已创建`] } : { ok: false, error: r.error };
			}
			if (op.kind === "drop") {
				const r = svc.dropTable(op.name);
				return r.ok ? { ok: true, applied: [`表 ${op.name} 已删除`] } : { ok: false, error: r.error };
			}
			if (op.kind === "setAuto") {
				const meta = svc.getMeta(op.table);
				if (!meta) return { ok: false, error: `表 ${op.table} 不存在` };
				meta.auto = op.auto;
				const r = svc.updateMeta(meta);
				return r.ok ? { ok: true, applied: [`表 ${op.table} auto=${op.auto}`] } : { ok: false, error: r.error };
			}
			if (op.kind === "insert") {
				const meta = svc.getMeta(op.table);
				if (!meta) return { ok: false, error: `表 ${op.table} 不存在` };
				const cols = Object.keys(op.row ?? {});
				if (cols.length === 0) return { ok: false, error: "insert 需要 row" };
				const sql = `INSERT INTO "${op.table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((c) => tableLit(op.row[c], tableColType(meta, c))).join(", ")})`;
				const r = svc.execWrite(sql);
				return r.ok ? { ok: true, applied: [`表 ${op.table} 插入 1 行`] } : { ok: false, error: r.error };
			}
			if (op.kind === "update") {
				const meta = svc.getMeta(op.table);
				if (!meta) return { ok: false, error: `表 ${op.table} 不存在` };
				const sets = Object.entries(op.changes ?? {}).map(([k, v]) => `"${k}" = ${tableLit(v, tableColType(meta, k))}`);
				const wheres = Object.entries(op.match ?? {}).map(([k, v]) => `"${k}" = ${tableLit(v, tableColType(meta, k))}`);
				if (sets.length === 0) return { ok: false, error: "update 需要 changes" };
				if (wheres.length === 0) return { ok: false, error: "update 需要 match（WHERE 定位）" };
				const sql = `UPDATE "${op.table}" SET ${sets.join(", ")} WHERE ${wheres.join(" AND ")}`;
				const r = svc.execWrite(sql);
				return r.ok ? { ok: true, applied: [`表 ${op.table} 更新 ${r.changes} 行`] } : { ok: false, error: r.error };
			}
			if (op.kind === "delete") {
				const meta = svc.getMeta(op.table);
				if (!meta) return { ok: false, error: `表 ${op.table} 不存在` };
				const wheres = Object.entries(op.match ?? {}).map(([k, v]) => `"${k}" = ${tableLit(v, tableColType(meta, k))}`);
				if (wheres.length === 0) return { ok: false, error: "delete 需要 match（WHERE 定位）" };
				const sql = `DELETE FROM "${op.table}" WHERE ${wheres.join(" AND ")}`;
				const r = svc.execWrite(sql);
				return r.ok ? { ok: true, applied: [`表 ${op.table} 删除 ${r.changes} 行`] } : { ok: false, error: r.error };
			}
			if (op.kind === "query") {
				const meta = svc.getMeta(op.table);
				if (!meta) return { ok: false, error: `表 ${op.table} 不存在` };
				const where = op.filter
					? ` WHERE ${Object.entries(op.filter).map(([k, v]) => `"${k}" = ${tableLit(v, tableColType(meta, k))}`).join(" AND ")}`
					: "";
				// ORDER BY rowid DESC：最新写入的行在前——此前 LIMIT 100 取前 100 行全是旧行，
				// 助手全表查「看不到刚写的行」→ 误判未落盘（2026-08-16 实测闭环验证）。
				const r = svc.execRead(`SELECT * FROM "${op.table}"${where} ORDER BY rowid DESC LIMIT 100`);
				return r.ok ? { ok: true, rows: r.rows } : { ok: false, error: r.error };
			}
			return { ok: false, error: `未知表操作：${String((op as { kind?: string }).kind ?? "")}` };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	},
	// ---- 自定义表格模板物化（DESIGN-template-system §5；SQL 化 2026-08-16）：建 SQLite 表（幂等） ----
	async applyTemplate(name) {
		const def = loadTemplate(cwd, name);
		if (!def) return { ok: false, error: `模板 ${name} 不存在` };
		const r = await materializeTemplateToSql(def);
		return { ok: true, applied: r.applied, warnings: r.warnings };
	},
	// ---- 表格历史回填（DESIGN-table-backfill §3）：已停用（SQL 化 2026-08-16）----
	// 旧实现从历史楼层提取数据写 state.tables（剧情侧不可见）；SQL 化后表格维护由
	// 场记代理按各表【维护规则】自主完成，回填通道不再必要。
	async applyTableBackfill(name) {
		return { ok: false, error: "表格回填已停用（SQL 化后场记代理按各表维护规则自主维护表格；如需补历史数据，可让助手按表说明用 sql_write 写入）" };
	},
	// ---- 原始导入（DESIGN-import-raw §2）：逐层回放 ST 聊天记录到新会话（旁路 LLM 场记，可中断）----
	async importRaw(input) {
		const content = (input.content ?? "").trim();
		if (!content) return { ok: false, error: "聊天记录内容为空" };
		// 1) ST 解析 + 清洗 → floors（user/assistant 对，含 name/text）
		let floors: ReplayFloor[];
		try {
			const parsed = parseStChat(content);
			const cleaned = cleanChat(parsed.messages, {
				...(input.tag && input.tag.trim() ? { extractTag: input.tag.trim() } : {}),
				stripTags: [...DEFAULT_STRIP_TAGS, ...(loadConfig(cwd).importStripTags ?? [])],
			});
			floors = cleaned.map((m) => ({ role: m.role, name: m.name, text: m.text }));
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		if (floors.length === 0) return { ok: false, error: "清洗后聊天记录为空" };
		// 2) 新会话（resolve 即 session_start 全跑完：卡/state/模板/开场白）
		await runtime.newSession();
		const sm = session.sessionManager;
		// 3) 命名（jsonl 文件名去后缀；当前会话直接 appendSessionInfo——同 renameSession 的 current 分支）
		const fileName = (input.fileName ?? "").trim();
		if (fileName) {
			const base = fileName.replace(/\.(jsonl?|txt)$/i, "").trim();
			if (base) {
				try {
					sm.appendSessionInfo(base);
				} catch {
					// 命名失败不阻断回放
				}
			}
		}
		// 4) 模板物化（可选；SQL 化 2026-08-16：建 SQLite 表，与 restHost.applyTemplate 同逻辑）
		const templateName = (input.templateName ?? "").trim();
		if (templateName) {
			const def = loadTemplate(cwd, templateName);
			if (!def) return { ok: false, error: `模板 ${templateName} 不存在` };
			const mr = await materializeTemplateToSql(def);
			if (mr.warnings.length > 0) console.warn(`[import-raw] 模板物化警告：${mr.warnings.join("；")}`);
		}
		// 5) 工作状态（与 applyStatePatch 同源）
		const file = join(stateDir, `${session.sessionId}.json`);
		const state = loadState(file);
		// 6) 回放：逐层注入 + 每 batchN 层合并场记；signal 可中断；进度经 activity 帧广播
		const batchN = Math.min(30, Math.max(1, Math.floor(Number(input.batchN) || 1)));
		const r = await replayFloors({
			floors,
			state,
			userName: names.userName,
			charName: names.charName,
			batchN,
			sideText: backfillSideText,
			appendMessage: (role, text) => {
				sm.appendMessage({ role, content: [{ type: "text", text }], timestamp: Date.now() });
			},
			save: () => {
				saveState(file, state); // fs.watch 自动广播 state 帧
				syncStoryStateFromDisk();
			},
			signal: input.signal,
			onProgress: (current, total, stage, scribeCalls) =>
				broadcast({
					type: "activity",
					activity: {
						kind: "note",
						name: "import-raw",
						detail: JSON.stringify({ current, total, stage, scribeCalls }),
					},
				}),
		});
		if (!r.ok) {
			// 中断/失败：已注入楼层保留——flush + 对齐内存消息 + 全量重放，让前端可见已回放部分
			try {
				sm.flush();
				session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
			} catch {
				// 对齐失败不影响返回
			}
			resyncAll();
			return { ok: false, error: r.error, aborted: r.aborted };
		}
		// 6.5) 逐表回填：已停用（SQL 化 2026-08-16）——旧 table-backfill 通道写
		// state.tables（剧情侧不可见）。SQL 化后每拍场记代理按各表【维护规则】自主
		// 查/写 SQLite 表，导入回放后的表维护由后续拍次自然完成。
		// （旧实现：auto 表数 > tableBackfillThreshold 时逐表 LLM 提取回填。）
		// 7) 收尾：flush + 对齐 agent 内存消息 + 全量重放（前端会话列表/消息刷新）
		sm.flush();
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		resyncAll();
		return { ok: true, floors: r.floors, scribeCalls: r.scribeCalls };
	},
	/** 世界状态只读：与 storyBridge.worldState() 同源（currentState：树快照优先，磁盘缓存兜底） */
	worldState() {
		try {
			return currentState();
		} catch {
			return null;
		}
	},
	/** 手动触发生图管线并嵌入当前分支最新剧情消息（配图按钮；Q15 简化通道——
	 *  runPipeline + patches 应用到最新叙事条目 → editEntryViaStoryChannel（rp-edited-reply）。
	 *  anchor（选填）：用户指定的正文短原文片段——第一张图挂接位置用它（LWB anchor 设计）。
	 *  entryId（2026-08-14 起配图按钮回传）：点击楼层的会话树条目 id——非最新叙事层
	 *  生图前明确拒绝（用户裁决），防止 branchCommit 钉回旧层切断后续楼层。 */
	async manualPipelineRun(text: string, anchor?: string, entryId?: string) {
		try {
			console.log(`[draw-pipeline] 手动配图触发（text 前 40 字：${text.slice(0, 40).replace(/\s+/g, " ")}${anchor ? `；anchor=${anchor.slice(0, 20)}` : ""}${entryId ? `；entryId=${entryId.slice(0, 8)}` : ""}）`);
			const { runPipeline } = await import("../src/draw-plugins/draw-pipeline/pipeline.ts");
			const { defaultPipelineDeps } = await import("../src/draw-plugins/draw-pipeline/index.ts");
			// 嵌入目标 = 当前分支最后一个叙事条目（assistant 回复 + rp-edited-reply 改稿覆盖）。
			// 2026-08-14 事故修复：原扫描只认 message/assistant，改稿楼层被跳过 → 目标回跳到
			// 更早楼层，branchCommit 钉回旧层把后续楼层切出分支视图（数据仍在树内可恢复）。
			const branch = session.sessionManager.getBranch() as Array<{
				id: string;
				type?: string;
				customType?: string;
				message?: { role?: string; content?: unknown };
				content?: unknown;
			}>;
			const resolved = resolveIllustrateTarget(branch, entryId?.trim() || undefined);
			if (!resolved.ok) return { ok: false, error: resolved.error };
			const targetId = resolved.entryId;
			// 目标之后不得有叙事性条目（新回合 user 消息 / 后续回复 / 改稿覆盖）——钉回会切楼层；
			// rp-state/model_change 等元数据允许（钉回后由旁路重记账再生成）。生图前 fail-fast。
			const obstruction = illustrateTargetObstruction(branch, targetId);
			if (obstruction) {
				const reason =
					obstruction === "user"
						? "该楼层之后已有新回合消息，配图放弃——请等本轮回复完成后再配图"
						: obstruction === "custom_message"
							? "该楼层之后已有改稿覆盖等其他楼层，配图仅支持最新叙事层"
							: "该楼层之后已有更新的回复，配图放弃";
				return { ok: false, error: reason };
			}
			// 当前显示全文：优先取该消息后的 rp-edited-reply 覆盖（含旧占位符），
			// 否则原始 content——二次配图不丢旧图（旧占位符只存在覆盖条目里）
			const entryText = currentDisplayTextOf(branch, targetId);
			if (!entryText.trim()) return { ok: false, error: "暂无剧情消息可嵌入" };
			// 手动触发用独立 entryId（manual-{ts}）——不与 auto 管线（onTurnEnd 用消息 entryId）
			// 共享 processedEntries 去重：auto 已处理过的消息，用户仍可手动再配图
			const result = await runPipeline(cwd, {
				entryId: `manual-${Date.now()}`,
				chatId: session.sessionId,
				messageText: text,
				// 用户锚点：第一张图挂接位置（LWB anchor 设计；缺省全按 LLM 规划）
				...(anchor && anchor.trim() ? { userAnchor: anchor.trim() } : {}),
				// 手动触发：绕过 auto 开关与角色白名单（用户显式要求配图），但沿用配置的
				// llm / maxImages / maxCharactersPerImage（与 auto 管线同源，规划模型一致）
				settings: (() => {
					const ps = (loadConfig(cwd).plugins?.["draw-pipeline"]?.settings ?? {}) as Record<string, unknown>;
					return {
						auto: true,
						characters: [],
						minIntervalMs: 0,
						maxImages: typeof ps.maxImages === "number" && ps.maxImages >= 1 ? Math.round(ps.maxImages) : 2,
						maxCharactersPerImage:
							typeof ps.maxCharactersPerImage === "number" && ps.maxCharactersPerImage >= 1
								? Math.round(ps.maxCharactersPerImage)
								: 3,
						...(ps.llm && typeof ps.llm === "object"
							? { llm: ps.llm as { provider?: string; model?: string } }
							: {}),
					};
				})(),
				deps: defaultPipelineDeps(cwd),
			});
			// 嵌入：patches 依次应用到最新叙事条目全文 → storyEdit 通道（rp-edited-reply）
			let embedded = false;
			if (result.ran && result.patches.length > 0 && targetId) {
				let newText = entryText;
				for (const patch of result.patches) newText = applyDraftOpToText(newText, patch);
				const r = await editEntryViaStoryChannel(targetId, newText);
				embedded = r.ok;
			}
			// ran/reason 透传给前端（HTTP 返回即管线执行完毕，非「已提交」）
			if (!result.ran) {
				console.log(`[draw-pipeline] 手动配图跳过：${result.reason ?? "未知原因"}`);
			} else {
				if (result.warnings.length > 0) {
					for (const w of result.warnings) console.log(`[draw-pipeline] 手动配图警告：${w}`);
				}
				console.log(
					`[draw-pipeline] 手动配图完成：slots=${result.slots.length} embedded=${embedded} patches=${result.patches.length}`,
				);
			}
			return { ok: true, ran: result.ran, reason: result.reason, slots: result.slots, warnings: result.warnings, embedded };
		} catch (e) {
			console.log(`[draw-pipeline] 手动配图异常：${e instanceof Error ? e.message : String(e)}`);
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	},
	/**
	 * 从当前分支全部消息正文剥离指定 slotId 的 [image:slotId] 占位符并保存（删除所有图时用）：
	 * 逐条 extractEntryText → 独立成段的占位符连周围空白一起清（\n 收拢），内联残留清空 →
	 * 有改动的经 editEntryViaStoryChannel（rp-edited-reply 通道）保存（skipScribe：占位符非叙事内容，
	 * 2026-08-10 用户裁决删除图片不刷新场记）。
	 * editEntryViaStoryChannel 对「目标之后已有更新角色回复」会失败（只清当前分支可安全编辑的），
	 * 失败原因记入 errors 继续，不 console 刷屏。
	 */
	async stripStoryPlaceholders(slotIds: string[]) {
		const ids = [...new Set((slotIds ?? []).filter((s) => typeof s === "string" && s.trim()))];
		const errors: string[] = [];
		let stripped = 0;
		if (ids.length === 0) return { stripped, errors: errors.length ? errors : undefined };
		const branch = session.sessionManager.getBranch() as Array<{
			id?: string;
			type?: string;
			message?: { role?: string; content?: unknown };
			customType?: string;
			content?: unknown;
		}>;
		for (const entry of branch) {
			const entryId = entry.id;
			if (!entryId) continue;
			// 取文本：message 条目 content 在 entry.message.content；custom_message（rp-edited-reply 等）
			// content 在 entry.content（同 branchMessages L527-539 结构）；其余类型无正文跳过
			const content = entry.type === "custom_message" ? entry.content : entry.type === "message" ? entry.message?.content : undefined;
			if (content === undefined) continue;
			const text = extractEntryText(content);
			if (!text) continue;
			let newText = text;
			for (const slotId of ids) {
				const placeholder = `[image:${slotId}]`;
				// 防注入：slotId 来自 REST 请求体，构造正则前转义正则特殊字符
				const esc = slotId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				// 独立成段的占位符：连同其前后 0-2 个换行与周围空白一起清掉（换行收拢为单个 \n）
				newText = newText.replace(new RegExp(`\\n{0,2}\\s*\\[image:${esc}\\]\\s*`, "g"), "\n");
				// 内联残留（段落中间直接嵌的）：精确清空
				newText = newText.split(placeholder).join("");
			}
			if (newText === text) continue;
			// 2026-08-10 用户裁决：图片占位符不属于叙事内容，删除图片不刷新场记（跳过重记账模型调用）
			const r = await editEntryViaStoryChannel(entryId, newText, { skipScribe: true });
			if (r.ok) stripped++;
			else errors.push(r.error ?? `条目 ${entryId} 保存失败`);
		}
		return { stripped, ...(errors.length > 0 ? { errors } : {}) };
	},
	// ---- 世界线视图 / 软删除 / 线名 ----
	worldlineView() {
		const sm = session.sessionManager;
		const sid = session.sessionId;
		const meta = loadWorldlineMeta(metaPath(cwd, sid));
		const entries: TreeEntryLite[] = sm.getEntries().map((e) => ({
			id: e.id,
			parentId: e.parentId,
			type: e.type,
			...("customType" in e && typeof (e as { customType?: string }).customType === "string"
				? { customType: (e as { customType: string }).customType }
				: {}),
			...("data" in e ? { data: (e as { data?: unknown }).data } : {}),
			...(typeof e.timestamp === "string" ? { timestamp: e.timestamp } : {}),
		}));
		const saves = extractSaves(entries, meta);
		const leafId = sm.getLeafId();
		const { branchIdsFromLeaf } = buildAncestryIndex(entries);
		const view = buildWorldlineView(saves, meta, branchIdsFromLeaf(leafId), leafId);
		view.currentLeafHasUnsavedStory = hasUnsavedStoryAfterSave(entries, leafId);
		return view;
	},
	deleteWorldlineSave(saveId) {
		const file = metaPath(cwd, session.sessionId);
		const meta = softDeleteSave(loadWorldlineMeta(file), saveId);
		saveWorldlineMeta(file, meta);
		broadcast({ type: "notify", level: "info", text: "已删除存档节点（软删除，会话树原文保留）" });
	},
	renameWorldline(worldlineId, name) {
		const file = metaPath(cwd, session.sessionId);
		const meta = renameWorldlineMeta(loadWorldlineMeta(file), worldlineId, name);
		saveWorldlineMeta(file, meta);
		broadcast({ type: "notify", level: "info", text: `世界线已改名「${name.trim()}」` });
	},
	// ---- 会话管理（PLAN-PANELS §2.1）：面板的重命名/删除/导出/全文搜索 ----
	sessions: () => sessionInfos(),
	async renameSession(path, name) {
		await assertListedSession(path);
		const clean = name.replace(/[\r\n]+/g, " ").trim();
		if (!clean) throw new Error("名字不能为空");
		if (session.sessionFile === path) {
			session.sessionManager.appendSessionInfo(clean);
			return;
		}
		// 离线会话：按 pi session_info 条目格式追加一行（parentId=文件最后一条的 id，等效 leaf）
		const lines = readFileSync(path, "utf8").split(/\r?\n/);
		let parentId: string | null = null;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const e = JSON.parse(line) as { id?: unknown };
				if (typeof e.id === "string") {
					parentId = e.id;
					break;
				}
			} catch {
				// 半行跳过
			}
		}
		const entry = {
			type: "session_info",
			id: randomBytes(4).toString("hex"),
			parentId,
			timestamp: new Date().toISOString(),
			name: clean,
		};
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
	},
	async deleteSession(path) {
		await assertListedSession(path);
		if (session.sessionFile === path) throw new Error("不能删除当前打开的会话（先切到其他会话再删）");
		unlinkSync(path);
		cardCache.delete(path);
		previewCache.delete(path);
	},
	// 删卡「相关数据」用：删除绑定某张卡的全部会话文件（rp-card 标记匹配）。
	// 调用方须保证当前打开的会话已不属于该卡（删当前卡先切走再调本方法）。
	async deleteCardSessions(cardRel) {
		const all = await SessionManager.list(cwd);
		let n = 0;
		for (const s of all) {
			if (isSameSessionPath(s.path, session.sessionFile)) continue;
			const mtime = s.modified instanceof Date ? s.modified.getTime() : Number(s.modified) || 0;
			const info = readSessionCard(s.path, mtime);
			if (!info || !sameCardPath(info.card, cardRel, cwd)) continue;
			try {
				unlinkSync(s.path);
				cardCache.delete(s.path);
				previewCache.delete(s.path);
				n += 1;
			} catch {
				// 单个文件删不掉（占用等）不挡整体
			}
		}
		if (n > 0) broadcast(await listSessions());
		return n;
	},
	async readSessionFile(path) {
		await assertListedSession(path);
		return readFileSync(path, "utf8");
	},
	// 全文搜索（借鉴 ST：搜会话内容而非只搜标题）；只搜 user/assistant 正文，注入素材不算命中
	async searchSessions(q) {
		const needle = q.trim().toLowerCase();
		if (!needle) return [];
		const out: Array<{
			path: string;
			name?: string;
			firstMessage: string;
			modified: number;
			messageCount: number;
			snippet: string;
			current: boolean;
		}> = [];
		for (const s of await sessionInfos()) {
			try {
				if (statSync(s.path).size > 20 * 1024 * 1024) continue; // 异常大文件跳过
				let snippet = "";
				for (const line of readFileSync(s.path, "utf8").split(/\r?\n/)) {
					if (!line.toLowerCase().includes(needle)) continue;
					try {
						const t = entryMsgText(JSON.parse(line));
						if (!t) continue;
						const flat = t.replace(/\s+/g, " ");
						const idx = flat.toLowerCase().indexOf(needle);
						if (idx < 0) continue;
						const start = Math.max(0, idx - 40);
						snippet = `${start > 0 ? "…" : ""}${flat.slice(start, idx + needle.length + 60)}…`;
						break;
					} catch {
						// 非 JSON 行跳过
					}
				}
				if (snippet) {
					out.push({
						path: s.path,
						...(s.name ? { name: s.name } : {}),
						firstMessage: s.firstMessage,
						modified: s.modified,
						messageCount: s.messageCount,
						snippet,
						current: s.current,
					});
				}
				if (out.length >= 20) break;
			} catch {
				// 单个会话读取失败不影响其余
			}
		}
		return out;
	},
	notify: (level, text) => broadcast({ type: "notify", level, text }),
	async ttsSpeak(text, caption) {
		const cfg = loadTtsConfig();
		if (!cfg) throw new Error(ttsConfigHint());
		const { buffer, ext } = await synthesizeSpeech(cfg, text);
		const saved = saveAudioBuffer(cwd, buffer, ext);
		const cap = (caption ?? text).trim().slice(0, 80);
		// 写入会话树为可展示 custom（刷新可回放）；短标记进 LLM 上下文可接受
		session.sessionManager.appendMessage({
			role: "custom",
			customType: "rp-audio",
			content: cap ? `〔配音〕${cap}` : "〔配音〕",
			display: true,
			details: { rpAudio: { src: saved.src, ...(cap ? { caption: cap } : {}) } },
			timestamp: Date.now(),
		} as never);
		const wireMsg = {
			channel: "audio" as const,
			text: cap,
			src: saved.src,
		};
		broadcast({ type: "message", message: wireMsg });
		return { src: saved.src, bytes: saved.bytes };
	},
	updateCheckNow: () => runUpdateCheck(true),
	updateDownload: (mirror) => startUpdateDownload(mirror),
	updateDiscard: () => {
		discardPendingUpdate(cwd);
		updateState = { phase: "none", currentVersion: APP_VERSION };
		pushUpdate();
	},
	updateRestart: () => {
		// 启动脚本循环重拉（LIYUAN_SUPERVISED=1 时 exit 87 = 请求重启）；
		// 直跑 node 的开发场景没有监护，退了就是退了（下次手动启动时应用）。
		console.log("[liyuan] 收到重启应用更新请求，退出进程…");
		setTimeout(() => process.exit(87), 300);
	},
	/** 向量记忆：绑定当前角色卡 + 当前对话会话 */
	memoryScope: () => ({
		sessionId: session.sessionId,
		card: cardPath || undefined,
	}),
};

// 启动时：liyuan.agent.json → models.json，重绑模型 + 应用思考档（配置 → 当前生效）
try {
	const loaded = loadAgentConfig(cwd);
	if (loaded.exists && Object.keys(loaded.config.providers).length > 0) {
		const cfg = normalizeAgentConfig(loaded.config);
		syncAgentConfigToRuntime(cwd, getAgentDir(), cfg);
		const cur = session.model;
		if (cur) {
			const next = session.modelRegistry.find(cur.provider, cur.id);
			if (next) await session.setModel(next);
			const p = cfg.providers[cur.provider];
			const entry = Array.isArray(p?.models) ? p.models.find((m) => String(m.id) === cur.id) : undefined;
			const per =
				typeof entry?.thinkingLevel === "string" && entry.thinkingLevel.trim()
					? entry.thinkingLevel.trim()
					: "";
			const def =
				typeof cfg.defaultThinkingLevel === "string" && cfg.defaultThinkingLevel.trim()
					? cfg.defaultThinkingLevel.trim()
					: "";
			const think = per || def;
			if (think) {
				try {
					session.setThinkingLevel(think as never);
				} catch {
					/* 档位名不支持时忽略 */
				}
			}
		}
		console.log("[liyuan] 已从 liyuan.agent.json 同步 models.json 与思考档");
	}
	// 配置归一（2026-08-15）：无论当前配置是否有 providers，都注册配置仓库全部档案的
	// 渠道——模型列表（/api/models allModels）显示用户自己的渠道，未启用的档案渠道也能选
	registerUserProviders();
	session.modelRegistry.refresh();
} catch (err) {
	console.error(`[liyuan] 启动同步 agent 配置失败：${err instanceof Error ? err.message : String(err)}`);
}

// ---------- 助手会话（右栏）：同进程第二 pi 会话（server/assistant.ts 托管） ----------
//
// 剧情会话与助手会话彻底分治：独立会话树（.liyuan-assistant/）、独立扩展集、独立模型。
// 这里只做三件事：提供剧情桥（只读面 + 白名单写）、把助手事件翻成 assistant_* 帧、
// 托管生命周期。启动失败不挡剧情（面板显示不可用）。

// ---------- 剧情会话与 agent 会话托管 ----------
// 剧情会话与助手/自定义 agent 会话彻底分治：独立会话树、独立扩展集、独立模型。
// 这里只做三件事：提供剧情桥（只读面 + 白名单写）、把 agent 事件翻成 assistant_* 帧、
// 托管生命周期。启动失败不挡剧情（面板显示不可用）。
//
// 桥权限模型（DESIGN-custom-agents §4，阶段二）：storyBridgeBase 是基础实现对象，
// 经 createStoryBridge 工厂按权限裁剪成 storyBridge。内置助手/剧情侧使用全权限，
// 自定义 agent 将按各自配置（liyuan.config.json 的 agents[].bridge）另行裁剪。

const storyBridgeBase: StoryBridge = {
	storyMessages: () => session.messages as unknown[],
	snapshot: () => ({
		sessionId: session.sessionId,
		cardName: names.charName,
		userName: names.userName,
		model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
		thinkingLevel: typeof session.thinkingLevel === "string" ? session.thinkingLevel : undefined,
		contextPercent: safeStats()?.contextPercent ?? null,
		messageCount: session.messages.length,
		streaming: session.isStreaming,
	}),
	queueStoryCommand: (text) => restHost.queueCommand(text),
	worldState: () => currentState(),
	/** 表格实时清单（SQLite；assistant world_read 表格段用——旧 state.tables 快照已停用） */
	listTables: () => {
		try {
			return stage.tablesService().listTables().map((t) => ({ name: t.name, auto: t.auto, rowCount: t.rowCount }));
		} catch {
			return [];
		}
	},
	applyStatePatch: (patch) => restHost.applyStatePatch(patch),
	applyTableOp: (op) => restHost.applyTableOp(op),
	applyTemplate: (name) => restHost.applyTemplate(name),
	applyTableBackfill: (name) => restHost.applyTableBackfill(name),
	softRefreshConfig: () => restHost.softRefreshConfig(),
	/** P8：广播 hello 全量重放（regex_manage 写盘后让所有端用新显示规则重渲当前消息） */
	resyncStory: () => resyncAll(),
	listModels: () => {
		const r = restHost.listModels();
		return {
			current: r.current ? { provider: r.current.provider, id: r.current.id, name: r.current.name } : null,
			models: r.models.map((m) => ({
				provider: m.provider,
				providerName: m.providerName,
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
			})),
		};
	},
	cardName: () => names.charName,
	// 向量记忆作用域（M-D3 助手侧工具用）：与 restHost.memoryScope / 台上注入同一口径——
	// 当前剧情会话 + 当前卡**路径**（scopeId 按路径 hash，只给卡名会落到另一个空作用域）。
	memoryScope: () => ({ sessionId: session.sessionId, card: cardPath || undefined }),
	// 世界线视图（M-D5 助手侧 worldline_list 工具用）：从剧情会话树拉存档点
	worldlineView: () => restHost.worldlineView(),
	// 面板（M-D5 助手侧 panel_* 工具用）：当前剧情会话的面板读写
	storyPanels: () => ({
		load() {
			const p = loadPanels(join(artifactsDir, `${session.sessionId}.json`));
			const out: Record<string, { name: string; kind: "markdown" | "svg" | "html"; content: string; archived?: boolean }> = {};
			for (const [k, v] of Object.entries(p)) out[k] = { name: v.name, kind: v.kind, content: v.content, archived: v.archived };
			return out;
		},
		write(input) {
			const file = join(artifactsDir, `${session.sessionId}.json`);
			const panels = loadPanels(file);
			const r = writePanel(panels, input);
			if (r.ok) { savePanels(file, r.panels); syncStoryPanelsFromDisk(); }
			return r;
		},
		close(name) {
			const file = join(artifactsDir, `${session.sessionId}.json`);
			const panels = loadPanels(file);
			const r = closePanelInMap(panels, name);
			if (r.ok) { savePanels(file, r.panels); syncStoryPanelsFromDisk(); }
			return r;
		},
	}),
	writePanels: (list) => restHost.importPanels(list),
	deliverMedia: (absPath) => {
		try {
			if (!existsSync(absPath)) return { ok: false as const, error: `文件不存在：${absPath}` };
			const ext = extname(absPath).toLowerCase();
			const imageExt = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"];
			const audioExt = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"];
			const videoExt = [".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv"];
			const kind = imageExt.includes(ext) ? "image" : audioExt.includes(ext) ? "audio" : videoExt.includes(ext) ? "video" : null;
			if (!kind) return { ok: false as const, error: `不支持的媒体格式：${ext || "（无扩展名）"}` };
			const mediaDir = dir(cwd, "media");
			mkdirSync(mediaDir, { recursive: true });
			const name = `${createHash("md5").update(readFileSync(absPath)).digest("hex").slice(0, 16)}${ext}`;
			writeFileSync(join(mediaDir, name), readFileSync(absPath));
			return { ok: true as const, src: `/media/${name}`, kind };
		} catch (err) {
			return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
		}
	},
	/** 委托模式：媒体同步进中间剧情流（与 show_image 同源 wire 通道） */
	emitStoryMedia: (media) => {
		const channel = media.kind === "audio" ? "audio" : media.kind === "video" ? "video" : "image";
		broadcast({
			type: "message",
			message: {
				channel,
				text: media.caption ?? "",
				src: media.src,
			},
		});
	},
	refreshStoryMaterials: () => restHost.softRefreshConfig(),
	mountCodex: (name, on) => {
		restHost.queueCommand(`/codexmount ${on ? "mount" : "unmount"} ${name}`);
	},
	mountedCodexes: () => restHost.mountedCodexes(),
	/**
	 * 显式改稿（story_edit 工具落地，设计稿 DESIGN-story-edit §3+§4）：
	 * 用 scriptEditMessage 的 lastRoleIndex 语义定位目标回复 → sm.branch 直钉前驱 →
	 * 注入 rp-edited-reply → 经 roleplay 的 globalThis 网关旁路重记账 → resyncAll 全端刷新。
	 * 死锁注意：本方法由助手侧调用（assistant_run 期间故事侧在 waitForIdle），
	 * 绝不能经 queueStoryCommand / restHost.queueCommand 触发任何剧情侧命令。
	 */
	async storyEdit({ lastRoleIndex, text }) {
		// 场记旁路网关：roleplay 经 jiti 加载、本文件是 Node 原生 ESM，双模块 scope 下
		// 不能直接 import，照 src/assistant-gateway.ts 的惯例经 globalThis 挂载点读取。
		const scribeGate = (globalThis as typeof globalThis & {
			__liyuanScribeGateway__?: {
				waitForScribeIdle: (ms?: number) => Promise<void>;
				scribeTurnOnceExported: (userText: string, assistantText: string) => Promise<void>;
			};
		}).__liyuanScribeGateway__;
		if (!scribeGate) {
			// 扩展未装载（rp 模式未启动）时无旁路记账能力，无法保证改后账本一致
			return { ok: false, error: "场记旁路网关未就绪（roleplay 扩展未装载），无法重记账" };
		}
		try {
			// 1. 等在途场记归位——避免在途场记用改前文本覆盖新状态
			await scribeGate.waitForScribeIdle();
			// 1b. 故事侧流式守卫（照 rewind/删除/切换的防御惯例）：流式中改稿会与在途
			//     生成的叶指针竞态（流式分支不落树），直接拒绝而非静默写入
			if (session.isStreaming) {
				return { ok: false, error: "故事侧正在生成中，请等本轮生成完成后重试 story_edit" };
			}

			const branch = session.sessionManager.getBranch() as Array<{
				id: string;
				parentId?: string | null;
				type?: unknown;
				customType?: string;
				message?: { role?: unknown; content?: unknown };
			}>;
			// 2. 提交前找到目标：与 scriptEditMessage 的 targetId 解析（sm.getBranch + getBranch 语义）
			const resolved = resolveRoleEditTarget(branch, { lastRoleIndex });
			if (!resolved.ok) return { ok: false, error: resolved.error };
			// 2c. 锚点类型日志（排查用）：确认钉叶目标是稳定锚点而非 model_change 等运行时中间节点
			{
				const anchor = branch.find((e) => e.id === resolved.targetId);
				console.log(
					`[liyuan] story_edit 钉叶锚点 ${resolved.targetId.slice(0, 8)} type=${anchor?.type ?? "?"} targetIdx=${resolved.targetIdx}`,
				);
			}
			// 2b. 「仅修改最新层」校验（2026-08-12 用户决策）：story_edit 只允许改最新叙事轮——
			//     目标必须是分支最后一个叙事条目（assistant 回复或 rp-edited-reply 改稿）；
			//     否则目标回跳会改错楼层（历史事故：改稿/配图嵌到告别回复楼层）
			if (lastRoleIndex !== 0) {
				return { ok: false, error: "story_edit 仅支持修改最新层（lastRoleIndex=0）；历史楼层修改请先导航回该楼层" };
			}
			let lastNarrativeIdx = -1;
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e.type === "message" && e.message?.role === "assistant") {
					lastNarrativeIdx = i;
					break;
				}
				if (e.type === "custom_message" && e.customType === "rp-edited-reply") {
					lastNarrativeIdx = i;
					break;
				}
			}
			if (resolved.targetIdx !== lastNarrativeIdx) {
				return { ok: false, error: "story_edit 目标不在最新层，已放弃（仅支持修改最新层；目标回跳说明当前叙事结构异常，请先确认楼层）" };
			}
			// 3. sm.branch 直钉（绝不用 session.navigateTree——它对 user/assistant 目标有副作用语义，
			//    实测导致分支回退到开场白、改写丢失）；append-only：原回复保留在树里
			const beforeLeaf = session.sessionManager.getLeafId();
			{
				try {
					const beforeFloor = buildStoryFloors(session.messages as unknown[]);
					console.log(
						`[liyuan-trace] [storyEdit] BEFORE target=${lastRoleIndex} leaf=${beforeLeaf?.slice(0, 8) ?? "?"} floors=${beforeFloor.length}`,
					);
				} catch {
					// 诊断日志不阻断
				}
			}
			branchCommitToTarget(resolved.targetId);
			// 4. 注入改后全文（方案 B：编辑槽复用——同目标楼复用一条 rp-edited-reply，不新增叶；
			//    上下文钩子会把该槽转成 assistant 给 LLM，带「已改写」标记；旧值进槽 history 可回滚）
			writeEditReplySlot(session.sessionManager as never, "storyEdit", resolved.targetId, text);
			// 4b. 叶校验（2026-08-12 防御）：注入后目标前驱必须仍在分支——否则说明叶被外部移动到
			//     预期外位置（历史 bug：story_edit 改稿挂错楼层），记录告警供排查
			{
				const afterBranch = session.sessionManager.getBranch();
				if (!afterBranch.some((e) => e.id === resolved.targetId)) {
					console.error(
						`[liyuan] story_edit 叶校验失败：目标前驱 ${resolved.targetId.slice(0, 8)} 不在注入后分支（叶 ${beforeLeaf?.slice(0, 8) ?? "?"} → ${session.sessionManager.getLeafId()?.slice(0, 8) ?? "?"}）`,
					);
				}
			}

			// 4c. 排查日志（story_edit 改稿后楼层投影的诊断锚点）：改稿后 session.messages 的形状
			//     与 buildStoryFloors 的楼层结果直接影响阅读侧能否读到改稿层。此日志把注入后的
			//     message 序列（role/customType）与楼层数固化下来，便于复现「改稿后丢一层」。
			{
				try {
					const shapeOf = (m: unknown): string =>
						m && typeof m === "object"
							? (m as { customType?: unknown }).customType
								? `custom:${(m as { customType?: unknown }).customType}`
								: String((m as { role?: unknown }).role ?? "?")
							: "?";
					const msgShape = (session.messages as unknown[]).map(shapeOf).join(",");
					const afterFloor = buildStoryFloors(session.messages as unknown[]);
					// 树侧真实条目尾迹（含被切掉的楼层），与 message 序列对照
					const branchTail = (session.sessionManager.getBranch() as Array<Record<string, unknown>>)
						.slice(-6)
						.map((e) => `${String(e.type)}:${(e as { customType?: string }).customType ?? (e as { message?: { role?: string } }).message?.role ?? ""}`)
						.join("|");
					console.log(
						`[liyuan-trace] [storyEdit] target=${lastRoleIndex} leaf=${beforeLeaf?.slice(0, 8) ?? "?"}→${session.sessionManager.getLeafId()?.slice(0, 8) ?? "?"} branchTail=[${branchTail}] messages=[${msgShape}] floors=${afterFloor.length} tail=${JSON.stringify(afterFloor.slice(-4).map((f) => [f.floor, f.kind, f.text.slice(0, 24)]))}`,
					);
				} catch (err2) {
					console.error("[liyuan-trace] [storyEdit] 诊断日志失败", err2);
				}
			}

			// 5. 重记账：取被编辑轮前一条 user 消息文本 + 改后 text，经网关旁路记账。
			//    提交已把叶移到编辑后的新叙事位置（rp-edited-reply 是当前叶的一部分），
			//    roleplay 闭包内的 state/快照即在该位置写——直接调用即可，无需再导航。
			let userText = "";
			for (let i = resolved.targetIdx - 1; i >= 0; i--) {
				const e = branch[i];
				if (e.type === "message" && e.message?.role === "user") {
					userText = extractEntryText(e.message.content);
					break;
				}
			}
			if (userText.trim() && !isBackstageText(userText)) {
				// SQL 化旁路重记账（2026-08-16）：走 engine 的 runScribeTurn 全链路
				//（顶层兜底 + 表格维护代理写 SQLite），不再走旧 roleplay 网关（旧账本路径）。
				await stage.rescribeTurn(userText, text);
			}

			// 6. 内存消息对齐（2026-08-16 修复）：改稿只写了会话树（rp-edited-reply），
			//    必须重建 agent.state.messages（= session.messages，story_read/story_search
			//    的数据源），否则 story_read 仍读到改稿前楼层——工具侧停在旧楼、UI（getBranch
			//    实时读树）却已显示新楼，重启后才追平。与 /compact /rewind /scriptEditMessage
			//    改造树后重建 messages（本文件 1999/3904 行）同一模式；禁用侧边日志对照 4c。
			try {
				session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
				const syncedFloorS = buildStoryFloors(session.agent.state.messages as unknown[]);
				console.log(
					`[liyuan-trace] [storyEdit] afterMessagesSync leaf=${session.sessionManager.getLeafId()?.slice(0, 8) ?? "?"} floors=${syncedFloorS.length}`,
				);
			} catch (errSync) {
				// 对齐失败不阻断改稿；下次树导航/重启会按树重建
				console.error("[liyuan-trace] [storyEdit] 内存消息对齐失败", errSync);
			}

			// 7. 全端刷新（照 scriptEditMessage 收尾，让前端看到新叶与标记）
			resyncAll();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	},
	/**
	 * 把生图结果嵌入最近一条剧情消息正文（Q15）：
	 * createSlot 登记 slot（file 指向 cache/media 相对路径）+ buildInsertPatch 生成 rp-draft-op 补丁
	 * + 分支校验 + sendCustomMessage 写入。树上字节不改（补丁读取时生效）。
	 */
	async embedStoryImage({ src, anchor, scene, characters, characterPrompts }) {
		try {
			// 1) src 解析：/cache/xxx → .liyuan-cache/xxx（相对 cwd）；/media/xxx → .liyuan-media/xxx；绝对路径原样
			let rel: string;
			let abs: string;
			if (src.startsWith("/cache/")) {
				rel = `.liyuan-cache/${src.slice("/cache/".length)}`;
				abs = join(cwd, rel);
			} else if (src.startsWith("/media/")) {
				rel = `.liyuan-media/${src.slice("/media/".length)}`;
				abs = join(cwd, rel);
			} else {
				abs = isAbsolute(src) ? src : join(cwd, src);
				rel = src;
			}
			if (!existsSync(abs)) return { ok: false, error: `文件不存在：${abs}` };

			// 2) 嵌入目标定位（2026-08-12 加固）：默认 = 当前分支最后一条 assistant；
			//    anchor 非空且默认目标未命中 → 全树搜索含 anchor 的条目（跨分支/历史楼层）；
			//    命中条目不在当前分支 → 报错让外部修正（不静默嵌错——历史 bug：
			//    叶指针漂移后 8 张图全部嵌进错误楼层，根因即 anchor 只定插入位、不选目标）
			const branch = session.sessionManager.getBranch() as Array<{
				id?: string;
				type?: string;
				message?: { role?: string; content?: unknown };
				customType?: string;
				content?: unknown;
			}>;
			const branchIds = branch.map((e) => e.id ?? "");
			const allEntries = session.sessionManager.getEntries() as Array<{
				id: string;
				parentId?: string | null;
				type?: string;
				customType?: string;
				message?: { role?: string; content?: unknown };
				content?: unknown;
			}>;
			// 叙事条目 = assistant 回复 + rp-edited-reply 改稿覆盖（改稿也是最新叙事；
			// 2026-08-12 二次修复：原只认 message/assistant，改稿楼层被跳过 → 目标回跳、图嵌错）
			const entryById = new Map(allEntries.map((e) => [e.id, e]));
			const roundOf = (id: string): string => {
				let cur = entryById.get(id);
				while (cur) {
					if (cur.type === "message" && cur.message?.role === "user") return cur.id;
					cur = cur.parentId ? entryById.get(cur.parentId) : null;
				}
				return "";
			};
			const embedItems = allEntries
				.filter(
					(e) =>
						(e.type === "message" && e.message?.role === "assistant") ||
						(e.type === "custom_message" && e.customType === "rp-edited-reply"),
				)
				.map((e) => ({
					id: e.id,
					// 当前显示全文优先（含覆盖的占位符/改稿内容），否则原始 content
					text:
						e.type === "custom_message"
							? extractEntryText(e.content)
							: currentDisplayTextOf(branch, e.id) || extractEntryText(e.message?.content),
					roundId: roundOf(e.id),
				}));
			const resolved = resolveEmbedTarget(embedItems, branchIds, anchor);
			if (!resolved.ok) return { ok: false, error: resolved.error };
			const targetId = resolved.entryId;
			const targetText = currentDisplayTextOf(branch, targetId);
			if (!targetText.trim()) return { ok: false, error: "暂无剧情消息可嵌入" };

			// 3) createSlot：slotId = slot-<uuid>，chatId=sessionId，messageId=条目 id，file=rel
			//    params 存结构化分栏（LWB 编辑 TAG 数据源）：
			//    有 characterPrompts（调用方已解析，draw_generate 生图与分栏共用同一份）→ 直接用；
			//    否则有 characters → 经服装档案组装（过滤空 tag）；无 → 仅 scene/positive
			const slotId = `slot-${randomUUID()}`;
			let params: Record<string, unknown> = {};
			if (scene) {
				params = { scene, positive: scene };
			}
			if (characterPrompts && characterPrompts.length > 0) {
				const prompts = characterPrompts
					.map((c) => ({ name: c.name, prompt: (c.prompt ?? "").trim(), ...(c.uc ? { uc: c.uc } : {}) }))
					.filter((c) => c.prompt);
				if (prompts.length > 0) params.characterPrompts = prompts;
			} else if (characters && characters.length > 0) {
				const card = cardPath || (() => {
					try {
						return (JSON.parse(readFileSync(join(cwd, "liyuan.config.json"), "utf8")) as { card?: string }).card ?? "";
					} catch {
						return "";
					}
				})();
				if (card) {
					try {
						const r = resolveCharacterTags(cwd, card, characters, currentState());
						const characterPrompts = r.characters
							.filter((c) => c.tags.trim())
							.map((c) => ({ name: c.name, prompt: c.tags.trim() }));
						if (characterPrompts.length > 0) params.characterPrompts = characterPrompts;
					} catch {
						// 解析失败：跳过分栏（保持 scene 整段）
					}
				}
			}
			createSlot(cwd, {
				slotId,
				chatId: session.sessionId,
				messageId: targetId,
				file: rel,
				...(Object.keys(params).length > 0 ? { params } : {}),
			});

			// 4) buildInsertPatch：正文 + anchor（缺省 → append 到末尾）+ 占位符
			//    定位失败（助手摘录的 anchor 与正文有出入/正文已变）→ 回退 append 末尾而
			//    不是整体失败——保证图至少嵌入正文
			const placeholder = `[image:${slotId}]`;
			const patchRes = buildInsertPatch(targetText, anchor, placeholder);
			const patch = patchRes.ok ? patchRes.patch : { append: placeholder };

			// 5) 应用补丁得新全文（占位符进正文——正文可修改，红线 2026-08-08 已移除）
			const newText = applyDraftOpToText(targetText, patch);

			// 6) 经 storyEdit 通道（rp-edited-reply 分支注入）写入：
			//    改后全文作为最新叙事版本（带「已改写」标记、原文旁支可回滚），
			//    渲染走 RichContent（无 rp-draft-op 补丁的 timeline 快照问题）。
			//    skipScribe（2026-08-16 用户裁决）：占位符非叙事内容，插画不改变剧情——
			//    不触发重记账，账本/表格继承原回复（润色才需要重算，见 storyEdit）。
			const r = await editEntryViaStoryChannel(targetId, newText, { skipScribe: true });
			if (!r.ok) return { ok: false, error: r.error };
			// 6b. 叶校验（2026-08-12 防御）：注入后目标必须仍在分支——否则说明叶被外部移动到
			//     预期外位置（历史 bug：改稿/嵌入挂错楼层），记录告警供排查
			{
				const afterBranch = session.sessionManager.getBranch();
				if (!afterBranch.some((e) => e.id === targetId)) {
					console.error(
						`[liyuan] embedStoryImage 叶校验失败：目标 ${targetId.slice(0, 8)} 不在注入后分支（叶=${session.sessionManager.getLeafId()?.slice(0, 8) ?? "?"}）`,
					);
				}
			}
			return { ok: true, slotId };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	},
};

/** 应用占位符补丁到正文：{append} → 末尾追加；{old,new} → 定点替换 */
function applyDraftOpToText(text: string, patch: Record<string, unknown>): string {
	if (typeof patch.append === "string" && patch.append.trim()) {
		return `${text}\n\n${patch.append}`;
	}
	if (typeof patch.old === "string" && patch.old && typeof patch.new === "string") {
		return text.includes(patch.old) ? text.replace(patch.old, patch.new) : text;
	}
	return text;
}

/**
 * 经 storyEdit 通道把改后全文注入剧情（Q15 简化方案，2026-08-08 用户定调：
 * 生图得 id → 改正文 tool 写入 → 渲染正则替换，三步即可，不走 rp-draft-op 补丁）：
 * 场记网关等待 → 目标条目仍在分支且其后无更新的角色回复（否则放弃）→
 * branchCommitToTarget 钉回 → sendCustomMessage rp-edited-reply → 旁路重记账 → resyncAll。
 */
async function editEntryViaStoryChannel(
	entryId: string,
	newText: string,
	opts?: { skipScribe?: boolean },
): Promise<{ ok: boolean; error?: string }> {
	const scribeGate = (globalThis as typeof globalThis & {
		__liyuanScribeGateway__?: {
			waitForScribeIdle: (ms?: number) => Promise<void>;
			scribeTurnOnceExported: (userText: string, assistantText: string) => Promise<void>;
		};
	}).__liyuanScribeGateway__;
	if (!scribeGate) {
		return { ok: false, error: "场记旁路网关未就绪（roleplay 扩展未装载），无法重记账" };
	}
	try {
		await scribeGate.waitForScribeIdle();
		const branch = session.sessionManager.getBranch() as Array<{
			id: string;
			type?: string;
			customType?: string;
			message?: { role?: string; content?: unknown };
		}>;
		const idx = branch.findIndex((e) => e.id === entryId);
		if (idx === -1) return { ok: false, error: "目标消息已离开当前分支（用户已进入新回合），嵌入放弃" };
		// 目标之后不得有叙事性条目——message（任意 role：新回合 user 消息/后续回复）或
		// custom_message（改稿覆盖等）在钉回时都会被切出当前分支视图
		// （2026-08-14 事故：原只查「之后无 assistant」，放行了「目标后挂 user 消息 +
		// 改稿覆盖」的切割）。元数据条目（rp-state/model_change 等）允许，钉回后旁路重记账再生成。
		const obstruction = illustrateTargetObstruction(branch, entryId);
		if (obstruction) {
			const reason =
				obstruction === "user"
					? "目标楼层之后已有新回合消息（用户已进入新回合），嵌入放弃——请等本轮回复完成后再配图"
					: obstruction === "custom_message"
						? "目标消息之后已有改稿覆盖等其他楼层，嵌入放弃——配图仅支持最新叙事层"
						: "目标消息之后已有更新的角色回复，嵌入放弃";
			return { ok: false, error: reason };
		}
		branchCommitToTarget(entryId);
		// 编辑正文（方案 B：槽复用——同目标楼复用一条 rp-edited-reply，不新增叶；旧值进槽 history）
		writeEditReplySlot(session.sessionManager as never, "storyChannel", entryId, newText);
		// 旁路重记账（与 storyEdit 同款）：取目标前一条 user 文本 + 改后全文
		let userText = "";
		for (let i = idx - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "message" && e.message?.role === "user") {
				userText = extractEntryText(e.message.content);
				break;
			}
		}
		if (userText.trim() && !isBackstageText(userText)) {
			// skipScribe（如删除图片占位符）：正文改动不影响叙事/场记状态，跳过重记账模型调用
			if (!opts?.skipScribe) {
				await scribeGate.scribeTurnOnceExported(userText, newText);
			}
		}
		resyncAll();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// 桥工厂：基础实现按权限裁剪出最终桥。内置助手/剧情侧用全权限（行为与改前完全一致）；
// 自定义 agent 将按各自配置裁剪（每方法未授权时抛错，工具执行层转成可见「无权限」）。
const storyBridge: StoryBridge = createStoryBridge(storyBridgeBase, FULL_BRIDGE_PERMISSIONS);

// 多 agent host 托管（DESIGN-custom-agents P3）：key="assistant" 是内置助手（原单 host 变量），
// 自定义 agent 按配置 id 入表；换卡/换故事/换会话时全部对齐当前剧情会话。
const agentHosts = new Map<string, AssistantHost>();

/**
 * agentId → JSON.stringify(该 agent 配置)：agents 热重建（reloadAgents）的签名比对基准。
 * 启动时初始化（内置助手与自定义 agent 创建处），reloadAgents 每次生效后更新。
 * 内置助手（assistant）不在 agents 配置段、不参与热重建，仅占位标记「已初始化」。
 */
const lastAgentConfigs = new Map<string, string>();

/** 某 agent 的 hello 帧（内置助手 = 原 assistant_hello 语义；自定义 agent 同构复用同一帧格式） */
const agentHelloFrame = (host: AssistantHost | null | undefined): ServerFrame => ({
	type: "assistant_hello",
	messages: host ? toAssistantHistory(host.messages()) : [],
	busy: host?.isStreaming() ?? false,
	model: host?.modelInfo() ?? null,
	follow: host?.follows() ?? true,
	...(host?.sessionPath() ? { sessionPath: host.sessionPath() } : {}),
});

/** 内置助手面板 hello（兼容现有调用点） */
const assistantHelloFrame = (): ServerFrame => agentHelloFrame(agentHosts.get("assistant"));

/** 取帧里的 agentId（部分 wire 帧未声明该可选字段，经类型断言容错读取）；缺省 "assistant" */
const agentIdOf = (frame: ClientFrame): string => {
	const v = (frame as { agentId?: unknown }).agentId;
	return typeof v === "string" && v.trim() ? v.trim() : "assistant";
};

/** 未知/未启用 agent 的错误帧（照现有 notify 错误风格） */
const agentUnavailableFrame = (agentId: string): ServerFrame => ({
	type: "notify",
	level: "warning",
	text: `agent「${agentId}」不存在或未启动`,
});

/** 全部 agent host 对齐当前剧情会话（自定义 agent 跟随剧情会话；switchToStory 幂等，"same" 不炸） */
const syncAllAgentStories = async (): Promise<void> => {
	for (const [id, host] of agentHosts) {
		try {
			await host.switchToStory(session.sessionId);
		} catch (err) {
			console.error(
				`[liyuan] ${id === "assistant" ? "助手" : `agent「${id}」`}对齐剧情会话失败：${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
};

/** 生成按 name 路由的委托实现（网关注册表保证 name 已注册，这里兜底用 host 执行 runTask） */
const buildAgentRunner = (agentId: string): AssistantRunner => async (req) => {
	// 统一调试接口：右栏助手/自定义 agent 请求按 config.debugLog 现读同步通道（开发者模式可关打印）
	syncDebugConfig(loadConfig(cwd));
	const host = agentHosts.get(agentId);
	const label = agentId === "assistant" ? "助手" : `agent「${agentId}」`;
	if (!host) {
		return {
			ok: false,
			summary: `${label}不可用。`,
			media: [],
			panelsWritten: [],
			error: "no_host",
		};
	}
	const task = req.task.trim();
	if (!task) {
		return { ok: false, summary: "任务为空。", media: [], panelsWritten: [], error: "empty" };
	}
	const modeHint =
		req.mode && req.mode !== "auto"
			? `【任务类型：${req.mode === "ops" ? "系统/API/办事" : req.mode === "author" ? "作者维护（面板/设定/账本）" : "诊断调优"}】\n`
			: "";
	const body = `${modeHint}${task}`;
	// 右栏可见：用户委托条
	broadcast({ type: "assistant_message", message: { role: "user", text: `〔剧情委托〕${task}` } });
	try {
		if (req.signal?.aborted) {
			return {
				ok: false,
				summary: "已取消。",
				media: [],
				panelsWritten: [],
				abandoned: true,
				error: "aborted",
			};
		}
		const onAbort = () => {
			void host.abort();
		};
		req.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// 等到 return_answer / 放弃 / 兜底交回（非仅等 agent_end 摘最后一句）
			const ret = await host.runTask(body);
			return {
				ok: ret.ok !== false && !ret.abandoned,
				summary: ret.summary,
				media: [],
				panelsWritten: [],
				abandoned: ret.abandoned,
				viaReturnTool: ret.viaReturnTool,
				...(ret.ok === false || ret.abandoned ? { error: ret.abandoned ? "abandoned" : "failed" } : {}),
			};
		} finally {
			req.signal?.removeEventListener("abort", onAbort);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			summary: `${label}执行失败：${msg}`,
			media: [],
			panelsWritten: [],
			error: msg,
		};
	}
};

/** 助手会话事件 → assistant_* wire 帧（与剧情订阅同构，无 swipe/面板等剧情专属面） */
const onAssistantEvent = (event: unknown) => {
	const ev = event as {
		type?: string;
		willRetry?: boolean;
		assistantMessageEvent?: { type?: string; delta?: string };
		message?: { role?: string };
		toolName?: string;
		args?: unknown;
		result?: unknown;
		isError?: boolean;
		attempt?: number;
		maxAttempts?: number;
	};
	switch (ev.type) {
		case "agent_start":
			broadcast({ type: "assistant_state", state: "start" });
			break;
		case "agent_end":
			if (!ev.willRetry) broadcast({ type: "assistant_state", state: "end" });
			break;
		case "message_update": {
			const e = ev.assistantMessageEvent;
			if (e?.type === "text_delta") broadcast({ type: "assistant_delta", kind: "text", delta: e.delta ?? "" });
			else if (e?.type === "thinking_delta")
				broadcast({ type: "assistant_delta", kind: "thinking", delta: e.delta ?? "" });
			break;
		}
		case "message_end": {
			// user 消息在受理时已回显；这里翻助手侧消息 + show_media 的媒体交付
			if (ev.message?.role === "assistant") {
				const list = toAssistantHistory([ev.message]);
				if (list.length) broadcast({ type: "assistant_message", message: list[0] });
			} else if (ev.message?.role === "toolResult") {
				const media = assistantMediaOfToolResult(ev.message as never);
				if (media) broadcast({ type: "assistant_message", message: media });
			}
			break;
		}
		case "tool_execution_start": {
			const detail = toolStartDetail(ev.toolName ?? "", ev.args);
			broadcast({ type: "assistant_activity", activity: { kind: "tool_start", name: ev.toolName ?? "", detail } });
			break;
		}
		case "tool_execution_end":
			broadcast({
				type: "assistant_activity",
				activity: {
					kind: "tool_end",
					name: ev.toolName ?? "",
					detail: summarizeToolResult(ev.result),
					isError: ev.isError === true,
				},
			});
			break;
		case "auto_retry_start":
			// 调试增强：助手 LLM 请求失败触发自动重试——统一接口打 ERROR
			debug.error("assistant", "助手模型请求失败，自动重试", {
				attempt: ev.attempt,
				maxAttempts: ev.maxAttempts,
				errorMessage: (ev as { errorMessage?: string }).errorMessage,
			});
			broadcast({
				type: "notify",
				level: "warning",
				// 事件载荷带 errorMessage（agent-session auto_retry_start）——显示出来便于定位失败原因
				text: `助手模型请求失败，自动重试 ${ev.attempt}/${ev.maxAttempts}…（${(ev as { errorMessage?: string }).errorMessage ?? "未知错误"}）`,
			});
			break;
		default:
			break;
	}
};

/** 用户对某 agent 发话（面板输入框 / 主输入框场外标记改道共用；调用方已按 agentId 路由到 host） */
const promptAssistant = async (host: AssistantHost, text: string) => {
	broadcast({ type: "assistant_message", message: { role: "user", text } });
	await host.prompt(text);
};

// 生图管线规划 LLM（draw-pipeline）：注册旁路实现，与场记/压缩同款 streamSimple 通道。
// 模型解析优先级：settings.llm（draw 局部配置）→ sideModel（全局旁挂模型）→ 剧情模型（session.model）。
// systemPrompt 最前拼破甲（sideJailbreak，2026-08-10 用户裁决）。
registerPlannerCaller(async (prompt, llm) => {
	// 统一调试接口：生图规划旁路按 config.debugLog 现读同步通道（开发者模式可关打印）
	syncDebugConfig(loadConfig(cwd));
	const model = (() => {
		if (llm?.provider && llm?.model) {
			const m = session.modelRegistry.find(llm.provider, llm.model);
			if (m) return m as never;
		}
		return resolveSideModel(loadConfig(cwd), session.model as never);
	})();
	if (!model) throw new Error("尚无可用模型（未配置剧情模型）");
	// 必须 await：getApiKeyAndHeaders 返回 Promise<ResolvedRequestAuth>，缺 await 会解构到
	// Promise 实例 → apiKey/headers 恒为 undefined → 底层报 "No API key for provider"（配图规划空转根因）
	const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error ?? `无法解析 ${String((model as { provider?: string }).provider)} 的 API key`);
	const { apiKey, headers } = auth;
	const s = streamSimple(
		model,
		{
			// 破甲最前 → 规划提示词 → router 收敛尾注（DESIGN-router §3 B 类）
			systemPrompt: sideJailbreakPrefix() + prompt.system + routerConvergeTailOf(),
			messages: [{ role: "user", content: [{ type: "text", text: prompt.user }], timestamp: Date.now() }],
		},
		{
			apiKey,
			headers,
			// 旁路参数统一（2026-08-10 用户裁决）：思考 medium + 大预算
			maxTokens: 81920,
			reasoning: "medium",
		},
	);
	let final: AssistantMsgLike | null = null;
	for await (const e of s) {
		if (e.type === "done") final = e.message ?? null;
		else if (e.type === "error") {
			const msg = e.error?.errorMessage || `stopReason=${e.error?.stopReason ?? "?"}`;
			// 调试增强：生图规划旁路返回 provider 错误——统一接口打 ERROR
			debug.error("side-text", "生图规划旁路 LLM 返回 provider 错误", {
				model: String((model as { id?: string }).id ?? ""),
				error: msg,
			});
			throw new Error(msg);
		}
	}
	if (!final) {
		debug.error("side-text", "生图规划旁路 LLM 流未产出最终消息", { model: String((model as { id?: string }).id ?? "") });
		throw new Error("规划 LLM 流未产出最终消息");
	}
	const text = (final.content ?? [])
		.filter((p) => p?.type === "text")
		.map((p) => String((p as { text?: string }).text ?? ""))
		.join("");
	if (!text.trim()) {
		debug.warning("side-text", "生图规划旁路 LLM 最终消息无文本", { model: String((model as { id?: string }).id ?? "") });
		throw new Error("规划 LLM 最终消息无文本");
	}
	return text;
});

// 旁路 LLM 的旁挂模型与破甲解析（2026-08-10，sideModel/sideJailbreak 配置）：
// - 旁挂模型：config.sideModel 存在且 modelRegistry 找得到 → 用之；否则回退剧情模型（session.model）。
// - 破甲提示词：config.sideJailbreak 非空时固定拼接在 systemPrompt 最前（绕过模型限制用，用户主动配置）。
// backfillSideText / registerPlannerCaller 共用；loadConfig 每次读盘 → 配置改动即时生效。

/** 破甲前缀：非空时返回「破甲文本 + 空行」，供拼在旁路 systemPrompt 最前 */
function sideJailbreakPrefix(): string {
	const jb = loadConfig(cwd).sideJailbreak?.trim();
	return jb ? `${jb}\n\n` : "";
}

/**
 * 旁挂模型解析（DESIGN-router §3 B 类旁路收敛）：config.sideModel → 剧情模型兜底。
 * 取代 registerPlannerCaller / backfillSideText / StageEngine.getSideModel 各自拷贝。
 */
function resolveSideModel(config: RpConfig, fallback: unknown): unknown {
	const sm = config.sideModel;
	if (sm?.provider && sm?.id) {
		const m = session.modelRegistry.find(sm.provider, sm.id);
		if (m) return m;
		console.warn(`[side-model] 旁挂模型 ${sm.provider}/${sm.id} 未找到，回退剧情模型`);
	}
	return fallback;
}

/**
 * 旁路收敛尾注（DESIGN-router §3：信息完备即产出，防旁路飘）。
 * 默认开（用户拍板）；router.enabled=false 时零变化（不加尾注）。
 */
function routerConvergeTailOf(): string {
	try {
		const r = loadConfig(cwd).router;
		if (r?.enabled === false) return "";
		if (r?.side?.convergeTail === false) return "";
	} catch {
		return "";
	}
	return CONVERGE_TAIL;
}

// 表格历史回填（DESIGN-table-backfill §3）/ 原始导入（DESIGN-import-raw §2）：旁路文本调用，
// 与场记/压缩/规划同款 streamSimple 通道。模型：旁挂模型（sideModel）→ 剧情模型兜底；
// systemPrompt 最前拼破甲（sideJailbreak）；失败返回 {error}——调用方跳过该块继续。
// signal 透传给 streamSimple 可中断。
async function backfillSideText(
	systemPrompt: string,
	userText: string,
	signal?: AbortSignal,
): Promise<string | { error: string }> {
	// 统一调试接口：旁路请求按 config.debugLog 现读同步通道（开发者模式可关打印）
	syncDebugConfig(loadConfig(cwd));
	try {
		// 旁挂模型优先（找不到回退剧情模型，收敛自 resolveSideModel）
		const model = resolveSideModel(loadConfig(cwd), session.model as never);
		if (!model) return { error: "尚无可用模型（未配置剧情模型）" };
		// 必须 await：getApiKeyAndHeaders 返回 Promise，缺 await 会解构到 Promise 实例（同 registerPlannerCaller 坑）
		const auth = await session.modelRegistry.getApiKeyAndHeaders(model as never);
		if (!auth.ok) return { error: auth.error ?? `无法解析 ${String((model as { provider?: string }).provider)} 的 API key` };
		const s = streamSimple(
			model as never,
			{
				// 破甲固定在最前（2026-08-10 用户裁决：绕过模型限制；除每轮剧情场记外所有旁路生效）
				// + router 收敛尾注（DESIGN-router §3 B 类；默认开）
				systemPrompt: sideJailbreakPrefix() + systemPrompt + routerConvergeTailOf(),
				messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				// 大预算（2026-08-10 用户裁决，较初值 4096 放大 20 倍）：high 思考 + 多表/长剧情提取
				// 需要充足输出空间；超限由 API 拒绝（旁路重试机制兜底）
				maxTokens: 81920,
				// 中等思考（2026-08-10 用户裁决）：填表/回放场记需按表规则推理，关思考引导质量差。
				// deepseek-v4-flash 的 thinkingLevelMap 不支持 medium（minimal/low/medium 均为 null），
				// clampThinkingLevel 会自动升档到 high；maxTokens 同步加大给推理预留预算（推理计入 token）。
				reasoning: "medium",
				...(signal ? { signal } : {}),
			},
		);
		let final: AssistantMsgLike | null = null;
		for await (const e of s) {
			if (e.type === "done") final = e.message ?? null;
			else if (e.type === "error") {
				const msg = e.error?.errorMessage || `stopReason=${e.error?.stopReason ?? "?"}`;
				// 调试增强：旁路（回填/导入）返回 provider 错误——统一接口打 ERROR
				debug.error("side-text", "旁路（回填/导入）LLM 返回 provider 错误", {
					model: String((model as { id?: string }).id ?? ""),
					error: msg,
				});
				return { error: msg };
			}
		}
		if (!final) {
			debug.error("side-text", "旁路（回填/导入）LLM 流未产出最终消息", {
				model: String((model as { id?: string }).id ?? ""),
			});
			return { error: "旁路 LLM 流未产出最终消息" };
		}
		const text = (final.content ?? [])
			.filter((p) => p?.type === "text")
			.map((p) => String((p as { text?: string }).text ?? ""))
			.join("");
		if (!text.trim()) {
			debug.warning("side-text", "旁路（回填/导入）LLM 最终消息无文本", {
				model: String((model as { id?: string }).id ?? ""),
			});
			return { error: "旁路 LLM 最终消息无文本" };
		}
		return text;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		debug.error("side-text", "旁路（回填/导入）LLM 调用异常", { error: msg });
		return { error: msg };
	}
}

// 生图管线 lore 检索（draw-pipeline）：注册 host 实现——loadMergedLore + searchEntries。
// 与 assistant 侧 lorebook_search 同一数据源（rest.ts loadMergedLore → searchEntries）。
registerLoreSearcher((query, limit) => {
	try {
		const entries = loadMergedLore(cwd, loadConfig(cwd));
		const hits = searchEntries(entries, query, limit ?? 3);
		return hits
			.map((h) => `【${h.entry.comment || h.entry.keys[0] || "未命名"}】\n${h.entry.content}`)
			.join("\n\n");
	} catch (e) {
		console.warn("[draw-pipeline] lore 检索失败：", e);
		return "";
	}
});

try {
	const assistant = await createAgentHost({
		cwd,
		agentId: "assistant",
		bridge: storyBridge,
		// 与主聊天共享同一模型注册表/认证存储（2026-08-15）：主会话配置热重载
		// refreshModels 后助手立即一致，不再有「主聊天能用、助手报缺 key」的快照差
		modelRegistry: runtime.services.modelRegistry,
		authStorage: runtime.services.authStorage,
		uiContext,
		onEvent: onAssistantEvent,
		onError: (text) => broadcast({ type: "error", text }),
	});
	agentHosts.set("assistant", assistant);
	// 内置助手不在 agents 配置段（不参与热重建比对/删除），占位标记「已初始化」即可
	lastAgentConfigs.set("assistant", JSON.stringify(null));
	// 剧情侧 assistant_run → 本 Host（过程进右栏，结果可双写剧情流）
	registerAgentRunner("assistant", buildAgentRunner("assistant"));
	console.log(`[liyuan] 助手会话已就位（${assistant.modelInfo() ? `${assistant.modelInfo()!.provider}/${assistant.modelInfo()!.id}` : "暂无模型"}${assistant.follows() ? "，跟随剧情模型" : ""}）`);
} catch (err) {
	registerAgentRunner("assistant", null);
	console.error(`[liyuan] 助手会话启动失败（面板不可用，剧情不受影响）：${err instanceof Error ? err.message : String(err)}`);
}

// 自定义 agent：读 liyuan.config.json 的 agents 段逐个创建 host（DESIGN-custom-agents P3）。
// 启动失败不挡剧情（照助手「面板不可用」模式，log 警告后继续）；缺配置/非法配置已由 loadConfig 归一化静默剔除。
const agentConfigs: AgentConfig[] = loadConfig(cwd).agents ?? [];
for (const cfg of agentConfigs) {
	const id = cfg.id;
	if (agentHosts.has(id)) {
		console.warn(`[liyuan] 自定义 agent「${id}」与内置助手或其他 agent 重名，跳过`);
		continue;
	}
	// prompt 与 promptFile 二选一：有 promptFile 则读文件内容作为 systemPrompt
	let systemPrompt = cfg.prompt;
	if (!systemPrompt && cfg.promptFile) {
		try {
			systemPrompt = readFileSync(isAbsolute(cfg.promptFile) ? cfg.promptFile : join(cwd, cfg.promptFile), "utf8");
		} catch (err) {
			console.warn(
				`[liyuan] 自定义 agent「${id}」promptFile（${cfg.promptFile}）读取失败，跳过启动：${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}
	}
	try {
		const host = await createAgentHost({
			cwd,
			// 桥按各自配置裁剪（只读组 readStory 一键开关；写权限默认 false，配错最多「委托报无权限」）
			bridge: createStoryBridge(storyBridgeBase, cfg.bridge),
			agentId: id,
			agentName: cfg.name,
			sessionDirName: `.liyuan-agents/${id}`,
			systemPrompt,
			toolsAllow: cfg.tools,
			tools: cfg.tools, // 内置工具白名单：与 stagehand 同清单，两端一起裁剪（与热重建 reloadAgents 一致）
			model: cfg.model ?? null,
			followsStoryModel: !cfg.model,
			// 与主聊天共享 modelRegistry/authStorage（2026-08-15，同内置助手）
			modelRegistry: runtime.services.modelRegistry,
			authStorage: runtime.services.authStorage,
			uiContext,
			onEvent: onAssistantEvent,
			onError: (text) => broadcast({ type: "error", text }),
		});
		agentHosts.set(id, host);
		// 启动即记录配置签名，供热重建（reloadAgents）比对；之后 PUT /api/config 的 agents 段触发
		lastAgentConfigs.set(id, JSON.stringify(cfg));
		registerAgentRunner(id, buildAgentRunner(id));
		console.log(
			`[liyuan] 自定义 agent「${id}」（${cfg.name}）已就位（${host.modelInfo() ? `${host.modelInfo()!.provider}/${host.modelInfo()!.id}` : "暂无模型"}${host.follows() ? "，跟随剧情模型" : ""}）`,
		);
	} catch (err) {
		console.warn(`[liyuan] 自定义 agent「${id}」启动失败（跳过，不影响剧情）：${err instanceof Error ? err.message : String(err)}`);
	}
}

// ---------- HTTP：REST /api/* + 托管 web/dist（存在时）+ 健康检查 ----------

const distDir = join(cwd, "web", "dist");
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".manifest": "application/manifest+json",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".webm": "video/webm",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".ogv": "video/ogg",
	".woff2": "font/woff2",
	".map": "application/json",
};

// ---------- 访问密码闸门（src/access.ts；设置面板「访问密码」区管理） ----------

let accessData: AccessData | null = loadAccess(cwd);
let accessFails = 0; // 连续失败计数：≥5 次后每次登录尝试强制延迟

function requestAuthed(req: IncomingMessage): boolean {
	if (!accessData) return true;
	return verifyToken(accessData, parseCookies(req.headers.cookie)[ACCESS_COOKIE]);
}

/** 需过闸的路径：业务 API 与用户数据托管；静态前端壳放行（登录页就在壳里） */
function accessGuarded(url: string): boolean {
	if (url.startsWith("/api/")) return !url.startsWith("/api/access/");
	return url.startsWith("/media/") || url.startsWith("/audio/") || url.startsWith("/uploads/");
}

function setAccessCookie(res: ServerResponse, token: string | null): void {
	const base = `${ACCESS_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Strict`;
	res.setHeader("set-cookie", token ? `${base}; Max-Age=31536000` : `${base}; Max-Age=0`);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > 65536) {
				reject(new Error("body 过大"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {});
			} catch (e) {
				reject(e as Error);
			}
		});
		req.on("error", reject);
	});
}

/**
 * SQL 表格 REST（DESIGN-tables-sql P5）：表清单/元数据/建删表/行数据/行写入。
 * UI 表编辑器与外部调用共用；SQL 由 UI/调用方构造，经 TablesService 校验执行。
 */
async function handleTablesApi(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
	const json = (code: number, body: unknown) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	const readBody = async (): Promise<Record<string, unknown>> => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
		} catch {
			return {};
		}
	};
	try {
		const svc = stage.tablesService();
		if (req.method === "GET" && urlPath === "/api/tables") {
			const list = svc.listTables();
			const metas: Record<string, unknown> = {};
			for (const t of list) metas[t.name] = svc.getMeta(t.name);
			json(200, { tables: list, metas });
			return;
		}
		if (req.method === "GET" && urlPath === "/api/tables/rows") {
			const u = new URL(req.url ?? "/", "http://x");
			const table = u.searchParams.get("table") ?? "";
			if (!/^[A-Za-z0-9_\u4e00-\u9fff]{1,32}$/.test(table)) {
				json(400, { error: "表名不合法" });
				return;
			}
			const offset = Math.max(0, Number(u.searchParams.get("offset") ?? 0) || 0);
			const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") ?? 50) || 50));
			// rowid 供前端行编辑定位（UPDATE/DELETE WHERE rowid = N）
			const r = svc.execRead(`SELECT rowid AS __rowid, * FROM "${table}" LIMIT ${limit} OFFSET ${offset}`);
			json(r.ok ? 200 : 400, r.ok ? { rows: r.rows } : { error: r.error });
			return;
		}
		if (req.method === "POST" && urlPath === "/api/tables") {
			const body = await readBody();
			const action = String(body.action ?? "");
			if (action === "create") {
				const r = svc.createTable(body.def as never);
				json(r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
				return;
			}
			if (action === "drop") {
				const r = svc.dropTable(String(body.name ?? ""));
				json(r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
				return;
			}
			if (action === "updateMeta") {
				const r = svc.updateMeta(body.def as never);
				json(r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
				return;
			}
			json(400, { error: "未知 action（create/drop/updateMeta）" });
			return;
		}
		if (req.method === "POST" && urlPath === "/api/tables/rows") {
			const body = await readBody();
			const r = svc.execWrite(String(body.sql ?? ""));
			json(r.ok ? 200 : 400, r.ok ? { ok: true, changes: r.changes } : { error: r.error });
			return;
		}
		json(404, { error: "unknown" });
	} catch (e) {
		json(500, { error: e instanceof Error ? e.message : String(e) });
	}
}

async function handleAccessApi(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {	const json = (code: number, body: unknown, token?: string | null) => {
		if (token !== undefined) setAccessCookie(res, token);
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	try {
		if (req.method === "GET" && url === "/api/access/status") {
			json(200, { required: !!accessData, ok: requestAuthed(req) });
			return;
		}
		if (req.method === "POST" && url === "/api/access/login") {
			if (!accessData) {
				json(400, { error: "未设置访问密码" });
				return;
			}
			if (accessFails >= 5) await new Promise((r) => setTimeout(r, 1500)); // 暴力尝试限速
			const body = await readJsonBody(req);
			if (typeof body.password === "string" && verifyPassword(accessData, body.password)) {
				accessFails = 0;
				json(200, { ok: true }, issueToken(cwd, accessData));
			} else {
				accessFails++;
				json(401, { error: "密码不正确" });
			}
			return;
		}
		if (req.method === "POST" && url === "/api/access/set") {
			const body = await readJsonBody(req);
			// 已有密码时，任何变更（改/关）都必须先验旧密码
			if (accessData && (typeof body.oldPassword !== "string" || !verifyPassword(accessData, body.oldPassword))) {
				json(403, { error: "当前密码不正确" });
				return;
			}
			const next = typeof body.newPassword === "string" ? body.newPassword : "";
			if (!next) {
				clearPassword(cwd);
				accessData = null;
				json(200, { required: false }, null);
				return;
			}
			if (next.length < 4) {
				json(400, { error: "密码至少 4 位" });
				return;
			}
			const r = setPassword(cwd, next);
			accessData = r.data;
			accessFails = 0;
			json(200, { required: true }, r.token); // 旧 token 全部失效；当前设备用新 token 续座
			return;
		}
		if (req.method === "POST" && url === "/api/access/logout") {
			if (accessData) revokeToken(cwd, accessData, parseCookies(req.headers.cookie)[ACCESS_COOKIE]);
			json(200, { ok: true }, null);
			return;
		}
		json(404, { error: "unknown access endpoint" });
	} catch (e) {
		json(400, { error: (e as Error).message });
	}
}

const httpServer = createServer((req, res) => {
	void (async () => {
		const urlPath = (req.url ?? "/").split("?")[0];
		if (urlPath.startsWith("/api/tables")) {
			await handleTablesApi(req, res, urlPath);
			return;
		}
		if (urlPath.startsWith("/api/access/")) {
			await handleAccessApi(req, res, urlPath);
			return;
		}
		if (accessGuarded(urlPath) && !requestAuthed(req)) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "需要登录" }));
			return;
		}
		if (await handleApiRequest(req, res, restHost)) return;
		const url = (req.url ?? "/").split("?")[0];
		if (url === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, sessionId: session.sessionId, char: names.charName }));
			return;
		}
		// 图片通道媒体托管（show_image → .liyuan-media/）
		if (url.startsWith("/media/")) {
			const mediaDir = dir(cwd, "media");
			const rel = normalize(url.slice("/media/".length)).replace(/^([/\\.])+/, "");
			const file = join(mediaDir, rel);
			if (file.startsWith(mediaDir) && existsSync(file)) {
				res.writeHead(200, {
					"content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
					"cache-control": "public, max-age=31536000, immutable", // 内容寻址文件名，可永久缓存
				});
				res.end(readFileSync(file));
			} else {
				res.writeHead(404);
				res.end();
			}
			return;
		}
		// 生图缓存托管（draw_generate → .liyuan-cache/；未保存缓存随时可能被清理，不设长期缓存）
		if (url.startsWith("/cache/")) {
			const cacheDir = dir(cwd, "cache");
			const rel = normalize(url.slice("/cache/".length)).replace(/^([/\\.])+/, "");
			const file = join(cacheDir, rel);
			if (file.startsWith(cacheDir) && existsSync(file)) {
				res.writeHead(200, {
					"content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
					"cache-control": "no-cache",
				});
				res.end(readFileSync(file));
			} else {
				res.writeHead(404);
				res.end();
			}
			return;
		}
		// 音频通道（show_audio / tts → .liyuan-audio/）
		if (url.startsWith("/audio/")) {
			const audioDir = dir(cwd, "audio");
			const rel = normalize(url.slice("/audio/".length)).replace(/^([/\\.])+/, "");
			const file = join(audioDir, rel);
			if (file.startsWith(audioDir) && existsSync(file)) {
				res.writeHead(200, {
					"content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
					"cache-control": "public, max-age=31536000, immutable",
				});
				res.end(readFileSync(file));
			} else {
				res.writeHead(404);
				res.end();
			}
			return;
		}
		// 上传区托管（.liyuan-uploads/）
		if (url.startsWith("/uploads/")) {
			const upDir = dir(cwd, "uploads");
			let rel = "";
			try {
				rel = normalize(decodeURIComponent(url.slice("/uploads/".length))).replace(/^([/\\.])+/, "");
			} catch {
				// 畸形百分号编码：按 404 处理
			}
			const file = rel ? join(upDir, rel) : "";
			if (file.startsWith(upDir) && existsSync(file)) {
				res.writeHead(200, {
					"content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
					"cache-control": "public, max-age=86400",
					"content-security-policy": "default-src 'none'",
					"x-content-type-options": "nosniff",
					// V2-6 sandbox 加固：脚本 iframe opaque origin（sandbox 无 allow-same-origin）下
					// fetch('/uploads/…') 变跨源——静态资源加 * CORS 放行（对静态上传可接受，D4 V2-6）
					"access-control-allow-origin": "*",
				});
				res.end(readFileSync(file));
			} else {
				res.writeHead(404);
				res.end();
			}
			return;
		}
		if (!existsSync(distDir)) {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end("梨园 server 运行中。前端尚未构建：开发用 `npm --prefix web run dev`，或 `npm --prefix web run build` 后刷新本页。WS 端点：/ws");
			return;
		}
		// 静态文件（含 SPA 回退），normalize 防目录穿越
		const rel = normalize(url === "/" ? "/index.html" : url).replace(/^([/\\])+/, "");
		let file = join(distDir, rel);
		if (!file.startsWith(distDir) || !existsSync(file)) file = join(distDir, "index.html");
		try {
			const body = readFileSync(file);
			const ext = extname(file).toLowerCase();
			const headers: Record<string, string> = {
				"content-type": MIME[ext] ?? "application/octet-stream",
			};
			// 品牌图 / 壳资源：可缓存（SW 会再管一层）
			if (
				ext === ".png" ||
				ext === ".webmanifest" ||
				ext === ".js" ||
				ext === ".css" ||
				ext === ".woff2" ||
				file.endsWith(`${"sw.js"}`) ||
				file.endsWith("site.webmanifest")
			) {
				const name = file.replace(/\\/g, "/");
				if (name.includes("/assets/")) {
					headers["cache-control"] = "public, max-age=31536000, immutable";
				} else if (name.endsWith("/sw.js")) {
					headers["cache-control"] = "no-cache";
				} else {
					headers["cache-control"] = "public, max-age=86400";
				}
			}
			// HTML 必须每次向服务器验证：无此头时手机浏览器启发式缓存旧壳，
			// 旧壳引用已删除的 hashed 资源 → 更新「刷新也不生效」甚至白屏
			if (ext === ".html") {
				headers["cache-control"] = "no-cache";
			}
			res.writeHead(200, headers);
			res.end(body);
		} catch {
			res.writeHead(404);
			res.end();
		}
	})().catch((err) => {
		if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
	});
});

// ---------- WS 端点 ----------

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// ---------- 台上引擎（PLAN-RP-HARNESS R1：叙事回合走自建循环，pi 只留幕后） ----------

// 主聊天跟踪（开发者模式）：写 .liyuan-state/trace/<sessionId>.jsonl；引擎按 config.chatTrace 现读开关
const traceRecorder = new TraceRecorder(join(stateDir, "trace"));

const stage = new StageEngine({
	cwd,
	getSessionManager: () => session.sessionManager as never,
	getModel: () => session.model as never,
	getAuth: async (m) => session.modelRegistry.getApiKeyAndHeaders(m as never),
	// 旁挂模型（8/14，sideModel 接上台）：台上旁路（评审/场记/压缩）统一走它——
	// 解析收敛自 resolveSideModel（modelRegistry.find，找不到回退剧情模型），配置改动即时生效
	getSideModel: () => resolveSideModel(loadConfig(cwd), undefined) ?? undefined,
	getThinking: () => session.thinkingLevel,
	// 场记落盘 → fs.watch 自动广播 state 帧（与扩展/REST 写路径同一条）
	getStateFile: (sessionId) => join(stateDir, `${sessionId}.json`),
	// memory_search 工具：剧情库 + 外部资料库合并取前 6（与扩展侧同一套语义）
	searchMemory: async (sessionId, query) => {
		const scope = { sessionId, card: cardPath || undefined };
		const [narrative, external] = await Promise.all([
			memorySearch(cwd, scope, "narrative", query).catch(() => []),
			memorySearch(cwd, scope, "external", query).catch(() => []),
		]);
		return [...narrative, ...external].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 6);
	},
	// 向量库写侧三件（M-D3）：MemoryScope 一律在此绑定（当前对话 + 当前卡），**不经模型**。
	// 写侧恒落 external——服务层 assertExtraStore 禁止手写剧情库，故工具不给 store 参数。
	addMemory: (sessionId, input) =>
		memoryManualAdd(cwd, { sessionId, card: cardPath || undefined }, input.text, {
			...(input.title ? { title: input.title } : {}),
		}),
	listMemory: (sessionId, storeId) =>
		memoryListChunks(cwd, { sessionId, card: cardPath || undefined }, storeId),
	deleteMemory: (sessionId, storeId, id) =>
		memoryDeleteChunk(cwd, { sessionId, card: cardPath || undefined }, storeId, id),
	// 面板读写（M-D5）：按 session 绑定 artifacts 文件，注入后台上可通过 panel_write/read/close 操控面板
	loadPanels: (sessionId) => {
		const panels = loadPanels(join(artifactsDir, `${sessionId}.json`));
		const result: Record<string, { name: string; kind: "markdown" | "svg" | "html"; content: string; archived?: boolean }> = {};
		for (const [k, v] of Object.entries(panels)) result[k] = { name: v.name, kind: v.kind, content: v.content, archived: v.archived };
		return result;
	},
	writePanel: (sessionId, input) => {
		const file = join(artifactsDir, `${sessionId}.json`);
		const panels = loadPanels(file);
		const r = writePanel(panels, input);
		if (r.ok) { savePanels(file, r.panels); syncStoryPanelsFromDisk(); }
		return r;
	},
	closePanel: (sessionId, name) => {
		const file = join(artifactsDir, `${sessionId}.json`);
		const panels = loadPanels(file);
		const r = closePanelInMap(panels, name);
		if (r.ok) { savePanels(file, r.panels); syncStoryPanelsFromDisk(); }
		return r;
	},
	// MCP 外设（8/06 重接）：009e22e 换引擎时 MCP 只留在扩展路径（pi.registerTool）+
	// 已删除的 director.ts，台上从此看不见——hub 连得上，模型无工具可用。此处补上注入。
	//
	// 启用集**自己从会话树读**，不问扩展要（jiti 二象性：扩展的 sessionMcpEnabled 闭包
	// 变量在 server 侧不可见）。树上的 rp-mcp 快照是唯一可靠信源，且天然随 rewind/fork 走。
	// 无快照（新会话尚未 /mcpsync，或扩展未装载）→ 回落项目 defaults，自愈不依赖扩展。
	mcp: {
		listTools: () => {
			const hub = getMcpHub(cwd);
			const fromTree = mcpEnabledFromBranch(session.sessionManager.getBranch() as unknown[], RP_MCP_TYPE);
			const want = fromTree ?? defaultSessionEnabledIds(cwd);
			// hub 的启用集与树不一致时对账一次（后台连接，本拍用当前已连上的）。
			// 不 await：装配不能被 MCP 握手拖慢；连上后的下一拍即可见。
			const current = hub.getSessionEnabled();
			if (want.join("|") !== current.join("|")) {
				void hub.sync(want).catch(() => {
					// 连不上不该拖垮叙事：本拍就当没有 MCP 工具
				});
			}
			return hub.listActiveTools();
		},
		callTool: (serverId, toolName, args, signal) => getMcpHub(cwd).callTool(serverId, toolName, args, signal),
	},
	// P7 剧情决策门禁（ask 工具）：复用 Phase 4 柱 1 的选择卡通道——
	// 弹卡 → 用户作答（选项原文/自由输入）回喂模型重拟计划；停止 → 本拍收束，笔还给用户。
	askUser: (question, options, signal) => askChoice(question, options, undefined, signal),
	// 媒体交付（8/06 重接）：show_image/audio/video/html + tts。
	// 与 MCP 同源的断链——wire.ts 的消费端一直健在，缺的只是台上生产端。
	media: true,
	// TTS 需要服务端环境（LIYUAN_TTS_API_KEY / OPENAI_API_KEY）：每拍现查，
	// 用户中途配好 env 重启即生效；没配就不上清单（模型不会去试一个必然失败的工具）。
	ttsAvailable: () => loadTtsConfig() !== null,
	// M4 压缩归档：被摘要覆盖的早期正文完整入剧情库——摘要管连续性，归档管细节召回
	archiveCompacted: async (sessionId, text) => {
		const r = await memoryArchiveCompacted(cwd, { sessionId, card: cardPath || undefined }, text);
		if (r.archived) {
			broadcast({ type: "notify", level: "info", text: `向量记忆：早期剧情已归档（${r.chunks} 段，可 memory_search 召回）` });
		}
	},
	// lorebook_toggle 工具（M-D2）：写 config.disabledLore 并软刷新素材。
	// 复用 M-C2 协议禁用的同一条指纹通道（PLAN-RP-TOOLING M-D2 明示不得另起一套）。
	setDisabledLore: (fingerprints, enabled) => {
		const disk = existsSync(configPath)
			? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
			: {};
		const prev = Array.isArray(disk.disabledLore)
			? disk.disabledLore.filter((f): f is string => typeof f === "string")
			: [];
		const next = toggleDisabledLore(prev, fingerprints, enabled);
		if (next.length > 0) disk.disabledLore = next;
		else delete disk.disabledLore;
		writeFileSync(configPath, `${JSON.stringify(disk, null, "\t")}\n`, "utf8");
		cfg = { ...cfg, disabledLore: next };
		// constant 条目影响 system prompt，素材需重装（与 REST /api/lorebook/toggle 同）
		void restHost.softRefreshConfig();
		return fingerprints.length;
	},
	// codex_mount 工具：宿主写 rp-codex 树快照——挂载关系随剧情分支走（rewind/fork 跟随）。
	// 与扩展 snapshotCodexMounts 同一条路径；扩展在下一拍 agent_start 会 restoreCodexFromBranch 收编。
	mountCodex: (sessionId, name, enabled) => {
		try {
			const sm = session.sessionManager;
			const branch = sm.getBranch() as Array<{
				type?: string;
				customType?: string;
				data?: { mounted?: unknown };
			}>;
			let mounted: string[] = [];
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e?.type === "custom" && e.customType === "rp-codex" && e.data && Array.isArray(e.data.mounted)) {
					mounted = e.data.mounted.filter((n): n is string => typeof n === "string");
					break;
				}
			}
			const lower = name.trim().toLowerCase();
			const next = enabled
				? mounted.some((n) => n.toLowerCase() === lower)
					? mounted
					: [...mounted, name.trim()]
				: mounted.filter((n) => n.toLowerCase() !== lower);
			sm.appendCustomEntry("rp-codex", { mounted: next });
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	},
	// choice 工具：复用 uiContext.select（askChoice 选择卡；停止即结算为 undefined，见 engine 透传）
	select: uiContext.select,
	streamFn: streamSimple as unknown as StageStreamFn,
	events: {
		onTurnStart: () => {
			broadcast({ type: "agent", state: "start" });
			// JS Runner 事件桥（断链修复 2026-08-16）：台上回合开始 → ST GENERATION_STARTED。
			// 经 script-events.ts 映射表发射（该模块此前零调用）；前端投影无 GENERATION_STARTED，零双发。
			for (const f of mapPiEventsToSt({ name: "turn_start", data: {} })) {
				broadcast({ type: "ext_event", name: f.name, args: f.args });
			}
		},
		onDelta: (kind, delta, draft, reset) =>
			broadcast({ type: "delta", kind, delta, ...(draft ? { draft: true } : {}), ...(reset ? { reset: true } : {}) }),
		onDraftResync: (segments) => broadcast({ type: "draft_resync", segments }),
		onStreamClear: () => broadcast({ type: "stream", state: "clear" }),
		onNotify: (level, text) => broadcast({ type: "notify", level, text }),
		onActivity: (detail) => broadcast({ type: "activity", activity: { kind: "note", name: "stage", detail } }),
		// LLM 主动播放音效（play_sound 工具）：同 uiContext 白名单与音量校验
		onPlaySound: (sound, volume) => emitPlaySound(sound, volume),
		onTurnEnd: (info) => {
			broadcast({ type: "agent", state: "end" });
			// reroll/编辑输入后无产出（aborted 无落树 / error）：回退到 reroll 前的旧叶——
			// 不许留下「只有 user 没有回复」的空拍（8/05：reroll 链上停止，前版本全消失）。
			if (rerollFallbackLeaf && (!info.entryId || info.error)) {
				const sm = session.sessionManager;
				if (sm.getLeafId() !== rerollFallbackLeaf) {
					try {
						sm.branch(rerollFallbackLeaf);
					} catch {
						// 回退失败不致命：保持当前状态
					}
				}
			}
			rerollFallbackLeaf = null;
			// 传统命令路径（/compact /rewind 等）仍读 AgentSession 内存副本：引擎写树后对齐一次
			try {
				session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
			} catch {
				// 对齐失败不影响本拍；下次树导航会重建
			}
			resyncAll();
			// 向量记忆入库：只在真落了新正文时（中断/错误拍不入）
			if (!info.entryId || info.error || info.aborted) return;
			void (async () => {
				try {
					const msgs = branchMessages() as Array<{ role?: string; content?: unknown }>;
					let lastText = "";
					for (let i = msgs.length - 1; i >= 0; i--) {
						const m = msgs[i];
						if (m?.role !== "assistant") continue;
						const c = m.content;
						if (typeof c === "string") lastText = c;
						else if (Array.isArray(c)) {
							lastText = c
								.map((p) =>
									p && typeof p === "object" && (p as { type?: string }).type === "text"
										? String((p as { text?: string }).text ?? "")
										: "",
								)
								.join("");
						}
						if (lastText.trim()) break;
					}
					const mem = await onNarrativeTurnEnd(
						cwd,
						{ sessionId: session.sessionId, card: cardPath || undefined },
						lastText,
					);
					if (mem.error) {
						broadcast({ type: "notify", level: "warning", text: `向量记忆：入库失败 · ${mem.error}` });
					} else if (mem.stored) {
						const how = mem.merged ? "合并入已有条目" : "新开条目";
						broadcast({ type: "notify", level: "info", text: `向量记忆：剧情库${how}（第 ${mem.counter} 轮 · 当前对话）` });
					}
				} catch (e) {
					console.warn("[memory] auto ingest failed", e);
				}
			})();

			// 生图管线钩子（能力包插件注册；后台执行不阻塞回合）
			// 取本回合最新 assistant 定稿文本（供管线规划；与向量记忆同源取法）。
			// 用 currentDisplayTextOf 取「当前显示全文」：该消息已有 rp-edited-reply 覆盖
			// （含旧占位符）时以其为基准，二次配图不丢旧图（否则补丁基于原文 → 覆盖丢占位符）
			const pipelineHooks = turnEndHooks();
			if (pipelineHooks.length > 0 && info.entryId) {
				const msgs2 = branchMessages() as Array<{ role?: string; content?: unknown }>;
				let pipelineText = "";
				for (let i = msgs2.length - 1; i >= 0; i--) {
					const m = msgs2[i];
					if (m?.role !== "assistant") continue;
					const c = m.content;
					if (typeof c === "string") pipelineText = c;
					else if (Array.isArray(c)) {
						pipelineText = c
							.map((p) =>
								p && typeof p === "object" && (p as { type?: string }).type === "text"
									? String((p as { text?: string }).text ?? "")
									: "",
							)
							.join("");
					}
					if (pipelineText.trim()) break;
				}
				{
					const b = session.sessionManager.getBranch() as Array<{
						id?: string;
						type?: string;
						customType?: string;
						message?: { content?: unknown };
						content?: unknown;
					}>;
					const covered = currentDisplayTextOf(b, info.entryId!);
					if (covered.trim()) pipelineText = covered;
				}
				const chatId = session.sessionId;
				// 前文（最近 3 条 assistant/user 消息，不含当前 entry——补丁/摘要/账本等 custom 不算）
				let historyText = "";
				{
					const msgs3 = branchMessages() as Array<{ role?: string; customType?: string; content?: unknown }>;
					const parts: string[] = [];
					for (let i = msgs3.length - 1; i >= 0 && parts.length < 3; i--) {
						const m = msgs3[i];
						if (m?.role !== "assistant" && m?.role !== "user") continue;
						const c = m.content;
						let t = "";
						if (typeof c === "string") t = c;
						else if (Array.isArray(c)) {
							t = c
								.map((p) =>
									p && typeof p === "object" && (p as { type?: string }).type === "text"
										? String((p as { text?: string }).text ?? "")
										: "",
								)
								.join("");
						}
						if (t.trim()) parts.push(`${m.role}: ${t.trim()}`);
					}
					historyText = parts.reverse().join("\n\n");
				}
				// 压缩摘要（rp-summary）：最近一条摘要条目的 data.summary（无则 ""）
				let summaryText = "";
				{
					const branch = session.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
					for (let i = branch.length - 1; i >= 0; i--) {
						const e = branch[i];
						if (e?.type === "custom" && e.customType === "rp-summary") {
							const d = e.data as { summary?: unknown } | undefined;
							if (d && typeof d.summary === "string" && d.summary.trim()) {
								summaryText = d.summary;
							}
							break;
						}
					}
				}
				// 补丁执行（Q15 简化：改正文通道 = storyEdit 语义，不走 rp-draft-op 补丁）：
				// 应用补丁得新全文 → editEntryViaStoryChannel（rp-edited-reply 分支注入）
				const appendPatch = async (patch: Record<string, unknown>) => {
					try {
						const branchIds = (session.sessionManager.getBranch() as Array<{ id?: string }>).map((e) => e.id);
						if (!branchIds.includes(info.entryId!)) {
							return { ok: false as const, reason: "目标消息已离开当前分支（用户已进入新回合），补丁丢弃" };
						}
						const newText = applyDraftOpToText(pipelineText ?? "", patch);
						const r = await editEntryViaStoryChannel(info.entryId!, newText);
						return r.ok ? { ok: true as const } : { ok: false as const, reason: r.error ?? "嵌入失败" };
					} catch (e) {
						console.warn("[draw-pipeline] 补丁写入失败", e);
						return { ok: false as const, reason: e instanceof Error ? e.message : String(e) };
					}
				};
				for (const h of pipelineHooks) {
					void (async () => {
						try {
							await h({
								entryId: info.entryId,
								aborted: info.aborted,
								text: pipelineText,
								chatId,
								historyText,
								summaryText,
								appendPatch,
							});
						} catch (e) {
							console.warn("[draw-pipeline]", e);
						}
					})();
				}
			}
		},
	},
	trace: traceRecorder,
});

/** 台上或旧循环任一在流式中（守卫共用） */
const storyStreaming = (): boolean => session.isStreaming || stage.isStreaming;

/**
 * 手动压缩（/compact 与 WS compact 帧共用）：走台上引擎自管压缩（M4）。
 * 摘要落 rp-summary 后 resyncAll——重放时被覆盖的楼层照旧全在（树只追加），
 * 变的只是**送模上下文**：装配时那段改由【前情提要】代替。
 */
const hostCompact = async (): Promise<void> => {
	broadcast({ type: "compaction", state: "start" });
	const r = await stage.compactNow();
	broadcast({ type: "compaction", state: "end", ok: r.kind === "compacted" });
	if (r.kind === "compacted") {
		broadcast({
			type: "notify",
			level: "info",
			text: `前情已压缩：${r.turns} 拍 ${r.chars} 字 → 摘要 ${r.summary.length} 字`,
		});
		resyncAll();
	} else if (r.kind === "failed") {
		broadcast({ type: "notify", level: "error", text: `压缩失败：${r.error}` });
	} else if (r.kind === "stale") {
		broadcast({ type: "notify", level: "warning", text: "压缩已丢弃（期间切换了分支）" });
	} else {
		broadcast({
			type: "notify",
			level: "info",
			text: r.reason === "busy" ? "正在演出中，稍后再压缩" : "早期剧情还不够长，暂不需要压缩",
		});
	}
};

/** 发送用户输入（含斜杠命令；命令后全量对齐所有端） */
const handlePrompt = async (text: string) => {
	const trimmed = text.trim();
	// ST 式变体：无参 /reroll 与 /swipe 由宿主处理（需重开一拍，扩展命令上下文无此能力）
	if (/^\/reroll\s*$/i.test(trimmed)) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再重新生成" });
			return;
		}
		await regenerateSwipe();
		return;
	}
	// M-D6 R1：有参 /reroll（前端编辑用户消息）同样在宿主拦截，走 StageEngine——
	// 之前漏到 pi 跑无台上装配的裸 LLM 回合（无预设拆层/无工作区/无验收器）。
	const rerollArgMatch = /^\/reroll\s+(.+)/i.exec(trimmed);
	if (rerollArgMatch) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再重新生成" });
			return;
		}
		const userId = lastStoryUserId();
		if (!userId) {
			broadcast({ type: "notify", level: "error", text: "没有可重新生成的剧情轮（需要先有一条用户输入）" });
			return;
		}
		const sm = session.sessionManager;
		// 记录编辑前的叶：生成失败/停止无产出时回退到旧输入+旧回复
		rerollFallbackLeaf = sm.getLeafId();
		// 编辑输入 = **替换**该输入：钉到它的 parent，旧输入连同旧回复进旁支——
		// 树上不再有「旧输入 + 新输入」两条 user（8/05 实弹：编辑后 reroll，屏上两条输入都在）。
		// 与无参 reroll（regenerateSwipe，branch(userId) 保留输入重roll回复）语义不同。
		const branch = sm.getBranch() as Array<{ id?: string; parentId?: string }>;
		const userEntry = branch.find((e) => e.id === userId);
		const parentId = userEntry?.parentId;
		if (parentId && parentId !== userId) {
			if (sm.getLeafId() !== parentId) sm.branch(parentId);
		} else if (sm.getLeafId() !== userId) {
			// 旧输入是根（无 parent）：无法替换，退而保留输入本身
			sm.branch(userId);
		}
		// 追加编辑后的用户消息
		sm.appendMessage({ role: "user", content: [{ type: "text", text: rerollArgMatch[1].trim() }], timestamp: Date.now() });
		sm.flush();
		resyncAll();
		await stage.regenerate();
		return;
	}
	// 开场白切换：宿主层处理，保证「同一条替换」而非叠楼
	const greetingMatch = /^\/greeting(?:\s+(.*))?$/i.exec(trimmed);
	if (greetingMatch) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再切换开场白" });
			return;
		}
		await hostSwitchGreeting(greetingMatch[1] ?? "");
		return;
	}
	const swipeMatch = /^\/swipe(?:\s+(prev|next|new))?\s*$/i.exec(trimmed);
	if (swipeMatch) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再切换变体" });
			return;
		}
		const dir = (swipeMatch[1]?.toLowerCase() ?? "next") as "prev" | "next" | "new";
		await handleSwipe(dir);
		return;
	}
	// /compact：台上引擎自管压缩（PLAN-RP-HARNESS M4）。
	// 旧路径 session.compact() 压的是 pi 的消息副本，看不全引擎写进树的东西
	// （rp-draft-op 补丁 / rp-state 快照 / 引擎直落的 assistant）——长局压不动，故整体让位。
	const compactMatch = /^\/compact(?:\s+(.*))?$/i.exec(trimmed);
	if (compactMatch) {
		if (storyStreaming()) {
			broadcast({ type: "notify", level: "warning", text: "请等当前回复完成（或先停止），再压缩上下文" });
			return;
		}
		await hostCompact();
		return;
	}

	// 2026-07-18 合流：主框一律进剧情侧；// 与整段括号不再硬改道。
	// 2026-08-02 起叙事回合走台上引擎（PLAN-RP-HARNESS R1）；斜杠命令仍经 pi 会话执行。

	const isCommand = trimmed.startsWith("/");
	if (!isCommand) {
		broadcast({
			type: "message",
			message: { channel: "user", name: names.userName, text: trimmed },
		});
		// JS Runner 事件桥（断链修复 2026-08-16）：用户消息受理 → ST MESSAGE_SENT。
		// 前端投影明确不给 user 通道发事件，此处经 script-events.ts 映射补上，零双发。
		for (const f of mapPiEventsToSt({ name: "message_end", data: { message: { role: "user", content: trimmed } } })) {
			broadcast({ type: "ext_event", name: f.name, args: f.args });
		}
		// 流式中送达的输入由引擎排队到本拍结束（RP 语境：不打断正在进行的叙事）
		await stage.performTurn(trimmed);
		return;
	}
	await session.prompt(trimmed, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
	// 斜杠命令可能改写历史（/rewind /reroll /import）或注入消息：全量对齐
	{
		// /import：前情块是 custom 消息，SessionManager 在「尚无 assistant 回复」的
		// 新会话里默认不落盘（防空会话刷屏）——导入的会话没有回复也必须持久化，
		// 否则重启/切会话后整段前情蒸发、会话列表里也找不到（用户实测踩中）。
		if (/^\/import\b/i.test(trimmed)) {
			session.sessionManager.flush();
		}
		resyncAll();
	}
};

/** 流式中禁止的操作统一挡下 */
const refuseWhileStreaming = (ws: WebSocket, what: string): boolean => {
	if (!storyStreaming()) return false;
	ws.send(JSON.stringify({ type: "notify", level: "warning", text: `请等当前回复完成（或先停止），再${what}` } satisfies ServerFrame));
	return true;
};

// ---------- 会话-卡绑定（PLAN-PHASE3 §2.1）：读文件头解析 rp-card，mtime 缓存 ----------

const cardCache = new Map<string, { mtimeMs: number; info: { card: string; name: string } | null }>();

const readSessionCard = (path: string, mtimeMs: number): { card: string; name: string } | null => {
	const cached = cardCache.get(path);
	if (cached && cached.mtimeMs === mtimeMs) return cached.info;
	let info: { card: string; name: string } | null = null;
	try {
		// 取最后一条 rp-card：头 64KB + 尾 64KB（换卡后新标记 append 在文件末尾）
		const size = statSync(path).size;
		const fd = openSync(path, "r");
		try {
			const headLen = Math.min(size, 65536);
			const headBuf = Buffer.alloc(headLen);
			readSync(fd, headBuf, 0, headLen, 0);
			let text = headBuf.toString("utf8");
			if (size > 65536) {
				const tailLen = Math.min(size - headLen, 65536);
				const tailBuf = Buffer.alloc(tailLen);
				readSync(fd, tailBuf, 0, tailLen, size - tailLen);
				text += "\n" + tailBuf.toString("utf8");
			}
			info = parseCardFromSessionHead(text);
		} finally {
			closeSync(fd);
		}
	} catch {
		info = null;
	}
	cardCache.set(path, { mtimeMs, info });
	return info;
};

/** 会话路径是否为当前打开（Windows 路径大小写/斜杠差异时 path=== 会失败） */
const isSameSessionPath = (a: string | undefined, b: string | undefined): boolean => {
	if (!a || !b) return false;
	const n = (p: string) => normalize(p).replace(/\\/g, "/").toLowerCase();
	return n(a) === n(b);
};

/**
 * 仅列**当前角色卡**下的会话（全部对话按卡绑定，不再有「未标记」分组）。
 * - 有 rp-card 且路径=当前卡 → 列出
 * - 其他卡 → 隐藏（即使是「当前打开」也不把同卡以外的旁支拉进列表）
 * - 无标记：不列入（session_start 会补写）
 * - 当前打开且绑定当前卡：标 current；当前打开却属其它卡：不列入（应已被 switchToCard 切走）
 * - 列表为空且进程有打开会话 → 兜底补一条「当前会话」
 */
const sessionInfos = async () => {
	// 每次列表前刷新卡路径，避免换卡后仍用旧 cardPath 滤错
	refreshNamesFromConfig();
	const all = await SessionManager.list(cwd);
	const curFile = session.sessionFile;
	const curId = session.sessionId;
	const list: Array<{
		path: string;
		id: string;
		name?: string;
		firstMessage: string;
		modified: number;
		messageCount: number;
		current: boolean;
		preview?: string;
		cardName: string;
		card?: string;
	}> = [];
	const belongsHere = (card: string | undefined) => {
		if (!cardPath) return false; // 未配置卡：不铺开历史
		return sameCardPath(card, cardPath, cwd);
	};
	for (const s of all) {
		const mtime = s.modified instanceof Date ? s.modified.getTime() : Number(s.modified) || 0;
		// 新建后 mtime 刚变：清掉可能过期的卡缓存再读
		if (cardCache.has(s.path)) {
			const c = cardCache.get(s.path)!;
			if (c.mtimeMs !== mtime) cardCache.delete(s.path);
		}
		const info = readSessionCard(s.path, mtime);
		const isCurrent = s.id === curId || isSameSessionPath(s.path, curFile);
		// 严格按卡过滤：其它卡一律不出现（含「当前打开却属其它卡」——由换卡流程切会话）
		if (!info || !belongsHere(info.card)) {
			// 仅当「当前会话尚未打上标记」时保留入口，避免新建后列表空白
			if (!(isCurrent && !info && cardPath)) continue;
		}
		const preview = readSessionPreview(s.path, mtime);
		list.push({
			path: s.path,
			id: s.id,
			...(s.name ? { name: s.name } : {}),
			firstMessage: s.firstMessage,
			modified: mtime,
			messageCount: s.messageCount,
			current: isCurrent,
			...(preview ? { preview } : {}),
			cardName: info?.name || names.charName,
			...(info?.card ? { card: info.card } : cardPath ? { card: cardPath } : {}),
		});
	}
	// 兜底：列表里没有任何 current，但进程确有打开会话 → 按 id/路径补一条（须属当前卡或无标记）
	if (curId && !list.some((x) => x.current)) {
		const mine = all.find((s) => s.id === curId || isSameSessionPath(s.path, curFile));
		if (mine) {
			const mtime = mine.modified instanceof Date ? mine.modified.getTime() : Number(mine.modified) || 0;
			const info = readSessionCard(mine.path, mtime);
			// 打开中的会话若明确属于其它卡：不塞进本卡列表（避免「切卡后仍见旧卡」）
			if (info && !belongsHere(info.card)) {
				// skip foreign current
			} else {
				const preview = readSessionPreview(mine.path, mtime);
				const existing = list.find((x) => x.id === mine.id || isSameSessionPath(x.path, mine.path));
				if (existing) {
					existing.current = true;
				} else {
					list.push({
						path: mine.path,
						id: mine.id,
						...(mine.name ? { name: mine.name } : {}),
						firstMessage: mine.firstMessage,
						modified: mtime,
						messageCount: mine.messageCount,
						current: true,
						...(preview ? { preview } : {}),
						cardName: info?.name || names.charName,
						...(info?.card ? { card: info.card } : cardPath ? { card: cardPath } : {}),
					});
				}
			}
		} else {
			// 惰性落盘：首条 assistant 前会话文件可能尚未出现在 SessionManager.list
			let cardName = names.charName;
			let boundCard = cardPath;
			try {
				const entries = session.sessionManager.getEntries() as Array<{
					type?: string;
					customType?: string;
					data?: { name?: string; card?: string };
				}>;
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e?.type === "custom" && e.customType === "rp-card") {
						if (typeof e.data?.name === "string" && e.data.name) cardName = e.data.name;
						if (typeof e.data?.card === "string" && e.data.card) boundCard = e.data.card;
						break;
					}
				}
			} catch {
				// 极早期生命周期：回落显示名
			}
			if (!boundCard || belongsHere(boundCard)) {
				let messageCount = 0;
				try {
					messageCount = session.messages?.length ?? 0;
				} catch {
					messageCount = 0;
				}
				list.push({
					path: curFile || "",
					id: curId,
					firstMessage: "",
					modified: Date.now(),
					messageCount,
					current: true,
					cardName,
					...(boundCard ? { card: boundCard } : {}),
				});
			}
		}
	}
	list.sort((a, b) => b.modified - a.modified);
	return list;
};

const listSessions = async (): Promise<ServerFrame> => ({ type: "sessions", list: await sessionInfos() });

// ---------- 会话文件辅助（预览/重命名/删除/搜索——面板重做 PLAN-PANELS §2.1） ----------

/** 读文件尾部若干字节（末条消息预览用；大会话不整读） */
const readFileTail = (path: string, bytes = 65536): string => {
	const fd = openSync(path, "r");
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		const n = readSync(fd, buf, 0, buf.length, start);
		return buf.toString("utf8", 0, n);
	} finally {
		closeSync(fd);
	}
};

/** 从会话条目提取正文文本（user/assistant 消息；其余条目返回 null） */
const entryMsgText = (entry: unknown): string | null => {
	const e = entry as { message?: unknown; role?: unknown; content?: unknown } | null;
	const m = (e?.message ?? e) as { role?: unknown; content?: unknown } | null;
	if (!m || (m.role !== "assistant" && m.role !== "user")) return null;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		const t = m.content
			.map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
			.filter(Boolean)
			.join(" ");
		return t || null;
	}
	return null;
};

const previewCache = new Map<string, { mtimeMs: number; text: string }>();

/** 末条消息预览（ST 过去聊天信息密度，借鉴项）：尾部扫描最后一条 user/assistant 正文 */
const readSessionPreview = (path: string, mtimeMs: number): string => {
	const cached = previewCache.get(path);
	if (cached && cached.mtimeMs === mtimeMs) return cached.text;
	let text = "";
	try {
		const lines = readFileTail(path).split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const t = entryMsgText(JSON.parse(line));
				if (t?.trim()) {
					text = t.replace(/\s+/g, " ").trim().slice(0, 80);
					break;
				}
			} catch {
				// 尾部截断的半行：跳过
			}
		}
	} catch {
		// 文件读取失败：无预览
	}
	previewCache.set(path, { mtimeMs, text });
	return text;
};

/** 校验路径确属本项目会话清单（所有会话文件操作的门），返回清单项 */
const assertListedSession = async (path: string) => {
	const all = await SessionManager.list(cwd);
	const found = all.find((s) => s.path === path);
	if (!found) throw new Error("不是本项目的会话文件");
	return found;
};

wss.on("connection", (ws, req) => {
	// 访问密码闸门：WS 与 REST 同一套 Cookie 凭据
	if (!requestAuthed(req)) {
		ws.close(4401, "unauthorized");
		return;
	}
	clients.add(ws);
	console.log("[ws] 客户端连接，当前连接数 " + clients.size);
	ws.send(JSON.stringify(helloFrame()));
	if (storyStreaming()) ws.send(JSON.stringify({ type: "agent", state: "start" } satisfies ServerFrame));
	// 助手面板：连接即对齐（busy 随帧携带，断线重连恢复生成中状态）
	ws.send(JSON.stringify(assistantHelloFrame()));
	// 在线更新状态：新连接即对齐（有新版/就绪时主页 chip 才能亮）
	if (updateState.phase !== "none")
		ws.send(JSON.stringify({ type: "update", update: { ...updateState, supervised: UPDATE_SUPERVISED } } satisfies ServerFrame));
	// 断线重连 / 新端接入：补发当前挂起的决策询问（未决卡不随 hello 历史走）
	for (const [id, p] of pendingChoices) ws.send(JSON.stringify(choiceFrame(id, p)));

	ws.on("message", (data) => {
		void (async () => {
			let frame: ClientFrame;
			try {
				frame = JSON.parse(String(data)) as ClientFrame;
			} catch {
				return;
			}
			try {
				switch (frame.type) {
					case "prompt": {
						const text = String(frame.text ?? "").trim();
						if (text) await handlePrompt(text);
						break;
					}
					case "abort": {
						// 强制停止：按下即收敛 UI/选择卡，再撕掉本拍（台上引擎 + 旧循环 + 委托中的 agent）
						for (const id of [...pendingChoices.keys()]) settleChoice(id, { stop: true });
						const assistant = agentHosts.get("assistant");
						const wasStreaming = storyStreaming() || (assistant?.isStreaming() ?? false);
						if (session.isStreaming) broadcast({ type: "agent", state: "end" });
						if (assistant?.isStreaming()) broadcast({ type: "assistant_state", state: "end" });
						stage.abort(); // 引擎自会以 aborted 谢幕（半拍正文保留）
						void session.abort().catch((err) => {
							console.error(`[liyuan] abort 失败：${err instanceof Error ? err.message : String(err)}`);
						});
						for (const [id, host] of agentHosts) {
							void host.abort().catch((err) => {
								console.error(
									`[liyuan] ${id === "assistant" ? "assistant abort(on story stop)" : `agent「${id}」abort(on story stop)`} 失败：${err instanceof Error ? err.message : String(err)}`,
								);
							});
						}
						if (!wasStreaming) {
							// 无流时仍可点停：无事发生
						}
						break;
					}
					case "reroll": {
						if (refuseWhileStreaming(ws, "重新生成")) return;
						const t = String(frame.text ?? "").trim();
						// 无参 = ST sibling 变体；有参 = 改用户文案后整轮重来（扩展 /reroll）
						await handlePrompt(t ? `/reroll ${t}` : "/reroll");
						break;
					}
					case "swipe": {
						if (refuseWhileStreaming(ws, "切换回复变体")) return;
						const dir = frame.dir === "prev" || frame.dir === "next" || frame.dir === "new" ? frame.dir : "next";
						await handleSwipe(dir);
						break;
					}
					case "compact":
						if (refuseWhileStreaming(ws, "压缩上下文")) return;
						await hostCompact();
						break;
					case "sessions":
						ws.send(JSON.stringify(await listSessions()));
						break;
					case "open": {
						if (refuseWhileStreaming(ws, "切换会话")) return;
						const path = String(frame.path ?? "");
						if (!path || path === session.sessionFile) return;
						await runtime.switchSession(path);
						// agent 对齐该剧情会话（有绑定则打开，无则新建，避免接着旧上下文；switchToStory 幂等）
						await syncAllAgentStories();
						if (agentHosts.has("assistant")) broadcast(assistantHelloFrame());
						broadcast({ type: "notify", level: "info", text: "已切换会话" });
						break;
					}
					case "new":
						if (refuseWhileStreaming(ws, "新建会话")) return;
						await runtime.newSession();
						// agent 对齐该剧情会话（有绑定则打开，无则新建，避免接着旧上下文；switchToStory 幂等）
						await syncAllAgentStories();
						if (agentHosts.has("assistant")) broadcast(assistantHelloFrame());
						broadcast({ type: "notify", level: "info", text: "已新建会话" });
						break;
					case "resync": {
						// P8：前端改完显示规则后请求全量重放 hello——所有端用新规则重渲当前消息。
						// 纯广播无写操作；流式时不响应（照相邻 case 的守卫模式，避免打断生成）。
						if (refuseWhileStreaming(ws, "刷新显示规则")) return;
						resyncAll();
						break;
					}
					case "choice_reply": {
						const id = String(frame.id ?? "");
						if (!pendingChoices.has(id)) return; // 已被他端应答/超时收敛
						if (frame.stop) {
							// 停止本回合：先收敛留痕（防重入），再中止当前生成，笔还给用户
							settleChoice(id, { stop: true });
							await session.abort();
						} else {
							const value = String(frame.value ?? "").trim();
							if (!value) return; // 空应答忽略，卡片保持未决
							settleChoice(id, { value });
						}
						break;
					}
					case "assistant_prompt": {
						const agentId = agentIdOf(frame);
						const host = agentHosts.get(agentId);
						if (!host) {
							// 内置助手未启动照旧广播警告；未知/未启动的自定义 agent 回错误帧
							if (agentId === "assistant") {
								broadcast({ type: "notify", level: "warning", text: "助手不可用（启动失败或没有可用模型），剧情不受影响" });
							} else {
								ws.send(JSON.stringify(agentUnavailableFrame(agentId) satisfies ServerFrame));
							}
							return;
						}
						const t = String(frame.text ?? "").trim();
						if (t) await promptAssistant(host, t);
						break;
					}
					case "assistant_abort": {
						const agentId = agentIdOf(frame);
						const host = agentHosts.get(agentId);
						if (!host) {
							if (agentId !== "assistant") ws.send(JSON.stringify(agentUnavailableFrame(agentId) satisfies ServerFrame));
							return; // 原语义：无助手无事发生
						}
						if (host.isStreaming()) {
							// agent 侧同样：先解锁前端 busy，再后台撕流
							broadcast({ type: "assistant_state", state: "end" });
						}
						void host.abort().catch((err) => {
							console.error(
								`[liyuan] ${agentId === "assistant" ? "assistant abort" : `agent「${agentId}」abort`} 失败：${err instanceof Error ? err.message : String(err)}`,
							);
						});
						break;
					}
					case "assistant_sessions": {
						const agentId = agentIdOf(frame);
						const host = agentHosts.get(agentId);
						if (!host) {
							if (agentId === "assistant") {
								// 原语义：助手未启动回空列表
								ws.send(JSON.stringify({ type: "assistant_sessions", list: [] } satisfies ServerFrame));
							} else {
								ws.send(JSON.stringify(agentUnavailableFrame(agentId) satisfies ServerFrame));
							}
							return;
						}
						const list = await host.listSessions();
						ws.send(JSON.stringify({ type: "assistant_sessions", list } satisfies ServerFrame));
						break;
					}
					case "assistant_open": {
						const agentId = agentIdOf(frame);
						const host = agentHosts.get(agentId);
						if (!host) {
							if (agentId !== "assistant") ws.send(JSON.stringify(agentUnavailableFrame(agentId) satisfies ServerFrame));
							return;
						}
						const path = String(frame.path ?? "");
						if (!path) return;
						try {
							await host.openSession(path);
							broadcast(agentHelloFrame(host));
							broadcast({ type: "notify", level: "info", text: "已切换助手历史" });
						} catch (err) {
							ws.send(
								JSON.stringify({
									type: "notify",
									level: "warning",
									text: err instanceof Error ? err.message : String(err),
								} satisfies ServerFrame),
							);
						}
						break;
					}
					case "assistant_delete": {
						const agentId = agentIdOf(frame);
						const host = agentHosts.get(agentId);
						if (!host) {
							if (agentId !== "assistant") ws.send(JSON.stringify(agentUnavailableFrame(agentId) satisfies ServerFrame));
							return;
						}
						const path = String(frame.path ?? "");
						if (!path) return;
						try {
							await host.deleteSession(path);
							const list = await host.listSessions();
							broadcast({ type: "assistant_sessions", list });
							broadcast({ type: "notify", level: "info", text: "已删除助手历史" });
						} catch (err) {
							ws.send(
								JSON.stringify({
									type: "notify",
									level: "warning",
									text: err instanceof Error ? err.message : String(err),
								} satisfies ServerFrame),
							);
						}
						break;
					}
					case "assistant_new": {
						const agentId = agentIdOf(frame);
						const host = agentHosts.get(agentId);
						if (!host) {
							if (agentId !== "assistant") ws.send(JSON.stringify(agentUnavailableFrame(agentId) satisfies ServerFrame));
							return;
						}
						if (host.isStreaming()) {
							ws.send(
								JSON.stringify({
									type: "notify",
									level: "warning",
									text: agentId === "assistant" ? "请等助手当前回复完成（或先停止），再开新对话" : "请等该 agent 当前回复完成（或先停止），再开新对话",
								} satisfies ServerFrame),
							);
							return;
						}
						await host.newConversation();
						broadcast(agentHelloFrame(host));
						broadcast({ type: "assistant_sessions", list: await host.listSessions() });
						break;
					}
					case "assistant_sync": {
						const agentId = agentIdOf(frame);
						const host = agentHosts.get(agentId);
						if (!host) {
							if (agentId === "assistant") {
								// 原语义：助手未启动也回空 hello
								ws.send(JSON.stringify(agentHelloFrame(null)));
							} else {
								ws.send(JSON.stringify(agentUnavailableFrame(agentId) satisfies ServerFrame));
							}
							return;
						}
						ws.send(JSON.stringify(agentHelloFrame(host)));
						break;
					}
					case "assistant_model": {
						const agentId = agentIdOf(frame);
						const host = agentHosts.get(agentId);
						if (!host) {
							if (agentId !== "assistant") ws.send(JSON.stringify(agentUnavailableFrame(agentId) satisfies ServerFrame));
							return;
						}
						const provider = typeof frame.provider === "string" ? frame.provider.trim() : "";
						const id = typeof frame.id === "string" ? frame.id.trim() : "";
						try {
							await host.setModel(provider && id ? { provider, id } : null);
							broadcast(agentHelloFrame(host));
						} catch (err) {
							ws.send(
								JSON.stringify({
									type: "notify",
									level: "error",
									text: err instanceof Error ? err.message : String(err),
								} satisfies ServerFrame),
							);
						}
						break;
					}
					// ---- JS Runner 程序化生成（ext_generate / ext_abort，D3 §5.10）----
					// 旁路 streamSimple（与 registerPlannerCaller 样板同款），不写会话树、不碰剧情链路；
					// 流式逐 delta 广播 ext_gen{start/delta/end|error}，前端 helper.ts 按 reqId 配对。
					case "ext_generate": {
						const reqId = frame.reqId;
						const params = frame.params;
						// 模型：params.model 可覆盖（modelRegistry 查找），缺省跟随剧情模型
						const model = (() => {
							if (params.model?.provider && params.model?.id) {
								const m = session.modelRegistry.find(params.model.provider, params.model.id);
								if (m) return m as never;
							}
							return session.model as never;
						})();
						if (!model) {
							broadcast({ type: "ext_gen", reqId, kind: "error", error: "尚无可用模型（未配置剧情模型）" });
							break;
						}
						const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
						if (!auth.ok) {
							broadcast({ type: "ext_gen", reqId, kind: "error", error: auth.error ?? `无法解析 ${String((model as { provider?: string }).provider)} 的 API key` });
							break;
						}
						const controller = new AbortController();
						extGenerateControllers.set(reqId, controller);
						broadcast({ type: "ext_gen", reqId, kind: "start" });
						try {
							const s = streamSimple(
								model,
								{
									systemPrompt: params.systemPrompt,
									messages: params.messages.map((m) => ({
										role: m.role,
										content: [{ type: "text", text: m.content }],
										timestamp: Date.now(),
									})),
								},
								{
									apiKey: auth.apiKey,
									headers: auth.headers,
									temperature: params.temperature,
									maxTokens: params.maxTokens ?? 4096,
									reasoning: params.reasoning,
									signal: controller.signal,
								},
							);
							let emitted = false;
							let gotErr = "";
							for await (const e of s) {
								if (e.type === "text_delta") {
									emitted = true;
									broadcast({ type: "ext_gen", reqId, kind: "delta", delta: e.delta });
								} else if (e.type === "done") {
									// 调试增强：JS Runner 旁路流结束但没有任何文本 delta（非预期）——统一接口打 WARNING
									if (!emitted && !gotErr) {
										debug.warning("side-text", "ext_generate 旁路流结束但未产出文本", {
											reqId,
											model: String((model as { id?: string }).id ?? ""),
										});
									}
									broadcast({ type: "ext_gen", reqId, kind: "end" });
								} else if (e.type === "error") {
									gotErr = e.error?.errorMessage || `stopReason=${e.error?.stopReason ?? "?"}`;
									// 调试增强：JS Runner 旁路返回 provider 错误——统一接口打 ERROR
									debug.error("side-text", "ext_generate 旁路 LLM 返回 provider 错误", {
										reqId,
										model: String((model as { id?: string }).id ?? ""),
										error: gotErr,
									});
									broadcast({ type: "ext_gen", reqId, kind: "error", error: gotErr });
								}
							}
						} finally {
							extGenerateControllers.delete(reqId);
						}
						break;
					}
					case "ext_abort": {
						// 中止对应生成流（AbortController）；stream 侧 emit error(aborted) → 广播 error 收尾
						const ctrl = extGenerateControllers.get(frame.reqId);
						if (ctrl) ctrl.abort();
						break;
					}
				}
			} catch (err) {
				broadcast({ type: "error", text: err instanceof Error ? err.message : String(err) });
			}
		})();
	});

	ws.on("close", () => {
		clients.delete(ws);
		console.log("[ws] 客户端断开，剩余 " + clients.size);
	});
	ws.on("error", () => {
		clients.delete(ws);
		console.log("[ws] 客户端错误断开，剩余 " + clients.size);
	});
});

// ---------- 启动 ----------

httpServer.listen(PORT, HOST, () => {
	const urls = [`http://localhost:${PORT}`];
	if (HOST === "0.0.0.0") {
		for (const list of Object.values(networkInterfaces())) {
			for (const ni of list ?? []) {
				if (ni.family === "IPv4" && !ni.internal) urls.push(`http://${ni.address}:${PORT}`);
			}
		}
	}
	console.log(`[liyuan] ${names.charName} 已就位（会话 ${session.sessionId.slice(0, 8)}…）`);
	console.log(`[liyuan] agent 目录 ${agentHome}`);
	for (const line of takeAgentMergeLog()) {
		console.log(`[liyuan] 迁移 ${line}`);
	}
	console.log(`[liyuan] ${urls.join("  |  ")}（手机连同一 Wi-Fi 访问后者；勿暴露公网）`);
});

const shutdown = async () => {
	try {
		unsubscribe?.();
		for (const ws of clients) ws.close();
		wss.close();
		httpServer.close();
		for (const host of agentHosts.values()) {
			try {
				await host.dispose();
			} catch {
				// 单个 agent 释放失败不影响整体退出
			}
		}
		await runtime.dispose();
	} finally {
		process.exit(0);
	}
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
