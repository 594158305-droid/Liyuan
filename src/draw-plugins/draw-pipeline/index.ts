/**
 * 插件 B「生图旁路管线」（draw-pipeline，DESIGN-draw §3.2）。
 *
 * 能力：AI 回复完成后（onTurnEnd）自动为消息规划并生成插图，占位符经
 * rp-draft-op 读取时补丁进正文（树上字节不改，显示/送模/压缩自动生效）。
 *
 * 依赖方向：插件 B → 底座（draw/service generateImage）+ 插件 C（slot-store 占位符）
 * + 插件 A（resolver 角色特征）。requires: ["draw-slot", "draw-role"]。
 *
 * 默认 deps 说明：
 * - callPlanner：规划 LLM 走旁路通道——本插件领域层不 import pi/server，
 *   由 host（main.ts）在启动时经 registerPlannerCaller 注入旁路实现（scribe 同款
 *   streamSimple 通道）；未注入时返回错误（不会崩溃）。
 * - generate / resolveChars / registerSlot：直接复用底座与插件 A/C 的领域函数。
 *
 * reroll 联动：state.json 记上次 entryId 与 slots；新 entryId 到来时把旧 slot 标 discarded。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dir, resolveConfigPath } from "../../paths.ts";
import { DEFAULT_CONFIG, type RpConfig } from "../../types.ts";
import { generateImage } from "../../draw/service.ts";
import { loadDrawConfig } from "../../draw/config.ts";
import { createSlot, discardSlot } from "../draw-slot/slot-store.ts";
import { resolveCharacterTags } from "../draw-role/resolver.ts";
import { recordUnknownCharacters } from "../draw-role/learn-candidates.ts";
import { getGlobalSelectedGroupTags, getRoleGroupTags } from "../draw-role/tag-groups.ts";
import { loadWardrobe } from "../../wardrobe.ts";
import type { PluginContext, PluginManifest, PluginToolDef, TurnEndHookInfo } from "../types.ts";
import { runPipeline, type PipelineDeps, type PipelineSettings } from "./pipeline.ts";

/** 插件声明（与 plugin.json 同内容；registry 校验 id 一致性用） */
export const manifest: PluginManifest = {
	id: "draw-pipeline",
	name: "生图旁路管线",
	version: "0.1.0",
	description: "AI 回复完成后自动为消息规划并生成插图（图文并茂）：规划 LLM → 图片计划 YAML → 合规 → 底座生图 → 占位符补丁进正文（rp-draft-op 读取时补丁，树上字节不改）",
	tools: [],
	panels: [],
	skills: [],
	requires: ["draw-slot", "draw-role"],
};

/** 插件工具（无 agent 工具面：管线是后台自动化，不暴露给模型） */
export const tools: PluginToolDef[] = [];

// ---------- 运行时状态 ----------

/** 模块级 cwd / 设置（init 注入） */
let pluginCwd = "";
let pluginSettings: PipelineSettings = {
	auto: true,
	characters: [],
	minIntervalMs: 5000,
	maxImages: 2,
	maxCharactersPerImage: 3,
};

/** reroll 状态文件路径（.liyuan-plugins/draw-pipeline/state.json） */
const stateFile = (cwd: string): string => join(cwd, ".liyuan-plugins", "draw-pipeline", "state.json");

interface PipelineState {
	lastEntryId: string;
	lastSlots: string[];
}

function loadState(cwd: string): PipelineState {
	try {
		const raw = JSON.parse(readFileSync(stateFile(cwd), "utf8")) as Partial<PipelineState>;
		return {
			lastEntryId: typeof raw.lastEntryId === "string" ? raw.lastEntryId : "",
			lastSlots: Array.isArray(raw.lastSlots) ? raw.lastSlots.filter((s): s is string => typeof s === "string") : [],
		};
	} catch {
		return { lastEntryId: "", lastSlots: [] };
	}
}

function saveState(cwd: string, s: PipelineState): void {
	try {
		mkdirSync(join(dirname(stateFile(cwd))), { recursive: true });
	} catch {
		/* ignore */
	}
	try {
		writeFileSync(stateFile(cwd), JSON.stringify(s, null, 2), "utf8");
	} catch {
		/* 状态写失败不阻断管线 */
	}
}

// ---------- 规划 LLM 注入（host 提供旁路实现） ----------

/** 规划 LLM 调用签名（host 注入；与 PipelineDeps.callPlanner 对齐） */
export type PlannerCaller = (
	prompt: { system: string; user: string },
	llm?: { provider?: string; model?: string },
) => Promise<string>;

let plannerCaller: PlannerCaller | null = null;

/** host 启动时注册旁路规划实现（main.ts 用 scribe 同款 streamSimple 通道）；测试可注入 fake */
export function registerPlannerCaller(fn: PlannerCaller | null): void {
	plannerCaller = fn;
}

/** 读注册的规划实现（未注册返回 null） */
export function getPlannerCaller(): PlannerCaller | null {
	return plannerCaller;
}

/** lore 检索调用签名（host 注入；与 PipelineDeps.searchLore 对齐） */
export type LoreSearcher = (query: string, limit?: number) => string;

let loreSearcher: LoreSearcher | null = null;

/** host 启动时注册 lore 检索实现（main.ts 用 loadMergedLore + searchEntries 包装）；测试可注入 fake */
export function registerLoreSearcher(fn: LoreSearcher | null): void {
	loreSearcher = fn;
}

/** 读注册的 lore 检索实现（未注册返回 null） */
export function getLoreSearcher(): LoreSearcher | null {
	return loreSearcher;
}

// ---------- 默认 deps ----------

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

/** 构造默认 deps：callPlanner 用注册的旁路实现；generate/resolveChars/registerSlot 用领域函数 */
export function defaultPipelineDeps(cwd: string): PipelineDeps {
	return {
		callPlanner: async (prompt, llm) => {
			if (!plannerCaller) throw new Error("规划 LLM 未注入（registerPlannerCaller 未调用）");
			return plannerCaller(prompt, llm);
		},
		generate: async (opts) => {
			// 二期自定义标签组：全局选中组（selectedGroupId 语义）的 tags 追加到 scene；
			// 未选全局组时回退全部 enabled 全局组（getGlobalSelectedGroupTags 兜底）
			let prompt = opts.prompt;
			const extra = getGlobalSelectedGroupTags(cwd);
			if (extra) prompt = `${prompt}, ${extra}`;
			const r = await generateImage(cwd, {
				prompt,
				negativePrompt: opts.negativePrompt,
				aspect: opts.aspect,
				providerId: opts.providerId,
			});
			return { src: r.src, slotId: r.slotId };
		},
		resolveChars: (names) => {
			const card = (loadConfig(cwd).card ?? "").trim();
			if (!card) return names.map(() => ({ tags: "" }));
			const r = resolveCharacterTags(cwd, card, names, undefined);
			// 二期：检出的不在档案里的角色 → 记入学习候选（learned/ignored 不覆盖）
			if (r.unknown.length > 0) {
				try {
					recordUnknownCharacters(cwd, r.unknown);
				} catch {
					// 记录失败不阻断生图
				}
			}
			// 角色选中组 tags（任务 4 语义：characterId===name 的组中 id===selectedGroupId）
			let wb;
			try {
				wb = loadWardrobe(cwd, card);
			} catch {
				wb = null;
			}
			return names.map((n) => {
				const c = r.characters.find((x) => x.name === n);
				const role = wb?.characters.find((x) => x.name === n);
				return {
					tags: c?.tags ?? "",
					uc: c?.uc ?? "",
					referenceImage: c?.referenceImage,
					groupTags: role?.selectedGroupId ? getRoleGroupTags(cwd, n, role.selectedGroupId) : "",
				};
			});
		},
		registerSlot: (slotId, file, tags) => {
			createSlot(cwd, {
				slotId,
				chatId: "",
				messageId: "",
				file,
				...(tags
					? {
							params: {
								...(tags.scene ? { scene: tags.scene, positive: tags.scene } : {}),
								...(tags.characterPrompts ? { characterPrompts: tags.characterPrompts } : {}),
							},
							...(tags.failed ? { failed: tags.failed } : {}),
						}
					: {}),
			});
		},
		// lore 检索：用注册的 host 实现（loadMergedLore + searchEntries）；未注册 → 返回 ""（不报错）
		searchLore: (query, limit) => {
			if (!loreSearcher) return "";
			try {
				return loreSearcher(query, limit);
			} catch {
				return "";
			}
		},
		// 动态分辨率：读 liyuan.draw.json 顶层 aspects（归一化后永远完整三档，缺省回退默认表）
		getAspects: () => loadDrawConfig(cwd).aspects,
	};
}

// ---------- 初始化 ----------

/** init：读 settings（auto 默认 true / characters / minIntervalMs / maxImages / maxCharactersPerImage / llm） */
export function init(ctx: PluginContext): void {
	pluginCwd = ctx.cwd;
	const s = ctx.settings ?? {};
	pluginSettings = {
		auto: s.auto !== false, // 默认 true（插件启用后）
		characters: Array.isArray(s.characters) ? s.characters.filter((x): x is string => typeof x === "string") : [],
		minIntervalMs: typeof s.minIntervalMs === "number" && s.minIntervalMs >= 0 ? s.minIntervalMs : 5000,
		maxImages: typeof s.maxImages === "number" && s.maxImages >= 1 ? Math.round(s.maxImages) : 2,
		maxCharactersPerImage:
			typeof s.maxCharactersPerImage === "number" && s.maxCharactersPerImage >= 1
				? Math.round(s.maxCharactersPerImage)
				: 3,
		...(s.llm && typeof s.llm === "object"
			? {
					llm: {
						...(typeof (s.llm as Record<string, unknown>).provider === "string"
							? { provider: (s.llm as Record<string, unknown>).provider as string }
							: {}),
						...(typeof (s.llm as Record<string, unknown>).model === "string"
							? { model: (s.llm as Record<string, unknown>).model as string }
							: {}),
					},
				}
			: {}),
	};
	ctx.log(`draw-pipeline 就绪（auto=${pluginSettings.auto}，characters=[${pluginSettings.characters.join(",")}]）`);
}

// ---------- 回合结束钩子 ----------

/**
 * onTurnEnd：auto=false 直接返回；否则跑管线并把 patches 经 info.appendPatch 写会话树。
 * reroll 联动：新 entryId 到来时把上次的旧 slot 标 discarded。
 */
export const hooks: { onTurnEnd: (info: TurnEndHookInfo) => Promise<void> } = {
	async onTurnEnd(info) {
		const cwd = pluginCwd;
		if (!cwd || !info.entryId) return;
		if (!pluginSettings.auto) return;
		if (info.aborted) return;

		// reroll 联动：新 entryId ≠ 上次 → 旧 slot 标 discarded
		const st = loadState(cwd);
		if (st.lastEntryId && st.lastEntryId !== info.entryId) {
			for (const slotId of st.lastSlots) {
				try {
					discardSlot(cwd, slotId);
				} catch {
					// 忽略单 slot 失败
				}
			}
		}

		const text = info.text ?? "";
		if (!text.trim()) return;
		const deps = defaultPipelineDeps(cwd);
		const result = await runPipeline(cwd, {
			entryId: info.entryId,
			chatId: info.chatId ?? "",
			messageText: text,
			historyText: info.historyText ?? "",
			summaryText: info.summaryText ?? "",
			settings: pluginSettings,
			deps,
		});
		if (!result.ran) {
			if (result.reason) console.log(`[draw-pipeline] 跳过：${result.reason}`);
			return;
		}
		if (result.warnings.length > 0) {
			for (const w of result.warnings) console.log(`[draw-pipeline] ${w}`);
		}
		// 执行补丁（host 注入 appendPatch）；成功后更新 reroll 状态
		let applied = false;
		if (info.appendPatch) {
			for (const patch of result.patches) {
				const r = info.appendPatch(patch);
				if (r.ok) applied = true;
			}
		}
		if (applied) {
			saveState(cwd, { lastEntryId: info.entryId, lastSlots: result.slots.map((s) => s.slotId) });
		}
	},
};
