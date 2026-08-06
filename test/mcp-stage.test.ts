import assert from "node:assert/strict";
import { test } from "node:test";

import {
	mcpEnabledFromBranch,
	mcpStageToolNames,
	mcpStageTools,
	runMcpStageTool,
	type McpStageDeps,
} from "../src/stage/mcp-stage.ts";
import { RP_MCP_TYPE } from "../src/mcp.ts";
import type { McpToolDescriptor } from "../src/mcp.ts";

/**
 * MCP 台上接线（8/06 重接）。回归背景：009e22e 换引擎时 MCP 只留在扩展路径
 * （pi.registerTool）+ 已删除的 director.ts，台上工具清单与提示词索引双双断链
 * ——hub 连得上而模型看不见。本文件钉死「工具进得去、路由认得准、失败传得出」。
 */

const desc = (over: Partial<McpToolDescriptor> = {}): McpToolDescriptor => ({
	serverId: "vision",
	serverName: "视觉识图",
	name: "analyze_image",
	qualifiedName: "mcp__vision__analyze_image",
	description: "看图识图",
	inputSchema: { type: "object", properties: { image_source: { type: "string" } } },
	...over,
});

const makeDeps = (
	tools: McpToolDescriptor[],
	call?: McpStageDeps["callTool"],
): McpStageDeps => ({
	listTools: () => tools,
	callTool:
		call ??
		(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })),
});

test("未注入 mcp 依赖 = 台上无 MCP 工具（依赖缺失的工具不上清单）", () => {
	assert.deepEqual(mcpStageTools(undefined), []);
	assert.equal(mcpStageToolNames(undefined).size, 0);
});

test("已连接的 MCP 工具进清单：限定名 + [MCP:server] 前缀 + schema 直传", () => {
	const tools = mcpStageTools(makeDeps([desc()]));
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "mcp__vision__analyze_image");
	// 前缀让模型知道这是外部服务器的工具（失败该报错而非换工具重试）
	assert.ok(tools[0].description.startsWith("[MCP:vision]"));
	assert.ok(tools[0].description.includes("看图识图"));
	// 裸 JSON Schema 直接进 Context.tools（不经 typebox，D-T1）
	assert.equal((tools[0].parameters as { type?: string }).type, "object");
});

test("描述为空时回落工具名——不给模型一条空描述", () => {
	const tools = mcpStageTools(makeDeps([desc({ description: "" })]));
	assert.ok(tools[0].description.includes("analyze_image"));
});

test("hub 抛异常不拖垮装配：返回空清单而非崩掉整拍", () => {
	const deps: McpStageDeps = {
		listTools: () => {
			throw new Error("hub 炸了");
		},
		callTool: async () => ({ content: [], details: {} }),
	};
	assert.deepEqual(mcpStageTools(deps), []);
	assert.equal(mcpStageToolNames(deps).size, 0);
});

test("路由集只含**已连接**的限定名——模型幻觉的服务器名不得被当成 MCP 调用", async () => {
	const deps = makeDeps([desc()]);
	const names = mcpStageToolNames(deps);
	assert.ok(names.has("mcp__vision__analyze_image"));
	assert.ok(!names.has("mcp__ghost__whatever"));
	// 非 MCP 名必须回落（返回 null），否则会吞掉 draft_write 等台上工具
	assert.equal(await runMcpStageTool(deps, "draft_write", {}), null);
	assert.equal(await runMcpStageTool(deps, "lorebook_search", {}), null);
});

test("调用走真实工具名：hub 去重改写过限定名时仍打到正确的 tool", async () => {
	const seen: Array<{ server: string; tool: string }> = [];
	// 去重场景：qualifiedName 被改成 _2，但真实 name 仍是 analyze_image
	const d = desc({ qualifiedName: "mcp__vision__analyze_image_2" });
	const deps = makeDeps([d], async (server, tool) => {
		seen.push({ server, tool });
		return { content: [{ type: "text" as const, text: "图里有猫" }], details: {} };
	});
	const r = await runMcpStageTool(deps, "mcp__vision__analyze_image_2", { image_source: "a.png" });
	// 按限定名反查描述符拿真实名——直接解析前缀会得到 "analyze_image_2"（服务器没有这个工具）
	assert.deepEqual(seen, [{ server: "vision", tool: "analyze_image" }]);
	assert.equal(r?.text, "图里有猫");
	assert.equal(r?.isError ?? false, false);
	assert.ok(r?.activity?.includes("analyze_image"));
});

test("查不到描述符时退回解析前缀（hub 刚断线等边缘情形，不静默失败）", async () => {
	const seen: Array<{ server: string; tool: string }> = [];
	const deps = makeDeps([], async (server, tool) => {
		seen.push({ server, tool });
		return { content: [{ type: "text" as const, text: "x" }], details: {} };
	});
	await runMcpStageTool(deps, "mcp__vision__analyze_image", {});
	assert.deepEqual(seen, [{ server: "vision", tool: "analyze_image" }]);
});

test("isError 如实透传：模型必须看到失败，不能当成功往下演", async () => {
	const deps = makeDeps([desc()], async () => ({
		content: [{ type: "text" as const, text: "Tool not found" }],
		isError: true,
		details: {},
	}));
	const r = await runMcpStageTool(deps, "mcp__vision__analyze_image", {});
	assert.equal(r?.isError, true);
	assert.ok(r?.text.includes("Tool not found"));
});

test("callTool 抛异常回成工具结果——整拍不崩，模型看到原因自己改道", async () => {
	const deps = makeDeps([desc()], async () => {
		throw new Error("ECONNREFUSED");
	});
	const r = await runMcpStageTool(deps, "mcp__vision__analyze_image", {});
	assert.equal(r?.isError, true);
	assert.ok(r?.text.includes("ECONNREFUSED"));
	assert.ok(r?.activity?.includes("失败"));
});

test("空内容也给可读文本（模型不该收到空字符串）", async () => {
	const ok = makeDeps([desc()], async () => ({ content: [], details: {} }));
	assert.equal((await runMcpStageTool(ok, "mcp__vision__analyze_image", {}))?.text, "（无输出）");
	const bad = makeDeps([desc()], async () => ({ content: [], isError: true, details: {} }));
	const r = await runMcpStageTool(bad, "mcp__vision__analyze_image", {});
	assert.ok(r?.text.includes("错误"));
});

test("abort 信号透传：用户点停止能中断慢的 MCP 调用", async () => {
	let got: AbortSignal | undefined;
	const deps = makeDeps([desc()], async (_s, _t, _a, signal) => {
		got = signal;
		return { content: [{ type: "text" as const, text: "y" }], details: {} };
	});
	const ac = new AbortController();
	await runMcpStageTool(deps, "mcp__vision__analyze_image", {}, ac.signal);
	assert.equal(got, ac.signal);
});

// ---- 启用集从会话树读（不跨 jiti 边界问扩展要） ----

test("会话树快照 → 启用集；取最近一条（rewind 后该看到当时的启用集）", () => {
	const branch = [
		{ type: "custom", customType: RP_MCP_TYPE, data: { enabled: ["old_srv"] } },
		{ type: "message" },
		{ type: "custom", customType: RP_MCP_TYPE, data: { enabled: ["vision", "context7"] } },
	];
	assert.deepEqual(mcpEnabledFromBranch(branch, RP_MCP_TYPE), ["vision", "context7"]);
});

test("无快照返回 null（区别于空数组「显式全关」）——调用方据此回落 defaults", () => {
	assert.equal(mcpEnabledFromBranch([], RP_MCP_TYPE), null);
	assert.equal(mcpEnabledFromBranch([{ type: "message" }], RP_MCP_TYPE), null);
	// 显式全关 = 空数组，不该被当成「没配过」
	assert.deepEqual(
		mcpEnabledFromBranch([{ type: "custom", customType: RP_MCP_TYPE, data: { enabled: [] } }], RP_MCP_TYPE),
		[],
	);
});

test("快照里的 id 经 sanitize；脏数据不炸", () => {
	assert.deepEqual(
		mcpEnabledFromBranch(
			[{ type: "custom", customType: RP_MCP_TYPE, data: { enabled: ["My-Server", "", "  ", "ok_1"] } }],
			RP_MCP_TYPE,
		),
		["my_server", "ok_1"],
	);
	// enabled 不是数组 / data 不是对象 / 条目畸形：跳过继续往前找，不抛
	assert.equal(
		mcpEnabledFromBranch(
			[
				null,
				{ type: "custom", customType: RP_MCP_TYPE, data: null },
				{ type: "custom", customType: RP_MCP_TYPE, data: { enabled: "vision" } },
			] as unknown[],
			RP_MCP_TYPE,
		),
		null,
	);
});
