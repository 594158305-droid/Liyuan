/**
 * D 标签离线库（插件 A draw-role，DESIGN-draw §3.1 一期）：danbooru-chars.dat 惰性加载。
 *
 * 数据文件：src/draw-plugins/draw-role/data/danbooru-chars.dat（zlib 压缩流，头 78 DA）。
 * 解压后为 UTF-8 JSON：`[["角色danbooru名",["tag1","tag2",...]], ...]`（7000 个角色）。
 * tag 为 danbooru 下划线格式（如 hatsune_miku → long_hair, twintails）。
 *
 * 零依赖纯 TS（node:zlib 属运行时内建，非 pi）：惰性加载 + 模块级缓存；
 * 解压/解析失败（数据文件缺失/损坏）降级为空库并记一次 console.warn，不崩溃。
 */

import { inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginDataDir } from "../registry.ts";

/** 角色条目：danbooru 名 + 外貌 tag 列表 */
export interface CharacterTagEntry {
	name: string;
	tags: string[];
}

/** 数据文件路径（ESM 稳定定位，不依赖 cwd） */
const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), "data", "danbooru-chars.dat");

/** 模块级缓存：首次调用才读盘解压 */
let cached: CharacterTagEntry[] | null = null;
let warned = false;

/**
 * 惰性加载 + 模块级缓存：zlib.inflateSync 解压 → JSON.parse → 建倒排索引。
 * 数据文件缺失/损坏 → 空数组（记一次 console.warn），搜索返回空。
 */
export function loadCharacterTagDb(): CharacterTagEntry[] {
	if (cached) return cached;
	cached = [];
	try {
		const buf = readFileSync(DATA_FILE);
		const json = JSON.parse(inflateSync(buf).toString("utf8")) as unknown;
		if (Array.isArray(json)) {
			const entries: CharacterTagEntry[] = [];
			for (const row of json) {
				if (!Array.isArray(row) || typeof row[0] !== "string") continue;
				const name = row[0].trim();
				if (!name) continue;
				const tags = Array.isArray(row[1]) ? row[1].filter((t): t is string => typeof t === "string") : [];
				entries.push({ name, tags });
			}
			cached = entries;
		}
	} catch (err) {
		if (!warned) {
			warned = true;
			console.warn(`[draw-role] D 标签库加载失败（已降级为空库）：${err instanceof Error ? err.message : String(err)}`);
		}
		cached = [];
	}
	return cached;
}

/** 按名字搜索角色（danbooru 名子串匹配，不区分大小写；按名长升序→原顺序稳定）；limit 默认 20 */
export function searchCharacters(query: string, limit = 20): CharacterTagEntry[] {
	const q = (query ?? "").trim().toLowerCase();
	if (!q) return [];
	const hits: { entry: CharacterTagEntry; pos: number }[] = [];
	for (const entry of loadCharacterTagDb()) {
		const idx = entry.name.toLowerCase().indexOf(q);
		if (idx !== -1) hits.push({ entry, pos: idx });
	}
	// 按名长升序（短名/全名匹配优先），同名保持原顺序稳定
	hits.sort((a, b) => a.entry.name.length - b.entry.name.length || a.pos - b.pos);
	return hits.slice(0, Math.max(0, limit)).map((h) => h.entry);
}

/** 按 tag 搜索（离线库，tag 名子串匹配；count=含该 tag 的角色数）；limit 默认 20 */
export function searchTags(query: string, limit = 20): { tag: string; count: number }[] {
	const q = (query ?? "").trim().toLowerCase();
	if (!q) return [];
	const counts = new Map<string, number>();
	for (const entry of loadCharacterTagDb()) {
		for (const t of entry.tags) {
			if (t.toLowerCase().includes(q)) counts.set(t, (counts.get(t) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
		.slice(0, Math.max(0, limit));
}

/**
 * 在线合并版 tag 搜索：显式传 cwd（供 rest 侧调用）——离线优先 + 在线补全。
 */
export function searchTagsWithOnline(
	cwd: string,
	query: string,
	limit = 20,
): { tag: string; count: number }[] {
	const q = (query ?? "").trim().toLowerCase();
	if (!q) return [];
	const offline = new Map<string, number>();
	for (const entry of loadCharacterTagDb()) {
		for (const t of entry.tags) {
			if (t.toLowerCase().includes(q)) offline.set(t, (offline.get(t) ?? 0) + 1);
		}
	}
	const merged = new Map<string, number>(offline);
	for (const { tag, count } of searchOnlineTags(cwd, q, 50)) {
		if (!merged.has(tag)) merged.set(tag, -count); // 负数=在线独有
	}
	return [...merged.entries()]
		.map(([tag, count]) => ({ tag, count: Math.abs(count) }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
		.slice(0, Math.max(0, limit));
}

/** 索引统计（调试/测试用） */
export function tagDbStats(): { characters: number; tags: number } {
	const db = loadCharacterTagDb();
	const tagSet = new Set<string>();
	for (const e of db) for (const t of e.tags) tagSet.add(t);
	return { characters: db.length, tags: tagSet.size };
}

// ---------- 在线标签库（二期）：HuggingFace danbooru tags.csv 下载缓存 ----------

/** 在线标签库缓存文件：.liyuan-plugins/draw-role/tags/tags.csv */
const onlineTagsPath = (cwd: string): string => join(pluginDataDir(cwd, "draw-role"), "tags", "tags.csv");

/** 在线标签库状态元信息文件：.liyuan-plugins/draw-role/tags/status.json */
const onlineStatusPath = (cwd: string): string => join(pluginDataDir(cwd, "draw-role"), "tags", "status.json");

const DEFAULT_ONLINE_SOURCE =
	"https://huggingface.co/datasets/KBlueLeaf/danbooru2023-metadata-database/resolve/main/tags.csv";

/** 在线标签条目：tag 名 + 出现次数（count/post_count） */
export interface OnlineTagEntry {
	tag: string;
	count: number;
}

/** 在线库状态（读缓存；无缓存返回 null） */
export function getOnlineTagDbStatus(cwd: string): { lastUpdatedAt: number | null; entries: number } | null {
	const p = onlineStatusPath(cwd);
	if (!existsSync(p)) return null;
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as { lastUpdatedAt?: unknown; entries?: unknown };
		return {
			lastUpdatedAt: typeof raw.lastUpdatedAt === "number" ? raw.lastUpdatedAt : null,
			entries: typeof raw.entries === "number" ? raw.entries : 0,
		};
	} catch {
		return null;
	}
}

/** 内存 Map 缓存（在线 tag → count） */
let onlineCache: Map<string, number> | null = null;

/** 加载在线缓存（无文件 → 空 Map） */
function loadOnlineCache(cwd: string): Map<string, number> {
	if (onlineCache) return onlineCache;
	const map = new Map<string, number>();
	const p = onlineTagsPath(cwd);
	if (existsSync(p)) {
		try {
			const text = readFileSync(p, "utf8");
			for (const line of text.split("\n")) {
				const parts = line.split(",");
				const name = (parts[0] ?? "").trim();
				if (!name) continue;
				const count = Number.parseInt((parts[1] ?? "").trim(), 10);
				if (Number.isFinite(count) && count > 0) map.set(name, count);
			}
		} catch {
			// 缓存文件损坏：忽略（下次更新覆盖）
		}
	}
	onlineCache = map;
	return map;
}

/**
 * 更新在线标签库：下载 sourceUrl 的 CSV（行 name,count 或 name,post_count），
 * 容错跳过坏行；缓存到 .liyuan-plugins/draw-role/tags/tags.csv + 内存 Map + 状态文件。
 * 下载/解析失败返回 { ok:false, error }（不抛）。
 */
export async function updateOnlineTagDb(
	cwd: string,
	opts?: { fetchImpl?: typeof fetch; sourceUrl?: string },
): Promise<{ ok: true; entries: number; lastUpdatedAt: number } | { ok: false; error: string }> {
	const fetchImpl = opts?.fetchImpl ?? fetch;
	const sourceUrl = opts?.sourceUrl ?? DEFAULT_ONLINE_SOURCE;
	try {
		const res = await fetchImpl(sourceUrl);
		if (!res.ok) return { ok: false, error: `下载失败（HTTP ${res.status}）` };
		const text = await res.text();
		const map = new Map<string, number>();
		for (const line of text.split("\n")) {
			const parts = line.split(",");
			const name = (parts[0] ?? "").trim();
			if (!name) continue;
			const count = Number.parseInt((parts[1] ?? "").trim(), 10);
			if (Number.isFinite(count) && count > 0) map.set(name, count);
		}
		if (map.size === 0) return { ok: false, error: "CSV 未解析到有效条目" };
		const dir = dirname(onlineTagsPath(cwd));
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			onlineTagsPath(cwd),
			[...map.entries()].map(([tag, count]) => `${tag},${count}`).join("\n"),
			"utf8",
		);
		const lastUpdatedAt = Date.now();
		writeFileSync(
			onlineStatusPath(cwd),
			`${JSON.stringify({ lastUpdatedAt, entries: map.size }, null, "\t")}\n`,
			"utf8",
		);
		onlineCache = map;
		return { ok: true, entries: map.size, lastUpdatedAt };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * 在线 tag 搜索（子串匹配，按 count 降序）；无缓存返回空。
 */
export function searchOnlineTags(cwd: string, query: string, limit = 20): { tag: string; count: number }[] {
	const q = (query ?? "").trim().toLowerCase();
	if (!q) return [];
	const map = loadOnlineCache(cwd);
	const hits: { tag: string; count: number }[] = [];
	for (const [tag, count] of map) {
		if (tag.toLowerCase().includes(q)) hits.push({ tag, count });
	}
	return hits.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, Math.max(0, limit));
}
