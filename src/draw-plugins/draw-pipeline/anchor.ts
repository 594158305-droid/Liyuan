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
