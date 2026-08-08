/**
 * 自定义标签组（插件 A draw-role 二期，DESIGN-draw §3.1 二期）：
 * 用户自定义标签组（增删/导入导出 JSON），生图时可选追加到 scene。
 *
 * 数据文件：.liyuan-plugins/draw-role/tag-groups.json（pluginDataDir）。
 * 零 pi / 零 server import。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { pluginDataDir } from "../registry.ts";

export interface TagGroup {
	id: string;
	name: string;
	/** NovelAI tag 串（空格分隔，可带 n::tag:: 权重） */
	tags: string;
	enabled: boolean;
	createdAt: number;
	/** 绑定角色名（空/缺省 = 全局组；非空 = 只对该角色生效） */
	characterId?: string;
}

export interface TagGroupsFile {
	version: 1;
	groups: TagGroup[];
	/** 全局当前选中组 id（指向某个无 characterId 的全局组；空 = 未选中） */
	selectedGroupId?: string;
}

const FILE_NAME = "tag-groups.json";

/** 数据文件路径：.liyuan-plugins/draw-role/tag-groups.json */
export function tagGroupsPath(cwd: string): string {
	return join(pluginDataDir(cwd, "draw-role"), FILE_NAME);
}

function emptyFile(): TagGroupsFile {
	return { version: 1, groups: [], selectedGroupId: undefined };
}

/** 读（缺失/损坏 → 空） */
export function loadTagGroups(cwd: string): TagGroupsFile {
	const p = tagGroupsPath(cwd);
	if (!existsSync(p)) return emptyFile();
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<TagGroupsFile>;
		const groups = Array.isArray(raw.groups)
			? raw.groups
					.filter(
						(g): g is TagGroup =>
							!!g && typeof g === "object" && typeof g.id === "string" && typeof g.name === "string",
					)
					.map((g) => ({
						id: g.id,
						name: g.name,
						tags: typeof g.tags === "string" ? g.tags : "",
						enabled: g.enabled === true,
						createdAt: typeof g.createdAt === "number" ? g.createdAt : 0,
						...(typeof g.characterId === "string" && g.characterId ? { characterId: g.characterId } : {}),
					}))
			: [];
		return {
			version: 1,
			groups,
			...(typeof raw.selectedGroupId === "string" && raw.selectedGroupId ? { selectedGroupId: raw.selectedGroupId } : {}),
		};
	} catch {
		return emptyFile();
	}
}

function save(cwd: string, file: TagGroupsFile): void {
	const p = tagGroupsPath(cwd);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
}

/**
 * 保存标签组：有 id → 更新（缺省字段保留）；无 id → 生成 randomBytes(4).hex。
 * 返回新文件（含保存后的组）。
 */
export function saveTagGroup(cwd: string, group: Partial<TagGroup> & { name: string }): TagGroupsFile {
	const file = loadTagGroups(cwd);
	const name = (group.name ?? "").trim() || "未命名组";
	if (group.id && group.id.trim()) {
		const id = group.id.trim();
		const next = file.groups.map((g) =>
			g.id === id
				? {
						...g,
						name,
						tags: group.tags !== undefined ? group.tags : g.tags,
						enabled: group.enabled !== undefined ? group.enabled : g.enabled,
						...(group.characterId !== undefined
							? typeof group.characterId === "string" && group.characterId
								? { characterId: group.characterId }
								: {}
							: g.characterId
								? { characterId: g.characterId }
								: {}),
					}
				: g,
		);
		const out: TagGroupsFile = {
			version: 1,
			groups: next,
			...(file.selectedGroupId ? { selectedGroupId: file.selectedGroupId } : {}),
		};
		save(cwd, out);
		return out;
	}
	const id = randomBytes(4).toString("hex");
	const out: TagGroupsFile = {
		version: 1,
		groups: [
			...file.groups,
			{
				id,
				name,
				tags: group.tags ?? "",
				enabled: group.enabled !== false,
				createdAt: Date.now(),
				...(typeof group.characterId === "string" && group.characterId ? { characterId: group.characterId } : {}),
			},
		],
		...(file.selectedGroupId ? { selectedGroupId: file.selectedGroupId } : {}),
	};
	save(cwd, out);
	return out;
}

/** 删除标签组 */
export function deleteTagGroup(cwd: string, id: string): { ok: boolean } {
	const file = loadTagGroups(cwd);
	const selectedGroupId =
		file.selectedGroupId === id ? undefined : file.selectedGroupId;
	const next: TagGroupsFile = {
		version: 1,
		groups: file.groups.filter((g) => g.id !== id),
		...(selectedGroupId ? { selectedGroupId } : {}),
	};
	save(cwd, next);
	return { ok: true };
}

/** 开关标签组 */
export function setTagGroupEnabled(cwd: string, id: string, enabled: boolean): { ok: boolean } {
	const file = loadTagGroups(cwd);
	const next: TagGroupsFile = {
		version: 1,
		groups: file.groups.map((g) => (g.id === id ? { ...g, enabled } : g)),
		...(file.selectedGroupId ? { selectedGroupId: file.selectedGroupId } : {}),
	};
	save(cwd, next);
	return { ok: true };
}

/** 启用组的 tags 空格拼接（生图时追加到 scene）。保持原行为（全部 enabled 组，供旧调用）。 */
export function getEnabledGroupTags(cwd: string): string {
	const file = loadTagGroups(cwd);
	return file.groups
		.filter((g) => g.enabled)
		.map((g) => g.tags)
		.filter(Boolean)
		.join(" ");
}

/** 设置全局当前选中组（写顶层 selectedGroupId；null 清除；groupId 不存在时忽略） */
export function setGlobalSelectedGroup(cwd: string, groupId: string | null): void {
	const file = loadTagGroups(cwd);
	if (groupId === null || groupId === "") {
		const next: TagGroupsFile = { version: 1, groups: file.groups };
		save(cwd, next);
		return;
	}
	const target = file.groups.find((g) => g.id === groupId && !g.characterId);
	if (!target) return; // 不存在（或非全局组）→ 忽略
	const next: TagGroupsFile = { version: 1, groups: file.groups, selectedGroupId: groupId };
	save(cwd, next);
}

/**
 * 全局选中组 tags：
 * - 顶层 selectedGroupId 指向某全局组（无 characterId）→ 返回该组 tags；
 * - 否则回退 getEnabledGroupTags 行为（全部 enabled 全局组）。
 */
export function getGlobalSelectedGroupTags(cwd: string): string {
	const file = loadTagGroups(cwd);
	if (file.selectedGroupId) {
		const g = file.groups.find((x) => x.id === file.selectedGroupId && !x.characterId);
		if (g) return (g.tags ?? "").trim();
	}
	return getEnabledGroupTags(cwd);
}

/**
 * 角色选中组 tags：找 characterId===characterName 的组中 id===selectedGroupId 的组；
 * 有 → 返回该组 tags；没有 → ""。
 */
export function getRoleGroupTags(cwd: string, characterName: string, selectedGroupId?: string): string {
	if (!selectedGroupId) return "";
	const file = loadTagGroups(cwd);
	const g = file.groups.find(
		(x) => x.id === selectedGroupId && x.characterId === characterName,
	);
	return g ? (g.tags ?? "").trim() : "";
}

/** 导入（按 id 去重覆盖；无 id 的生成新 id）；返回导入数 */
export function importTagGroups(cwd: string, groups: TagGroup[]): number {
	const file = loadTagGroups(cwd);
	let imported = 0;
	let nextGroups = [...file.groups];
	for (const raw of groups ?? []) {
		if (!raw || typeof raw !== "object") continue;
		const name = (raw.name ?? "").trim();
		if (!name) continue;
		const characterId = typeof raw.characterId === "string" && raw.characterId ? raw.characterId : undefined;
		if (raw.id && raw.id.trim()) {
			const idx = nextGroups.findIndex((g) => g.id === raw.id);
			const item: TagGroup = {
				id: raw.id.trim(),
				name,
				tags: typeof raw.tags === "string" ? raw.tags : "",
				enabled: raw.enabled !== false,
				createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
				...(characterId ? { characterId } : {}),
			};
			if (idx >= 0) nextGroups[idx] = item;
			else nextGroups.push(item);
		} else {
			nextGroups.push({
				id: randomBytes(4).toString("hex"),
				name,
				tags: typeof raw.tags === "string" ? raw.tags : "",
				enabled: raw.enabled !== false,
				createdAt: Date.now(),
				...(characterId ? { characterId } : {}),
			});
		}
		imported++;
	}
	const next: TagGroupsFile = {
		version: 1,
		groups: nextGroups,
		...(file.selectedGroupId ? { selectedGroupId: file.selectedGroupId } : {}),
	};
	save(cwd, next);
	return imported;
}

/** 导出全部标签组（每组含 characterId 新字段） */
export function exportTagGroups(cwd: string): TagGroup[] {
	return loadTagGroups(cwd).groups;
}
