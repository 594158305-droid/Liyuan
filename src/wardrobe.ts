/**
 * 服装档案（.liyuan-wardrobe/）：按角色卡组织的命名服装集。
 *
 * 与用户角色卡文件解耦（不改写卡）；参考图存 .liyuan-wardrobe/refs/。
 * 「当前穿着」是状态层（账本 CharacterState.outfit，随世界线回档），
 * 本文件只管理「定义层」：角色外观 tag + 服装 tag 集。零 pi 依赖（D3 合规）。
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { readJsonFile } from "./jsonio.ts";

export const WARDROBE_DIR = ".liyuan-wardrobe";

export interface Outfit {
	id: string;
	name: string;
	/** NovelAI tag 串（空格分隔，可带 n::tag:: 权重） */
	tags: string;
	/** 参考图路径（相对 cwd，存 .liyuan-wardrobe/refs/） */
	referenceImage?: string;
	notes?: string;
}

export interface WardrobeCharacter {
	name: string;
	/** 基础外观 tag（发型/瞳色/体型，非服装） */
	appearanceTags: string;
	outfits: Outfit[];
	/** 默认穿着（无当前穿着状态时回退） */
	defaultOutfit?: string;
	/** 别名（检出用；正文含别名即算在场） */
	aliases?: string[];
	/** 角色类型（如 主角/配角/NPC） */
	type?: string;
	/** 角色级负面 tag（生图时并入 negativePrompt） */
	negativeTags?: string;
	/** Danbooru 角色 tag（如 hakurei_reimu） */
	danbooruTag?: string;
	/** 生图时是否并入 danbooruTag（缺省 true） */
	useDanbooruTag?: boolean;
	/** 隐藏：不出现在检出/候选 */
	hidden?: boolean;
	/** 该角色选中的自定义标签组 id（见 draw-role/tag-groups.ts） */
	selectedGroupId?: string;
	/** 可选角色 id（LWB 对齐；缺省用 name） */
	id?: string;
}

export interface WardrobeFile {
	format: "liyuan-wardrobe";
	version: 1;
	/** 关联角色卡路径（相对 cwd，与配置 card 一致） */
	cardPath: string;
	characters: WardrobeCharacter[];
}

/** 卡路径 → 档案文件 key（哈希，避免文件名非法字符；跨平台稳定） */
export function wardrobeKey(cardPath: string): string {
	return createHash("md5").update(cardPath.replace(/\\/g, "/")).digest("hex").slice(0, 12);
}

export function wardrobePath(cwd: string, cardPath: string): string {
	return join(cwd, WARDROBE_DIR, `${wardrobeKey(cardPath)}.json`);
}

export function refsDir(cwd: string): string {
	return join(cwd, WARDROBE_DIR, "refs");
}

export function emptyWardrobe(cardPath: string): WardrobeFile {
	return { format: "liyuan-wardrobe", version: 1, cardPath, characters: [] };
}

export function loadWardrobe(cwd: string, cardPath: string): WardrobeFile {
	const path = wardrobePath(cwd, cardPath);
	if (!existsSync(path)) return emptyWardrobe(cardPath);
	try {
		const raw = readJsonFile(path) as Record<string, unknown>;
		const characters = Array.isArray(raw.characters)
			? raw.characters
					.map((c): WardrobeCharacter | null => {
						if (!c || typeof c !== "object") return null;
						const co = c as Record<string, unknown>;
						const name = typeof co.name === "string" && co.name.trim() ? co.name.trim() : "";
						if (!name) return null;
						const outfits = Array.isArray(co.outfits)
							? co.outfits
									.map((o): Outfit | null => {
										if (!o || typeof o !== "object") return null;
										const oo = o as Record<string, unknown>;
										const id = typeof oo.id === "string" && oo.id.trim() ? oo.id.trim() : "";
										if (!id) return null;
										return {
											id,
											name: typeof oo.name === "string" ? oo.name : id,
											tags: typeof oo.tags === "string" ? oo.tags : "",
											...(typeof oo.referenceImage === "string" && oo.referenceImage ? { referenceImage: oo.referenceImage } : {}),
											...(typeof oo.notes === "string" && oo.notes ? { notes: oo.notes } : {}),
										};
									})
									.filter((o): o is Outfit => o !== null)
							: [];
						return {
							name,
							appearanceTags: typeof co.appearanceTags === "string" ? co.appearanceTags : "",
							outfits,
							...(typeof co.defaultOutfit === "string" && co.defaultOutfit ? { defaultOutfit: co.defaultOutfit } : {}),
							...(Array.isArray(co.aliases)
								? {
										aliases: co.aliases.filter((a): a is string => typeof a === "string" && a.trim() !== ""),
									}
								: {}),
							...(typeof co.type === "string" && co.type ? { type: co.type } : {}),
							...(typeof co.negativeTags === "string" && co.negativeTags ? { negativeTags: co.negativeTags } : {}),
							...(typeof co.danbooruTag === "string" && co.danbooruTag ? { danbooruTag: co.danbooruTag } : {}),
							...(typeof co.useDanbooruTag === "boolean" ? { useDanbooruTag: co.useDanbooruTag } : {}),
							...(co.hidden === true ? { hidden: true } : {}),
							...(typeof co.selectedGroupId === "string" && co.selectedGroupId ? { selectedGroupId: co.selectedGroupId } : {}),
							...(typeof co.id === "string" && co.id ? { id: co.id } : {}),
						};
					})
					.filter((c): c is WardrobeCharacter => c !== null)
			: [];
		return { format: "liyuan-wardrobe", version: 1, cardPath, characters };
	} catch {
		return emptyWardrobe(cardPath);
	}
}

export function saveWardrobe(cwd: string, wb: WardrobeFile): void {
	const path = wardrobePath(cwd, wb.cardPath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(wb, null, "\t")}\n`, "utf8");
}

export function newOutfitId(): string {
	return randomBytes(4).toString("hex");
}

// ---------- 增改删（返回新档案，调用方决定是否落盘） ----------

export interface UpsertCharacterFields {
	aliases?: string[];
	type?: string;
	negativeTags?: string;
	danbooruTag?: string;
	useDanbooruTag?: boolean;
	hidden?: boolean;
	selectedGroupId?: string;
	id?: string;
}

/** 建新角色（参数可选，带新字段时一并写入；已存在同名 → 原样返回） */
export function upsertCharacter(wb: WardrobeFile, name: string, fields: UpsertCharacterFields = {}): WardrobeFile {
	const n = name.trim();
	if (!n) return wb;
	if (wb.characters.some((c) => c.name === n)) return wb;
	const base: WardrobeCharacter = {
		name: n,
		appearanceTags: "",
		outfits: [],
		defaultOutfit: undefined,
	};
	if (Array.isArray(fields.aliases) && fields.aliases.length > 0) base.aliases = [...fields.aliases];
	if (typeof fields.type === "string" && fields.type) base.type = fields.type;
	if (typeof fields.negativeTags === "string" && fields.negativeTags) base.negativeTags = fields.negativeTags;
	if (typeof fields.danbooruTag === "string" && fields.danbooruTag) base.danbooruTag = fields.danbooruTag;
	if (typeof fields.useDanbooruTag === "boolean") base.useDanbooruTag = fields.useDanbooruTag;
	if (fields.hidden === true) base.hidden = true;
	if (typeof fields.selectedGroupId === "string" && fields.selectedGroupId) base.selectedGroupId = fields.selectedGroupId;
	if (typeof fields.id === "string" && fields.id) base.id = fields.id;
	return { ...wb, characters: [...wb.characters, base] };
}

export function removeCharacter(wb: WardrobeFile, name: string): WardrobeFile {
	return { ...wb, characters: wb.characters.filter((c) => c.name !== name) };
}

export function setAppearanceTags(wb: WardrobeFile, name: string, tags: string): WardrobeFile {
	return {
		...wb,
		characters: wb.characters.map((c) => (c.name === name ? { ...c, appearanceTags: tags } : c)),
	};
}

export function addOutfit(wb: WardrobeFile, name: string, outfit: Outfit): WardrobeFile {
	return {
		...wb,
		characters: wb.characters.map((c) =>
			c.name === name && !c.outfits.some((o) => o.id === outfit.id)
				? { ...c, outfits: [...c.outfits, outfit] }
				: c,
		),
	};
}

export function updateOutfit(wb: WardrobeFile, name: string, outfit: Outfit): WardrobeFile {
	return {
		...wb,
		characters: wb.characters.map((c) =>
			c.name === name
				? { ...c, outfits: c.outfits.map((o) => (o.id === outfit.id ? { ...o, ...outfit } : o)) }
				: c,
		),
	};
}

export function removeOutfit(wb: WardrobeFile, name: string, outfitId: string): WardrobeFile {
	return {
		...wb,
		characters: wb.characters.map((c) => {
			if (c.name !== name) return c;
			const outfits = c.outfits.filter((o) => o.id !== outfitId);
			const defaultOutfit = c.defaultOutfit === outfitId ? (outfits[0]?.id ?? undefined) : c.defaultOutfit;
			return { ...c, outfits, defaultOutfit };
		}),
	};
}

export function setDefaultOutfit(wb: WardrobeFile, name: string, outfitId: string): WardrobeFile {
	return {
		...wb,
		characters: wb.characters.map((c) => (c.name === name ? { ...c, defaultOutfit: outfitId } : c)),
	};
}

/** 取角色实际穿着：优先指定/账本状态，回退默认，再回退第一套 */
export function resolveOutfit(
	wb: WardrobeFile,
	name: string,
	currentOutfitId?: string,
): { outfit: Outfit | null; character: WardrobeCharacter | null } {
	const character = wb.characters.find((c) => c.name === name) ?? null;
	if (!character) return { outfit: null, character: null };
	const outfit =
		character.outfits.find((o) => o.id === currentOutfitId) ??
		character.outfits.find((o) => o.id === character.defaultOutfit) ??
		character.outfits[0] ??
		null;
	return { outfit, character };
}

/** 参考图上传落盘（返回相对 cwd 路径） */
export function saveReferenceImage(cwd: string, cardPath: string, data: Buffer, ext: string): string {
	const dir = refsDir(cwd);
	mkdirSync(dir, { recursive: true });
	const name = `${wardrobeKey(cardPath)}-${randomBytes(4).toString("hex")}${ext}`;
	writeFileSync(join(dir, name), data);
	return `${WARDROBE_DIR}/refs/${name}`;
}

/** 列出 refs 目录（清理孤儿参考图用） */
export function listReferenceImages(cwd: string): string[] {
	const dir = refsDir(cwd);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => /\.(png|jpe?g|webp|gif|avif)$/i.test(f));
}

/** 删除未被任何服装引用的参考图文件 */
export function pruneReferenceImages(cwd: string, wb: WardrobeFile): void {
	const used = new Set<string>();
	for (const c of wb.characters) for (const o of c.outfits) if (o.referenceImage) used.add(o.referenceImage);
	const dir = refsDir(cwd);
	if (!existsSync(dir)) return;
	for (const f of readdirSync(dir)) {
		const rel = `${WARDROBE_DIR}/refs/${f}`;
		if (!used.has(rel)) {
			try {
				unlinkSync(join(dir, f));
			} catch {
				/* 忽略 */
			}
		}
	}
}
