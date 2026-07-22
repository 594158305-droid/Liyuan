/**
 * 对话流正文切分（RichContent 真路径，纯函数可测）。
 *
 * 顺序纪律（spec §7 P1 + skeptic fix）：
 * 1) 卡皮肤正则先认领 StatusBlock 等 → 卡作者 HTML
 * 2) 顶层标准容器 / 围栏 HTML 先切出（保护皮肤产物内的 <status> 不被状态面板撕碎）
 * 3) 仅在剩余纯文本上再跑 splitStatusParts → 梨园统一状态卡
 */

import type { DisplayRule } from "../../src/cardfront.ts";
import { applyCardSkin } from "./cardSkin.ts";
import { splitHtmlParts } from "./htmlEmbed.ts";
import { splitStatusParts, stripOrphanStatusTags } from "./statusBlocks.ts";

export type RichPart =
	| { kind: "text"; text: string }
	| { kind: "status"; tag: string; body: string }
	| { kind: "html"; html: string; scripts: boolean };

export type SkinMacros = { rules: DisplayRule[]; charName: string; userName: string };

/**
 * 与 Messages.RichContent 同序：skin → HTML 块 → 状态标签 → 纯文本。
 * 返回可直接映射到 Paragraphs / StatusPanel / HtmlFrame 的序列。
 */
export function splitRichContentParts(text: string, skin?: SkinMacros | null): RichPart[] {
	const skinned = skin && skin.rules.length > 0 ? applyCardSkin(text, skin.rules, skin) : text;
	// 先认领 HTML：皮肤产物（div 包 status）与 ```html 围栏整块进 html 段
	const htmlClaimed = splitHtmlParts(skinned);
	const out: RichPart[] = [];
	for (const p of htmlClaimed) {
		if (p.kind === "html") {
			out.push({ kind: "html", html: p.html, scripts: p.scripts });
			continue;
		}
		// 仅剩余文本：未皮肤的 StatusBlock 等落梨园状态卡
		for (const s of splitStatusParts(p.text)) {
			if (s.kind === "status") {
				out.push({ kind: "status", tag: s.tag, body: s.body });
			} else if (s.text.trim()) {
				out.push({ kind: "text", text: stripOrphanStatusTags(s.text) });
			}
		}
	}
	return out;
}
