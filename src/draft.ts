/**
 * 稿纸（draft）——RP agent 化的正文修订层（与 coding agent 的 Edit-on-workspace 同构）。
 *
 * 动机（2026-08-02 实测）：模型输出流不可逆，"打磨"只能发生在 thinking 里——改一处
 * 就得把全稿在脑内重誊一遍（25k 字 thinking 里正文出现 2 遍）。本模块把稿子交给
 * harness 持有：
 * - 草稿即正文本身：模型照常流式输出，不经工具参数，不牺牲流式体验；
 * - draft_edit 以「精确替换」补丁修订已写文字——补丁存为 rp-draft-op 隐藏消息，
 *   会话树只追加不改写，可回放、随变体分支走；
 * - draft_check 用程序化验收代替模型脑内自查机械项（字数/禁词/比喻/句式/模块齐全）；
 * - 显示层（server/wire toWireHistory）与送模层（roleplay context 钩子）各自套用
 *   同一份补丁函数——两侧看到同一份定稿，原始草稿仅存于会话文件。
 *
 * 本文件零 pi 依赖，纯函数可单测。
 */

import { scanTaggedBlocks } from "./postprocess.ts";

/** 补丁隐藏消息的 customType（sendMessage display:false；wire 跳过、送模前移除） */
export const DRAFT_OP_TYPE = "rp-draft-op";

/**
 * 稿纸工件消息的 customType（v2 工件化，2026-08-02）：draft_write 把整份正文写进
 * 该消息——正文从此不再是"模型的回复"，而是后端工件；wire 把它渲染为叙事气泡，
 * 送模前转成 assistant 文本（模型在历史里看到的仍是自己的话）。
 */
export const DRAFT_DOC_TYPE = "rp-draft";

export interface DraftOp {
	old: string;
	new: string;
}

/** 追加式补丁（M2）：把缺失的整块模块（如状态栏）补到稿末 */
export interface DraftAppendOp {
	append: string;
}

export type AnyDraftOp = DraftOp | DraftAppendOp;

/** 补丁消息 content（JSON 字符串）→ 补丁；不合法返回 null */
export function parseDraftOp(content: unknown): AnyDraftOp | null {
	if (typeof content !== "string") return null;
	try {
		const o = JSON.parse(content) as { old?: unknown; new?: unknown; append?: unknown };
		if (typeof o.old === "string" && o.old.length > 0 && typeof o.new === "string") {
			return { old: o.old, new: o.new };
		}
		if (typeof o.append === "string" && o.append.trim().length > 0) {
			return { append: o.append };
		}
	} catch {
		// 非补丁 JSON：忽略
	}
	return null;
}

/** wire MsgLike 与 context message 的公共子集（够用即可，不引它们的类型） */
export interface DraftMsgLike {
	role?: string;
	customType?: string;
	content?: unknown;
}

const textOfParts = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: unknown }).type === "text"
				? String((p as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
};

/** 在消息 content 里替换第一处 old（string 与 parts 两种形态）；未命中返回 null */
function replaceInContent(content: unknown, op: DraftOp): unknown | null {
	if (typeof content === "string") {
		if (!content.includes(op.old)) return null;
		return content.replace(op.old, op.new);
	}
	if (!Array.isArray(content)) return null;
	for (let i = 0; i < content.length; i++) {
		const p = content[i] as { type?: unknown; text?: unknown };
		if (p && typeof p === "object" && p.type === "text" && typeof p.text === "string" && p.text.includes(op.old)) {
			const parts = content.slice();
			parts[i] = { ...(p as object), text: (p.text as string).replace(op.old, op.new) };
			return parts;
		}
	}
	return null;
}

/** 追加到消息文本末尾（string 或最后一个 text part）；无处可追返回 null */
function appendToContent(content: unknown, text: string): unknown | null {
	if (typeof content === "string") {
		return `${content}\n\n${text}`;
	}
	if (!Array.isArray(content)) return null;
	for (let i = content.length - 1; i >= 0; i--) {
		const p = content[i] as { type?: unknown; text?: unknown };
		if (p && typeof p === "object" && p.type === "text" && typeof p.text === "string") {
			const parts = content.slice();
			parts[i] = { ...(p as object), text: `${p.text}\n\n${text}` };
			return parts;
		}
	}
	return null;
}

/** 补丁可作用的目标：assistant 文本消息，或稿纸工件消息 */
function isDraftOpTarget(m: DraftMsgLike): boolean {
	if (m?.role === "assistant") return true;
	return m?.role === "custom" && m.customType === DRAFT_DOC_TYPE;
}

/**
 * 顺序应用补丁流：遇到 rp-draft-op 时，向前找最近一条含 old 的目标消息
 * （assistant 文本或 rp-draft 稿纸），替换第一处；补丁消息本身从结果中移除。
 * 非破坏（浅克隆被改的消息）。
 */
export function applyDraftOps<T extends DraftMsgLike>(messages: T[]): { messages: T[]; applied: number } {
	const out: T[] = [];
	let applied = 0;
	for (const m of messages) {
		if (m?.role === "custom" && m.customType === DRAFT_OP_TYPE) {
			const op = parseDraftOp(m.content);
			if (op) {
				for (let i = out.length - 1; i >= 0; i--) {
					const prev = out[i];
					if (!isDraftOpTarget(prev)) continue;
					if ("append" in op) {
						// 追加式：补到最近一条目标消息末尾
						const next = appendToContent(prev.content, op.append);
						if (next !== null) {
							out[i] = { ...prev, content: next };
							applied++;
						}
						break;
					}
					const next = replaceInContent(prev.content, op);
					if (next !== null) {
						out[i] = { ...prev, content: next };
						applied++;
						break;
					}
				}
			}
			continue; // 补丁条目不进入结果流
		}
		out.push(m);
	}
	return { messages: out, applied };
}

/**
 * 末端实质消息的角色——跳过稿纸工件（rp-draft / rp-draft-op）。
 * 工件直落树后可能贴在消息流末尾；续轮判定若拿"末条"当信号，末条=工件会被
 * 误判成新回合 → 全量脚手架重注 → 模型当成新拍开写（2026-08-02 实测事故）。
 */
export function lastSubstantiveRole(messages: DraftMsgLike[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "custom" && (m.customType === DRAFT_DOC_TYPE || m.customType === DRAFT_OP_TYPE)) continue;
		return m?.role;
	}
	return undefined;
}

/**
 * 当前回合（最后一条 user 之后）的有效草稿——先套补丁再取文。
 * 有稿纸工件（rp-draft）时以**最后一份稿纸**为准（draft_write 重写即换稿）；
 * 没有稿纸时回落到 assistant 文本拼接（模型不配合工件化时的 v1 行为）。
 */
export function draftTurnText(messages: DraftMsgLike[]): string {
	const { messages: patched } = applyDraftOps(messages);
	let lastUser = -1;
	for (let i = patched.length - 1; i >= 0; i--) {
		if (patched[i]?.role === "user") {
			lastUser = i;
			break;
		}
	}
	const asstParts: string[] = [];
	let lastDraft: string | null = null;
	for (let i = lastUser + 1; i < patched.length; i++) {
		const m = patched[i];
		if (m?.role === "custom" && m.customType === DRAFT_DOC_TYPE) {
			const t = textOfParts(m.content).trim();
			if (t) lastDraft = t;
			continue;
		}
		if (m?.role !== "assistant") continue;
		const t = textOfParts(m.content).trim();
		if (t) asstParts.push(t);
	}
	return lastDraft ?? asstParts.join("\n\n");
}

/** draft_edit 定位校验（对给定草稿文本）：old 必须恰好出现一次 */
export function resolveDraftEditText(turn: string, old: string): { ok: true } | { ok: false; error: string } {
	if (!old || !old.trim()) return { ok: false, error: "old 不能为空。" };
	if (!turn) return { ok: false, error: "本回合还没有可修订的正文——先把草稿写出来。" };
	let count = 0;
	let idx = turn.indexOf(old);
	while (idx !== -1 && count < 3) {
		count++;
		idx = turn.indexOf(old, idx + Math.max(1, old.length));
	}
	if (count === 0) {
		return { ok: false, error: "old 在本回合已写文本中找不到——必须与原文逐字一致（含标点空白）。请重新精确引用。" };
	}
	if (count > 1) {
		return { ok: false, error: "old 在本回合文本中出现多处——请扩大引用范围使其唯一。" };
	}
	return { ok: true };
}

/** draft_edit 落笔前的定位校验：old 在当前回合文本中必须恰好出现一次 */
export function resolveDraftEdit(messages: DraftMsgLike[], old: string): { ok: true } | { ok: false; error: string } {
	return resolveDraftEditText(draftTurnText(messages), old);
}

// ---------------- draft_edit 定位阶梯与批量套用（M-B） ----------------

/**
 * 中文标点归一：直角/弯引号、破折号、省略号、全半角空格统一。
 * 中文正文里模型引用原文时最常见的失配就是引号变体——放宽格式噪声，绝不放宽内容差异
 * （对标 Codex seek_sequence.rs 的模糊阶梯，但我们把命中级别回报给模型，它不报）。
 *
 * ⚠ 每条规则必须**逐字符一对一**（不合并、不增删）——归一后的下标要直接用回原文取子串，
 * 长度一变下标就会错位。故省略号只做 ⋯→… 的等长替换，不做 `+` 合并。
 */
function normalizePunct(s: string): string {
	return s
		.replace(/[“”„‟]/g, '"')
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[「」『』]/g, '"')
		.replace(/[—－–―]/g, "—")
		.replace(/[⋯]/g, "…")
		.replace(/[ 　  ]/g, " ");
}

/** 定位命中级别——非精确命中要在 toolResult 里说明，模型才知道自己引得不准 */
export type EditMatchLevel = "exact" | "trimmed" | "punct";

export interface EditLocation {
	start: number;
	end: number;
	level: EditMatchLevel;
}

/** 在 text 中按阶梯定位 old 的唯一出现：精确 → 首尾 trim → 标点归一 */
export function locateEdit(text: string, old: string): { ok: true; at: EditLocation } | { ok: false; error: string } {
	if (!old || !old.trim()) return { ok: false, error: "old 不能为空。" };
	if (!text.trim()) return { ok: false, error: "工作区还没有稿件——先用 draft_write 提交初稿。" };

	const findAll = (hay: string, needle: string): number[] => {
		const hits: number[] = [];
		if (!needle) return hits;
		let i = hay.indexOf(needle);
		while (i !== -1 && hits.length <= 8) {
			hits.push(i);
			i = hay.indexOf(needle, i + needle.length);
		}
		return hits;
	};

	// 一级：精确
	let hits = findAll(text, old);
	if (hits.length === 1) return { ok: true, at: { start: hits[0]!, end: hits[0]! + old.length, level: "exact" } };
	if (hits.length > 1) {
		return { ok: false, error: `old 在现稿中出现 ${hits.length} 处——请扩大引用范围（前后多带一句）使其唯一。` };
	}

	// 二级：首尾 trim（模型常多带或少带首尾空白）
	const trimmed = old.trim();
	if (trimmed !== old) {
		hits = findAll(text, trimmed);
		if (hits.length === 1) {
			return { ok: true, at: { start: hits[0]!, end: hits[0]! + trimmed.length, level: "trimmed" } };
		}
		if (hits.length > 1) {
			return { ok: false, error: `old（忽略首尾空白后）在现稿中出现 ${hits.length} 处——请扩大引用范围使其唯一。` };
		}
	}

	// 三级：标点归一（引号/破折号/省略号变体）
	const normText = normalizePunct(text);
	const normOld = normalizePunct(trimmed);
	hits = findAll(normText, normOld);
	if (hits.length === 1) {
		// 归一不改变长度（全部一对一替换），下标可直接用回原文
		return { ok: true, at: { start: hits[0]!, end: hits[0]! + normOld.length, level: "punct" } };
	}
	if (hits.length > 1) {
		return { ok: false, error: `old（标点归一后）在现稿中出现 ${hits.length} 处——请扩大引用范围使其唯一。` };
	}

	return {
		ok: false,
		// 回显模型自己声称的 old（对标 Codex lib.rs:790）——让它自己看出幻觉
		error:
			`old 在现稿中找不到。你引用的是：\n「${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}」\n` +
			`须与现稿逐字一致。用 draft_search 取回精确原文，或 draft_read 通读现稿后重试。`,
	};
}

export interface DraftEditItem {
	old: string;
	new: string;
}

export interface DraftEditResult {
	ok: boolean;
	/** 成功时的新全文（失败时不产出——批量原子性） */
	text?: string;
	/** 每处的结果说明（成功含命中级别，失败含原因） */
	details: string[];
}

/**
 * 批量定点替换：**先全部定位、全绿才落笔**（对标 Codex 的 verify-then-apply，
 * 任一处失败则整批不改，避免半套用的稿子）。区间重叠也判失败。
 */
export function applyDraftEdits(text: string, edits: DraftEditItem[]): DraftEditResult {
	if (edits.length === 0) return { ok: false, details: ["edits 为空——至少给一处修改。"] };

	const located: Array<{ at: EditLocation; item: DraftEditItem; idx: number }> = [];
	const details: string[] = [];
	let failed = false;

	for (let i = 0; i < edits.length; i++) {
		const it = edits[i]!;
		if (typeof it?.old !== "string" || typeof it?.new !== "string") {
			details.push(`第 ${i + 1} 处：old/new 都必须是字符串。`);
			failed = true;
			continue;
		}
		const r = locateEdit(text, it.old);
		if (!r.ok) {
			details.push(`第 ${i + 1} 处：${r.error}`);
			failed = true;
			continue;
		}
		located.push({ at: r.at, item: it, idx: i });
	}

	if (!failed) {
		// 重叠检测：按起点排序后相邻区间不得交叉
		const sorted = [...located].sort((a, b) => a.at.start - b.at.start);
		for (let i = 1; i < sorted.length; i++) {
			if (sorted[i]!.at.start < sorted[i - 1]!.at.end) {
				details.push(
					`第 ${sorted[i - 1]!.idx + 1} 处与第 ${sorted[i]!.idx + 1} 处的引用区间重叠——` +
						`请合并成一处，或缩小引用范围。`,
				);
				failed = true;
				break;
			}
		}
	}

	if (failed) {
		details.push("**整批未套用**（任一处定位失败则全部不改）——修正后重新提交整批。");
		return { ok: false, details };
	}

	// 从后往前替换，前面的下标不受影响
	const sorted = [...located].sort((a, b) => b.at.start - a.at.start);
	let out = text;
	for (const { at, item } of sorted) {
		out = out.slice(0, at.start) + item.new + out.slice(at.end);
	}

	for (const { at, item, idx } of located) {
		const lvl =
			at.level === "exact" ? "" : at.level === "trimmed" ? "（按忽略首尾空白匹配）" : "（按标点归一匹配）";
		const from = item.old.trim();
		details.push(
			`第 ${idx + 1} 处${lvl}：${from.slice(0, 24)}${from.length > 24 ? "…" : ""} → ` +
				`${item.new.slice(0, 24)}${item.new.length > 24 ? "…" : ""}`,
		);
	}
	return { ok: true, text: out, details };
}

/** 命中处的上下文引用（±pad 字，空白压平）——draft_search 与验收报告共用 */
const ctxQuote = (text: string, idx: number, len: number, pad = 8): string => {
	const from = Math.max(0, idx - pad);
	const to = Math.min(text.length, idx + len + pad);
	return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ")}${to < text.length ? "…" : ""}`;
};

/** draft_search：在现稿中定位文字，返回 ±24 字上下文引用（供 draft_edit 取精确原文） */
export function searchDraft(text: string, query: string, limit = 8): { hits: string[]; total: number } {
	if (!query.trim() || !text) return { hits: [], total: 0 };
	const hits: string[] = [];
	let total = 0;
	let i = text.indexOf(query);
	while (i !== -1) {
		total++;
		if (hits.length < limit) hits.push(ctxQuote(text, i, query.length, 24));
		i = text.indexOf(query, i + query.length);
	}
	return { hits, total };
}

// ---------------- 程序化验收（lint for prose） ----------------

export interface DraftRules {
	/** 正文字数区间（不含标签模块） */
	wordRange?: { min: number; max: number };
	/** 禁词表（预设「禁用词汇/黑名单」块里提取） */
	bannedWords: string[];
	/** 预设有比喻频率约束 */
	metaphorRule: boolean;
	/** 预设禁「不是…是…」先否后肯句式 */
	banNegPos: boolean;
	/** 必须出现的模块标签（每个都要在，如 w2g / draft_notes） */
	requiredTags: string[];
	/** 状态栏标签组（任一命中即可，如 StatusBlock / state1） */
	statusBarTagGroup: string[];
}

export function emptyDraftRules(): DraftRules {
	return { bannedWords: [], metaphorRule: false, banNegPos: false, requiredTags: [], statusBarTagGroup: [] };
}

/** 规则是否空到不值得跑核验 */
export function rulesAreEmpty(r: DraftRules): boolean {
	return (
		!r.wordRange &&
		r.bannedWords.length === 0 &&
		!r.metaphorRule &&
		!r.banNegPos &&
		r.requiredTags.length === 0 &&
		r.statusBarTagGroup.length === 0
	);
}

	// 兼容三种形态：<tag>（成对）、<tag >、<tag/>（自闭合占位符——界面由卡渲染）
	const TAG_IN_HINT_RE = /<([A-Za-z_][\w.-]*)\s*\/?\s*>/g;

/**
 * 「成文纪律」块判定（四阶段供料，2026-08-02 用户定案）：禁词表、禁八股、比喻原则、
 * 句式禁令等——全是对"已存在文字"做手术的规则。这类块**不进写作上下文**：
 * 初稿阶段只见文风/人称/字数/剧情类要求（写顺为先），纪律块全文随 draft_write
 * 的核验报告一起返还，作为精修阶段的靶子。写作时看不到细则=脑内验算无从发生；
 * 精修时才见=目标单一。带字数要求的块永远不算纪律块（写作时必须知道目标篇幅）。
 */
export function isPoliceBlock(content: string): boolean {
	if (!content) return false;
	if (/字数|response_length|word_count/i.test(content)) return false;
	// 供给特征优先：语料/词库类块（给写作供词的）即便夹带禁用词小节也留在写作台上——
	// 扣走词库=先用错词再挨个补（2026-08-02 TGbreak 瑟瑟语料实测误伤）
	if (/(语料|词库|多种表达|称呼：|称呼:)/.test(content)) return false;
	if (/(禁用词|词汇黑名单|厌恶的词汇|禁词表)/.test(content)) return true;
	// 英文键名的纪律块（双人成行「Claude 禁词表」形态：Forbidden_Expressions /
	// Writing_Proscription / Forbidden_Syntax_Styles）——2026-08-03 分桶审查发现漏网
	if (/(forbidden_(?:expressions?|syntax|words?)|writing_proscription|banned_(?:words?|phrases?))/i.test(content)) {
		return true;
	}
	if (/比喻/.test(content) && /(频率|段落内|宁缺毋滥|比喻词不重复|只允许使用1次)/.test(content)) return true;
	if (/(不是[…….]{1,3}是|先否定[再后]?肯定)/.test(content)) return true;
	if (/(禁八股|anti.?clich)/i.test(content) && /(禁止|黑名单|自检|改写)/.test(content)) return true;
	return false;
}

/**
 * 验算指令的句级特征（M4.5 慢因 B 残余，2026-08-03）。
 *
 * 块级分流（isPoliceBlock）只能整块留或整块撤，可**留在写作台上的文风块里仍夹带
 * 「每段写完自检 X」这类指令**——它们是脑内验算的直接燃料：模型会为每一条在思考里
 * 把正文逐句过一遍。这些活儿 harness 已经在做（checkDraft 程序化核验 + 精修阶段
 * 带原文和违规清单定点修订），写作阶段重做一遍纯属白烧墙钟。
 *
 * 判定对象是**单句/单行**，只摘「写完回头查」，留「怎么写」：
 *   摘：「每段写完后自检是否出现禁用句式」「输出前逐条核对上述要求」「检查完再输出」
 *   留：「以直接对白为主」「用具体感官细节」「段落之间联系紧密」
 */
const AUDIT_VERBS = /(自检|自查|检查|核对|复核|检视|校验|排雷|审查|确认(?:一遍|无误|是否)|回头看|回读|重读|逐条|逐句|逐段)/;
/**
 * 只认「已有文字再回头动手」这一类时机。**动笔前的一次性读题不算**——
 * 「每次回复前梳理要点写进 <draft_notes>」是预设自己的规划区，一轮一次，
 * 正是 harness 要的形态；摘掉它等于砸预设的规划结构（2026-08-03 语料实测）。
 * 贵的是粒度：逐句、逐段、写完再审，一轮里反复起草-复查。
 */
const AUDIT_TIMING =
	/(写完|写好|输出后|完成后|结束后|回复后|每段|每一段|每句|每一句|收笔|定稿|再输出|然后输出|才能输出|才可输出|方可输出|才能结束)/;

/**
 * 「读题遵循」不算验算：`$(检查并遵循<user_def>内的要求)`、`确保输出语言为…` 这类是
 * **动笔前**的读题与合规声明，摘掉等于把预设的要求本身撕了（2026-08-03 语料实测：
 * 双人成行的 draft_notes 清单大半是这个形态）。验算的定义是「对已写出的文字回头做手术」。
 */
const COMPLY_NOT_AUDIT = /(并遵循|遵循<|要求\)|确保遵循|检查开启|是否开启|开启了冲突)/;

/**
 * 单行是否为「验算指令」。要求同时命中「审查动作」与「事后时机」——
 * 只有动词（「检查设定是否冲突」属剧情理解）或只有时机（「每段聚焦一个角色」属写法）都不摘，
 * 宁可漏摘不可误伤（摘掉文风指令＝正文变差，比慢更糟）。
 */
export function isAuditLine(line: string): boolean {
	const t = line.trim();
	if (!t) return false;
	// 结构行（标签、分隔线、变量赋值）不参与判定
	if (/^[<{[]/.test(t) || /^[-=━─—\s]+$/.test(t)) return false;
	if (COMPLY_NOT_AUDIT.test(t)) return false;
	return AUDIT_VERBS.test(t) && AUDIT_TIMING.test(t);
}

/**
 * 块内句级过滤：摘掉验算指令行，保留其余原文。
 * 逐行处理（预设块几乎都是分行列点），不改动缩进与标签结构。
 * 返回 { text, dropped }——dropped 为被摘行数，0 表示原文照旧。
 */
export function stripAuditLines(content: string): { text: string; dropped: number } {
	if (!content) return { text: content, dropped: 0 };
	const lines = content.split("\n");
	const kept: string[] = [];
	let dropped = 0;
	for (const line of lines) {
		if (isAuditLine(line)) {
			dropped++;
			continue;
		}
		kept.push(line);
	}
	if (dropped === 0) return { text: content, dropped: 0 };
	// 摘行可能留下连续空行，收敛一下（不改非空行本身）
	const text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
	return { text, dropped };
}
/** 通用 HTML 标签不算模块标签 */
const GENERIC_TAGS = new Set(["details", "summary", "br", "div", "span", "p", "b", "i", "hr", "html", "body"]);
/**
 * 指代性标签不算输出模块：预设叙述里常用 <user>/<char> 指"用户/角色"本人
 * （2026-08-02 实测：TGbreak 行动选项块的「选择的内容是<user>的行动」被误判成必须模块，
 * 模型顺从地发明了一个 <user> 块塞进正文）。
 */
const REFERENT_TAGS = new Set(["user", "char", "assistant", "human", "system", "player_input", "bot"]);

/**
 * 从预设启用块原文 + 卡状态栏格式提取机械规则。
 * 解析不出的项就空着（checkDraft 对空项不报）——宁可漏验，不可误伤。
 */
export function extractDraftRules(blockContents: string[], statusBarFormats?: string[]): DraftRules {
	const rules = emptyDraftRules();

	for (const text of blockContents) {
		if (!text) continue;

		// 字数区间：限定在明确谈正文字数的块里（含 摘要 的 200-300 等不取）
		if (!rules.wordRange && /(正文|response_length|字数限制|字数设定|word_count)/.test(text)) {
			const m =
				/(\d{2,4})\s*(?:[-–—~～]|到|至)\s*(\d{2,4})\s*字/.exec(text) ??
				/[大]于\s*(\d{2,4})\D{0,14}?[小]于\s*(\d{2,4})/.exec(text);
			if (m) {
				const min = Number(m[1]);
				const max = Number(m[2]);
				if (Number.isFinite(min) && Number.isFinite(max) && min < max && min >= 50) {
					rules.wordRange = { min, max };
				}
			}
		}

		// 禁词表：只认明确的禁词块，块内取引号词
		if (/(禁用词|词汇黑名单|厌恶的词汇|禁词表)/.test(text)) {
			for (const qm of text.matchAll(/[“”"「]([^“”"」\n]{1,10})[“”"」]/g)) {
				const w = qm[1].trim();
				if (!w || w.length > 10) continue;
				if (/[{}$]/.test(w)) continue; // 宏残留
				if (/[…]/.test(w)) continue; // 句式示意（如 不是…是…），非字面词
				if (!rules.bannedWords.includes(w)) rules.bannedWords.push(w);
			}
		}

		if (!rules.metaphorRule && /比喻/.test(text) && /(频率|段落内|宁缺毋滥|比喻词不重复|只允许使用1次)/.test(text)) {
			rules.metaphorRule = true;
		}
		if (!rules.banNegPos && /(不是[…….]{1,3}是|先否定[再后]?肯定)/.test(text)) {
			rules.banNegPos = true;
		}

		// M-C 拆层后不再提取「选择框/draft_notes」类格式栈 requiredTags——预设的输出模块
		// （w2g/catsay/draft_notes/摘要）已由 agent 工具流与账本渲染承接（PLAN-RP-AGENT-EXEC §4）：
		// draft_check 不再逼模型手写格式块，卡状态栏组（statusBarTagGroup）仍验（卡的设计，不动）。
	}

	// 卡状态栏：任一格式命中即可
	for (const hint of statusBarFormats ?? []) {
		for (const tm of hint.matchAll(TAG_IN_HINT_RE)) {
			const tag = tm[1];
			if (GENERIC_TAGS.has(tag.toLowerCase()) || REFERENT_TAGS.has(tag.toLowerCase())) continue;
			if (!rules.statusBarTagGroup.includes(tag)) rules.statusBarTagGroup.push(tag);
		}
	}

	return rules;
}

export interface DraftReport {
	violations: string[];
	notes: string[];
	/** 正文（剥掉标签模块后）非空白字符数 */
	bodyChars: number;
	pass: boolean;
}

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 剥掉全部顶层标签块与 HTML 注释后的正文 */
export function extractDraftBody(turnText: string): string {
	let t = turnText.replace(/<!--[\s\S]*?-->/g, "");
	// 顶层标签块整块剥除（状态栏/w2g/catsay/draft_notes/details 等都不算正文）
	for (let pass = 0; pass < 4; pass++) {
		const blocks = scanTaggedBlocks(t);
		if (blocks.length === 0) break;
		let out = "";
		let cursor = 0;
		for (const b of blocks) {
			if (b.start > cursor) out += t.slice(cursor, b.start);
			cursor = b.end;
		}
		if (cursor < t.length) out += t.slice(cursor);
		if (out === t) break;
		t = out;
	}
	// 残留的孤立开闭标签行
	t = t.replace(/^\s*<\/?[A-Za-z_一-鿿][\w一-鿿.-]*(\s[^>]*)?>\s*$/gm, "");
	return t.trim();
}

/**
 * 引号内区域抹平——只看叙述层。
 *
 * 主权检查用它（角色在对白里说「你决定吧」是合法的）；比喻词规则同样需要
 * （见 checkDraft 内的 metaphorRule）。
 */
const stripQuotedSpans = (t: string): string =>
	t.replace(/「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|"[^"\n]*"/g, "〔对白〕");

/** 机械项核验：violations=必须修；notes=提示性（不拦） */
export function checkDraft(turnText: string, rules: DraftRules): DraftReport {
	const violations: string[] = [];
	const notes: string[] = [];
	const body = extractDraftBody(turnText);
	const bodyChars = body.replace(/\s+/g, "").length;

	if (rules.wordRange) {
		const { min, max } = rules.wordRange;
		// 字数只作提示（note），不作违规（violation）——8/09 定案：
		// 字数目标已由规划轮分配 + 【续写】卡兜底，封笔后不再判违规逼模型扩写
		// （那是末端修复的诱因：封笔报「字数不足」→ 模型在稿纸里补内容）。
		if (bodyChars < min) {
			notes.push(`正文 ${bodyChars} 字（不含标签模块），预设建议下限 ${min}。`);
		} else if (bodyChars > max) {
			notes.push(`正文 ${bodyChars} 字（不含标签模块），预设建议上限 ${max}。`);
		}
	}

	let bannedHits = 0;
	for (const w of rules.bannedWords) {
		let idx = body.indexOf(w);
		while (idx !== -1) {
			bannedHits++;
			if (bannedHits <= 5) violations.push(`禁词「${w}」：${ctxQuote(body, idx, w.length)}`);
			idx = body.indexOf(w, idx + w.length);
		}
	}
	if (bannedHits > 5) violations.push(`（禁词共 ${bannedHits} 处，以上仅列前 5）`);

	if (rules.banNegPos) {
		const m = /不是[^。！？\n]{1,24}[，,]?\s*而?是/.exec(body);
		if (m) violations.push(`「不是…是…」句式：${ctxQuote(body, m.index, m[0].length)}`);
	}

	if (rules.metaphorRule) {
		// 只扫叙述层：对白里的「像吗？」是人物在说话，不是作者在打比方。
		// 8/08 实弹——自然对白被计成 5 次比喻，模型两段思考全花在跟计数搏斗上，
		// 最后把对白改僵。可精确计数的文风判决会被当成待优化的分数（与字数螺旋同构）。
		const narrationOnly = stripQuotedSpans(body);
		const words = narrationOnly.match(/像|仿佛|如同|宛如|好似|犹如/g) ?? [];
		const paras = body.split(/\n\s*\n|\n/).filter((s) => s.trim().length > 0).length || 1;
		const limit = Math.max(1, Math.ceil(paras / 5));
		if (words.length > limit) {
			violations.push(`比喻词 ${words.length} 次 / ${paras} 段（预设约 5 段 1 次，上限约 ${limit}）——保留最必要的一处，其余改白描。`);
		} else if (words.length > 0) {
			notes.push(`比喻词 ${words.length} 次 / ${paras} 段，在限内。`);
		}
	}

	// 末端修复已彻底删除（8/09 定案）：requiredTags / statusBarTagGroup 不再判违规——
	// 状态栏/格式模块归**输出层**（模型最后一轮走 text 通道输出，mergeFinalText 拼接），
	// 不属于稿纸验收项。判违规会把模型逼进「封笔后稿纸里补」的末端修复，
	// 造成状态栏补两次、续写被未修违规拦截等连锁问题。
	// 字段保留（rulesAreEmpty / 提取逻辑仍引用），只是不再产生 violations。

	return { violations, notes, bodyChars, pass: violations.length === 0 };
}

/** 核验报告 → 回喂模型的文本 */
/**
 * 核验报告转可读回喂。
 *
 * `showChars=false`（未封笔）时不报字数：整拍字数目标 + 每段回传实测值会闭成误差环，
 * 实弹里模型的反思整段变成「还差 19 字」的算术，不再想戏（8/08 定案）。
 * 封笔后是验收场合，读数可见无害。
 */
export function formatDraftReport(r: DraftReport, showChars = true): string {
	const chars = showChars ? `（正文 ${r.bodyChars} 字）` : "";
	if (r.pass) {
		return `核验通过${chars}。${r.notes.length ? `\n${r.notes.join("\n")}` : ""}\n机械项无违规——不要再回头自查这些；若无其他修订，直接停笔收轮。`;
	}
	const lines = [
		`核验发现 ${r.violations.length} 处待修${chars}：`,
		...r.violations.map((v, i) => `${i + 1}. ${v}`),
		...r.notes,
		`逐处用 draft_edit 定点替换修正（old 逐字引用现稿原文、须唯一，可一次给多处）——不要重交全文；套用后会自动复验。`,
	];
	return lines.join("\n");
}

// ---------------- 用户主权红线（R5 第二层不变量，规则先行） ----------------

/** 命中点前若是建议/假设语气则放行（"你可以选择…"不是代做决定） */
const SOV_GUARD_RE = /(?:可以|可|能|能否|是否|要不要|不妨|请|建议|若|如果|假如|要是|除非|万一|无论)\s*$/;

/**
 * 用户主权检查：稿子是否替用户角色说话、代述内心、代做决定。
 * 精度优先——只抓恶性形态（带对白引导、内心动词、完成态决定动词），
 * 宁可漏报不可误伤；上限 6 条。动作复述（"你拱手行礼"）不在检查之列。
 */
export function checkSovereignty(turnText: string, userName: string, charName?: string): string[] {
	if (!userName.trim()) return [];
	const narration = stripQuotedSpans(extractDraftBody(turnText));
	const subj = `(?:${escapeReg(userName)}|你)`;
	const fixHint = charName ? `改为留白或以${charName}的观察侧写` : "改为留白或从旁观察";
	const checks: Array<{ re: RegExp; label: string }> = [
		// 主语在前的对白引导：你说：/沈舟答道："
		{ re: new RegExp(`${subj}[^。！？\\n听闻见觉]{0,4}(?:说|喊|答|回答|问|反问|开口)[道了]?\\s*[:：]`, "g"), label: "代写对白" },
		// 对白在前的归属：〔对白〕你低声说。
		{ re: new RegExp(`〔对白〕\\s*${subj}[^。！？\\n听闻见觉]{0,6}(?:说|道|答|问)`, "g"), label: "代写对白" },
		{ re: new RegExp(`${subj}(?:心想|心中暗|暗想|暗自想|暗自道|心道|腹诽|内心(?:一|暗|翻))`, "g"), label: "代述内心" },
		{ re: new RegExp(`${subj}(?:决定|选择|答应|同意|拒绝|默许)[了道]`, "g"), label: "代做决定" },
	];
	const out: string[] = [];
	for (const c of checks) {
		let m: RegExpExecArray | null = c.re.exec(narration);
		while (m && out.length < 6) {
			const before = narration.slice(Math.max(0, m.index - 8), m.index);
			if (!SOV_GUARD_RE.test(before)) {
				out.push(
					`${c.label}（用户主权）：${ctxQuote(narration, m.index, m[0].length)}——${userName} 的言行与决定只能由用户书写，${fixHint}。`,
				);
			}
			m = c.re.exec(narration);
		}
	}
	return out;
}
