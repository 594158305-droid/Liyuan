/**
 * 图片计划解析与合规（插件 B draw-pipeline，DESIGN-draw §3.2 + Q10/Q11）。
 *
 * YAML 解析方案（契约 §1）：项目无 js-yaml 直接依赖（node_modules 里的 yaml 是传递依赖、
 * src/ 未用，领域层不引入未声明依赖）→ 实现**逐行模糊解析**（缩进识别 + 字段行解析），
 * 支持多个 `<image_gen>` 块合并。容错：缩进乱/引号断/字段缺省都能进（缺省字段有默认值），
 * 完全无块 → 抛 parse 错误（调用方按「规划失败」重试或跳过）。
 *
 * 轻量合规（Q11）：maxImages / maxCharactersPerImage 硬截断、scene 空/超长截断、
 * aspect 非法回退 portrait。分级校验（sfw/nsfw）一期简化为不拦截（报告见返回文档）。
 */

/** 单张图的任务 */
export interface ImageTask {
	index: number;
	/** 正文锚点（缺省 = 消息末尾） */
	anchor?: string;
	aspect: "portrait" | "landscape" | "square";
	scene: string;
	/** 整图补充负面（选填） */
	negative?: string;
	characters: { name: string; action?: string }[];
}

export interface ImagePlan {
	tasks: ImageTask[];
	warnings: string[];
}

const IMAGE_GEN_BLOCK_RE = /<image_gen>([\s\S]*?)<\/image_gen>/gi;

/** 从文本提取所有 <image_gen> 块并合并内容（多个块合并、保序） */
function extractBlocks(text: string): string[] {
	const blocks: string[] = [];
	IMAGE_GEN_BLOCK_RE.lastIndex = 0;
	for (const m of text.matchAll(IMAGE_GEN_BLOCK_RE)) blocks.push(m[1] ?? "");
	IMAGE_GEN_BLOCK_RE.lastIndex = 0;
	return blocks;
}

/** 单行解析：`key: value`（容忍行首缩进、key 两端空白）；非键值行返回 null */
function parseKeyValue(line: string): { key: string; value: string } | null {
	const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
	if (!m) return null;
	return { key: m[1].trim(), value: (m[2] ?? "").trim() };
}

/** 剥掉标量值两端的引号（直/弯），容忍引号断裂（首尾不配对也剥） */
function unquote(value: string): string {
	let v = value.trim();
	if (v.startsWith('"') || v.startsWith('"') || v.startsWith("“") || v.startsWith("「")) v = v.slice(1);
	if (v.endsWith('"') || v.endsWith('"') || v.endsWith("”") || v.endsWith("」")) v = v.slice(0, -1);
	return v.trim();
}

/** 逐行解析一个 image_gen 块内容（无 <image_gen> 围栏的裸 YAML 片段） */
function parseBlockBody(body: string): ImageTask[] {
	const lines = body.split("\n");
	const tasks: ImageTask[] = [];
	let cur: ImageTask | null = null;
	let charCur: { name: string; action?: string } | null = null;

	for (const raw of lines) {
		const line = raw.replace(/\r$/, "");
		// 任务开始：`- index: N`（容忍 `-index:` 等缩进噪声）
		const taskStart = /^\s*-\s*index\s*:\s*(\d+)/.exec(line);
		if (taskStart) {
			if (cur) tasks.push(cur);
			cur = { index: Number(taskStart[1]), aspect: "portrait", scene: "", characters: [] };
			charCur = null;
			continue;
		}
		// 字符条目：`- name: xxx`（缩进在 characters 下；若无明确层级则只要在 task 内）
		const charStart = /^\s*-\s*name\s*:\s*(.+)$/.exec(line);
		if (charStart && cur) {
			charCur = { name: unquote(charStart[1].trim()) };
			cur.characters.push(charCur);
			continue;
		}
		const kv = parseKeyValue(line);
		if (!kv || !cur) continue;
		const val = unquote(kv.value);
		switch (kv.key) {
			case "anchor":
				// 引号包裹则去引号（容忍直/弯引号）
				cur.anchor = val || undefined;
				break;
			case "aspect":
				if (val === "landscape" || val === "square" || val === "portrait") {
					cur.aspect = val;
				} else {
					cur.aspect = "portrait"; // 非法回退 portrait
				}
				break;
			case "scene":
				cur.scene = val;
				break;
			case "negative":
				cur.negative = val;
				break;
			case "action":
				if (charCur) charCur.action = val;
				else if (cur.characters.length > 0) cur.characters[cur.characters.length - 1]!.action = val;
				break;
			default:
				// 未知字段：忽略（多级容错，不因多余字段中断）
				break;
		}
	}
	if (cur) tasks.push(cur);
	return tasks;
}

/**
 * 从规划 LLM 输出中提取 <image_gen> YAML 块并解析。
 * - 支持多个 <image_gen> 块合并（各自解析后按顺序拼接，index 保序）
 * - 无块 → 抛 Error（parse 错误，调用方重试或跳过）
 */
export function parseImagePlan(text: string): ImagePlan {
	const blocks = extractBlocks(text ?? "");
	const tasks: ImageTask[] = [];
	const warnings: string[] = [];
	if (blocks.length === 0) {
		throw new Error("输出中未找到 <image_gen> 块");
	}
	for (const b of blocks) {
		const t = parseBlockBody(b);
		if (t.length === 0) warnings.push("有 <image_gen> 块但未解析出任务（跳过）");
		else tasks.push(...t);
	}
	// index 排序 + 去重（保序稳定）
	tasks.sort((a, b) => a.index - b.index);
	const seen = new Set<number>();
	const unique = tasks.filter((t) => {
		if (seen.has(t.index)) {
			warnings.push(`重复 index ${t.index}（保留先出现者）`);
			return false;
		}
		seen.add(t.index);
		return true;
	});
	return { tasks: unique, warnings };
}

const VALID_ASPECT = new Set(["portrait", "landscape", "square"]);
const MAX_SCENE_CHARS = 800;

/**
 * 轻量合规（Q11）：maxImages 硬截断（默认 2）、maxCharactersPerImage（默认 3）、
 * scene 空/超长（>800）截断、aspect 非法回退 portrait；返回截断后的计划 + warnings。
 */
export function enforceLimits(
	plan: ImagePlan,
	opts: { maxImages?: number; maxCharactersPerImage?: number },
): ImagePlan {
	const maxImages = opts.maxImages ?? 2;
	const maxChars = opts.maxCharactersPerImage ?? 3;
	const warnings = [...plan.warnings];

	let tasks = plan.tasks;
	if (tasks.length > maxImages) {
		warnings.push(`图片数 ${tasks.length} 超上限 ${maxImages}，截断保留前 ${maxImages} 张`);
		tasks = tasks.slice(0, maxImages);
	}

	const out: ImageTask[] = [];
	for (const t of tasks) {
		const chars = t.characters.slice(0, maxChars);
		if (t.characters.length > maxChars) {
			warnings.push(`任务 ${t.index} 角色数 ${t.characters.length} 超上限 ${maxChars}，截断`);
		}
		const scene = (t.scene ?? "").trim();
		if (!scene) {
			warnings.push(`任务 ${t.index} 缺 scene，跳过`);
			continue;
		}
		const truncatedScene = scene.length > MAX_SCENE_CHARS ? scene.slice(0, MAX_SCENE_CHARS) : scene;
		if (scene.length > MAX_SCENE_CHARS) warnings.push(`任务 ${t.index} scene 超长（>${MAX_SCENE_CHARS}），截断`);
		const aspect = VALID_ASPECT.has(t.aspect) ? t.aspect : "portrait";
		out.push({
			index: t.index,
			...(t.anchor ? { anchor: t.anchor } : {}),
			aspect,
			scene: truncatedScene,
			...(t.negative ? { negative: t.negative } : {}),
			characters: chars.map((c) => ({ name: c.name, ...(c.action ? { action: c.action } : {}) })),
		});
	}
	return { tasks: out, warnings };
}
