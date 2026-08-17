/**
 * 表格行向量同步（DESIGN-tables-vector §4，2026-08-16）。
 *
 * 独立向量库：`.liyuan-state/tables-vec/<scopeId>.jsonl`（行式 JSON，与 .liyuan-memory
 * 解耦）。表行 → chunk（id = "tables:<表名>:<rowid>" 稳定，支持按行 upsert/移除），
 * 嵌入模式跟随 .liyuan-memory/config.json（local 同步哈希 / cloud 异步接口）。
 *
 * 降级健壮性（§12）：
 * - 无表/未启用 → 调用方短路（本模块只做「有数据时的正确行为」）；
 * - 嵌入异常 → 抛出，调用方捕获并降级（表数据照常落 SQLite，检索注入降级）；
 * - 向量文件损坏 → 坏行跳过，下次全量重同步自然重建。
 *
 * 纯函数式（cwd/scope 注入），零 pi 依赖，可单测。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadMemoryConfig, memoryScopeId, type MemoryScope } from "../memory/config.ts";
import { cosine, embedTextLocal, embedTextsCloud, LOCAL_EMBED_DIM } from "../memory/embed.ts";

// ---------------- 类型 ----------------

export interface TableRowChunk {
	id: string;
	table: string;
	rowid: number;
	text: string;
	embedding: number[];
}

export interface TableRowHit {
	table: string;
	rowid: number;
	text: string;
	score: number;
}

/** 一行表数据的序列化文本（检索与展示共用） */
export function rowText(table: string, row: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(row)) {
		if (k === "__rowid") continue;
		if (v === null || v === undefined || v === "") continue;
		parts.push(`${k}=${String(v)}`);
	}
	return `${table}｜${parts.join("；")}`;
}

export const chunkIdOf = (table: string, rowid: number): string => `tables:${table}:${rowid}`;

// ---------------- 文件 ----------------

export function tableVecFile(cwd: string, scope: MemoryScope): string {
	return join(cwd, ".liyuan-state", "tables-vec", `${memoryScopeId(scope)}.jsonl`);
}

function loadChunks(cwd: string, scope: MemoryScope): TableRowChunk[] {
	const p = tableVecFile(cwd, scope);
	if (!existsSync(p)) return [];
	const out: TableRowChunk[] = [];
	for (const line of readFileSync(p, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const c = JSON.parse(line) as TableRowChunk;
			if (c && typeof c.id === "string" && Array.isArray(c.embedding)) out.push(c);
		} catch {
			// 坏行跳过（文件损坏由全量重同步重建）
		}
	}
	return out;
}

function saveChunks(cwd: string, scope: MemoryScope, chunks: TableRowChunk[]): void {
	const p = tableVecFile(cwd, scope);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""), "utf8");
}

// ---------------- 嵌入（跟随 memory 配置） ----------------

async function embedTableTexts(cwd: string, texts: string[]): Promise<number[][]> {
	const cfg = loadMemoryConfig(cwd);
	if (cfg.embedMode === "cloud") {
		return embedTextsCloud(texts, cfg.cloudEmbed);
	}
	return texts.map((t) => embedTextLocal(t, LOCAL_EMBED_DIM));
}

// ---------------- 同步 ----------------

/**
 * 单表全量同步：把该表现在所有行 upsert 进向量库，并清理该表已不存在的 rowid。
 * （写路径「不解析 SQL 行变化」——对写过的表整表重同步，单表 ≤200 行毫秒级。）
 */
export async function syncTableRows(
	cwd: string,
	scope: MemoryScope,
	table: string,
	rows: Array<{ rowid: number; text: string }>,
): Promise<{ added: number; updated: number; removed: number }> {
	const chunks = loadChunks(cwd, scope);
	const byId = new Map(chunks.map((c) => [c.id, c]));
	const texts = rows.map((r) => r.text).filter((t) => t.length > 0);
	const vectors = texts.length > 0 ? await embedTableTexts(cwd, texts) : [];
	let added = 0;
	let updated = 0;
	const seen = new Set<string>();
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i]!;
		const id = chunkIdOf(table, r.rowid);
		seen.add(id);
		const existing = byId.get(id);
		if (existing) {
			if (existing.text !== r.text) {
				existing.text = r.text;
				existing.embedding = vectors[i]!;
				updated++;
			}
			continue;
		}
		byId.set(id, { id, table, rowid: r.rowid, text: r.text, embedding: vectors[i]! });
		added++;
	}
	// 清理该表已不存在的 rowid
	let removed = 0;
	for (const c of chunks) {
		if (c.table === table && !seen.has(c.id)) {
			removed++;
			byId.delete(c.id);
		}
	}
	// 保存全部（Map 含旧 + 新增 + 更新后的 chunk）
	saveChunks(cwd, scope, [...byId.values()]);
	return { added, updated, removed };
}

/** 删表：移除该表全部 chunks */
export function removeTableVec(cwd: string, scope: MemoryScope, table: string): void {
	const chunks = loadChunks(cwd, scope).filter((c) => c.table !== table);
	saveChunks(cwd, scope, chunks);
}

/** 全清（rewind 全量重同步前） */
export function clearTableVec(cwd: string, scope: MemoryScope): void {
	saveChunks(cwd, scope, []);
}

// ---------------- 检索 ----------------

/**
 * 检索与本拍上下文最相关的表行：query 嵌入 → 余弦 → threshold 过滤 → topK。
 * 嵌入异常向上抛（调用方降级：返回空注入，主链路不受影响）。
 */
export async function searchTableRows(
	cwd: string,
	scope: MemoryScope,
	query: string,
	topK = 6,
	threshold = 0.15,
): Promise<TableRowHit[]> {
	const q = query.trim();
	if (!q) return [];
	const chunks = loadChunks(cwd, scope);
	if (chunks.length === 0) return [];
	const [qvec] = await embedTableTexts(cwd, [q]);
	if (!qvec) return [];
	const hits: TableRowHit[] = [];
	for (const c of chunks) {
		const score = cosine(qvec, c.embedding);
		if (score < threshold) continue;
		hits.push({ table: c.table, rowid: c.rowid, text: c.text, score });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, topK);
}

/** 向量库 chunk 数（诊断/告警用） */
export function tableVecSize(cwd: string, scope: MemoryScope): number {
	return loadChunks(cwd, scope).length;
}
