/**
 * setScripts 的全量同步计划（M3a 纯逻辑，可 node 直跑冒烟）。
 *
 * 策略：每次 setScripts 全量对比「当前运行表」与「最新脚本列表」，
 * 只对「启用状态 / content」变化的脚本做销毁重建，未变化的不动——
 * 避免脚本内部状态（已注册的 eventOn 监听、局部变量）在无关 setScripts 时被误杀。
 * 拆成独立纯模块：不 import 任何 DOM / `?raw` 依赖，node --input-type=module 可加载验证。
 */
import type { ScriptMeta } from "./types.ts";

/** 本次同步的三段动作 */
export interface ScriptPlan {
	/** 应销毁的脚本 id（列表消失或 enabled 变 false） */
	toRemove: string[];
	/** 应新建 iframe 的脚本（新启用 / 此前 disabled 现启用 / content 变化） */
	toCreate: ScriptMeta[];
	/** 保持不动（已启用且 content 未变，保留脚本状态） */
	toKeep: ScriptMeta[];
}

/**
 * 对比当前运行表与全量脚本列表，得出增删建清单。
 *
 * @param current 当前运行表快照（id → content）；运行时传
 *                `[...runtimes].map(([id,e]) => ({ id, content: e.meta.content }))`
 * @param list    最新全量脚本列表（含 disabled）
 */
export function planScriptSync(
	current: ReadonlyArray<{ id: string; content: string }>,
	list: ScriptMeta[],
): ScriptPlan {
	const running = new Map(current.map((e) => [e.id, e.content]));
	const next = new Map<string, ScriptMeta>();
	for (const meta of list) {
		if (meta && typeof meta.id === "string" && meta.id) next.set(meta.id, meta);
	}

	const toRemove: string[] = [];
	const toCreate: ScriptMeta[] = [];
	const toKeep: ScriptMeta[] = [];

	// 当前运行表：消失 / 停用 → 移除；content 变化 → 重建；未变 → 保留
	for (const [id, content] of running) {
		const meta = next.get(id);
		if (!meta || !meta.enabled) {
			toRemove.push(id);
			continue;
		}
		if (meta.content !== content) toCreate.push(meta);
		else toKeep.push(meta);
	}
	// 新列表里新增的已启用脚本 → 新建
	for (const [id, meta] of next) {
		if (meta.enabled && !running.has(id)) toCreate.push(meta);
	}

	return { toRemove, toCreate, toKeep };
}
