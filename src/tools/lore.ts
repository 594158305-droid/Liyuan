/**
 * 世界书族工具（PLAN-RP-TOOLING M-D1 垂直切片）。
 *
 * 合一前 `lorebook_search` 有三份实现（stage / assistant / roleplay），底层都调同一个
 * `searchEntries`，**差的是语料与话术**：台上剥离外部插件协议条目但不搜知识库；
 * 扩展搜知识库且带中文别名；助手两样都没有。没有一份是另外两份的超集。
 *
 * 合一取法（2026-08-04 用户裁定）：
 *   - **语料差异归依赖注入**——`LoreDeps.entries()` 由各面自己提供。
 *     台上注入「世界书+overlay+协议剥离+**挂载知识库**」（补齐 codex：原描述早已承诺
 *     「已挂载知识库」而实现从不加载，属描述与实现不符，本次一并修正）；
 *     助手注入**原始**世界书（**不剥协议**——助手是诊断面，用户问「我的卡为什么带
 *     UpdateVariable」时它必须看得见那些条目；协议剥离是台上生成的需要，不是检索的需要）。
 *   - 中文别名增强（扩展侧 withAliases）依赖 LLM 侧生成+缓存，留后续里程碑。
 *   - **话术按面裁剪**：台上要「查不到＝未被写下，可自行创造」的授权与记账去向；
 *     助手要语料规模与命中回声（诊断口径）。二者住同一文件，不会再各自漂移。
 */

import { checkWriteGate } from "./gate.ts";
import { errText, intArg, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

/** 命中条目的结构子集（不依赖 LorebookEntry 全形，便于离线单测） */
export interface LoreEntryLike {
	uid?: number;
	comment?: string;
	keys?: string[];
	content?: string;
	/** 常驻注入（列举/写入回执要报） */
	constant?: boolean;
	/** 是否启用；false = 被 disabledLore 停用（列举要标出来） */
	enabled?: boolean;
}

export interface LoreHitLike {
	entry: LoreEntryLike;
	score?: number;
}

export interface LoreDeps {
	/**
	 * 本面的检索语料 → 命中。limit 由工具传入（各面默认值不同，见 schema）。
	 * 语料范围是各面注入时的决定（见文件头），工具本身不关心条目从哪来。
	 */
	searchLore: (query: string, limit: number) => LoreHitLike[];
	/** 语料规模（助手诊断话术要报「共 N 条」）；未注入则不报 */
	loreSize?: () => number;

	// ---- 以下为 M-D2 世界书族补全；未注入则该工具不可用（各面按能力注册） ----

	/** 写一条正典进补充设定集；返回 null＝内容重复未写入 */
	writeLore?: (input: { title: string; keys: string[]; content: string; constant?: boolean }) => LoreEntryLike | null;
	/** 列举全部条目（含停用的——列举的意义正是让 agent 看见能启停什么） */
	listLore?: () => LoreEntryLike[];
	/** 按内容指纹启停；返回实际生效的条数 */
	toggleLore?: (fingerprints: string[], enabled: boolean) => number;
	/** 条目内容 → 指纹（启停的持久键；由调用方注入避免 src/tools 依赖 crypto） */
	fingerprint?: (content: string) => string;
	/** 本拍用户原文 + 门禁档位（写侧门禁判定用，见 gate.ts） */
	gate?: () => { lastUserText: string; creationMode?: "ask" | "silent" };
}

/** 台上默认命中数（一拍封顶 3 次检索，每次 3 条：控上下文预算） */
const STAGE_LIMIT = 3;
/** 助手默认命中数（诊断面要看得广，可调到 20） */
const ASSISTANT_LIMIT = 5;

/**
 * 命中格式化：`### 标题（关键词：…）\n正文`。
 *
 * 合一前三份的括号/分隔符各不相同（全角「（关键词：…）」/ 全角「（keys: …）」/ 半角「 (keys: …)」）。
 * 统一取台上那版：全角中文标签、顿号分隔、**无关键词时整段省略**（不留空括号）。
 */
function formatHits(hits: LoreHitLike[]): string {
	return hits
		.map((h) => {
			const title = h.entry.comment || h.entry.keys?.[0] || "条目";
			const keys = h.entry.keys?.length ? `（关键词：${h.entry.keys.join("、")}）` : "";
			return `### ${title}${keys}\n${h.entry.content ?? ""}`;
		})
		.join("\n\n");
}

export const lorebookSearch: ToolSpec<LoreDeps> = {
	name: "lorebook_search",
	domain: "lore",
	mode: "read",
	surfaces: ["stage", "assistant", "extension"],
	label: "检索世界书",
	description: (ctx) =>
		ctx.surface === "stage"
			? `检索设定集（世界书、补充设定集与已挂载知识库）：地点、族群、历史、人物、法术等设定细节。` +
				`正文将涉及你没有十足把握的世界细节时，先查再写——查不到才是「未被写下」，那时可自行创造并保持与既有事实一致。` +
				`用设定原文的语言检索（多为${ctx.language}或英文）。`
			: `检索本项目的世界书与补充设定集，用于诊断设定内容（含被台上按外部插件协议剥离的条目）。` +
				`用设定原文的语言检索（多为${ctx.language}或英文）。`,
	parameters: (ctx) => {
		const query = {
			type: "string",
			description:
				ctx.surface === "stage" ? "关键词（空格分隔），非整句问题" : "检索词（用世界书原文语言），关键词而非整句",
		};
		// 台上不开 limit：一拍检索配额有限，条数固定才好控上下文预算；助手是诊断面，放开。
		if (ctx.surface === "stage") {
			return { type: "object", properties: { query }, required: ["query"] };
		}
		return {
			type: "object",
			properties: {
				query,
				limit: { type: "number", description: `命中上限（默认 ${ASSISTANT_LIMIT}，最多 20）` },
			},
			required: ["query"],
		};
	},
	async run(args, deps, ctx): Promise<ToolResult> {
		const stage = ctx.surface === "stage";
		const query = strArg(args, "query");
		if (!query) return { text: "缺少 query 参数。" };

		const limit = stage ? STAGE_LIMIT : intArg(args, "limit", ASSISTANT_LIMIT, 1, 20);
		let hits: LoreHitLike[] = [];
		try {
			hits = deps.searchLore(query, limit);
		} catch (err) {
			// 不抛：告诉模型怎么往下走（台上继续演，助手报障）
			return {
				text: stage
					? `设定集检索失败：${errText(err)}。按已知事实继续写。`
					: `设定集检索失败：${errText(err)}`,
			};
		}

		if (hits.length === 0) {
			if (stage) {
				return {
					text: "设定集无命中——该细节尚未被写下。可自行创造，但须与既有事实一致（重要的创造会由场记记进账本）。",
					activity: `查设定「${query}」· 无命中`,
				};
			}
			const size = deps.loreSize?.();
			return {
				text: `（世界书${typeof size === "number" ? `共 ${size} 条，` : ""}未命中「${query}」）`,
				activity: `查设定「${query}」· 无命中`,
			};
		}

		return {
			text: formatHits(hits),
			activity: `查设定「${query}」· ${hits.length} 条`,
			details: { hits: hits.map((h) => ({ uid: h.entry.uid, score: h.score })) },
		};
	},
};

// ---------------- M-D2：写侧 + 列举 + 启停 ----------------

/**
 * 调用情境（D-T3）：用户明确说「把这条记下来/写进设定集」。
 * **不是**模型自己觉得该记就记——那是门禁挡的（gate.ts），也是描述里反复强调的。
 * 剧情进展归 world_state_update，此工具只收**世界设定**。
 */
export const lorebookWrite: ToolSpec<LoreDeps> = {
	name: "lorebook_write",
	domain: "lore",
	mode: "write",
	surfaces: ["stage", "assistant", "extension"],
	label: "写入补充设定集",
	description: () =>
		"把用户明确要求留存的世界设定（设定/规则/人物志）写进补充设定集：跨会话保留，此后 lorebook_search 可命中。" +
		"**仅在用户明确要求记录时调用**——不要自作主张写，也不要反问「要不要写下来」。" +
		"只收世界设定；剧情进展归 world_state_update。内容重复会被拒绝。" +
		"用户的原始世界书永远只读，写入落在独立的补充设定集里。",
	parameters: () => ({
		type: "object",
		properties: {
			title: { type: "string", description: "条目标题，如「北境骨誓风俗」" },
			keys: {
				type: "array",
				items: { type: "string" },
				description: "检索关键词（中文与任何原文名都放进来，否则日后检索不到）",
			},
			content: { type: "string", description: "正典正文（简洁、陈述性、用剧情语言）" },
			constant: { type: "boolean", description: "true = 常驻注入（仅限全局关键事实，滥用会挤占上下文）" },
		},
		required: ["title", "keys", "content"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.writeLore) return { text: "补充设定集未就绪（本会话尚未装载角色卡）。" };

		const title = strArg(args, "title");
		const content = strArg(args, "content");
		if (!title || !content) return { text: "缺少 title 或 content 参数。" };
		const keys = Array.isArray(args.keys)
			? args.keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
			: [];

		// 写入门禁（D-T4）：仅在用户本轮明确要求时放行
		const g = deps.gate?.();
		if (g) {
			const verdict = checkWriteGate({
				toolName: "lorebook_write",
				lastUserText: g.lastUserText,
				creationMode: g.creationMode,
			});
			if (!verdict.allow) return { text: verdict.reason, activity: "写设定 · 门禁拦下" };
		}

		let entry: LoreEntryLike | null;
		try {
			entry = deps.writeLore({ title, keys, content, constant: args.constant === true });
		} catch (err) {
			return { text: `写入补充设定集失败：${errText(err)}` };
		}
		if (!entry) return { text: "内容与已有条目重复，未写入。", activity: "写设定 · 重复跳过" };

		return {
			text:
				`已固化为正典：【${entry.comment}】关键词 ${entry.keys?.join("、") || "（无）"}` +
				`${entry.constant ? "（常驻注入）" : ""}。此后检索可命中，跨会话保留。`,
			activity: `写设定「${entry.comment}」`,
			details: { uid: entry.uid },
		};
	},
};

/**
 * 调用情境（D-T3）：模型想知道「这个世界里都写了些什么」——检索靠关键词命中，
 * 列举才答得了「有哪些条目」「哪些被停用了」。也是 lorebook_toggle 取指纹的入口。
 */
export const lorebookList: ToolSpec<LoreDeps> = {
	name: "lorebook_list",
	domain: "lore",
	mode: "read",
	surfaces: ["stage", "assistant"],
	label: "列举世界书条目",
	description: () =>
		"列举设定集的全部条目（标题/关键词/是否常驻/是否已停用/指纹），用于纵览有哪些设定、" +
		"或为 lorebook_toggle 取指纹。要查具体内容用 lorebook_search——本工具只给目录不给正文。",
	parameters: () => ({
		type: "object",
		properties: {
			keyword: { type: "string", description: "只列标题或关键词含此字样的条目（缺省列全部）" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.listLore || !deps.fingerprint) return { text: "本环境不支持列举世界书条目。" };

		let all: LoreEntryLike[];
		try {
			all = deps.listLore();
		} catch (err) {
			return { text: `列举设定集失败：${errText(err)}` };
		}

		const kw = strArg(args, "keyword").toLowerCase();
		const list = kw
			? all.filter(
					(e) =>
						(e.comment ?? "").toLowerCase().includes(kw) ||
						(e.keys ?? []).some((k) => k.toLowerCase().includes(kw)),
				)
			: all;

		if (list.length === 0) {
			return {
				text: kw ? `设定集共 ${all.length} 条，无标题/关键词含「${kw}」的条目。` : "设定集是空的。",
				activity: `列设定${kw ? `「${kw}」` : ""}· 0 条`,
			};
		}

		const fp = deps.fingerprint;
		const lines = list.map((e) => {
			const marks = [e.constant ? "常驻" : "", e.enabled === false ? "**已停用**" : ""].filter(Boolean).join("·");
			const keys = e.keys?.length ? `关键词 ${e.keys.join("、")}` : "无关键词";
			return `- ${e.comment || e.keys?.[0] || "条目"}｜${keys}${marks ? `｜${marks}` : ""}｜指纹 ${fp(e.content ?? "")}`;
		});
		const head = kw ? `设定集含「${kw}」的条目 ${list.length}/${all.length} 条：` : `设定集共 ${list.length} 条：`;
		return {
			text: `${head}\n${lines.join("\n")}`,
			activity: `列设定${kw ? `「${kw}」` : ""}· ${list.length} 条`,
		};
	},
};

/**
 * 调用情境（D-T3）：某条设定与当前剧情/预设冲突，或用户说「别再用那条设定了」。
 *
 * ⚠ 复用 `config.disabledLore` 指纹通道——与 M-C2 的外部插件协议禁用是**同一机制**
 * （TOOLING M-D2 明示不得另起一套）。停用是**用户级**的：跨会话、跨卡保留。
 */
export const lorebookToggle: ToolSpec<LoreDeps> = {
	name: "lorebook_toggle",
	domain: "lore",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "启停世界书条目",
	description: () =>
		"启用/停用设定集条目（按指纹，指纹从 lorebook_list 取）。停用后该条不再注入上下文、检索也不命中。" +
		"用于某条设定与当前剧情冲突、或用户要求弃用某条设定时。" +
		"**这是用户级的持久开关**（跨会话保留），不是本拍的临时忽略——拿不准就先问用户。",
	parameters: () => ({
		type: "object",
		properties: {
			fingerprints: {
				type: "array",
				items: { type: "string" },
				description: "要启停的条目指纹（从 lorebook_list 取），可多条",
			},
			enabled: { type: "boolean", description: "true = 启用，false = 停用" },
		},
		required: ["fingerprints", "enabled"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.toggleLore) return { text: "本环境不支持启停世界书条目。" };

		const fps = Array.isArray(args.fingerprints)
			? args.fingerprints.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
			: [];
		if (fps.length === 0) return { text: "缺少 fingerprints 参数（指纹从 lorebook_list 取）。" };
		if (typeof args.enabled !== "boolean") return { text: "缺少 enabled 参数（true = 启用，false = 停用）。" };

		const enabled = args.enabled;
		let count: number;
		try {
			count = deps.toggleLore(fps, enabled);
		} catch (err) {
			return { text: `启停失败：${errText(err)}` };
		}
		const verb = enabled ? "启用" : "停用";
		return {
			text: `已${verb} ${count} 条设定（用户级持久开关，跨会话保留）。${enabled ? "" : "停用的条目不再注入上下文，检索也不会命中。"}`,
			activity: `${verb}设定 · ${count} 条`,
		};
	},
};

/** 世界书族全部工具（M-D1 检索；M-D2 写侧/列举/启停） */
export const loreTools: ToolSpec<LoreDeps>[] = [lorebookSearch, lorebookWrite, lorebookList, lorebookToggle];
