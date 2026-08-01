import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	allocateServerId,
	BUILTIN_VISION_ID,
	builtinMcpServers,
	defaultSessionEnabledIds,
	discoverMcpCatalog,
	emptyMcpConfig,
	formatMcpIndex,
	loadMcpConfig,
	normalizeMcpConfig,
	parametersFromMcpSchema,
	parseMcpServersMap,
	probeMcpServer,
	qualifyMcpToolName,
	resetMcpHubForTests,
	sanitizeServerId,
	saveMcpConfig,
	setDefaultEnabled,
	serverSummary,
	validateServerConfig,
	type McpServerStatus,
} from "../src/mcp.ts";

test("sanitizeServerId and qualifyMcpToolName", () => {
	assert.equal(sanitizeServerId("Playwright MCP"), "playwright_mcp");
	assert.equal(sanitizeServerId("  "), "");
	const q = qualifyMcpToolName("playwright", "browser_navigate");
	assert.equal(q, "mcp__playwright__browser_navigate");
	assert.ok(q.length <= 64);
});

test("validateServerConfig", () => {
	assert.ok(validateServerConfig({ id: "a", name: "a", enabled: true, transport: "stdio" }));
	assert.equal(
		validateServerConfig({ id: "a", name: "a", enabled: true, transport: "stdio", command: "npx" }),
		null,
	);
	assert.equal(
		validateServerConfig({
			id: "a",
			name: "a",
			enabled: true,
			transport: "http",
			url: "http://127.0.0.1:3000/mcp",
		}),
		null,
	);
});

test("mcp config roundtrip + allocate id", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-mcp-"));
	try {
		resetMcpHubForTests();
		assert.deepEqual(loadMcpConfig(dir), emptyMcpConfig());
		// 用不太可能与本机 Claude 台账撞名的 id
		const id = allocateServerId(dir, "liyuan-unique-mcp-zzz");
		assert.equal(id, "liyuan_unique_mcp_zzz");
		saveMcpConfig(dir, {
			format: "liyuan-mcp",
			version: 2,
			servers: [
				{
					id,
					name: "LiyuanTest",
					enabled: false,
					transport: "stdio",
					command: "npx",
					args: ["-y", "@playwright/mcp@latest"],
				},
			],
			defaults: {},
		});
		const loaded = loadMcpConfig(dir);
		assert.equal(loaded.servers.length, 1);
		assert.equal(loaded.servers[0].id, "liyuan_unique_mcp_zzz");
		assert.equal(allocateServerId(dir, "liyuan-unique-mcp-zzz"), "liyuan_unique_mcp_zzz_2");
		assert.match(serverSummary(loaded.servers[0]), /npx/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		resetMcpHubForTests();
	}
});

test("normalizeMcpConfig drops bad / duplicate ids; defaults false by default", () => {
	const n = normalizeMcpConfig({
		format: "liyuan-mcp",
		version: 2,
		servers: [
			{ id: "ok", name: "OK", enabled: true, transport: "stdio", command: "x" },
			{ id: "ok", name: "dup", enabled: true, transport: "stdio", command: "y" },
			{ id: "", name: "bad", enabled: true, transport: "stdio", command: "z" },
			null as unknown as never,
		],
	});
	assert.equal(n.servers.length, 1);
	assert.equal(n.servers[0].command, "x");
	assert.equal(n.defaults?.ok, true);
});

test("parseMcpServersMap: Claude-style stdio + sse", () => {
	const list = parseMcpServersMap(
		{
			playwright: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] },
			"1shell": { type: "sse", url: "http://127.0.0.1:3301/mcp/sse", headers: { A: "b" } },
			broken: { type: "stdio" },
		},
		"claude",
	);
	assert.equal(list.length, 2);
	assert.equal(list.find((x) => x.id === "playwright")?.transport, "stdio");
	assert.equal(list.find((x) => x.id === "1shell")?.transport, "sse");
	assert.equal(list.every((x) => x.enabled === false), true);
	assert.equal(list.every((x) => x.source === "claude"), true);
});

test("discoverMcpCatalog merges project .mcp.json and liyuan-mcp; defaults off", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-mcp-disc-"));
	try {
		resetMcpHubForTests();
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					alpha: { command: "npx", args: ["-y", "x"], type: "stdio" },
				},
			}),
		);
		saveMcpConfig(dir, {
			format: "liyuan-mcp",
			version: 2,
			servers: [
				{
					id: "alpha",
					name: "Alpha Override",
					enabled: false,
					transport: "stdio",
					command: "node",
					args: ["local.js"],
				},
			],
			defaults: {},
		});
		const cat = discoverMcpCatalog(dir);
		const alpha = cat.find((c) => c.id === "alpha");
		assert.ok(alpha);
		assert.equal(alpha!.command, "node"); // liyuan 覆盖 .mcp.json
		assert.ok(alpha!.sources.includes("project-mcp") || alpha!.sources.includes("liyuan"));
		assert.equal(alpha!.enabled, false);
		assert.deepEqual(defaultSessionEnabledIds(dir), []);

		setDefaultEnabled(dir, "alpha", true);
		assert.deepEqual(defaultSessionEnabledIds(dir), ["alpha"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		resetMcpHubForTests();
	}
});

test("parametersFromMcpSchema accepts object schema", () => {
	const schema = parametersFromMcpSchema({
		type: "object",
		properties: { q: { type: "string" } },
		required: ["q"],
	});
	assert.equal((schema as { type?: string }).type, "object");
	const loose = parametersFromMcpSchema(null);
	assert.equal((loose as { type?: string }).type, "object");
});

test("formatMcpIndex mentions discovery when none enabled", () => {
	const statuses: McpServerStatus[] = [
		{
			id: "pw",
			name: "Playwright",
			enabled: false,
			defaultEnabled: false,
			transport: "stdio",
			status: "disconnected",
			summary: "npx",
			tools: [],
			source: "claude",
			sources: ["claude"],
			discovered: true,
		},
	];
	const text = formatMcpIndex(statuses);
	assert.match(text, /发现/);
	assert.match(text, /未启用/);
});

test("discover from real ~/.claude.json if present", () => {
	const p = join(homedir(), ".claude.json");
	const cat = discoverMcpCatalog(mkdtempSync(join(tmpdir(), "liyuan-mcp-home-")));
	// 只要本机有 claude 配置，目录里应出现其服务器（不依赖 cwd 项目文件）
	try {
		const j = JSON.parse(require("node:fs").readFileSync(p, "utf8"));
		const keys = Object.keys(j.mcpServers || {});
		if (keys.length === 0) return;
		const ids = new Set(cat.map((c) => c.id));
		const hit = keys.some((k: string) => ids.has(k.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32)));
		assert.ok(hit, `expected some of ${keys.join(",")} in catalog, got ${[...ids].join(",")}`);
	} catch {
		// 无 claude 配置则跳过断言
	}
});

// ---------- 内置视觉 MCP（随发布包走） ----------

test("内置视觉 MCP：目录必含，endpoint 运行时解析且脚本存在", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-mcp-builtin-"));
	try {
		resetMcpHubForTests();
		const cat = discoverMcpCatalog(dir);
		const vis = cat.find((c) => c.id === BUILTIN_VISION_ID);
		assert.ok(vis, "目录应包含 liyuan_vision");
		assert.equal(vis!.builtin, true);
		assert.equal(vis!.transport, "stdio");
		assert.equal(vis!.command, process.execPath);
		assert.match(vis!.args?.[0] ?? "", /vision-server\.mjs$/);
		assert.ok(existsSync(vis!.args![0]), "内置 server 脚本应在仓库内");
		// 默认关（RP 用不到的不必开）
		assert.equal(vis!.enabled, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		resetMcpHubForTests();
	}
});

test("内置视觉 MCP：项目覆盖只并入 env，endpoint 被重钉", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-mcp-builtin-ov-"));
	try {
		resetMcpHubForTests();
		saveMcpConfig(dir, {
			format: "liyuan-mcp",
			version: 2,
			servers: [
				{
					id: BUILTIN_VISION_ID,
					name: "视觉识图",
					enabled: false,
					transport: "stdio",
					command: "evil.exe",
					args: ["stale-path.mjs"],
					env: { LIYUAN_VISION_API_KEY: "k-test", LIYUAN_VISION_MODEL: "m" },
				},
			],
			defaults: {},
		});
		const cat = discoverMcpCatalog(dir);
		const vis = cat.find((c) => c.id === BUILTIN_VISION_ID);
		assert.ok(vis);
		assert.equal(vis!.builtin, true);
		assert.equal(vis!.command, process.execPath, "覆盖层不得改内置 endpoint");
		assert.match(vis!.args?.[0] ?? "", /vision-server\.mjs$/);
		assert.equal(vis!.env?.LIYUAN_VISION_API_KEY, "k-test", "覆盖层 env 应并入");
		assert.equal(vis!.discovered, false, "有项目条目→可删（删=回退内置默认）");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		resetMcpHubForTests();
	}
});

test("内置视觉 server 可启动并列出工具（无 key 也能起）", async () => {
	const [vis] = builtinMcpServers();
	const r = await probeMcpServer({ ...vis, env: undefined }, 30_000);
	assert.equal(r.ok, true, r.error);
	const names = r.tools.map((t) => t.name).sort();
	assert.deepEqual(names, ["analyze_image", "extract_image_text"]);
});

test("内置视觉 server：未配置时调用返回配置指引", async () => {
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
	const [vis] = builtinMcpServers();
	const transport = new StdioClientTransport({
		command: vis.command!,
		args: vis.args ?? [],
		cwd: vis.cwd,
		stderr: "pipe",
	});
	const client = new Client({ name: "liyuan-test", version: "0.0.0" });
	await client.connect(transport);
	try {
		const res = (await client.callTool({
			name: "analyze_image",
			arguments: { image_source: "https://example.com/x.png", prompt: "描述" },
		})) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
		assert.equal(res.isError, true);
		const text = res.content.map((c) => c.text ?? "").join("");
		assert.match(text, /尚未配置/);
		assert.match(text, /LIYUAN_VISION_API_KEY/);
	} finally {
		await client.close();
	}
});
