/**
 * 场记 TODO（2026-08-15 逐表派发 v1）：每拍定稿后从正文筛出需要维护的 auto 表。
 *
 * 背景：旧场记一次全量注入全部 auto 表（19 表 JSON ≈ 21 万字符/拍，实测见
 * plan_doc/token-slimming.md），输入过大且单表失败拖累整拍。逐表派发后，每表
 * 一个独立旁路调用（输入 = 该表 description + 现有行 + 本轮对话），本模块负责
 * 生成「本轮哪些表要动」的 TODO 清单。
 *
 * 文本匹配（零 LLM 成本，v1）：
 * - ① 表名（去尾「表」字）出现在正文；
 * - ② 列名（≥2 字）出现在正文；
 * - ③ 时间/地点/纪要链表强制入列（列名含「时间/地点/纪要」——纪要表、全局
 *   数据表等每拍都要维护时间线，不能等正文点名）；
 * - ④ 现有行首列实体（如角色名，≥2 字）出现在正文。
 *
 * 纯函数、零依赖，可单测。
 */

import type { CustomTable } from "./types.ts";

/** 强制入列的列名特征（时间/地点/纪要链：这些表每拍维护时间线/纪要，不靠正文点名） */
const FORCED_COLUMN_HINTS = ["时间", "地点", "纪要"] as const;

/**
 * 生成本轮 TODO 表名列表（保持表定义顺序，去重由 Object.entries 天然保证）。
 * text = 本轮对话（用户原话 + 定稿正文，拼接）。
 */
export function buildTableTodo(text: string, tables: Record<string, CustomTable>): string[] {
	const out: string[] = [];
	for (const [name, t] of Object.entries(tables)) {
		if (!t.auto) continue;
		if (tableNeedsRefresh(text, name, t)) out.push(name);
	}
	return out;
}

/** 单表是否纳入本轮 TODO（供单测直接断言） */
export function tableNeedsRefresh(text: string, name: string, t: CustomTable): boolean {
	// ① 表名（去尾「表」字，≥2 字）出现在正文
	const bare = name.endsWith("表") ? name.slice(0, -1) : name;
	if (bare.length >= 2 && text.includes(bare)) return true;
	// ② 列名（≥2 字）出现在正文
	if (t.columns.some((c) => c.name.length >= 2 && text.includes(c.name))) return true;
	// ③ 时间/地点/纪要链强制入列（列名特征；正文不点名也维护）
	if (t.columns.some((c) => FORCED_COLUMN_HINTS.some((h) => c.name.includes(h)))) return true;
	// ④ 现有行首列实体（字符串 ≥2 字）出现在正文
	if (t.columns.length > 0 && t.rows.length > 0) {
		const key = t.columns[0]!.name;
		if (t.rows.some((r) => typeof r[key] === "string" && (r[key] as string).length >= 2 && text.includes(r[key] as string))) {
			return true;
		}
	}
	return false;
}
