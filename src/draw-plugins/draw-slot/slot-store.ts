/**
 * 插件 C「图像存储映射」核心领域层（DESIGN-draw §3.3）：slot 映射表文件持久化。
 *
 * 零依赖纯 TS（不 import server / pi）：占位符文本标记、映射读写（原子写 + 防抖）、
 * 保存/删除/清理/重建/磁盘扫描。文件 `.liyuan-state/draw-slots.json`（复用 dir(cwd,"state")）。
 *
 * 约定：
 * - 未保存 cache 文件：`.liyuan-cache/draw-{ts}-{rand}.png`（服务端生成）；已保存 → `.liyuan-media/<md5前16位><ext>`
 * - 「当前生效版本」= versions 里最后一个非 discarded；追加新版本时旧版不自动废弃（由上层 reroll/编辑时显式标记）
 * - 全部纯增改函数返回新 store（不可变风格）；createSlot/appendVersion 内部自动防抖落盘，
 *   其余（saveSlot/saveAllSlots/deleteSlot/cleanupExpired）由调用方按语义决定立即落盘
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { dir } from "../../paths.ts";

/** 占位符：文本内嵌标记（slotId 只允许字母数字连字符） */
export const PLACEHOLDER_REGEX = /\[image:([A-Za-z0-9-]+)\]/g;

/** 生成占位符文本：`[image:${slotId}]` */
export function createPlaceholder(slotId: string): string {
	return `[image:${slotId}]`;
}

/** 从文本提取 slotId（去重、保序） */
export function extractSlotIds(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	PLACEHOLDER_REGEX.lastIndex = 0;
	for (const m of text.matchAll(PLACEHOLDER_REGEX)) {
		const id = m[1];
		if (!seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	PLACEHOLDER_REGEX.lastIndex = 0;
	return out;
}

/** 版本条目：同一 slot 的历次生成/编辑结果 */
export interface SlotVersion {
	/** 相对 cwd：".liyuan-cache/..."（未保存）或 ".liyuan-media/..."（已保存）；生成失败占位无文件 → 空串 */
	file: string;
	/** 生成参数快照 */
	params: Record<string, unknown>;
	/** 0 = 未保存 */
	savedAt: number;
	/** reroll/替换后废弃（保留期后可清） */
	discarded: boolean;
	/** 生成失败记录（失败占位符无文件） */
	failed?: { code: string; reason: string };
}

export interface SlotEntry {
	chatId: string;
	messageId: string;
	createdAt: number;
	/** 生成/编辑历史（按追加序；当前生效 = 最后一个非 discarded） */
	versions: SlotVersion[];
	/** 选中版本下标（LWB 正文版本切换持久化；缺省 undefined = 最新非 discarded） */
	selectedVersionIndex?: number;
}

export interface SlotStoreFile {
	version: 1;
	slots: Record<string, SlotEntry>;
}

/** 单个 slot 的展示信息（前端占位符渲染用） */
export interface SlotInfo {
	slotId: string;
	saved: boolean;
	/** 当前版本文件 URL（/cache/ 或 /media/ 前缀；失败占位无文件 → ""） */
	src: string;
	versionCount: number;
	createdAt: number;
	/** 选中版本下标（缺省 undefined = 最新非 discarded） */
	selectedVersionIndex?: number;
	/** 当前生效版本的失败记录（有 failed 时） */
	failed?: { code: string; reason: string };
	/** 任一版本有 failed */
	hasFailed?: boolean;
	/** 各版本展示信息（含 tags：从 params 读，兼容旧 prompt 文本回退作 scene；failed 版本透出） */
	versions: { file: string; src: string; saved: boolean; discarded: boolean; tags: VersionTags; failed?: { code: string; reason: string } }[];
}

/** 版本 tags 快照（LWB 编辑 TAG：scene/characterPrompts/positive） */
export interface VersionTags {
	scene?: string;
	characterPrompts?: { name: string; prompt: string; uc?: string }[];
	positive?: string;
}

const SLOT_STORE_REL = "draw-slots.json";

/** 映射文件路径：.liyuan-state/draw-slots.json */
export function slotStorePath(cwd: string): string {
	return join(dir(cwd, "state"), SLOT_STORE_REL);
}

/** 读（缺失/损坏 → 空 store） */
export function loadSlotStore(cwd: string): SlotStoreFile {
	const p = slotStorePath(cwd);
	if (!existsSync(p)) return { version: 1, slots: {} };
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SlotStoreFile>;
		const slots: Record<string, SlotEntry> = {};
		if (raw && typeof raw === "object" && raw.slots && typeof raw.slots === "object") {
			for (const [id, e] of Object.entries(raw.slots as Record<string, Partial<SlotEntry>>)) {
				if (!e || typeof e !== "object") continue;
				const versions = Array.isArray(e.versions)
					? e.versions
							.filter(
								(v): v is SlotVersion =>
									!!v &&
									typeof v === "object" &&
									typeof v.file === "string" &&
									typeof v.savedAt === "number" &&
									typeof v.discarded === "boolean",
							)
							.map((v) => ({ ...v, params: v.params && typeof v.params === "object" ? v.params : {} }))
					: [];
				slots[id] = {
					chatId: typeof e.chatId === "string" ? e.chatId : "",
					messageId: typeof e.messageId === "string" ? e.messageId : "",
					createdAt: typeof e.createdAt === "number" ? e.createdAt : 0,
					versions,
					// selectedVersionIndex：保留；越界/非法时清掉（缺省回退最新有效）
					...(typeof e.selectedVersionIndex === "number" &&
					Number.isInteger(e.selectedVersionIndex) &&
					e.selectedVersionIndex >= 0 &&
					e.selectedVersionIndex < versions.length
						? { selectedVersionIndex: e.selectedVersionIndex }
						: {}),
				};
			}
		}
		return { version: 1, slots };
	} catch {
		return { version: 1, slots: {} };
	}
}

// ---------- 原子写 + 防抖 ----------

/** 写盘：原子（tmp 再 rename） */
function writeStoreNow(cwd: string, store: SlotStoreFile): void {
	const p = slotStorePath(cwd);
	mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
	renameSync(tmp, p);
}

/** 防抖状态（模块级）：300ms 合并连续写 */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let debounceCwd = "";
let debounceStore: SlotStoreFile | null = null;

/**
 * 有效 store：优先取防抖 pending（快速连续 createSlot/appendVersion 时，
 * 前一次结果还没落盘，若只读磁盘会丢掉前几次）；否则读磁盘。
 */
function effectiveStore(cwd: string): SlotStoreFile {
	if (debounceStore && debounceCwd === cwd) return structuredClone(debounceStore);
	return loadSlotStore(cwd);
}

/** 防抖落盘：300ms 内多次调用只写一次（保存/追加高频路径用） */
export function saveSlotStoreDebounced(cwd: string, store: SlotStoreFile): void {
	debounceCwd = cwd;
	debounceStore = store;
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		if (debounceStore) {
			try {
				writeStoreNow(debounceCwd, debounceStore);
			} catch {
				// 写盘失败不阻断调用链（下次写会重试）
			}
		}
		debounceStore = null;
	}, 300);
}

/** 立即写盘（重建/清理/删除等收尾用；同时清防抖 pending） */
export function saveSlotStoreNow(cwd: string, store: SlotStoreFile): void {
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = null;
	}
	debounceStore = null;
	writeStoreNow(cwd, store);
}

/** 强制 flush 防抖 pending（REST 层重建等读盘前用）：有 pending 则立即落盘 */
export function flushSlotStorePending(cwd: string): void {
	if (debounceStore && debounceCwd === cwd) saveSlotStoreNow(cwd, debounceStore);
}

// ---------- 纯增改（不可变风格，返回新 store） ----------

/** 登记新 slot（生成后调用）：首版本 file 指向 cache，saved=false；自动防抖落盘 */
export function createSlot(
	cwd: string,
	opts: {
		slotId: string;
		chatId: string;
		messageId: string;
		file: string;
		params?: Record<string, unknown>;
		failed?: { code?: string; reason: string };
	},
): SlotStoreFile {
	const store = effectiveStore(cwd);
	if (store.slots[opts.slotId]) return store; // 已存在：不覆盖
	store.slots[opts.slotId] = {
		chatId: opts.chatId,
		messageId: opts.messageId,
		createdAt: Date.now(),
		versions: [
			{
				file: opts.file,
				params: opts.params ?? {},
				savedAt: 0,
				discarded: false,
				...(opts.failed ? { failed: { code: opts.failed.code || "unknown", reason: opts.failed.reason } } : {}),
			},
		],
	};
	saveSlotStoreDebounced(cwd, store);
	return store;
}

/** 追加版本（增强/编辑 TAG 再生/重生成产生新版本）；slot 不存在 → 原样返回 */
export function appendVersion(
	cwd: string,
	slotId: string,
	opts: { file: string; params?: Record<string, unknown>; failed?: { code?: string; reason: string } },
): SlotStoreFile {
	const store = effectiveStore(cwd);
	const entry = store.slots[slotId];
	if (!entry) return store;
	store.slots[slotId] = {
		...entry,
		versions: [
			...entry.versions,
			{
				file: opts.file,
				params: opts.params ?? {},
				savedAt: 0,
				discarded: false,
				...(opts.failed ? { failed: { code: opts.failed.code || "unknown", reason: opts.failed.reason } } : {}),
			},
		],
	};
	saveSlotStoreDebounced(cwd, store);
	return store;
}

// ---------- 保存 ----------

/**
 * 取当前生效版本：优先 selectedVersionIndex 指向的版本（若合法且非 discarded）；
 * 否则最后一个非 discarded；无则 null。
 */
function currentVersion(entry: SlotEntry): SlotVersion | null {
	if (
		typeof entry.selectedVersionIndex === "number" &&
		Number.isInteger(entry.selectedVersionIndex) &&
		entry.selectedVersionIndex >= 0 &&
		entry.selectedVersionIndex < entry.versions.length
	) {
		const sel = entry.versions[entry.selectedVersionIndex];
		if (sel && !sel.discarded) return sel;
	}
	for (let i = entry.versions.length - 1; i >= 0; i--) {
		if (!entry.versions[i].discarded) return entry.versions[i];
	}
	return null;
}

/** cache 相对路径 → 绝对路径（/cache/ 前缀或 .liyuan-cache/ 相对路径均可） */
function resolveCacheAbs(cwd: string, file: string): string {
	if (file.startsWith("/cache/")) return join(cwd, file.replace(/^\//, ""));
	return join(cwd, file);
}

/**
 * 保存：把指定版本（versionIndex 缺省 = selectedVersionIndex 指向版本，再缺省 = 最新非 discarded）
 * 的 cache 文件移入 .liyuan-media/（内容寻址 md5 前 16 位 + ext，与 deliverMedia 同命名）；
 * 目标已存在同内容 → 直接删 cache 文件；并置 savedAt。只保存指定版本的文件。
 */
export function saveSlot(cwd: string, slotId: string, versionIndex?: number): { ok: true } | { ok: false; error: string } {
	const store = effectiveStore(cwd);
	const entry = store.slots[slotId];
	if (!entry) return { ok: false, error: `slot 不存在：${slotId}` };
	let ver: SlotVersion | null;
	if (typeof versionIndex === "number") {
		if (!Number.isInteger(versionIndex) || versionIndex < 0 || versionIndex >= entry.versions.length) {
			return { ok: false, error: `版本下标越界：${versionIndex}` };
		}
		ver = entry.versions[versionIndex] ?? null;
	} else {
		ver = currentVersion(entry);
	}
	if (!ver) return { ok: false, error: `slot「${slotId}」没有有效版本` };
	if (ver.savedAt > 0) return { ok: true }; // 已保存：幂等

	const cacheAbs = resolveCacheAbs(cwd, ver.file);
	if (!existsSync(cacheAbs)) return { ok: false, error: `文件不存在：${ver.file}` };
	const ext = extname(cacheAbs).toLowerCase() || ".png";
	const mediaDir = dir(cwd, "media");
	mkdirSync(mediaDir, { recursive: true });
	const name = `${createHash("md5").update(readFileSync(cacheAbs)).digest("hex").slice(0, 16)}${ext}`;
	const dest = join(mediaDir, name);
	if (!existsSync(dest)) copyFileSync(cacheAbs, dest);
	// 目标已存在同内容（或刚复制成功）：删 cache 源文件
	try {
		unlinkSync(cacheAbs);
	} catch {
		// 删不掉不影响（映射已指向 media）
	}
	const versions = entry.versions.map((v) => (v === ver ? { ...v, file: `.liyuan-media/${name}`, savedAt: Date.now() } : v));
	store.slots[slotId] = { ...entry, versions };
	saveSlotStoreNow(cwd, store);
	return { ok: true };
}

/**
 * 设置选中版本下标（LWB 正文版本切换持久化）。越界返回错误。
 */
export function setSelectedVersionIndex(cwd: string, slotId: string, index: number): { ok: true } | { ok: false; error: string } {
	const store = effectiveStore(cwd);
	const entry = store.slots[slotId];
	if (!entry) return { ok: false, error: `slot 不存在：${slotId}` };
	if (!Number.isInteger(index) || index < 0 || index >= entry.versions.length) {
		return { ok: false, error: `版本下标越界：${index}` };
	}
	store.slots[slotId] = { ...entry, selectedVersionIndex: index };
	saveSlotStoreNow(cwd, store);
	return { ok: true };
}

/**
 * 覆盖保存某版本的 tags（LWB 编辑 TAG 语义：改 tag 不重绘；同版本覆盖写）。
 * 更新 versions[index].params 里的 {scene, characterPrompts, positive}，保留其他 params 字段。
 */
export function updateVersionTags(
	cwd: string,
	slotId: string,
	versionIndex: number,
	tags: { scene?: string; characterPrompts?: { name: string; prompt: string; uc?: string }[]; positive?: string },
): { ok: true } | { ok: false; error: string } {
	const store = effectiveStore(cwd);
	const entry = store.slots[slotId];
	if (!entry) return { ok: false, error: `slot 不存在：${slotId}` };
	if (!Number.isInteger(versionIndex) || versionIndex < 0 || versionIndex >= entry.versions.length) {
		return { ok: false, error: `版本下标越界：${versionIndex}` };
	}
	const versions = entry.versions.map((v, i) => {
		if (i !== versionIndex) return v;
		const params = { ...v.params };
		if (tags.scene !== undefined) params.scene = tags.scene;
		if (tags.characterPrompts !== undefined) params.characterPrompts = tags.characterPrompts;
		if (tags.positive !== undefined) params.positive = tags.positive;
		return { ...v, params };
	});
	store.slots[slotId] = { ...entry, versions };
	saveSlotStoreNow(cwd, store);
	return { ok: true };
}

/** 全部未保存的 slot 转存；返回 { saved, skipped }（已保存/无文件/无版本的跳过） */
export function saveAllSlots(cwd: string): { saved: number; skipped: number } {
	// 先 flush pending（防抖态）到磁盘，再逐 slot 转存（saveSlot 内部立即写盘）
	if (debounceStore && debounceCwd === cwd) saveSlotStoreNow(cwd, debounceStore);
	const store = loadSlotStore(cwd);
	let saved = 0;
	let skipped = 0;
	for (const slotId of Object.keys(store.slots)) {
		const info = getSlotInfo(cwd, slotId);
		if (info?.saved) {
			skipped++; // 已保存：幂等跳过
			continue;
		}
		const r = saveSlot(cwd, slotId);
		if (r.ok) saved++;
		else skipped++;
	}
	return { saved, skipped };
}

// ---------- 删除 / 清理 ----------

/** 删除 slot：删其所有版本文件（cache 与 media 引用都删）并从映射移除；返回删除的文件数 */
export function deleteSlot(cwd: string, slotId: string): number {
	const store = effectiveStore(cwd);
	const entry = store.slots[slotId];
	if (!entry) return 0;
	let removed = 0;
	for (const v of entry.versions) {
		const abs = v.file.startsWith("/") ? join(cwd, v.file.replace(/^\//, "")) : join(cwd, v.file);
		try {
			if (existsSync(abs)) {
				unlinkSync(abs);
				removed++;
			}
		} catch {
			// 忽略单个文件删除失败
		}
	}
	delete store.slots[slotId];
	saveSlotStoreNow(cwd, store);
	return removed;
}

/** 删除全部 slot（逐个复用 deleteSlot 内部逻辑）；返回删除的 slot 数 */
export function deleteAllSlots(cwd: string): number {
	const store = effectiveStore(cwd);
	const ids = Object.keys(store.slots);
	let removed = 0;
	for (const id of ids) {
		// deleteSlot 对不存在的 slot 返回 0；存在则删除（文件数 ≥0 也可能 0），用删除前存在性计数
		if (store.slots[id]) removed++;
		deleteSlot(cwd, id);
	}
	return removed;
}

/**
 * 标记 slot 全部版本为 discarded（reroll 联动：旧回复被替换后其 slot 不再展示，
 * 文件保留供回退，超期后随 cleanupExpired 清理）。slot 不存在 → 返回 false。
 */
export function discardSlot(cwd: string, slotId: string): boolean {
	const store = effectiveStore(cwd);
	const entry = store.slots[slotId];
	if (!entry) return false;
	const versions = entry.versions.map((v) => ({ ...v, discarded: true }));
	store.slots[slotId] = { ...entry, versions };
	saveSlotStoreNow(cwd, store);
	return true;
}

/**
 * 过期清理：
 * - 未保存 slot 创建超 retentionDays → 删 cache 文件 + 移除映射
 * - discarded 版本超期 → 删文件 + 从 versions 移除
 * - 已保存（savedAt>0）与未超期的不动
 */
export function cleanupExpired(cwd: string, retentionDays = 3): { removedSlots: number; removedFiles: number } {
	const store = effectiveStore(cwd);
	const now = Date.now();
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const removedSlots: string[] = [];
	let removedFiles = 0;

	const dropFile = (file: string): void => {
		const abs = file.startsWith("/") ? join(cwd, file.replace(/^\//, "")) : join(cwd, file);
		try {
			if (existsSync(abs)) {
				unlinkSync(abs);
				removedFiles++;
			}
		} catch {
			// 忽略
		}
	};

	for (const [slotId, entry] of Object.entries(store.slots)) {
		// 未保存 slot：整体超期 → 删文件 + 移除
		const anySaved = entry.versions.some((v) => v.savedAt > 0);
		if (!anySaved && entry.createdAt > 0 && entry.createdAt < cutoff) {
			for (const v of entry.versions) dropFile(v.file);
			removedSlots.push(slotId);
			delete store.slots[slotId];
			continue;
		}
		// 部分保存/已保存：只清超期的 discarded 版本（dropFile 内部已计数 removedFiles）
		const versions = entry.versions.filter((v) => {
			if (!v.discarded) return true;
			// 用 savedAt 判断超期（discarded 版本已保存则按其保存时间；未保存按 created 兜底）
			const t = v.savedAt > 0 ? v.savedAt : entry.createdAt;
			if (t > 0 && t < cutoff) {
				dropFile(v.file);
				return false;
			}
			return true;
		});
		if (versions.length !== entry.versions.length) {
			store.slots[slotId] = { ...entry, versions };
		}
	}

	saveSlotStoreNow(cwd, store);
	return { removedSlots: removedSlots.length, removedFiles };
}

// ---------- 磁盘扫描 / 信息 ----------

/** 扫描 .liyuan-media/ 已保存文件；与映射比对，缺失的登记为孤儿文件（只统计不建 slot） */
export function scanMediaDisk(cwd: string): { files: string[]; orphanFiles: string[] } {
	const mediaDir = dir(cwd, "media");
	let files: string[] = [];
	try {
		files = readdirSync(mediaDir)
			.filter((f) => /\.(png|jpe?g|webp|gif|avif)$/i.test(f))
			.sort();
	} catch {
		return { files: [], orphanFiles: [] };
	}
	const store = loadSlotStore(cwd);
	const referenced = new Set<string>();
	for (const e of Object.values(store.slots)) {
		for (const v of e.versions) {
			if (v.savedAt > 0) {
				const name = v.file.replace(/^\.liyuan-media\//, "");
				referenced.add(name);
			}
		}
	}
	const orphanFiles = files.filter((f) => !referenced.has(f));
	return { files, orphanFiles };
}

/** 从版本 params 读 tags（兼容旧 prompt 文本：无 scene 时回退 prompt 作 scene 展示） */
export function tagsFromParams(params: Record<string, unknown>): VersionTags {
	const out: VersionTags = {};
	if (typeof params.scene === "string") out.scene = params.scene;
	else if (typeof params.prompt === "string") out.scene = params.prompt; // 旧格式回退
	if (Array.isArray(params.characterPrompts)) {
		out.characterPrompts = params.characterPrompts
			.filter(
				(c): c is { name: string; prompt: string; uc?: string } =>
					!!c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string" && typeof (c as { prompt?: unknown }).prompt === "string",
			)
			.map((c) => ({ name: c.name, prompt: c.prompt, ...(typeof c.uc === "string" ? { uc: c.uc } : {}) }));
	}
	if (typeof params.positive === "string") out.positive = params.positive;
	return out;
}

/** 相对路径 → 显示 URL（/cache/ 或 /media/ 前缀）；空串（失败占位）→ "" */
function fileToSrc(file: string): string {
	if (!file) return "";
	if (file.startsWith(".liyuan-media/")) return `/media/${file.slice(".liyuan-media/".length)}`;
	if (file.startsWith(".liyuan-cache/")) return `/cache/${file.slice(".liyuan-cache/".length)}`;
	if (file.startsWith("/")) return file;
	return file;
}

/** 取 slot 当前显示信息；不存在返回 null */
export function getSlotInfo(cwd: string, slotId: string): SlotInfo | null {
	const store = loadSlotStore(cwd);
	const entry = store.slots[slotId];
	if (!entry) return null;
	const ver = currentVersion(entry);
	const saved = !!ver && ver.savedAt > 0;
	const src = ver ? fileToSrc(ver.file) : "";
	const hasFailed = entry.versions.some((v) => !!v.failed);
	return {
		slotId,
		saved,
		src,
		versionCount: entry.versions.length,
		createdAt: entry.createdAt,
		...(typeof entry.selectedVersionIndex === "number" ? { selectedVersionIndex: entry.selectedVersionIndex } : {}),
		...(ver && ver.failed ? { failed: ver.failed } : {}),
		...(hasFailed ? { hasFailed: true } : {}),
		versions: entry.versions.map((v) => ({
			file: v.file,
			src: fileToSrc(v.file),
			saved: v.savedAt > 0,
			discarded: v.discarded,
			tags: tagsFromParams(v.params),
			...(v.failed ? { failed: v.failed } : {}),
		})),
	};
}

/** 全部 slot 摘要（列表路由用） */
export function listSlotSummaries(
	cwd: string,
): {
	slotId: string;
	saved: boolean;
	createdAt: number;
	versionCount: number;
	selectedVersionIndex?: number;
	failed?: { code: string; reason: string };
	hasFailed?: boolean;
}[] {
	const store = loadSlotStore(cwd);
	return Object.entries(store.slots).map(([slotId, e]) => {
		const ver = currentVersion(e);
		const hasFailed = e.versions.some((v) => !!v.failed);
		return {
			slotId,
			saved: !!ver && ver.savedAt > 0,
			createdAt: e.createdAt,
			versionCount: e.versions.length,
			...(typeof e.selectedVersionIndex === "number" ? { selectedVersionIndex: e.selectedVersionIndex } : {}),
			...(ver && ver.failed ? { failed: ver.failed } : {}),
			...(hasFailed ? { hasFailed: true } : {}),
		};
	});
}

/** 文件修改时间辅助（重建补登记时判断 cache 文件存在性） */
export function cacheFileExists(cwd: string, file: string): boolean {
	return existsSync(resolveCacheAbs(cwd, file));
}

/** 文件 stat 辅助（预留；当前未用，供后续扩展） */
export function fileMtimeMs(abs: string): number {
	try {
		return statSync(abs).mtimeMs;
	} catch {
		return 0;
	}
}
