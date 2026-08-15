import assert from "node:assert/strict";
import { test } from "node:test";

import {
	historyHasToolCall,
	isStagedModel,
	minimalStageTools,
	MINIMAL_STAGEHAND_TOOLS,
	STAGED_MODELS,
	stagedToolNames,
} from "../src/tool-staging.ts";
import type { StageTool } from "../src/stage/tools.ts";

/**
 * DSH 式双阶段工具暴露（参照 xiaobright/dsh-anchored-standard）：
 * V4 Pro 强依赖 API 可见工具目录选执行轨迹——会话早期只暴露最小工具集，
 * 首次工具调用后放开全量；状态从持久记录推导（resume/reload 不丢）。
 * 本文件钉死判定函数与两侧 Minimal 裁剪规则。
 */

const tool = (name: string): StageTool => ({ name, description: `desc ${name}`, parameters: {} });

/** 最小 readDeps mock：读侧工具无函数存在性检查（availableSpecs 只查写侧），传对象即可 */
const READ_DEPS = { getState: () => ({}), formatState: () => "" } as unknown as Parameters<typeof minimalStageTools>[1];

const STAGE_FULL = [
	"lorebook_search",
	"lorebook_read",
	"memory_search",
	"world_state_get",
	"table_query",
	"writing_guide",
	"beat_plan",
	"beat_step_done",
	"draft_write",
	"draft_append",
	"draft_edit",
	"draft_seal",
	"ask",
	"draw_generate",
	"play_sound",
	"assistant_run",
	"mcp__vision__analyze_image",
].map(tool);

test("STAGED_MODELS 只含 deepseek-v4-pro", () => {
	assert.deepEqual([...STAGED_MODELS], ["deepseek-v4-pro"]);
});

test("isStagedModel：目标模型 true，其余 false", () => {
	assert.equal(isStagedModel("deepseek-v4-pro"), true);
	assert.equal(isStagedModel("deepseek-v4-flash"), false);
	assert.equal(isStagedModel("claude-sonnet-4-5"), false);
	assert.equal(isStagedModel(undefined), false);
});

test("historyHasToolCall：空历史 / 纯文本 → false", () => {
	assert.equal(historyHasToolCall([]), false);
	assert.equal(
		historyHasToolCall([{ role: "user", content: [{ type: "text", text: "你好" }] }]),
		false,
	);
	assert.equal(
		historyHasToolCall([{ role: "assistant", content: [{ type: "text", text: "正文" }] }]),
		false,
	);
});

test("historyHasToolCall：assistant 消息含 toolCall 块 → true", () => {
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "查一下" }] },
		{ role: "assistant", content: [{ type: "text", text: "稍等" }, { type: "toolCall", name: "read", arguments: {} }] },
	];
	assert.equal(historyHasToolCall(msgs), true);
	// 只有 toolResult（工具已执行）也算——历史里出现过工具调用
	assert.equal(
		historyHasToolCall([{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "结果" }] }]),
		true,
	);
});

test("stagedToolNames：非目标模型 → null（维持现状全量）", () => {
	assert.equal(
		stagedToolNames({ modelId: "deepseek-v4-flash", registryNames: ["read", "bash"], promoted: false }),
		null,
	);
	assert.equal(
		stagedToolNames({ modelId: undefined, registryNames: ["read", "bash"], promoted: false }),
		null,
	);
});

test("stagedToolNames：已晋升（历史有工具调用）→ null（永不回退）", () => {
	assert.equal(
		stagedToolNames({ modelId: "deepseek-v4-pro", registryNames: ["read", "bash", "return_answer"], promoted: true }),
		null,
	);
});

test("stagedToolNames：未晋升 → 最小集与注册表交集", () => {
	assert.deepEqual(
		stagedToolNames({
			modelId: "deepseek-v4-pro",
			registryNames: ["read", "bash", "return_answer", "ask_user", "lorebook_search"],
			promoted: false,
		}),
		["read", "bash", "return_answer"],
	);
	// 白名单没放 bash：交集变小，return_answer 保留（委托交回通道）
	assert.deepEqual(
		stagedToolNames({
			modelId: "deepseek-v4-pro",
			registryNames: ["read", "return_answer"],
			promoted: false,
		}),
		["read", "return_answer"],
	);
});

test("stagedToolNames：交集为空 → null（防激活空工具集）", () => {
	assert.equal(
		stagedToolNames({
			modelId: "deepseek-v4-pro",
			registryNames: ["draw_generate", "tag_search"],
			promoted: false,
		}),
		null,
	);
});

test("MINIMAL_STAGEHAND_TOOLS 含委托交回通道 return_answer", () => {
	assert.ok(MINIMAL_STAGEHAND_TOOLS.includes("return_answer"));
	assert.ok(MINIMAL_STAGEHAND_TOOLS.includes("read"));
	assert.ok(MINIMAL_STAGEHAND_TOOLS.includes("bash"));
});

test("minimalStageTools：只留读侧+规划，写侧/媒体/音效/助手委托/MCP 全隐藏", () => {
	const minimal = minimalStageTools(STAGE_FULL, READ_DEPS).map((t) => t.name);
	assert.deepEqual(new Set(minimal), new Set([
		"lorebook_search",
		"memory_search",
		"world_state_get",
		"table_query",
		"writing_guide",
		"beat_plan",
		"beat_step_done",
	]));
	for (const hidden of ["draft_write", "draft_append", "draft_edit", "draft_seal", "ask", "draw_generate", "play_sound", "assistant_run", "mcp__vision__analyze_image"]) {
		assert.ok(!minimal.includes(hidden), `写侧/外设工具不应留在 Minimal：${hidden}`);
	}
	// 规划工具必须保留（装配提示词点名「第 1 轮用 beat_plan」，目录里没有会与提示词矛盾）
	assert.ok(minimal.includes("beat_plan"));
	assert.ok(minimal.includes("beat_step_done"));
	// 至少恒有两件读侧工具，Minimal 永不空
	assert.ok(minimal.includes("world_state_get"));
	assert.ok(minimal.includes("table_query"));
});

test("minimalStageTools：readDeps 未注入（undefined）时统一层工具不进 Minimal", () => {
	const minimal = minimalStageTools(STAGE_FULL, undefined).map((t) => t.name);
	assert.ok(!minimal.includes("lorebook_search"));
	assert.ok(minimal.includes("world_state_get"));
});
