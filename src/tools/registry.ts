/**
 * 统一工具层地基（PLAN-RP-TOOLING M-D1，D-T1）。
 *
 * 三套注册表（台上 src/stage/tools.ts、幕后 server/assistant.ts、扩展 .liyuan/extensions/roleplay.ts）
 * 曾各写一份同名工具，文案/参数/兜底话术各不相同。此处是**唯一实现**，三面各取子集。
 *
 * 形状取 stage（D-T1）：**纯数据 schema + 依赖注入**——
 *   - parameters 是裸 JSON Schema，`src/` 内**禁止 import typebox**（破了就失去离线单测能力）；
 *     typebox 侧消费者直接吃裸 schema 即可（packages/ai 的 Compile 对裸 schema 校验正常）。
 *   - 依赖只传**函数与数据**，不放模块级可变状态（jiti 二象性红线，见 liyuan-jiti-module-duality）。
 *
 * surfaces 决定合一之后仍能分发不同子集：台上不该见 config_write，助手不该见 draft_write。
 *
 * **合一的是实现，不是清单**（D-T2）：同一工具在不同面上服务不同 agent（台上在演，助手在诊断），
 * 描述与参数按面裁剪是正当的——但两版都住在同一个文件里，改一处就看得见另一处，不会再静默漂移。
 */

/** 能力域——按板块分族，用于按消费者取子集 */
export type ToolDomain = "lore" | "memory" | "card" | "worldline" | "draft" | "state" | "panel" | "preset";

/** 消费者面 */
export type ToolSurface = "stage" | "assistant" | "extension";

/** 装配上下文：描述/schema 按面与语言裁剪 */
export interface ToolContext {
	surface: ToolSurface;
	/** 剧情语言（台上按它说话；助手面固定用配置语言即可） */
	language: string;
}

/** 工具产出：text 回给模型，activity 出过程条（无则不出条） */
export interface ToolResult {
	text: string;
	activity?: string;
	/** 结构化副信道（前端渲染/诊断用；模型看不到） */
	details?: unknown;
}

/**
 * 工具定义。Deps 是该工具族的依赖包（函数与数据，见上方红线）。
 *
 * run 的容错契约沿用 stage：**不抛**——检索失败/缺参都回可读文本，
 * 让模型能自己往下走，一拍不因工具出错而中断。
 */
export interface ToolSpec<Deps> {
	name: string;
	domain: ToolDomain;
	/** 读/写——写侧受写入门禁与消费者白名单约束（D-T4） */
	mode: "read" | "write";
	surfaces: ToolSurface[];
	/** UI 标签（助手/扩展面展示用；台上无展示位） */
	label: string;
	description: (ctx: ToolContext) => string;
	/** 裸 JSON Schema */
	parameters: (ctx: ToolContext) => Record<string, unknown>;
	run(args: Record<string, unknown>, deps: Deps, ctx: ToolContext): Promise<ToolResult>;
}

/** 取某个面可见的工具子集 */
export function toolsFor<D>(specs: ToolSpec<D>[], surface: ToolSurface): ToolSpec<D>[] {
	return specs.filter((s) => s.surfaces.includes(surface));
}

/** 按名字取——找不到返回 undefined，调用方负责回「未知工具」文本 */
export function findTool<D>(specs: ToolSpec<D>[], name: string): ToolSpec<D> | undefined {
	return specs.find((s) => s.name === name);
}

/** 读字符串参数并 trim；非字符串按空串处理（模型偶尔传 number/null） */
export function strArg(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	return typeof v === "string" ? v.trim() : "";
}

/** 读数值参数并钳到 [min,max]；缺失/非法回 fallback */
export function intArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
	const v = args[key];
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** 错误转可读文本的统一口径（工具不抛，见 ToolSpec.run 契约） */
export function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
