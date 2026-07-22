/**
 * 一档卡皮肤:在显示文本上应用卡作者的美化正则(spec §7 P1)。
 * 只跑显示层——送模历史在 server 侧另有裁剪,此处产物绝不回流。
 * 单条规则失败静默跳过:显示层宁可少化妆,不能白屏。
 */

import type { DisplayRule } from "../../src/cardfront.ts";

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function substMacros(text: string, macros: { charName: string; userName: string }, forRegex: boolean): string {
	const char = forRegex ? escapeReg(macros.charName) : macros.charName;
	const user = forRegex ? escapeReg(macros.userName) : macros.userName;
	return text.replace(/\{\{\s*char\s*\}\}/gi, char).replace(/\{\{\s*user\s*\}\}/gi, user);
}

export function applyCardSkin(
	text: string,
	rules: DisplayRule[],
	macros: { charName: string; userName: string },
): string {
	let out = text;
	for (const r of rules) {
		try {
			const re = new RegExp(substMacros(r.source, macros, true), r.flags);
			const replace = substMacros(r.replace, macros, false).replace(/\{\{\s*match\s*\}\}/gi, "$$&");
			out = out.replace(re, replace);
		} catch {
			// 单条坏规则不拖累整条管线
		}
	}
	return out;
}
