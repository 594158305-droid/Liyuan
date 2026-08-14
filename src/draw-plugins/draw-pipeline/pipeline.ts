/**
 * 管线编排（插件 B draw-pipeline，DESIGN-draw §3.2 核心）。
 *
 * 流程：同 entryId 去重 → minIntervalMs 限频 → 角色白名单 → lore 检索（经注入）
 * → 角色档案摘要 → buildPlannerPrompt → callPlanner（失败自动重试一次）
 * → parseImagePlan → enforceLimits → 逐 task：resolveChars + generate + registerSlot
 * → buildInsertPatch 生成补丁（多图合并）→ 返回 slots + patches。
 *
 * 纯函数 + 依赖注入：不碰 pi / server；默认实现经 index.ts 的 deps 注入。
 */

import { buildInsertPatch } from "./anchor.ts";
import { buildPlannerPrompt } from "./planner.ts";
import { enforceLimits, parseImagePlan, type ImagePlan } from "./scene-plan.ts";
import { createPlaceholder } from "../draw-slot/slot-store.ts";
import { classifyError } from "../../draw/errors.ts";
import { DEFAULT_DRAW_ASPECTS, type DrawAspects } from "../../draw/config.ts";
import { gridToCenter } from "../../draw/novelai.ts";
import { assembleUnknownCharacter } from "../draw-role/resolver.ts";
import { randomUUID } from "node:crypto";

export interface PipelineSettings {
	/** 默认 true（插件启用后） */
	auto: boolean;
	/** 角色白名单（空 = 不限） */
	characters: string[];
	/** reroll 连续触发最小间隔，默认 5000ms */
	minIntervalMs: number;
	maxImages: number;
	maxCharactersPerImage: number;
	llm?: { provider?: string; model?: string };
}

export interface PipelineDeps {
	/** 规划 LLM 调用（默认实现走 scribe 同款旁路通道；测试注入 fake） */
	callPlanner: (prompt: { system: string; user: string }, llm?: { provider?: string; model?: string }) => Promise<string>;
	/** 生图（默认实现：底座 generateImage；测试注入 fake） */
	generate: (opts: {
		prompt: string;
		negativePrompt?: string;
		aspect: "portrait" | "landscape" | "square";
		providerId?: string;
		/** 角色分栏（V4 分栏出图：每角色独立 char_caption + center 坐标；缺省无分栏） */
		characterPrompts?: { name: string; prompt: string; uc?: string; center?: { x: number; y: number } }[];
	}) => Promise<{ src: string; slotId: string }>;
	/** 角色特征解析（默认实现：draw-role resolver.resolveCharacterTags；测试注入 fake） */
	resolveChars: (names: string[]) => { tags: string; uc?: string; referenceImage?: string; groupTags?: string }[];
	/** 占位符落库（默认实现：draw-slot slot-store.createSlot）；tags 为结构化分栏（scene/characterPrompts）；failed 记录生成失败（无文件） */
	registerSlot: (
		slotId: string,
		file: string,
		tags?: {
			scene: string;
			characterPrompts?: { name: string; prompt: string; uc?: string; center?: { x: number; y: number } }[];
			failed?: { code?: string; reason: string };
		},
	) => void;
	/** lore 检索（选填；不可用/失败时 loreText=""；host 注入真实实现） */
	searchLore?: (query: string, limit?: number) => string;
	/** 三档构图分辨率（选填；缺省回退默认表——默认实现读 liyuan.draw.json 顶层 aspects） */
	getAspects?: () => DrawAspects;
}

export interface PipelineResult {
	ran: boolean;
	reason?: string;
	slots: { slotId: string; src: string; index: number }[];
	warnings: string[];
	/** rp-draft-op 补丁（host 侧 applyDraftOp 执行；本模块不碰 pi） */
	patches: Record<string, unknown>[];
}

export interface RunPipelineOpts {
	entryId: string;
	chatId: string;
	messageText: string;
	/** 最近 1 条 user 消息（兼容旧字段） */
	contextText?: string;
	/** 最近 N 条前文拼接（更早的前文；在 contextText 之前注入提示词） */
	historyText?: string;
	/** 压缩摘要（rp-summary 内容；注入「前情提要」段） */
	summaryText?: string;
	/** 用户指定锚点（正文短原文片段）：第一张图的插入位置用它（LWB 原始设计——
	 *  手动/配图按钮指定位置时覆盖 LLM 规划的第一个 anchor；缺省 = 全按 LLM 规划） */
	userAnchor?: string;
	settings: PipelineSettings;
	deps: PipelineDeps;
}

/** 已处理/处理中的 entryId 记录（模块级 Map，turn 结束后由 host 清） */
const processedEntries = new Set<string>();
/** 最近一次管线运行时间（minIntervalMs 限频） */
let lastRunAt = 0;

/** 登记 entryId 已处理（供测试/外部清理） */
export function markEntryProcessed(entryId: string): void {
	processedEntries.add(entryId);
}

/** 清空去重记录（host 在 turn 结束后调用，避免无限增长） */
export function resetPipelineDedupe(): void {
	processedEntries.clear();
}

/** 记录最近运行时间（测试可注入重置） */
export function resetPipelineTimer(): void {
	lastRunAt = 0;
}

/** 在场角色检出（复用 draw-role 实现；白名单为空时跳过） */
function detectWhitelistHit(text: string, whitelist: string[]): string[] {
	if (whitelist.length === 0) return [];
	// 简单子串检出（不引 character-detect 的长名阶梯——管线场景白名单通常是全名，直接 indexOf）
	const lower = text.toLowerCase();
	return whitelist.filter((n) => n.trim() && lower.includes(n.trim().toLowerCase()));
}

/**
 * 跑一次管线。任何非致命失败都返回 ran=true + warnings（尽量出图）；
 * 致命失败（无文本/未启用旋钮）返回 ran=false + reason。
 */
export async function runPipeline(cwd: string, opts: RunPipelineOpts): Promise<PipelineResult> {
	const { entryId, chatId, messageText, settings, deps } = opts;
	const warnings: string[] = [];

	// 旋钮：auto=false → 不跑（手动触发另走 /run 路由）
	if (!settings.auto) {
		return { ran: false, reason: "auto 关闭（可经手动旋钮触发）", slots: [], warnings: [], patches: [] };
	}
	if (!messageText || !messageText.trim()) {
		return { ran: false, reason: "正文为空", slots: [], warnings: [], patches: [] };
	}
	// 同 entryId 去重
	if (processedEntries.has(entryId)) {
		return { ran: false, reason: "entryId 已处理（去重）", slots: [], warnings: [], patches: [] };
	}
	processedEntries.add(entryId);
	// minIntervalMs 限频（毫秒）
	const now = Date.now();
	if (lastRunAt > 0 && now - lastRunAt < (settings.minIntervalMs ?? 5000)) {
		return { ran: false, reason: "距上次触发过近（限频）", slots: [], warnings: [], patches: [] };
	}
	lastRunAt = now;

	// 角色白名单：有白名单但正文无命中 → 跳过
	if (settings.characters.length > 0) {
		const hits = detectWhitelistHit(messageText, settings.characters);
		if (hits.length === 0) {
			return { ran: false, reason: "角色白名单未命中", slots: [], warnings: [], patches: [] };
		}
		warnings.push(`白名单命中角色：${hits.join("、")}`);
	}

	// lore 检索（可选；失败/不可用 → ""）
	// query：正文前 100 字符 + 白名单角色名拼接（正文关键词优先，角色名补充）
	let loreText = "";
	if (deps.searchLore) {
		try {
			const queryParts = [messageText.slice(0, 100).replace(/\s+/g, " ").trim()];
			if (settings.characters.length > 0) queryParts.push(...settings.characters);
			const query = queryParts.filter(Boolean).join(" ");
			const raw = deps.searchLore(query, 3) ?? "";
			// 每条约 200 字符截断
			loreText = raw
				.split("\n\n")
				.map((s) => (s.length > 200 ? `${s.slice(0, 200)}…` : s))
				.join("\n\n");
		} catch {
			loreText = "";
		}
	}

	// 角色档案摘要：白名单命中或正文检出（用 whitelist 优先，否则空白名单下由规划模型在正文里自己识别——
	// 一期不做复杂在场检出，直接给 whitelist 的档案；空白名单则跳过角色摘要）
	let characterNotes = "";
	if (settings.characters.length > 0) {
		try {
			const resolved = deps.resolveChars(settings.characters);
			characterNotes = resolved
				.map((c, i) => `${settings.characters[i]}：${c.tags || "（无 tag）"}${c.referenceImage ? "（有参考图）" : ""}`)
				.join("\n");
		} catch {
			characterNotes = "";
		}
	}

	const prompt = buildPlannerPrompt({
		messageText,
		contextText: opts.contextText ?? "",
		historyText: opts.historyText ?? "",
		summaryText: opts.summaryText ?? "",
		skillText: null, // skill 读取在 index.ts deps 里注入（本模块零文件依赖）
		loreText,
		characterNotes,
		aspects: deps.getAspects?.() ?? DEFAULT_DRAW_ASPECTS,
		maxImages: settings.maxImages ?? 2,
		maxCharactersPerImage: settings.maxCharactersPerImage ?? 3,
	});

	// 规划 LLM 调用：失败自动带 CRITICAL OUTPUT RULE 重试一次
	let plannerText = "";
	try {
		plannerText = await deps.callPlanner(prompt, settings.llm);
	} catch (e) {
		warnings.push(`规划调用失败，带规则重试一次：${e instanceof Error ? e.message : String(e)}`);
		const retryPrompt = {
			system: `${prompt.system}\n\nCRITICAL OUTPUT RULE: 你上次的输出没有成功解析。严格只输出一个 <image_gen> YAML 块，不要输出任何其它内容。`,
			user: prompt.user,
		};
		try {
			plannerText = await deps.callPlanner(retryPrompt, settings.llm);
		} catch (e2) {
			return {
				ran: true,
				reason: `规划 LLM 两次调用均失败：${e2 instanceof Error ? e2.message : String(e2)}`,
				slots: [],
				warnings,
				patches: [],
			};
		}
	}
	if (!plannerText || !plannerText.trim()) {
		return { ran: true, reason: "规划 LLM 返回空", slots: [], warnings, patches: [] };
	}

	// 解析 + 合规
	let plan: ImagePlan;
	try {
		plan = parseImagePlan(plannerText);
	} catch (e) {
		return {
			ran: true,
			reason: `图片计划解析失败：${e instanceof Error ? e.message : String(e)}`,
			slots: [],
			warnings,
			patches: [],
		};
	}
	plan = enforceLimits(plan, {
		maxImages: settings.maxImages ?? 2,
		maxCharactersPerImage: settings.maxCharactersPerImage ?? 3,
	});
	warnings.push(...plan.warnings);
	if (plan.tasks.length === 0) {
		return { ran: true, reason: "计划无有效任务", slots: [], warnings, patches: [] };
	}

	// 逐 task：resolveChars + generate + registerSlot（顺序执行，防并发烧额度）
	const slots: { slotId: string; src: string; index: number }[] = [];
	for (const task of plan.tasks) {
		try {
			// 角色 tag 组装：档案命中 → 档案 tags（appearance+outfit）+ groupTags + action；
			// 档案未命中/无名 → assembleUnknownCharacter 用 LLM 条目（type/appear/costume/action）组装——不再静默丢人；
			// center：A1~E5 网格 → 归一化坐标（分栏出图 use_coords 生效）
			// V4 语义：角色特征只走 char_captions 分栏，base_caption（scene）不再拼接角色 tag（防重复）
			let promptText = task.scene;
			const characterPrompts: { name: string; prompt: string; uc?: string; center?: { x: number; y: number } }[] = [];
			let negativePrompt = task.negative;
			if (task.characters.length > 0) {
				const resolved = deps.resolveChars(task.characters.map((c) => c.name ?? ""));
				for (const [i, c] of task.characters.entries()) {
					const arch = resolved[i];
					const base = arch?.tags ?? "";
					const full = base
						? [base, arch?.groupTags ?? "", c.action ?? "", c.interact ?? ""].filter(Boolean).join(", ")
						: assembleUnknownCharacter({
								name: c.name || undefined,
								type: c.type,
								appear: c.appear,
								costume: c.costume,
								action: c.action,
								interact: c.interact,
								uc: c.uc,
							}).tags;
					if (!full.trim()) continue; // 无任何特征可画 → 不进分栏
					const center = c.center && /^[A-Ea-e][1-5]$/.test(c.center.trim()) ? gridToCenter(c.center.trim()) : undefined;
					characterPrompts.push({
						name: c.name ?? "路人",
						prompt: full,
						...(c.uc ? { uc: c.uc } : {}),
						...(center ? { center } : {}),
					});
				}
				// 角色级负面：task.negative + 各角色 uc（逗号连接，去重）
				const ucParts = resolved.map((r) => (r.uc && r.uc.trim() ? r.uc.trim() : "")).filter(Boolean);
				const negParts = [...(task.negative && task.negative.trim() ? [task.negative.trim()] : []), ...ucParts];
				negativePrompt = [...new Set(negParts)].join(", ");
			}
			const r = await deps.generate({
				prompt: promptText,
				negativePrompt,
				aspect: task.aspect,
				...(characterPrompts.length > 0 ? { characterPrompts } : {}),
			});
			deps.registerSlot(r.slotId, r.src, {
				scene: task.scene,
				...(characterPrompts.length > 0
					? { characterPrompts: characterPrompts.map((cp) => ({ name: cp.name, prompt: cp.prompt, ...(cp.center ? { center: cp.center } : {}) })) }
					: {}),
			});
			slots.push({ slotId: r.slotId, src: r.src, index: task.index });
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			const code = classifyError(e).code;
			warnings.push(`任务 ${task.index} 生图失败：${reason}`);
			// 失败落 failed slot：占位符插入正文（前端显示失败态），文件为空串
			const failedSlotId = randomUUID();
			try {
				deps.registerSlot(failedSlotId, "", {
					scene: task.scene,
					failed: { code, reason },
				});
			} catch {
				// 失败落库异常不阻断（warnings 已记录原因）
			}
			slots.push({ slotId: failedSlotId, src: "", index: task.index });
		}
	}
	if (slots.length === 0) {
		return { ran: true, reason: "全部生图任务失败", slots, warnings, patches: [] };
	}

	// 生成补丁：多图时把占位符按 index 排序。
	// - 有 anchor 的任务：逐任务在各自锚点插一个 replace 补丁（锚点重复时只插一次，防重复命中）；
	// - 无 anchor 的任务：全部占位符拼成一个 append 补丁插到消息末尾。
	// 补丁按 index 顺序排列，host 侧 applyDraftOps 顺序应用。
	const ordered = slots.slice().sort((a, b) => a.index - b.index);
	const patches: Record<string, unknown>[] = [];
	const anchored: { index: number; slotId: string; src: string; anchor: string }[] = [];
	const tailPlaceholders: string[] = [];

	// 第一张图的插入位置：用户锚点优先（配图按钮/REST 指定；LWB 原始设计——
	// 短原文 anchor + 四重定位保底，挂接正文任意位置）；其余仍按 LLM 规划的 anchor
	let firstPlaced = false;
	for (const task of plan.tasks) {
		const slot = ordered.find((s) => s.index === task.index);
		if (!slot) continue;
		const anchorFor =
			!firstPlaced && opts.userAnchor && opts.userAnchor.trim() ? opts.userAnchor.trim() : task.anchor;
		firstPlaced = true;
		if (anchorFor && anchorFor.trim()) {
			// 同一 anchor 只插一次（多图共享锚点：把占位符合并进同一补丁）
			const anchor = anchorFor.trim();
			const exist = anchored.find((a) => a.anchor === anchor);
			if (exist) {
				// 追加占位符到该锚点补丁的 new 尾部（实现上在下方统一重建）
				anchored.splice(anchored.indexOf(exist), 1);
				anchored.push({
					index: exist.index,
					slotId: `${exist.slotId} ${createPlaceholder(slot.slotId)}`,
					src: exist.src,
					anchor: exist.anchor,
				});
			} else {
				anchored.push({ index: task.index, slotId: createPlaceholder(slot.slotId), src: slot.src, anchor });
			}
		} else {
			tailPlaceholders.push(createPlaceholder(slot.slotId));
		}
	}

	// 逐个锚点补丁
	for (const a of anchored.sort((x, y) => x.index - y.index)) {
		const r = buildInsertPatch(messageText, a.anchor, a.slotId);
		if (!r.ok) {
			warnings.push(`锚点「${a.anchor.slice(0, 20)}…」定位失败：${r.reason}（该图占位符并入末尾）`);
			tailPlaceholders.push(a.slotId);
			continue;
		}
		patches.push(r.patch);
	}
	// 末尾 append 补丁
	if (tailPlaceholders.length > 0) {
		patches.push({ append: tailPlaceholders.join("\n\n") });
	}
	if (patches.length === 0) {
		return { ran: true, reason: "补丁生成失败", slots, warnings, patches: [] };
	}
	return { ran: true, slots, warnings, patches };
}
