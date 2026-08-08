/**
 * 插件 D「占位符图片编辑」（draw-edit）一期。
 *
 * 说明：draw-edit 本身无后端领域逻辑（操作全部复用底座 service + 插件 C slot-store + REST）：
 * - 保存/删除/重新生成/增强/放大/局部重绘/编辑TAG 全走 REST（/api/draw/generate、/api/draw/enhance、
 *   /api/draw/slots*）——UI 操作条见 web/src/components/draw-slot-image.tsx，画廊见 gallery-section.tsx；
 * - 前端组件常驻但按 config.plugins.draw-edit.enabled 显示（与 draw-role/draw-slot 同模式）。
 * 插件属领域层：零 pi / 零 server import。
 */

import type { PluginContext, PluginManifest, PluginToolDef } from "../types.ts";

/** 插件声明（与 plugin.json 同内容；registry 校验 id 一致性用） */
export const manifest: PluginManifest = {
	id: "draw-edit",
	name: "占位符图片编辑",
	version: "0.1.0",
	description: "消息内图片悬浮操作条：保存/删除/重新生成/增强/放大/局部重绘/编辑TAG再生；画廊版本网格升级",
	tools: [],
	panels: ["DrawEditPanel"],
	skills: [],
	requires: ["draw-slot", "draw-pipeline"],
};

/** 插件工具（无 agent 工具面：编辑操作走 REST + 前端） */
export const tools: PluginToolDef[] = [];

/** init 空实现（无后端状态） */
export function init(_ctx: PluginContext): void {
	/* 无初始化 */
}
