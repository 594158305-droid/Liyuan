/**
 * JS Runner 宿主侧上下文快照与变量缓存（M3b / G1）。
 *
 * 订阅 jsrunnerBus 的原始帧（hello / message），维护一份「脚本可同步读取」的
 * ContextSnapshot（对应 ST getContext() 白名单面），并持有全局/聊天级脚本变量缓存
 * （extdata scope=global|chat key=script_vars），getVar/setVar/addVar 同步读写 + 防抖持久化。
 *
 * G1（window.SillyTavern 适配面）补的持久化面：
 * - extensionSettings：scope=global key=ext_settings，懒加载缓存 + saveExtensionSettings 防抖落盘
 *   （脚本在 iframe 拿到的 extensionSettings 是 postMessage 深拷贝，改本地副本后须经
 *   saveSettingsDebounced 把副本回传宿主，宿主以此替换缓存并落盘）；
 * - chat_metadata：scope=chat key=chat_metadata，宿主维护权威值，脚本传 partial 经
 *   updateChatMetadata 合并 + 防抖落盘；
 * - characterId / personaDescription / characters{avatar,firstMes}：/api/card 与 /api/personas
 *   尽力而为映射（见 refreshVars）。
 *
 * 帧处理（简化，对齐 App.tsx 的 hello/message 语义）：
 * - hello  → 重建消息数组 + 记录角色/用户名与 sessionId，随后异步重载变量与卡信息
 * - message → 追加；帧里带 entryId 则按 entryId 去重替换
 * - state / 其余帧  → 不进快照
 *
 * 模块加载时注册 bus sink。纯 TS + fetch，不 import React。
 */
import { jsrunnerBus } from "./bus.ts";
import { attachContextProvider } from "./bridge.ts";
import { apiGet, getExtData, putExtData } from "../api.ts";
import type { ServerFrame } from "../wire.ts";
import type { ContextSnapshot } from "./types.ts";

/** 变量持久化用的 extdata key（全局与聊天级共用同名，scope 区分） */
const VARS_KEY = "script_vars";
/** 全局扩展设置持久化 key（G1） */
const EXT_SETTINGS_KEY = "ext_settings";
/** 聊天级元数据持久化 key（G1） */
const CHAT_METADATA_KEY = "chat_metadata";
/** setVar/addVar 后的防抖持久化延迟 */
const PERSIST_DEBOUNCE_MS = 300;

/** 快照消息投影形状（ContextSnapshot.chat 元素） */
interface SnapshotChatEntry {
	mes: string;
	is_user: boolean;
	is_system: boolean;
	name?: string;
	entryId?: string;
}

/** 已对齐的 wire 消息数组（hello 重建 / message 追加或按 entryId 去重替换） */
let messages: import("../wire.ts").WireMsg[] = [];
let charName = "";
let userName = "";
let sessionId = "";

/** 变量缓存：null = 尚未从 extdata 加载（区别于「空对象」） */
let globalVars: Record<string, unknown> | null = null;
let chatVars: Record<string, unknown> | null = null;

/** 角色卡信息（characters 用；非关键，加载失败保持空） */
let cardName = "";
let cardDescription = "";
/** G1：卡文件路径（characterId 稳定标识）/ 头像 URL（仅 .png 卡）/ 默认开场白 */
let cardPath = "";
let cardAvatarUrl = "";
let cardFirstMes = "";
/** G1：当前人设文本（/api/personas 当前身份的 persona 字段） */
let personaDescriptionText = "";

/** G1：权威 chat_metadata（scope=chat）；快照带副本，脚本改后显式落盘 */
let chatMetadata: Record<string, unknown> = {};
/** G1：全局扩展设置缓存；null = 尚未从 extdata 加载（区别于空对象） */
let extensionSettings: Record<string, unknown> | null = null;

/**
 * 单条 wire 消息 → 快照投影（纯函数，可 node 直跑冒烟）。
 * - user 通道：is_user=true
 * - narrative/greeting/import/backstage：角色侧 is_user=false
 * - 其余通道（image/audio/html/choice 等）：也放进 chat，is_system=true 标记
 */
export function toSnapshotEntry(
	msg: import("../wire.ts").WireMsg,
	names: { charName: string; userName: string },
): SnapshotChatEntry {
	const isUser = msg.channel === "user";
	const roleSide =
		msg.channel === "narrative" ||
		msg.channel === "greeting" ||
		msg.channel === "import" ||
		msg.channel === "backstage";
	const isSystem = !isUser && !roleSide;
	const name = msg.name || (isUser ? names.userName : roleSide ? names.charName : undefined);
	const entryId = (msg as { entryId?: unknown }).entryId;
	return {
		mes: msg.text ?? "",
		is_user: isUser,
		is_system: isSystem,
		...(name ? { name } : {}),
		...(typeof entryId === "string" && entryId ? { entryId } : {}),
	};
}

/**
 * 当前角色卡投影（characters 数组元素，兼容 ST character 字段子集）。
 * extensions：Liyuan /api/card 无 ST extensions 对等物，不填充（脚本读到 undefined 不炸）。
 */
function buildCharacterEntry(): ContextSnapshot["characters"][number] {
	const entry: ContextSnapshot["characters"][number] = { name: cardName || charName };
	if (cardDescription) entry.description = cardDescription;
	if (cardAvatarUrl) entry.avatar = cardAvatarUrl;
	if (cardFirstMes) entry.firstMes = cardFirstMes;
	return entry;
}

/** 当前快照（generate helper 等同步读） */
export function buildSnapshot(): ContextSnapshot {
	return {
		chat: messages.map((m) => toSnapshotEntry(m, { charName, userName })),
		chat_metadata: chatMetadata,
		name1: charName,
		name2: userName,
		vars: { ...(globalVars ?? {}) },
		chatVars: { ...(chatVars ?? {}) },
		...(sessionId ? { currentChatId: sessionId } : {}),
		...(cardPath ? { characterId: cardPath } : {}),
		...(personaDescriptionText ? { personaDescription: personaDescriptionText } : {}),
		// 可变引用：iframe 内 postMessage 深拷贝后脚本改副本，saveSettingsDebounced 回传替换
		extensionSettings: getExtensionSettings(),
		characters: [buildCharacterEntry()],
	};
}

// ---------- 变量读写（同步面 + 防抖持久化） ----------

function varsFor(scope: "global" | "chat"): Record<string, unknown> {
	if (scope === "chat") {
		if (chatVars === null) chatVars = {};
		return chatVars;
	}
	if (globalVars === null) globalVars = {};
	return globalVars;
}

/** 同步读变量（scope：global 或 chat，缺省 global） */
export function getVar(key: string, scope: "global" | "chat" = "global"): unknown {
	return varsFor(scope)[key];
}

/** 更新缓存 + 防抖持久化到 extdata */
export function setVar(key: string, value: unknown, scope: "global" | "chat" = "global"): void {
	varsFor(scope)[key] = value;
	schedulePersist(scope);
}

/** 数值累加（非数值按 0 起步），返回新值 */
export function addVar(key: string, delta: number, scope: "global" | "chat" = "global"): unknown {
	const v = varsFor(scope);
	const cur = typeof v[key] === "number" ? (v[key] as number) : 0;
	const next = cur + (typeof delta === "number" ? delta : 0);
	v[key] = next;
	schedulePersist(scope);
	return next;
}

/** 删除变量（更新缓存 + 防抖持久化；键不存在时 no-op，不触发多余持久化） */
export function deleteVar(key: string, scope: "global" | "chat" = "global"): void {
	const v = varsFor(scope);
	if (!(key in v)) return;
	delete v[key];
	schedulePersist(scope);
}

/** 从 extdata 重载变量（会话/连接切换后调用） */
export async function refreshVars(): Promise<void> {
	const [g, c, ext, meta] = await Promise.all([
		getExtData("global", VARS_KEY).catch(() => undefined),
		getExtData("chat", VARS_KEY).catch(() => undefined),
		getExtData("global", EXT_SETTINGS_KEY).catch(() => undefined),
		getExtData("chat", CHAT_METADATA_KEY).catch(() => undefined),
	]);
	if (g && typeof g === "object" && !Array.isArray(g)) globalVars = g as Record<string, unknown>;
	if (c && typeof c === "object" && !Array.isArray(c)) chatVars = c as Record<string, unknown>;
	if (ext && typeof ext === "object" && !Array.isArray(ext)) extensionSettings = ext as Record<string, unknown>;
	if (meta && typeof meta === "object" && !Array.isArray(meta)) chatMetadata = meta as Record<string, unknown>;
	// 角色卡信息（characters / characterId）：/api/card 无 id/avatar/extensions 对等字段，
	// 尽力而为——path 作 characterId、.png 卡推头像 URL、greetings[0] 作 firstMes；失败不影响变量面
	try {
		const card = await apiGet<{
			name?: unknown;
			description?: unknown;
			path?: unknown;
			greetings?: Array<{ text?: unknown }>;
		}>("/api/card", { bypassCache: true });
		if (card && typeof card.name === "string" && card.name.trim()) cardName = card.name;
		if (card && typeof card.description === "string" && card.description.trim()) {
			cardDescription = card.description;
		}
		if (card && typeof card.path === "string" && card.path.trim()) {
			cardPath = card.path;
			cardAvatarUrl = /\.png$/i.test(card.path)
				? `/api/cards/image?path=${encodeURIComponent(card.path)}`
				: "";
		}
		cardFirstMes =
			Array.isArray(card?.greetings) && typeof card.greetings[0]?.text === "string"
				? card.greetings[0].text
				: "";
	} catch {
		// 无卡/未配置：忽略
	}
	// 人设描述（personaDescription）：/api/personas 当前身份的 persona 文本；非关键
	try {
		const pr = await apiGet<{
			personas?: Array<{ id?: unknown; persona?: unknown }>;
			activeId?: unknown;
		}>("/api/personas", { bypassCache: true });
		const active = Array.isArray(pr?.personas)
			? pr.personas.find((p) => p.id === pr.activeId)
			: undefined;
		personaDescriptionText = active && typeof active.persona === "string" ? active.persona : "";
	} catch {
		personaDescriptionText = "";
	}
}

const persistTimers = new Map<"global" | "chat", ReturnType<typeof setTimeout>>();

function schedulePersist(scope: "global" | "chat"): void {
	const prev = persistTimers.get(scope);
	if (prev) clearTimeout(prev);
	persistTimers.set(
		scope,
		setTimeout(() => {
			persistTimers.delete(scope);
			void persistVars(scope);
		}, PERSIST_DEBOUNCE_MS),
	);
}

async function persistVars(scope: "global" | "chat"): Promise<void> {
	const vars = scope === "chat" ? chatVars : globalVars;
	if (vars === null) return;
	try {
		await putExtData(scope, VARS_KEY, vars);
	} catch (e) {
		console.warn("[jsrunner context] 变量持久化失败", scope, e);
	}
}

// ---------- 扩展设置 / 聊天元数据（G1：SillyTavern 适配面的可写持久化面） ----------

/** 全局扩展设置（可变引用；懒加载缓存，未加载时给空对象） */
export function getExtensionSettings(): Record<string, unknown> {
	if (extensionSettings === null) extensionSettings = {};
	return extensionSettings;
}

async function persistExtSettings(): Promise<void> {
	try {
		await putExtData("global", EXT_SETTINGS_KEY, extensionSettings ?? {});
	} catch (e) {
		console.warn("[jsrunner context] extensionSettings 持久化失败", e);
	}
}

let extSettingsTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 防抖落盘 global/ext_settings。payload 为 iframe 内可变副本的当前值（postMessage 深拷贝，
 * 脚本在本地副本上的改动须回传才持久化）；缺省时落当前缓存。返回的 Promise 在落盘完成后 resolve。
 */
export function saveExtensionSettings(payload?: Record<string, unknown>): Promise<void> {
	if (payload && typeof payload === "object") extensionSettings = payload;
	if (extSettingsTimer) clearTimeout(extSettingsTimer);
	return new Promise((resolve) => {
		extSettingsTimer = setTimeout(() => {
			extSettingsTimer = null;
			void persistExtSettings().finally(resolve);
		}, PERSIST_DEBOUNCE_MS);
	});
}

let chatMetadataTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 更新快照 chat_metadata（宿主权威）：reset=true 整体替换，否则浅合并；随后防抖落盘
 * scope=chat/chat_metadata。脚本在快照副本上改字段后，把要落盘的 partial 传进来。
 */
export function updateChatMetadata(partial: Record<string, unknown>, reset = false): void {
	chatMetadata = reset ? { ...partial } : { ...chatMetadata, ...partial };
	if (chatMetadataTimer) clearTimeout(chatMetadataTimer);
	chatMetadataTimer = setTimeout(() => {
		chatMetadataTimer = null;
		void (async () => {
			try {
				await putExtData("chat", CHAT_METADATA_KEY, chatMetadata);
			} catch (e) {
				console.warn("[jsrunner context] chat_metadata 持久化失败", e);
			}
		})();
	}, PERSIST_DEBOUNCE_MS);
}

// ---------- bus sink：hello 重建 / message 追加 ----------

jsrunnerBus.registerSink({
	onWireFrame(frame: ServerFrame) {
		switch (frame.type) {
			case "hello": {
				messages = frame.messages;
				charName = frame.charName ?? "";
				userName = frame.userName ?? "";
				sessionId = frame.sessionId;
				// 会话/连接对齐后：重载脚本变量与角色卡信息（异步，不阻塞帧处理）
				void refreshVars();
				break;
			}
			case "message": {
				const m = frame.message;
				const entryId = (m as { entryId?: unknown }).entryId;
				if (typeof entryId === "string" && entryId) {
					const i = messages.findIndex((x) => (x as { entryId?: unknown }).entryId === entryId);
					messages = i >= 0 ? [...messages.slice(0, i), m, ...messages.slice(i + 1)] : [...messages, m];
				} else {
					messages = [...messages, m];
				}
				break;
			}
			default:
				// state / ext_event / 其它帧不进快照（快照只吃 hello/message）
				break;
		}
	},
});

// ---------- 接入桥：把 buildSnapshot 注册为 context 提供者（runtime 在 hello/message/ready 后推送） ----------

attachContextProvider(buildSnapshot);
