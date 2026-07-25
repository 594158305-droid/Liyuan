/**
 * 预设宏求值器 —— ST 宏的最小核心集。
 *
 * 承诺边界（文档同步）：只支持 setvar / getvar / addvar / random / trim / {{//注释}} /
 * lastusermessage / char / user。清单外的 {{…}} 一律从送模文本中剥除并记入 unsupported，
 * 由调用方上报（显式降级）——绝不把宏字面量原样发给模型当噪声。
 *
 * 语义要点：
 * - 变量表挂在 MacroEnv 上，跨块共享：按预设块顺序依次求值，前面块 setvar、后面块 getvar。
 * - 求值内层优先（嵌套宏先解），setvar 的值为急切求值结果。
 * - 自引用等病态输入靠轮数上限兜底，残留 token 最终剥除。
 */

export interface MacroEnv {
	vars: Map<string, string>;
	charName: string;
	userName: string;
	/** 本轮用户原文（{{lastusermessage}}）；戏外/缺省为 undefined → 空串 */
	userText?: string;
}

export interface MacroEvalResult {
	text: string;
	/** 本次调用遇到的清单外宏名（去重） */
	unsupported: string[];
}

export function createMacroEnv(init: { charName: string; userName: string; userText?: string }): MacroEnv {
	return { vars: new Map(), charName: init.charName, userName: init.userName, userText: init.userText };
}

const MAX_PASSES = 16;
/** 内层优先的宏 token：{{ 到最近的 }}，内部不再含 {{ */
const TOKEN = /\{\{(?:(?!\{\{)[\s\S])*?\}\}/g;
const COMMENT = /\{\{\s*\/\/[\s\S]*?\}\}/g;
const TRIM = /\s*\{\{\s*trim\s*\}\}\s*/gi;

export function evalPresetMacros(text: string, env: MacroEnv): MacroEvalResult {
	const unsupported = new Set<string>();
	let t = text;
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const before = t;
		t = t.replace(COMMENT, "");
		t = t.replace(TRIM, "");
		t = t.replace(TOKEN, (token) => evalToken(token, env, unsupported));
		if (t === before) break;
	}
	// 轮数耗尽仍有残留（自引用等病态情形）：剥净，不发字面量
	t = t.replace(COMMENT, "").replace(TRIM, "").replace(/\{\{[\s\S]*?\}\}/g, "");
	return { text: t, unsupported: [...unsupported] };
}

function evalToken(token: string, env: MacroEnv, unsupported: Set<string>): string {
	const body = token.slice(2, -2);
	// 宏名：到第一个冒号/空白为止（兼容 {{random:a,b}} 单冒号旧写法）
	const nameMatch = body.match(/^\s*([^:\s{}]+)/);
	const name = (nameMatch?.[1] ?? "").toLowerCase();
	// 参数区：宏名后剥掉一个 :: 或 :
	const rest = body.slice((nameMatch?.[0] ?? "").length).replace(/^(::|:)/, "");

	switch (name) {
		case "char":
			return env.charName;
		case "user":
			return env.userName;
		case "lastusermessage":
			return env.userText ?? "";
		case "setvar": {
			const [key, ...valueParts] = rest.split("::");
			if (key !== undefined && key.trim()) env.vars.set(key.trim(), valueParts.join("::"));
			return "";
		}
		case "addvar": {
			const [key, ...valueParts] = rest.split("::");
			if (key !== undefined && key.trim()) {
				const k = key.trim();
				env.vars.set(k, (env.vars.get(k) ?? "") + valueParts.join("::"));
			}
			return "";
		}
		case "getvar":
			return env.vars.get(rest.split("::")[0]?.trim() ?? "") ?? "";
		case "random": {
			const args = rest.includes("::") ? rest.split("::") : rest.split(",");
			const picked = args[Math.floor(Math.random() * args.length)] ?? "";
			return picked;
		}
		default:
			if (name) unsupported.add(name);
			return "";
	}
}
