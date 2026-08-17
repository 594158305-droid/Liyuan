/**
 * 梨园化 router 配置装载（docs/DESIGN-router.md §4，DESIGN-flow-config 同款外置模式）：
 * 代码内嵌默认（router-core.ts）→ assets/flow/router.json 文件覆盖 → liyuan.config.json
 * `router` 段覆盖。非法条目跳过、缺省回退内置；解析结果进引擎 flowWarnings（去重播报）。
 *
 * 纯函数 + 常量表，零 pi 依赖，可单测（与 src/preset-split.ts 同风格）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	DEFAULT_CARDS,
	DEFAULT_LEXICON,
	DEFAULT_PERSONAS,
	type RouterBand,
	type RouterCard,
	type RouterLexicon,
	type RouterPersonas,
} from "./router-core.ts";
import type { RouterConfig } from "./types.ts";

/** router.json 数据形态（personas / cards / classify 三段的用户覆盖位） */
export interface RouterFileConfig {
	personas?: Partial<RouterPersonas>;
	cards?: Partial<Record<"build" | "fix" | "deep", RouterCard>>;
	classify?: Partial<RouterLexicon>;
}

/** 解析后的运行时形态（引擎只读） */
export interface ResolvedRouter {
	enabled: boolean;
	/** perTurn = 唯一推荐形态：稳定弱人格 + 每拍模式卡（用户拍板） */
	personaMode: "perTurn" | "fixed" | "off";
	toolStaging: boolean;
	modeCards: boolean;
	convergeTail: boolean;
	agentsEnabled: boolean;
	personas: RouterPersonas;
	cards: Record<"build" | "fix" | "deep", RouterCard>;
	lexicon: RouterLexicon;
	/** 按模型覆盖（config.router.models）：engine 取人格时按 modelId 优先查 */
	modelOverrides: Record<string, { band?: RouterBand; persona?: string }>;
}

export const DEFAULT_RESOLVED: ResolvedRouter = {
	enabled: true,
	personaMode: "perTurn",
	toolStaging: true,
	modeCards: true,
	convergeTail: true,
	agentsEnabled: false,
	personas: { ...DEFAULT_PERSONAS },
	cards: { ...DEFAULT_CARDS },
	lexicon: {
		build: [...DEFAULT_LEXICON.build],
		fix: [...DEFAULT_LEXICON.fix],
		complex: [...DEFAULT_LEXICON.complex],
	},
	modelOverrides: {},
};

const isNonEmptyStrings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

/** 校验并归一化 router.json 数据形态；结构非法返回 null（调用方回退内置） */
export function normalizeRouterFile(raw: unknown): RouterFileConfig | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const out: RouterFileConfig = {};
	if (obj.personas && typeof obj.personas === "object") {
		const p = obj.personas as Record<string, unknown>;
		const personas: Partial<RouterPersonas> = {};
		for (const key of ["pro", "flash", "spec", "react"] as const) {
			if (typeof p[key] === "string" && (p[key] as string).trim()) personas[key] = p[key] as string;
		}
		if (Object.keys(personas).length > 0) out.personas = personas;
	}
	if (obj.cards !== undefined) {
		// cards 为数组形态（与 round-cards.json 一致）：[{ key, title, body }]，按 key 归位
		if (Array.isArray(obj.cards)) {
			const cards: Partial<Record<"build" | "fix" | "deep", RouterCard>> = {};
			for (const item of obj.cards) {
				if (!item || typeof item !== "object") continue;
				const card = item as Record<string, unknown>;
				if (typeof card.key !== "string" || typeof card.title !== "string" || typeof card.body !== "string") continue;
				if (!card.title || !card.body) continue;
				const key = card.key.replace(/^router-/, "");
				if (key === "build" || key === "fix" || key === "deep") {
					cards[key] = { key: `router-${key}`, title: card.title, body: card.body };
				}
			}
			if (Object.keys(cards).length > 0) out.cards = cards;
		}
	}
	if (obj.classify && typeof obj.classify === "object") {
		const cl = obj.classify as Record<string, unknown>;
		const classify: Partial<RouterLexicon> = {};
		if (isNonEmptyStrings(cl.build)) classify.build = cl.build;
		if (isNonEmptyStrings(cl.fix)) classify.fix = cl.fix;
		if (isNonEmptyStrings(cl.complex)) classify.complex = cl.complex;
		if (Object.keys(classify).length > 0) out.classify = classify;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** 读 assets/flow/router.json（cwd 相对仓库根）；缺失/损坏返回 null（调用方回退内置） */
export function loadRouterFile(cwd: string): RouterFileConfig | null {
	try {
		const p = join(cwd, "assets", "flow", "router.json");
		if (!existsSync(p)) return null;
		return normalizeRouterFile(JSON.parse(readFileSync(p, "utf8")));
	} catch {
		return null;
	}
}

/** 合并配置段：config.router 覆盖文件（文件覆盖内置）。非法条目跳过。 */
export function resolveRouterConfig(
	config: RouterConfig | undefined,
	file: RouterFileConfig | null,
): ResolvedRouter {
	const out: ResolvedRouter = {
		...DEFAULT_RESOLVED,
		personas: { ...DEFAULT_RESOLVED.personas },
		cards: { ...DEFAULT_RESOLVED.cards },
		lexicon: {
			build: [...DEFAULT_RESOLVED.lexicon.build],
			fix: [...DEFAULT_RESOLVED.lexicon.fix],
			complex: [...DEFAULT_RESOLVED.lexicon.complex],
		},
		modelOverrides: {},
	};

	// 1) 文件覆盖（提供哪段覆盖哪段）
	if (file) {
		if (file.personas) out.personas = { ...out.personas, ...file.personas };
		if (file.cards) out.cards = { ...out.cards, ...file.cards };
		if (file.classify) {
			if (file.classify.build) out.lexicon.build = [...file.classify.build];
			if (file.classify.fix) out.lexicon.fix = [...file.classify.fix];
			if (file.classify.complex) out.lexicon.complex = [...file.classify.complex];
		}
	}

	// 2) 配置段覆盖（最高优先级）
	if (config && typeof config === "object") {
		if (typeof config.enabled === "boolean") out.enabled = config.enabled;
		if (config.stage && typeof config.stage === "object") {
			if (config.stage.personaMode === "perTurn" || config.stage.personaMode === "fixed" || config.stage.personaMode === "off") {
				out.personaMode = config.stage.personaMode;
			}
			if (typeof config.stage.toolStaging === "boolean") out.toolStaging = config.stage.toolStaging;
			if (typeof config.stage.modeCards === "boolean") out.modeCards = config.stage.modeCards;
		}
		if (config.side && typeof config.side === "object" && typeof config.side.convergeTail === "boolean") {
			out.convergeTail = config.side.convergeTail;
		}
		if (config.agents && typeof config.agents === "object" && typeof config.agents.enabled === "boolean") {
			out.agentsEnabled = config.agents.enabled;
		}
		if (config.models && typeof config.models === "object") {
			for (const [modelId, m] of Object.entries(config.models)) {
				if (!modelId || !m || typeof m !== "object") continue;
				const o: { band?: RouterBand; persona?: string } = {};
				if (m.band === "spec" || m.band === "react" || m.band === "weak") o.band = m.band;
				if (typeof m.persona === "string" && m.persona.trim()) o.persona = m.persona;
				if (Object.keys(o).length > 0) out.modelOverrides[modelId] = o;
			}
		}
		if (config.classify && typeof config.classify === "object") {
			if (isNonEmptyStrings(config.classify.build)) out.lexicon.build = [...config.classify.build];
			if (isNonEmptyStrings(config.classify.fix)) out.lexicon.fix = [...config.classify.fix];
			if (isNonEmptyStrings(config.classify.complex)) out.lexicon.complex = [...config.classify.complex];
		}
	}

	return out;
}
