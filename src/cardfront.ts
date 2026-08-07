/**
 * 卡前端(一档皮肤):从卡原始 JSON 提取 ST regex_scripts,筛出「显示向美化规则」。
 *
 * 筛选逻辑(spec §7 P1):!disabled && placement 含 2(AI 输出) && !(promptOnly && !markdownOnly)。
 * 清理向(promptOnly)规则不进显示层——harness 策略引擎(postprocess)已原生替代。
 * trimStrings/substituteRegex 由 cardSkin.ts 引擎原生支持,此处只透传不拦截;
 * minDepth/maxDepth 显示层不生效,忽略但提示。
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
	/** ST 卡规则自带的唯一 id(透传自 regex_scripts 的 id 字段;无则缺省,关闭键回落 name/source) */
	id?: string;
	/** @deprecated 旧用户规则关闭字段;新写入一律用 disabled。isRuleOff 兼容读取两者 */
	off?: boolean;
	/** 统一开关字段:true=规则关闭。兼容读:`disabled === true || off === true`(新写入用 disabled) */
	disabled?: boolean;
	/** 修剪:替换前从捕获值中逐个剔除的子串(编辑器回车分隔);可含 {{char}}/{{user}} 宏 */
	trimStrings?: string[];
	/** 作用范围多选:1=用户输入/2=AI输出/3=快捷命令/5=世界信息/6=推理;缺省视为 [2] */
	placement?: number[];
	/** 编辑消息时运行(显示层不生效,仅字段存储) */
	runOnEdit?: boolean;
	/** 查找时宏替换档位:0=不替换(字面宏) 1=raw 2=escaped;字段缺失(undefined)=escaped(历史行为) */
	substituteRegex?: 0 | 1 | 2;
	/** 深度下限(null/undefined=无限;显示层不生效,仅字段存储) */
	minDepth?: number | null;
	/** 深度上限(null/undefined=无限;显示层不生效,仅字段存储) */
	maxDepth?: number | null;
	/** 仅格式显示(短暂;显示层过滤不靠它,仅存储透传) */
	markdownOnly?: boolean;
	/** 仅格式提示词(短暂;显示层过滤不靠它,仅存储透传) */
	promptOnly?: boolean;
}

/** 正则脚本分组(全局/角色/预设三分类共用的组结构) */
export interface RuleGroup {
	/** 组名;空串 = 未分组(永远保留一组未分组,禁删) */
	name: string;
	/** 整组开关:off=true 时组内全部规则不生效(默认开) */
	off?: boolean;
	rules: DisplayRule[];
}

/** 一档皮肤快照:wire hello / REST 共用,前端据此注入显示管线 */
export interface CardFrontSnapshot {
	enabled: boolean;
	hasSkin: boolean;
	/** 生效规则合并列表:卡内嵌未关闭规则 + 全局组展开 + 角色组展开 + 预设组展开(越具体越后应用) */
	rules: DisplayRule[];
	/** 卡内嵌规则全量(筛选后,含被用户关闭的),UI 展示用 */
	cardRules: DisplayRule[];
	/** @deprecated 旧平铺用户规则(仅 config.userRules 残留时非空);新形态见 userGroups */
	userRules: DisplayRule[];
	/** 全局正则分组(含旧 userRules 迁移读取) */
	userGroups: RuleGroup[];
	/** 当前卡的角色正则分组 */
	cardGroups: RuleGroup[];
	/** 当前活跃预设的正则分组(预设文件本体,不随草稿) */
	presetGroups: RuleGroup[];
	/** 当前卡被用户关闭的卡内嵌规则键列表(ruleKey:id/name/source) */
	ruleOff: string[];
	/** 当前卡被覆盖的卡内嵌规则键列表(ruleKey;覆盖挂原始键,改名/改 id 不影响) */
	overrides: string[];
	charName: string;
	userName: string;
}

/**
 * 从已读卡 raw 组装快照(纯函数,不读盘)。
 * raw=null 表示坏卡/读失败 → 无皮肤但仍返回结构,前端可清空。
 */
export function buildCardFrontSnapshot(
	config: RpConfig,
	raw: Record<string, unknown> | null,
	charName: string,
	presetGroups?: RuleGroup[],
): CardFrontSnapshot {
	const rawRules = raw ? displayRules(extractRegexScripts(raw)) : [];
	const overrides = cardOverridesOf(config, config.card);
	const ruleOff = (config.cardRuleOff ?? {})[config.card] ?? [];
	const offKeys = new Set(ruleOff);
	// 卡内嵌规则应用覆盖层:键仍用原始 ruleKey(r),覆盖挂在该键下;cardRules 存生效后的 eff(UI 展示编辑后内容)。
	// 关闭判定:生效后的 eff 参与 isRuleOff(eff) || ruleOff.includes(原始键)(键不受覆盖影响)。
	const cardRules: DisplayRule[] = [];
	const cardEffective: DisplayRule[] = [];
	for (const r of rawRules) {
		const key = ruleKey(r);
		// 覆盖生效:强制回填原始键为 eff.id,保证 ruleKey(eff)===key 恒成立(前端编辑载荷无 id,
		// 不回填会导致「已修改」标记/开关/后续编辑的键失配)
		const eff = key in overrides ? { ...overrides[key], id: key } : r;
		cardRules.push(eff);
		if (!offKeys.has(key) && !isRuleOff(eff)) cardEffective.push(eff);
	}
	// 生效列表:卡内嵌未关闭规则(已应用覆盖) → 全局组 → 当前卡组 → 预设组(越具体越后应用)
	const rules = [
		...cardEffective,
		...expandGroups(userGroupsOf(config)),
		...expandGroups(cardGroupsOf(config, config.card)),
		...expandGroups(presetGroups ?? []),
	];
	return {
		enabled: isSkinEnabled(config, config.card),
		hasSkin: rawRules.length > 0, // hasSkin 语义不变:仍指卡内嵌规则存在(与生效 rules 无关)
		rules,
		cardRules,
		userRules: config.userRules ?? [],
		userGroups: userGroupsOf(config),
		cardGroups: cardGroupsOf(config, config.card),
		presetGroups: presetGroups ?? [],
		ruleOff,
		overrides: Object.keys(overrides),
		charName,
		userName: config.userName,
	};
}

/** 规则关闭键:id 优先,name 次之,最后回落 source(卡内嵌规则关闭的持久化引用) */
export function ruleKey(r: DisplayRule): string {
	return r.id ?? r.name ?? r.source;
}

/** 规则是否关闭:disabled 与旧 off 双兼容(新写入用 disabled,旧数据仍可读 off) */
export function isRuleOff(r: DisplayRule): boolean {
	return r.disabled === true || r.off === true;
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

/** "/pattern/flags" → {source, flags};裸串按字面源、默认 g;正则可编译失败返回 null */
export function parseFindRegex(find: string): { source: string; flags: string } | null {
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
		// trimStrings/substituteRegex 已由引擎(cardSkin.ts)原生支持,不再整条跳过
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
		const rule: DisplayRule = {
			name: typeof r.scriptName === "string" ? r.scriptName : "",
			source: parsed.source,
			flags: parsed.flags,
			replace: typeof r.replaceString === "string" ? r.replaceString : "",
		};
		// ST 规则自带的 id 字段透传,作为该规则在 config.cardRuleOff 里的关闭键
		if (typeof r.id === "string" && r.id) rule.id = r.id;
		// 透传 ST 新字段:显示层引擎(cardSkin.ts)/前端规则管理 UI 按需读取(原样透传,false 也保留)
		if (typeof r.disabled === "boolean") rule.disabled = r.disabled;
		if (Array.isArray(r.trimStrings)) rule.trimStrings = r.trimStrings as string[];
		if (Array.isArray(r.placement)) rule.placement = r.placement as number[];
		if (typeof r.runOnEdit === "boolean") rule.runOnEdit = r.runOnEdit;
		if (typeof r.substituteRegex === "number" && (r.substituteRegex === 0 || r.substituteRegex === 1 || r.substituteRegex === 2)) {
			rule.substituteRegex = r.substituteRegex;
		}
		if (r.minDepth === null || typeof r.minDepth === "number") rule.minDepth = r.minDepth;
		if (r.maxDepth === null || typeof r.maxDepth === "number") rule.maxDepth = r.maxDepth;
		if (typeof r.markdownOnly === "boolean") rule.markdownOnly = r.markdownOnly;
		if (typeof r.promptOnly === "boolean") rule.promptOnly = r.promptOnly;
		out.push(rule);
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

// ---------- 作用域读写(全局/角色组;纯函数,只返回新配置,不落盘) ----------

/** 全局正则分组读取(config.userRuleGroups;旧平铺 userRules 自动迁移为未分组组) */
export function userGroupsOf(config: RpConfig): RuleGroup[] {
	if (config.userRuleGroups) return config.userRuleGroups;
	if (Array.isArray(config.userRules)) return [{ name: "", rules: config.userRules }];
	return [];
}

/** 写入全局分组形态(同时清掉旧平铺 userRules,避免下次读取再迁移;JSON.stringify 会丢掉 undefined) */
export function setUserGroups(config: RpConfig, groups: RuleGroup[]): RpConfig {
	return { ...config, userRuleGroups: groups, userRules: undefined };
}

/** 当前卡的角色正则分组读取 */
export function cardGroupsOf(config: RpConfig, cardPath: string): RuleGroup[] {
	return (config.cardRuleGroups ?? {})[cardPath] ?? [];
}

/** 写入角色分组形态 */
export function setCardGroups(config: RpConfig, cardPath: string, groups: RuleGroup[]): RpConfig {
	return { ...config, cardRuleGroups: { ...(config.cardRuleGroups ?? {}), [cardPath]: groups } };
}

// ---------- 组列表纯操作(输入/输出都是 RuleGroup[],可跨作用域复用) ----------

/** 追加新组(空规则列表)到末尾 */
export function addGroup(groups: RuleGroup[], name: string): RuleGroup[] {
	return [...groups, { name, rules: [] }];
}

/** 更新组名/整组开关(越界原样返回) */
export function updateGroup(groups: RuleGroup[], index: number, patch: { name?: string; off?: boolean }): RuleGroup[] {
	if (index < 0 || index >= groups.length) return groups;
	const g = { ...groups[index] };
	if (patch.name !== undefined) g.name = patch.name;
	if (patch.off !== undefined) g.off = patch.off;
	const next = groups.slice();
	next[index] = g;
	return next;
}

/** 删除组(未分组组 name=="" 禁删,原样返回) */
export function removeGroup(groups: RuleGroup[], index: number): RuleGroup[] {
	if (index < 0 || index >= groups.length) return groups;
	if (groups[index].name === "") return groups;
	return groups.filter((_, i) => i !== index);
}

/** 上下移动组(delta=-1 上移 / 1 下移,相邻交换;越界原样返回) */
export function moveGroup(groups: RuleGroup[], index: number, delta: -1 | 1): RuleGroup[] {
	const j = index + delta;
	if (index < 0 || index >= groups.length || j < 0 || j >= groups.length) return groups;
	const next = groups.slice();
	[next[index], next[j]] = [next[j], next[index]];
	return next;
}

// ---------- 组内规则纯操作 ----------

/** 向指定组追加规则(groupIndex 越界原样返回) */
export function addRule(groups: RuleGroup[], groupIndex: number, rule: DisplayRule): RuleGroup[] {
	if (groupIndex < 0 || groupIndex >= groups.length) return groups;
	const next = groups.slice();
	const g = groups[groupIndex];
	next[groupIndex] = { ...g, rules: [...g.rules, rule] };
	return next;
}

/** 更新规则;toGroup 缺省=原地,提供则跨组移动(原组移除、目标组追加)。任一越界原样返回 */
export function updateRule(
	groups: RuleGroup[],
	groupIndex: number,
	ruleIndex: number,
	rule: DisplayRule,
	toGroup?: number,
): RuleGroup[] {
	if (groupIndex < 0 || groupIndex >= groups.length) return groups;
	const src = groups[groupIndex];
	if (ruleIndex < 0 || ruleIndex >= src.rules.length) return groups;
	const dest = toGroup === undefined ? groupIndex : toGroup;
	if (dest < 0 || dest >= groups.length) return groups;
	const next = groups.slice();
	if (dest === groupIndex) {
		const g = { ...src, rules: src.rules.slice() };
		g.rules[ruleIndex] = rule;
		next[groupIndex] = g;
	} else {
		next[groupIndex] = { ...src, rules: src.rules.filter((_, i) => i !== ruleIndex) };
		const dst = groups[dest];
		next[dest] = { ...dst, rules: [...dst.rules, rule] };
	}
	return next;
}

/** 删除组内规则(越界原样返回) */
export function removeRule(groups: RuleGroup[], groupIndex: number, ruleIndex: number): RuleGroup[] {
	if (groupIndex < 0 || groupIndex >= groups.length) return groups;
	const src = groups[groupIndex];
	if (ruleIndex < 0 || ruleIndex >= src.rules.length) return groups;
	const next = groups.slice();
	next[groupIndex] = { ...src, rules: src.rules.filter((_, i) => i !== ruleIndex) };
	return next;
}

/** 组内上下移动规则(相邻交换;越界原样返回) */
export function moveRule(groups: RuleGroup[], groupIndex: number, ruleIndex: number, delta: -1 | 1): RuleGroup[] {
	if (groupIndex < 0 || groupIndex >= groups.length) return groups;
	const src = groups[groupIndex];
	const j = ruleIndex + delta;
	if (ruleIndex < 0 || ruleIndex >= src.rules.length || j < 0 || j >= src.rules.length) return groups;
	const rules = src.rules.slice();
	[rules[ruleIndex], rules[j]] = [rules[j], rules[ruleIndex]];
	const next = groups.slice();
	next[groupIndex] = { ...src, rules };
	return next;
}

/** 展开生效规则:组 off!==true 且规则未关闭(disabled/off),按组序/组内序 */
export function expandGroups(groups: RuleGroup[]): DisplayRule[] {
	const out: DisplayRule[] = [];
	for (const g of groups) {
		if (g.off === true) continue;
		for (const r of g.rules) {
			if (isRuleOff(r)) continue;
			out.push(r);
		}
	}
	return out;
}

/** 复制组整体追加到目标:目标已有同名组 → 「原名 (副本)」,再撞则「原名 (副本 2)」…;无同名用原名 */
export function copyGroup(groups: RuleGroup[], fromIndex: number, targetGroups: RuleGroup[]): RuleGroup[] {
	if (fromIndex < 0 || fromIndex >= groups.length) return targetGroups;
	const src = groups[fromIndex];
	const names = new Set(targetGroups.map((g) => g.name));
	const name = nextGroupName(src.name, names);
	return [...targetGroups, { ...src, name, rules: src.rules.map((r) => ({ ...r })) }];
}

/** 复制名生成:同名 → 加「 (副本)」后缀;再撞递增序号 */
function nextGroupName(base: string, names: Set<string>): string {
	if (!names.has(base)) return base;
	let n = 1;
	for (;;) {
		const cand =
			base === ""
				? n === 1
					? "副本"
					: `副本 ${n}`
				: n === 1
					? `${base} (副本)`
					: `${base} (副本 ${n})`;
		if (!names.has(cand)) return cand;
		n++;
	}
}

/** 维护 config.cardRuleOff[cardPath] 数组的单个关闭键:off=true 加入(幂等),off=false 移除 */
export function setCardRuleOff(config: RpConfig, cardPath: string, key: string, off: boolean): RpConfig {
	const offByCard = config.cardRuleOff ?? {};
	const cur = offByCard[cardPath] ?? [];
	const nextKeys = off ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter((k) => k !== key);
	return { ...config, cardRuleOff: { ...offByCard, [cardPath]: nextKeys } };
}

// ---------- 卡内嵌规则覆盖层(需求:卡内嵌规则可编辑,不改卡文件;键 = ruleKey) ----------

/** 读某卡的覆盖规则表(缺省 {}) */
export function cardOverridesOf(config: RpConfig, cardPath: string): Record<string, DisplayRule> {
	return config.cardRuleOverrides?.[cardPath] ?? {};
}

/** 写入单条覆盖(幂等;覆盖挂原始 key,key 不与规则字段联动;存储时回填 id=key,保证 ruleKey(覆盖)===key) */
export function setCardRuleOverride(config: RpConfig, cardPath: string, key: string, rule: DisplayRule): RpConfig {
	const byCard = config.cardRuleOverrides ?? {};
	const cur = byCard[cardPath] ?? {};
	return { ...config, cardRuleOverrides: { ...byCard, [cardPath]: { ...cur, [key]: { ...rule, id: key } } } };
}

/** 删除单条覆盖(幂等;该卡覆盖清空后整段移除,避免残留空记录) */
export function removeCardRuleOverride(config: RpConfig, cardPath: string, key: string): RpConfig {
	const byCard = config.cardRuleOverrides ?? {};
	const cur = byCard[cardPath] ?? {};
	if (!(key in cur)) return config; // 幂等:本来就没有
	const nextCard = { ...cur };
	delete nextCard[key];
	const nextByCard = { ...byCard };
	if (Object.keys(nextCard).length === 0) {
		delete nextByCard[cardPath];
	} else {
		nextByCard[cardPath] = nextCard;
	}
	return { ...config, cardRuleOverrides: nextByCard };
}

// ---------- 未分组组兜底(需求:空组时也能添加规则) ----------

/** 空组列表 → 补一个未分组空组(写路径/读侧兜底,避免全新配置 group=0 越界);非空原样返回 */
export function ensureUngrouped(groups: RuleGroup[]): RuleGroup[] {
	if (groups.length === 0) return [{ name: "", rules: [] }];
	return groups;
}
