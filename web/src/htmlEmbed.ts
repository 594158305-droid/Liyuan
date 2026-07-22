/**
 * 对话流 HTML 底座：从正文中切出 ```html 代码块 / 整页文档 / 顶层标准容器块，供 Messages 渲染。
 * 卡皮肤产物（div 等）在此切成 html 段进无痕帧；自定义状态标签不在此列。
 */

export type TextPart =
	| { kind: "text"; text: string }
	| { kind: "html"; html: string; /** 围栏标记 scripts / +js 时为 true */ scripts: boolean };

/** 标准容器标签白名单:皮肤/界面产物以它们开头;自定义标签(状态栏族)绝不在此列 */
const BLOCK_TAGS = /^(div|section|article|table|figure|details|style)$/i;

/** 在纯文本段中切出行首起始、深度配平的标准 HTML 块 */
function splitTopLevelBlocks(text: string): TextPart[] {
	const openRe = /^[ \t]*<(\w+)(\s[^>]*)?>/gm;
	const parts: TextPart[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = openRe.exec(text)) !== null) {
		const tag = m[1];
		if (!BLOCK_TAGS.test(tag)) continue;
		// 从开标签起做同名深度配平
		const tagRe = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, "gi");
		tagRe.lastIndex = m.index;
		let depth = 0;
		let end = -1;
		let t: RegExpExecArray | null;
		while ((t = tagRe.exec(text)) !== null) {
			depth += t[1] ? -1 : 1;
			if (depth === 0) {
				end = t.index + t[0].length;
				break;
			}
		}
		if (end < 0) continue; // 未闭合:整段留作文本
		const before = text.slice(last, m.index);
		if (before.trim()) parts.push({ kind: "text", text: before });
		parts.push({ kind: "html", html: text.slice(m.index, end).trim(), scripts: false });
		last = end;
		openRe.lastIndex = end;
	}
	if (parts.length === 0) return [{ kind: "text", text }];
	const rest = text.slice(last);
	if (rest.trim()) parts.push({ kind: "text", text: rest });
	return parts;
}

/**
 * 拆分：```html ... ``` / ```html scripts ... ``` / ```html+js ... ```
 * 未闭合的围栏当普通文本。随后对 text 段再扫行首标准容器块。
 */
export function splitHtmlParts(text: string): TextPart[] {
	if (!text) return [];
	// lang: html | html scripts | html+js | html+script
	const re = /```html(?:\s*\+?\s*(?:scripts?|js))?[ \t]*\r?\n([\s\S]*?)```/gi;
	const parts: TextPart[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) {
			const chunk = text.slice(last, m.index);
			if (chunk) parts.push({ kind: "text", text: chunk });
		}
		const fence = m[0].slice(0, m[0].indexOf("\n") >= 0 ? m[0].indexOf("\n") : 8);
		const scripts = /\bscripts?\b|\bjs\b|\+/i.test(fence);
		const html = m[1].replace(/^\uFEFF/, "").trim();
		if (html) parts.push({ kind: "html", html, scripts });
		last = m.index + m[0].length;
	}
	if (last < text.length) {
		const rest = text.slice(last);
		if (rest) parts.push({ kind: "text", text: rest });
	}
	// 整段就是 HTML 文档（无围栏）——常见于部分卡 first_mes
	if (parts.length === 1 && parts[0].kind === "text" && looksLikeHtmlDocument(parts[0].text)) {
		return [{ kind: "html", html: parts[0].text.trim(), scripts: false }];
	}
	const base = parts.length > 0 ? parts : [{ kind: "text", text } as TextPart];
	// 文本段二次扫描:行首标准容器块(皮肤产物)切成 html 段
	return base.flatMap((p) => (p.kind === "text" ? splitTopLevelBlocks(p.text) : [p]));
}

/** 粗判：整段以 doctype/html 开头的文档 */
export function looksLikeHtmlDocument(text: string): boolean {
	const t = text.trimStart().slice(0, 200).toLowerCase();
	return t.startsWith("<!doctype html") || t.startsWith("<html");
}

/** 整条消息就是一个界面(单 html 段、无正文残留)——整楼模式判定(spec §4 落位 1) */
export function isFullInterface(text: string): boolean {
	const parts = splitHtmlParts(text);
	return parts.length === 1 && parts[0].kind === "html";
}
