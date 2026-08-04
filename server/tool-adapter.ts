/**
 * 助手适配器（PLAN-RP-TOOLING §2.1）：统一工具层 → pi 的 ToolDefinition。
 *
 * 住在 server/ 侧的理由（D-T1）：typebox 依赖不得渗进 `src/`。
 * 实际转换很薄——`packages/ai` 的校验层对**裸 JSON Schema** 走 `Compile` 同样正常
 * （validation.ts 的 hasTypeBoxMetadata 分支即为此留），故此处只做类型断言，
 * 不重写 schema：重写才会引入「两份 schema 各自漂移」的老问题。
 */

import type { TSchema } from "typebox";

import type { ToolDefinition } from "@liyuan/agent-runtime";
import { toolsFor, type ToolContext, type ToolSpec } from "../src/tools/registry.ts";

/** 把统一层工具装成 pi ToolDefinition；deps 由调用方按面注入 */
export function assistantToolDefs<D>(specs: ToolSpec<D>[], deps: D, language: string): ToolDefinition[] {
	const ctx: ToolContext = { surface: "assistant", language };
	return toolsFor(specs, "assistant").map(
		(spec): ToolDefinition => ({
			name: spec.name,
			label: spec.label,
			description: spec.description(ctx),
			// 裸 JSON Schema 直接交给校验层（见文件头）
			parameters: spec.parameters(ctx) as unknown as TSchema,
			async execute(_id, params) {
				const r = await spec.run((params ?? {}) as Record<string, unknown>, deps, ctx);
				return { content: [{ type: "text" as const, text: r.text }] };
			},
		}),
	);
}
