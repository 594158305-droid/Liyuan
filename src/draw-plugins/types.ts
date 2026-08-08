/**
 * 能力包（生图插件）类型（DESIGN-draw §3.0）。
 *
 * 插件是领域层（src/draw-plugins/）：禁止 import @liyuan/agent-runtime（pi）——
 * 只导出纯函数与数据，工具经接线层标准接口注册。typebox 为 schema 元库，
 * 不属 pi，src/mcp.ts 已有同款引用（D-T1 注释的历史例外，此处沿用）。
 */

import type { TSchema } from "typebox";

/** plugin.json 声明（与 DESIGN §3.0 一致） */
export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	description: string;
	/** 工具名清单（声明用） */
	tools: string[];
	/** 前端面板组件清单（声明用；本期前端静态注册，动态加载留待正式插件机制） */
	panels: string[];
	/** 随插件发布的 skill 文件名（.md，位于 <plugin>/skills/ 下） */
	skills: string[];
	/** 依赖的插件 id（顺序加载 + 冲突检测，无动态解析） */
	requires: string[];
}

/** 工具结果（与 pi ToolResult 结构兼容，接线层透传；插件不得 import pi） */
export interface PluginToolResult {
	content: { type: "text"; text: string }[];
	details?: Record<string, unknown>;
	isError?: boolean;
	terminate?: boolean;
}

/** 插件工具定义（纯函数，不碰 pi） */
export interface PluginToolDef {
	name: string;
	label: string;
	description: string;
	/** TypeBox schema（接线层转 defineTool） */
	parameters: TSchema;
	execute: (params: Record<string, unknown>) => Promise<PluginToolResult> | PluginToolResult;
}

/** 插件运行时上下文 */
export interface PluginContext {
	cwd: string;
	/** 插件私有数据目录 .liyuan-plugins/<id>/（不存在则创建） */
	dataDir: string;
	/** 该插件在 liyuan.config.json plugins.<id>.settings 里的配置对象 */
	settings: Record<string, unknown>;
	log: (msg: string) => void;
}

/**
 * 回合结束钩子信息（host 侧 onTurnEnd 注入；appendPatch 由 host 提供，
 * 插件经它把 rp-draft-op 补丁写进会话树——插件本身不碰 pi / server）。
 */
export interface TurnEndHookInfo {
	/** 本回合新条目的树上 id（reroll/错误拍可能为空） */
	entryId?: string;
	/** 是否被用户中断 */
	aborted: boolean;
	/** 本回合 assistant 定稿正文（补丁已套；无则空串） */
	text?: string;
	/** 当前会话 id */
	chatId?: string;
	/** 最近 N 条前文拼接（管线规划用；缺省 ""） */
	historyText?: string;
	/** 最近一条压缩摘要（rp-summary 内容；缺省 ""） */
	summaryText?: string;
	/**
	 * 执行 rp-draft-op 补丁（host 侧闭包注入）：校验目标仍在当前分支后经
	 * sendCustomMessage 写入。返回 ok:false 表示补丁被丢弃（消息已离开分支）。
	 */
	appendPatch?: (patch: Record<string, unknown>) => { ok: boolean; reason?: string };
}

/** 能力包模块（index.ts 导出约定） */
export interface DrawPlugin {
	manifest: PluginManifest;
	tools?: PluginToolDef[];
	init?: (ctx: PluginContext) => Promise<void> | void;
	cleanup?: () => Promise<void> | void;
	/** 生命周期钩子（host 在对应时机调用；本期只有 onTurnEnd） */
	hooks?: {
		onTurnEnd?: (info: TurnEndHookInfo) => Promise<void> | void;
	};
}
