/**
 * 锚点对齐定位（插件 B draw-pipeline，DESIGN-draw §3.2 + Q10 的纯文本简化版）。
 *
 * LWB 四层定位策略简化：全文精确 → 最长子串 → 尾部 10 字符 → 去标点模糊。
 * 定位后做段落对齐：把插入点推到最近的段落边界（\n\n）处。
 * 产出 rp-draft-op replace 补丁（src/draft.ts DraftOp：{old, new}）；anchor 缺省 → append 补丁。
 * 纯函数零依赖。
 */

/** 锚点定位结果 */
export interface AnchorResult {
	ok: boolean;
	reason?: string;
}

/** 归一化：去标点/空白（用于模糊匹配；下标不回用，只判命中） */
function fuzzyNorm(s: string): string {
	return s.replace(/[\s，。！？；：、,.!?;:""''「」『』（）()—–\-…]/g, "").toLowerCase();
}

/**
 * 判定 anchor 是否命中某段正文（四层策略，与 buildInsertPatch 同款）：
 * ① 全文精确 → ② 最长子串 → ③ 尾部 10 字符 → ④ 去标点模糊。
 * 返回命中层级；未命中返回 null。纯函数零依赖。
 */
export function matchAnchor(
	text: string,
	anchor: string,
): "exact" | "substring" | "tail" | "fuzzy" | null {
	const anchorTrim = (anchor ?? "").trim();
	if (!text || !anchorTrim) return null;
	// ① 全文精确匹配
	if (text.indexOf(anchorTrim) !== -1) return "exact";
	// ② 最长子串匹配
	if (longestSubstring(text, anchorTrim)) return "substring";
	// ③ 尾部 10 字符
	const tail = anchorTrim.slice(-10);
	if (tail.length >= 3 && text.indexOf(tail) !== -1) return "tail";
	// ④ 去标点模糊：归一后匹配 anchor 的连续片段（正文确实包含该文字，仅标点/空白差异）
	const normText = fuzzyNorm(text);
	const normAnchor = fuzzyNorm(anchorTrim);
	if (normAnchor.length >= 3) {
		for (let len = normAnchor.length; len >= 3; len--) {
			for (let start = 0; start + len <= normAnchor.length; start++) {
				const sub2 = normAnchor.slice(start, start + len);
				if (normText.indexOf(sub2) !== -1) return "fuzzy";
			}
		}
	}
	return null;
}

/**
 * 全树搜索含 anchor 的条目（embedStoryImage 目标加固用，2026-08-12）：
 * 遍历全部 message 条目（不只当前分支），按 matchAnchor 四层策略找 anchor 命中的条目。
 * 多条命中取「最后出现的」（entries 按时间序 → 最近的叙事楼层）。
 * 返回 { entryId, matched }；未命中返回 null。纯函数零依赖。
 */
export function findEntryByAnchor(
	entries: Array<{ id: string; text: string }>,
	anchor: string,
): { entryId: string; matched: "exact" | "substring" | "tail" | "fuzzy" } | null {
	const anchorTrim = (anchor ?? "").trim();
	if (!anchorTrim) return null;
	let best: { entryId: string; matched: "exact" | "substring" | "tail" | "fuzzy" } | null = null;
	for (const e of entries) {
		if (!e.text) continue;
		const m = matchAnchor(e.text, anchorTrim);
		if (m) best = { entryId: e.id, matched: m };
	}
	return best;
}

/** 嵌入目标解析结果 */
export type EmbedTargetResult =
	| { ok: true; entryId: string; matched: "default" | "anchor" }
	| { ok: false; error: string };

/** 嵌入目标候选条目（roundId = 所属 user 指令轮，用于轮校验） */
export interface EmbedItem {
	id: string;
	text: string;
	/** 所属 user 指令轮的 entry id（无 user 祖先时缺省） */
	roundId?: string;
}

/**
 * 嵌入目标条目解析（embedStoryImage 目标加固，2026-08-12）：
 * - 默认目标 = branchIds 中最后一个「叙事条目」——含 assistant 回复与 rp-edited-reply
 *   改稿覆盖（改稿楼层也是最新叙事；历史缺陷：只认 message/assistant，改稿被跳过
 *   → 目标跳回更早楼层，配图嵌错）；
 * - anchor 非空且默认目标文本未命中 → 全树搜索含 anchor 的条目（跨分支/历史楼层）；
 * - 命中条目不在当前分支 → 报错（叶指针漂移/用户已回退，不静默嵌错）；
 * - 命中条目与默认目标不同轮（anchor 摘录自其他楼层）→ 报错（单楼层出图约束）；
 * - anchor 全树无命中 → 报错。
 * items：全部叙事条目（assistant message + rp-edited-reply，时间序）；branchIds：当前分支条目 id 序列。
 * 纯函数零依赖，可单测。
 */
export function resolveEmbedTarget(
	items: EmbedItem[],
	branchIds: string[],
	anchor: string | undefined,
): EmbedTargetResult {
	const anchorTrim = (anchor ?? "").trim();
	// 默认目标：branchIds 中最后出现的叙事条目（含 rp-edited-reply 改稿）
	let defaultEntry: EmbedItem | null = null;
	for (const it of items) {
		if (branchIds.includes(it.id)) defaultEntry = it;
	}
	if (!defaultEntry) return { ok: false, error: "暂无剧情消息可嵌入" };
	if (!anchorTrim) return { ok: true, entryId: defaultEntry.id, matched: "default" };
	// anchor 命中默认目标 → 用默认目标（插入点由 buildInsertPatch 再定位）
	if (matchAnchor(defaultEntry.text, anchorTrim)) {
		return { ok: true, entryId: defaultEntry.id, matched: "anchor" };
	}
	// 全树搜索（跨分支/历史楼层）
	const found = findEntryByAnchor(items, anchorTrim);
	if (!found) {
		return { ok: false, error: "anchor 未在剧情正文命中，无法确定嵌入位置（请确认 anchor 逐字摘录自最新剧情正文）" };
	}
	if (!branchIds.includes(found.entryId)) {
		return {
			ok: false,
			error: `目标楼层不在当前分支（anchor 命中 ${found.entryId.slice(0, 8)}…，已离开当前叙事），嵌入放弃——请先回到该分支再重试`,
		};
	}
	// 轮校验（2026-08-12 二次修复）：anchor 命中其他指令轮 = 摘录自非目标楼层
	// （历史案例：改稿楼层被跳过导致默认目标回跳，助手从旧楼层摘 anchor → 图全嵌错）
	const foundEntry = items.find((it) => it.id === found.entryId);
	if (
		found.entryId !== defaultEntry.id &&
		defaultEntry.roundId &&
		foundEntry?.roundId &&
		foundEntry.roundId !== defaultEntry.roundId
	) {
		return {
			ok: false,
			error: "anchor 摘录自其他楼层（非最新叙事轮），本次配图仅支持最新楼层——请确认配图目标楼层或先回到该楼层再重试",
		};
	}
	return { ok: true, entryId: found.entryId, matched: "anchor" };
}

/**
 * 配图嵌入目标解析（2026-08-14 事故修复）：
 * - 目标 = 分支最后一个「叙事条目」——assistant 回复 + rp-edited-reply 改稿覆盖
 *   （原实现只认 message/assistant，改稿楼层被跳过 → 目标回跳到更早楼层，
 *   branchCommit 钉回旧层把后续楼层切出分支视图）；
 * - clickedEntryId（配图按钮回传的点击楼层 entry id）非最新叙事层 → 拒绝
 *   （2026-08-14 用户裁决：历史楼层配图明确拒绝，生图前 fail-fast）。
 * 纯函数零依赖，可单测。
 */
export function resolveIllustrateTarget(
	branch: Array<{ id: string; type?: string; customType?: string; message?: { role?: string } | null }>,
	clickedEntryId?: string,
): { ok: true; entryId: string } | { ok: false; error: string } {
	const last = [...branch]
		.reverse()
		.find(
			(e) =>
				(e.type === "message" && e.message?.role === "assistant") ||
				(e.type === "custom_message" && e.customType === "rp-edited-reply"),
		);
	if (!last?.id) return { ok: false, error: "暂无剧情消息可嵌入" };
	if (clickedEntryId && clickedEntryId !== last.id) {
		return { ok: false, error: "该楼层之后还有楼层，配图仅支持最新叙事层——请对最新楼层配图（或先回退再配图）" };
	}
	return { ok: true, entryId: last.id };
}

/**
 * 目标之后是否还有叙事性条目（message 任意 role / custom_message）——存在则钉回叶指针
 * 会把它们切出当前分支视图（2026-08-14 事故的切割通道）。返回梗阻类型供报错措辞；
 * 无梗阻返回 null。纯函数零依赖，可单测。
 */
export function illustrateTargetObstruction(
	branch: Array<{ id: string; type?: string; customType?: string; message?: { role?: string } | null }>,
	targetId: string,
): "user" | "reply" | "custom_message" | null {
	const idx = branch.findIndex((e) => e.id === targetId);
	if (idx === -1) return null; // 目标不在分支：调用方先做存在性校验
	for (let i = idx + 1; i < branch.length; i++) {
		const t = branch[i];
		if (t.type === "custom_message") {
			// 编辑槽复用（方案 B 2026-08-16）：rp-edited-reply 槽是该楼的改写覆盖位，
			// 允许多次覆写复用（不新增叶）；其余自定义消息（如新改稿层/其他）才阻塞。
			if (t.customType === "rp-edited-reply") continue;
			return "custom_message";
		}
		if (t.type === "message") return t.message?.role === "user" ? "user" : "reply";
	}
	return null;
}

/** 在 text 中找 needle 的最长匹配片段（子串连续匹配；返回命中片段与原序） */
function longestSubstring(text: string, needle: string): { hit: string; index: number } | null {
	const lower = text.toLowerCase();
	const n = needle.toLowerCase();
	// 滑动窗口：从长到短尝试 needle 的连续子串
	for (let len = n.length; len >= 3; len--) {
		for (let start = 0; start + len <= n.length; start++) {
			const sub = n.slice(start, start + len);
			const idx = lower.indexOf(sub);
			if (idx !== -1) return { hit: needle.slice(start, start + len), index: idx };
		}
	}
	return null;
}

/**
 * 在正文中定位锚点并计算 rp-draft-op replace 补丁参数：
 * 策略：① 全文精确匹配 → ② 最长子串 → ③ 尾部 10 字符 → ④ 去标点模糊匹配；
 * 定位后做段落对齐：把插入点推到最近的段落边界（\n\n）处（anchor 命中段落末尾）；
 * 最终产出 replace 补丁 { old: 插入点前的稳定子串（>12 字符）, new: 该子串 + 占位符 }；
 * anchor 缺省 → 返回消息末尾 append 补丁 { append: 占位符 }。
 */
export function buildInsertPatch(
	text: string,
	anchor: string | undefined,
	placeholder: string,
): { ok: true; patch: Record<string, unknown> } | { ok: false; reason: string } {
	if (!text) return { ok: false, reason: "正文为空，无法定位插入点" };

	// anchor 缺省：消息末尾 append
	if (!anchor || !anchor.trim()) {
		return { ok: true, patch: { append: placeholder } };
	}
	const anchorTrim = anchor.trim();

	// ① 全文精确匹配（命中处推段落边界）
	const exactIdx = text.indexOf(anchorTrim);
	if (exactIdx !== -1) return alignAndBuildReplace(text, exactIdx + anchorTrim.length, placeholder);

	// ② 最长子串匹配
	const sub = longestSubstring(text, anchorTrim);
	if (sub) return alignAndBuildReplace(text, sub.index + sub.hit.length, placeholder);

	// ③ 尾部 10 字符：anchor 前 10 字符（去掉后可能仍长）在正文里找
	const tail = anchorTrim.slice(-10);
	if (tail.length >= 3) {
		const tailIdx = text.indexOf(tail);
		if (tailIdx !== -1) return alignAndBuildReplace(text, tailIdx + tail.length, placeholder);
	}

	// ④ 去标点模糊：归一后匹配 anchor 的连续片段
	const normText = fuzzyNorm(text);
	const normAnchor = fuzzyNorm(anchorTrim);
	if (normAnchor.length >= 3) {
		for (let len = normAnchor.length; len >= 3; len--) {
			for (let start = 0; start + len <= normAnchor.length; start++) {
				const sub2 = normAnchor.slice(start, start + len);
				const idx = normText.indexOf(sub2);
				if (idx !== -1) {
					// 归一下标不可直接回用，但可以取「正文里包含该片段」的原始位置附近：
					// 用归一串的片段在原文中按字符搜索（简化：按原始文本 indexOf 该子串的近似）
					// ——保守做法：用原文的原始子串再精确找一次
					const rawSub = anchorTrim.slice(start, start + len);
					const rawIdx = text.indexOf(rawSub);
					if (rawIdx !== -1) return alignAndBuildReplace(text, rawIdx + rawSub.length, placeholder);
					// 原始子串也找不到（纯标点差异）：放弃模糊，回退到文本末尾
					return { ok: true, patch: { append: placeholder } };
				}
			}
		}
	}

	return { ok: false, reason: "锚点在正文中未找到（全文/子串/尾部/模糊均未命中）" };
}

/** 在插入点处做段落对齐：把插入点推到最近的段落边界，再产出 replace 补丁 */
function alignAndBuildReplace(
	text: string,
	insertIdx: number,
	placeholder: string,
): { ok: true; patch: Record<string, unknown> } {
	let idx = insertIdx;
	// 向后推段落边界（\n\n）——若 anchor 命中段落中间，推到该段末尾
	const after = text.indexOf("\n\n", idx);
	if (after !== -1 && after < idx + 200) idx = after; // 只在附近找边界，避免跨太远
	// 取插入点前的稳定子串（尽量 >12 字符；不足则用更短）
	const from = Math.max(0, idx - 12);
	const old = text.slice(from, idx);
	// new = old + 占位符：old 与原文逐字一致才能被 replace 命中
	return { ok: true, patch: { old, new: `${old}${placeholder}` } };
}
