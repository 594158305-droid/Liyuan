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

/**
 * 嵌入目标条目解析（embedStoryImage 目标加固，2026-08-12）：
 * - 默认目标 = branchIds 中最后一条 assistant 条目（items 按时间序，取最后命中分支的）；
 * - anchor 非空且默认目标文本未命中 → 全树搜索含 anchor 的条目（跨分支/历史楼层）；
 * - 命中条目不在当前分支 → 报错（叶指针漂移/用户已回退，不静默嵌错——历史 bug：
 *   叶漂移后 8 张图全嵌进错误楼层，根因即 anchor 只定插入位、不参与选目标）；
 * - anchor 全树无命中 → 报错。
 * items：全部 assistant 条目（id + 提取后的显示文本，时间序）；branchIds：当前分支条目 id 序列。
 * 纯函数零依赖，可单测。
 */
export function resolveEmbedTarget(
	items: Array<{ id: string; text: string }>,
	branchIds: string[],
	anchor: string | undefined,
): EmbedTargetResult {
	const anchorTrim = (anchor ?? "").trim();
	// 默认目标：branchIds 中最后出现的 assistant 条目
	let defaultEntry: { id: string; text: string } | null = null;
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
	return { ok: true, entryId: found.entryId, matched: "anchor" };
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
