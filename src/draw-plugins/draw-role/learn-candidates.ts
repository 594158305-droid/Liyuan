/**
 * 未知角色自动学习（插件 A draw-role 二期，DESIGN-draw §3.1 二期）：
 * 管线检出的不在服装档案里的角色 → 记录候选 → 用户确认后写入 wardrobe。
 *
 * 数据文件：.liyuan-plugins/draw-role/learn-candidates.json（pluginDataDir）。
 * 零 pi / 零 server import。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginDataDir } from "../registry.ts";
import { resolveConfigPath } from "../../paths.ts";
import { DEFAULT_CONFIG, type RpConfig } from "../../types.ts";
import { loadWardrobe, saveWardrobe, upsertCharacter } from "../../wardrobe.ts";

/** 学习候选：管线/手动检出的未知角色 */
export interface LearnCandidate {
	name: string;
	firstSeenAt: number;
	source: "pipeline" | "manual";
	status: "pending" | "learned" | "ignored";
}

export interface LearnCandidatesFile {
	version: 1;
	candidates: LearnCandidate[];
}

const FILE_NAME = "learn-candidates.json";

/** 数据文件路径：.liyuan-plugins/draw-role/learn-candidates.json */
export function learnCandidatesPath(cwd: string): string {
	return join(pluginDataDir(cwd, "draw-role"), FILE_NAME);
}

function emptyFile(): LearnCandidatesFile {
	return { version: 1, candidates: [] };
}

/** 读（缺失/损坏 → 空） */
export function loadLearnCandidates(cwd: string): LearnCandidatesFile {
	const p = learnCandidatesPath(cwd);
	if (!existsSync(p)) return emptyFile();
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<LearnCandidatesFile>;
		const candidates = Array.isArray(raw.candidates)
			? raw.candidates
					.filter(
						(c): c is LearnCandidate =>
							!!c &&
							typeof c === "object" &&
							typeof c.name === "string" &&
							typeof c.firstSeenAt === "number",
					)
					.map((c) => ({
						name: c.name.trim(),
						firstSeenAt: c.firstSeenAt,
						source: c.source === "manual" ? ("manual" as const) : ("pipeline" as const),
						status:
							c.status === "learned"
								? ("learned" as const)
								: c.status === "ignored"
									? ("ignored" as const)
									: ("pending" as const),
					}))
			: [];
		return { version: 1, candidates };
	} catch {
		return emptyFile();
	}
}

function save(cwd: string, file: LearnCandidatesFile): void {
	const p = learnCandidatesPath(cwd);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
}

/**
 * 记录未知角色：同名刷新 firstSeenAt（source 保留首次来源）；
 * learned/ignored 状态不覆盖（已学习的角色不再被管线重复登记）。
 */
export function recordUnknownCharacters(cwd: string, names: string[]): LearnCandidatesFile {
	const cleaned = [...new Set((names ?? []).map((n) => (typeof n === "string" ? n.trim() : "")).filter(Boolean))];
	if (cleaned.length === 0) return loadLearnCandidates(cwd);
	const file = loadLearnCandidates(cwd);
	const byName = new Map(file.candidates.map((c) => [c.name, c]));
	for (const name of cleaned) {
		const existing = byName.get(name);
		if (existing) {
			if (existing.status === "learned" || existing.status === "ignored") continue;
			existing.firstSeenAt = Date.now();
		} else {
			byName.set(name, { name, firstSeenAt: Date.now(), source: "pipeline", status: "pending" });
		}
	}
	const next = { version: 1 as const, candidates: [...byName.values()] };
	save(cwd, next);
	return next;
}

/** 列表（可选按状态过滤；默认全量） */
export function listLearnCandidates(cwd: string, status?: "pending" | "learned" | "ignored"): LearnCandidate[] {
	const file = loadLearnCandidates(cwd);
	if (!status) return file.candidates;
	return file.candidates.filter((c) => c.status === status);
}

/** 领域层读项目配置（与 draw-role index.ts 同源） */
function loadConfig(cwd: string): RpConfig {
	const p = resolveConfigPath(cwd);
	if (!existsSync(p)) return { ...DEFAULT_CONFIG };
	try {
		return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<RpConfig>) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * 确认学习：把角色 upsert 进 wardrobe（cardPath 缺省当前卡）+ 标记 learned。
 * 返回 { ok } 或 { ok:false, error }（cardPath 无效时抛中文错）。
 */
export function confirmLearnCharacter(
	cwd: string,
	name: string,
	cardPath?: string,
): { ok: true } | { ok: false; error: string } {
	const n = (name ?? "").trim();
	if (!n) return { ok: false, error: "缺少 name" };
	const card = (cardPath ?? "").trim() || (loadConfig(cwd).card ?? "").trim();
	if (!card) return { ok: false, error: "缺少 card（当前未配置角色卡）" };
	try {
		const wb = upsertCharacter(loadWardrobe(cwd, card), n);
		saveWardrobe(cwd, wb);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	const file = loadLearnCandidates(cwd);
	const next = {
		version: 1 as const,
		candidates: file.candidates.map((c) =>
			c.name === n ? { ...c, status: ("learned" as const) } : c,
		),
	};
	// 确认时若尚未登记（手动确认），补一条 learned 记录
	if (!next.candidates.some((c) => c.name === n)) {
		next.candidates.push({ name: n, firstSeenAt: Date.now(), source: "manual", status: "learned" });
	}
	save(cwd, next);
	return { ok: true };
}

/** 忽略候选（标记 ignored） */
export function dismissLearnCandidate(cwd: string, name: string): { ok: boolean } {
	const n = (name ?? "").trim();
	if (!n) return { ok: false };
	const file = loadLearnCandidates(cwd);
	const next = {
		version: 1 as const,
		candidates: file.candidates.map((c) => (c.name === n ? { ...c, status: ("ignored" as const) } : c)),
	};
	save(cwd, next);
	return { ok: true };
}
