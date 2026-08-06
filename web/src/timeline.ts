/**
 * 回合时间线：把一拍里「思考 / 工具 / 正文」按**发生顺序**串成一条段落序列。
 *
 * 旧结构是三条并行累加通道（streamText / streamThinking / activities），各占一个
 * 固定分区，屏上顺序由 JSX 写死 —— 时间关系在拼接时就丢了，所以永远是
 * 「思考一坨在上、正文一坨在下」。本模块改为单条有序序列：delta 追加到末段，
 * kind 变化或工具事件到达时开新段。
 *
 * D10 纪律：本模块只做分段与计数，绝不改写正文字符。
 */

import type { WireActivity } from "./wire.ts";

/** 时间线段：思考 / 工具步骤 / 正文，三选一，按发生顺序排列 */
export type TurnSegment =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "tool"; activities: WireActivity[] };

/**
 * 思考量的粗略 token 估算（折叠态摘要用）。
 *
 * 思维链多为中英混排：CJK 约 1 token/字，ASCII 约 1 token/4 字符。
 * 这是展示用的量级指示，不是计费口径——不追求精确，但要在中文长思考上
 * 不至于低报 4 倍（按纯 /4 估会）。
 */
export function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		// CJK 统一表意文字 + 扩展A + 兼容表意 + 日文假名 + 中文标点
		if (
			(c >= 0x3040 && c <= 0x30ff) ||
			(c >= 0x3400 && c <= 0x4dbf) ||
			(c >= 0x4e00 && c <= 0x9fff) ||
			(c >= 0xf900 && c <= 0xfaff) ||
			(c >= 0x3000 && c <= 0x303f) ||
			(c >= 0xff00 && c <= 0xffef)
		) {
			cjk++;
		} else {
			other++;
		}
	}
	return Math.max(1, Math.round(cjk + other / 4));
}

/** 折叠摘要用的紧凑计数：≥1000 显示 1.2K */
export function formatTokenCount(n: number): string {
	if (n >= 1000) {
		const k = n / 1000;
		return `${k >= 10 ? Math.round(k) : k.toFixed(1)}K`;
	}
	return String(n);
}

/**
 * 追加流式增量：与末段同类则并入，否则开新段。
 * 返回新数组（React 状态不可变更新）。
 *
 * draft=true 表示稿件流（draft_write 参数转发）——**替换语义**：
 * 多稿重交/定点改稿作用在同一份稿上，新稿原地替换末尾正文段而不是叠加，
 * 否则屏上会出现「初稿 + 终稿」两份正文（与服务端 replaceDraftSegment 同语义）。
 * reset=true 表示本次 draft_write 调用的首个分片——把旧稿整个清掉换成新稿开头；
 * 同一次调用内的后续分片（reset=false）照常并入新稿段。
 */
export function appendDelta(
	segs: TurnSegment[],
	kind: "text" | "thinking",
	delta: string,
	draft = false,
	reset = false,
): TurnSegment[] {
	if (!delta) return segs;
	if (draft && kind === "text") {
		if (reset) {
			// 新一稿：替换末尾正文段为增量起点（清掉旧稿），无正文段则开新段
			const last = segs[segs.length - 1];
			if (last && last.kind === "text") return [...segs.slice(0, -1), { kind: "text", text: delta }];
			return [...segs, { kind: "text", text: delta }];
		}
		const last = segs[segs.length - 1];
		if (last && last.kind === "text") {
			// 同稿分片并入末尾正文段（该段 = 当前稿）
			const merged: TurnSegment = { kind: "text", text: last.text + delta };
			return [...segs.slice(0, -1), merged];
		}
		return [...segs, { kind: "text", text: delta }];
	}
	const last = segs[segs.length - 1];
	if (last && last.kind === kind) {
		const merged: TurnSegment = { kind, text: last.text + delta };
		return [...segs.slice(0, -1), merged];
	}
	return [...segs, { kind, text: delta }];
}

/**
 * 追加工具步骤：与末段同为工具则并入同一段（连续调用聚成一组，不逐条占行），
 * 否则开新段。
 */
export function appendActivity(segs: TurnSegment[], activity: WireActivity): TurnSegment[] {
	const last = segs[segs.length - 1];
	if (last && last.kind === "tool") {
		const merged: TurnSegment = { kind: "tool", activities: [...last.activities, activity] };
		return [...segs.slice(0, -1), merged];
	}
	return [...segs, { kind: "tool", activities: [activity] }];
}

/**
 * 丢弃末尾的中间态正文段（server 发 stream:clear —— 该轮正文是调工具前的
 * 计划旁白，不算成品）。思考段与工具段保留：它们本就是过程记录。
 *
 * 只删末尾连续的 text 段，前面轮次已定稿的正文不动。
 */
export function dropTrailingText(segs: TurnSegment[]): TurnSegment[] {
	let end = segs.length;
	while (end > 0 && segs[end - 1].kind === "text") end--;
	return end === segs.length ? segs : segs.slice(0, end);
}

/** 末尾中间态正文（stream:clear 前留档成 note 用）；无则空串 */
export function trailingText(segs: TurnSegment[]): string {
	let out = "";
	for (let i = segs.length - 1; i >= 0; i--) {
		const s = segs[i];
		if (s.kind !== "text") break;
		out = s.text + out;
	}
	return out;
}

/** 时间线里的正文合流（定稿正文 = 所有 text 段顺序拼接） */
export function textOf(segs: TurnSegment[]): string {
	return segs
		.filter((s): s is Extract<TurnSegment, { kind: "text" }> => s.kind === "text")
		.map((s) => s.text)
		.join("");
}

/** 时间线里的思考合流（兼容旧 thinking 字段与「复制思维链」） */
export function thinkingOf(segs: TurnSegment[]): string {
	return segs
		.filter((s): s is Extract<TurnSegment, { kind: "thinking" }> => s.kind === "thinking")
		.map((s) => s.text.trim())
		.filter(Boolean)
		.join("\n\n");
}

/** 时间线里的工具步骤合流（兼容旧 activities 字段） */
export function activitiesOf(segs: TurnSegment[]): WireActivity[] {
	return segs.flatMap((s) => (s.kind === "tool" ? s.activities : []));
}

/** 段是否为空（纯空白的文本段不值得占位） */
function isEmptySeg(s: TurnSegment): boolean {
	return s.kind === "tool" ? s.activities.length === 0 : !s.text.trim();
}

/** 去掉空段（流式过程中会产生空壳段，定稿前清一遍） */
export function pruneEmpty(segs: TurnSegment[]): TurnSegment[] {
	return segs.filter((s) => !isEmptySeg(s));
}

/**
 * 由旧字段合成时间线（历史消息 / 重放没有分段信息时的兼容路径）。
 * 顺序取旧渲染的既有约定：思考 → 过程 → 正文。
 */
export function segmentsFromLegacy(o: {
	thinking?: string;
	activities?: WireActivity[];
	text?: string;
}): TurnSegment[] {
	const segs: TurnSegment[] = [];
	if (o.thinking?.trim()) segs.push({ kind: "thinking", text: o.thinking });
	if (o.activities?.length) segs.push({ kind: "tool", activities: o.activities });
	if (o.text?.trim()) segs.push({ kind: "text", text: o.text });
	return segs;
}

/**
 * 合并两条时间线（同一拍里多次定稿——中断续写 / 多轮 upsert）。
 * 直接首尾相接后归并相邻同类段，保持整体时序。
 */
export function concatSegments(a: TurnSegment[], b: TurnSegment[]): TurnSegment[] {
	const out: TurnSegment[] = [];
	for (const seg of [...a, ...b]) {
		const last = out[out.length - 1];
		if (!last) {
			out.push(seg);
			continue;
		}
		if (last.kind === "tool" && seg.kind === "tool") {
			out[out.length - 1] = { kind: "tool", activities: [...last.activities, ...seg.activities] };
		} else if (last.kind === seg.kind && seg.kind !== "tool" && last.kind !== "tool") {
			// 两段文本相接：中间补空行，避免上一稿末句与下一稿首句黏连
			out[out.length - 1] = { kind: seg.kind, text: `${last.text.trimEnd()}\n\n${seg.text.trimStart()}` };
		} else {
			out.push(seg);
		}
	}
	return out;
}
