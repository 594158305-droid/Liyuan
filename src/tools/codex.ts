/**
 * 知识库族工具（PLAN-RP-TOOLING：codex 家族）。
 *
 * 领域函数全在 `src/codex.ts`（纯函数，只依赖 cwd）——此前只有扩展侧（roleplay.ts）与
 * 助手侧手写三件（codex_create/codex_write/codex_mount）有工具化入口，台上完全不可见。
 * 本族把六件统一进来：读（list/read）+ 写（create/write/delete）+ 挂载（mount）。
 *
 * ## 与补充设定集的分工
 *
 * - 知识库（.liyuan-codex/）独立于角色卡全局存在，任何会话挂载后并入检索（lorebook_search）；
 * - 补充设定集（lorebook_write）按卡分文件、跟卡走。二者都是用户资料，写侧都过门禁。
 *
 * ## 写入门禁（D-T4）
 *
 * `codex_write` 在 GATED_TOOLS 之列，只有用户本轮明确要求记录时才放行；
 * `codex_delete` 认**删除信号**（DELETE_REQUEST_RE，同 memory_delete 语义，见 gate.ts）。
 * 助手面不注入 gate（助手每次调用由用户当面驱动，见 assistant.ts 注释）——未注入则跳过判定。
 *
 * ## 挂载语义（codex_mount）
 *
 * 挂载关系随剧情分支走（rp-codex 树快照，rewind/fork 跟随）。引擎侧读当前挂载
 * 直接读分支快照（codexNamesFromBranch）；写入由宿主注入的 `mountCodex` 回调处理
 * （宿主在回调里写树快照，main.ts 注入）。工具本身只透传 name + enabled。
 */

import { checkWriteGate } from "./gate.ts";
import { errText, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

import type {
	AppendCodexResult,
	CodexEntryInput,
	CodexMeta,
	CreateCodexResult,
	DeleteCodexResult,
} from "../codex.ts";
import type { LorebookEntry } from "../types.ts";

export interface CodexDeps {
	/** 列举全部库（codex_list / codex_mount 列表模式用）；未注入 = 台上无对应工具 */
	listCodexes?: () => CodexMeta[];
	/** 读库条目（codex_read 用）；返回 null = 库不存在 */
	readCodex?: (name: string) => LorebookEntry[] | null;
	/** 建库（codex_create 用） */
	createCodexFn?: (name: string, description?: string) => CreateCodexResult;
	/** 写条目（codex_write 用；内容指纹去重） */
	writeCodex?: (name: string, input: CodexEntryInput) => AppendCodexResult;
	/** 删条目（codex_delete 用；按内容指纹删除） */
	deleteCodexEntryFn?: (name: string, fingerprint: string) => DeleteCodexResult;
	/** 条目内容 → 指纹（codex_read 展示指纹、codex_delete 按 title 定位用） */
	fingerprint?: (content: string) => string;
	/** 当前分支挂载的库名（codex_mount 列表模式用；引擎从树快照读） */
	mountedCodexes?: () => string[];
	/** 挂载/卸载（codex_mount 用；宿主能力：写 rp-codex 树快照） */
	mountCodex?: (name: string, enabled: boolean) => { ok: boolean; error?: string };
	/** 本拍用户原文 + 门禁档位（写侧门禁判定用，见 gate.ts） */
	gate?: () => { lastUserText: string; creationMode?: "ask" | "silent" };
}

/** 按库名找 meta（大小写不敏感）；找不到回 null */
const findMeta = (all: CodexMeta[], name: string): CodexMeta | undefined =>
	all.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());

/** 「现有库名列表」话术（查单个没命中时给出可见的库，避免模型瞎猜名字） */
const knownNamesOf = (all: CodexMeta[]): string =>
	all.map((c) => c.name).join("、");

/**
 * 调用情境（D-T3）：模型想知道「有哪些知识库、各收着什么」。检索靠关键词命中，
 * 列举才答得了「有什么库」；也是 codex_mount / codex_read 的先导。
 */
export const codexList: ToolSpec<CodexDeps> = {
	name: "codex_list",
	domain: "codex",
	mode: "read",
	surfaces: ["stage", "assistant"],
	label: "列举知识库",
	description: (ctx) =>
		ctx.surface === "stage"
			? `列出全部知识库（名称/描述/条目数）；可选 name 只查单个。` +
				`知识库是跨会话全局存在的自建设定库，挂载后条目并入 lorebook_search 检索。` +
				`想知道有哪些库、某库收着什么内容，先查这里再决定要不要 codex_mount / codex_read。`
			: `列出全部知识库（名称/描述/条目数），用于纵览有哪些用户自建设定库、或按名查单个库的信息。` +
				`要读库内条目用 codex_read。`,
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "库名（缺省列全部）" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.listCodexes) return { text: "本环境不支持列举知识库。" };

		let all: CodexMeta[];
		try {
			all = deps.listCodexes();
		} catch (err) {
			return { text: `列举知识库失败：${errText(err)}` };
		}

		const want = strArg(args, "name");
		if (want) {
			const meta = findMeta(all, want);
			if (!meta) {
				return {
					text: `没有名为「${want}」的知识库${all.length ? `（现有：${knownNamesOf(all)}）` : "（尚无任何库，可用 codex_create 创建）"}。`,
					activity: `查知识库「${want}」· 无此库`,
				};
			}
			return {
				text: `知识库「${meta.name}」：${meta.entryCount} 条${meta.description ? `。${meta.description}` : ""}`,
				activity: `查知识库「${meta.name}」`,
				details: { name: meta.name, entryCount: meta.entryCount },
			};
		}

		if (all.length === 0) {
			return { text: "尚无任何知识库。可用 codex_create 创建。", activity: "列知识库 · 0 个" };
		}
		const lines = all.map((c) => `- ${c.name}（${c.entryCount} 条）${c.description ? `：${c.description}` : ""}`);
		return {
			text: `现有知识库共 ${all.length} 个：\n${lines.join("\n")}`,
			activity: `列知识库 · ${all.length} 个`,
		};
	},
};

/**
 * 调用情境（D-T3）：模型要引用某库的具体条目内容——「该库收着什么、某条原文是什么」。
 * 检索（lorebook_search）只回命中片段，答不了「整库目录 / 单条全文」。
 */
export const codexRead: ToolSpec<CodexDeps> = {
	name: "codex_read",
	domain: "codex",
	mode: "read",
	surfaces: ["stage", "assistant"],
	label: "读取知识库",
	description: (ctx) =>
		ctx.surface === "stage"
			? `读取知识库内容（条目列表：标题/关键词/正文/指纹）。可选 title 只读标题或关键词含此字样的条目。` +
				`正文涉及某库已收知识时先读再写，别凭印象捏造库里的既有事实。`
			: `读取知识库条目（标题/关键词/正文/指纹），可传 title 过滤单条。用于查看库里的具体内容，` +
				`指纹供 codex_delete 精确删除用。`,
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "库名（必填）" },
			title: { type: "string", description: "只读标题或关键词含此字样的条目（缺省读全部）" },
		},
		required: ["name"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.readCodex) return { text: "本环境不支持读取知识库。" };

		const name = strArg(args, "name");
		if (!name) return { text: "缺少 name 参数（库名）。" };

		let entries: LorebookEntry[] | null;
		try {
			entries = deps.readCodex(name);
		} catch (err) {
			return { text: `读取知识库失败：${errText(err)}` };
		}
		if (!entries) return { text: `没有名为「${name}」的知识库（可用 codex_list 查看现有库）。` };

		const title = strArg(args, "title");
		const matched = title
			? entries.filter(
					(e) =>
						(e.comment ?? "").toLowerCase().includes(title.toLowerCase()) ||
						(e.keys ?? []).some((k) => k.toLowerCase().includes(title.toLowerCase())),
				)
			: entries;

		if (matched.length === 0) {
			return {
				text: title
					? `知识库「${name}」共 ${entries.length} 条，无标题/关键词含「${title}」的条目。`
					: `知识库「${name}」是空的（尚无条目）。`,
				activity: `读知识库「${name}」· 0 条`,
			};
		}

		const lines = matched.map((e) => {
			const keys = e.keys?.length ? `（关键词：${e.keys.join("、")}）` : "";
			const marks = [e.constant ? "常驻" : "", e.enabled === false ? "**已停用**" : ""].filter(Boolean).join("·");
			const fp = deps.fingerprint ? `｜指纹 ${deps.fingerprint(e.content ?? "")}` : "";
			return `### ${e.comment || e.keys?.[0] || "条目"}${keys}\n${e.content ?? ""}${marks ? `\n${marks}` : ""}${fp}`;
		});
		return {
			text: lines.join("\n\n"),
			activity: `读知识库「${name}」· ${matched.length} 条`,
			details: { name, count: matched.length },
		};
	},
};

/**
 * 调用情境（D-T3）：用户说「帮我建一个 X 的库/整理一册长期设定」。建的是新文件（同名拒写），
 * 不碰用户现有数据。建库后要本对话用得上还需 codex_mount。
 */
export const codexCreate: ToolSpec<CodexDeps> = {
	name: "codex_create",
	domain: "codex",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "创建知识库",
	description: (ctx) =>
		ctx.surface === "stage"
			? `创建一个空的命名知识库（跨会话全局存在，任何对话都可 codex_mount 挂载）。` +
				`仅当用户明确要建库/整理一册长期设定时调用；同名已存在会拒写。` +
				`建库后本对话要检索它还需 codex_mount 挂载。`
			: `创建命名知识库（独立于角色卡、可被任意对话挂载的设定数据库）。同名已存在则拒绝。` +
				`建库后用 codex_write 写条目、codex_mount 挂到剧情。`,
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "库名（≤40 字；跨会话的身份标识）" },
			description: { type: "string", description: "一句话说明这个库收集什么（可省）" },
		},
		required: ["name"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.createCodexFn) return { text: "本环境不支持创建知识库。" };

		const name = strArg(args, "name");
		if (!name) return { text: "缺少 name 参数（库名）。" };

		let r: CreateCodexResult;
		try {
			r = deps.createCodexFn(name, strArg(args, "description"));
		} catch (err) {
			return { text: `创建知识库失败：${errText(err)}` };
		}
		if (!r.ok) return { text: r.error, activity: "建知识库 · 失败" };
		return {
			text: `知识库「${r.meta.name}」已创建（${r.meta.entryCount} 条）。本对话要检索它先 codex_mount 挂载；写条目用 codex_write。`,
			activity: `建知识库「${r.meta.name}」`,
			details: { name: r.meta.name },
		};
	},
};

/**
 * 调用情境（D-T3）：用户明确说「把这条记进 X 库/沉淀到知识库」。写的是用户资料，
 * 过写入门禁（GATED_TOOLS 含 codex_write）——不是模型自己觉得该记就记。
 */
export const codexWrite: ToolSpec<CodexDeps> = {
	name: "codex_write",
	domain: "codex",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "写入知识库",
	description: () =>
		"把用户明确要求沉淀的知识写进指定知识库（跨会话保留，挂载该库的任何对话都能检索到）。" +
		"**仅在用户明确要求记录时调用**——不要自作主张写，也不要反问「要不要记下来」。内容重复会被拒绝。" +
		"剧情进展归 world_state_update；本工具只收可长期复用的知识条目。",
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "目标库名（必须已存在）" },
			title: { type: "string", description: "条目标题，如「赤髓·蚀骨兰」" },
			keys: {
				type: "array",
				items: { type: "string" },
				description: "检索关键词（中文与任何原文名都放进来；省略则从标题派生）",
			},
			content: { type: "string", description: "条目正文（简洁、陈述性）" },
		},
		required: ["name", "title", "content"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.writeCodex) return { text: "本环境不支持写入知识库。" };

		const name = strArg(args, "name");
		const title = strArg(args, "title");
		const content = strArg(args, "content");
		if (!name || !title || !content) return { text: "缺少 name / title / content 参数。" };
		const keys = Array.isArray(args.keys)
			? args.keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
			: [];

		// 写入门禁（D-T4）：仅在用户本轮明确要求时放行
		const g = deps.gate?.();
		if (g) {
			const verdict = checkWriteGate({
				toolName: "codex_write",
				lastUserText: g.lastUserText,
				creationMode: g.creationMode,
			});
			if (!verdict.allow) return { text: verdict.reason, activity: "写知识库 · 门禁拦下" };
		}

		let r: AppendCodexResult;
		try {
			r = deps.writeCodex(name, { title, keys, content });
		} catch (err) {
			return { text: `写入知识库失败：${errText(err)}` };
		}
		if (!r.ok) return { text: r.error, activity: "写知识库 · 失败" };
		if (!r.entry) return { text: "内容与库中已有条目重复，未写入。", activity: "写知识库 · 重复跳过" };
		return {
			text: `已写入知识库「${name}」：【${r.entry.comment}】关键词 ${r.entry.keys.join("、") || "（无）"}。挂载该库的对话此后检索可命中。`,
			activity: `写知识库「${name}」`,
			details: { codex: name, uid: r.entry.uid },
		};
	},
};

/**
 * 调用情境（D-T3）：用户指出某条知识记错了、或要求删掉某条。删除不可逆——
 * 门禁认删除信号（DELETE_REQUEST_RE，同 memory_delete），且话术指向「继续演」。
 */
export const codexDelete: ToolSpec<CodexDeps> = {
	name: "codex_delete",
	domain: "codex",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "删除知识库条目",
	description: () =>
		"删除知识库里的某条条目：按 fingerprint（从 codex_read 取）或按 title（标题与 codex_read 显示的一致）。" +
		"**仅在用户明确要求删除时调用**——删除不可逆；你自己觉得某条不对，就在正文里绕开它，不要删。",
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "库名（必填）" },
			fingerprint: { type: "string", description: "条目的内容指纹（从 codex_read 取）；与 title 二选一" },
			title: { type: "string", description: "条目标题（与 codex_read 显示的一致）；与 fingerprint 二选一" },
		},
		required: ["name"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.deleteCodexEntryFn || !deps.readCodex) return { text: "本环境不支持删除知识库条目。" };

		const name = strArg(args, "name");
		if (!name) return { text: "缺少 name 参数（库名）。" };

		// 门禁：删除认删除信号（同 memory_delete，gate.ts signalFor 映射）
		const g = deps.gate?.();
		if (g) {
			const verdict = checkWriteGate({
				toolName: "codex_delete",
				lastUserText: g.lastUserText,
				creationMode: g.creationMode,
			});
			if (!verdict.allow) return { text: verdict.reason, activity: "删知识库 · 门禁拦下" };
		}

		let fingerprint = strArg(args, "fingerprint");
		const title = strArg(args, "title");
		if (!fingerprint && !title) return { text: "缺少 fingerprint 或 title 参数（条目标识从 codex_read 取）。" };

		if (!fingerprint) {
			// 按 title 定位：读库找标题完全一致的条目，取其内容指纹
			let entries: LorebookEntry[] | null;
			try {
				entries = deps.readCodex(name);
			} catch (err) {
				return { text: `读取知识库失败：${errText(err)}` };
			}
			if (!entries) return { text: `没有名为「${name}」的知识库。` };
			if (!deps.fingerprint) return { text: "本环境不支持按标题删除（缺指纹能力），请用 fingerprint 参数。" };
			const t = title.toLowerCase();
			const hits = entries.filter((e) => (e.comment ?? "").toLowerCase() === t);
			if (hits.length === 0) {
				return { text: `知识库「${name}」中没有标题为「${title}」的条目（标题需与 codex_read 显示的完全一致）。`, activity: "删知识库 · 未命中" };
			}
			if (hits.length > 1) {
				const fps = hits.map((e) => deps.fingerprint!(e.content ?? "")).join("、");
				return { text: `知识库「${name}」有 ${hits.length} 条同名条目，请用 fingerprint 精确指定（${fps}）。` };
			}
			fingerprint = deps.fingerprint(hits[0].content ?? "");
		}

		let r: DeleteCodexResult;
		try {
			r = deps.deleteCodexEntryFn(name, fingerprint);
		} catch (err) {
			return { text: `删除知识库条目失败：${errText(err)}` };
		}
		if (!r.ok) return { text: r.error, activity: "删知识库 · 失败" };
		if (!r.removed) {
			return {
				text: `知识库「${name}」中没有指纹 ${fingerprint} 的条目（可能已删除）。先用 codex_read 取准确的指纹或标题。`,
				activity: "删知识库 · 未命中",
			};
		}
		return { text: `已从知识库「${name}」删除条目（不可恢复）。`, activity: "删知识库 · 1 条", details: { codex: name } };
	},
};

/**
 * 调用情境（D-T3）：剧情要用某册长期设定、或用户说「把那个库挂上/卸掉」。
 * 挂载关系随分支走（rewind/fork 跟随）；写侧由宿主回调落树快照（简化实现，见文件头）。
 * 省略 name = 列表模式（全部库 + 当前挂载状态）。
 */
export const codexMount: ToolSpec<CodexDeps> = {
	name: "codex_mount",
	domain: "codex",
	mode: "write",
	surfaces: ["stage", "assistant"],
	label: "挂载/卸载知识库",
	description: (ctx) =>
		ctx.surface === "stage"
			? `把知识库挂载/卸载到当前会话（挂载后其条目并入 lorebook_search 检索；挂载关系随剧情分支走，rewind 跟随）。` +
				`省略 name 时列出全部库及当前挂载状态。` +
				`剧情里要用某册长期设定时先挂载再检索；不再需要可卸载（库文件保留）。`
			: `把知识库挂载/卸载到剧情对话（挂载后条目并入剧情检索；挂载关系随剧情分支走）。` +
				`省略 name 时列出全部库及当前挂载状态。`,
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "库名（缺省 = 列出全部库及挂载状态）" },
			enabled: { type: "boolean", description: "true = 挂载（缺省），false = 卸载" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.listCodexes) return { text: "本环境不支持列举知识库。" };

		const mounted = deps.mountedCodexes?.() ?? [];
		const name = strArg(args, "name");

		// 列表模式：不带 name → 列出全部库 + 挂载状态（顺带回答「当前挂载了什么」）
		if (!name) {
			let all: CodexMeta[];
			try {
				all = deps.listCodexes();
			} catch (err) {
				return { text: `列举知识库失败：${errText(err)}` };
			}
			if (all.length === 0) {
				return { text: "尚无任何知识库。可用 codex_create 创建。", activity: "列知识库 · 0 个" };
			}
			const lines = all.map((c) => {
				const on = mounted.some((n) => n.toLowerCase() === c.name.toLowerCase());
				return `- ${c.name}（${c.entryCount} 条${on ? "，已挂载" : ""}）${c.description ? `：${c.description}` : ""}`;
			});
			return {
				text: `现有知识库（当前挂载：${mounted.join("、") || "无"}）：\n${lines.join("\n")}`,
				activity: `列知识库 · ${all.length} 个`,
			};
		}

		if (!deps.mountCodex) return { text: "本环境不支持挂载/卸载知识库。" };

		let all: CodexMeta[];
		try {
			all = deps.listCodexes();
		} catch (err) {
			return { text: `列举知识库失败：${errText(err)}` };
		}
		const meta = findMeta(all, name);
		if (!meta) {
			return {
				text: `没有名为「${name}」的知识库${all.length ? `（现有：${knownNamesOf(all)}）` : "（尚无任何库，可 codex_create 创建）"}。`,
				activity: "挂知识库 · 无此库",
			};
		}

		const enabled = args.enabled !== false;
		const already = mounted.some((n) => n.toLowerCase() === meta.name.toLowerCase());
		if (already === enabled) {
			return { text: `知识库「${meta.name}」已${enabled ? "挂载" : "卸载"}（${meta.entryCount} 条）。` };
		}

		let r: { ok: boolean; error?: string };
		try {
			r = deps.mountCodex(meta.name, enabled);
		} catch (err) {
			return { text: `挂载/卸载知识库失败：${errText(err)}` };
		}
		if (!r.ok) return { text: r.error || "挂载/卸载失败。", activity: "挂知识库 · 失败" };
		return {
			text: `知识库「${meta.name}」已${enabled ? "挂载到本会话" : "从本会话卸载"}（${meta.entryCount} 条）。${enabled ? "条目已并入检索。" : "库文件保留，可随时再挂载。"}`,
			activity: `${enabled ? "挂载" : "卸载"}知识库「${meta.name}」`,
			details: { codex: meta.name, enabled },
		};
	},
};

/** 知识库族全部工具（读两件 + 写三件 + 挂载一件） */
export const codexTools: ToolSpec<CodexDeps>[] = [
	codexList,
	codexRead,
	codexCreate,
	codexWrite,
	codexDelete,
	codexMount,
];
