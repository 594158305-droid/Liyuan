/**
 * 角色特征解析（插件 A draw-role 核心接口，DESIGN-draw §3.1 一期）：
 * 服装档案 → 组装生图用角色 tag（appearanceTags + 当前穿着 outfit.tags）+ 参考图。
 *
 * 依赖方向：插件 A → 底座（wardrobe.ts 服装档案 / draw/novelai.ts 的 CharacterPrompt 结构）。
 * 零 pi 依赖。worldState 由调用方传入（REST 侧 RestHost 无 worldState getter，传 undefined
 * 时 currentOutfit 缺省回退 outfits 第一套）。
 *
 * 穿着优先级的现状（2026-08-16 检修后）：
 *   生图穿着的权威源是「在场角色表」的当前穿搭/上装/下装列（剧情引擎每拍维护，中文白描），
 *   而非服装档案的静态 defaultOutfit——后者被误设成「裸体」时会把生图带歪。
 *   为此：draw_generate 允许调用方经 sceneOutfits[name] 传「覆盖穿着 tags」，用于替换档案 outfit
 *   （画师从在场角色表读出穿着后转英文 tag 传入）；worldState.characters[name].outfit 保留账本语义，
 *   仅作第二级回退。defaultOutfit 已在 wardrobe.ts 废弃（不再参与解析），只保留 outfits 清单。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadWardrobe, resolveOutfit } from "../../wardrobe.ts";
import { detectPresentCharactersWithAliases } from "./character-detect.ts";
import { getRoleGroupTags } from "./tag-groups.ts";
import type { CharacterPrompt } from "../../draw/novelai.ts";

export interface ResolvedCharacter {
	name: string;
	/** 组装好的正 tag：appearanceTags + danbooruTag + 当前穿着 outfit.tags + 角色选中组 tags（空格分隔合并，保留 n::tag:: 权重语法） */
	tags: string;
	/** 角色级负面（character.negativeTags，非空才输出；否则 ""） */
	uc: string;
	/** 服装参考图 base64（outfit.referenceImage 存在则读文件转 base64；读失败忽略） */
	referenceImage?: string;
}

export interface ResolveResult {
	characters: ResolvedCharacter[];
	/** 不在服装档案里的角色名 */
	unknown: string[];
}

/** 参考图路径相对 cwd → 绝对路径（绝对路径直接用；/media/、/cache/ 前缀也按 cwd 相对解析） */
function resolveRefAbs(cwd: string, ref: string): string {
	if (isAbsolute(ref)) return ref;
	if (ref.startsWith("/")) return join(cwd, ref.replace(/^\//, ""));
	return join(cwd, ref);
}

/** danbooru 下划线 → NAI 空格分隔（对齐 LWBox danbooruToNai；NAI 对空格 tag 解析更稳） */
function danbooruToNai(tag: string): string {
	return tag.replace(/_/g, " ");
}

/** NAI 形象类型：档案 type 字段（UI 选项 girl/boy/man/woman）；仅匹配英文合法值时进 tag（防老数据中文值如「主角」误伤） */
function naiTypeOf(c: { type?: string }): string {
	const t = (c.type ?? "").trim();
	return /^(girl|boy|woman|man|other)$/i.test(t) ? t.toLowerCase() : "";
}

/**
 * 解析角色特征：
 * - names 里的名字逐一到服装档案（loadWardrobe(cwd, cardPath)）查角色
 * - 当前穿着优先级：sceneOutfits[name]（调用方从「在场角色表」读出的覆盖穿着 tags）
 *     → worldState.characters[name].outfit（账本）→ outfits 第一套（档案 defaultOutfit 已废弃）
 * - sceneOutfits：覆盖穿着优先。画师把在场角色表的当前穿搭/上装/下装转成英文 tag 传入，
 *     生图即按此穿着，摆脱服装档案静态默认（这是「穿着以剧情/在场角色表为准」的入口）。
 * - tag 组装：appearanceTags + danbooruTag（useDanbooruTag!==false 时）+ 穿着 tags(sceneOutfits 或 outfit.tags) + 角色选中组 tags（getRoleGroupTags）
 * - uc：角色 negativeTags（非空才输出）
 * - 参考图读文件转 base64（直接返回 raw base64，底座 buildGenerateBody 会 stripDataPrefix 处理）
 * - unknown：档案里没有的角色名
 */
export function resolveCharacterTags(
	cwd: string,
	cardPath: string,
	names: string[],
	worldState?: { characters?: Record<string, { outfit?: string }> },
	sceneOutfits?: Record<string, string>,
): ResolveResult {
	const wb = loadWardrobe(cwd, cardPath);
	const characters: ResolvedCharacter[] = [];
	const unknown: string[] = [];

	for (const raw of names) {
		const name = (raw ?? "").trim();
		if (!name) continue;
		const { outfit, character } = resolveOutfit(wb, name, worldState?.characters?.[name]?.outfit);
		if (!character) {
			unknown.push(name);
			continue;
		}
		// 穿着主源：sceneOutfits 显式覆盖 > 档案 resolved outfit（defaultOutfit 已废弃）
		const outfitTags = sceneOutfits?.[name]?.trim() || outfit?.tags || "";
		const roleGroupTags = getRoleGroupTags(cwd, name, character.selectedGroupId);
		const parts = [
			character.useDanbooruTag !== false && character.danbooruTag ? danbooruToNai(character.danbooruTag) : "",
			naiTypeOf(character),
			character.appearanceTags,
			outfitTags,
			roleGroupTags,
		]
			.filter(Boolean)
			.join(" ")
			.trim();
		const resolved: ResolvedCharacter = {
			name,
			tags: parts,
			uc: character.negativeTags && character.negativeTags.trim() ? character.negativeTags.trim() : "",
		};
		const ref = outfit?.referenceImage;
		if (ref) {
			try {
				const abs = resolveRefAbs(cwd, ref);
				if (existsSync(abs)) {
					resolved.referenceImage = readFileSync(abs).toString("base64");
				}
			} catch {
				// 读参考图失败：忽略（无参考图照常出图）
			}
		}
		characters.push(resolved);
	}
	return { characters, unknown };
}

/**
 * 在正文中检出在场角色（含别名解析）：从服装档案读 known（name + aliases，hidden 剔除），
 * 对 names（正文）用 detectPresentCharactersWithAliases 检出，返回按正文出现顺序去重的主名。
 * 档案缺失/无 known → []。
 */
export function resolvePresentWithAliases(
	cwd: string,
	cardPath: string,
	names: string,
	_worldState?: { characters?: Record<string, { outfit?: string }> },
): string[] {
	const wb = loadWardrobe(cwd, cardPath);
	const known = wb.characters
		.filter((c) => c.hidden !== true)
		.map((c) => ({ name: c.name, aliases: c.aliases }));
	return detectPresentCharactersWithAliases(names, known);
}

/** 类型再导出：供调用方把 ResolvedCharacter 转 CharacterPrompt（center 由调用方决定） */
export type { CharacterPrompt };

/**
 * 无档案/无名角色的 LLM 完整条目 → ResolvedCharacter（对齐 LWBox：type 进 tag 串，
 * 与 appear/costume/action 拼接——无档案角色照样有独立分栏，不是"不算人"）。
 * name 可空 = 无名配角（type 兜底 boy，与 LWBox「默认无名配角 type=boy」一致）。
 */
export interface UnknownCharacterEntry {
	name?: string;
	type?: string;
	appear?: string;
	costume?: string;
	action?: string;
	interact?: string;
	uc?: string;
}

export function assembleUnknownCharacter(c: UnknownCharacterEntry): ResolvedCharacter {
	const type = (c.type ?? "").trim() || "boy";
	const tags = [type, c.appear, c.costume, c.action, c.interact].filter(Boolean).join(", ").trim();
	return {
		name: (c.name ?? "").trim() || type,
		tags,
		uc: (c.uc ?? "").trim(),
	};
}
