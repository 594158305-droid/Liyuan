/**
 * 插件 C「图像存储映射」（draw-slot）index.ts。
 *
 * 一期无 agent 工具（tools 空）——C 的能力走 REST 与领域函数（slot-store.ts）：
 * - 保存/删除/清理/重建/列表：server/rest.ts 的 /api/draw/slots* 路由（常驻注册）
 * - 前端占位符渲染：web/src/components/draw-slot-image.tsx（RichContent 分段替换）
 *
 * init(ctx)：读 settings（autoSave 默认 false、retentionDays 默认 3）缓存到模块级变量，
 * 供其他插件（B 管线）查询 autoSave。清理按 retention 定时/手动触发，init 只存配置。
 * 插件属领域层：零 pi / 零 server import。
 */

import type { PluginContext, PluginManifest, PluginToolDef } from "../types.ts";
import { cleanupExpired } from "./slot-store.ts";

/** 插件声明（与 plugin.json 同内容；registry 校验 id 一致性用） */
export const manifest: PluginManifest = {
	id: "draw-slot",
	name: "图像存储映射",
	version: "0.1.0",
	description: "占位符 [image:slotId] 进正文、slot 映射文件持久化、保存模式（手动默认 + 自动开关）、过期清理、索引重建、前端占位符渲染",
	tools: [],
	panels: [],
	skills: [],
	requires: [],
};

/** 插件工具（一期空：C 的能力走 REST 与领域函数，无 agent 工具面） */
export const tools: PluginToolDef[] = [];

/** 模块级配置缓存（init 注入；供 B 管线等查询） */
interface SlotSettings {
	autoSave: boolean;
	retentionDays: number;
	/** 自动清理开关（LWB clearExpiredCache 对齐）：开启时启动做一次性清理，不设定时器 */
	autoClean: boolean;
}

let slotSettings: SlotSettings = { autoSave: false, retentionDays: 3, autoClean: false };

/** 读取插件配置（autoSave / retentionDays / autoClean，缺省回默认）；供本插件 REST 与其它插件查询 */
export function getSlotSettings(): SlotSettings {
	return { ...slotSettings };
}

/** init：只存配置；autoClean 开启时做一次性过期清理（清理按 retention 定时/手动触发，不在启动时跑定时器） */
export function init(ctx: PluginContext): void {
	const s = ctx.settings ?? {};
	slotSettings = {
		autoSave: s.autoSave === true,
		retentionDays: typeof s.retentionDays === "number" && s.retentionDays >= 0 ? s.retentionDays : 3,
		autoClean: s.autoClean === true,
	};
	ctx.log(`draw-slot 就绪（autoSave=${slotSettings.autoSave}，retentionDays=${slotSettings.retentionDays}，autoClean=${slotSettings.autoClean}）`);
	// 启动一次性清理（LWB clearExpiredCache 同款语义；幂等，失败不影响插件）
	if (slotSettings.autoClean && ctx.cwd) {
		try {
			const r = cleanupExpired(ctx.cwd, slotSettings.retentionDays);
			if (r.removedSlots > 0 || r.removedFiles > 0) {
				ctx.log(`自动清理完成：移除 ${r.removedSlots} 个槽位、${r.removedFiles} 个文件`);
			}
		} catch (err) {
			ctx.log(`自动清理失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
