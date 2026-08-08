/**
 * 插件 A「角色管理」（draw-role）一期完整化。
 *
 * 工具：wardrobe_list / wardrobe_update（服装档案）+ tag_search（D 标签离线库）。
 * 能力：tagdb（Danbooru 角色库）、character-detect（在场检出）、resolver（角色特征解析）。
 * 插件属领域层：零 pi / 零 server import；工具经接线层按 config.plugins.draw-role.enabled 注册。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveConfigPath } from "../../paths.ts";
import { DEFAULT_CONFIG, type RpConfig } from "../../types.ts";
import { Type } from "typebox";

import {
	addOutfit,
	loadWardrobe,
	newOutfitId,
	removeCharacter,
	removeOutfit,
	saveWardrobe,
	setAppearanceTags,
	setDefaultOutfit,
	updateOutfit,
	upsertCharacter,
	type Outfit as WardrobeOutfit,
} from "../../wardrobe.ts";
import type { PluginContext, PluginManifest, PluginToolDef, PluginToolResult } from "../types.ts";
import { searchCharacters } from "./tagdb.ts";

export * from "./tagdb.ts";
export * from "./character-detect.ts";
export * from "./resolver.ts";
export * from "./learn-candidates.ts";
export * from "./tag-groups.ts";

/** 插件声明（与 plugin.json 同内容；registry 校验 id 一致性用） */
export const manifest: PluginManifest = {
	id: "draw-role",
	name: "角色管理",
	version: "0.1.0",
	description: "服装档案、D 标签库、角色特征解析（一期：服装档案工具 + tag_search；特征解析/在场检出接口已就绪）",
	tools: ["wardrobe_list", "wardrobe_update", "tag_search"],
	panels: ["DrawRolePanel"],
	skills: [],
	requires: [],
};

/** 模块级 cwd：init 时注入（execute 只收模型参数，此处补运行上下文） */
let pluginCwd = "";

/** 一期无实际初始化，仅收下运行时上下文（cwd 供工具读配置/档案） */
export function init(ctx: PluginContext): void {
	pluginCwd = ctx.cwd;
}

/** 领域层读项目配置（与 rest.ts loadConfig 同源：resolveConfigPath + DEFAULT_CONFIG 兜底） */
function loadConfig(cwd: string): RpConfig {
	const p = resolveConfigPath(cwd);
	if (!existsSync(p)) return { ...DEFAULT_CONFIG };
	try {
		return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<RpConfig>) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** 文本结果（与 assistant 侧 text() 同形） */
const text = (t: string, isError = false): PluginToolResult => ({
	content: [{ type: "text" as const, text: t }],
	...(isError ? { isError: true } : {}),
});

/** 当前卡路径（缺省用 config.card；与 rest.ts GET /api/wardrobe 同源） */
const currentCard = (): string => {
	try {
		return (loadConfig(pluginCwd).card ?? "").trim();
	} catch {
		return "";
	}
};

/** 插件工具定义（纯函数，不碰 pi） */
export const tools: PluginToolDef[] = [
	{
		name: "wardrobe_list",
		label: "查看服装档案",
		description:
			"读当前（或指定）角色卡的服装档案：每角色的外观 tag、服装清单（id/name/tags/是否有参考图）。组装生图 prompt 时先查这里。",
		parameters: Type.Object({
			card: Type.Optional(Type.String({ description: "角色卡路径（相对 cwd），缺省用当前卡" })),
		}),
		async execute(params) {
			const card = (params.card ?? "").toString().trim() || currentCard();
			if (!card) return text("缺少 card（当前未配置角色卡）", true);
			const wb = loadWardrobe(pluginCwd, card);
			if (wb.characters.length === 0) {
				return text("该卡暂无服装档案");
			}
			const lines: string[] = [`服装档案（卡：${card}）`];
			for (const c of wb.characters) {
				lines.push(`\n【${c.name}】`);
				lines.push(`外观 tag：${c.appearanceTags || "（无）"}`);
				lines.push(`默认穿着：${c.defaultOutfit ?? "（未设）"}`);
				if (c.outfits.length === 0) {
					lines.push("服装：无");
					continue;
				}
				lines.push("服装：");
				for (const o of c.outfits) {
					lines.push(
						`- ${o.id}「${o.name}」${o.tags ? ` tag=${o.tags}` : ""}${o.referenceImage ? "（有参考图）" : ""}${o.notes ? ` note=${o.notes}` : ""}`,
					);
				}
			}
			lines.push("\n（当前穿着需经面板设置——本工具不读账本）");
			return text(lines.join("\n"));
		},
	},
	{
		name: "wardrobe_update",
		label: "维护服装档案",
		description:
			"维护角色卡服装档案（不改剧情正文）：upsert 建角色 / remove 删角色 / setAppearance 设外观 tag / addOutfit 加服装 / updateOutfit 改服装 / removeOutfit 删服装 / setDefault 设默认穿着。当前穿着写账本走 POST /api/wardrobe/current（面板/接口），本工具不写账本。",
		parameters: Type.Object({
			card: Type.Optional(Type.String({ description: "角色卡路径（相对 cwd），缺省用当前卡" })),
			character: Type.String({ description: "角色名" }),
			action: Type.Union([
				Type.Literal("upsert"),
				Type.Literal("remove"),
				Type.Literal("setAppearance"),
				Type.Literal("addOutfit"),
				Type.Literal("updateOutfit"),
				Type.Literal("removeOutfit"),
				Type.Literal("setDefault"),
			]),
			outfit: Type.Optional(
				Type.Object({
					id: Type.Optional(Type.String({ description: "服装 id（addOutfit 缺省自动生成）" })),
					name: Type.Optional(Type.String({ description: "服装名" })),
					tags: Type.Optional(Type.String({ description: "NovelAI tag 串" })),
					referenceImage: Type.Optional(Type.String({ description: "参考图相对路径" })),
					notes: Type.Optional(Type.String({ description: "备注" })),
				}),
			),
			outfitId: Type.Optional(Type.String({ description: "服装 id（removeOutfit/setDefault 用）" })),
			appearanceTags: Type.Optional(Type.String({ description: "外观 tag（setAppearance 用）" })),
		}),
		async execute(params) {
			const card = (params.card ?? "").toString().trim() || currentCard();
			if (!card) return text("缺少 card（当前未配置角色卡）", true);
			const name = (params.character ?? "").toString().trim();
			if (!name) return text("缺少 character", true);
			let wb = loadWardrobe(pluginCwd, card);
			switch (params.action) {
				case "upsert":
					wb = upsertCharacter(wb, name);
					break;
				case "remove":
					wb = removeCharacter(wb, name);
					break;
				case "setAppearance":
					wb = setAppearanceTags(upsertCharacter(wb, name), name, (params.appearanceTags ?? "").toString());
					break;
				case "addOutfit": {
					const o = params.outfit as Record<string, unknown> | undefined;
					if (!o || !(o.name ?? "").toString().trim()) return text("addOutfit 需要 outfit.name", true);
					wb = addOutfit(upsertCharacter(wb, name), name, {
						id: (o.id ?? "").toString().trim() || newOutfitId(),
						name: (o.name ?? "").toString(),
						tags: (o.tags ?? "").toString(),
						...(o.referenceImage ? { referenceImage: (o.referenceImage as string).toString() } : {}),
						...(o.notes ? { notes: (o.notes as string).toString() } : {}),
					});
					break;
				}
				case "updateOutfit": {
					const o = params.outfit as Record<string, unknown> | undefined;
					if (!o || !(o.id ?? "").toString().trim()) return text("updateOutfit 需要 outfit.id", true);
					// 以现有服装为底，仅覆盖显式传来的字段
					const id = (o.id as string).toString();
					const cur =
						wb.characters.find((c) => c.name === name)?.outfits.find((x) => x.id === id) ??
						({ id, name: "", tags: "" } as WardrobeOutfit);
					const next: WardrobeOutfit = {
						...cur,
						id,
						...(o.name !== undefined ? { name: (o.name as string).toString() } : {}),
						...(o.tags !== undefined ? { tags: (o.tags as string).toString() } : {}),
						...(o.referenceImage !== undefined ? { referenceImage: (o.referenceImage as string).toString() } : {}),
						...(o.notes !== undefined ? { notes: (o.notes as string).toString() } : {}),
					};
					wb = updateOutfit(wb, name, next);
					break;
				}
				case "removeOutfit": {
					if (!(params.outfitId ?? "").toString().trim()) return text("removeOutfit 需要 outfitId", true);
					wb = removeOutfit(wb, name, (params.outfitId as string).toString());
					break;
				}
				case "setDefault": {
					if (!(params.outfitId ?? "").toString().trim()) return text("setDefault 需要 outfitId", true);
					wb = setDefaultOutfit(upsertCharacter(wb, name), name, (params.outfitId as string).toString());
					break;
				}
				default:
					return text(`无效 action：${String(params.action)}`, true);
			}
			saveWardrobe(pluginCwd, wb);
			return text(`已更新服装档案：${name}（action=${params.action}）`);
		},
	},
	{
		name: "tag_search",
		label: "搜索 Danbooru 角色标签",
		description:
			"按名字搜索 Danbooru 角色库（7000+ 角色，danbooru 下划线格式），返回角色的外貌 tag 列表，用于组装生图提示词中的角色特征。query 传角色名（支持中英文/模糊）。",
		parameters: Type.Object({
			query: Type.String({ description: "角色名（danbooru 名或关键词）" }),
			limit: Type.Optional(Type.Number({ description: "返回条数上限，默认 20" })),
		}),
		async execute(params) {
			const query = (params.query ?? "").toString().trim();
			const limit = typeof params.limit === "number" ? Math.max(1, Math.min(50, Math.round(params.limit))) : 20;
			if (!query) return text("缺少 query", true);
			const hits = searchCharacters(query, limit);
			if (hits.length === 0) return text("未找到，可尝试其他拼写");
			const lines = hits.map((h) => {
				const shown = h.tags.slice(0, 30).join(", ");
				const suffix = h.tags.length > 30 ? "…" : "";
				return `- ${h.name}：${shown}${suffix}`;
			});
			return text(lines.join("\n"));
		},
	},
];
