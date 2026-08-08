/**
 * REST 层（PLAN-PHASE3 §4）：面板 CRUD 走 /api/*，请求-响应形态；流内容继续走 WS wire。
 *
 * D3 纪律：本模块零 pi import——凡需要触碰 pi 的操作（模型/凭据/会话重载/换卡/命令），
 * 通过 main.ts 注入的 RestHost 接口（纯平面类型）完成；本模块自己只做
 * HTTP 路由 + liyuan.config.json / liyuan-preset.json / 世界书 / 角色卡的领域层文件操作。
 *
 * 写入纪律（PLAN-PHASE3 §4）：写 liyuan.config.json / 预设前先备份 .bak；
 * 触发会话重载的写操作在流式中一律拒绝（409）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

import {
	EMPTY_AGENT_CONFIG,
	deleteProfile,
	enableProfile,
	listProfiles,
	loadAgentConfig,
	loadProfile,
	materializeEnvKeysInConfig,
	mergeModelsById,
	migrateActiveConfigIntoProfiles,
	normalizeAgentConfig,
	normalizeModels,
	publicProvider,
	saveAgentConfig,
	saveProfile,
	seedProviderFromRuntime,
	syncAgentConfigToRuntime,
	type AgentModelEntry,
	type AgentProvider,
	type LiyuanAgentConfig,
} from "../src/agent-config.ts";
import {
	addCardGreeting,
	deleteCardGreeting,
	exportCardFile,
	loadCardFile,
	moveCardGreeting,
	readCardRawJson,
	remapGreetingIndexAfterMove,
	setCardGreetings,
	updateCardFields,
	updateCardGreeting,
	type CardExportLoreMode,
	type CardFieldPatch,
} from "../src/card.ts";
import {
	addGroup,
	addRule,
	buildCardFrontSnapshot,
	cardGroupsOf,
	cardOverridesOf,
	copyGroup,
	displayRules,
	ensureUngrouped,
	extractRegexScripts,
	moveGroup,
	moveRule,
	parseFindRegex,
	removeCardRuleOverride,
	removeGroup,
	removeRule,
	ruleKey,
	setCardGroups,
	setCardRuleOff,
	setCardRuleOverride,
	setSkinEnabled,
	setUserGroups,
	updateGroup,
	updateRule,
	userGroupsOf,
	type CardFrontSnapshot,
	type DisplayRule,
	type RuleGroup,
} from "../src/cardfront.ts";
import {
	appendCodexEntry,
	createCodex,
	deleteCodexEntry,
	findCodex,
	keysFromTitle,
	listCodexes,
	loadCodexEntries,
	userEntryToCodexInput,
} from "../src/codex.ts";
import { RP_COMMANDS } from "../src/commands.ts";
import {
	getMemoryStatus,
	memoryClearStore,
	memoryDeleteChunk,
	memoryImportText,
	memoryListChunks,
	memoryManualAdd,
	memoryReembedScope,
	memoryRemoveStore,
	memorySearch,
	probeCloudEmbed,
	updateMemoryConfig,
	updateStoreConfig,
} from "../src/memory/index.ts";
import { resolveConfigPath } from "../src/paths.ts";
import type { WorldlineView } from "../src/worldline.ts";
import {
	appendLorebookFileEntry,
	applyDisabledLore,
	deleteLorebookFileEntry,
	exportStLorebook,
	loadLorebookFile,
	loreFingerprint,
	mergeEntries,
	mountedLorebookPaths,
	normalizeEntries,
	overlayPathFor,
	patchLorebookFileEntry,
	searchEntries,
	setMountedLorebooks,
	type LoreEntryPatch,
} from "../src/lorebook.ts";
import {
	clearPersonaAvatar,
	createPersona,
	deletePersona,
	findPersona,
	loadPersonas,
	personaForCard,
	savePersonaAvatar,
	savePersonas,
	updatePersona,
	type Persona,
} from "../src/personas.ts";
import { convertStPreset, normalizeRpPreset, type RpPreset } from "../src/preset.ts";
import {
	allocateServerId,
	discoverMcpCatalog,
	getMcpHub,
	loadMcpConfig,
	probeMcpServer,
	saveMcpConfig,
	sanitizeServerId,
	setDefaultEnabled,
	validateServerConfig,
	type McpServerConfig,
} from "../src/mcp.ts";
import { listSkills, saveSkill } from "../src/skills.ts";
import { DEFAULT_CONFIG, type AgentBridgePermissions, type AgentConfig, type LorebookEntry, type RpConfig } from "../src/types.ts";
import { readJsonFile } from "../src/jsonio.ts";
import { formatBytes, listMedia, listUploads, saveUpload } from "../src/uploads.ts";
import { loadDrawConfig, newProviderId, normalizeDrawAspects, normalizeDrawProvider, saveDrawConfig } from "../src/draw/config.ts";
import { testNovelAiConnection } from "../src/draw/novelai.ts";
import { generateImage, enhanceImage, pngSizeOf } from "../src/draw/service.ts";
import { DrawError } from "../src/draw/errors.ts";
import { EXTDATA_SCOPES, getExtData, putExtData } from "../src/extdata.ts";
import { loadWardrobe, saveReferenceImage, saveWardrobe, upsertCharacter, type WardrobeFile } from "../src/wardrobe.ts";
import {
	appendVersion,
	cleanupExpired,
	deleteAllSlots,
	deleteSlot,
	deleteVersion,
	extractSlotIds,
	flushSlotStorePending,
	getSlotInfo,
	listSlotSummaries,
	loadSlotStore,
	saveAllSlots,
	saveSlot,
	saveSlotStoreNow,
	scanMediaDisk,
	setSelectedVersionIndex,
	tagsFromParams,
	updateVersionTags,
} from "../src/draw-plugins/draw-slot/slot-store.ts";
import { detectPresentCharacters, detectPresentCharactersWithAliases } from "../src/draw-plugins/draw-role/character-detect.ts";
import { resolveCharacterTags } from "../src/draw-plugins/draw-role/resolver.ts";
import {
	confirmLearnCharacter,
	dismissLearnCandidate,
	listLearnCandidates,
	recordUnknownCharacters,
} from "../src/draw-plugins/draw-role/learn-candidates.ts";
import {
	deleteTagGroup,
	exportTagGroups,
	getEnabledGroupTags,
	importTagGroups,
	loadTagGroups,
	saveTagGroup,
	setGlobalSelectedGroup,
	setTagGroupEnabled,
	type TagGroup,
} from "../src/draw-plugins/draw-role/tag-groups.ts";
import {
	getOnlineTagDbStatus,
	searchCharacters,
	searchTags,
	searchTagsWithOnline,
	updateOnlineTagDb,
} from "../src/draw-plugins/draw-role/tagdb.ts";
import { defaultPipelineDeps, getPlannerCaller } from "../src/draw-plugins/draw-pipeline/index.ts";
import { runPipeline } from "../src/draw-plugins/draw-pipeline/pipeline.ts";
import { buildRefineMessages, decomposeTags, extractRefinedScene } from "../src/draw-plugins/draw-edit/prompt-refine.ts";

// ---------- 宿主接口（由 main.ts 实现；纯平面类型，pi 止步于 main） ----------

export interface CurrentModelInfo {
	provider: string;
	id: string;
	name: string;
	thinkingLevel: string;
	availableLevels: string[];
	/** 当前模型上下文窗口（来自 models.json / 连接配置；默认 128000） */
	contextWindow: number;
	/** 单次最大输出（来自 models.json / 连接配置；缺省时 registry 用 16384） */
	maxTokens?: number;
}

export interface ModelInfo {
	provider: string;
	providerName: string;
	id: string;
	name: string;
	reasoning: boolean;
	/** 支持图片输入（上传图片可被该模型看见） */
	vision: boolean;
	contextWindow: number;
	maxTokens?: number;
}

export interface AuthProviderInfo {
	provider: string;
	displayName: string;
	/** 已写入 auth.json（可「移除已存 key」） */
	configured: boolean;
	/**
	 * 当前是否真正可用（stored / 环境变量已设 / runtime key 等）。
	 * 注意：pi 的 getAuthStatus().configured 对「仅环境变量」恒为 false，
	 * 列表展示必须以 ready 为准，否则 DeepSeek 等会沉进「未配置」。
	 */
	ready: boolean;
	/** 凭据来源（stored/environment/models_json_key…） */
	source?: string;
	/** 环境变量名等提示（如 DEEPSEEK_API_KEY） */
	label?: string;
	modelCount: number;
}

/** 运行时渠道快照（用于空配置时收编当前正在用的渠道） */
export interface ProviderRuntimeSnapshot {
	provider: string;
	baseUrl?: string;
	api?: string;
	/** 环境变量名（无 $），如 DEEPSEEK_API_KEY */
	envKey?: string;
	models: Array<{
		id: string;
		name?: string;
		reasoning?: boolean;
		contextWindow?: number;
		maxTokens?: number;
	}>;
}

export interface RestHost {
	cwd: string;
	isStreaming(): boolean;
	listModels(): { current: CurrentModelInfo | null; models: ModelInfo[] };
	selectModel(provider: string, id: string): Promise<CurrentModelInfo>;
	setThinkingLevel(level: string): CurrentModelInfo;
	authProviders(): AuthProviderInfo[];
	setAuthKey(provider: string, key: string): void;
	removeAuth(provider: string): void;
	/** runtime agent 目录（同步用，不对用户暴露） */
	agentDir(): string;
	/** 取某 provider 的运行时模型/端点快照 */
	providerSnapshot(provider: string): ProviderRuntimeSnapshot | null;
	refreshModels(): void;
	/** 会话重载（session_start 重放，素材重装）+ 服务端显示名刷新 + 全端对齐 */
	reloadSession(): Promise<void>;
	/**
	 * 热更新：扩展内重读 config/卡/世界书/预设并重建 system prompt，不 session.reload。
	 * 用于切身份、改 user 设定、挂载世界书等——ST 式即时生效。
	 */
	softRefreshConfig(): Promise<void>;
	/** 自定义 agent 管理界面工具清单（stagehand 工具 + 内置 read/bash/edit/write） */
	listAgentTools(): string[];
	/**
	 * agents 热重建（PUT /api/config 的 agents 段写盘后触发）：
	 * 返回 agentId → 状态：ok=已生成 / busy=忙碌跳过待下次重启 / removed=已删除。
	 * 内置助手（assistant）不在管理范围，永不参与删除/变更。
	 */
	reloadAgents(): Promise<Record<string, "ok" | "busy" | "removed">>;
	/**
	 * 分支角色消息编辑（前端改写/删除回复）：lastRoleIndex=从分支末尾倒数第 N 条角色消息
	 * （0=最后一条），op=edit 注入 rp-edited-reply（原文保留在分支树内），op=delete 只钉叶到前驱。
	 */
	scriptEditMessage(input: {
		lastRoleIndex?: number;
		branchIndex?: number;
		op: "edit" | "delete";
		text?: string;
	}): Promise<void>;
	/** config.card 已写盘后调用：切到该卡最近会话，无则新建 */
	switchToCard(): Promise<"switched" | "created">;
	/** 经会话通道执行斜杠命令（/import 等，扩展的 notify 会以 wire notify 推送） */
	promptCommand(text: string): Promise<void>;
	/** 排队执行斜杠命令（不等待完成；流式中自动排到本轮结束）。返回是否进入了排队 */
	queueCommand(text: string): boolean;
	/** 面板导入（柱 2 liyuan-panels 格式）：写盘并 await panelsync 收编扩展内存 */
	importPanels(list: Array<{ name?: unknown; kind?: unknown; content?: unknown }>): Promise<{
		imported: number;
		names: string[];
		errors: string[];
	}>;
	/** 用户收起/删除面板（同 panel_close：归档出活跃列表，盘上保留，同名重写可重开） */
	closePanel(name: string): Promise<void>;
	/**
	 * 用户手改面板 content（A：通用源码编辑）。
	 * 须已有活跃面板；kind 可改（默认保留原 kind）。写盘 + 收编扩展内存 + 树快照。
	 */
	savePanel(input: {
		name: string;
		content: string;
		kind?: string;
	}): Promise<{ name: string; kind: string; updatedAt: number }>;
	/** 当前剧情分支上挂载的知识库名（会话树 rp-codex 快照，随 rewind/fork 走） */
	mountedCodexes(): string[];
	// ---- 会话管理（PLAN-PANELS §2.1，main.ts 实现） ----
	sessions(): Promise<SessionInfoLite[]>;
	renameSession(path: string, name: string): Promise<void>;
	deleteSession(path: string): Promise<void>;
	/** 删除绑定某张卡的全部会话文件（删卡「相关数据」用；当前打开的会话不动） */
	deleteCardSessions(cardRel: string): Promise<number>;
	readSessionFile(path: string): Promise<string>;
	searchSessions(q: string): Promise<SessionSearchHit[]>;
	/** 世界状态用户主权编辑（applyPatch 语义，落盘+ await statesync） */
	applyStatePatch(patch: Record<string, unknown>): Promise<{ applied: string[]; warnings: string[] }>;
	/** 世界状态只读（当前分支账本；与 applyStatePatch 同源；未就绪返回 null） */
	worldState(): import("../src/types.ts").WorldState | null;
	/** 手动触发生图管线并嵌入当前分支最新剧情消息（配图按钮）；无宿主能力时缺省（路由回退纯管线结果）。
	 *  anchor（选填）：用户指定的正文短原文片段——第一张图挂接位置用它（LWB anchor 设计） */
	manualPipelineRun?(text: string, anchor?: string): Promise<{
		ok: boolean;
		error?: string;
		/** 管线是否实际执行（false = 被跳过/未执行，reason 说明） */
		ran?: boolean;
		/** 未执行或失败的原因 */
		reason?: string;
		slots?: { slotId: string; src: string; index: number }[];
		warnings?: string[];
		embedded?: boolean;
	}>;
	/**
	 * 从当前分支全部消息正文剥离指定 slotId 的 [image:slotId] 占位符并保存（删除所有图时用）；
	 * 返回实际改动条数
	 */
	stripStoryPlaceholders?(slotIds: string[]): Promise<{ stripped: number; errors?: string[] }>;
	notify(level: "info" | "warning" | "error", text: string): void;
	/** 世界线时间线视图（会话树 rp-save + 旁路 meta） */
	worldlineView(): import("../src/worldline.ts").WorldlineView;
	/** 软删除存档节点 */
	deleteWorldlineSave(saveId: string): void;
	/** 重命名世界线（自动名可改） */
	renameWorldline(worldlineId: string, name: string): void;
	/** 文生音并写入会话（气泡「配音」/ REST） */
	ttsSpeak(text: string, caption?: string): Promise<{ src: string; bytes: number }>;
	/** 向量记忆作用域：当前角色卡 + 当前对话（换卡/新对话 = 独立库） */
	memoryScope(): { sessionId: string; card?: string };
	// ---- 在线更新（主页 chip → 弹窗 → toast；状态经 WS update 帧推送） ----
	/** 手动检查（启动已静默查过一次；这里给弹窗里的重试） */
	updateCheckNow(): Promise<void>;
	/** 开始下载暂存（mirror=镜像前缀，空=直连）；进度经 WS 推送 */
	updateDownload(mirror?: string): Promise<void>;
	/** 丢弃已暂存的更新 */
	updateDiscard(): void;
	/** 重启进程应用更新（启动脚本包裹下：退出后由脚本循环重拉） */
	updateRestart(): void;
}

export interface SessionInfoLite {
	path: string;
	id: string;
	name?: string;
	firstMessage: string;
	modified: number;
	messageCount: number;
	current: boolean;
	preview?: string;
	cardName?: string;
}

export interface SessionSearchHit {
	path: string;
	name?: string;
	firstMessage: string;
	modified: number;
	messageCount: number;
	snippet: string;
	current: boolean;
}

// ---------- 基础工具 ----------

const MAX_BODY = 32 * 1024 * 1024; // ST 聊天记录/预设上传上限 32MB
const MAX_UPLOAD = 64 * 1024 * 1024; // 上传区文件上限 64MB

function readBodyRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > maxBytes) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function readBody(req: IncomingMessage): Promise<string> {
	return readBodyRaw(req, MAX_BODY).then((b) => b.toString("utf8"));
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
	res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(obj));
}

const resolvePath = (cwd: string, p: string) => (isAbsolute(p) ? p : join(cwd, p));

/** 带 .bak 备份的 JSON 写盘（tab 缩进，与手写配置一致） */
export function writeJsonWithBackup(path: string, data: unknown): void {
	if (existsSync(path)) copyFileSync(path, `${path}.bak`);
	writeFileSync(path, JSON.stringify(data, null, "\t") + "\n", "utf8");
}

// ---------- 配置读写 ----------

export const configPath = (cwd: string) => resolveConfigPath(cwd);

export function loadConfig(cwd: string): RpConfig {
	const p = configPath(cwd);
	if (!existsSync(p)) return { ...DEFAULT_CONFIG };
	const raw = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<RpConfig>) };
	// 规范化：旧 lorebook 单本 → lorebooks 数组；agents 段读盘容错
	const normalized = { ...raw, agents: normalizeAgents(raw.agents) };
	return setMountedLorebooks(normalized, mountedLorebookPaths(normalized));
}

/**
 * 一档皮肤快照(hello 与 GET /api/cardfront 唯一组装点)。
 * 读盘失败不抛:无皮肤即可,前端清空 cardSkin。
 */
export function loadCardFrontSnapshot(cwd: string): CardFrontSnapshot {
	const config = loadConfig(cwd);
	const abs = resolvePath(cwd, config.card);
	let raw: Record<string, unknown> | null = null;
	let charName = "";
	try {
		raw = readCardRawJson(abs).raw as Record<string, unknown>;
		charName = loadCardFile(abs).name;
	} catch {
		try {
			charName = loadCardFile(abs).name;
		} catch {
			/* ignore */
		}
	}
	// 预设正则分组随快照透出（loadEffectivePreset 已保证 regexGroups 从预设文件本体透出，不随草稿）
	const preset = loadEffectivePreset(cwd).preset;
	return buildCardFrontSnapshot(config, raw, charName, preset?.regexGroups);
}

// ---------- 正则分组作用域读写（global|card|preset；三分类共用的存储助手） ----------

/** scope 参数解析（global|card|preset），非法抛中文错（由 handleApiRequest 统一回 400） */
function assertGroupScope(v: string | null): "global" | "card" | "preset" {
	if (v === "global" || v === "card" || v === "preset") return v;
	throw new Error("scope 必须为 global / card / preset");
}

/**
 * 读指定作用域的组列表（纯读，不写盘）。
 * - global: config.userRuleGroups（含旧 userRules 迁移）
 * - card:   config.cardRuleGroups[card]，附带 card 的卡内嵌规则全量（已应用覆盖层）+ 关闭键 + 覆盖键
 * - preset: 预设文件本体里的 regexGroups（不碰 preset-override.json 草稿）；无活跃预设时 groups 空、preset=null
 * 三个 scope 返回前均 ensureUngrouped（只读补，不落盘）：全新配置前端才能 openNewRule(0)。
 */
function readGroupScope(
	cwd: string,
	scope: "global" | "card" | "preset",
	card: string | null,
): {
	groups: RuleGroup[];
	card?: { path: string; cardRules: DisplayRule[]; ruleOff: string[]; overrides: string[] };
	preset?: { file: string; name: string } | null;
} {
	if (scope === "global") return { groups: ensureUngrouped(userGroupsOf(loadConfig(cwd))) };
	if (scope === "card") {
		if (!card) throw new Error("scope=card 时缺少 card 参数");
		const config = loadConfig(cwd);
		return {
			groups: ensureUngrouped(cardGroupsOf(config, card)),
			card: cardFrontCardState(cwd, card),
		};
	}
	// preset：直接读预设文件本体
	const config = loadConfig(cwd);
	if (!config.preset) return { groups: ensureUngrouped([]), preset: null };
	try {
		const p = resolvePath(cwd, config.preset);
		if (!existsSync(p)) return { groups: ensureUngrouped([]), preset: null };
		const raw = JSON.parse(readFileSync(p, "utf8")) as { name?: string; regexGroups?: unknown };
		return {
			groups: ensureUngrouped(Array.isArray(raw.regexGroups) ? (raw.regexGroups as RuleGroup[]) : []),
			preset: { file: config.preset, name: typeof raw.name === "string" ? raw.name : "preset" },
		};
	} catch {
		return { groups: ensureUngrouped([]), preset: null };
	}
}

/**
 * 某卡的 card 段最新状态（卡内嵌规则已应用覆盖层 + 关闭键 + 覆盖键）。
 * 供 GET groups?scope=card 的 card 段与 PUT/DELETE /api/cardfront/cardrule 返回值共用，前端直接替换。
 */
function cardFrontCardState(cwd: string, card: string): { path: string; cardRules: DisplayRule[]; ruleOff: string[]; overrides: string[] } {
	const config = loadConfig(cwd);
	let rawRules: DisplayRule[] = [];
	try {
		const abs = resolvePath(cwd, card);
		rawRules = displayRules(extractRegexScripts(readCardRawJson(abs).raw as Record<string, unknown>));
	} catch {
		/* 卡不可读则规则空 */
	}
	const overrides = cardOverridesOf(config, card);
	const cardRules = rawRules.map((r) => overrides[ruleKey(r)] ?? r);
	return {
		path: card,
		cardRules,
		ruleOff: (config.cardRuleOff ?? {})[card] ?? [],
		overrides: Object.keys(overrides),
	};
}

/** 写指定作用域的组列表（全量替换） */
function writeGroupScope(cwd: string, scope: "global" | "card" | "preset", card: string | null, groups: RuleGroup[]): void {
	if (scope === "global") {
		writeJsonWithBackup(configPath(cwd), setUserGroups(loadConfig(cwd), groups));
		return;
	}
	if (scope === "card") {
		if (!card) throw new Error("scope=card 时缺少 card 参数");
		writeJsonWithBackup(configPath(cwd), setCardGroups(loadConfig(cwd), card, groups));
		return;
	}
	// preset：只写预设文件本体里的 regexGroups（保留其余字段），不碰 preset-override.json 草稿
	const config = loadConfig(cwd);
	if (!config.preset) throw new Error("未选择预设");
	const p = resolvePath(cwd, config.preset);
	if (!existsSync(p)) throw new Error(`预设文件不存在：${config.preset}`);
	const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
	writeJsonWithBackup(p, { ...raw, regexGroups: groups });
}

/** POST/PUT 规则 body 白名单字段校验；非法类型/越界抛中文错（由 handleApiRequest 统一回 400） */
function validateRuleBodyFields(body: Record<string, unknown>): {
	name?: string;
	disabled?: boolean;
	trimStrings?: string[];
	placement?: number[];
	runOnEdit?: boolean;
	substituteRegex?: 0 | 1 | 2;
	minDepth?: number | null;
	maxDepth?: number | null;
	markdownOnly?: boolean;
	promptOnly?: boolean;
} {
	const out: {
		name?: string;
		disabled?: boolean;
		trimStrings?: string[];
		placement?: number[];
		runOnEdit?: boolean;
		substituteRegex?: 0 | 1 | 2;
		minDepth?: number | null;
		maxDepth?: number | null;
		markdownOnly?: boolean;
		promptOnly?: boolean;
	} = {};
	if (body.name !== undefined) {
		if (typeof body.name !== "string") throw new Error("name 必须是字符串");
		out.name = body.name.trim();
	}
	// disabled：统一开关字段；兼容旧 off（收到 off 也转存为 disabled）
	if (body.disabled !== undefined || body.off !== undefined) {
		if (body.disabled !== undefined && typeof body.disabled !== "boolean") throw new Error("disabled 必须是布尔值");
		if (body.off !== undefined && typeof body.off !== "boolean") throw new Error("off 必须是布尔值");
		out.disabled = body.disabled !== undefined ? body.disabled : body.off;
	}
	if (body.trimStrings !== undefined) {
		if (!Array.isArray(body.trimStrings) || body.trimStrings.some((x) => typeof x !== "string")) {
			throw new Error("trimStrings 必须是字符串数组（编辑器回车分隔）");
		}
		out.trimStrings = body.trimStrings.filter((x) => x.length > 0);
	}
	if (body.placement !== undefined) {
		if (!Array.isArray(body.placement)) throw new Error("placement 必须是数字数组（1/2/3/5/6）");
		if (body.placement.length === 0) throw new Error("placement 不能为空数组");
		const ok = [1, 2, 3, 5, 6];
		if (body.placement.some((x) => typeof x !== "number" || !ok.includes(x))) {
			throw new Error("placement 只允许 1/2/3/5/6（1=用户输入/2=AI输出/3=快捷命令/5=世界信息/6=推理）");
		}
		out.placement = body.placement as number[];
	}
	if (body.runOnEdit !== undefined) {
		if (typeof body.runOnEdit !== "boolean") throw new Error("runOnEdit 必须是布尔值");
		out.runOnEdit = body.runOnEdit;
	}
	if (body.substituteRegex !== undefined) {
		if (body.substituteRegex !== 0 && body.substituteRegex !== 1 && body.substituteRegex !== 2) {
			throw new Error("substituteRegex 必须为 0/1/2（0=不替换 1=raw 2=escaped）");
		}
		out.substituteRegex = body.substituteRegex as 0 | 1 | 2;
	}
	for (const k of ["minDepth", "maxDepth"] as const) {
		if (body[k] !== undefined) {
			const v = body[k];
			if (v === null) {
				out[k] = null;
				continue;
			}
			if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} 必须是数字或 null`);
			if (v < 0) throw new Error(`${k} 不能为负数`);
			out[k] = v;
		}
	}
	if (body.markdownOnly !== undefined) {
		if (typeof body.markdownOnly !== "boolean") throw new Error("markdownOnly 必须是布尔值");
		out.markdownOnly = body.markdownOnly;
	}
	if (body.promptOnly !== undefined) {
		if (typeof body.promptOnly !== "boolean") throw new Error("promptOnly 必须是布尔值");
		out.promptOnly = body.promptOnly;
	}
	return out;
}

// ---------- 自定义 agent 段（DESIGN-custom-agents §2：声明式配置 + 校验） ----------

/** agent id 合法形状：小写字母开头，后接小写字母/数字/连字符 */
const AGENT_ID_RE = /^[a-z][a-z0-9-]*$/;

/** bridge 权限键白名单（与 AgentBridgePermissions 一一对应；不认未知键） */
const BRIDGE_PERM_KEYS = [
	"readStory",
	"writePanels",
	"storyEdit",
	"queueCommand",
	"applyStatePatch",
	"emitMedia",
	"refreshMaterials",
	"mountCodex",
	"embedStoryImage",
] as const;

/**
 * 归一化 agents 段（loadConfig 读盘时容错）：
 * - 非数组 / 空值 → [];
 * - 每个条目：非对象或 id 非法则丢弃（写盘校验已在上游 applyConfigPatch 把关，这里只兜底手改的脏数据）；
 * - 缺省桥权限全部补 false、缺省 skills/tools 补空数组、缺省 name 回退 id、缺省 model 不设（跟随剧情模型）。
 */
export function normalizeAgents(input: unknown): AgentConfig[] {
	if (!Array.isArray(input)) return [];
	const out: AgentConfig[] = [];
	for (const item of input) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const a = item as Record<string, unknown>;
		const id = typeof a.id === "string" ? a.id.trim() : "";
		if (!AGENT_ID_RE.test(id)) continue;
		const bridge = (typeof a.bridge === "object" && a.bridge !== null ? a.bridge : {}) as Record<string, unknown>;
		const perms: AgentBridgePermissions = {
			readStory: bridge.readStory === true,
			writePanels: bridge.writePanels === true,
			storyEdit: bridge.storyEdit === true,
			queueCommand: bridge.queueCommand === true,
			applyStatePatch: bridge.applyStatePatch === true,
			emitMedia: bridge.emitMedia === true,
			refreshMaterials: bridge.refreshMaterials === true,
			mountCodex: bridge.mountCodex === true,
			embedStoryImage: bridge.embedStoryImage === true,
		};
		const m = a.model;
		const model =
			typeof m === "object" &&
			m !== null &&
			typeof (m as { provider?: unknown }).provider === "string" &&
			typeof (m as { id?: unknown }).id === "string"
				? { provider: (m as { provider: string }).provider, id: (m as { id: string }).id }
				: undefined;
		out.push({
			id,
			name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : id,
			...(typeof a.description === "string" ? { description: a.description } : {}),
			...(model ? { model } : {}),
			...(typeof a.prompt === "string" ? { prompt: a.prompt } : {}),
			...(typeof a.promptFile === "string" ? { promptFile: a.promptFile } : {}),
			skills: Array.isArray(a.skills) ? a.skills.filter((x): x is string => typeof x === "string") : [],
			tools: Array.isArray(a.tools) ? a.tools.filter((x): x is string => typeof x === "string") : [],
			bridge: perms,
		});
	}
	return out;
}

/** 校验 bridge 为完整权限对象（8 键全 boolean，不认未知键）；非法抛错（中文） */
function validateBridge(input: unknown, id: string): AgentBridgePermissions {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error(`agent「${id}」缺少 bridge 权限对象`);
	}
	const b = input as Record<string, unknown>;
	const out = {} as AgentBridgePermissions;
	for (const key of BRIDGE_PERM_KEYS) {
		if (typeof b[key] !== "boolean") {
			throw new Error(`agent「${id}」bridge.${key} 必须是布尔值（bridge 须为完整权限对象，每个键都显式声明）`);
		}
		out[key] = b[key];
	}
	const unknownKeys = Object.keys(b).filter((k) => !(BRIDGE_PERM_KEYS as readonly string[]).includes(k));
	if (unknownKeys.length > 0) {
		throw new Error(`agent「${id}」bridge 含未知键：${unknownKeys.join("、")}（仅支持 ${BRIDGE_PERM_KEYS.join("/")}）`);
	}
	return out;
}

/** 校验可选字符串数组字段；未提供返回 undefined，提供但非字符串数组则抛错 */
function validateStringArray(input: unknown, id: string, field: string): string[] | undefined {
	if (input === undefined) return undefined;
	if (!Array.isArray(input) || input.some((x) => typeof x !== "string")) {
		throw new Error(`agent「${id}」的 ${field} 必须是字符串数组`);
	}
	return input as string[];
}

/**
 * 自定义 agent 段严格校验（applyConfigPatch 入口）：
 * 任一 agent 非法即抛错拒绝整段（DESIGN-custom-agents §2：不静默丢弃/截断）——
 * 权限配置宁缺毋滥，宁可整段拒绝让用户修正，也不能悄悄丢掉越权开关。
 */
function validateAgentsPatch(input: unknown): AgentConfig[] {
	if (!Array.isArray(input)) throw new Error("agents 必须是数组");
	const seen = new Set<string>();
	const out: AgentConfig[] = [];
	for (const item of input) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new Error("agents 内每个条目必须是对象");
		}
		const a = item as Record<string, unknown>;
		// id：必填，/^[a-z][a-z0-9-]*$/、整段内唯一
		const id = typeof a.id === "string" ? a.id.trim() : "";
		if (!id) throw new Error("agent 条目缺少必填字段 id");
		if (!AGENT_ID_RE.test(id)) {
			throw new Error(`agent id「${id}」非法：须匹配 /^[a-z][a-z0-9-]*$/（小写字母开头，后接小写字母/数字/连字符）`);
		}
		if (seen.has(id)) throw new Error(`agent id 重复：「${id}」`);
		seen.add(id);
		// name：必填非空字符串（面板显示名）
		const name = typeof a.name === "string" ? a.name.trim() : "";
		if (!name) throw new Error(`agent「${id}」缺少必填字段 name`);
		const description = typeof a.description === "string" ? a.description : undefined;
		// model：可选，提供则必须是 { provider, id } 形（缺省跟随剧情模型）
		let model: { provider: string; id: string } | undefined;
		if (a.model !== undefined) {
			const m = a.model as { provider?: unknown; id?: unknown } | null;
			if (
				!m ||
				typeof m !== "object" ||
				typeof m.provider !== "string" ||
				!m.provider ||
				typeof m.id !== "string" ||
				!m.id
			) {
				throw new Error(`agent「${id}」的 model 必须是 { provider, id } 对象`);
			}
			model = { provider: m.provider, id: m.id };
		}
		// prompt 与 promptFile 二选一（不认同时提供）
		const prompt = a.prompt !== undefined ? a.prompt : undefined;
		const promptFile = a.promptFile !== undefined ? a.promptFile : undefined;
		if (prompt !== undefined || promptFile !== undefined) {
			if (typeof prompt !== "string" && prompt !== undefined) {
				throw new Error(`agent「${id}」的 prompt 必须是字符串`);
			}
			if (typeof promptFile !== "string" && promptFile !== undefined) {
				throw new Error(`agent「${id}」的 promptFile 必须是字符串`);
			}
			if (typeof prompt === "string" && typeof promptFile === "string") {
				throw new Error(`agent「${id}」的 prompt 与 promptFile 不能同时提供（二选一）`);
			}
		}
		const skills = validateStringArray(a.skills, id, "skills") ?? [];
		const tools = validateStringArray(a.tools, id, "tools") ?? [];
		const bridge = validateBridge(a.bridge, id);
		out.push({
			id,
			name,
			...(description !== undefined ? { description } : {}),
			...(model ? { model } : {}),
			...(typeof prompt === "string" ? { prompt } : {}),
			...(typeof promptFile === "string" ? { promptFile } : {}),
			skills,
			tools,
			bridge,
		});
	}
	return out;
}

/** config PUT 白名单（card 不在内：换卡必须走 /api/card/switch 的完整流程） */
const CONFIG_EDITABLE = new Set([
	"userName",
	"userPersona",
	"displayName",
	"language",
	"scanDepth",
	"maxLoreInjections",
	"greeting",
	"greetingIndex",
	"importStripTags",
	"lorebook",
	"lorebooks",
	"preset",
	"disabledLore",
	"backendControl",
	"creationMode",
	"assistantModel",
	"agents",
	"plugins",
]);

export function applyConfigPatch(config: RpConfig, patch: Record<string, unknown>): RpConfig {
	const next = { ...config } as Record<string, unknown>;
	for (const [k, v] of Object.entries(patch)) {
		if (!CONFIG_EDITABLE.has(k)) continue;
		if (k === "agents") {
			// 自定义 agent 段：空值 = 清除全部 agent；否则严格校验，任一非法即抛错拒绝整段（设计 §2）
			if (v === null || v === undefined || v === "") {
				delete next[k];
			} else {
				next[k] = validateAgentsPatch(v);
			}
			continue;
		}
		if (v === null || v === undefined || v === "") {
			delete next[k]; // 空值 = 删除可选键（displayName/lorebook/preset 等）
		} else {
			next[k] = v;
		}
	}
	// 必填字段兜底
	if (typeof next.userName !== "string" || !next.userName) next.userName = DEFAULT_CONFIG.userName;
	if (typeof next.language !== "string" || !next.language) next.language = DEFAULT_CONFIG.language;
	next.scanDepth = clampInt(next.scanDepth, 1, 50, DEFAULT_CONFIG.scanDepth);
	next.maxLoreInjections = clampInt(next.maxLoreInjections, 0, 20, DEFAULT_CONFIG.maxLoreInjections);
	// 固定楼层压缩周期：0=关闭主动压缩；上限防手滑（500 轮≈永不触发）
	next.compactEveryNTurns = clampInt(next.compactEveryNTurns, 0, 500, DEFAULT_CONFIG.compactEveryNTurns ?? 30);
	next.greeting = next.greeting === true;
	// 决策门禁档位：只认 ask / silent；非法值删除（扩展缺省按 silent）
	if (next.creationMode !== "ask" && next.creationMode !== "silent") delete next.creationMode;
	// 助手模型：只认 { provider, id } 形；非法值删除（缺省=跟随剧情模型）
	if (next.assistantModel !== undefined) {
		const am = next.assistantModel as { provider?: unknown; id?: unknown } | null;
		if (
			!am ||
			typeof am !== "object" ||
			typeof am.provider !== "string" ||
			!am.provider ||
			typeof am.id !== "string" ||
			!am.id
		) {
			delete next.assistantModel;
		} else {
			next.assistantModel = { provider: am.provider, id: am.id };
		}
	}
	// 挂载书：lorebooks 数组优先；兼容旧单本 lorebook
	const paths = mountedLorebookPaths(next as RpConfig);
	Object.assign(next, setMountedLorebooks(next as RpConfig, paths));
	return next as unknown as RpConfig;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
	const n = typeof v === "number" ? Math.round(v) : Number.parseInt(String(v), 10);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(max, Math.max(min, n));
}

// ---------- 世界书（服务端只读副本，与扩展同一装配路径） ----------

export type LoreSource = "card" | "file" | "agent";

/**
 * 世界书装配：已挂载独立书（0..N 本）+ agent 补充设定集。
 * 卡内 character_book **不**自动进上下文——须导入为独立书并挂载（config.lorebooks）。
 * 角色卡与世界书解耦：换卡不改挂载列表。
 * source：file=挂载书 / agent=补充设定。
 */
function loadMergedLoreWithSource(
	cwd: string,
	config: RpConfig,
): {
	entries: LorebookEntry[];
	sourceOf: (e: LorebookEntry) => LoreSource;
	cardName: string;
	paths: string[];
} {
	const card = loadCardFile(resolvePath(cwd, config.card));
	const paths = mountedLorebookPaths(config);
	const fileGroups: LorebookEntry[][] = [];
	for (const rel of paths) {
		const abs = resolvePath(cwd, rel);
		if (existsSync(abs)) fileGroups.push(loadLorebookFile(abs));
	}
	const fileEntries = mergeEntries(...fileGroups);
	const overlayPath = overlayPathFor(cwd, card.name);
	const overlayEntries = existsSync(overlayPath) ? loadLorebookFile(overlayPath) : [];
	const fileSet = new Set(fileEntries.map((e) => e.content.trim()));
	const entries = applyDisabledLore(mergeEntries(fileEntries, overlayEntries), config.disabledLore);
	const sourceOf = (e: LorebookEntry): LoreSource => (fileSet.has(e.content.trim()) ? "file" : "agent");
	return { entries, sourceOf, cardName: card.name, paths };
}

export function loadMergedLore(cwd: string, config: RpConfig): LorebookEntry[] {
	return loadMergedLoreWithSource(cwd, config).entries;
}

/**
 * 导出用活跃世界书：挂载书 + 补充设定 + 卡原内嵌（指纹去重）+ 用户停用清单。
 * 即「改过角色卡/世界书之后」的创作态，便于分享回 ST / 再导入梨园。
 */
function collectActiveLoreForExport(cwd: string, config: RpConfig): LorebookEntry[] {
	const card = loadCardFile(resolvePath(cwd, config.card));
	const { entries: active } = loadMergedLoreWithSource(cwd, config);
	return applyDisabledLore(mergeEntries(active, card.book), config.disabledLore);
}

const previewText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------- 卡库（PLAN-PANELS §2.7）：扫描候选目录，卡头信息按 mtime 缓存 ----------

const cardMetaCache = new Map<string, { mtimeMs: number; meta: { name: string; tags: string[] } | null }>();

/** 卡库扫描目录：assets/cards + 当前卡所在目录（用户素材常在项目外） */
function cardDirSpecs(cwd: string, config: RpConfig): Array<{ abs: string; relBase: string }> {
	const specs = [{ abs: join(cwd, "assets", "cards"), relBase: "assets/cards" }];
	const cardRel = config.card.replace(/\\/g, "/");
	const base = cardRel.includes("/") ? cardRel.slice(0, cardRel.lastIndexOf("/")) : ".";
	const abs = resolvePath(cwd, base);
	if (!specs.some((s) => s.abs === abs)) specs.push({ abs, relBase: base });
	return specs;
}

interface CardLibItem {
	path: string;
	name: string;
	tags: string[];
	isPng: boolean;
	mtimeMs: number;
}

function listCardLibrary(cwd: string, config: RpConfig): CardLibItem[] {
	const out: CardLibItem[] = [];
	for (const spec of cardDirSpecs(cwd, config)) {
		if (!existsSync(spec.abs)) continue;
		for (const f of readdirSync(spec.abs)) {
			if (!/\.(png|json)$/i.test(f)) continue;
			const abs = join(spec.abs, f);
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(abs).mtimeMs;
			} catch {
				continue;
			}
			const cached = cardMetaCache.get(abs);
			let meta = cached && cached.mtimeMs === mtimeMs ? cached.meta : undefined;
			if (meta === undefined) {
				try {
					const c = loadCardFile(abs);
					// 卡名为空视为非角色卡（同目录常混有预设等其他 JSON）
					meta = c.name.trim() ? { name: c.name, tags: c.tags } : null;
				} catch {
					meta = null;
				}
				cardMetaCache.set(abs, { mtimeMs, meta });
			}
			if (!meta) continue;
			out.push({ path: `${spec.relBase}/${f}`, name: meta.name, tags: meta.tags, isPng: /\.png$/i.test(f), mtimeMs });
		}
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** 校验 query 里的卡路径确属卡库（一切卡文件读操作的门），返回绝对路径 */
function assertLibraryCard(cwd: string, config: RpConfig, relPath: string): string {
	const item = listCardLibrary(cwd, config).find((c) => c.path === relPath);
	if (!item) throw new Error("不是卡库中的角色卡");
	return resolvePath(cwd, relPath);
}

// 卡收藏（借鉴 ST favorites）：独立小文件，不动 rp.config（免会话重载）
const favsPath = (cwd: string) => join(cwd, ".liyuan-cache", "card-favs.json");

function loadFavs(cwd: string): string[] {
	try {
		const j = JSON.parse(readFileSync(favsPath(cwd), "utf8")) as unknown;
		return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function saveFavs(cwd: string, favs: string[]): void {
	mkdirSync(join(cwd, ".liyuan-cache"), { recursive: true });
	writeFileSync(favsPath(cwd), `${JSON.stringify(favs, null, "\t")}\n`, "utf8");
}

// ---------- 梨园 Agent 配置（liyuan.agent.json 真源；同步 runtime 为实现细节） ----------

/** 读配置；若 providers 为空且会话有当前模型，自动收编一条渠道并落盘（标准化测试遗留） */
function loadProjectAgentExtras(cwd: string): {
	shellPath?: string;
	skills?: string[];
	enableSkillCommands?: boolean;
} {
	try {
		const ps = JSON.parse(readFileSync(join(cwd, ".liyuan", "settings.json"), "utf8")) as Record<string, unknown>;
		return {
			shellPath: typeof ps.shellPath === "string" ? ps.shellPath : undefined,
			skills: Array.isArray(ps.skills) ? ps.skills.filter((x): x is string => typeof x === "string") : undefined,
			enableSkillCommands: typeof ps.enableSkillCommands === "boolean" ? ps.enableSkillCommands : undefined,
		};
	} catch {
		return {};
	}
}

function loadOrSeedAgentConfig(host: RestHost): { path: string; exists: boolean; config: LiyuanAgentConfig; seeded: boolean } {
	// 仓库为空时，把当前启用配置拆进仓库（迁移）
	const mig = migrateActiveConfigIntoProfiles(host.cwd);
	if (mig.migrated) {
		host.notify("info", `已建立配置仓库：${mig.ids.join("、")}`);
	}

	const loaded = loadAgentConfig(host.cwd);

	// 已有配置：把残留 $ENV 收成配置文件明文（Agent 只读自己的配置文件）
	// 并始终把 liyuan.agent.json 同步到 models.json，避免手改 agent.json 后重启/重开面板仍用旧 maxTokens
	if (Object.keys(loaded.config.providers).length > 0) {
		const cfg = loaded.config;
		if (materializeEnvKeysInConfig(cfg)) {
			saveAgentConfig(host.cwd, cfg);
		}
		syncAgentConfigToRuntime(host.cwd, host.agentDir(), cfg);
		host.refreshModels();
		return { path: loaded.path, exists: true, config: cfg, seeded: false };
	}

	const { current } = host.listModels();
	if (!current) return { ...loaded, seeded: false };
	const snap = host.providerSnapshot(current.provider);
	if (!snap || snap.models.length === 0) return { ...loaded, seeded: false };

	const extras = loadProjectAgentExtras(host.cwd);
	// key 写入配置文件本身：一次性从环境取实值写入，之后不再依赖环境变量
	const apiKey =
		(snap.envKey && process.env[snap.envKey]?.trim()) ||
		(current.provider === "deepseek" ? process.env.DEEPSEEK_API_KEY?.trim() : undefined) ||
		undefined;

	const provider = seedProviderFromRuntime({
		provider: snap.provider,
		baseUrl: snap.baseUrl,
		api: snap.api,
		apiKey,
		models: snap.models,
	});
	const config: LiyuanAgentConfig = {
		version: 1,
		defaultProvider: current.provider,
		defaultModel: current.id,
		defaultThinkingLevel: current.thinkingLevel,
		...extras,
		providers: { [snap.provider]: provider },
	};
	saveAgentConfig(host.cwd, config);
	syncAgentConfigToRuntime(host.cwd, host.agentDir(), config);
	host.refreshModels();
	return { path: loaded.path, exists: true, config, seeded: true };
}

function persistAgentConfig(host: RestHost, config: LiyuanAgentConfig): LiyuanAgentConfig {
	const normalized = normalizeAgentConfig(config);
	saveAgentConfig(host.cwd, normalized);
	syncAgentConfigToRuntime(host.cwd, host.agentDir(), normalized);
	host.refreshModels();
	return normalized;
}

/** 从 Agent 配置解析某模型的思考档：模型条目 > defaultThinkingLevel */
function thinkingLevelFromConfig(
	config: LiyuanAgentConfig,
	provider: string,
	modelId: string,
): string | undefined {
	const p = config.providers?.[provider];
	const list = Array.isArray(p?.models) ? p.models : [];
	const m = list.find((x) => String(x.id) === modelId);
	const per = typeof m?.thinkingLevel === "string" ? m.thinkingLevel.trim() : "";
	if (per) return per;
	const def = typeof config.defaultThinkingLevel === "string" ? config.defaultThinkingLevel.trim() : "";
	return def || undefined;
}

/**
 * models.json 刷新后：重绑当前模型（contextWindow / maxTokens）
 * 并把配置里的思考档写回会话（配置 → 当前生效，双向里「从配置上来」这一侧）
 */
async function rebindCurrentModel(host: RestHost, config?: LiyuanAgentConfig): Promise<void> {
	const cur = host.listModels().current;
	if (!cur) return;
	try {
		await host.selectModel(cur.provider, cur.id);
	} catch {
		// 模型可能暂不可用；配置已落盘，下次切换仍会带上新字段
	}
	const cfg = config ?? loadAgentConfig(host.cwd).config;
	const after = host.listModels().current;
	if (!after) return;
	const think = thinkingLevelFromConfig(cfg, after.provider, after.id);
	if (think) {
		try {
			host.setThinkingLevel(think);
		} catch {
			/* 模型不认该档位名时忽略 */
		}
	}
}

function resolveProbeKey(apiKey?: string): string | undefined {
	if (!apiKey || apiKey === "placeholder") return undefined;
	if (apiKey.startsWith("$")) {
		const name = apiKey.slice(1).replace(/^\{|\}$/g, "");
		const v = process.env[name];
		return v || undefined;
	}
	if (apiKey.startsWith("!")) return undefined; // 命令取 key：探测跳过
	return apiKey;
}

async function probeModelsEndpoint(
	baseUrl: string,
	apiKey?: string,
): Promise<{ ok: boolean; status: number; detail: string; ids: string[] }> {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	const headers: Record<string, string> = {};
	const resolved = resolveProbeKey(apiKey);
	if (resolved) headers.authorization = `Bearer ${resolved}`;
	try {
		const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
		if (!r.ok) {
			return { ok: false, status: r.status, detail: (await r.text()).slice(0, 300) || `HTTP ${r.status}`, ids: [] };
		}
		const json = (await r.json()) as {
			data?: Array<{ id?: unknown; name?: unknown }>;
			models?: Array<{ id?: unknown; name?: unknown }>;
		};
		const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
		const ids = list.map((m) => String(m.id ?? m.name ?? "").trim()).filter(Boolean);
		return {
			ok: true,
			status: r.status,
			detail: ids.length
				? `连通（HTTP ${r.status}，${ids.length} 个模型）`
				: `连通（HTTP ${r.status}，模型清单为空）`,
			ids,
		};
	} catch (e) {
		return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e), ids: [] };
	}
}

// ---------- 多预设管理（PLAN-PANELS-V2 §2.6：assets/presets/ 存多份，config.preset 指向当前） ----------

const PRESETS_DIR = "assets/presets";
/** 面板未点「保存」时的运行时草稿（立即进 system；切换预设时丢弃） */
const PRESET_OVERRIDE_REL = ".liyuan/preset-override.json";

const presetSlug = (name: string) => name.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "preset";

/** 预设路径白名单：历史单文件 liyuan-preset.json 或 assets/presets/ 顶层 .json */
function validatePresetPath(p: string): string {
	const norm = p.replace(/\\/g, "/");
	if (norm === "liyuan-preset.json") return norm;
	const base = norm.startsWith(`${PRESETS_DIR}/`) ? norm.slice(PRESETS_DIR.length + 1) : "";
	if (!base || base.includes("/") || base.includes("..") || !base.endsWith(".json")) throw new Error("非法预设路径");
	return norm;
}

export function presetOverridePath(cwd: string): string {
	return join(cwd, PRESET_OVERRIDE_REL);
}

function clearPresetOverride(cwd: string): void {
	const p = presetOverridePath(cwd);
	if (existsSync(p)) {
		try {
			unlinkSync(p);
		} catch {
			/* ignore */
		}
	}
}

/** 磁盘上的已保存预设（不含草稿） */
export function loadDiskPreset(cwd: string): { path: string; preset: RpPreset } | null {
	const config = loadConfig(cwd);
	if (!config.preset) return null;
	const p = resolvePath(cwd, config.preset);
	if (!existsSync(p)) return null;
	return { path: config.preset, preset: normalizeRpPreset(JSON.parse(readFileSync(p, "utf8"))) };
}

/** 运行时生效：草稿优先，否则磁盘 */
export function loadEffectivePreset(cwd: string): { path: string | null; preset: RpPreset | null; fromOverride: boolean } {
	const config = loadConfig(cwd);
	if (!config.preset) return { path: null, preset: null, fromOverride: false };
	const ovr = presetOverridePath(cwd);
	if (existsSync(ovr)) {
		try {
			const preset = normalizeRpPreset(JSON.parse(readFileSync(ovr, "utf8")));
			// regexGroups 只存预设文件本体：草稿合并时从磁盘本体透出，避免 override 吞掉本体字段
			const disk = loadDiskPreset(cwd);
			if (disk) preset.regexGroups = disk.preset.regexGroups;
			return { path: config.preset, preset, fromOverride: true };
		} catch {
			/* fall through */
		}
	}
	const disk = loadDiskPreset(cwd);
	if (!disk) return { path: config.preset, preset: null, fromOverride: false };
	return { path: disk.path, preset: disk.preset, fromOverride: false };
}

export function mergePresetPatches(
	base: RpPreset,
	body: {
		samplers?: Record<string, number>;
		blocks?: Array<{
			id: string;
			enabled?: boolean;
			name?: string;
			content?: string;
			channel?: "system" | "postHistory";
		}>;
	},
): RpPreset {
	return {
		...base,
		samplers: sanitizeSamplers(body.samplers) ?? base.samplers,
		blocks: base.blocks.map((b) => {
			const patch = body.blocks?.find((x) => x.id === b.id);
			if (!patch) return b;
			const out = { ...b };
			if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
			if (typeof patch.name === "string") out.name = patch.name.trim() || b.name;
			if (typeof patch.content === "string") out.content = patch.content;
			if (patch.channel === "system" || patch.channel === "postHistory") out.channel = patch.channel;
			return out;
		}),
	};
}

function listPresetFiles(cwd: string): Array<{ file: string; name: string }> {
	const out: Array<{ file: string; name: string }> = [];
	const readName = (abs: string): string | null => {
		try {
			return normalizeRpPreset(JSON.parse(readFileSync(abs, "utf8"))).name;
		} catch {
			return null;
		}
	};
	const legacy = join(cwd, "liyuan-preset.json");
	if (existsSync(legacy)) {
		const name = readName(legacy);
		if (name !== null) out.push({ file: "liyuan-preset.json", name });
	}
	const dir = join(cwd, PRESETS_DIR);
	if (existsSync(dir)) {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			const name = readName(join(dir, f));
			if (name !== null) out.push({ file: `${PRESETS_DIR}/${f}`, name });
		}
	}
	return out;
}

// ---------- 世界书文件管理（PLAN-PANELS-V2 §2.3：选书/导入/删除） ----------

const LOREBOOKS_DIR = "assets/lorebooks";

/** 世界书扫描目录：assets/lorebooks + 各挂载书所在目录（用户素材常在项目外） */
function lorebookDirSpecs(cwd: string, config: RpConfig): Array<{ abs: string; relBase: string }> {
	const specs = [{ abs: join(cwd, LOREBOOKS_DIR), relBase: LOREBOOKS_DIR }];
	for (const rel of mountedLorebookPaths(config)) {
		const base = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
		const abs = resolvePath(cwd, base);
		if (!specs.some((s) => s.abs === abs)) specs.push({ abs, relBase: base });
	}
	return specs;
}

const lorebookMetaCache = new Map<string, { mtimeMs: number; count: number | null; displayName: string }>();

function listLorebookFiles(cwd: string, config: RpConfig): Array<{ path: string; name: string; entryCount: number }> {
	const out: Array<{ path: string; name: string; entryCount: number }> = [];
	for (const spec of lorebookDirSpecs(cwd, config)) {
		if (!existsSync(spec.abs)) continue;
		for (const f of readdirSync(spec.abs)) {
			if (!f.endsWith(".json")) continue;
			const abs = join(spec.abs, f);
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(abs).mtimeMs;
			} catch {
				continue;
			}
			const cached = lorebookMetaCache.get(abs);
			// Prefer JSON `name` over bare filename — zip tools (Windows Compress-Archive)
			// often corrupt non-ASCII filenames while leaving UTF-8 content intact.
			let displayName = f.replace(/\.json$/i, "");
			let count: number | null;
			if (cached && cached.mtimeMs === mtimeMs) {
				count = cached.count;
				displayName = cached.displayName || displayName;
			} else {
				try {
					const raw = readJsonFile(abs) as Record<string, unknown>;
					const entries = normalizeEntries(raw.entries);
					count = entries.length > 0 ? entries.length : null; // 0 条=不是世界书（同目录常混有卡/预设）
					if (typeof raw.name === "string" && raw.name.trim()) {
						displayName = raw.name.trim();
					}
				} catch {
					count = null;
				}
				lorebookMetaCache.set(abs, { mtimeMs, count, displayName });
			}
			if (count === null) continue;
			out.push({ path: `${spec.relBase}/${f}`, name: displayName, entryCount: count });
		}
	}
	return out;
}

// ---------- persona 投影（PLAN-PANELS-V2 §2.5：config.userName/userPersona=当前 persona 的镜像） ----------

function projectPersonaToConfig(cwd: string, p: Persona): void {
	const config = loadConfig(cwd) as unknown as Record<string, unknown>;
	config.userName = p.name;
	config.userPersona = p.persona;
	writeJsonWithBackup(configPath(cwd), config);
}

// ---------- 路由 ----------

/** /api/* 请求处理；非 /api 路径返回 false 交回静态托管 */
export async function handleApiRequest(req: IncomingMessage, res: ServerResponse, host: RestHost): Promise<boolean> {
	const url = (req.url ?? "/").split("?")[0];
	if (!url.startsWith("/api/")) return false;
	const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
	const route = `${req.method} ${url}`;

	/** 触发会话重载/切换的写操作在流式中拒绝 */
	const refuseWhileStreaming = (): boolean => {
		if (!host.isStreaming()) return false;
		sendJson(res, 409, { error: "正在生成回复，请稍候（或先停止）再操作" });
		return true;
	};

	try {
		switch (route) {
			// ---- 命令清单（输入框补全用；单一来源 src/commands.ts） ----
			case "GET /api/commands": {
				sendJson(res, 200, { commands: RP_COMMANDS });
				return true;
			}
			// ---- 命令桥（agent 自操作 / 脚本化入口；PLAN-PHASE3 §6.3 三入口之一） ----
			case "POST /api/command": {
				const body = JSON.parse(await readBody(req)) as { text?: string };
				const text = (body.text ?? "").trim();
				const m = /^\/(\w+)(?:\s|$)/.exec(text);
				if (!m || !RP_COMMANDS.some((c) => c.name === m[1])) {
					throw new Error(`不是可用命令：${text.slice(0, 40)}（可用：${RP_COMMANDS.map((c) => `/${c.name}`).join(" ")}）`);
				}
				const queued = host.queueCommand(text);
				sendJson(res, 200, { ok: true, queued, note: queued ? "生成中：已排队到本轮结束执行" : "已提交执行" });
				return true;
			}

			// ---- 文生音（气泡配音 / 脚本） ----
			case "POST /api/tts": {
				const body = JSON.parse(await readBody(req)) as { text?: string; caption?: string };
				const text = (body.text ?? "").trim();
				if (!text) throw new Error("缺少 text");
				const r = await host.ttsSpeak(text, body.caption?.trim() || undefined);
				sendJson(res, 200, { ok: true, ...r });
				return true;
			}

			// ---- 世界线（存档时间线） ----
			case "GET /api/worldline": {
				sendJson(res, 200, host.worldlineView() satisfies WorldlineView);
				return true;
			}
			case "POST /api/worldline/delete-save": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { saveId?: string };
				const saveId = (body.saveId ?? "").trim();
				if (!saveId) throw new Error("缺少 saveId");
				host.deleteWorldlineSave(saveId);
				sendJson(res, 200, { ok: true, view: host.worldlineView() });
				return true;
			}
			case "POST /api/worldline/rename": {
				const body = JSON.parse(await readBody(req)) as { worldlineId?: string; name?: string };
				const worldlineId = (body.worldlineId ?? "").trim();
				const name = (body.name ?? "").trim();
				if (!worldlineId || !name) throw new Error("需要 worldlineId 与 name");
				host.renameWorldline(worldlineId, name);
				sendJson(res, 200, { ok: true, view: host.worldlineView() });
				return true;
			}

			// ---- 上传区（附件随消息模型）：原始字节直传，文件名走 query（免 multipart 解析依赖）。
			// 不触碰会话：流式中也允许（agent 下一轮注入的【上传文件】速览自然可见）
			case "POST /api/upload": {
				const rawName = (query.get("name") ?? "").trim();
				if (!rawName) throw new Error("缺少 name（URL 编码的原始文件名）");
				const data = await readBodyRaw(req, MAX_UPLOAD);
				if (data.length === 0) throw new Error("文件内容为空");
				const saved = saveUpload(host.cwd, rawName, data);
				sendJson(res, 200, { ok: true, file: saved.file, bytes: saved.bytes, size: formatBytes(saved.bytes) });
				return true;
			}
			case "GET /api/uploads": {
				const map = (u: { file: string; name: string; bytes: number; mtimeMs: number }) => ({
					file: u.file,
					name: u.name,
					size: formatBytes(u.bytes),
					mtimeMs: u.mtimeMs,
				});
				sendJson(res, 200, {
					/** 我的上传：.liyuan-uploads/ */
					uploads: listUploads(host.cwd).map(map),
					/** 本地图片：.liyuan-media/（AI show_image 等） */
					media: listMedia(host.cwd).map(map),
				});
				return true;
			}
			case "DELETE /api/uploads": {
				const file = query.get("file") ?? "";
				// 只许删 .liyuan-uploads/ 或 .liyuan-media/ 顶层文件
				let base = "";
				let dir = "";
				if (file.startsWith(".liyuan-uploads/") || file.startsWith(".rp-uploads/")) {
					base = file.replace(/^\.(liyuan|rp)-uploads\//, "");
					dir = ".liyuan-uploads";
				} else if (file.startsWith(".liyuan-media/") || file.startsWith(".rp-media/")) {
					base = file.replace(/^\.(liyuan|rp)-media\//, "");
					dir = ".liyuan-media";
				}
				if (!dir || !base || base.includes("/") || base.includes("\\") || base.includes("..")) {
					throw new Error("非法路径");
				}
				const abs = join(host.cwd, dir, base);
				if (!existsSync(abs)) throw new Error("文件不存在");
				unlinkSync(abs);
				sendJson(res, 200, { ok: true });
				return true;
			}

			// ---- 知识库（柱 3）：面板只读展示 + 挂载状态；建库/挂载/写入经由对话（agent 是入口） ----
			case "GET /api/codex": {
				const mounted = new Set(host.mountedCodexes());
				sendJson(res, 200, {
					mounted: [...mounted],
					codexes: listCodexes(host.cwd).map((c) => ({
						name: c.name,
						description: c.description,
						entryCount: c.entryCount,
						mounted: mounted.has(c.name),
					})),
				});
				return true;
			}
			case "GET /api/codex/entries": {
				const name = query.get("name") ?? "";
				const entries = loadCodexEntries(host.cwd, name);
				if (!entries) throw new Error(`知识库不存在：${name}`);
				sendJson(res, 200, {
					entries: entries.map((e) => ({
						fingerprint: loreFingerprint(e.content),
						/** 前端主标题：名字 */
						name: e.comment || e.keys[0] || "（未命名）",
						comment: e.comment,
						keys: e.keys,
						constant: e.constant,
						/** 前端正文：信息 */
						content: e.content,
						chars: e.content.length,
					})),
				});
				return true;
			}
			/**
			 * 用户添加条目：只收 name（名字）+ info（信息），后端译为标准 lore 条目
			 * （comment/keys/content；keys 从名字自动派生，可被检索）。
			 */
			case "POST /api/codex/entries": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					codex?: string;
					name?: string;
					info?: string;
					/** 兼容旧字段 / agent 同形 */
					title?: string;
					content?: string;
					keys?: string[];
				};
				const codexName = (body.codex ?? "").trim();
				if (!codexName) throw new Error("缺少知识库名 codex");
				const title = (body.name ?? body.title ?? "").trim();
				const info = (body.info ?? body.content ?? "").trim();
				if (!title) throw new Error("名字不能为空");
				if (!info) throw new Error("信息不能为空");
				const input = userEntryToCodexInput(
					title,
					info,
					Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : undefined,
				);
				const r = appendCodexEntry(host.cwd, codexName, input);
				if (!r.ok) throw new Error(r.error);
				if (!r.entry) {
					sendJson(res, 200, { ok: true, duplicate: true, fingerprint: loreFingerprint(input.content) });
					return true;
				}
				if (host.mountedCodexes().some((n) => n.toLowerCase() === codexName.toLowerCase())) {
					await host.reloadSession();
				}
				host.notify("info", `已写入「${codexName}」：${r.entry.comment}`);
				sendJson(res, 200, {
					ok: true,
					duplicate: false,
					fingerprint: loreFingerprint(r.entry.content),
					name: r.entry.comment,
				});
				return true;
			}
			case "DELETE /api/codex/entries": {
				if (refuseWhileStreaming()) return true;
				const codexName = (query.get("codex") ?? query.get("name") ?? "").trim();
				const fp = (query.get("fp") ?? query.get("fingerprint") ?? "").trim();
				if (!codexName) throw new Error("缺少知识库名");
				if (!fp) throw new Error("缺少条目 fingerprint");
				const r = deleteCodexEntry(host.cwd, codexName, fp);
				if (!r.ok) throw new Error(r.error);
				if (!r.removed) throw new Error("条目不存在（可能已删除）");
				if (host.mountedCodexes().some((n) => n.toLowerCase() === codexName.toLowerCase())) {
					await host.reloadSession();
				}
				host.notify("info", `已从「${codexName}」删除一条`);
				sendJson(res, 200, { ok: true });
				return true;
			}
			// 导出知识库为世界书 JSON（公开格式，可互通酒馆等；柱 3）
			case "GET /api/codex/export": {
				const name = query.get("name") ?? "";
				const entries = loadCodexEntries(host.cwd, name);
				if (!entries) throw new Error(`知识库不存在：${name}`);
				sendJson(res, 200, { name, json: exportStLorebook(name, entries) });
				return true;
			}

			// ---- 内置向量记忆（按「角色卡+对话」隔离；设置面板一等公民） ----
			case "GET /api/memory": {
				sendJson(res, 200, getMemoryStatus(host.cwd, host.memoryScope()));
				return true;
			}
			case "PUT /api/memory": {
				const body = JSON.parse(await readBody(req)) as {
					enabled?: boolean;
					searchTopK?: number;
					injectOnTurn?: boolean;
					embedMode?: "local" | "cloud";
					cloudEmbed?: { baseUrl?: string; apiKey?: string; model?: string };
					stores?: Array<{
						id: string;
						enabled?: boolean;
						everyNTurns?: number;
						maxChunks?: number;
						name?: string;
					}>;
				};
				const sc = host.memoryScope();
				const cur = getMemoryStatus(host.cwd, sc).config;
				updateMemoryConfig(host.cwd, {
					...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
					...(typeof body.searchTopK === "number" ? { searchTopK: body.searchTopK } : {}),
					...(typeof body.injectOnTurn === "boolean" ? { injectOnTurn: body.injectOnTurn } : {}),
					...(body.embedMode === "local" || body.embedMode === "cloud" ? { embedMode: body.embedMode } : {}),
					...(body.cloudEmbed
						? {
								cloudEmbed: {
									baseUrl: body.cloudEmbed.baseUrl ?? cur.cloudEmbed.baseUrl,
									apiKey: body.cloudEmbed.apiKey ?? "",
									model: body.cloudEmbed.model ?? cur.cloudEmbed.model,
								},
							}
						: {}),
				});
				if (Array.isArray(body.stores)) {
					for (const s of body.stores) {
						if (!s?.id) continue;
						updateStoreConfig(host.cwd, s.id, {
							...(typeof s.enabled === "boolean" ? { enabled: s.enabled } : {}),
							...(typeof s.everyNTurns === "number" ? { everyNTurns: s.everyNTurns } : {}),
							...(typeof s.maxChunks === "number" ? { maxChunks: s.maxChunks } : {}),
							...(typeof s.name === "string" ? { name: s.name } : {}),
						});
					}
				}
				sendJson(res, 200, getMemoryStatus(host.cwd, sc));
				return true;
			}
			case "POST /api/memory/search": {
				const body = JSON.parse(await readBody(req)) as { storeId?: string; query?: string; topK?: number };
				const storeId = (body.storeId ?? "narrative").trim();
				const query = (body.query ?? "").trim();
				if (!query) throw new Error("缺少 query");
				const hits = await memorySearch(host.cwd, host.memoryScope(), storeId, query, body.topK);
				sendJson(res, 200, { hits });
				return true;
			}
			case "POST /api/memory/import": {
				const body = JSON.parse(await readBody(req)) as {
					storeId?: string;
					text?: string;
					fileName?: string;
				};
				// 仅额外库；剧情库禁止导入
				const storeId = (body.storeId ?? "external").trim() || "external";
				const text = (body.text ?? "").trim();
				if (!text) throw new Error("缺少 text");
				const sc = host.memoryScope();
				const r = await memoryImportText(host.cwd, sc, storeId, text, body.fileName);
				if (r.added > 0) {
					const label = body.fileName?.trim() || "额外库";
					host.notify(
						"info",
						`向量记忆：向量化成功 · 额外库 +${r.added} 条（「${label}」· 当前对话）`,
					);
				} else if (r.chunks > 0) {
					host.notify("info", "向量记忆：内容已在库中（无新增）");
				}
				sendJson(res, 200, { ok: true, ...r, ...getMemoryStatus(host.cwd, sc) });
				return true;
			}
			case "POST /api/memory/manual": {
				// 手动向量化 → 仅额外库，每段/块一条
				const body = JSON.parse(await readBody(req)) as {
					text?: string;
					title?: string;
					storeId?: string;
				};
				const text = (body.text ?? "").trim();
				if (!text) throw new Error("缺少 text");
				const sc = host.memoryScope();
				const r = await memoryManualAdd(host.cwd, sc, text, {
					title: body.title,
					storeId: body.storeId,
				});
				if (r.added > 0) {
					host.notify(
						"info",
						`向量记忆：手动向量化成功 · 额外库 +${r.added} 条（当前对话）`,
					);
				} else {
					host.notify("info", "向量记忆：内容已在库中（无新增）");
				}
				sendJson(res, 200, { ok: true, ...r, ...getMemoryStatus(host.cwd, sc) });
				return true;
			}
			case "GET /api/memory/chunks": {
				const storeId = (query.get("storeId") ?? "external").trim() || "external";
				const sc = host.memoryScope();
				const chunks = memoryListChunks(host.cwd, sc, storeId);
				sendJson(res, 200, { storeId, chunks });
				return true;
			}
			case "DELETE /api/memory/chunk": {
				const storeId = (query.get("storeId") ?? "").trim();
				const id = (query.get("id") ?? "").trim();
				if (!storeId) throw new Error("缺少 storeId");
				if (!id) throw new Error("缺少 id");
				const sc = host.memoryScope();
				const ok = memoryDeleteChunk(host.cwd, sc, storeId, id);
				if (!ok) throw new Error("条目不存在或已删除");
				host.notify("info", "向量记忆：已删除 1 条");
				sendJson(res, 200, { ok: true, ...getMemoryStatus(host.cwd, sc) });
				return true;
			}
			case "POST /api/memory/chunk/delete": {
				// 兼容不便发 DELETE body 的客户端
				const body = JSON.parse(await readBody(req)) as { storeId?: string; id?: string };
				const storeId = (body.storeId ?? "").trim();
				const id = (body.id ?? "").trim();
				if (!storeId) throw new Error("缺少 storeId");
				if (!id) throw new Error("缺少 id");
				const sc = host.memoryScope();
				const ok = memoryDeleteChunk(host.cwd, sc, storeId, id);
				if (!ok) throw new Error("条目不存在或已删除");
				host.notify("info", "向量记忆：已删除 1 条");
				sendJson(res, 200, { ok: true, ...getMemoryStatus(host.cwd, sc) });
				return true;
			}
			case "POST /api/memory/probe-embed": {
				const r = await probeCloudEmbed(host.cwd);
				sendJson(res, 200, r);
				return true;
			}
			case "POST /api/memory/reembed": {
				// 保留原文，按当前 embed 模式重算向量（换 local/cloud 后用）
				const body = JSON.parse((await readBody(req)) || "{}") as { storeId?: string };
				const sc = host.memoryScope();
				const r = await memoryReembedScope(host.cwd, sc, {
					storeId: body.storeId?.trim() || undefined,
				});
				const modeLabel = r.mode === "cloud" ? `云端(${r.model})` : "本地";
				if (r.totalChunks === 0) {
					host.notify("info", "向量记忆：当前对话库为空，无需重向量化");
				} else {
					host.notify(
						"info",
						`向量记忆：重向量化完成 · ${r.totalUpdated}/${r.totalChunks} 条 → ${modeLabel}（当前对话）`,
					);
				}
				sendJson(res, 200, { ok: true, ...r, ...getMemoryStatus(host.cwd, sc) });
				return true;
			}
			case "POST /api/memory/clear": {
				const body = JSON.parse(await readBody(req)) as { storeId?: string };
				const storeId = (body.storeId ?? "").trim();
				if (!storeId) throw new Error("缺少 storeId");
				const sc = host.memoryScope();
				memoryClearStore(host.cwd, sc, storeId);
				sendJson(res, 200, { ok: true, ...getMemoryStatus(host.cwd, sc) });
				return true;
			}
			case "DELETE /api/memory/store": {
				const storeId = (query.get("id") ?? "").trim();
				if (!storeId) throw new Error("缺少 id");
				const sc = host.memoryScope();
				memoryRemoveStore(host.cwd, sc, storeId);
				sendJson(res, 200, { ok: true, ...getMemoryStatus(host.cwd, sc) });
				return true;
			}

			// ---- 技能库：面板只读展示 + /skill:name 显式触发（触发经会话通道，同输入框打命令） ----
			case "GET /api/skills": {
				sendJson(res, 200, {
					skills: listSkills(host.cwd).map((s) => ({
						name: s.name,
						description: s.description,
						file: s.file,
						disableModelInvocation: s.disableModelInvocation === true,
					})),
				});
				return true;
			}
			case "GET /api/skills/content": {
				const file = query.get("file") ?? "";
				const base = file.startsWith(".liyuan-skills/") ? file.slice(".liyuan-skills/".length) : "";
				if (!base || base.includes("/") || base.includes("\\") || base.includes("..") || !base.endsWith(".md")) {
					throw new Error("非法路径");
				}
				const abs = join(host.cwd, ".liyuan-skills", base);
				if (!existsSync(abs)) throw new Error("技能文件不存在");
				sendJson(res, 200, { content: readFileSync(abs, "utf8") });
				return true;
			}
			// 技能写入/更新（PLAN-PANELS §2.6）：同名覆盖=更新，frontmatter 由 saveSkill 统一生成
			case "POST /api/skills": {
				const body = JSON.parse(await readBody(req)) as {
					name?: string;
					description?: string;
					content?: string;
					disableModelInvocation?: boolean;
				};
				const name = (body.name ?? "").trim();
				const content = (body.content ?? "").trim();
				if (!name) throw new Error("缺少技能名");
				if (!content) throw new Error("技能内容为空");
				const r = saveSkill(host.cwd, {
					name,
					description: (body.description ?? "").trim(),
					content,
					disableModelInvocation: body.disableModelInvocation === true,
				});
				sendJson(res, 200, { ok: true, ...r, note: "system prompt 里的技能索引在下次会话重载时更新" });
				return true;
			}
			case "DELETE /api/skills": {
				const file = query.get("file") ?? "";
				const base = file.startsWith(".liyuan-skills/") ? file.slice(".liyuan-skills/".length) : "";
				if (!base || base.includes("/") || base.includes("\\") || base.includes("..") || !base.endsWith(".md")) {
					throw new Error("非法路径");
				}
				const abs = join(host.cwd, ".liyuan-skills", base);
				if (!existsSync(abs)) throw new Error("技能文件不存在");
				unlinkSync(abs);
				sendJson(res, 200, { ok: true });
				return true;
			}

			// ---- MCP 外设（柱 4）：多源发现 + 本对话开关 + 项目手写 + 探测 ----
			case "GET /api/mcp": {
				const hub = getMcpHub(host.cwd);
				const catalog = discoverMcpCatalog(host.cwd);
				const statuses = hub.statusList();
				// hub 尚未 session_start 时 sessionEnabled 为空：仍展示目录，enabled 全 false
				const byId = new Map(statuses.map((s) => [s.id, s]));
				const servers = catalog.map((e) => {
					const st = byId.get(e.id);
					if (st) return st;
					return {
						id: e.id,
						name: e.name,
						enabled: false,
						defaultEnabled: e.enabled,
						transport: e.transport,
						status: "disconnected" as const,
						tools: [],
						summary:
							e.transport === "stdio"
								? `${e.command ?? ""} ${(e.args ?? []).join(" ")}`.trim()
								: (e.url ?? ""),
						source: e.source,
						sources: e.sources,
						discovered: e.discovered,
						builtin: e.builtin,
					};
				});
				const project = loadMcpConfig(host.cwd);
				sendJson(res, 200, {
					servers,
					sessionEnabled: hub.getSessionEnabled(),
					// 项目手写条目（编辑表单回填）
					config: project.servers,
					// 发现项的完整配置（编辑发现项→建项目覆盖时预填表单）
					catalog: catalog.map((e) => ({
						id: e.id,
						name: e.name,
						enabled: e.enabled,
						transport: e.transport,
						command: e.command,
						args: e.args,
						env: e.env,
						cwd: e.cwd,
						url: e.url,
						headers: e.headers,
					})),
					// 发现摘要（调试/面板提示）
					discovered: catalog.length,
				});
				return true;
			}
			case "POST /api/mcp/sync": {
				try {
					await host.promptCommand("/mcpsync");
				} catch {
					// 扩展未装载：仅 hub 侧对账
					const hub = getMcpHub(host.cwd);
					await hub.sync();
				}
				sendJson(res, 200, { ok: true, servers: getMcpHub(host.cwd).statusList() });
				return true;
			}
			// 本对话启用/关闭（agent 绑会话）；可选写入「新对话默认」
			case "POST /api/mcp/enable": {
				const body = JSON.parse(await readBody(req)) as {
					id?: string;
					enabled?: boolean;
					/** true=同时写入项目 defaults，影响之后的新对话 */
					persistDefault?: boolean;
				};
				const id = sanitizeServerId(String(body.id ?? ""));
				if (!id) throw new Error("缺少 id");
				const on = body.enabled === true;
				if (body.persistDefault === true) {
					setDefaultEnabled(host.cwd, id, on);
				}
				try {
					await host.promptCommand(`/mcpset ${id} ${on ? "on" : "off"}`);
				} catch (e) {
					throw new Error(`切换失败：${e instanceof Error ? e.message : String(e)}`);
				}
				sendJson(res, 200, {
					ok: true,
					id,
					enabled: on,
					servers: getMcpHub(host.cwd).statusList(),
					sessionEnabled: getMcpHub(host.cwd).getSessionEnabled(),
				});
				return true;
			}
			case "POST /api/mcp/servers": {
				const body = JSON.parse(await readBody(req)) as Partial<McpServerConfig> & { id?: string };
				const cfg = loadMcpConfig(host.cwd);
				const name = String(body.name ?? body.id ?? "").trim();
				if (!name && !body.command && !body.url) throw new Error("请填写名称，以及 command 或 url");
				const id = body.id?.trim()
					? sanitizeServerId(body.id)
					: allocateServerId(host.cwd, name || body.command || "server");
				if (!id) throw new Error("无效的服务器 id");
				if (cfg.servers.some((s) => s.id === id)) throw new Error(`id「${id}」已在项目配置中`);
				// 手写添加默认关（与发现一致）；调用方可显式 enabled:true
				const server: McpServerConfig = {
					id,
					name: name || id,
					enabled: body.enabled === true,
					transport: body.transport === "http" || body.transport === "sse" ? body.transport : "stdio",
					command: typeof body.command === "string" ? body.command.trim() : undefined,
					args: Array.isArray(body.args) ? body.args.filter((x): x is string => typeof x === "string") : undefined,
					env: body.env && typeof body.env === "object" ? (body.env as Record<string, string>) : undefined,
					cwd: typeof body.cwd === "string" ? body.cwd.trim() : undefined,
					url: typeof body.url === "string" ? body.url.trim() : undefined,
					headers: body.headers && typeof body.headers === "object" ? (body.headers as Record<string, string>) : undefined,
				};
				const v = validateServerConfig(server);
				if (v) throw new Error(v);
				cfg.servers.push(server);
				if (server.enabled) {
					cfg.defaults = { ...(cfg.defaults ?? {}), [id]: true };
				}
				saveMcpConfig(host.cwd, cfg);
				if (server.enabled) {
					try {
						await host.promptCommand(`/mcpset ${id} on`);
					} catch {
						// ignore
					}
				}
				host.notify("info", `MCP「${server.name}」已写入项目配置`);
				sendJson(res, 200, {
					ok: true,
					server,
					servers: getMcpHub(host.cwd).statusList(),
				});
				return true;
			}
			case "PUT /api/mcp/servers": {
				const body = JSON.parse(await readBody(req)) as Partial<McpServerConfig> & { id?: string };
				const id = sanitizeServerId(String(body.id ?? ""));
				if (!id) throw new Error("缺少 id");
				const cfg = loadMcpConfig(host.cwd);
				const idx = cfg.servers.findIndex((s) => s.id === id);
				// 仅项目手写可改 endpoint；发现项请用 enable 开关
				if (idx < 0) {
					if (typeof body.enabled === "boolean") {
						// 发现项：只改开关
						setDefaultEnabled(host.cwd, id, body.enabled);
						try {
							await host.promptCommand(`/mcpset ${id} ${body.enabled ? "on" : "off"}`);
						} catch {
							// ignore
						}
						sendJson(res, 200, {
							ok: true,
							servers: getMcpHub(host.cwd).statusList(),
							sessionEnabled: getMcpHub(host.cwd).getSessionEnabled(),
						});
						return true;
					}
					throw new Error(`项目中无手写条目「${id}」（发现项只能开关，或先「添加」做项目覆盖）`);
				}
				const prev = cfg.servers[idx];
				const server: McpServerConfig = {
					...prev,
					name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : prev.name,
					enabled: typeof body.enabled === "boolean" ? body.enabled : prev.enabled,
					transport:
						body.transport === "http" || body.transport === "sse" || body.transport === "stdio"
							? body.transport
							: prev.transport,
					command: body.command !== undefined ? String(body.command).trim() : prev.command,
					args: body.args !== undefined
						? Array.isArray(body.args)
							? body.args.filter((x): x is string => typeof x === "string")
							: prev.args
						: prev.args,
					env: body.env !== undefined
						? body.env && typeof body.env === "object"
							? (body.env as Record<string, string>)
							: undefined
						: prev.env,
					cwd: body.cwd !== undefined ? String(body.cwd).trim() || undefined : prev.cwd,
					url: body.url !== undefined ? String(body.url).trim() || undefined : prev.url,
					headers: body.headers !== undefined
						? body.headers && typeof body.headers === "object"
							? (body.headers as Record<string, string>)
							: undefined
						: prev.headers,
				};
				const v = validateServerConfig(server);
				if (v) throw new Error(v);
				cfg.servers[idx] = server;
				cfg.defaults = { ...(cfg.defaults ?? {}), [id]: server.enabled === true };
				saveMcpConfig(host.cwd, cfg);
				try {
					await host.promptCommand(`/mcpset ${id} ${server.enabled ? "on" : "off"}`);
				} catch {
					// ignore
				}
				sendJson(res, 200, { ok: true, server, servers: getMcpHub(host.cwd).statusList() });
				return true;
			}
			case "DELETE /api/mcp/servers": {
				const id = sanitizeServerId(query.get("id") ?? "");
				if (!id) throw new Error("缺少 id");
				const cfg = loadMcpConfig(host.cwd);
				const next = cfg.servers.filter((s) => s.id !== id);
				if (next.length === cfg.servers.length) {
					throw new Error(`项目中无手写「${id}」（发现项不能删除，关掉即可）`);
				}
				cfg.servers = next;
				if (cfg.defaults) {
					const d = { ...cfg.defaults };
					delete d[id];
					cfg.defaults = d;
				}
				saveMcpConfig(host.cwd, cfg);
				try {
					await host.promptCommand(`/mcpset ${id} off`);
				} catch {
					// ignore
				}
				host.notify("info", `已删除项目 MCP「${id}」`);
				sendJson(res, 200, { ok: true, servers: getMcpHub(host.cwd).statusList() });
				return true;
			}
			case "POST /api/mcp/probe": {
				const body = JSON.parse(await readBody(req)) as Partial<McpServerConfig> & { id?: string };
				// 允许只传 id：从目录取 endpoint
				let server: McpServerConfig;
				if (body.id && !body.command && !body.url) {
					const hit = discoverMcpCatalog(host.cwd).find((s) => s.id === sanitizeServerId(body.id!));
					if (!hit) throw new Error(`目录中无「${body.id}」`);
					server = {
						id: hit.id,
						name: hit.name,
						enabled: true,
						transport: hit.transport,
						command: hit.command,
						args: hit.args,
						env: hit.env,
						cwd: hit.cwd,
						url: hit.url,
						headers: hit.headers,
					};
				} else {
					server = {
						id: sanitizeServerId(String(body.id ?? "probe")) || "probe",
						name: String(body.name ?? "probe"),
						enabled: true,
						transport: body.transport === "http" || body.transport === "sse" ? body.transport : "stdio",
						command: typeof body.command === "string" ? body.command.trim() : undefined,
						args: Array.isArray(body.args) ? body.args.filter((x): x is string => typeof x === "string") : undefined,
						env: body.env && typeof body.env === "object" ? (body.env as Record<string, string>) : undefined,
						cwd: typeof body.cwd === "string" ? body.cwd.trim() : undefined,
						url: typeof body.url === "string" ? body.url.trim() : undefined,
						headers:
							body.headers && typeof body.headers === "object" ? (body.headers as Record<string, string>) : undefined,
					};
				}
				const result = await probeMcpServer(server);
				sendJson(res, 200, result);
				return true;
			}

			// ---- Agent 自建面板：liyuan-panels 社区格式导入（柱 2）。导出走前端（内容已在 wire，零服务端） ----
			case "POST /api/panels/import": {
				const body = JSON.parse(await readBody(req)) as {
					format?: unknown;
					panels?: unknown;
					name?: unknown;
					kind?: unknown;
					content?: unknown;
				};
				// 宽进：标准 {format:"liyuan-panels",panels:[…]}，也容单面板裸对象 {name,kind,content}
				const list = Array.isArray(body.panels)
					? (body.panels as Array<{ name?: unknown; kind?: unknown; content?: unknown }>)
					: typeof body.name === "string" && typeof body.content === "string"
						? [body]
						: null;
				if (!list || list.length === 0) {
					throw new Error('格式不对：需要 liyuan-panels JSON（{"format":"liyuan-panels","version":1,"panels":[{"name","kind","content"}]}）');
				}
				const result = await host.importPanels(list);
				if (result.imported > 0) {
					host.notify("info", `已导入 ${result.imported} 个面板${result.errors.length ? `（${result.errors.length} 个失败）` : ""}`);
				}
				sendJson(res, result.imported > 0 ? 200 : 400, { ok: result.imported > 0, ...result });
				return true;
			}
			// 用户从面板坞删除：同 agent panel_close（归档，出活跃列表；fs.watch + panelsync）
			case "DELETE /api/panels": {
				const name = (query.get("name") ?? "").trim();
				if (!name) throw new Error("缺少 name");
				await host.closePanel(name);
				host.notify("info", `已删除面板「${name}」`);
				sendJson(res, 200, { ok: true, name });
				return true;
			}
			// 用户手改面板源码（markdown/svg/html 通用）：写盘 + 收编，下轮 agent 可见
			case "PUT /api/panels": {
				const body = JSON.parse(await readBody(req)) as {
					name?: unknown;
					content?: unknown;
					kind?: unknown;
				};
				const name = typeof body.name === "string" ? body.name.trim() : "";
				if (!name) throw new Error("缺少 name");
				if (typeof body.content !== "string") throw new Error("缺少 content");
				const kind = typeof body.kind === "string" && body.kind.trim() ? body.kind.trim() : undefined;
				const saved = await host.savePanel({ name, content: body.content, kind });
				host.notify("info", `已保存面板「${saved.name}」`);
				sendJson(res, 200, { ok: true, ...saved });
				return true;
			}

			// ---- 会话管理（PLAN-PANELS §2.1）：重命名/删除/导出/全文搜索 ----
			case "GET /api/sessions/search": {
				sendJson(res, 200, { hits: await host.searchSessions(query.get("q") ?? "") });
				return true;
			}
			case "POST /api/sessions/rename": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { path?: string; name?: string };
				if (!body.path || !body.name?.trim()) throw new Error("缺少 path / name");
				await host.renameSession(body.path, body.name);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "DELETE /api/sessions": {
				if (refuseWhileStreaming()) return true;
				const path = query.get("path") ?? "";
				if (!path) throw new Error("缺少 path");
				await host.deleteSession(path);
				host.notify("info", "会话已删除");
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "GET /api/sessions/export": {
				const path = query.get("path") ?? "";
				if (!path) throw new Error("缺少 path");
				const content = await host.readSessionFile(path);
				res.writeHead(200, {
					"content-type": "application/x-ndjson; charset=utf-8",
					"content-disposition": `attachment; filename="session.jsonl"; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
				});
				res.end(content);
				return true;
			}

			// ---- 卡前端(一档皮肤,spec 2026-07-22 §7 P1) ----
			case "GET /api/cardfront": {
				// 与 GET /api/card 同：当前卡用 resolvePath（支持按路径换卡的非库内路径）
				// 载荷必须与 hello.cardfront 同源(buildCardFrontSnapshot)
				sendJson(res, 200, loadCardFrontSnapshot(host.cwd));
				return true;
			}
			case "PUT /api/cardfront": {
				const body = JSON.parse(await readBody(req)) as { enabled?: boolean };
				if (typeof body.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
				const config = loadConfig(host.cwd);
				writeJsonWithBackup(configPath(host.cwd), setSkinEnabled(config, config.card, body.enabled));
				sendJson(res, 200, { ok: true, enabled: body.enabled });
				return true;
			}

			// ---- 卡前端正则脚本分组（三分类：global/card/preset；scope=card 必带 card= 路径参数） ----
			// 契约：POST/PUT 规则的 findRegex 可带 /pattern/flags 或裸串，服务端用 parseFindRegex 拆成 source+flags 存储。
			case "GET /api/cardfront/groups": {
				const scope = assertGroupScope(query.get("scope"));
				const card = query.get("card");
				const r = readGroupScope(host.cwd, scope, card);
				sendJson(res, 200, {
					ok: true,
					groups: r.groups,
					...(r.card ? { card: r.card } : {}),
					...(r.preset !== undefined ? { preset: r.preset } : {}),
				});
				return true;
			}
			case "POST /api/cardfront/groups": {
				const scope = assertGroupScope(query.get("scope"));
				const card = query.get("card");
				const body = JSON.parse(await readBody(req)) as { name?: string };
				if (typeof body.name !== "string") throw new Error("缺少 name");
				const r = readGroupScope(host.cwd, scope, card);
				const groups = addGroup(r.groups, body.name.trim());
				writeGroupScope(host.cwd, scope, card, groups);
				sendJson(res, 200, { ok: true, groups });
				return true;
			}
			case "PUT /api/cardfront/groups": {
				const scope = assertGroupScope(query.get("scope"));
				const card = query.get("card");
				const body = JSON.parse(await readBody(req)) as {
					index?: number;
					group?: { name?: string; off?: unknown };
				};
				if (typeof body.index !== "number" || !body.group) throw new Error("缺少 index / group");
				const patch: { name?: string; off?: boolean } = {};
				if (body.group.name !== undefined) {
					if (typeof body.group.name !== "string") throw new Error("name 必须是字符串");
					patch.name = body.group.name.trim();
				}
				if (body.group.off !== undefined) {
					if (typeof body.group.off !== "boolean") throw new Error("off 必须是布尔值");
					patch.off = body.group.off;
				}
				const r = readGroupScope(host.cwd, scope, card);
				if (body.index < 0 || body.index >= r.groups.length) throw new Error("index 越界");
				const groups = updateGroup(r.groups, body.index, patch);
				writeGroupScope(host.cwd, scope, card, groups);
				sendJson(res, 200, { ok: true, groups });
				return true;
			}
			case "DELETE /api/cardfront/groups": {
				const scope = assertGroupScope(query.get("scope"));
				const card = query.get("card");
				const rawIndex = query.get("index");
				if (rawIndex === null || !/^\d+$/.test(rawIndex)) throw new Error("缺少合法的 index");
				const index = Number(rawIndex);
				const r = readGroupScope(host.cwd, scope, card);
				if (index < 0 || index >= r.groups.length) throw new Error("index 越界");
				if (r.groups[index].name === "") throw new Error("未分组组不可删除");
				const groups = removeGroup(r.groups, index);
				writeGroupScope(host.cwd, scope, card, groups);
				sendJson(res, 200, { ok: true, groups });
				return true;
			}
			case "POST /api/cardfront/groups/move": {
				const scope = assertGroupScope(query.get("scope"));
				const card = query.get("card");
				const body = JSON.parse(await readBody(req)) as { index?: number; delta?: number };
				if (typeof body.index !== "number" || (body.delta !== -1 && body.delta !== 1)) {
					throw new Error("index / delta 不合法（delta 必须为 -1 或 1）");
				}
				const r = readGroupScope(host.cwd, scope, card);
				const target = body.index + body.delta;
				if (body.index < 0 || body.index >= r.groups.length || target < 0 || target >= r.groups.length) {
					throw new Error("index 越界");
				}
				const groups = moveGroup(r.groups, body.index, body.delta);
				writeGroupScope(host.cwd, scope, card, groups);
				sendJson(res, 200, { ok: true, groups });
				return true;
			}
			case "POST /api/cardfront/groups/copy": {
				const body = JSON.parse(await readBody(req)) as {
					from?: { scope?: string; card?: string; group?: number };
					to?: { scope?: string; card?: string };
				};
				if (!body.from || !body.to) throw new Error("缺少 from / to");
				const fromScope = assertGroupScope(body.from.scope ?? null);
				const toScope = assertGroupScope(body.to.scope ?? null);
				if (typeof body.from.group !== "number") throw new Error("缺少 from.group");
				if (fromScope === "card" && !body.from.card) throw new Error("from.scope=card 时缺少 from.card");
				if (toScope === "card" && !body.to.card) throw new Error("to.scope=card 时缺少 to.card");
				const src = readGroupScope(host.cwd, fromScope, body.from.card ?? null);
				if (body.from.group < 0 || body.from.group >= src.groups.length) throw new Error("from.group 越界");
				// from/to 同分类时基于同一份列表追加（生成副本），否则独立读目标列表
				const sameScope = fromScope === toScope && body.from.card === body.to.card;
				const targetGroups = sameScope ? src.groups : readGroupScope(host.cwd, toScope, body.to.card ?? null).groups;
				const groups = copyGroup(src.groups, body.from.group, targetGroups);
				writeGroupScope(host.cwd, toScope, body.to.card ?? null, groups);
				sendJson(res, 200, { ok: true, groups });
				return true;
			}
			case "POST /api/cardfront/rules": {
				const scope = assertGroupScope(query.get("scope"));
				const card = query.get("card");
				const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
				if (typeof body.group !== "number") throw new Error("缺少 group");
				if (typeof body.findRegex !== "string" || !body.findRegex.trim()) throw new Error("缺少 findRegex");
				if (typeof body.replace !== "string") throw new Error("缺少 replace");
				const parsed = parseFindRegex(body.findRegex);
				if (!parsed) throw new Error("findRegex 不是合法的正则表达式");
				const extra = validateRuleBodyFields(body);
				const r = readGroupScope(host.cwd, scope, card);
				// 空组兜底:全新配置 groups=[] 时补未分组组,保证 group=0 可承接规则
				const groups0 = ensureUngrouped(r.groups);
				if (body.group < 0 || body.group >= groups0.length) throw new Error("group 越界");
				const groups = addRule(groups0, body.group, {
					...extra,
					name: extra.name ?? "",
					source: parsed.source,
					flags: parsed.flags,
					replace: body.replace,
				});
				writeGroupScope(host.cwd, scope, card, groups);
				sendJson(res, 200, { ok: true, groups });
				return true;
			}
			case "PUT /api/cardfront/rules": {
				const scope = assertGroupScope(query.get("scope"));
				const card = query.get("card");
				const body = JSON.parse(await readBody(req)) as {
					group?: number;
					index?: number;
					rule?: Record<string, unknown>;
					toGroup?: number;
				};
				if (
					typeof body.group !== "number" ||
					typeof body.index !== "number" ||
					!body.rule ||
					typeof body.rule !== "object" ||
					Array.isArray(body.rule)
				) {
					throw new Error("缺少 group / index / rule");
				}
				const rule = body.rule;
				if (typeof rule.findRegex !== "string" || !rule.findRegex.trim()) throw new Error("缺少 findRegex");
				if (typeof rule.replace !== "string") throw new Error("缺少 replace");
				const parsed = parseFindRegex(rule.findRegex);
				if (!parsed) throw new Error("findRegex 不是合法的正则表达式");
				const extra = validateRuleBodyFields(rule);
				const r = readGroupScope(host.cwd, scope, card);
				// 空组兜底:全新配置 groups=[] 时补未分组组,保证 group=0 可更新
				const groups0 = ensureUngrouped(r.groups);
				if (body.group < 0 || body.group >= groups0.length) throw new Error("group 越界");
				if (body.index < 0 || body.index >= groups0[body.group].rules.length) throw new Error("index 越界");
				if (body.toGroup !== undefined && (body.toGroup < 0 || body.toGroup >= groups0.length)) {
					throw new Error("toGroup 越界");
				}
				const groups = updateRule(
					groups0,
					body.group,
					body.index,
					{
						...extra,
						name: extra.name ?? "",
						source: parsed.source,
						flags: parsed.flags,
						replace: rule.replace,
					},
					body.toGroup,
				);
				writeGroupScope(host.cwd, scope, card, groups);
				sendJson(res, 200, { ok: true, groups });
				return true;
			}
			case "DELETE /api/cardfront/rules": {
				const scope = assertGroupScope(query.get("scope"));
				const card = query.get("card");
				const rawGroup = query.get("group");
				const rawIndex = query.get("index");
				if (rawGroup === null || !/^\d+$/.test(rawGroup) || rawIndex === null || !/^\d+$/.test(rawIndex)) {
					throw new Error("缺少合法的 group / index");
				}
				const group = Number(rawGroup);
				const index = Number(rawIndex);
				const r = readGroupScope(host.cwd, scope, card);
				if (group < 0 || group >= r.groups.length) throw new Error("group 越界");
				if (index < 0 || index >= r.groups[group].rules.length) throw new Error("index 越界");
				const groups = removeRule(r.groups, group, index);
				writeGroupScope(host.cwd, scope, card, groups);
				sendJson(res, 200, { ok: true, groups });
				return true;
			}
			case "POST /api/cardfront/rules/move": {
				const scope = assertGroupScope(query.get("scope"));
				const card = query.get("card");
				const body = JSON.parse(await readBody(req)) as { group?: number; index?: number; delta?: number };
				if (
					typeof body.group !== "number" ||
					typeof body.index !== "number" ||
					(body.delta !== -1 && body.delta !== 1)
				) {
					throw new Error("group / index / delta 不合法（delta 必须为 -1 或 1）");
				}
				const r = readGroupScope(host.cwd, scope, card);
				if (body.group < 0 || body.group >= r.groups.length) throw new Error("group 越界");
				const srcRules = r.groups[body.group].rules;
				const target = body.index + body.delta;
				if (body.index < 0 || body.index >= srcRules.length || target < 0 || target >= srcRules.length) {
					throw new Error("index 越界");
				}
				const groups = moveRule(r.groups, body.group, body.index, body.delta);
				writeGroupScope(host.cwd, scope, card, groups);
				sendJson(res, 200, { ok: true, groups });
				return true;
			}
			case "PUT /api/cardfront/rule-off": {
				const body = JSON.parse(await readBody(req)) as { key?: string; off?: boolean };
				if (typeof body.key !== "string" || !body.key.trim()) throw new Error("缺少 key");
				if (typeof body.off !== "boolean") throw new Error("off 必须是布尔值");
				let config = loadConfig(host.cwd);
				config = setCardRuleOff(config, config.card, body.key, body.off);
				writeJsonWithBackup(configPath(host.cwd), config);
				sendJson(res, 200, { ok: true, ruleOff: (config.cardRuleOff ?? {})[config.card] ?? [] });
				return true;
			}
			// ---- 卡内嵌规则编辑(覆盖层,不改卡文件;作用于当前卡 config.card) ----
			// 契约:写入/还原后返回 card 段最新状态(与 GET groups?scope=card 的 card 段一致,前端直接替换)。
			// 关闭判定:覆盖里的 disabled=true 与 ruleOff 双保险无冲突——还原后原卡 disabled 恢复,ruleOff 独立工作。
			case "PUT /api/cardfront/cardrule": {
				const body = JSON.parse(await readBody(req)) as { key?: string; rule?: Record<string, unknown> };
				if (typeof body.key !== "string" || !body.key.trim()) throw new Error("缺少 key");
				if (!body.rule || typeof body.rule !== "object" || Array.isArray(body.rule)) throw new Error("缺少 rule");
				const ruleBody = body.rule;
				if (typeof ruleBody.findRegex !== "string" || !ruleBody.findRegex.trim()) throw new Error("缺少 findRegex");
				if (typeof ruleBody.replace !== "string") throw new Error("缺少 replace");
				const parsed = parseFindRegex(ruleBody.findRegex);
				if (!parsed) throw new Error("findRegex 不是合法的正则表达式");
				const extra = validateRuleBodyFields(ruleBody);
				const config = loadConfig(host.cwd);
				const rule: DisplayRule = {
					...extra,
					name: extra.name ?? "",
					source: parsed.source,
					flags: parsed.flags,
					replace: ruleBody.replace,
				};
				const next = setCardRuleOverride(config, config.card, body.key.trim(), rule);
				writeJsonWithBackup(configPath(host.cwd), next);
				sendJson(res, 200, { ok: true, card: cardFrontCardState(host.cwd, config.card) });
				return true;
			}
			case "DELETE /api/cardfront/cardrule": {
				const key = (query.get("key") ?? "").trim();
				if (!key) throw new Error("缺少 key");
				const config = loadConfig(host.cwd);
				const next = removeCardRuleOverride(config, config.card, key);
				writeJsonWithBackup(configPath(host.cwd), next);
				sendJson(res, 200, { ok: true, card: cardFrontCardState(host.cwd, config.card) });
				return true;
			}

			// ---- 卡库（PLAN-PANELS §2.7）：清单/立绘/导入/收藏 ----
			case "GET /api/cards": {
				const config = loadConfig(host.cwd);
				const favs = new Set(loadFavs(host.cwd));
				sendJson(res, 200, {
					current: config.card,
					cards: listCardLibrary(host.cwd, config).map((c) => ({ ...c, fav: favs.has(c.path) })),
				});
				return true;
			}
			case "GET /api/cards/image": {
				const p = query.get("path") ?? "";
				const abs = assertLibraryCard(host.cwd, loadConfig(host.cwd), p);
				if (!/\.png$/i.test(abs)) throw new Error("该卡没有内嵌立绘（JSON 卡）");
				// 路径稳定即可长缓存；避免卡库↔详情来回时封面反复重下
				let mtime = 0;
				try {
					mtime = statSync(abs).mtimeMs;
				} catch {
					/* ignore */
				}
				res.writeHead(200, {
					"content-type": "image/png",
					"cache-control": "public, max-age=604800, immutable",
					etag: `"${mtime.toString(16)}"`,
				});
				res.end(readFileSync(abs));
				return true;
			}
			case "POST /api/cards/import": {
				const rawName = (query.get("name") ?? "").trim();
				if (!rawName || !/\.(png|json)$/i.test(rawName)) throw new Error("文件名必须以 .png 或 .json 结尾");
				const safe = rawName.replace(/[\\/:*?"<>|]/g, "-");
				const dir = join(host.cwd, "assets", "cards");
				mkdirSync(dir, { recursive: true });
				const dest = join(dir, safe);
				if (existsSync(dest)) throw new Error(`同名卡已存在：${safe}`);
				const data = await readBodyRaw(req, MAX_UPLOAD);
				if (data.length === 0) throw new Error("文件内容为空");
				writeFileSync(dest, data);
				try {
					const card = loadCardFile(dest);
					if (!card.name.trim()) throw new Error("卡名为空");
					host.notify("info", `已导入角色卡「${card.name}」`);
					sendJson(res, 200, {
						ok: true,
						path: `assets/cards/${safe}`,
						name: card.name,
						embeddedLoreCount: card.book.length,
					});
				} catch (e) {
					unlinkSync(dest); // 坏卡不留盘
					throw new Error(`不是有效的角色卡：${e instanceof Error ? e.message : String(e)}`);
				}
				return true;
			}
			/**
			 * 删除角色卡。query：
			 * - path：卡库内相对路径（必填）
			 * - lore=1：连同配套世界书（assets/lorebooks/<卡名>.json 及 -N 变体）一起删并取消挂载
			 * - data=1：连同相关数据（该卡全部会话、补充设定集、persona 卡锁定）一起删；
			 *   不带则数据保留，重新导入同路径同名卡可无缝续玩
			 * 删除当前使用中的卡：先自动切到默认卡（或卡库剩余第一张），最后一张卡拒删。
			 */
			case "DELETE /api/cards": {
				if (refuseWhileStreaming()) return true;
				const p = query.get("path") ?? "";
				const wantLore = query.get("lore") === "1";
				const wantData = query.get("data") === "1";
				let config = loadConfig(host.cwd);
				const abs = assertLibraryCard(host.cwd, config, p);
				let cardName = basename(p).replace(/\.(png|json)$/i, "");
				try {
					cardName = loadCardFile(abs).name || cardName;
				} catch {
					// 坏卡也允许删，名字退回文件名
				}
				const isCurrent = !!config.card && resolvePath(host.cwd, config.card) === abs;

				// 删当前卡：先切走（默认卡优先，其次卡库剩余第一张；没有可去处则拒绝）
				let switchedTo: string | null = null;
				if (isCurrent) {
					const others = listCardLibrary(host.cwd, config).filter((c) => resolvePath(host.cwd, c.path) !== abs);
					const fallback = others.find((c) => c.path === DEFAULT_CONFIG.card) ?? others[0];
					if (!fallback) throw new Error("这是卡库里最后一张卡，删掉就没有可用角色了：请先导入其它卡");
					const raw = config as unknown as Record<string, unknown>;
					delete raw.displayName;
					delete raw.greetingIndex;
					raw.card = fallback.path;
					writeJsonWithBackup(configPath(host.cwd), raw);
					const persona = personaForCard(loadPersonas(host.cwd), fallback.path);
					if (persona) projectPersonaToConfig(host.cwd, persona);
					await host.switchToCard();
					switchedTo = fallback.path;
					config = loadConfig(host.cwd);
				}

				// 卡本体
				unlinkSync(abs);
				cardMetaCache.delete(abs);
				const favs = loadFavs(host.cwd);
				if (favs.includes(p)) {
					saveFavs(host.cwd, favs.filter((f) => f !== p));
				}

				// 配套世界书：与 import-embedded-lore 同一命名推导（<卡名>.json / <卡名>-N.json）
				let deletedLore = 0;
				if (wantLore) {
					const safeBase = cardName.replace(/[\\/:*?"<>|]/g, "-").trim() || "card-lore";
					const rx = new RegExp(`^${safeBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d+)?\\.json$`, "i");
					const dir = join(host.cwd, LOREBOOKS_DIR);
					const gone: string[] = [];
					if (existsSync(dir)) {
						for (const f of readdirSync(dir)) {
							if (!rx.test(f)) continue;
							try {
								unlinkSync(join(dir, f));
								gone.push(`${LOREBOOKS_DIR}/${f}`);
							} catch {
								// 删不掉的留着，挂载也别拆
							}
						}
					}
					if (gone.length > 0) {
						const mounted = mountedLorebookPaths(config).filter((m) => !gone.includes(m));
						writeJsonWithBackup(configPath(host.cwd), setMountedLorebooks(config, mounted));
						await host.softRefreshConfig();
					}
					deletedLore = gone.length;
				}

				// 相关数据：会话 + 补充设定集 + persona 卡锁定（保留则重新导入同路径卡即无缝续玩）
				let deletedSessions = 0;
				if (wantData) {
					deletedSessions = await host.deleteCardSessions(p);
					const overlay = overlayPathFor(host.cwd, cardName);
					if (existsSync(overlay)) {
						try {
							unlinkSync(overlay);
						} catch {
							/* 不挡 */
						}
					}
					const pstore = loadPersonas(host.cwd);
					if (pstore.byCard[p]) {
						const byCard = { ...pstore.byCard };
						delete byCard[p];
						savePersonas(host.cwd, { ...pstore, byCard });
					}
				}

				host.notify(
					"info",
					`已删除角色卡「${cardName}」${wantLore && deletedLore > 0 ? `，配套世界书 ${deletedLore} 本` : ""}${wantData ? `，相关数据（会话 ${deletedSessions} 个）` : "（数据保留，重新导入可续玩）"}${switchedTo ? `；已切换到「${basename(switchedTo)}」` : ""}`,
				);
				sendJson(res, 200, { ok: true, deletedLore, deletedSessions, switchedTo });
				return true;
			}
			case "POST /api/cards/fav": {
				const body = JSON.parse(await readBody(req)) as { path?: string; fav?: boolean };
				if (!body.path) throw new Error("缺少 path");
				const favs = new Set(loadFavs(host.cwd));
				if (body.fav) favs.add(body.path);
				else favs.delete(body.path);
				saveFavs(host.cwd, [...favs]);
				sendJson(res, 200, { ok: true });
				return true;
			}

			// ---- 世界状态编辑（PLAN-PANELS §2.11）：用户主权，applyPatch 语义，不经模型 ----
			case "PUT /api/state": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { patch?: Record<string, unknown> };
				if (!body.patch || typeof body.patch !== "object") throw new Error("缺少 patch");
				const r = await host.applyStatePatch(body.patch);
				sendJson(res, 200, r);
				return true;
			}

			// ---- 用户角色 persona（PLAN-PANELS-V2 §2.5）：多身份清单/创建/选择/编辑/删除/按卡锁定 ----
			case "GET /api/personas": {
				let store = loadPersonas(host.cwd);
				const config = loadConfig(host.cwd);
				// 迁移：首次使用且 config 已有单人设 → 自动收编为第一个 persona
				if (store.personas.length === 0 && config.userName) {
					const r = createPersona(store, { name: config.userName, persona: config.userPersona });
					store = { ...r.store, current: r.id };
					savePersonas(host.cwd, store);
				}
				const active = personaForCard(store, config.card);
				sendJson(res, 200, {
					personas: store.personas,
					current: store.current,
					lockedForCard: store.byCard[config.card] ?? null,
					activeId: active?.id ?? null,
				});
				return true;
			}
			case "POST /api/personas": {
				const body = JSON.parse(await readBody(req)) as { name?: string; persona?: string };
				if (!body.name?.trim()) throw new Error("缺少名字");
				const store = loadPersonas(host.cwd);
				const r = createPersona(store, { name: body.name, persona: body.persona });
				// 第一个 persona 自动成为全局默认
				savePersonas(host.cwd, r.store.current === null ? { ...r.store, current: r.id } : r.store);
				sendJson(res, 200, { ok: true, id: r.id });
				return true;
			}
			case "PUT /api/personas": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { id?: string; name?: string; persona?: string };
				if (!body.id) throw new Error("缺少 id");
				const store = loadPersonas(host.cwd);
				if (!findPersona(store, body.id)) throw new Error("身份不存在");
				const next = updatePersona(store, body.id, { name: body.name, persona: body.persona });
				savePersonas(host.cwd, next);
				// 改的是当前生效身份 → 投影进 config 并重载
				const config = loadConfig(host.cwd);
				const active = personaForCard(next, config.card);
				if (active?.id === body.id) {
					projectPersonaToConfig(host.cwd, active);
					await host.softRefreshConfig();
				}
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "DELETE /api/personas": {
				const id = query.get("id") ?? "";
				const store = loadPersonas(host.cwd);
				if (!findPersona(store, id)) throw new Error("身份不存在");
				if (store.personas.length <= 1) throw new Error("至少保留一个身份");
				savePersonas(host.cwd, deletePersona(host.cwd, store, id));
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/personas/select": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { id?: string; lockToCard?: boolean };
				const store = loadPersonas(host.cwd);
				const p = findPersona(store, body.id ?? "");
				if (!p) throw new Error("身份不存在");
				const config = loadConfig(host.cwd);
				const byCard = { ...store.byCard };
				if (body.lockToCard === true) byCard[config.card] = p.id;
				else if (body.lockToCard === false) delete byCard[config.card];
				savePersonas(host.cwd, { ...store, current: body.lockToCard ? store.current : p.id, byCard });
				projectPersonaToConfig(host.cwd, p);
				await host.softRefreshConfig();
				host.notify("info", `已切换身份：${p.name}`);
				sendJson(res, 200, { ok: true });
				return true;
			}
			/** 上传裁剪后的头像（raw PNG/JPEG 字节，ST 式方形头像由前端裁完再传） */
			case "POST /api/personas/avatar": {
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const store = loadPersonas(host.cwd);
				if (!findPersona(store, id)) throw new Error("身份不存在");
				const data = await readBodyRaw(req, 8 * 1024 * 1024); // 裁后头像上限 8MB
				const next = savePersonaAvatar(host.cwd, store, id, data);
				savePersonas(host.cwd, next);
				const p = findPersona(next, id)!;
				host.notify("info", `已更新头像：${p.name}`);
				sendJson(res, 200, { ok: true, avatar: p.avatar });
				return true;
			}
			case "GET /api/personas/avatar": {
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const store = loadPersonas(host.cwd);
				const p = findPersona(store, id);
				if (!p?.avatar) {
					res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "无头像" }));
					return true;
				}
				const abs = resolvePath(host.cwd, p.avatar);
				if (!existsSync(abs)) {
					res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "头像文件缺失" }));
					return true;
				}
				const buf = readFileSync(abs);
				const isPng = buf[0] === 0x89 && buf[1] === 0x50;
				res.writeHead(200, {
					"content-type": isPng ? "image/png" : "image/jpeg",
					// 头像 URL 常带 bust 参数；允许短缓存减少切换闪烁
					"cache-control": "public, max-age=3600",
					"content-length": buf.length,
				});
				res.end(buf);
				return true;
			}
			case "DELETE /api/personas/avatar": {
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const store = loadPersonas(host.cwd);
				if (!findPersona(store, id)) throw new Error("身份不存在");
				const next = clearPersonaAvatar(host.cwd, store, id);
				savePersonas(host.cwd, next);
				sendJson(res, 200, { ok: true });
				return true;
			}

			// ---- 多预设管理（PLAN-PANELS-V2 §2.6） ----
			case "GET /api/presets": {
				const config = loadConfig(host.cwd);
				sendJson(res, 200, { active: config.preset ?? null, presets: listPresetFiles(host.cwd) });
				return true;
			}
			case "POST /api/presets/select": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { file?: string | null };
				const config = loadConfig(host.cwd) as unknown as Record<string, unknown>;
				// 切换预设：丢弃未保存草稿
				clearPresetOverride(host.cwd);
				if (body.file === null || body.file === "") {
					delete config.preset; // 不用预设
				} else {
					const file = validatePresetPath(body.file ?? "");
					if (!existsSync(resolvePath(host.cwd, file))) throw new Error("预设文件不存在");
					config.preset = file;
				}
				writeJsonWithBackup(configPath(host.cwd), config);
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/presets/saveas": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { name?: string };
				const name = (body.name ?? "").trim();
				if (!name) throw new Error("缺少预设名");
				const config = loadConfig(host.cwd);
				// 另存：取当前生效内容（含未保存草稿）
				const current: RpPreset = loadEffectivePreset(host.cwd).preset
					?? (config.preset
						? normalizeRpPreset(JSON.parse(readFileSync(resolvePath(host.cwd, config.preset), "utf8")))
						: { name, samplers: {}, blocks: [] });
				const file = `${PRESETS_DIR}/${presetSlug(name)}.json`;
				const abs = resolvePath(host.cwd, file);
				if (existsSync(abs)) throw new Error(`同名预设文件已存在：${file}`);
				mkdirSync(join(host.cwd, PRESETS_DIR), { recursive: true });
				clearPresetOverride(host.cwd);
				writeJsonWithBackup(abs, { ...current, name });
				writeJsonWithBackup(configPath(host.cwd), { ...loadConfig(host.cwd), preset: file });
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true, file });
				return true;
			}
			case "POST /api/presets/rename": {
				const body = JSON.parse(await readBody(req)) as { file?: string; name?: string };
				const file = validatePresetPath(body.file ?? "");
				const name = (body.name ?? "").trim();
				if (!name) throw new Error("缺少新名字");
				const abs = resolvePath(host.cwd, file);
				const preset = normalizeRpPreset(JSON.parse(readFileSync(abs, "utf8")));
				writeJsonWithBackup(abs, { ...preset, name });
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "DELETE /api/presets": {
				if (refuseWhileStreaming()) return true;
				const file = validatePresetPath(query.get("file") ?? "");
				const abs = resolvePath(host.cwd, file);
				if (!existsSync(abs)) throw new Error("预设文件不存在");
				unlinkSync(abs);
				const config = loadConfig(host.cwd) as unknown as Record<string, unknown>;
				if (config.preset === file) {
					clearPresetOverride(host.cwd);
					delete config.preset;
					writeJsonWithBackup(configPath(host.cwd), config);
					await host.softRefreshConfig();
				}
				sendJson(res, 200, { ok: true });
				return true;
			}
			// 导入：ST 预设自动转换 / 梨园预设直接收档；存入 assets/presets/ 并切换启用
			case "POST /api/presets/import": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { name?: string; json?: Record<string, unknown> };
				if (!body.json || typeof body.json !== "object") throw new Error("缺少预设 JSON");
				const name = (body.name ?? "").trim() || "imported-preset";
				const isSt = Array.isArray(body.json.prompts) || Array.isArray(body.json.prompt_order);
				const { preset, report } = isSt
					? convertStPreset(body.json, name)
					: { preset: { ...normalizeRpPreset(body.json), name }, report: [] };
				const file = `${PRESETS_DIR}/${presetSlug(name)}.json`;
				const abs = resolvePath(host.cwd, file);
				mkdirSync(join(host.cwd, PRESETS_DIR), { recursive: true });
				clearPresetOverride(host.cwd);
				writeJsonWithBackup(abs, preset);
				writeJsonWithBackup(configPath(host.cwd), { ...loadConfig(host.cwd), preset: file });
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true, file, report, blockCount: preset.blocks.length, converted: isSt });
				return true;
			}
			case "GET /api/presets/export": {
				const file = validatePresetPath(query.get("file") ?? "");
				const abs = resolvePath(host.cwd, file);
				const preset = normalizeRpPreset(JSON.parse(readFileSync(abs, "utf8")));
				sendJson(res, 200, { name: preset.name, json: preset });
				return true;
			}

			// ---- 世界书文件管理（PLAN-PANELS-V2 §2.3：选书/导入/删除） ----
			case "GET /api/lorebooks": {
				const config = loadConfig(host.cwd);
				const active = mountedLorebookPaths(config);
				sendJson(res, 200, {
					/** 多本同时挂载；兼容旧前端：active 现为 string[] */
					active,
					/** @deprecated 旧单本字段：取 active[0] 或 null */
					activeOne: active[0] ?? null,
					books: listLorebookFiles(host.cwd, config),
				});
				return true;
			}
			/**
			 * 挂载多选：
			 * - { paths: string[] } 整体覆盖挂载列表（[] = 一本都不挂）
			 * - { path, enabled?: boolean } 单本开关（默认 enabled=true 切换为挂上；enabled=false 卸下）
			 * - { path: null } 清空全部挂载
			 * 角色卡与世界书无关：本接口不碰 card。
			 */
			case "POST /api/lorebooks/select": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					path?: string | null;
					paths?: string[];
					enabled?: boolean;
				};
				const config = loadConfig(host.cwd);
				const ensureBook = (p: string) => {
					const abs = resolvePath(host.cwd, p);
					if (!existsSync(abs) || loadLorebookFile(abs).length === 0) {
						throw new Error(`不是有效的世界书文件：${p}`);
					}
				};
				let nextPaths: string[];
				if (Array.isArray(body.paths)) {
					nextPaths = body.paths.map((p) => p.replace(/\\/g, "/")).filter(Boolean);
					for (const p of nextPaths) ensureBook(p);
				} else if (body.path === null || body.path === "") {
					nextPaths = [];
				} else if (typeof body.path === "string" && body.path.trim()) {
					const p = body.path.replace(/\\/g, "/");
					ensureBook(p);
					const cur = new Set(mountedLorebookPaths(config));
					const on = body.enabled !== false; // 默认挂上；传 false 卸下
					// 若未显式传 enabled 且已在列表中 → 视为切换（toggle）
					if (body.enabled === undefined) {
						if (cur.has(p)) cur.delete(p);
						else cur.add(p);
					} else if (on) cur.add(p);
					else cur.delete(p);
					nextPaths = [...cur];
				} else {
					throw new Error("缺少 path 或 paths");
				}
				const next = setMountedLorebooks(config, nextPaths);
				writeJsonWithBackup(configPath(host.cwd), next);
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true, active: nextPaths });
				return true;
			}
			case "POST /api/lorebooks/import": {
				const rawName = (query.get("name") ?? "").trim().replace(/\.json$/i, "");
				if (!rawName) throw new Error("缺少 name");
				const safe = `${rawName.replace(/[\\/:*?"<>|]/g, "-")}.json`;
				mkdirSync(join(host.cwd, LOREBOOKS_DIR), { recursive: true });
				const dest = join(host.cwd, LOREBOOKS_DIR, safe);
				if (existsSync(dest)) throw new Error(`同名世界书已存在：${safe}`);
				const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
				const entries = normalizeEntries(body.entries);
				if (entries.length === 0) throw new Error("不是有效的世界书（entries 为空）");
				writeFileSync(dest, `${JSON.stringify(body, null, "\t")}\n`, "utf8");
				host.notify("info", `世界书「${rawName}」已导入（${entries.length} 条）`);
				sendJson(res, 200, { ok: true, path: `${LOREBOOKS_DIR}/${safe}`, entryCount: entries.length });
				return true;
			}
			case "DELETE /api/lorebooks": {
				if (refuseWhileStreaming()) return true;
				const p = (query.get("path") ?? "").replace(/\\/g, "/");
				const base = p.startsWith(`${LOREBOOKS_DIR}/`) ? p.slice(LOREBOOKS_DIR.length + 1) : "";
				if (!base || base.includes("/") || base.includes("..") || !base.endsWith(".json")) {
					throw new Error("只能删除 assets/lorebooks/ 下的世界书（项目外的素材文件不动）");
				}
				const abs = join(host.cwd, LOREBOOKS_DIR, base);
				if (!existsSync(abs)) throw new Error("文件不存在");
				unlinkSync(abs);
				const config = loadConfig(host.cwd);
				const active = mountedLorebookPaths(config);
				if (active.includes(p)) {
					const next = setMountedLorebooks(
						config,
						active.filter((x) => x !== p),
					);
					writeJsonWithBackup(configPath(host.cwd), next);
					await host.softRefreshConfig();
				}
				sendJson(res, 200, { ok: true });
				return true;
			}

			// ---- 知识库管理（PLAN-PANELS-V2 §2.4：建库/改名/删除/挂载按钮，用户主权） ----
			case "POST /api/codex": {
				const body = JSON.parse(await readBody(req)) as { name?: string; description?: string };
				const r = createCodex(host.cwd, body.name ?? "", body.description ?? "");
				if (!r.ok) throw new Error(r.error);
				host.notify("info", `知识库「${r.meta.name}」已创建`);
				sendJson(res, 200, { ok: true, name: r.meta.name });
				return true;
			}
			case "POST /api/codex/rename": {
				const body = JSON.parse(await readBody(req)) as { name?: string; newName?: string };
				const meta = findCodex(host.cwd, body.name ?? "");
				if (!meta) throw new Error(`知识库不存在：${body.name}`);
				const newName = (body.newName ?? "").trim();
				if (!newName) throw new Error("缺少新名字");
				if (host.mountedCodexes().some((n) => n.toLowerCase() === meta.name.toLowerCase())) {
					throw new Error("该库已挂载到当前对话，先卸载再改名");
				}
				if (findCodex(host.cwd, newName)) throw new Error(`已存在同名知识库：${newName}`);
				const r = createCodex(host.cwd, newName, meta.description);
				if (!r.ok) throw new Error(r.error);
				// 搬条目：读旧文件原始 entries 写入新文件（保 uid 与灯法字段）
				const oldRaw = JSON.parse(readFileSync(meta.file, "utf8")) as Record<string, unknown>;
				const newRaw = JSON.parse(readFileSync(r.meta.file, "utf8")) as Record<string, unknown>;
				writeFileSync(r.meta.file, `${JSON.stringify({ ...newRaw, entries: oldRaw.entries ?? [] }, null, "\t")}\n`, "utf8");
				unlinkSync(meta.file);
				sendJson(res, 200, { ok: true, name: newName });
				return true;
			}
			case "DELETE /api/codex": {
				const name = query.get("name") ?? "";
				const meta = findCodex(host.cwd, name);
				if (!meta) throw new Error(`知识库不存在：${name}`);
				if (host.mountedCodexes().some((n) => n.toLowerCase() === meta.name.toLowerCase())) {
					throw new Error("该库已挂载到当前对话，先卸载再删除");
				}
				unlinkSync(meta.file);
				host.notify("info", `知识库「${meta.name}」已删除`);
				sendJson(res, 200, { ok: true });
				return true;
			}
			// 挂载/卸载：经命令桥走扩展 /codexmount（与 codex_mount 工具同一内存+树快照路径）
			case "POST /api/codex/mount": {
				const body = JSON.parse(await readBody(req)) as { name?: string; mounted?: boolean };
				const meta = findCodex(host.cwd, body.name ?? "");
				if (!meta) throw new Error(`知识库不存在：${body.name}`);
				const queued = host.queueCommand(`/codexmount ${body.mounted ? "mount" : "unmount"} ${meta.name}`);
				sendJson(res, 200, { ok: true, queued });
				return true;
			}

			// ---- 角色卡字段编辑（JSON + PNG tEXt 回写） ----
			case "PUT /api/card": {
				if (refuseWhileStreaming()) return true;
				const patch = JSON.parse(await readBody(req)) as CardFieldPatch;
				const config = loadConfig(host.cwd);
				updateCardFields(resolvePath(host.cwd, config.card), patch);
				await host.softRefreshConfig(); // 卡字段进 system prompt，必须重装
				sendJson(res, 200, { ok: true });
				return true;
			}
			/**
			 * 导出当前角色卡（含可选世界书合并）。
			 * query: format=json|png，lore=active|embedded|none
			 * - active（默认）：挂载世界书 + 本卡补充设定 + 原内嵌书（指纹去重），即「改过之后」的创作态
			 * - embedded：仅卡内原 character_book
			 * - none：不带世界书
			 */
			case "GET /api/card/export": {
				const config = loadConfig(host.cwd);
				const format = (query.get("format") ?? "json").toLowerCase() === "png" ? "png" : "json";
				const loreRaw = (query.get("lore") ?? "active").toLowerCase();
				const loreMode: CardExportLoreMode =
					loreRaw === "none" || loreRaw === "embedded" ? loreRaw : "active";
				const abs = resolvePath(host.cwd, config.card);
				const bookEntries =
					loreMode === "active" ? collectActiveLoreForExport(host.cwd, config) : undefined;
				const exp = exportCardFile(abs, { format, loreMode, bookEntries });
				res.writeHead(200, {
					"content-type": exp.mime,
					"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exp.filename)}`,
					"cache-control": "no-store",
					"x-liyuan-lore-mode": exp.loreMode,
					"x-liyuan-lore-count": String(exp.loreCount),
				});
				res.end(exp.body);
				return true;
			}
			/** 开场白 CRUD：index 0=first_mes，1..=alternate_greetings */
			case "PUT /api/card/greetings": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					index?: number;
					text?: string;
					greetings?: string[];
				};
				const config = loadConfig(host.cwd);
				const abs = resolvePath(host.cwd, config.card);
				if (Array.isArray(body.greetings)) {
					setCardGreetings(
						abs,
						body.greetings.map((t) => String(t ?? "")),
					);
				} else if (typeof body.index === "number" && typeof body.text === "string") {
					updateCardGreeting(abs, body.index, body.text);
				} else {
					throw new Error("需要 greetings[] 或 index+text");
				}
				// 若当前选中序号越界，钳回
				const card = loadCardFile(abs);
				const max = card.alternateGreetings.length;
				const gi = config.greetingIndex ?? 0;
				if (gi > max) {
					writeJsonWithBackup(configPath(host.cwd), { ...config, greetingIndex: 0 });
				}
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/card/greetings": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { text?: string };
				const config = loadConfig(host.cwd);
				const abs = resolvePath(host.cwd, config.card);
				const index = addCardGreeting(abs, body.text ?? "");
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true, index });
				return true;
			}
			case "DELETE /api/card/greetings": {
				if (refuseWhileStreaming()) return true;
				const index = Number.parseInt(query.get("index") ?? "", 10);
				if (!Number.isFinite(index)) throw new Error("缺少 index");
				const config = loadConfig(host.cwd);
				const abs = resolvePath(host.cwd, config.card);
				deleteCardGreeting(abs, index);
				const card = loadCardFile(abs);
				const max = card.alternateGreetings.length;
				let gi = config.greetingIndex ?? 0;
				if (gi > max) gi = 0;
				else if (gi === index) gi = Math.max(0, index - 1);
				else if (gi > index) gi = gi - 1;
				writeJsonWithBackup(configPath(host.cwd), { ...config, greetingIndex: gi });
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true, greetingIndex: gi });
				return true;
			}
			/** 开场白上移/下移：{ index, delta: -1|1 } */
			case "POST /api/card/greetings/move": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { index?: number; delta?: number };
				const index = typeof body.index === "number" ? body.index : Number.NaN;
				const delta = body.delta === -1 || body.delta === 1 ? body.delta : Number.NaN;
				if (!Number.isFinite(index) || !Number.isFinite(delta)) throw new Error("需要 index 与 delta（-1 上移 / 1 下移）");
				const config = loadConfig(host.cwd);
				const abs = resolvePath(host.cwd, config.card);
				const to = moveCardGreeting(abs, index, delta);
				const gi0 = config.greetingIndex ?? 0;
				const gi = remapGreetingIndexAfterMove(gi0, index, to);
				if (gi !== gi0) {
					writeJsonWithBackup(configPath(host.cwd), { ...config, greetingIndex: gi });
				}
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true, index: to, greetingIndex: gi });
				return true;
			}

			// ---- 模型 ----
			case "GET /api/models": {
				// 打开连接面板时：agent.json → models.json，并重绑当前模型（手改 maxTokens 等无需整进程重启）
				loadOrSeedAgentConfig(host);
				await rebindCurrentModel(host);
				sendJson(res, 200, host.listModels());
				return true;
			}
			// ---- 自定义 agent 管理 ----
			case "GET /api/agent-tools": {
				// 自定义 agent 管理界面的工具清单（stagehand 工具 + 内置 read/bash/edit/write）
				sendJson(res, 200, { tools: host.listAgentTools() });
				return true;
			}
			case "POST /api/models/select": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { provider?: string; id?: string };
				if (!body.provider || !body.id) throw new Error("缺少 provider / id");
				const current = await host.selectModel(body.provider, body.id);
				host.notify("info", `模型已切换：${current.name}`);
				sendJson(res, 200, { current });
				return true;
			}
			case "POST /api/models/thinking": {
				const body = JSON.parse(await readBody(req)) as { level?: string };
				if (!body.level) throw new Error("缺少 level");
				sendJson(res, 200, { current: host.setThinkingLevel(body.level) });
				return true;
			}

			// ---- API 连接 ----
			case "GET /api/auth": {
				sendJson(res, 200, { providers: host.authProviders() });
				return true;
			}
			case "POST /api/auth": {
				const body = JSON.parse(await readBody(req)) as { provider?: string; key?: string };
				if (!body.provider || !body.key) throw new Error("缺少 provider / key");
				host.setAuthKey(body.provider, body.key.trim());
				host.refreshModels();
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "DELETE /api/auth": {
				const provider = query.get("provider");
				if (!provider) throw new Error("缺少 provider");
				host.removeAuth(provider);
				host.refreshModels();
				sendJson(res, 200, { ok: true });
				return true;
			}
			// ---- 配置仓库 liyuan-profiles/ + 当前启用 liyuan.agent.json ----
			case "GET /api/agent-profiles": {
				loadOrSeedAgentConfig(host); // 触发迁移
				sendJson(res, 200, { profiles: listProfiles(host.cwd) });
				return true;
			}
			case "GET /api/agent-profiles/one": {
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const rec = loadProfile(host.cwd, id);
				if (!rec) throw new Error(`配置不存在：${id}`);
				sendJson(res, 200, {
					id: rec.id,
					name: rec.name,
					updatedAt: rec.updatedAt,
					config: rec.config,
					text: `${JSON.stringify(rec.config, null, "\t")}\n`,
				});
				return true;
			}
			/** 生成器：只写入仓库，不启用 */
			case "POST /api/agent-profiles": {
				const body = JSON.parse(await readBody(req)) as {
					id?: string;
					name?: string;
					config?: unknown;
					text?: string;
				};
				let parsed: unknown = body.config;
				if (typeof body.text === "string") {
					try {
						parsed = JSON.parse(body.text);
					} catch (e) {
						throw new Error(`JSON 无法解析：${e instanceof Error ? e.message : String(e)}`);
					}
				}
				if (!parsed) throw new Error("缺少 config 或 text");
				const config = normalizeAgentConfig(parsed);
				materializeEnvKeysInConfig(config);
				const idRaw = (body.id ?? body.name ?? Object.keys(config.providers)[0] ?? "").trim();
				if (!idRaw) throw new Error("请填写配置名");
				const name = (body.name ?? idRaw).trim();
				// 生成器只写入仓库，不启用；同名则覆盖仓库副本
				const rec = saveProfile(host.cwd, idRaw, name, config);
				host.notify("info", `配置「${rec.name}」已存入仓库（未启用）`);
				sendJson(res, 200, { ok: true, profile: { id: rec.id, name: rec.name, updatedAt: rec.updatedAt }, profiles: listProfiles(host.cwd) });
				return true;
			}
			/** 修改仓库中的配置（不自动启用，除非已是启用中的那份） */
			case "PUT /api/agent-profiles": {
				const body = JSON.parse(await readBody(req)) as {
					id?: string;
					name?: string;
					config?: unknown;
					text?: string;
				};
				const id = (body.id ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const prev = loadProfile(host.cwd, id);
				if (!prev) throw new Error(`配置不存在：${id}`);
				let parsed: unknown = body.config ?? prev.config;
				if (typeof body.text === "string") {
					try {
						parsed = JSON.parse(body.text);
					} catch (e) {
						throw new Error(`JSON 无法解析：${e instanceof Error ? e.message : String(e)}`);
					}
				}
				const config = normalizeAgentConfig(parsed);
				materializeEnvKeysInConfig(config);
				const name = (body.name ?? prev.name).trim();
				const rec = saveProfile(host.cwd, id, name, config);
				// 若正在启用这份，同步到 runtime 并重绑当前模型（contextWindow 等）
				const active = listProfiles(host.cwd).find((p) => p.active);
				if (active?.id === id) {
					persistAgentConfig(host, config);
					await rebindCurrentModel(host);
				}
				host.notify("info", `配置「${rec.name}」已更新`);
				sendJson(res, 200, {
					ok: true,
					profile: { id: rec.id, name: rec.name, updatedAt: rec.updatedAt },
					profiles: listProfiles(host.cwd),
					current: host.listModels().current,
				});
				return true;
			}
			case "POST /api/agent-profiles/enable":
			case "POST /api/agent-profiles/refresh": {
				// enable：启用仓库配置；refresh：已启用时从仓库/磁盘重读并重传到 models.json（不必先关再开）
				const isRefresh = route === "POST /api/agent-profiles/refresh";
				const body = JSON.parse(await readBody(req)) as { id?: string };
				const id = (body.id ?? "").trim();
				if (!id) throw new Error("缺少 id");
				if (isRefresh) {
					const active = listProfiles(host.cwd).find((p) => p.active);
					if (active?.id !== id) {
						throw new Error("只能刷新「启用中」的配置；其它配置请先点启用");
					}
				}
				const config = enableProfile(host.cwd, host.agentDir(), id);
				host.refreshModels();
				// 切换到配置里的默认模型
				if (config.defaultProvider && config.defaultModel) {
					try {
						await host.selectModel(config.defaultProvider, config.defaultModel);
					} catch {
						/* 模型可能暂不可用 */
					}
				}
				// 模型条目 thinkingLevel > defaultThinkingLevel → 会话当前生效
				await rebindCurrentModel(host, config);
				host.notify("info", isRefresh ? `已刷新配置「${id}」并重传到运行时` : `已启用配置「${id}」`);
				sendJson(res, 200, {
					ok: true,
					refreshed: isRefresh,
					config,
					profiles: listProfiles(host.cwd),
					current: host.listModels().current,
				});
				return true;
			}
			case "DELETE /api/agent-profiles": {
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				deleteProfile(host.cwd, id);
				host.notify("info", `已删除配置「${id}」`);
				sendJson(res, 200, { ok: true, profiles: listProfiles(host.cwd) });
				return true;
			}

			// ---- 当前启用的 Agent 配置（liyuan.agent.json）----
			case "GET /api/agent-config": {
				const { path, exists, config, seeded } = loadOrSeedAgentConfig(host);
				await rebindCurrentModel(host);
				if (seeded) host.notify("info", "已将当前使用中的渠道收编进梨园 Agent 配置");
				sendJson(res, 200, {
					path,
					exists: exists || seeded,
					config,
					text: `${JSON.stringify(config, null, "\t")}\n`,
					seeded,
					profiles: listProfiles(host.cwd),
				});
				return true;
			}
			case "PUT /api/agent-config": {
				const body = JSON.parse(await readBody(req)) as { text?: string; config?: unknown };
				let parsed: unknown;
				if (typeof body.text === "string") {
					try {
						parsed = JSON.parse(body.text);
					} catch (e) {
						throw new Error(`JSON 无法解析：${e instanceof Error ? e.message : String(e)}`);
					}
				} else if (body.config !== undefined) {
					parsed = body.config;
				} else {
					throw new Error("缺少 text 或 config");
				}
				const config = persistAgentConfig(host, normalizeAgentConfig(parsed));
				await rebindCurrentModel(host);
				host.notify("info", "当前 Agent 配置已保存");
				sendJson(res, 200, {
					ok: true,
					path: loadAgentConfig(host.cwd).path,
					config,
					text: `${JSON.stringify(config, null, "\t")}\n`,
					current: host.listModels().current,
				});
				return true;
			}
			// 兼容旧路径：转发到 agent-config
			case "GET /api/models-json": {
				const { path, exists, config, seeded } = loadOrSeedAgentConfig(host);
				sendJson(res, 200, {
					path,
					exists: exists || seeded,
					content: config,
					text: `${JSON.stringify(config, null, "\t")}\n`,
				});
				return true;
			}
			case "PUT /api/models-json": {
				const body = JSON.parse(await readBody(req)) as { text?: string; content?: unknown };
				const parsed =
					typeof body.text === "string"
						? JSON.parse(body.text)
						: body.content !== undefined
							? body.content
							: null;
				if (!parsed) throw new Error("缺少 text 或 content");
				const config = persistAgentConfig(host, normalizeAgentConfig(parsed));
				sendJson(res, 200, {
					ok: true,
					path: loadAgentConfig(host.cwd).path,
					text: `${JSON.stringify(config, null, "\t")}\n`,
				});
				return true;
			}
			case "POST /api/channels": {
				const body = JSON.parse(await readBody(req)) as {
					name?: string;
					baseUrl?: string;
					api?: string;
					apiKey?: string;
					models?: unknown;
					provider?: Record<string, unknown>;
					setDefault?: boolean;
				};
				const name = (body.name ?? "").trim();
				const baseUrl = (body.baseUrl ?? (body.provider?.baseUrl as string | undefined) ?? "").toString().trim();
				const api = (body.api ?? (body.provider?.api as string | undefined) ?? "").toString().trim();
				if (!name || !baseUrl || !api) throw new Error("渠道名、Base URL、API 类型均必填（模型清单可后补）");
				if (!/^[\w.-]+$/.test(name)) throw new Error("渠道名只允许字母数字与 . - _");
				const { config } = loadOrSeedAgentConfig(host);
				if (config.providers[name]) throw new Error(`渠道已存在：${name}`);
				const models = normalizeModels(body.models ?? body.provider?.models ?? []);
				const fromProvider = body.provider && typeof body.provider === "object" ? { ...body.provider } : {};
				delete fromProvider.name;
				const entry: AgentProvider = {
					...fromProvider,
					baseUrl,
					api,
					apiKey: (body.apiKey ?? (fromProvider.apiKey as string | undefined) ?? "").toString().trim() || "placeholder",
					models,
				};
				config.providers[name] = entry;
				if (body.setDefault || !config.defaultProvider) {
					config.defaultProvider = name;
					if (models[0]) config.defaultModel = models[0].id;
				}
				persistAgentConfig(host, config);
				host.notify("info", `渠道「${name}」已保存（${models.length} 个模型）`);
				sendJson(res, 200, { ok: true, channel: publicProvider(name, entry), config });
				return true;
			}
			case "GET /api/channels": {
				const { path, config, seeded } = loadOrSeedAgentConfig(host);
				if (seeded) host.notify("info", "已将当前使用中的渠道收编进梨园 Agent 配置");
				sendJson(res, 200, {
					path,
					configPath: path,
					channels: Object.entries(config.providers).map(([name, p]) => publicProvider(name, p)),
					defaultProvider: config.defaultProvider ?? null,
					defaultModel: config.defaultModel ?? null,
				});
				return true;
			}
			case "PUT /api/channels": {
				const body = JSON.parse(await readBody(req)) as {
					name?: string;
					baseUrl?: string;
					api?: string;
					apiKey?: string;
					models?: unknown;
					mergeModels?: boolean;
					patch?: Record<string, unknown>;
					setDefault?: boolean;
				};
				const name = (body.name ?? "").trim();
				const { config } = loadOrSeedAgentConfig(host);
				const ch = config.providers[name];
				if (!ch) throw new Error(`渠道不存在：${name}`);
				if (body.patch && typeof body.patch === "object") {
					for (const [k, v] of Object.entries(body.patch)) {
						if (k === "name") continue;
						if (v === null) delete ch[k];
						else ch[k] = v;
					}
				}
				if (typeof body.baseUrl === "string" && body.baseUrl.trim()) ch.baseUrl = body.baseUrl.trim();
				if (typeof body.api === "string" && body.api.trim()) ch.api = body.api.trim();
				if (typeof body.apiKey === "string" && body.apiKey.trim()) ch.apiKey = body.apiKey.trim();
				if (body.models !== undefined) {
					const incoming = normalizeModels(body.models);
					ch.models = body.mergeModels ? mergeModelsById(normalizeModels(ch.models), incoming) : incoming;
				}
				config.providers[name] = ch;
				if (body.setDefault) {
					config.defaultProvider = name;
					const mid = normalizeModels(ch.models)[0]?.id;
					if (mid) config.defaultModel = mid;
				}
				persistAgentConfig(host, config);
				sendJson(res, 200, { ok: true, channel: publicProvider(name, ch), config });
				return true;
			}
			case "DELETE /api/channels": {
				const name = (query.get("name") ?? "").trim();
				const { config } = loadOrSeedAgentConfig(host);
				if (!config.providers[name]) throw new Error(`渠道不存在：${name}`);
				delete config.providers[name];
				if (config.defaultProvider === name) {
					const first = Object.keys(config.providers)[0];
					config.defaultProvider = first;
					config.defaultModel = first ? normalizeModels(config.providers[first].models)[0]?.id : undefined;
				}
				persistAgentConfig(host, config);
				host.notify("info", `渠道「${name}」已删除`);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/channels/test": {
				const body = JSON.parse(await readBody(req)) as { name?: string; baseUrl?: string; apiKey?: string };
				let baseUrl = (body.baseUrl ?? "").trim();
				let apiKey = (body.apiKey ?? "").trim() || undefined;
				const name = (body.name ?? "").trim();
				if (name) {
					const ch = loadOrSeedAgentConfig(host).config.providers[name];
					if (!ch?.baseUrl) throw new Error(`渠道不存在或缺 Base URL：${name}`);
					baseUrl = String(ch.baseUrl);
					if (!apiKey) {
						const k = typeof ch.apiKey === "string" ? ch.apiKey : "";
						if (k && k !== "placeholder") apiKey = k; // $ENV 由 probe 解析
					}
				}
				if (!baseUrl) throw new Error("缺少 name 或 baseUrl");
				const result = await probeModelsEndpoint(baseUrl, apiKey);
				sendJson(res, 200, { ok: result.ok, status: result.status, detail: result.detail });
				return true;
			}
			case "POST /api/channels/fetch-models": {
				const body = JSON.parse(await readBody(req)) as {
					name?: string;
					baseUrl?: string;
					apiKey?: string;
					apply?: boolean;
				};
				let baseUrl = (body.baseUrl ?? "").trim();
				let apiKey = (body.apiKey ?? "").trim() || undefined;
				const name = (body.name ?? "").trim();
				const loaded = name ? loadOrSeedAgentConfig(host) : null;
				const ch = name && loaded ? loaded.config.providers[name] : undefined;
				if (name) {
					if (!ch?.baseUrl) throw new Error(`渠道不存在或缺 Base URL：${name}`);
					baseUrl = String(ch.baseUrl);
					if (!apiKey) {
						const k = typeof ch.apiKey === "string" ? ch.apiKey : "";
						if (k && k !== "placeholder") apiKey = k;
					}
				}
				if (!baseUrl) throw new Error("缺少 name 或 baseUrl");
				const result = await probeModelsEndpoint(baseUrl, apiKey);
				if (!result.ok) throw new Error(`拉取失败：${result.detail}`);
				if (result.ids.length === 0) throw new Error("渠道返回了空模型清单");
				const models = result.ids.map((id) => ({ id })) as AgentModelEntry[];
				if (body.apply && name && loaded && ch) {
					ch.models = mergeModelsById(normalizeModels(ch.models), models);
					loaded.config.providers[name] = ch;
					persistAgentConfig(host, loaded.config);
					host.notify("info", `「${name}」已合并 ${result.ids.length} 个模型`);
					sendJson(res, 200, { ok: true, models: result.ids, channel: publicProvider(name, ch) });
					return true;
				}
				sendJson(res, 200, { ok: true, models: result.ids });
				return true;
			}

			// ---- 配置（用户角色 / 设置） ----
			case "GET /api/config": {
				sendJson(res, 200, { config: loadConfig(host.cwd) });
				return true;
			}
			case "PUT /api/config": {
				if (refuseWhileStreaming()) return true;
				const patch = JSON.parse(await readBody(req)) as Record<string, unknown>;
				const next = applyConfigPatch(loadConfig(host.cwd), patch);
				writeJsonWithBackup(configPath(host.cwd), next);
				await host.softRefreshConfig();
				// agents 段变更触发 host 热重建（删除/重建自定义 agent；忙碌中的记 busy 待下次重启）。
				// patch 无 agents 时同样恒发 agentReload（空表），前端可统一解析。
				const agentReload = await host.reloadAgents();
				sendJson(res, 200, { config: next, agentReload });
				return true;
			}

			// ---- 角色卡 ----
			case "GET /api/card": {
				const config = loadConfig(host.cwd);
				const card = loadCardFile(resolvePath(host.cwd, config.card));
				sendJson(res, 200, {
					path: config.card,
					displayName: config.displayName ?? null,
					greetingIndex: config.greetingIndex ?? 0,
					name: card.name,
					description: card.description,
					personality: card.personality,
					scenario: card.scenario,
					creatorNotes: card.creatorNotes,
					tags: card.tags,
					/** 卡内嵌 character_book 条数（>0 时前端可提示导入配套世界书） */
					embeddedLoreCount: card.book.length,
					greetings: [card.firstMes, ...card.alternateGreetings].map((text, index) => ({
						index,
						label: index === 0 ? "默认开场白" : `备选 ${index}`,
						text,
					})),
				});
				return true;
			}
			case "POST /api/greeting": {
				const body = JSON.parse(await readBody(req)) as { index?: number; apply?: boolean };
				const config = loadConfig(host.cwd);
				const card = loadCardFile(resolvePath(host.cwd, config.card));
				const max = card.alternateGreetings.length; // 合法范围 0..max
				const index = clampInt(body.index, 0, max, 0);
				writeJsonWithBackup(configPath(host.cwd), { ...config, greetingIndex: index });
				// apply=true：走扩展 /greeting，未开聊时可即时替换对话里的开场白
				if (body.apply) {
					if (refuseWhileStreaming()) return true;
					await host.promptCommand(`/greeting ${index}`);
					sendJson(res, 200, { greetingIndex: index, applied: true });
					return true;
				}
				host.notify("info", "开场白已选定，对下一个新会话生效");
				sendJson(res, 200, { greetingIndex: index, applied: false });
				return true;
			}
			case "POST /api/card/switch": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { card?: string };
				const cardPath = (body.card ?? "").trim();
				if (!cardPath) throw new Error("缺少 card 路径");
				const card = loadCardFile(resolvePath(host.cwd, cardPath)); // 先验卡，坏卡不落盘
				const config = loadConfig(host.cwd) as unknown as Record<string, unknown>;
				// 卡专属字段随卡走：显示名/开场白选择清掉。
				// 世界书与角色卡解耦：换卡不碰 lorebooks / disabledLore（条目启停跨卡保留）。
				delete config.displayName;
				delete config.greetingIndex;
				config.card = cardPath;
				writeJsonWithBackup(configPath(host.cwd), config);
				// persona 按卡自动选用（卡锁定→全局默认）：投影进 config 一并生效
				const pstore = loadPersonas(host.cwd);
				const persona = personaForCard(pstore, cardPath);
				if (persona) projectPersonaToConfig(host.cwd, persona);
				const result = await host.switchToCard();
				host.notify(
					"info",
					`${result === "switched" ? `已切换到「${card.name}」的最近会话` : `已为「${card.name}」新建会话`}${persona ? `（身份：${persona.name}）` : ""}`,
				);
				sendJson(res, 200, {
					result,
					name: card.name,
					path: cardPath,
					embeddedLoreCount: card.book.length,
				});
				return true;
			}
			/**
			 * 把当前卡（或指定卡）的内嵌 character_book 另存为独立世界书并挂到配置。
			 * 卡内嵌书仍会随卡加载；另存后可在世界书面板管理、跨卡复用。
			 */
			case "POST /api/card/import-embedded-lore": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { card?: string };
				const config = loadConfig(host.cwd);
				const cardPath = (body.card ?? config.card).trim();
				if (!cardPath) throw new Error("缺少角色卡");
				const card = loadCardFile(resolvePath(host.cwd, cardPath));
				if (card.book.length === 0) throw new Error(`「${card.name}」没有内嵌世界书`);
				const safeBase = card.name.replace(/[\\/:*?"<>|]/g, "-").trim() || "card-lore";
				mkdirSync(join(host.cwd, LOREBOOKS_DIR), { recursive: true });
				let file = `${safeBase}.json`;
				let dest = join(host.cwd, LOREBOOKS_DIR, file);
				let n = 2;
				while (existsSync(dest)) {
					file = `${safeBase}-${n}.json`;
					dest = join(host.cwd, LOREBOOKS_DIR, file);
					n += 1;
				}
				const stJson = exportStLorebook(card.name, card.book);
				writeFileSync(dest, `${JSON.stringify(stJson, null, "\t")}\n`, "utf8");
				const rel = `${LOREBOOKS_DIR}/${file}`;
				// 追加挂载，不顶掉其它已启用的书
				const next = setMountedLorebooks(config, [...mountedLorebookPaths(config), rel]);
				writeJsonWithBackup(configPath(host.cwd), next);
				await host.softRefreshConfig();
				host.notify("info", `已导入配套世界书「${card.name}」（${card.book.length} 条）并加入挂载`);
				sendJson(res, 200, { ok: true, path: rel, entryCount: card.book.length, name: card.name });
				return true;
			}

			// ---- 世界书 ----
			/**
			 * 条目列表：默认按「当前点开的那一本」返回，不合并多本。
			 * - ?path=assets/lorebooks/xxx.json → 只返回该文件条目
			 * - ?source=agent → 只返回当前卡的 agent 补充设定
			 * - 无参 → 空列表（避免误把全部挂载书砸进 UI）
			 * 会话上下文仍由 config.lorebooks 多本合并（扩展层），与本列表解耦。
			 */
			case "GET /api/lorebook": {
				const config = loadConfig(host.cwd);
				const pathQ = (query.get("path") ?? "").replace(/\\/g, "/").trim();
				const sourceQ = (query.get("source") ?? "").trim();
				const mounted = mountedLorebookPaths(config);
				const mapEntries = (entries: LorebookEntry[], source: LoreSource) =>
					entries.map((e) => ({
						fingerprint: loreFingerprint(e.content),
						comment: e.comment,
						keys: e.keys,
						secondaryKeys: e.secondaryKeys,
						constant: e.constant,
						enabled: e.enabled,
						selective: e.selective,
						order: e.order,
						chars: e.content.length,
						source,
						preview: previewText(e.content, 160),
					}));

				if (sourceQ === "agent") {
					const card = loadCardFile(resolvePath(host.cwd, config.card));
					const overlayPath = overlayPathFor(host.cwd, card.name);
					const raw = existsSync(overlayPath) ? loadLorebookFile(overlayPath) : [];
					const entries = applyDisabledLore(raw, config.disabledLore);
					sendJson(res, 200, {
						lorebookPath: null,
						lorebookPaths: mounted,
						viewPath: null,
						viewSource: "agent" as const,
						viewName: "agent 补充设定",
						total: entries.length,
						entries: mapEntries(entries, "agent"),
					});
					return true;
				}

				if (pathQ) {
					const abs = resolvePath(host.cwd, pathQ);
					if (!existsSync(abs)) throw new Error("世界书文件不存在");
					const raw = loadLorebookFile(abs);
					if (raw.length === 0) throw new Error("不是有效的世界书文件");
					const entries = applyDisabledLore(raw, config.disabledLore);
					const name =
						(() => {
							try {
								const j = readJsonFile(abs) as Record<string, unknown>;
								return typeof j.name === "string" && j.name.trim() ? j.name.trim() : null;
							} catch {
								return null;
							}
						})() ?? pathQ.split("/").pop()?.replace(/\.json$/i, "") ?? pathQ;
					sendJson(res, 200, {
						lorebookPath: pathQ,
						lorebookPaths: mounted,
						viewPath: pathQ,
						viewSource: "file" as const,
						viewName: name,
						total: entries.length,
						entries: mapEntries(entries, "file"),
					});
					return true;
				}

				// 无 path：不返回合并全集（UI 必须先点选一本）
				sendJson(res, 200, {
					lorebookPath: null,
					lorebookPaths: mounted,
					viewPath: null,
					viewSource: null,
					viewName: null,
					total: 0,
					entries: [],
				});
				return true;
			}
			case "GET /api/lorebook/entry": {
				const fp = query.get("fp") ?? "";
				const config = loadConfig(host.cwd);
				// 在全部库文件 + 补充设定里找（浏览未挂载书时也能展开正文）
				const card = loadCardFile(resolvePath(host.cwd, config.card));
				const candidates: Array<{ abs: string; source: LoreSource }> = [];
				for (const b of listLorebookFiles(host.cwd, config)) {
					candidates.push({ abs: resolvePath(host.cwd, b.path), source: "file" });
				}
				candidates.push({ abs: overlayPathFor(host.cwd, card.name), source: "agent" });
				let found: LorebookEntry | null = null;
				let source: LoreSource = "file";
				for (const c of candidates) {
					if (!existsSync(c.abs)) continue;
					const hit = applyDisabledLore(loadLorebookFile(c.abs), config.disabledLore).find(
						(e) => loreFingerprint(e.content) === fp,
					);
					if (hit) {
						found = hit;
						source = c.source;
						break;
					}
				}
				if (!found) throw new Error("条目不存在（世界书可能已更换）");
				sendJson(res, 200, {
					content: found.content,
					comment: found.comment,
					keys: found.keys,
					secondaryKeys: found.secondaryKeys,
					constant: found.constant,
					enabled: found.enabled,
					selective: found.selective,
					order: found.order,
					source,
					fingerprint: fp,
				});
				return true;
			}
			/**
			 * 新增条目：写进指定世界书文件（body.path=书路径，或 "agent"=本卡补充设定）。
			 * 面板只必填标题 + 正文；关键词留空则从标题派生——蓝灯条目没有 key 永远不会触发。
			 */
			case "POST /api/lorebook/entry": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					path?: string;
					comment?: string;
					name?: string;
					content?: string;
					info?: string;
					keys?: string[];
					secondaryKeys?: string[];
					constant?: boolean;
					selective?: boolean;
					order?: number;
				};
				const comment = (body.comment ?? body.name ?? "").trim();
				const content = (body.content ?? body.info ?? "").trim();
				if (!comment) throw new Error("标题不能为空");
				if (!content) throw new Error("正文不能为空");
				const config = loadConfig(host.cwd);
				const card = loadCardFile(resolvePath(host.cwd, config.card));
				const target = (body.path ?? "").replace(/\\/g, "/").trim();
				let abs: string;
				let targetLabel: string;
				if (!target || target === "agent") {
					abs = overlayPathFor(host.cwd, card.name);
					targetLabel = "补充设定";
				} else {
					// 与 DELETE 同源：只认书单里的路径
					const known = listLorebookFiles(host.cwd, config);
					const hit = known.find((b) => b.path === target);
					if (!hit) throw new Error("不是已知的世界书文件");
					abs = resolvePath(host.cwd, target);
					targetLabel = hit.name;
				}
				const rawKeys = Array.isArray(body.keys)
					? body.keys.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean)
					: [];
				const entry = appendLorebookFileEntry(abs, {
					comment,
					keys: rawKeys.length > 0 ? rawKeys : keysFromTitle(comment),
					content,
					secondaryKeys: Array.isArray(body.secondaryKeys)
						? body.secondaryKeys.filter((k): k is string => typeof k === "string")
						: [],
					constant: body.constant === true,
					selective: body.selective === true,
					order: typeof body.order === "number" ? body.order : undefined,
				});
				if (!entry) {
					sendJson(res, 200, { ok: true, duplicate: true, fingerprint: loreFingerprint(content) });
					return true;
				}
				await host.softRefreshConfig();
				host.notify("info", `已向「${targetLabel}」新增条目：${entry.comment}`);
				sendJson(res, 200, {
					ok: true,
					duplicate: false,
					fingerprint: loreFingerprint(entry.content),
					comment: entry.comment,
					keys: entry.keys,
				});
				return true;
			}
			/**
			 * 编辑条目：写回源文件（独立世界书 file / agent 补充设定）。
			 * 可改 constant（绿/蓝灯）、order（优先级）、keys、selective、comment、content。
			 */
			case "PUT /api/lorebook/entry": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					fingerprint?: string;
					constant?: boolean;
					order?: number;
					keys?: string[];
					secondaryKeys?: string[];
					selective?: boolean;
					comment?: string;
					content?: string;
				};
				const fp = (body.fingerprint ?? "").trim();
				if (!fp) throw new Error("缺少 fingerprint");
				const config = loadConfig(host.cwd);
				const card = loadCardFile(resolvePath(host.cwd, config.card));
				// 写回：扫描全部世界书文件 + 补充设定（不限当前挂载，浏览哪本改哪本）
				const candidates: string[] = [];
				for (const b of listLorebookFiles(host.cwd, config)) {
					candidates.push(resolvePath(host.cwd, b.path));
				}
				candidates.push(overlayPathFor(host.cwd, card.name));

				const patch: LoreEntryPatch = {};
				if (typeof body.constant === "boolean") patch.constant = body.constant;
				if (typeof body.order === "number" && Number.isFinite(body.order)) {
					patch.order = Math.max(0, Math.min(9999, Math.round(body.order)));
				}
				if (Array.isArray(body.keys)) patch.keys = body.keys.filter((k): k is string => typeof k === "string");
				if (Array.isArray(body.secondaryKeys)) {
					patch.secondaryKeys = body.secondaryKeys.filter((k): k is string => typeof k === "string");
				}
				if (typeof body.selective === "boolean") patch.selective = body.selective;
				if (typeof body.comment === "string") patch.comment = body.comment;
				if (typeof body.content === "string") patch.content = body.content;
				if (Object.keys(patch).length === 0) throw new Error("没有可更新的字段");

				let result: { entry: LorebookEntry; newFingerprint: string } | null = null;
				let wrotePath = "";
				for (const abs of candidates) {
					if (!existsSync(abs)) continue;
					const r = patchLorebookFileEntry(abs, fp, patch);
					if (r) {
						result = r;
						wrotePath = abs;
						break;
					}
				}
				if (!result) throw new Error("未找到可写条目（世界书可能已更换，或条目不在挂载书/补充设定中）");

				// 内容变更时迁移 disabledLore 指纹
				if (result.newFingerprint !== fp && config.disabledLore?.includes(fp)) {
					const disabled = config.disabledLore.map((d) => (d === fp ? result!.newFingerprint : d));
					const next = { ...config, disabledLore: disabled } as Record<string, unknown>;
					writeJsonWithBackup(configPath(host.cwd), next);
				}

				// constant / order / content 影响注入，重装会话
				await host.softRefreshConfig();
				host.notify("info", "世界书条目已保存");
				sendJson(res, 200, {
					ok: true,
					fingerprint: result.newFingerprint,
					constant: result.entry.constant,
					order: result.entry.order,
					path: wrotePath.startsWith(host.cwd) ? wrotePath.slice(host.cwd.length + 1).replace(/\\/g, "/") : wrotePath,
				});
				return true;
			}
			/**
			 * 删除条目：从源文件（独立世界书 / agent 补充设定）里移除该条。
			 * 与 PUT 同一寻址方式：按指纹扫全部书文件 + 补充设定，命中哪本删哪本。
			 * 传 ?path= 时只在该文件内删（避免多本书含同指纹条目时误删别本）。
			 */
			case "DELETE /api/lorebook/entry": {
				if (refuseWhileStreaming()) return true;
				const fp = (query.get("fp") ?? query.get("fingerprint") ?? "").trim();
				if (!fp) throw new Error("缺少条目 fingerprint");
				const pathQ = (query.get("path") ?? "").replace(/\\/g, "/").trim();
				const config = loadConfig(host.cwd);
				const card = loadCardFile(resolvePath(host.cwd, config.card));
				const known = listLorebookFiles(host.cwd, config).map((b) => b.path);
				const candidates: string[] = [];
				if (pathQ === "agent") {
					candidates.push(overlayPathFor(host.cwd, card.name));
				} else if (pathQ) {
					// 只认书单里的路径（与面板展示同源），不接受任意文件路径
					if (!known.includes(pathQ)) throw new Error("不是已知的世界书文件");
					candidates.push(resolvePath(host.cwd, pathQ));
				} else {
					for (const p of known) candidates.push(resolvePath(host.cwd, p));
					candidates.push(overlayPathFor(host.cwd, card.name));
				}
				let removed: LorebookEntry | null = null;
				let fromPath = "";
				for (const abs of candidates) {
					if (!existsSync(abs)) continue;
					const r = deleteLorebookFileEntry(abs, fp);
					if (r) {
						removed = r;
						fromPath = abs;
						break;
					}
				}
				if (!removed) throw new Error("未找到该条目（世界书可能已更换，或条目不在可写文件中）");
				// 清理停用清单里的残留指纹
				if (config.disabledLore?.includes(fp)) {
					const disabled = config.disabledLore.filter((d) => d !== fp);
					const next = { ...config } as Record<string, unknown>;
					if (disabled.length > 0) next.disabledLore = disabled;
					else delete next.disabledLore;
					writeJsonWithBackup(configPath(host.cwd), next);
				}
				await host.softRefreshConfig();
				host.notify("info", `已删除条目「${removed.comment || removed.keys[0] || fp}」`);
				sendJson(res, 200, {
					ok: true,
					comment: removed.comment,
					path: fromPath.startsWith(host.cwd) ? fromPath.slice(host.cwd.length + 1).replace(/\\/g, "/") : fromPath,
				});
				return true;
			}
			case "GET /api/lorebook/search": {
				const q = query.get("q") ?? "";
				const entries = loadMergedLore(host.cwd, loadConfig(host.cwd));
				const hits = searchEntries(entries, q, 5);
				sendJson(res, 200, {
					hits: hits.map((h) => ({
						comment: h.entry.comment,
						keys: h.entry.keys,
						score: h.score,
						preview: previewText(h.entry.content, 400),
					})),
				});
				return true;
			}
			case "POST /api/lorebook/toggle": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					fingerprint?: string;
					fingerprints?: string[];
					enabled?: boolean;
				};
				// 单条与批量（过滤结果全启/全停）共用一个端点
				const fps = [
					...(body.fingerprint ? [body.fingerprint] : []),
					...(Array.isArray(body.fingerprints) ? body.fingerprints.filter((f): f is string => typeof f === "string") : []),
				];
				if (fps.length === 0) throw new Error("缺少 fingerprint(s)");
				const config = loadConfig(host.cwd);
				const disabled = new Set(config.disabledLore ?? []);
				for (const fp of fps) {
					if (body.enabled) disabled.delete(fp);
					else disabled.add(fp);
				}
				const next = { ...config, disabledLore: [...disabled] } as Record<string, unknown>;
				if ((next.disabledLore as string[]).length === 0) delete next.disabledLore;
				writeJsonWithBackup(configPath(host.cwd), next);
				await host.softRefreshConfig(); // constant 条目影响 system prompt，必须重装
				sendJson(res, 200, { ok: true, count: fps.length });
				return true;
			}
			// 导出：?path=按书导出（原样内容）；缺省导出合并结果（agent 补充的正典也有了带走的路）
			case "GET /api/lorebook/export": {
				const p = (query.get("path") ?? "").replace(/\\/g, "/");
				if (p) {
					const abs = resolvePath(host.cwd, p);
					if (!existsSync(abs)) throw new Error("世界书文件不存在");
					const entries = loadLorebookFile(abs);
					if (entries.length === 0) throw new Error("不是有效的世界书文件");
					const name = p.split("/").pop()?.replace(/\.json$/i, "") ?? "lorebook";
					sendJson(res, 200, { name, json: exportStLorebook(name, entries) });
					return true;
				}
				const { entries, cardName } = loadMergedLoreWithSource(host.cwd, loadConfig(host.cwd));
				const name = `${cardName}-梨园世界书`;
				sendJson(res, 200, { name, json: exportStLorebook(name, entries) });
				return true;
			}

			// ---- 预设 ----
			/**
			 * GET：默认读**磁盘已保存**版（切换回来应看到原样）。
			 * ?full=1 附带每块 content；?working=1 则返回当前运行时草稿（若有）。
			 */
			case "GET /api/preset": {
				const config = loadConfig(host.cwd);
				if (!config.preset) {
					sendJson(res, 200, { preset: null, dirty: false });
					return true;
				}
				const wantWorking = query.get("working") === "1";
				const full = query.get("full") === "1";
				const loaded = wantWorking ? loadEffectivePreset(host.cwd) : (() => {
					const d = loadDiskPreset(host.cwd);
					return d
						? { path: d.path, preset: d.preset, fromOverride: false }
						: { path: config.preset, preset: null, fromOverride: false };
				})();
				if (!loaded.preset) {
					sendJson(res, 200, { preset: null, missing: config.preset, dirty: existsSync(presetOverridePath(host.cwd)) });
					return true;
				}
				const preset = loaded.preset;
				sendJson(res, 200, {
					path: loaded.path,
					dirty: existsSync(presetOverridePath(host.cwd)),
					preset: {
						name: preset.name,
						samplers: preset.samplers,
						blocks: preset.blocks.map((b) => ({
							id: b.id,
							name: b.name,
							channel: b.channel,
							role: b.role,
							enabled: b.enabled,
							chars: b.content.length,
							...(full ? { content: b.content } : {}),
						})),
					},
				});
				return true;
			}
			/** 单块全文：优先草稿，否则磁盘 */
			case "GET /api/preset/block": {
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const { preset, path } = loadEffectivePreset(host.cwd);
				if (!preset) throw new Error(path ? `预设文件不存在：${path}` : "当前未配置预设文件");
				const block = preset.blocks.find((b) => b.id === id);
				if (!block) throw new Error(`找不到提示词块：${id}`);
				sendJson(res, 200, {
					id: block.id,
					name: block.name,
					channel: block.channel,
					role: block.role,
					enabled: block.enabled,
					content: block.content,
					chars: block.content.length,
				});
				return true;
			}
			/**
			 * PUT：只写入运行时草稿并热更新（**不落盘**）。
			 * 开关/改字立刻影响下一轮生成；点「保存」才写预设文件。
			 */
			case "PUT /api/preset": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					samplers?: Record<string, number>;
					blocks?: Array<{
						id: string;
						enabled?: boolean;
						name?: string;
						content?: string;
						channel?: "system" | "postHistory";
					}>;
					/** 完整替换草稿（前端持有全文时用） */
					preset?: unknown;
				};
				const config = loadConfig(host.cwd);
				if (!config.preset) throw new Error("当前未配置预设文件");
				let next: RpPreset;
				if (body.preset !== undefined) {
					next = normalizeRpPreset(body.preset);
				} else {
					const base = loadEffectivePreset(host.cwd).preset ?? loadDiskPreset(host.cwd)?.preset;
					if (!base) throw new Error(`预设文件不存在：${config.preset}`);
					next = mergePresetPatches(base, body);
				}
				const ovr = presetOverridePath(host.cwd);
				mkdirSync(join(host.cwd, ".liyuan"), { recursive: true });
				// regexGroups 只存预设文件本体：草稿不进 override，显示管线由 loadEffectivePreset 从本体透出
				const { regexGroups: _ignoreRegexGroups, ...draft } = next;
				writeFileSync(ovr, `${JSON.stringify(draft, null, "\t")}\n`, "utf8");
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true, dirty: true, saved: false });
				return true;
			}
			/** 把当前草稿（或请求体）写入磁盘预设文件，并清除草稿标记 */
			case "POST /api/preset/save": {
				if (refuseWhileStreaming()) return true;
				const rawBody = await readBody(req).catch(() => "");
				const body = JSON.parse(rawBody.trim() || "{}") as {
					preset?: unknown;
					samplers?: Record<string, number>;
					blocks?: Array<{
						id: string;
						enabled?: boolean;
						name?: string;
						content?: string;
						channel?: "system" | "postHistory";
					}>;
				};
				const config = loadConfig(host.cwd);
				if (!config.preset) throw new Error("当前未配置预设文件");
				const filePath = resolvePath(host.cwd, config.preset);
				let next: RpPreset;
				if (body.preset !== undefined) {
					next = normalizeRpPreset(body.preset);
				} else if (body.blocks || body.samplers) {
					const base = loadEffectivePreset(host.cwd).preset ?? loadDiskPreset(host.cwd)?.preset;
					if (!base) throw new Error(`预设文件不存在：${config.preset}`);
					next = mergePresetPatches(base, body);
				} else {
					const eff = loadEffectivePreset(host.cwd).preset;
					if (!eff) throw new Error(`预设文件不存在：${config.preset}`);
					next = eff;
				}
				writeJsonWithBackup(filePath, next);
				clearPresetOverride(host.cwd);
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true, dirty: false, saved: true, path: config.preset });
				return true;
			}
			/** 丢弃未保存草稿，从磁盘重载 */
			case "POST /api/preset/revert": {
				if (refuseWhileStreaming()) return true;
				clearPresetOverride(host.cwd);
				await host.softRefreshConfig();
				sendJson(res, 200, { ok: true, dirty: false });
				return true;
			}
			case "POST /api/preset/convert": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { name?: string; json?: Record<string, unknown> };
				if (!body.json || typeof body.json !== "object") throw new Error("缺少 ST 预设 JSON");
				const { preset, report } = convertStPreset(body.json, (body.name ?? "").trim() || "imported-preset");
				const outPath = join(host.cwd, "liyuan-preset.json");
				writeJsonWithBackup(outPath, preset);
				const config = loadConfig(host.cwd);
				if (config.preset !== "liyuan-preset.json") {
					writeJsonWithBackup(configPath(host.cwd), { ...config, preset: "liyuan-preset.json" });
				}
				await host.softRefreshConfig();
				sendJson(res, 200, { report, blockCount: preset.blocks.length, samplers: preset.samplers });
				return true;
			}

			// ---- 在线更新 ----
			case "POST /api/update/check": {
				await host.updateCheckNow();
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/update/download": {
				const body = JSON.parse((await readBody(req)) || "{}") as { mirror?: string };
				// 不 await 完成：进度经 WS 推送，失败也经 WS 回 available+error
				void host.updateDownload(typeof body.mirror === "string" ? body.mirror : undefined).catch(() => {});
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/update/discard": {
				host.updateDiscard();
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/update/restart": {
				if (refuseWhileStreaming()) return true;
				sendJson(res, 200, { ok: true });
				// 先回包再退：前端收到 ok 后展示「重启中」并等重连
				host.updateRestart();
				return true;
			}

			// ---- 导入 ST 聊天记录 ----
			case "POST /api/import": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { content?: string; tag?: string };
				if (!body.content?.trim()) throw new Error("聊天记录内容为空");
				const dir = join(host.cwd, ".liyuan-cache", "imports");
				mkdirSync(dir, { recursive: true });
				const rel = join(".liyuan-cache", "imports", `import-${Date.now()}.jsonl`);
				writeFileSync(join(host.cwd, rel), body.content, "utf8");
				const tag = (body.tag ?? "").trim();
				// /import 全流程（解析→清洗→摘要→建账→注入）由扩展命令完成，进度经 notify 推送
				await host.promptCommand(`/import ${rel}${tag ? ` ${tag}` : ""}`);
				sendJson(res, 200, { ok: true });
				return true;
			}

			// ---- 生图配置（liyuan.draw.json：provider 注册表 + 参数预设 + 全局风格） ----
			case "GET /api/extdata": {
				const scope = (query.get("scope") ?? "").trim();
				const key = (query.get("key") ?? "").trim();
				if (!(EXTDATA_SCOPES as readonly string[]).includes(scope)) throw new Error("非法 extdata 作用域");
				if (!key) throw new Error("缺少 key");
				sendJson(res, 200, { ok: true, value: getExtData(host.cwd, scope as never, key) });
				return true;
			}
			case "PUT /api/extdata": {
				if (refuseWhileStreaming()) return true;
				const scope = (query.get("scope") ?? "").trim();
				const key = (query.get("key") ?? "").trim();
				if (!(EXTDATA_SCOPES as readonly string[]).includes(scope)) throw new Error("非法 extdata 作用域");
				if (!key) throw new Error("缺少 key");
				const body = JSON.parse(await readBody(req)) as { value?: unknown };
				putExtData(host.cwd, scope as never, key, body.value);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "GET /api/draw/providers": {
				const cfg = loadDrawConfig(host.cwd);
				// 返回结构与前端 DrawProvidersResponse 契约一致：{ ok, config, providers }
				// （styles/defaultStyleId 由独立接口 /api/draw/styles 提供）
				sendJson(res, 200, {
					ok: true,
					config: { version: cfg.version, defaultProvider: cfg.defaultProvider, autoConfirm: cfg.autoConfirm },
					providers: cfg.providers,
				});
				return true;
			}
			case "POST /api/draw/providers": {
				if (refuseWhileStreaming()) return true;
				const raw = JSON.parse(await readBody(req)) as Record<string, unknown>;
				// 新增（未带 id）时先生成 id：normalize 对无 id 的 provider 返回 null（契约语义）
				if (typeof raw.id !== "string" || !raw.id.trim()) raw.id = newProviderId();
				const provider = normalizeDrawProvider(raw);
				if (!provider) throw new Error("provider 数据无效");
				const cfg = loadDrawConfig(host.cwd);
				const idx = cfg.providers.findIndex((p) => p.id === provider.id);
				if (idx >= 0) cfg.providers[idx] = provider;
				else cfg.providers.push(provider);
				if (!cfg.defaultProvider) cfg.defaultProvider = provider.id;
				saveDrawConfig(host.cwd, cfg);
				sendJson(res, 200, { ok: true, providers: cfg.providers });
				return true;
			}
			case "DELETE /api/draw/providers": {
				if (refuseWhileStreaming()) return true;
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const cfg = loadDrawConfig(host.cwd);
				const removed = cfg.providers.some((p) => p.id === id);
				cfg.providers = cfg.providers.filter((p) => p.id !== id);
				// 被删的是默认 provider：回退第一个 enabled
				if (removed && cfg.defaultProvider === id) {
					cfg.defaultProvider = cfg.providers.find((p) => p.enabled)?.id ?? "";
				}
				saveDrawConfig(host.cwd, cfg);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "PUT /api/draw/default": {
				if (refuseWhileStreaming()) return true;
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const cfg = loadDrawConfig(host.cwd);
				if (!cfg.providers.some((p) => p.id === id)) throw new Error("provider 不存在");
				cfg.defaultProvider = id;
				saveDrawConfig(host.cwd, cfg);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/draw/test": {
				const body = JSON.parse(await readBody(req)) as { id?: string; apiKey?: string; baseUrl?: string };
				let apiKey = "";
				let baseUrl: string | undefined;
				const id = (body.id ?? "").trim();
				if (id) {
					const cfg = loadDrawConfig(host.cwd);
					const p = cfg.providers.find((x) => x.id === id);
					if (!p) throw new Error("provider 不存在");
					if (p.type !== "novelai") throw new Error("该后端尚未实现（预留）");
					apiKey = p.apiKey;
					baseUrl = p.baseUrl || undefined;
				} else {
					apiKey = (body.apiKey ?? "").trim();
					baseUrl = body.baseUrl?.trim() || undefined;
				}
				if (!apiKey) throw new Error("缺少 apiKey");
				try {
					await testNovelAiConnection({ apiKey, baseUrl });
				} catch (e) {
					throw new Error(drawErrorZh(e));
				}
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "GET /api/draw/styles": {
				const cfg = loadDrawConfig(host.cwd);
				sendJson(res, 200, { styles: cfg.styles, defaultStyleId: cfg.defaultStyleId });
				return true;
			}
			case "POST /api/draw/styles": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					id?: string;
					name?: string;
					positivePrefix?: string;
					negativePrefix?: string;
				};
				const name = (body.name ?? "").trim();
				if (!name) throw new Error("缺少风格名 name");
				const cfg = loadDrawConfig(host.cwd);
				const styles = [...cfg.styles];
				const id = (body.id ?? "").trim();
				const idx = id ? styles.findIndex((s) => s.id === id) : -1;
				if (idx >= 0) {
					// 同名 id：更新既有风格
					styles[idx] = {
						...styles[idx],
						name,
						positivePrefix: body.positivePrefix ?? "",
						negativePrefix: body.negativePrefix ?? "",
					};
				} else {
					// 新增（无 id 或 id 不存在则生成新 id）
					styles.push({
						id: id || randomBytes(4).toString("hex"),
						name,
						positivePrefix: body.positivePrefix ?? "",
						negativePrefix: body.negativePrefix ?? "",
					});
				}
				const defaultStyleId = cfg.defaultStyleId || styles[0]?.id || "";
				saveDrawConfig(host.cwd, { ...cfg, styles, defaultStyleId });
				sendJson(res, 200, { ok: true, styles, defaultStyleId });
				return true;
			}
			case "DELETE /api/draw/styles": {
				if (refuseWhileStreaming()) return true;
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const cfg = loadDrawConfig(host.cwd);
				const styles = cfg.styles.filter((s) => s.id !== id);
				// 删的是默认风格：回退第一套（无则空串）
				const defaultStyleId = cfg.defaultStyleId === id ? (styles[0]?.id ?? "") : cfg.defaultStyleId;
				saveDrawConfig(host.cwd, { ...cfg, styles, defaultStyleId });
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "PUT /api/draw/default-style": {
				if (refuseWhileStreaming()) return true;
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				const cfg = loadDrawConfig(host.cwd);
				if (!cfg.styles.some((s) => s.id === id)) throw new Error("风格不存在");
				saveDrawConfig(host.cwd, { ...cfg, defaultStyleId: id });
				sendJson(res, 200, { ok: true });
				return true;
			}

			// ---- 动态分辨率（liyuan.draw.json 顶层 aspects：三档构图分辨率，管线/助手共用） ----
			case "GET /api/draw/aspects": {
				const cfg = loadDrawConfig(host.cwd);
				sendJson(res, 200, { ok: true, aspects: cfg.aspects });
				return true;
			}
			case "PUT /api/draw/aspects": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { aspects?: unknown };
				const cfg = loadDrawConfig(host.cwd);
				cfg.aspects = normalizeDrawAspects(body.aspects);
				saveDrawConfig(host.cwd, cfg);
				sendJson(res, 200, { ok: true, aspects: cfg.aspects });
				return true;
			}

			// ---- 服装档案（.liyuan-wardrobe/；当前穿着经 /wardrobe/current 写账本 CharacterState.outfit） ----
			case "GET /api/wardrobe": {
				// 缺省用当前卡（RestHost 未暴露 card 字段，与其余卡路由一致从 config.card 取）
				const card = (query.get("card") ?? "").trim() || (loadConfig(host.cwd).card ?? "").trim();
				if (!card) throw new Error("缺少 card");
				const wb = loadWardrobe(host.cwd, card);
				// 返回结构与前端 WardrobeResponse 契约一致：{ ok, card, wardrobe }
				sendJson(res, 200, { ok: true, card, wardrobe: wb });
				return true;
			}
			case "PUT /api/wardrobe": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as WardrobeFile;
				if (!(body.cardPath ?? "").trim()) throw new Error("缺少 cardPath");
				saveWardrobe(host.cwd, body);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/wardrobe/current": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { character?: string; outfitId?: string };
				const character = (body.character ?? "").trim();
				const outfitId = (body.outfitId ?? "").trim();
				if (!character) throw new Error("缺少 character");
				if (!outfitId) throw new Error("缺少 outfitId");
				const card = (loadConfig(host.cwd).card ?? "").trim();
				if (!card) throw new Error("缺少 card（当前未配置角色卡）");
				// 账本层：applyPatch 已支持 outfit 字段（src/state.ts characters 分支），随世界线回档
				const r = await host.applyStatePatch({ characters: { [character]: { outfit: outfitId } } });
				// 定义层：保证该角色存在于服装档案（upsert 后落盘，幂等）
				const wb = upsertCharacter(loadWardrobe(host.cwd, card), character);
				saveWardrobe(host.cwd, wb);
				sendJson(res, 200, { ok: true, applied: r.applied, warnings: r.warnings });
				return true;
			}
			case "POST /api/wardrobe/ref": {
				if (refuseWhileStreaming()) return true;
				const card = (query.get("card") ?? "").trim();
				const name = (query.get("name") ?? "").trim();
				if (!card) throw new Error("缺少 card");
				if (!name) throw new Error("缺少 name");
				const m = /\.([a-z0-9]+)$/i.exec(name);
				const ext = `.${m ? m[1].toLowerCase() : ""}`;
				if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].includes(ext)) {
					throw new Error("不支持的图片格式");
				}
				const data = await readBodyRaw(req, MAX_UPLOAD);
				if (data.length === 0) throw new Error("文件内容为空");
				const path = saveReferenceImage(host.cwd, card, data, ext);
				sendJson(res, 200, { ok: true, path });
				return true;
			}

			// ---- 图像存储映射（插件 C draw-slot；占位符 [image:slotId] 进正文） ----
			// 常驻注册说明：路由本身无副作用（插件关时映射文件不存在 → 返回空数据），
			// 不依赖插件 init；保存/删除/清理的操作对象是 slot-store 文件与 cache/media 文件，
			// 与插件开关解耦（渲染层见 web/src/components/draw-slot-image.tsx）。
			case "GET /api/draw/slots": {
				// 先 flush 防抖 pending：createSlot/appendVersion 走防抖落盘（300ms），
				// 若直接读盘会拿到旧数据——增强/重生成后前端立即 reload 时计数/新图不刷新
				flushSlotStorePending(host.cwd);
				const slotId = (query.get("slotId") ?? "").trim();
				if (slotId) {
					const info = getSlotInfo(host.cwd, slotId);
					if (!info) throw new Error("slot 不存在");
					sendJson(res, 200, info);
					return true;
				}
				const summaries = listSlotSummaries(host.cwd);
				const total = summaries.length;
				const unsaved = summaries.filter((s) => !s.saved).length;
				// 版本摘要：每 slot 全部版本（discarded 也返回，前端弱显示）；经 getSlotInfo 透出
				// selectedVersionIndex + versions[].tags（LWB 版本切换/编辑 TAG 数据源）
				const slotView = (s: (typeof summaries)[number]): Record<string, unknown> => {
					const info = getSlotInfo(host.cwd, s.slotId);
					if (!info) return { slotId: s.slotId, saved: s.saved, createdAt: s.createdAt, versionCount: s.versionCount, versions: [] };
					return {
						slotId: info.slotId,
						saved: info.saved,
						createdAt: info.createdAt,
						versionCount: info.versionCount,
						...(typeof info.selectedVersionIndex === "number" ? { selectedVersionIndex: info.selectedVersionIndex } : {}),
						...(info.hasFailed ? { hasFailed: true } : {}),
						versions: info.versions,
					};
				};
				sendJson(res, 200, {
					total,
					unsaved,
					slots: summaries.map(slotView),
				});
				return true;
			}
			case "POST /api/draw/slots/save": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { slotId?: string; versionIndex?: number };
				const slotId = (body.slotId ?? "").trim();
				if (!slotId) throw new Error("缺少 slotId");
				const r = saveSlot(host.cwd, slotId, body.versionIndex);
				if (!r.ok) throw new Error(r.error);
				sendJson(res, 200, { ok: true, saved: true });
				return true;
			}
			case "POST /api/draw/slots/select": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { slotId?: string; versionIndex?: number };
				const slotId = (body.slotId ?? "").trim();
				if (!slotId) throw new Error("缺少 slotId");
				if (typeof body.versionIndex !== "number") throw new Error("缺少 versionIndex");
				const r = setSelectedVersionIndex(host.cwd, slotId, body.versionIndex);
				if (!r.ok) throw new Error(r.error);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "PUT /api/draw/slots/tags": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					slotId?: string;
					versionIndex?: number;
					scene?: string;
					characterPrompts?: { name: string; prompt: string; uc?: string }[];
				};
				const slotId = (body.slotId ?? "").trim();
				if (!slotId) throw new Error("缺少 slotId");
				if (typeof body.versionIndex !== "number") throw new Error("缺少 versionIndex");
				// LWB 一致：scene 不能为空（编辑 TAG 保存场景分栏）
				if (body.scene !== undefined && !body.scene.trim()) throw new Error("场景 TAG 不能为空");
				const r = updateVersionTags(host.cwd, slotId, body.versionIndex, {
					...(body.scene !== undefined ? { scene: body.scene } : {}),
					...(body.characterPrompts !== undefined ? { characterPrompts: body.characterPrompts } : {}),
				});
				if (!r.ok) throw new Error(r.error);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "POST /api/draw/slots/save-all": {
				if (refuseWhileStreaming()) return true;
				const r = saveAllSlots(host.cwd);
				sendJson(res, 200, { ok: true, saved: r.saved, skipped: r.skipped });
				return true;
			}
			case "DELETE /api/draw/slots": {
				if (refuseWhileStreaming()) return true;
				const slotId = (query.get("slotId") ?? "").trim();
				if (!slotId) throw new Error("缺少 slotId");
				const removedFiles = deleteSlot(host.cwd, slotId);
				// 剥离正文占位符（删除后不留 [图片已清理] 失效标记；宿主可选实现，未实现则 stripped=0）
				let stripped = 0;
				if (host.stripStoryPlaceholders) {
					const r = await host.stripStoryPlaceholders([slotId]);
					stripped = r.stripped;
				}
				sendJson(res, 200, { ok: true, removedFiles, stripped });
				return true;
			}
			case "DELETE /api/draw/slots/version": {
				// 删除 slot 中的单个版本（当前显示图）：删文件 + 从 versions 移除；
				// 版本删完 → slot 一并删除 + 剥离正文占位符
				if (refuseWhileStreaming()) return true;
				const slotId = (query.get("slotId") ?? "").trim();
				if (!slotId) throw new Error("缺少 slotId");
				const rawIdx = Number.parseInt(query.get("versionIndex") ?? "", 10);
				if (!Number.isInteger(rawIdx)) throw new Error("缺少 versionIndex");
				const r = deleteVersion(host.cwd, slotId, rawIdx);
				if (!r.ok) throw new Error(r.error);
				let stripped = 0;
				if (r.versionsLeft === 0 && host.stripStoryPlaceholders) {
					const sr = await host.stripStoryPlaceholders([slotId]);
					stripped = sr.stripped;
				}
				sendJson(res, 200, { ok: true, versionsLeft: r.versionsLeft, removedFiles: r.removedFiles, stripped });
				return true;
			}
			case "POST /api/draw/slots/cleanup": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse((await readBody(req)) || "{}") as { retentionDays?: number };
				const r = cleanupExpired(host.cwd, body.retentionDays);
				sendJson(res, 200, { ok: true, removedSlots: r.removedSlots, removedFiles: r.removedFiles });
				return true;
			}
			case "POST /api/draw/slots/rebuild": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse((await readBody(req)) || "{}") as {
					messages?: Array<{ id?: string; text?: string }>;
				};
				const result = rebuildSlotIndex(host.cwd, body.messages ?? []);
				sendJson(res, 200, result);
				return true;
			}
			case "POST /api/draw/slots/retry": {
				// 失败占位符重试（LWB storeFailedPlaceholder + saveTagsAndRetry）：
				// 读目标版本 params 的 prompt/scene → generateImage 重新生成 → 追加新版本（失败态被覆盖）
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { slotId?: string; versionIndex?: number };
				const slotId = (body.slotId ?? "").trim();
				if (!slotId) throw new Error("缺少 slotId");
				const info = getSlotInfo(host.cwd, slotId);
				if (!info) throw new Error("slot 不存在");
				// 目标版本 index：显式 versionIndex → selectedVersionIndex → 最后一个非 discarded
				let targetIndex: number;
				if (
					typeof body.versionIndex === "number" &&
					Number.isInteger(body.versionIndex) &&
					body.versionIndex >= 0 &&
					body.versionIndex < info.versionCount &&
					!info.versions[body.versionIndex].discarded
				) {
					targetIndex = body.versionIndex;
				} else if (
					typeof info.selectedVersionIndex === "number" &&
					Number.isInteger(info.selectedVersionIndex) &&
					info.selectedVersionIndex >= 0 &&
					info.selectedVersionIndex < info.versionCount &&
					!info.versions[info.selectedVersionIndex].discarded
				) {
					targetIndex = info.selectedVersionIndex;
				} else {
					const lastActive = info.versions
						.map((v, i) => ({ v, i }))
						.filter((x) => !x.v.discarded)
						.pop();
					if (!lastActive) throw new Error("该 slot 没有可重试的版本");
					targetIndex = lastActive.i;
				}
				// 取目标版本 params 的 prompt 或 scene（有 scene 用 scene，无则 prompt）
				const ver = loadSlotStore(host.cwd).slots[slotId]?.versions[targetIndex];
				if (!ver) throw new Error("slot 不存在");
				const params = ver.params ?? {};
				const rawPrompt =
					(typeof params.scene === "string" && params.scene.trim())
						? params.scene.trim()
						: (typeof params.prompt === "string" && params.prompt.trim())
							? params.prompt.trim()
							: "";
				if (!rawPrompt) throw new Error("该版本无可用 prompt");
				let r: { src: string };
				try {
					r = await generateImage(host.cwd, { prompt: rawPrompt });
				} catch (e) {
					throw new Error(drawErrorZhFull(e));
				}
				// 转相对路径（/cache/ → .liyuan-cache/…，同 /api/draw/generate 内联逻辑）
				const rel = r.src.startsWith("/cache/")
					? `.liyuan-cache/${r.src.slice("/cache/".length)}`
					: r.src.startsWith("/media/")
						? `.liyuan-media/${r.src.slice("/media/".length)}`
						: r.src;
				appendVersion(host.cwd, slotId, { file: rel, params: { scene: rawPrompt, positive: rawPrompt } });
				sendJson(res, 200, { ok: true, src: r.src });
				return true;
			}
			case "POST /api/draw/slots/delete-all": {
				// 删除全部（或指定 slotIds）slot + 从当前分支正文剥离对应占位符
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse((await readBody(req)) || "{}") as { slotIds?: string[] };
				const requested = Array.isArray(body.slotIds)
					? body.slotIds.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
					: [];
				const allIds = listSlotSummaries(host.cwd).map((s) => s.slotId);
				const targets = requested.length > 0 ? requested : allIds;
				let removed = 0;
				let removedFiles = 0;
				if (requested.length > 0) {
					// 部分删除：逐个 deleteSlot（返回删除文件数；不存在返回 0）
					for (const id of targets) {
						const existed = allIds.includes(id);
						removedFiles += deleteSlot(host.cwd, id);
						if (existed) removed++;
					}
				} else {
					// 全部删除：deleteAllSlots 返回删除 slot 数
					removed = deleteAllSlots(host.cwd);
					removedFiles = removed;
				}
				// 剥离正文占位符（只清这次删除的 slotIds；宿主可选实现，未实现则 stripped=0）
				let stripped = 0;
				if (host.stripStoryPlaceholders && targets.length > 0) {
					const r = await host.stripStoryPlaceholders(targets);
					stripped = r.stripped;
				}
				sendJson(res, 200, { ok: true, removed, removedFiles, stripped });
				return true;
			}

			// ---- 插件 A draw-role：D 标签搜索 / 在场检出 / 角色特征解析（常驻只读路由） ----
			// 常驻注册说明：只读查询无副作用（D 标签库是插件自带数据文件，与插件开关解耦）；
			// resolve 的 worldState 侧：RestHost 无 worldState getter（仅 applyStatePatch 可写），
			// 此处传 undefined——currentOutfit 缺省回退 defaultOutfit → 第一套（resolveCharacterTags 语义）。
			case "GET /api/draw/tags/search": {
				const q = (query.get("q") ?? "").trim();
				if (!q) throw new Error("缺少 q");
				const rawLimit = Number.parseInt(query.get("limit") ?? "20", 10);
				const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20;
				const characters = searchCharacters(q, limit);
				const tags = searchTagsWithOnline(host.cwd, q, limit);
				sendJson(res, 200, {
					characters: characters.map((c) => ({ name: c.name, tags: c.tags })),
					tags,
				});
				return true;
			}
			case "GET /api/draw/tags/character": {
				const name = (query.get("name") ?? "").trim();
				if (!name) throw new Error("缺少 name");
				const hit = searchCharacters(name, 1).find((c) => c.name.toLowerCase() === name.toLowerCase());
				sendJson(res, 200, hit ? { name: hit.name, tags: hit.tags } : { name, tags: [] });
				return true;
			}
			case "GET /api/draw/characters/detect": {
				const text = (query.get("text") ?? "").trim();
				const rawNames = (query.get("names") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
				// 别名检出（LWB 对齐）：读服装档案 aliases 构建 known，用 detectPresentCharactersWithAliases；
				// 卡读取失败或名单为空 → 回退原 detectPresentCharacters（与旧行为一致）
				let found: string[] = [];
				try {
					const card = (query.get("card") ?? "").trim() || (loadConfig(host.cwd).card ?? "").trim();
					const wb = loadWardrobe(host.cwd, card);
					const known = wb.characters
						.filter((c) => c.hidden !== true)
						.map((c) => ({ name: c.name, aliases: c.aliases }));
					if (known.length > 0) {
						found = detectPresentCharactersWithAliases(text, known);
					} else {
						found = detectPresentCharacters(text, rawNames);
					}
				} catch {
					found = detectPresentCharacters(text, rawNames);
				}
				sendJson(res, 200, { found });
				return true;
			}
			case "GET /api/draw/characters/resolve": {
				const card = (query.get("card") ?? "").trim() || (loadConfig(host.cwd).card ?? "").trim();
				if (!card) throw new Error("缺少 card（当前未配置角色卡）");
				const names = (query.get("names") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
				if (names.length === 0) throw new Error("缺少 names（逗号分隔）");
				// worldState：RestHost.worldState()（只读 getter，与 applyStatePatch 同源）；
				// 旧 host 未实现时可选链兜底 → null（currentOutfit 回退 defaultOutfit）
				const ws = host.worldState?.() ?? null;
				const r = resolveCharacterTags(host.cwd, card, names, ws ? { characters: ws.characters } : undefined);
				sendJson(res, 200, { characters: r.characters, unknown: r.unknown });
				return true;
			}

			// ---- 未知角色自动学习（插件 A draw-role 二期） ----
			case "GET /api/draw/characters/learn-candidates": {
				const statusRaw = (query.get("status") ?? "").trim();
				const status =
					statusRaw === "pending" || statusRaw === "learned" || statusRaw === "ignored"
						? statusRaw
						: undefined;
				sendJson(res, 200, { ok: true, candidates: listLearnCandidates(host.cwd, status) });
				return true;
			}
			case "POST /api/draw/characters/learn": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { name?: string; card?: string };
				const r = confirmLearnCharacter(host.cwd, body.name ?? "", body.card);
				if (!r.ok) throw new Error(r.error);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "DELETE /api/draw/characters/learn": {
				if (refuseWhileStreaming()) return true;
				const name = (query.get("name") ?? "").trim();
				if (!name) throw new Error("缺少 name");
				dismissLearnCandidate(host.cwd, name);
				sendJson(res, 200, { ok: true });
				return true;
			}

			// ---- 自定义标签组（插件 A draw-role 二期） ----
			case "GET /api/draw/tag-groups": {
				sendJson(res, 200, { ok: true, groups: loadTagGroups(host.cwd).groups });
				return true;
			}
			case "POST /api/draw/tag-groups": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as Partial<TagGroup> & { name?: string };
				if (!body.name || !body.name.trim()) throw new Error("缺少 name");
				const file = saveTagGroup(host.cwd, { name: body.name, ...(body.id ? { id: body.id } : {}), tags: body.tags, enabled: body.enabled });
				sendJson(res, 200, { ok: true, groups: file.groups });
				return true;
			}
			case "PUT /api/draw/tag-groups": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as Partial<TagGroup> & { name?: string };
				if (!body.id || !body.id.trim()) throw new Error("缺少 id");
				const file = saveTagGroup(host.cwd, { id: body.id, name: body.name ?? "", tags: body.tags, enabled: body.enabled });
				sendJson(res, 200, { ok: true, groups: file.groups });
				return true;
			}
			case "DELETE /api/draw/tag-groups": {
				if (refuseWhileStreaming()) return true;
				const id = (query.get("id") ?? "").trim();
				if (!id) throw new Error("缺少 id");
				deleteTagGroup(host.cwd, id);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "PUT /api/draw/tag-groups/toggle": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { id?: string; enabled?: boolean };
				if (!body.id || !body.id.trim()) throw new Error("缺少 id");
				if (typeof body.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
				setTagGroupEnabled(host.cwd, body.id, body.enabled);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "PUT /api/draw/tag-groups/select": {
				// 全局当前选中组（LWB selectedGroupId 语义）：id 空/null → 清除
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { id?: string };
				const id = (body.id ?? "").trim();
				setGlobalSelectedGroup(host.cwd, id || null);
				sendJson(res, 200, { ok: true });
				return true;
			}
			case "GET /api/draw/tag-groups/export": {
				// JSON 下载（attach 头，同 /api/sessions/export 模式）
				const groups = exportTagGroups(host.cwd);
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"content-disposition": 'attachment; filename="liyuan-tag-groups.json"',
					"cache-control": "no-store",
				});
				res.end(`${JSON.stringify(groups, null, "\t")}\n`);
				return true;
			}
			case "POST /api/draw/tag-groups/import": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { groups?: TagGroup[] } | TagGroup[];
				const groups = Array.isArray(body)
					? body
					: Array.isArray((body as { groups?: unknown }).groups)
						? ((body as { groups: TagGroup[] }).groups)
						: [];
				if (groups.length === 0) throw new Error("没有可导入的标签组");
				const imported = importTagGroups(host.cwd, groups);
				sendJson(res, 200, { ok: true, imported, groups: loadTagGroups(host.cwd).groups });
				return true;
			}

			// ---- 在线标签库（插件 A draw-role 二期） ----
			case "POST /api/draw/tags/online-update": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse((await readBody(req)) || "{}") as { sourceUrl?: string };
				const r = await updateOnlineTagDb(host.cwd, { ...(body.sourceUrl ? { sourceUrl: body.sourceUrl } : {}) });
				if (!r.ok) throw new Error(r.error);
				sendJson(res, 200, { ok: true, entries: r.entries, lastUpdatedAt: r.lastUpdatedAt });
				return true;
			}
			case "GET /api/draw/tags/online-status": {
				sendJson(res, 200, { ok: true, status: getOnlineTagDbStatus(host.cwd) });
				return true;
			}

			// ---- 生图旁路管线（插件 B draw-pipeline）手动旋钮 ----
			// 说明：RestHost 无会话树/session 访问，本路由只运行管线并返回 slots + patches（JSON），
			// **不执行补丁**——补丁由宿主 onTurnEnd 钩子经 appendPatch 执行（与管线索引.ts hooks 同路）。
			case "POST /api/draw/pipeline/run": {
				if (refuseWhileStreaming()) return true;
				const cfg = loadConfig(host.cwd);
				if (cfg.plugins?.["draw-pipeline"]?.enabled !== true) {
					throw new Error("生图管线未启用（config.plugins.draw-pipeline.enabled）");
				}
				const body = JSON.parse(await readBody(req)) as { entryId?: string; text?: string; anchor?: string };
				const text = (body.text ?? "").trim();
				if (!text) throw new Error("缺少 text（本路由不访问会话树，需显式传正文）");
				// 用户锚点（选填）：正文短原文片段，第一张图挂接位置用它（LWB anchor 设计）
				const anchor = (body.anchor ?? "").trim() || undefined;
				// 配图按钮/手动触发：宿主执行管线并嵌入当前分支最新剧情消息（Q15 简化通道——
				// 宿主有 session/场记能力可写正文；无宿主能力（测试/嵌入式）时回退纯管线结果）
				if (host.manualPipelineRun) {
					const r = await host.manualPipelineRun(text, anchor);
					if (!r.ok) throw new Error(r.error ?? "管线执行失败");
					sendJson(res, 200, {
						ok: true,
						ran: r.ran === true,
						reason: r.reason,
						slots: r.slots ?? [],
						warnings: r.warnings ?? [],
						embedded: r.embedded === true,
					});
					return true;
				}
				const settingsRaw = cfg.plugins["draw-pipeline"]?.settings ?? {};
				const settings = {
					auto: true, // 手动旋钮：绕过 auto 开关
					characters: Array.isArray(settingsRaw.characters)
						? (settingsRaw.characters as unknown[]).filter((x): x is string => typeof x === "string")
						: [],
					minIntervalMs:
						typeof settingsRaw.minIntervalMs === "number" && settingsRaw.minIntervalMs >= 0
							? settingsRaw.minIntervalMs
							: 5000,
					maxImages: typeof settingsRaw.maxImages === "number" && settingsRaw.maxImages >= 1 ? Math.round(settingsRaw.maxImages) : 2,
					maxCharactersPerImage:
						typeof settingsRaw.maxCharactersPerImage === "number" && settingsRaw.maxCharactersPerImage >= 1
							? Math.round(settingsRaw.maxCharactersPerImage)
							: 3,
					...(settingsRaw.llm && typeof settingsRaw.llm === "object"
						? { llm: settingsRaw.llm as { provider?: string; model?: string } }
						: {}),
				};
				const result = await runPipeline(host.cwd, {
					entryId: body.entryId ?? `manual-${Date.now()}`,
					chatId: "",
					messageText: text,
					settings,
					deps: defaultPipelineDeps(host.cwd),
				});
				sendJson(res, 200, {
					ok: true,
					ran: result.ran,
					reason: result.reason,
					slots: result.slots,
					warnings: result.warnings,
					patches: result.patches, // 宿主执行（本路由不写会话树）
					note: "补丁由宿主回合钩子执行；本手动路由只返回管线结果",
				});
				return true;
			}

			// ---- 底座生图/增强经 REST 暴露（DESIGN 2.4 工具是 agent 通道，UI 操作条走 REST） ----
			case "POST /api/draw/generate": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					prompt?: string;
					negativePrompt?: string;
					aspect?: "portrait" | "landscape" | "square";
					providerId?: string;
					presetId?: string;
					styleId?: string;
					params?: Record<string, unknown>;
					slotId?: string;
				};
				const prompt = (body.prompt ?? "").trim();
				if (!prompt) throw new Error("缺少 prompt");
				let r: { src: string; slotId: string };
				try {
					r = await generateImage(host.cwd, {
						prompt,
						...(body.negativePrompt !== undefined ? { negativePrompt: body.negativePrompt } : {}),
						...(body.aspect ? { aspect: body.aspect } : {}),
						...(body.providerId ? { providerId: body.providerId } : {}),
						...(body.presetId ? { presetId: body.presetId } : {}),
						...(body.styleId !== undefined ? { styleId: body.styleId } : {}),
						...(body.params ? { params: body.params as never } : {}),
					});
				} catch (e) {
					throw new Error(drawErrorZhFull(e));
				}
				// slotId 存在 → 追加版本（file 转相对路径；slot 不存在则忽略 append）
				// 注：srcToRel 内联（曾以 case 间 const 声明触发 TDZ——跳转命中时声明被跳过抛 ReferenceError）
				if (body.slotId) {
					const relSrc = r.src.startsWith("/cache/")
						? `.liyuan-cache/${r.src.slice("/cache/".length)}`
						: r.src.startsWith("/media/")
							? `.liyuan-media/${r.src.slice("/media/".length)}`
							: r.src;
					// params 存结构化 scene/positive（LWB 编辑 TAG 数据源；旧 {prompt} 兼容保留）
					appendVersion(host.cwd, body.slotId, { file: relSrc, params: { prompt, scene: prompt, positive: prompt } });
				}
				sendJson(res, 200, { ok: true, src: r.src, slotId: body.slotId ?? r.slotId });
				return true;
			}
			case "POST /api/draw/enhance": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as {
					source?: string;
					op?: "redraw" | "enhance" | "upscale" | "inpaint";
					strength?: number;
					scaleBy?: number;
					maskBase64?: string;
					slotId?: string;
					/** 源版本下标（数组下标 0=最旧；缺省=selectedVersionIndex ?? 最新非 discarded）——redraw 文生图/tags 继承用 */
					versionIndex?: number;
				};
				const source = (body.source ?? "").trim();
				if (!source) throw new Error("缺少 source");
				const op = body.op;
				if (op !== "redraw" && op !== "enhance" && op !== "upscale" && op !== "inpaint") {
					throw new Error("op 必须为 redraw / enhance / upscale / inpaint");
				}

				// redraw + slotId：「重新生成」= 用源版本 tags 文生图（构图全新）——
				// 修复 img2img redraw 导致构图不变（DESIGN §8 对账 #5 时版本无 prompt 快照，
				// 现 generate 路由已把 prompt 存进 params，切回文生图条件已满足）。
				// 无 tags（历史版本）回退下方 img2img redraw 原行为。
				if (op === "redraw" && body.slotId) {
					const entry = loadSlotStore(host.cwd).slots[body.slotId];
					const ver = entry ? pickSlotVersion(entry, body.versionIndex) : null;
					const tags = ver ? tagsFromParams(ver.params) : {};
					const scene = (tags.scene ?? tags.positive ?? "").trim();
					if (scene) {
						const charTags = (tags.characterPrompts ?? [])
							.map((c) => (c.prompt ?? "").trim())
							.filter(Boolean);
						const prompt = charTags.length > 0 ? `${charTags.join(", ")}, ${scene}` : scene;
						// 尺寸继承：读源图 PNG IHDR（NAI 输出为 png）；非 png/读失败 → 不动尺寸
						let size: { width: number; height: number } | undefined;
						try {
							const buf = readFileSync(resolveSourceAbs(host.cwd, source));
							size = pngSizeOf(buf) ?? undefined;
						} catch {
							size = undefined;
						}
						let rg: { src: string; slotId: string };
						try {
							rg = await generateImage(host.cwd, {
								prompt,
								...(size ? { params: { width: size.width, height: size.height } as never } : {}),
							});
						} catch (e) {
							throw new Error(drawErrorZhFull(e));
						}
						// 新版本带 tags（scene/characterPrompts/positive），编辑 TAG 不空
						appendVersion(host.cwd, body.slotId, {
							file: srcToRel(rg.src),
							params: {
								prompt,
								scene: tags.scene ?? "",
								positive: tags.positive ?? tags.scene ?? "",
								characterPrompts: tags.characterPrompts ?? [],
							},
						});
						sendJson(res, 200, { ok: true, src: rg.src });
						return true;
					}
				}

				let r: { src: string };
				try {
					r = await enhanceImage(host.cwd, {
						source,
						op,
						...(body.strength !== undefined ? { strength: body.strength } : {}),
						...(body.scaleBy !== undefined ? { scaleBy: body.scaleBy } : {}),
						...(body.maskBase64 ? { maskBase64: body.maskBase64 } : {}),
					});
				} catch (e) {
					throw new Error(drawErrorZhFull(e));
				}
				if (body.slotId) {
					// 新版本继承源版本 tags（增强/放大/局部重绘画面场景不变；redraw 无 tags 回退时同样继承）——
					// 修复增强/重生成后新版本编辑 TAG 全空（原 appendVersion 不带 params）
					const entry = loadSlotStore(host.cwd).slots[body.slotId];
					const ver = entry ? pickSlotVersion(entry, body.versionIndex) : null;
					appendVersion(host.cwd, body.slotId, {
						file: srcToRel(r.src),
						...(ver && ver.params ? { params: { ...ver.params } } : {}),
					});
				}
				sendJson(res, 200, { ok: true, src: r.src });
				return true;
			}

			// ---- 插件 D 二期：AI 微调（DESIGN-draw §3.4） ----
			// 新语义（LWB applyAiRefineResult 对齐）：只「改写 + 分解预览」，
			// **不自动重生成、不追加版本**——前端确认后经 /slots/tags 覆写（改 tag 不重绘）。
			case "POST /api/draw/refine": {
				if (refuseWhileStreaming()) return true;
				const body = JSON.parse(await readBody(req)) as { slotId?: string; instruction?: string };
				const slotId = (body.slotId ?? "").trim();
				if (!slotId) throw new Error("缺少 slotId");
				const entry = loadSlotStore(host.cwd).slots[slotId];
				if (!entry) throw new Error("slot 不存在");
				// 当前生效版本（最后一个非 discarded）的 params：scene/prompt/characterPrompts/positive/negative
				const cur = [...entry.versions].reverse().find((v) => !v.discarded);
				if (!cur) throw new Error("该版本无场景可微调");
				const params = cur.params ?? {};
				const decomposed = decomposeTags({
					scene:
						typeof params.scene === "string" && params.scene.trim()
							? params.scene
							: typeof params.prompt === "string" && params.prompt.trim()
								? params.prompt
								: undefined,
					...(Array.isArray(params.characterPrompts) ? { characterPrompts: params.characterPrompts as { name: string; prompt: string }[] } : {}),
					...(typeof params.positive === "string" ? { positive: params.positive } : {}),
					...(typeof params.negative === "string" ? { negative: params.negative } : {}),
				});
				if (!decomposed.scene.trim()) throw new Error("该版本无场景可微调");
				const caller = getPlannerCaller();
				if (!caller) throw new Error("管线规划模型未就绪");
				let refined = "";
				try {
					refined = await caller(buildRefineMessages(decomposed.scene, body.instruction));
				} catch (e) {
					throw new Error(`微调调用失败：${e instanceof Error ? e.message : String(e)}`);
				}
				const refinedScene = extractRefinedScene(refined);
				if (!refinedScene) throw new Error("微调结果解析失败");
				// 不 generateImage、不 appendVersion：返回分解预览 + 改写结果，由前端决定应用
				sendJson(res, 200, { ok: true, decomposed, refined: { scene: refinedScene } });
				return true;
			}

			default:
				sendJson(res, 404, { error: `未知接口：${route}` });
				return true;
		}
	} catch (err) {
		sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		return true;
	}
}

function sanitizeSamplers(input: Record<string, number> | undefined): Record<string, number> | undefined {
	if (!input || typeof input !== "object") return undefined;
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(input)) {
		if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
	}
	return out;
}

/** DrawError → 中文提示（POST /api/draw/test 用）；非 DrawError 原样 message */
function drawErrorZh(e: unknown): string {
	if (e && typeof e === "object") {
		const code = (e as { code?: unknown }).code;
		if (code === "auth") return "API Key 无效";
		if (code === "quota") return "Anlas 不足";
		if (code === "busy") return "当前繁忙，请稍后重试";
		if (code === "network" || code === "timeout") return "网络错误";
	}
	return e instanceof Error ? e.message : String(e);
}

/**
 * DrawError → 中文提示（POST /api/draw/generate 与 /api/draw/enhance 用，契约映射）：
 * auth→API Key 无效 / quota→Anlas 不足 / busy→当前繁忙 / timeout→请求超时 /
 * network→网络错误 / parse→解析失败 / unknown→原消息。
 */
function drawErrorZhFull(e: unknown): string {
	if (e instanceof DrawError) {
		switch (e.code) {
			case "auth": return "API Key 无效";
			case "quota": return "Anlas 不足";
			case "busy": return "当前繁忙";
			case "timeout": return "请求超时";
			case "network": return "网络错误";
			case "parse": return "解析失败";
			case "unknown": return e.message;
			default: return e.message;
		}
	}
	return e instanceof Error ? e.message : String(e);
}

// ---------- 生图版本操作辅助（enhance redraw 文生图 + tags 继承用） ----------

/** 源图 URL → 磁盘绝对路径（/cache/ /media/ 前缀；绝对路径直接用） */
function resolveSourceAbs(cwd: string, source: string): string {
	if (source.startsWith("/cache/")) return join(cwd, ".liyuan-cache", source.slice("/cache/".length));
	if (source.startsWith("/media/")) return join(cwd, ".liyuan-media", source.slice("/media/".length));
	if (isAbsolute(source)) return source;
	return join(cwd, source);
}

/** 生成结果 URL → slot 存储相对路径（/cache/ /media/ 前缀 → .liyuan-* 目录） */
function srcToRel(src: string): string {
	if (src.startsWith("/cache/")) return `.liyuan-cache/${src.slice("/cache/".length)}`;
	if (src.startsWith("/media/")) return `.liyuan-media/${src.slice("/media/".length)}`;
	return src;
}

/** 定位 slot 版本：显式 versionIndex → selectedVersionIndex → 最新非 discarded；无则 null */
function pickSlotVersion(
	entry: { selectedVersionIndex?: number; versions: Array<{ params: Record<string, unknown>; discarded: boolean }> },
	versionIndex?: number,
): { params: Record<string, unknown>; discarded: boolean } | null {
	const versions = entry.versions;
	if (typeof versionIndex === "number" && versionIndex >= 0 && versionIndex < versions.length) {
		return versions[versionIndex] ?? null;
	}
	if (typeof entry.selectedVersionIndex === "number" && entry.selectedVersionIndex >= 0 && entry.selectedVersionIndex < versions.length) {
		return versions[entry.selectedVersionIndex] ?? null;
	}
	for (let i = versions.length - 1; i >= 0; i--) {
		if (!versions[i].discarded) return versions[i];
	}
	return null;
}

/**
 * 索引重建（POST /api/draw/slots/rebuild）：
 * - 对 messages 里每段 text 提取占位符 slotId → 已存在映射的保留；
 * - 不存在映射的：在 .liyuan-cache/ 与 .liyuan-media/ 找不到对应 slot-*.png 文件 → 登记为孤儿
 *   （versions 空数组 + saved=false，渲染层显示失效态）；找到同名 slot-*.png → 补登记；
 * - mediaDisk 的孤儿文件（有文件无 slot）仅统计不自动建 slot（返回 mediaFiles 数）。
 * 写盘用 saveSlotStoreNow。
 */
function rebuildSlotIndex(cwd: string, messages: Array<{ id?: string; text?: string }>): {
	ok: true;
	restored: number;
	orphanPlaceholders: number;
	mediaFiles: number;
} {
	flushSlotStorePending(cwd); // 防抖 pending 先落盘，重建基于最新映射
	const store = loadSlotStore(cwd);
	let restored = 0;
	let orphanPlaceholders = 0;

	for (const m of messages) {
		const text = m.text ?? "";
		for (const slotId of extractSlotIds(text)) {
			if (store.slots[slotId]) continue; // 已存在映射：保留
			// 找同名文件：cache 或 media 下形如 slot-<id>.png
			const cacheAbs = join(cwd, ".liyuan-cache", `${slotId}.png`);
			const mediaAbs = join(cwd, ".liyuan-media", `${slotId}.png`);
			if (existsSync(cacheAbs)) {
				store.slots[slotId] = {
					chatId: m.id ?? "",
					messageId: m.id ?? "",
					createdAt: Date.now(),
					versions: [{ file: `.liyuan-cache/${slotId}.png`, params: {}, savedAt: 0, discarded: false }],
				};
				restored++;
			} else if (existsSync(mediaAbs)) {
				store.slots[slotId] = {
					chatId: m.id ?? "",
					messageId: m.id ?? "",
					createdAt: Date.now(),
					versions: [{ file: `.liyuan-media/${slotId}.png`, params: {}, savedAt: Date.now(), discarded: false }],
				};
				restored++;
			} else {
				// 孤儿占位符：登记空版本（渲染层显示失效态）
				store.slots[slotId] = {
					chatId: m.id ?? "",
					messageId: m.id ?? "",
					createdAt: Date.now(),
					versions: [],
				};
				orphanPlaceholders++;
			}
		}
	}

	const { files } = scanMediaDisk(cwd);
	saveSlotStoreNow(cwd, store);
	return { ok: true, restored, orphanPlaceholders, mediaFiles: files.length };
}
