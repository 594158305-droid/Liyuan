/**
 * AI 微调（插件 D 二期，迁移 LWB prompt-refine 思路）：
 * 对已生成图的 prompt 拆解出场景描述 → 构造「优化画面描述」对话 → 从 LLM 输出提取 [场景]。
 *
 * 纯函数、零依赖（领域层：不 import server / pi）。管线 LLM 调用经 draw-pipeline 的
 * getPlannerCaller() 注入（见 rest.ts /api/draw/refine 路由）。
 */

/** 已知质量/风格前缀 tag（比较前先剥权重包裹；命中头部连续段即剥离） */
const QUALITY_PREFIX_TAGS = new Set([
	"best quality",
	"amazing quality",
	"masterpiece",
	"highres",
	"incredibly absurdres",
	"absurdres",
	"ultra-detailed",
	"highly detailed",
	"very aesthetic",
	"aesthetic",
	"perfect anatomy",
	"perfect composition",
	"perfect lighting",
	"sharp focus",
	"intricate details",
	"photorealistic",
	"hyper-detailed",
	"beautiful lighting",
]);

/** 角色数量/主体标识 tag（出现即视为角色段开头，剥离该 token） */
const CHARACTER_COUNT_RE = /^(\d+\s*(girls?|boys?|male|female|person|people|others)|solo)$/i;

/**
 * 剥权重包裹：`n::tag::` / `(tag:1.2)` → 裸 tag（仅用于匹配；输出保留原文 token）。
 */
function bareTag(t: string): string {
	let s = t.trim();
	s = s.replace(/^\d+(\.\d+)?::/, "").replace(/::$/, "");
	const paren = /^\((.+)\)$/.exec(s);
	if (paren) s = paren[1].replace(/:\s*[\d.]+$/, "");
	return s.trim().toLowerCase();
}

/**
 * 拆出场景描述（简单版，按已知分隔启发式）：
 * 1. 按逗号切 token；
 * 2. 剥掉头部连续的质量前缀 tag（已知清单）；
 * 3. 剥掉头部第一个角色数量/主体标识 tag（`1girl`/`solo` 等）。
 * 剩余拼回 scene。若角色外观 tag 与场景混在一起无法进一步细分（一期不做
 * 角色解析器依赖），由微调提示词「不改变角色特征」约束兜底。
 */
export function decomposePrompt(prompt: string): { scene: string } {
	const tokens = prompt.split(",").map((t) => t.trim()).filter(Boolean);
	const out: string[] = [];
	for (const t of tokens) {
		if (out.length === 0) {
			const b = bareTag(t);
			if (QUALITY_PREFIX_TAGS.has(b)) continue; // 质量前缀：只剥头部连续段
			if (CHARACTER_COUNT_RE.test(b)) continue; // 角色数量 tag：只剥头部第一个
		}
		out.push(t);
	}
	return { scene: out.join(", ") };
}

/** 五段分解输入（编辑 TAG 分栏 tags 结构） */
export interface DecomposeTagsInput {
	scene?: string;
	characterPrompts?: { name: string; prompt: string }[];
	positive?: string;
	negative?: string;
	/** 画幅模式（缺省 "portrait"） */
	mode?: string;
}

/** 五段分解结果（AI 微调弹窗预览用） */
export interface DecomposeTagsResult {
	mode: string;
	qualityPrefix: string;
	scene: string;
	characters: string[];
	negative: string;
}

/**
 * 把编辑 TAG 分栏的 tags 拆成五段（模式/质量前缀/场景/角色/负面）：
 * - mode：tags.mode（缺省 "portrait"）
 * - qualityPrefix：tags.positive 非空则用之；否则从 scene 头部剥离已知质量词（复用 QUALITY_PREFIX_TAGS）
 * - scene：剥离质量前缀后的场景（positive 已给时不改动）
 * - characters：characterPrompts.map(p => p.prompt)
 * - negative：tags.negative 或 ""
 */
export function decomposeTags(tags: DecomposeTagsInput): DecomposeTagsResult {
	const positive = typeof tags.positive === "string" ? tags.positive.trim() : "";
	let scene = typeof tags.scene === "string" ? tags.scene.trim() : "";
	let qualityPrefix = positive;
	if (!qualityPrefix && scene) {
		const tokens = scene.split(",").map((t) => t.trim()).filter(Boolean);
		// 剥离头部连续的质量前缀（复用 QUALITY_PREFIX_TAGS）
		let i = 0;
		while (i < tokens.length && QUALITY_PREFIX_TAGS.has(bareTag(tokens[i]))) i++;
		if (i > 0) {
			qualityPrefix = tokens.slice(0, i).join(", ");
			scene = tokens.slice(i).join(", ");
		}
	}
	return {
		mode: typeof tags.mode === "string" && tags.mode ? tags.mode : "portrait",
		qualityPrefix,
		scene,
		characters: Array.isArray(tags.characterPrompts)
			? tags.characterPrompts.map((p) => p.prompt).filter((p) => typeof p === "string" && p.trim() !== "")
			: [],
		negative: typeof tags.negative === "string" ? tags.negative : "",
	};
}

/**
 * 构造微调对话（迁移 LWB buildRefineMessages 思路）：
 * 以「优化画面描述」为目标——细化构图/光线/氛围/环境；硬性保留主体、
 * 不得增加/删减/改变角色特征；要求只输出 `[场景]` 一行。
 * instruction 可选：追加到 user 场景后作为「用户指令」。
 */
export function buildRefineMessages(scene: string, instruction?: string): { system: string; user: string } {
	return {
		system:
			"你是画面描述优化助手。目标：把一段用于图像生成（Danbooru tag 风格）的画面描述优化得更清晰、更利于高质量出图——" +
			"细化构图、光线、氛围与环境细节，用更准确、更丰富的描述词。\n" +
			"硬性要求：\n" +
			"1. 保留主体与画面基本内容；\n" +
			"2. 不得增加、删减或改变角色特征（外观、衣着、身份）；\n" +
			"3. 不得改变主体、核心构图与画面主题。\n" +
			"输出格式：只输出一行，以 [场景] 开头，后接优化后的画面描述；不要解释、不要输出其它任何内容。",
		user: `${scene || "（空）"}${instruction ? `\n用户指令：${instruction}` : ""}`,
	};
}

/**
 * 从 LLM 输出剥离提取 `[场景]` 内容：
 * - 剥 markdown 围栏；找 `[场景]` / `【场景】` 标记（可带 `:`/`：`），取其后的整段；
 * - 若其后又出现其它 `[xxx]` 段（LLM 附加内容），只取首个段前内容；
 * - 无标记或内容为空 → null（调用方报「微调结果解析失败」）。
 */
export function extractRefinedScene(text: string): string | null {
	if (!text) return null;
	const t = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/`/g, "").trim();
	if (!t) return null;
	const m = /[\[【]\s*场景\s*[\]】]\s*[:：]?\s*([\s\S]*)$/.exec(t);
	if (!m) return null;
	let scene = m[1].trim();
	if (!scene) return null;
	// 防 LLM 附加：截到下一个 [xxx] 段之前
	const seg = scene.split(/[\[【][^\]】]*[\]】]/)[0].trim();
	return seg || null;
}
