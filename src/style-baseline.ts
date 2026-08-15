/**
 * 文风卡（DESIGN-style-baseline §2）：本场唯一文风来源。
 *
 * 数据源优先级：assets/flow/style-baseline.json（正式数据源，随发布包分发）
 * → 本文件 DEFAULT_STYLE_BASELINE（内嵌默认，文件缺失/损坏时兜底，内容须与 JSON 逐字一致，
 *    test/style-baseline.test.ts 有逐字比对兜底）→ liyuan.config.json 的 styleBaseline 段
 *    按 key 覆盖（default 键替换默认卡；presets 内同名键替换预设卡，未提供的键继承）。
 *
 * 卡只做四件事：声音（一句话）、参考系（一个方向）、同场景正反例（反例只覆盖
 * 分镜腔/散文腔/流水账腔三个原型）、一个自检问题。harness 不定义文风，只引用本卡。
 *
 * 纯函数 + 常量表，零模块级可变状态（jiti 二象性红线）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { StyleBaselineCard, StyleBaselineConfig } from "./types.ts";

/** 文风卡数据文件形态：default 必填；presets 按拆层表 key 选卡 */
export interface StyleBaselineFile {
	default: StyleBaselineCard;
	presets?: Record<string, StyleBaselineCard>;
}

/** 内嵌默认文风卡（assets/flow/style-baseline.json 的兜底镜像——改文案必须两处同步） */
export const DEFAULT_STYLE_BASELINE: StyleBaselineFile = {
	default: {
		voice:
			"你是在给读者讲一个故事：用连续的、有人味的叙述把动作、对白、心理和环境缝在一起，让读者觉得在读小说，而不是在看分镜脚本、散文诗或流水账。对白放在引号里；动作、神态与场景用叙事句落实，不抽象概括情绪。",
		reference: "成熟中文网文 / 通俗小说叙事（单选，不叠加）",
		positive:
			"凯尔推开店门，门铃叮当一响。千束正踮着脚往架子上挂新滤纸，听见声音也不回头，先喊了一句“欢迎光临”，等转过身看清是他，那声招呼的尾音往上挑了挑：“哟，又是你啊。今天还是美式？老位置给你留着呢。”她说着把咖啡豆舀进磨豆机，耳根却红了一小片。",
		negatives: {
			shot: "镜头推到咖啡厅门口。门铃响。千束回头。她笑。凯尔坐下。咖啡端上来。",
			prose: "看落日把海面烧成一片滚烫的金。风把她的发吹成一场无声的叹息。",
			ledger: "他先去咖啡厅，和千束聊了几句。再去事务所看了一圈。下午去港区散步。五天后回到房间。",
		},
		check: "这段读完，读者会觉得在读小说，还是在看分镜 / 散文 / 账本？",
	},
	presets: {
		"liyuan-custom": {
			voice:
				"你在用成熟中文网文的手感写一篇给人读的长篇叙事：动作、对白、心理、环境融成一体，句子有完整的骨架（谁、在什么环境里、带着什么神色、做了什么），读起来是在讲故事，不是分镜脚本、散文诗或流水账。成人向描写同样要服从这条：写实、完整、有身体有反应，不靠意象虚写。",
			reference: "成熟中文网文（允许直白的成人向描写，但叙事姿态不变）",
			positive:
				"池水在两人腰胯急促的碰撞下哗啦作响，凯尔一边扶着她发颤的腰肢，一边再度俯下身，含住她张开喘息的唇瓣，把温热的体液渡进她口中，卷着她的软舌翻搅吞咽。黎维塔只觉得神智被滔天欲浪卷向云端，小腹在一次次深重滑擦下泛起大片绯红，紧闭的花唇被磨得外翻溢浆，一股接一股滚烫的白浆在水下喷涌。",
			negatives: {
				shot: "他压上去。她喘。他顶。她叫。床响。",
				prose: "看落日把海面烧成一片滚烫的金。快感像潮水漫过她的身体。",
				ledger: "他已答应。她高潮四次。关系更近一步。",
			},
			check: "这段读完，读者会觉得在读小说，还是在看分镜 / 散文 / 账本？",
		},
	},
};

/** 校验单张文风卡；结构非法返回 null（宁漏勿伤） */
export function normalizeStyleBaselineCard(raw: unknown): StyleBaselineCard | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	const voice = str(o.voice).trim();
	const reference = str(o.reference).trim();
	const positive = str(o.positive).trim();
	const check = str(o.check).trim();
	const neg = o.negatives as Record<string, unknown> | null;
	if (!voice || !reference || !positive || !check || !neg || typeof neg !== "object") return null;
	const shot = str(neg.shot).trim();
	const prose = str(neg.prose).trim();
	const ledger = str(neg.ledger).trim();
	if (!shot || !prose || !ledger) return null;
	return { voice, reference, positive, negatives: { shot, prose, ledger }, check };
}

/** 校验数据文件；default 非法整体弃用（调用方回退内嵌默认） */
export function normalizeStyleBaselineFile(raw: unknown): StyleBaselineFile | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const defaultCard = normalizeStyleBaselineCard(o.default);
	if (!defaultCard) return null;
	const presets: Record<string, StyleBaselineCard> = {};
	if (o.presets && typeof o.presets === "object") {
		for (const [k, v] of Object.entries(o.presets as Record<string, unknown>)) {
			const card = normalizeStyleBaselineCard(v);
			if (card) presets[k] = card;
		}
	}
	return { default: defaultCard, ...(Object.keys(presets).length > 0 ? { presets } : {}) };
}

/** 读 assets/flow/style-baseline.json；缺失/损坏回退内嵌默认 */
export function loadStyleBaselineFile(cwd: string): StyleBaselineFile {
	const p = join(cwd, "assets", "flow", "style-baseline.json");
	if (!existsSync(p)) return DEFAULT_STYLE_BASELINE;
	try {
		return normalizeStyleBaselineFile(JSON.parse(readFileSync(p, "utf8"))) ?? DEFAULT_STYLE_BASELINE;
	} catch {
		return DEFAULT_STYLE_BASELINE;
	}
}

/** 配置覆盖与选卡：override.default 盖默认；override.presets 按 key 合并（同名盖、新名追加、未提供的继承） */
export function resolveStyleBaseline(
	file: StyleBaselineFile,
	override: StyleBaselineConfig | undefined,
	presetKey: string | null | undefined,
): StyleBaselineCard {
	const mergeCard = (base: StyleBaselineCard, patch?: StyleBaselineCard): StyleBaselineCard => {
		if (!patch) return base;
		return {
			...base,
			...patch,
			negatives: { ...base.negatives, ...patch.negatives },
		};
	};
	const patchOf = (raw: unknown): StyleBaselineCard | undefined =>
		raw ? (normalizeStyleBaselineCard(raw) ?? undefined) : undefined;
	const defaultCard = mergeCard(file.default, patchOf(override?.default));
	if (!presetKey) return defaultCard;
	const presets = new Map<string, StyleBaselineCard>(Object.entries(file.presets ?? {}));
	for (const [k, v] of Object.entries(override?.presets ?? {})) {
		const patch = patchOf(v);
		if (!patch) continue;
		presets.set(k, mergeCard(presets.get(k) ?? defaultCard, patch));
	}
	return presets.get(presetKey) ?? defaultCard;
}

/** 文风卡 → system 内的常驻分节正文（# 文风基准 的标题由装配器加） */
export function renderStyleBaseline(card: StyleBaselineCard): string {
	return `【声音】${card.voice}
【参考系】${card.reference}
【正例】${card.positive}
【反例·分镜腔】${card.negatives.shot}
【反例·散文腔】${card.negatives.prose}
【反例·流水账腔】${card.negatives.ledger}
【自检】${card.check}`;
}
