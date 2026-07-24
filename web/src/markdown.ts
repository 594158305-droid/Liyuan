/**
 * 对话流轻量 markdown 切分（纯函数，可 node:test）。
 *
 * 不全量 CommonMark：只做与酒馆观感对齐、选项/正文可分所需的子集。
 * - 围栏代码块 ``` / ```lang … ```
 * - 其余仍走 Paragraphs 的 RP 排版（*动作*、对白）
 *
 * Options 等标签在服务端 unwrap 后常留下无 lang 围栏；此处收成代码块，
 * 围栏字符本身不显示，块有独立底色与正文区分。
 */

export type MdPart =
	| { kind: "text"; text: string }
	| { kind: "code"; lang: string; code: string };

/**
 * 切出 markdown 围栏代码块；未闭合围栏当普通文本。
 * 仅认行首 ```（起点为 0 或前一字符为换行）。
 */
export function splitMarkdownParts(text: string): MdPart[] {
	if (!text) return [];
	const re = /```([^\n`]*)\r?\n([\s\S]*?)\r?\n```[ \t]*/g;
	const parts: MdPart[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		// 行首约束
		if (m.index > 0 && text[m.index - 1] !== "\n") {
			continue;
		}
		if (m.index > last) {
			parts.push({ kind: "text", text: text.slice(last, m.index) });
		}
		parts.push({
			kind: "code",
			lang: (m[1] ?? "").trim(),
			code: (m[2] ?? "").replace(/\s+$/g, ""),
		});
		last = m.index + m[0].length;
		// 闭合后多余换行并入下一段起点，避免代码块后多一空段
		if (text[last] === "\r" && text[last + 1] === "\n") last += 2;
		else if (text[last] === "\n") last += 1;
		re.lastIndex = last;
	}
	if (last < text.length) {
		const rest = text.slice(last);
		if (rest) parts.push({ kind: "text", text: rest });
	}
	return parts.length > 0 ? parts : [{ kind: "text", text }];
}
