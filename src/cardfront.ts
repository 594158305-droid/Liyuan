/**
 * 卡前端(一档皮肤):从卡原始 JSON 提取 ST regex_scripts,筛出「显示向美化规则」。
 *
 * 筛选逻辑(spec §7 P1):!disabled && placement 含 2(AI 输出) && !(promptOnly && !markdownOnly)。
 * 清理向(promptOnly)规则不进显示层——harness 策略引擎(postprocess)已原生替代。
 * v1 不支持 trimStrings/substituteRegex:遇到整条跳过,宁缺毋错(显示错样式比没样式糟)。
 *
 * 载荷纪律:hello 与 GET /api/cardfront 必须同源(buildCardFrontSnapshot),避免「REST 有规则、对话流无规则」。
 */

import type { RpConfig } from "./types.ts";

export interface DisplayRule {
	name: string;
	/** 正则源文本(不含定界斜杠) */
	source: string;
	flags: string;
	replace: string;
}

/** 一档皮肤快照:wire hello / REST 共用,前端据此注入显示管线 */
export interface CardFrontSnapshot {
	enabled: boolean;
	hasSkin: boolean;
	rules: DisplayRule[];
	charName: string;
	userName: string;
}

/**
 * 从已读卡 raw 组装快照(纯函数,不读盘)。
 * raw=null 表示坏卡/读失败 → 无皮肤但仍返回结构,前端可清空。
 */
export function buildCardFrontSnapshot(
	config: { card: string; cardSkinOff?: string[]; userName: string },
	raw: Record<string, unknown> | null,
	charName: string,
): CardFrontSnapshot {
	const rules = raw ? displayRules(extractRegexScripts(raw)) : [];
	return {
		enabled: isSkinEnabled(config, config.card),
		hasSkin: rules.length > 0,
		rules,
		charName,
		userName: config.userName,
	};
}

/** ST 卡的 regex_scripts 数组(data.extensions 优先,顶层 extensions 兜底) */
export function extractRegexScripts(raw: Record<string, unknown>): unknown[] {
	const data = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : raw;
	const ext = data.extensions && typeof data.extensions === "object" ? (data.extensions as Record<string, unknown>) : {};
	return Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
}

/**
 * 卡作者是否设计了「状态栏」输出格式（美化正则 / 开场示例里的 StatusBlock、stateN 等）。
 * 用于 harness：有则剧情回合必须写状态栏——与用户预设是否开启无关。
 * 检测时**包含 disabled 规则**（作者设计仍在，只是显示开关）。
 */
export function cardStatusBarFormats(raw: Record<string, unknown> | null | undefined): string[] {
	if (!raw || typeof raw !== "object") return [];
	const found = new Set<string>();
	const note = (s: string) => {
		if (/StatusBlock|status_block/i.test(s)) found.add("`<StatusBlock>…</StatusBlock>`");
		if (/<\s*state\d+|state\\d|<\(state/i.test(s) || /多状态栏|状态展示/i.test(s)) {
			found.add("`<state1>…</state1>`（或卡约定的 state 序号）");
		}
		// 与 PANEL_NAME_RE / statusBlocks 对齐：这些标签渲染端都支持，检测端也要认
		if (/normal_?status/i.test(s)) found.add("`<normal_status>…</normal_status>`");
		if (/special_?status/i.test(s)) found.add("`<special_status>…</special_status>`");
		if (/char(?:acter)?_?status/i.test(s)) found.add("`<character_status>…</character_status>`");
		// 独立 <status> / <statusbar>（排除已被上面捕获的复合词）
		if (/<status[\s>]|<statusbar[\s>]/i.test(s) && !found.size) {
			found.add("`<status>…</status>`");
		}
	};
	for (const s of extractRegexScripts(raw)) {
		if (!s || typeof s !== "object") continue;
		const r = s as Record<string, unknown>;
		const blob = [
			typeof r.scriptName === "string" ? r.scriptName : "",
			typeof r.findRegex === "string" ? r.findRegex : "",
			typeof r.replaceString === "string" ? r.replaceString.slice(0, 400) : "",
		].join("\n");
		note(blob);
		// 卡作者自定义占位标签（如「模拟修仙」的 <StatusPlaceHolderImpl/>）：
		// 规则名含"状态栏/status"、findRegex 含 <Tag> 或 <Tag/> → 视为卡自定义状态栏格式。
		// 不能只扫内容——标签名千变万化，scriptName 是唯一可靠的意图信号。
		const name = typeof r.scriptName === "string" ? r.scriptName : "";
		const find = typeof r.findRegex === "string" ? r.findRegex : "";
		if (/状态栏|status/i.test(name) && !found.size) {
			const tagM = find.match(/<([A-Za-z_][\w]*)\s*\/?>/);
			if (tagM) {
				const tag = tagM[1];
				// 自闭合占位 <Tag/> vs 成对 <Tag>…</Tag>
				const selfClose = find.includes("/>");
				found.add(selfClose ? `\`<${tag}/>\`` : `\`<${tag}>…</${tag}>\``);
			}
		}
	}
	const data = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Record<string, unknown>;
	const greet = [
		typeof data.first_mes === "string" ? data.first_mes : "",
		...(Array.isArray(data.alternate_greetings) ? data.alternate_greetings.map((g) => String(g ?? "")) : []),
	].join("\n");
	note(greet);
	// 卡说明 / 系统提示 / 后置指令也可能定义状态栏格式（不只在显示正则和开场白里）
	for (const field of ["description", "system_prompt", "post_history_instructions", "personality"] as const) {
		const v = data[field];
		if (typeof v === "string" && v) note(v);
	}
	return [...found];
}

/** "/pattern/flags" → {source, flags};裸串按字面源、默认 g */
function parseFindRegex(find: string): { source: string; flags: string } | null {
	const m = /^\/([\s\S]+)\/([a-z]*)$/.exec(find.trim());
	const source = m ? m[1] : find;
	const flags = m?.[2] || "g";
	try {
		new RegExp(source, flags);
	} catch {
		return null;
	}
	return { source, flags };
}

export function displayRules(scripts: unknown[]): DisplayRule[] {
	const out: DisplayRule[] = [];
	for (const s of scripts) {
		if (!s || typeof s !== "object") continue;
		const r = s as Record<string, unknown>;
		if (r.disabled === true) continue;
		const placement = Array.isArray(r.placement) ? r.placement : [];
		if (!placement.includes(2)) continue; // 2 = AI 输出
		if (r.promptOnly === true && r.markdownOnly !== true) continue; // 纯送模侧,显示层不管
		if (Array.isArray(r.trimStrings) && r.trimStrings.length > 0) {
			console.warn(`[cardfront] 规则「${String(r.scriptName ?? "?")}」用了 trimStrings,v1 不支持,跳过`);
			continue;
		}
		if (typeof r.substituteRegex === "number" && r.substituteRegex !== 0) {
			console.warn(`[cardfront] 规则「${String(r.scriptName ?? "?")}」用了 substituteRegex,v1 不支持,跳过`);
			continue;
		}
		// v1 明确不支持深度限定,忽略但提示(规则仍应用)
		if (r.minDepth != null || r.maxDepth != null) {
			console.warn(`[cardfront] 规则「${String(r.scriptName ?? "?")}」的深度限定被忽略`);
		}
		const find = typeof r.findRegex === "string" ? r.findRegex : "";
		if (!find.trim()) continue;
		const parsed = parseFindRegex(find);
		if (!parsed) {
			console.warn(`[cardfront] 规则「${String(r.scriptName ?? "?")}」正则无法解析,跳过`);
			continue;
		}
		out.push({
			name: typeof r.scriptName === "string" ? r.scriptName : "",
			source: parsed.source,
			flags: parsed.flags,
			replace: typeof r.replaceString === "string" ? r.replaceString : "",
		});
	}
	return out;
}

/** 皮肤开关:默认开;关过的卡记在 config.cardSkinOff(路径列表,同 disabledLore 模式) */
export function isSkinEnabled(config: { card: string; cardSkinOff?: string[] }, cardPath: string): boolean {
	return !(config.cardSkinOff ?? []).includes(cardPath);
}

export function setSkinEnabled(config: RpConfig, cardPath: string, enabled: boolean): RpConfig {
	const cur = config.cardSkinOff ?? [];
	const next = enabled ? cur.filter((p) => p !== cardPath) : cur.includes(cardPath) ? cur : [...cur, cardPath];
	return { ...config, cardSkinOff: next };
}
