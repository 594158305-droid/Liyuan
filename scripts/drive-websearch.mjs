// 网络搜索 MCP 驱动脚本：spawn 内置 websearch-server.mjs，listTools 后调 web_search 打印返回与 isError。
// 自包含 MCP client（不 import src/mcp.ts）。
// 用法：node scripts/drive-websearch.mjs [--query "关键词"] [--backend searxng|tavily] [--tavily-key tvly-xxx]
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../server/mcp/websearch-server.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

// 参数解析（默认 searxng；tavily 需 --tavily-key）
const argv = process.argv.slice(2);
let query = "梨园 戏曲";
let backend = "searxng";
let tavilyKey = "";
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--query") {
		query = argv[i + 1] ?? query;
		i++;
	} else if (argv[i].startsWith("--query=")) {
		query = argv[i].slice("--query=".length);
	} else if (argv[i] === "--backend") {
		backend = argv[i + 1] ?? backend;
		i++;
	} else if (argv[i] === "--tavily-key") {
		tavilyKey = argv[i + 1] ?? "";
		i++;
	}
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [serverPath],
	cwd: root,
	env: {
		...process.env,
		LIYUAN_WEBSEARCH_BACKEND: backend,
		...(tavilyKey ? { LIYUAN_WEBSEARCH_TAVILY_API_KEY: tavilyKey } : {}),
	},
	stderr: "inherit", // 服务端日志（stderr）直接透传到终端
});

const client = new Client({ name: "drive-websearch", version: "0.1.0" });
await client.connect(transport);
try {
	const tools = await client.listTools();
	console.log(`工具列表（${tools.tools.length}）：`);
	for (const t of tools.tools) console.log(`  - ${t.name}`);

	console.log(`\n── web_search（backend=${backend}，query=${query}，max_results=3）──`);
	const res = await client.callTool({ name: "web_search", arguments: { query, max_results: 3 } });
	const text = (res?.content ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
	console.log(text);
	console.log(`\nisError=${res?.isError === true}`);
} finally {
	await client.close();
}
