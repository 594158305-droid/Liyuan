/**
 * 显示正则管理工具（regex_manage，P7）。
 *
 * 一个工具 + action 参数分派（list/get/create/update/delete/move/toggle/test），
 * 覆盖 global/card/preset 三作用域的正则分组与规则 CRUD、卡内嵌规则启停，
 * 以及单规则对样例文本的试运行（test 纯函数，不写盘）。
 * scope=card + cardRuleKey 时，update=编辑卡内嵌规则（写 config.cardRuleOverrides 覆盖层，
 * 不改卡文件）、delete=还原覆盖（删除覆盖恢复卡原文）。
 *
 * 与 server/rest.ts 的 /api/cardfront/* 端点共用同一套 src/cardfront.ts 纯函数，
 * 但本工具**不 import server/rest**——读盘/写盘/广播经 RegexDeps 由调用方
 * （server/assistant.ts 的 createStagehandTools）按面注入。
 *
 * 写盘类操作（create/update/delete/move/toggle）成功后：saveConfig / savePresetGroups
 * + broadcastResync()（P8：广播 hello 帧，前端用新规则重渲当前消息）。
 */

import { isAbsolute, join } from "node:path";
import { loadCardFile, readCardRawJson } from "../card.ts";
import {
	addGroup,
	addRule,
	cardGroupsOf,
	cardOverridesOf,
	displayRules,
	ensureUngrouped,
	extractRegexScripts,
	isRuleOff,
	moveGroup,
	moveRule,
	parseFindRegex,
	removeCardRuleOverride,
	removeGroup,
	removeRule,
	ruleKey,
	setCardGroups,
	setCardRuleOff,
	setCardRuleOverride,
	setUserGroups,
	updateGroup,
	updateRule,
	userGroupsOf,
	type DisplayRule,
	type RuleGroup,
} from "../cardfront.ts";
import { applyCardSkin } from "../cardSkin.ts";
import type { RpConfig } from "../types.ts";
import { errText, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

export interface RegexDeps {
	/** 读项目配置（liyuan.config.json 归一化后） */
	loadConfig: () => RpConfig;
	/** 写配置：调用方闭包负责 写盘 → softRefreshConfig（或等价的规则热载） */
	saveConfig: (next: RpConfig) => void;
	/** 当前活跃预设的 regexGroups（无预设/文件缺失返回 null）；写预设作用域由闭包直接写预设文件本体 */
	loadPresetGroups: () => RuleGroup[] | null;
	/** 写预设文件本体的 regexGroups（不碰 preset-override.json 草稿） */
	savePresetGroups: (groups: RuleGroup[]) => void;
	/** 写盘成功后触发聊天全量重放（P8 resync：前端用新规则重渲当前消息） */
	broadcastResync: () => void;
	/** 项目根目录（scope=card 读卡文件用） */
	cwd: string;
}

type RegexScope = "global" | "card" | "preset";

const VALID_PLACEMENT = [1, 2, 3, 5, 6] as const;

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function assertScope(v: unknown): RegexScope {
	if (v === "global" || v === "card" || v === "preset") return v;
	throw new Error("scope 必须为 global / card / preset");
}

const scopeName = (scope: RegexScope, card?: string) =>
	scope === "global" ? "全局" : scope === "card" ? `角色「${card ?? "?"}」` : "预设";

/** 精确读 index 参数：必须是整数；非法抛中文错（不钳位，越界由上层再判） */
function indexOf(args: Record<string, unknown>, key: string): number {
	const v = args[key];
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new Error(`${key} 必须是非负整数`);
	}
	return v;
}

function readScopeGroups(deps: RegexDeps, scope: RegexScope, card?: string): RuleGroup[] {
	if (scope === "global") return userGroupsOf(deps.loadConfig());
	if (scope === "card") {
		if (!card) throw new Error("scope=card 时必须提供 card 参数（卡路径）");
		return cardGroupsOf(deps.loadConfig(), card);
	}
	return deps.loadPresetGroups() ?? [];
}

function writeScopeGroups(deps: RegexDeps, scope: RegexScope, card: string | undefined, groups: RuleGroup[]): void {
	if (scope === "global") {
		deps.saveConfig(setUserGroups(deps.loadConfig(), groups));
	} else if (scope === "card") {
		if (!card) throw new Error("scope=card 时必须提供 card 参数（卡路径）");
		deps.saveConfig(setCardGroups(deps.loadConfig(), card, groups));
	} else {
		deps.savePresetGroups(groups);
	}
}

/** 卡内嵌显示规则（卡文件 regex_scripts → displayRules；读失败返回空） */
function readCardEmbeddedRules(deps: RegexDeps, card: string): DisplayRule[] {
	try {
		const abs = isAbsolute(card) ? card : join(deps.cwd, card);
		const { raw } = readCardRawJson(abs);
		return displayRules(extractRegexScripts(raw as Record<string, unknown>));
	} catch {
		return [];
	}
}

/**
 * 从工具参数构建/合并一条规则。
 * existing=null 为 create；否则以 existing 为底合并（保留未触碰字段）。
 * requireFind/requireReplace：create/test 必填 findRegex，create 必填 replace。
 * 字段校验与 server/rest.ts 的 validateRuleBodyFields 同口径（非法类型抛中文错）。
 */
function buildRuleFromArgs(
	existing: DisplayRule | null,
	args: Record<string, unknown>,
	requireFind: boolean,
	requireReplace: boolean,
): DisplayRule {
	const name = strArg(args, "name");
	let source = existing?.source ?? "";
	let flags = existing?.flags ?? "g";
	if (args.findRegex !== undefined && args.findRegex !== null) {
		const find = String(args.findRegex).trim();
		if (!find) throw new Error("findRegex 不能为空");
		const parsed = parseFindRegex(find);
		if (!parsed) throw new Error("findRegex 不是合法的正则表达式");
		source = parsed.source;
		flags = parsed.flags;
	} else if (requireFind) {
		throw new Error("缺少 findRegex");
	}
	let replace = existing?.replace ?? "";
	if (args.replace !== undefined) {
		if (typeof args.replace !== "string") throw new Error("replace 必须是字符串");
		replace = args.replace;
	} else if (requireReplace) {
		throw new Error("缺少 replace");
	}

	const rule: DisplayRule = {
		name: name || (existing?.name ?? ""),
		source,
		flags,
		replace,
	};
	// id 透传保留（卡内嵌规则关闭键；用户规则一般无 id）
	if (existing?.id) rule.id = existing.id;
	// disabled：统一开关字段，兼容旧 off
	if (args.disabled !== undefined || args.off !== undefined) {
		if (args.disabled !== undefined && typeof args.disabled !== "boolean") throw new Error("disabled 必须是布尔值");
		if (args.off !== undefined && typeof args.off !== "boolean") throw new Error("off 必须是布尔值");
		const disabled = args.disabled !== undefined ? args.disabled : args.off;
		rule.disabled = disabled === true;
	} else if (existing && isRuleOff(existing)) {
		// 更新且未触碰开关：保留关闭态，并顺带把旧 off 迁移为 disabled
		rule.disabled = true;
	}
	if (args.trimStrings !== undefined) {
		if (!Array.isArray(args.trimStrings) || args.trimStrings.some((x) => typeof x !== "string")) {
			throw new Error("trimStrings 必须是字符串数组");
		}
		const ts = (args.trimStrings as string[]).filter((x) => x.length > 0);
		if (ts.length > 0) rule.trimStrings = ts;
	} else if (existing?.trimStrings) {
		rule.trimStrings = existing.trimStrings;
	}
	if (args.placement !== undefined) {
		if (!Array.isArray(args.placement) || args.placement.length === 0) {
			throw new Error("placement 必须是非空数字数组");
		}
		if (args.placement.some((x) => typeof x !== "number" || !(VALID_PLACEMENT as readonly number[]).includes(x))) {
			throw new Error("placement 只允许 1/2/3/5/6（1=用户输入/2=AI输出/3=快捷命令/5=世界信息/6=推理）");
		}
		rule.placement = args.placement as number[];
	} else if (existing?.placement) {
		rule.placement = existing.placement;
	}
	for (const k of ["runOnEdit", "markdownOnly", "promptOnly"] as const) {
		if (args[k] !== undefined) {
			if (typeof args[k] !== "boolean") throw new Error(`${k} 必须是布尔值`);
			rule[k] = args[k] as boolean;
		} else if (existing && existing[k] !== undefined) {
			rule[k] = existing[k] as boolean;
		}
	}
	if (args.substituteRegex !== undefined) {
		const s = args.substituteRegex;
		if (s !== 0 && s !== 1 && s !== 2) {
			throw new Error("substituteRegex 必须为 0/1/2（0=不替换 1=raw 2=escaped）");
		}
		rule.substituteRegex = s as 0 | 1 | 2;
	} else if (existing?.substituteRegex !== undefined) {
		rule.substituteRegex = existing.substituteRegex;
	}
	for (const k of ["minDepth", "maxDepth"] as const) {
		if (args[k] !== undefined) {
			const v = args[k];
			if (v === null) {
				rule[k] = null;
				continue;
			}
			if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} 必须是数字或 null`);
			if (v < 0) throw new Error(`${k} 不能为负数`);
			rule[k] = v;
		} else if (existing && existing[k] !== undefined) {
			rule[k] = existing[k] as number | null;
		}
	}
	return rule;
}

// ---------- action 实现（全部纯领域函数 + deps，不碰 pi / rest） ----------

function actionList(args: Record<string, unknown>, deps: RegexDeps): string {
	const scope = assertScope(args.scope);
	const card = strArg(args, "card") || undefined;
	const groups = readScopeGroups(deps, scope, card);
	const lines: string[] = [scope === "global" ? "全局正则分组：" : scope === "card" ? `角色「${card}」正则分组：` : "预设正则分组："];
	for (let i = 0; i < groups.length; i++) {
		const g = groups[i];
		const goff = g.off === true ? "（组关闭）" : "";
		const ruleLines = g.rules
			.map((r, j) => {
				const roff = isRuleOff(r) ? "（关）" : "";
				return `  [${j}] ${r.name || "（未命名）"}${roff}：/${r.source}/${r.flags} → ${trunc(r.replace, 50)}`;
			})
			.join("\n");
		lines.push(`组[${i}]「${g.name || "未分组"}」${goff}·${g.rules.length} 条${ruleLines ? `\n${ruleLines}` : ""}`);
	}
	if (scope === "card" && card) {
		const cardRules = readCardEmbeddedRules(deps, card);
		const offKeys = (deps.loadConfig().cardRuleOff ?? {})[card] ?? [];
		lines.push(`卡内嵌规则（${cardRules.length} 条，规则[${"index"}] 供 toggle 引用）：`);
		cardRules.forEach((r, i) => {
			const off = offKeys.includes(ruleKey(r)) ? "（用户已关）" : "";
			lines.push(`  [${i}] ${r.name || "（未命名）"}${off}：/${r.source}/${r.flags} → ${trunc(r.replace, 50)}`);
		});
	}
	return lines.join("\n");
}

function actionGet(args: Record<string, unknown>, deps: RegexDeps): string {
	const scope = assertScope(args.scope);
	const card = strArg(args, "card") || undefined;
	const groups = readScopeGroups(deps, scope, card);
	const group = typeof args.group === "number" ? indexOf(args, "group") : 0;
	const g = groups[group];
	if (!g) throw new Error(`组[${group}] 不存在`);
	const ruleIdx = indexOf(args, "rule");
	const rule = g.rules[ruleIdx];
	if (!rule) throw new Error(`规则[${ruleIdx}] 不存在`);
	return `${scopeName(scope, card)}组[${group}] 规则[${ruleIdx}]「${rule.name || "（未命名）"}」：\n${JSON.stringify(rule, null, 2)}`;
}

function actionCreate(args: Record<string, unknown>, deps: RegexDeps): string {
	const scope = assertScope(args.scope);
	const card = strArg(args, "card") || undefined;
	if (typeof args.group === "number") {
		// 建规则：先 ensureUngrouped 兜底（全新配置 groups=[] 时未分组组可承接，group=0 不再越界）
		const groups0 = ensureUngrouped(readScopeGroups(deps, scope, card));
		const group = indexOf(args, "group");
		if (group >= groups0.length) throw new Error(`组[${group}] 不存在`);
		const rule = buildRuleFromArgs(null, args, true, true);
		const groups = addRule(groups0, group, rule);
		writeScopeGroups(deps, scope, card, groups);
		deps.broadcastResync();
		return `已在 ${scopeName(scope, card)}组[${group}] 添加规则「${rule.name || "（未命名）"}」（/${rule.source}/${rule.flags}）。`;
	}
	// 建组
	const name = strArg(args, "name");
	if (!name) throw new Error("创建组需要 name 参数；创建规则需要 group 参数");
	const groups = addGroup(readScopeGroups(deps, scope, card), name);
	writeScopeGroups(deps, scope, card, groups);
	deps.broadcastResync();
	return `已添加组「${name}」（组[${groups.length - 1}]）。`;
}

function actionUpdate(args: Record<string, unknown>, deps: RegexDeps): string {
	const scope = assertScope(args.scope);
	const card = strArg(args, "card") || undefined;
	// 卡内嵌规则覆盖编辑（scope=card + cardRuleKey）：写 config.cardRuleOverrides，不改卡文件
	const cardRuleKey = strArg(args, "cardRuleKey") || undefined;
	if (scope === "card" && cardRuleKey) {
		if (!card) throw new Error("scope=card 时必须提供 card 参数（卡路径）");
		const config = deps.loadConfig();
		const overrides = cardOverridesOf(config, card);
		// 基准 = 已有覆盖（优先）或卡上原规则；都没有则报错
		const orig = overrides[cardRuleKey] ?? readCardEmbeddedRules(deps, card).find((r) => ruleKey(r) === cardRuleKey);
		if (!orig) throw new Error(`卡内嵌规则「${cardRuleKey}」不存在（卡上无此键，也没有覆盖）`);
		const merged = buildRuleFromArgs(orig, args, false, false);
		deps.saveConfig(setCardRuleOverride(config, card, cardRuleKey, merged));
		deps.broadcastResync();
		return `已更新卡内嵌规则「${cardRuleKey}」（覆盖层，不改卡文件）。`;
	}
	let groups = ensureUngrouped(readScopeGroups(deps, scope, card));
	const group = typeof args.group === "number" ? indexOf(args, "group") : 0;
	const g = groups[group];
	if (!g) throw new Error(`组[${group}] 不存在`);
	if (typeof args.rule === "number") {
		// 规则字段更新（findRegex 校验；未触碰字段保留）
		const ruleIdx = indexOf(args, "rule");
		if (ruleIdx >= g.rules.length) throw new Error(`规则[${ruleIdx}] 不存在`);
		const merged = buildRuleFromArgs(g.rules[ruleIdx], args, false, false);
		groups = updateRule(groups, group, ruleIdx, merged);
		writeScopeGroups(deps, scope, card, groups);
		deps.broadcastResync();
		return `已更新 ${scopeName(scope, card)}组[${group}] 规则[${ruleIdx}]「${merged.name || "（未命名）"}」。`;
	}
	// 组名 / 组开关
	const patch: { name?: string; off?: boolean } = {};
	const name = strArg(args, "name");
	if (name) patch.name = name;
	if (args.off !== undefined) {
		if (typeof args.off !== "boolean") throw new Error("off 必须是布尔值");
		patch.off = args.off;
	}
	if (Object.keys(patch).length === 0) {
		throw new Error("update 需要 name / off（更新组）或 rule（更新规则）或 cardRuleKey（卡内嵌覆盖）参数");
	}
	groups = updateGroup(groups, group, patch);
	writeScopeGroups(deps, scope, card, groups);
	deps.broadcastResync();
	return `已更新组[${group}]「${patch.name ?? "名称不变"}」。`;
}

function actionDelete(args: Record<string, unknown>, deps: RegexDeps): string {
	const scope = assertScope(args.scope);
	const card = strArg(args, "card") || undefined;
	// 还原卡内嵌规则覆盖（scope=card + cardRuleKey）：删除 config.cardRuleOverrides 里该键，恢复卡原文
	const cardRuleKey = strArg(args, "cardRuleKey") || undefined;
	if (scope === "card" && cardRuleKey) {
		if (!card) throw new Error("scope=card 时必须提供 card 参数（卡路径）");
		const config = deps.loadConfig();
		const overrides = cardOverridesOf(config, card);
		if (!(cardRuleKey in overrides)) {
			return `卡内嵌规则「${cardRuleKey}」本来就没有覆盖，无需还原。`;
		}
		deps.saveConfig(removeCardRuleOverride(config, card, cardRuleKey));
		deps.broadcastResync();
		return `已还原卡内嵌规则「${cardRuleKey}」（删除覆盖，恢复卡原文）。`;
	}
	let groups = readScopeGroups(deps, scope, card);
	const group = typeof args.group === "number" ? indexOf(args, "group") : 0;
	if (group >= groups.length) throw new Error(`组[${group}] 不存在`);
	if (typeof args.rule === "number") {
		const ruleIdx = indexOf(args, "rule");
		if (ruleIdx >= groups[group].rules.length) throw new Error(`规则[${ruleIdx}] 不存在`);
		groups = removeRule(groups, group, ruleIdx);
		writeScopeGroups(deps, scope, card, groups);
		deps.broadcastResync();
		return `已删除 ${scopeName(scope, card)}组[${group}] 规则[${ruleIdx}]。`;
	}
	if (groups[group].name === "") throw new Error("未分组组不可删除");
	groups = removeGroup(groups, group);
	writeScopeGroups(deps, scope, card, groups);
	deps.broadcastResync();
	return `已删除组[${group}]。`;
}

function actionMove(args: Record<string, unknown>, deps: RegexDeps): string {
	const scope = assertScope(args.scope);
	const card = strArg(args, "card") || undefined;
	const delta = args.moveDelta;
	if (delta !== -1 && delta !== 1) throw new Error("moveDelta 必须为 -1（上移）或 1（下移）");
	let groups = readScopeGroups(deps, scope, card);
	const group = typeof args.group === "number" ? indexOf(args, "group") : 0;
	if (group >= groups.length) throw new Error(`组[${group}] 不存在`);
	if (typeof args.rule === "number") {
		const ruleIdx = indexOf(args, "rule");
		if (ruleIdx >= groups[group].rules.length) throw new Error(`规则[${ruleIdx}] 不存在`);
		const target = ruleIdx + delta;
		if (target < 0 || target >= groups[group].rules.length) {
			throw new Error(`规则[${ruleIdx}] 已在边界，无法${delta === -1 ? "上移" : "下移"}`);
		}
		groups = moveRule(groups, group, ruleIdx, delta);
	} else {
		const target = group + delta;
		if (target < 0 || target >= groups.length) {
			throw new Error(`组[${group}] 已在边界，无法${delta === -1 ? "上移" : "下移"}`);
		}
		groups = moveGroup(groups, group, delta);
	}
	writeScopeGroups(deps, scope, card, groups);
	deps.broadcastResync();
	return `已移动 ${scopeName(scope, card)}组[${group}]${typeof args.rule === "number" ? ` 规则[${indexOf(args, "rule")}]` : ""}。`;
}

function actionToggle(args: Record<string, unknown>, deps: RegexDeps): string {
	const scope = assertScope(args.scope);
	const card = strArg(args, "card") || undefined;
	// 卡内嵌规则启停（scope=card 且只有 rule、无 group）：走 config.cardRuleOff（不改卡文件）
	if (scope === "card" && typeof args.rule === "number" && typeof args.group !== "number") {
		if (!card) throw new Error("scope=card 时必须提供 card 参数（卡路径）");
		const cardRules = readCardEmbeddedRules(deps, card);
		const ruleIdx = indexOf(args, "rule");
		const rule = cardRules[ruleIdx];
		if (!rule) throw new Error(`卡内嵌规则[${ruleIdx}] 不存在`);
		const config = deps.loadConfig();
		const offKeys = (config.cardRuleOff ?? {})[card] ?? [];
		const key = ruleKey(rule);
		const off = !offKeys.includes(key);
		deps.saveConfig(setCardRuleOff(config, card, key, off));
		deps.broadcastResync();
		return `卡内嵌规则「${rule.name || "（未命名）"}」已${off ? "停用" : "启用"}。`;
	}
	let groups = readScopeGroups(deps, scope, card);
	const group = typeof args.group === "number" ? indexOf(args, "group") : 0;
	const g = groups[group];
	if (!g) throw new Error(`组[${group}] 不存在`);
	if (typeof args.rule === "number") {
		const ruleIdx = indexOf(args, "rule");
		const cur = g.rules[ruleIdx];
		if (!cur) throw new Error(`规则[${ruleIdx}] 不存在`);
		// 翻转 disabled，并清掉旧 off（避免双字段打架）
		const next: DisplayRule = { ...cur, off: undefined, disabled: !isRuleOff(cur) };
		groups = updateRule(groups, group, ruleIdx, next);
		writeScopeGroups(deps, scope, card, groups);
		deps.broadcastResync();
		return `规则「${next.name || "（未命名）"}」已${next.disabled === true ? "停用" : "启用"}。`;
	}
	const curOff = g.off === true;
	groups = updateGroup(groups, group, { off: !curOff });
	writeScopeGroups(deps, scope, card, groups);
	deps.broadcastResync();
	return `组「${g.name || "未分组"}」已${!curOff ? "停用" : "启用"}。`;
}

/** test：单规则对 testText 纯函数试运行，不写盘 */
function actionTest(args: Record<string, unknown>, deps: RegexDeps): string {
	const testText = strArg(args, "testText");
	if (!testText) throw new Error("test 需要 testText（样例文本）");
	const rule = buildRuleFromArgs(null, args, true, false);
	const config = deps.loadConfig();
	let charName = "";
	try {
		const abs = isAbsolute(config.card) ? config.card : join(deps.cwd, config.card);
		charName = loadCardFile(abs).name;
	} catch {
		charName = "角色";
	}
	const userName = config.userName || "用户";
	const out = applyCardSkin(testText, [rule], { charName, userName });
	return (
		`试运行（/${rule.source}/${rule.flags}，宏 char=${charName} user=${userName}` +
		`${rule.trimStrings ? `，trimStrings=${rule.trimStrings.join("、")}` : ""}` +
		`${rule.substituteRegex !== undefined ? `，substituteRegex=${rule.substituteRegex}` : ""}）：\n\n${out}`
	);
}

export const regexManage: ToolSpec<RegexDeps> = {
	name: "regex_manage",
	domain: "card",
	mode: "write",
	surfaces: ["assistant"],
	label: "管理显示正则",
	description: () =>
		"管理剧情显示用的美化正则（一档卡皮肤规则）：全局 / 角色卡 / 预设三个作用域的分组与规则 CRUD、" +
		"卡内嵌规则启停与覆盖编辑、以及单条规则对样例文本的试运行。action 分派：list 列组与规则概要、get 取单条全字段、" +
		"create 建组或规则、update 改规则字段或组名/组开关、delete 删组或规则、move 相邻移动、toggle 启停、" +
		"test 试运行（不写盘）。scope=card 时传 cardRuleKey 可编辑/还原卡内嵌规则——走 config 覆盖层，**不改卡文件**。" +
		"规则字段与 ST 对齐：findRegex（可带 /pattern/flags）、replace、disabled、trimStrings、placement" +
		"（1=用户输入/2=AI输出/3=快捷命令/5=世界信息/6=推理）、runOnEdit、substituteRegex（0=不替换 1=raw 2=escaped）、" +
		"minDepth/maxDepth（null=不限）、markdownOnly、promptOnly。写盘操作会立即刷新前端显示（resync）。",
	parameters: () => ({
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["list", "get", "create", "update", "delete", "move", "toggle", "test"],
				description: "操作：list 概要 / get 单条全字段 / create 建组或规则 / update 更新 / delete 删除 / move 移动 / toggle 启停 / test 试运行",
			},
			scope: {
				type: "string",
				enum: ["global", "card", "preset"],
				description: "作用域：global=全局 / card=角色卡 / preset=当前预设（写预设作用域直接改预设文件本体）",
			},
			card: { type: "string", description: "scope=card 时必填：角色卡路径（相对项目根）" },
			cardRuleKey: { type: "string", description: "scope=card 时编辑卡内嵌规则：规则键（ruleKey=id/name/source）；update=写覆盖，delete=还原删除覆盖（均不改卡文件）" },
			group: { type: "number", description: "组 index（缺省 0=未分组）" },
			rule: { type: "number", description: "规则 index（缺省=操作整个组；scope=card 的 toggle 时引用卡内嵌规则 index）" },
			moveDelta: { type: "number", enum: [-1, 1], description: "move 时移动方向：-1=上移 / 1=下移" },
			name: { type: "string", description: "组名或规则名" },
			findRegex: { type: "string", description: "正则（可带 /pattern/flags 或裸串；创建/更新/试运行用 parseFindRegex 校验）" },
			replace: { type: "string", description: "替换串（支持 $1/$n、$&、$<name>、{{match}}、{{char}}/{{user}} 宏）" },
			disabled: { type: "boolean", description: "true=停用该规则（统一开关字段）" },
			trimStrings: { type: "array", items: { type: "string" }, description: "替换前从捕获值中逐个剔除的子串（可含 {{char}}/{{user}}）" },
			placement: { type: "array", items: { type: "number" }, description: "作用范围：1=用户输入/2=AI输出/3=快捷命令/5=世界信息/6=推理" },
			runOnEdit: { type: "boolean", description: "编辑消息时运行（存储字段，显示层不生效）" },
			substituteRegex: { type: "number", enum: [0, 1, 2], description: "查找时宏档位：0=不替换 1=raw 2=escaped（缺省=escaped 历史行为）" },
			minDepth: { type: ["number", "null"], description: "深度下限（null=不限；存储字段，显示层不生效）" },
			maxDepth: { type: ["number", "null"], description: "深度上限（null=不限；存储字段，显示层不生效）" },
			markdownOnly: { type: "boolean", description: "仅格式显示（存储透传）" },
			promptOnly: { type: "boolean", description: "仅格式提示词（存储透传）" },
			testText: { type: "string", description: "action=test 时的样例文本" },
		},
		required: ["action", "scope"],
	}),
	async run(args, deps): Promise<ToolResult> {
		try {
			const action = strArg(args, "action");
			let result = "";
			switch (action) {
				case "list":
					result = actionList(args, deps);
					break;
				case "get":
					result = actionGet(args, deps);
					break;
				case "create":
					result = actionCreate(args, deps);
					break;
				case "update":
					result = actionUpdate(args, deps);
					break;
				case "delete":
					result = actionDelete(args, deps);
					break;
				case "move":
					result = actionMove(args, deps);
					break;
				case "toggle":
					result = actionToggle(args, deps);
					break;
				case "test":
					result = actionTest(args, deps);
					break;
				default:
					return { text: `未知 action「${action}」（可用：list/get/create/update/delete/move/toggle/test）。`, activity: "正则管理 · 参数错误" };
			}
			return { text: result, activity: `正则管理 · ${action}` };
		} catch (err) {
			return { text: `正则管理失败：${errText(err)}`, activity: "正则管理 · 失败" };
		}
	},
};

/** 显示正则族工具（P7：单工具 action 分派） */
export const regexTools: ToolSpec<RegexDeps>[] = [regexManage];
