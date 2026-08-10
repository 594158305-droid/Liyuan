#!/usr/bin/env node
/**
 * 梨园内置网络搜索 MCP（随发布包走）：给 agent 补原生 web 搜索能力，用于查资料、核实信息。
 * 后端可插拔：默认 SearXNG（自托管，查询不出本机）；Tavily（免费 1000 次/月，无需信用卡）。
 *
 * 配置（env，可在 扩展 → MCP → 内置 里编辑 JSON 填写）：
 *   LIYUAN_WEBSEARCH_BACKEND       后端：searxng（默认）/ tavily
 *   LIYUAN_WEBSEARCH_SEARXNG_URL   SearXNG 地址，默认 http://127.0.0.1:8080（容忍末尾斜杠）
 *   LIYUAN_WEBSEARCH_TAVILY_API_KEY Tavily API key（tavily 后端必填）
 *   LIYUAN_WEBSEARCH_TAVILY_URL     Tavily 端点，默认 https://api.tavily.com/search（可覆盖以便代理/测试）
 *   LIYUAN_WEBSEARCH_TIMEOUT_MS    单次搜索超时，默认 15000
 *
 * stdio 纪律：stdout 只走 MCP 协议，日志一律 stderr。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function log(msg) {
	process.stderr.write(`[liyuan-websearch] ${msg}\n`);
}

function envConfig() {
	const backend = (process.env.LIYUAN_WEBSEARCH_BACKEND ?? "searxng").trim().toLowerCase() || "searxng";
	// 容忍末尾斜杠 / 多余空白
	const searxngUrl =
		(process.env.LIYUAN_WEBSEARCH_SEARXNG_URL ?? "http://127.0.0.1:8080").trim().replace(/\/+$/, "") ||
		"http://127.0.0.1:8080";
	const tavilyUrl =
		(process.env.LIYUAN_WEBSEARCH_TAVILY_URL ?? "https://api.tavily.com/search").trim().replace(/\/+$/, "") ||
		"https://api.tavily.com/search";
	const tavilyApiKey = (process.env.LIYUAN_WEBSEARCH_TAVILY_API_KEY ?? "").trim();
	const timeoutMs = Number.parseInt(process.env.LIYUAN_WEBSEARCH_TIMEOUT_MS ?? "", 10);
	return {
		backend,
		searxngUrl,
		tavilyUrl,
		tavilyApiKey,
		timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000,
	};
}

/** SearXNG JSON API 完整地址（§3.2） */
function searxngSearchUrl(baseUrl, query, opts) {
	const u = new URL("/search", baseUrl);
	u.searchParams.set("q", query);
	u.searchParams.set("format", "json");
	// 未传语言也显式带 zh，保证中文场景（§3.3）
	u.searchParams.set("language", opts.language || "zh");
	u.searchParams.set("safesearch", String(opts.safesearch));
	u.searchParams.set("categories", "general");
	if (opts.timeRange) u.searchParams.set("time_range", opts.timeRange);
	return u.toString();
}

/**
 * 搜 SearXNG。请求头仅 Accept: application/json；
 * 网络失败 / 5xx / 超时自动重试一次，4xx（配置/请求问题）不重试。
 */
async function searxngSearch(query, opts) {
	const c = envConfig();
	const url = searxngSearchUrl(c.searxngUrl, query, opts);
	let lastErr = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), c.timeoutMs);
		try {
			const res = await fetch(url, {
				headers: { Accept: "application/json" },
				signal: ac.signal,
			});
			clearTimeout(timer);
			if (!res.ok) {
				const text = (await res.text().catch(() => "")).slice(0, 300);
				if (res.status === 403) {
					// settings.yml 的 search.formats 未含 json 时 webapp.py 直接 abort 403
					throw new Error(
						"SearXNG 拒绝 JSON 请求：请在其 settings.yml 的 search.formats 加入 json（默认仅 html 会 403），详见 docs/DESIGN-websearch.md §5.2",
					);
				}
				const err = new Error(`SearXNG HTTP ${res.status}：${text || res.statusText}`);
				if (res.status < 500) throw err; // 4xx 重试无意义
				lastErr = err;
				continue;
			}
			const json = await res.json();
			if (!Array.isArray(json?.results)) {
				throw new Error(`SearXNG 返回异常：${JSON.stringify(json).slice(0, 300)}`);
			}
			return json;
		} catch (e) {
			clearTimeout(timer);
			if (e?.name === "AbortError") {
				lastErr = new Error(`SearXNG 超时（${c.timeoutMs}ms）`);
				continue;
			}
			// 明确的 HTTP/格式错误直接抛（4xx 不重试）
			if (e instanceof Error && /HTTP 4\d\d|拒绝 JSON|返回异常/.test(e.message)) throw e;
			if (e instanceof TypeError) {
				// fetch 网络层失败（连接被拒 / DNS 失败等）→ 给可执行的部署指引
				lastErr = new Error(
					`无法连接 SearXNG（${c.searxngUrl}）。请先启动：\n` +
						`docker run -d --name liyuan-searxng --restart unless-stopped -p 127.0.0.1:8080:8080 -v "$PWD:/etc/searxng/" -v searxng-data:/var/cache/searxng/ docker.io/searxng/searxng:latest\n` +
						`并确认 curl http://127.0.0.1:8080/healthz 返回 OK（部署配置见 docs/DESIGN-websearch.md §5）`,
				);
				continue;
			}
			lastErr = e instanceof Error ? e : new Error(String(e));
		}
	}
	throw lastErr ?? new Error("SearXNG 调用失败");
}

/**
 * 搜 Tavily。POST {tavilyUrl}，Authorization Bearer。
 * Tavily 免费层 1000 次/月（无需信用卡）；content 是面向 LLM 的摘要。
 * 网络失败 / 5xx / 超时自动重试一次，4xx（key 错误/额度耗尽）不重试。
 */
async function tavilySearch(query, opts) {
	const c = envConfig();
	if (!c.tavilyApiKey) {
		throw new Error(
			"未配置 LIYUAN_WEBSEARCH_TAVILY_API_KEY：请到 https://tavily.com 免费注册（无需信用卡，每月 1000 次搜索），" +
				"拿到 API key 后在 扩展 → MCP → 内置 → 网络搜索 → 编辑 env 填入保存，并重开一次本对话的开关",
		);
	}
	const body = {
		query,
		search_depth: "basic",
		max_results: opts.maxResults,
		include_answer: false,
	};
	// time_range: day/week/month/year，与 SearXNG 的 day/month/year 直接对齐
	if (opts.timeRange) body.time_range = opts.timeRange;

	let lastErr = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), c.timeoutMs);
		try {
			const res = await fetch(c.tavilyUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${c.tavilyApiKey}`,
				},
				body: JSON.stringify(body),
				signal: ac.signal,
			});
			clearTimeout(timer);
			if (!res.ok) {
				const text = (await res.text().catch(() => "")).slice(0, 300);
				if (res.status === 401 || res.status === 403) {
					throw new Error(
						`Tavily 拒绝请求（HTTP ${res.status}）：请检查 API key 是否正确、额度是否用完（免费 1000 次/月）。响应：${text || res.statusText}`,
					);
				}
				const err = new Error(`Tavily HTTP ${res.status}：${text || res.statusText}`);
				if (res.status < 500) throw err; // 4xx 重试无意义
				lastErr = err;
				continue;
			}
			const json = await res.json();
			if (!Array.isArray(json?.results)) {
				throw new Error(`Tavily 返回异常：${JSON.stringify(json).slice(0, 300)}`);
			}
			return json;
		} catch (e) {
			clearTimeout(timer);
			if (e?.name === "AbortError") {
				lastErr = new Error(`Tavily 超时（${c.timeoutMs}ms）`);
				continue;
			}
			if (e instanceof Error && /HTTP 4\d\d|拒绝请求|返回异常|尚未配置/.test(e.message)) throw e;
			if (e instanceof TypeError) {
				lastErr = new Error(`无法连接 Tavily（${c.tavilyUrl}）：请检查网络/代理，或确认 URL 可访问`);
				continue;
			}
			lastErr = e instanceof Error ? e : new Error(String(e));
		}
	}
	throw lastErr ?? new Error("Tavily 调用失败");
}

/** tavily result → formatResults 可用的归一化形状（engine 固定 tavily，publishedDate 取 published_date） */
function normalizeTavilyResults(results) {
	return (Array.isArray(results) ? results : []).map((r) => ({
		title: typeof r?.title === "string" ? r.title : "",
		url: typeof r?.url === "string" ? r.url : "",
		content: typeof r?.content === "string" ? r.content : "",
		engine: "tavily",
		publishedDate: typeof r?.published_date === "string" ? r.published_date : "",
	}));
}

/** results[] → 文本列表（§3.4）：序号. 标题（engine · publishedDate 若有）/ URL / 摘要，条目间空行 */
function formatResults(results, maxResults) {
	const lines = [];
	const n = Math.min(results.length, maxResults);
	for (let i = 0; i < n; i++) {
		const r = results[i] ?? {};
		const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : "（无标题）";
		const url = typeof r.url === "string" && r.url.trim() ? r.url.trim() : "（无链接）";
		const content = typeof r.content === "string" && r.content.trim() ? r.content.trim().slice(0, 300) : "";
		const engine = typeof r.engine === "string" && r.engine.trim() ? r.engine.trim() : "";
		const publishedDate =
			typeof r.publishedDate === "string" && r.publishedDate.trim() ? r.publishedDate.trim() : "";
		const meta = [engine, publishedDate].filter(Boolean).join(" · ");
		lines.push(meta ? `${i + 1}. ${title}（${meta}）` : `${i + 1}. ${title}`);
		lines.push(`   ${url}`);
		lines.push(`   ${content || "（无摘要）"}`);
		lines.push("");
	}
	return lines.join("\n").trim();
}

const TOOLS = [
	{
		name: "web_search",
		description: "通过网络搜索引擎检索公开网页，返回标题+URL+摘要列表，用于查资料、核实信息。",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "搜索关键词，越具体越好" },
				language: { type: "string", description: "语言（SearXNG 代码），默认 zh" },
				max_results: { type: "integer", description: "返回条数 1-10，默认 5", minimum: 1, maximum: 10 },
				time_range: { type: "string", enum: ["day", "month", "year"], description: "可选：只看近期结果" },
				safesearch: { type: "integer", enum: [0, 1, 2], description: "安全搜索 0关/1中/2严，默认 1" },
			},
			required: ["query"],
		},
	},
];

function textResult(text, isError = false) {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function handleWebSearch(args) {
	const backend = envConfig().backend;
	const query = typeof args?.query === "string" ? args.query.trim() : "";
	if (!query) return textResult("缺少 query（搜索关键词）", true);
	const language = typeof args?.language === "string" && args.language.trim() ? args.language.trim() : "zh";
	let maxResults = 5;
	const mr = Number(args?.max_results);
	if (Number.isFinite(mr)) maxResults = Math.min(Math.max(Math.trunc(mr), 1), 10);
	let safesearch = 1;
	const ss = Number(args?.safesearch);
	if ([0, 1, 2].includes(ss)) safesearch = ss;
	const timeRange = ["day", "month", "year"].includes(args?.time_range) ? args.time_range : undefined;

	if (backend === "searxng") {
		const json = await searxngSearch(query, { language, timeRange, safesearch });
		let out = formatResults(Array.isArray(json.results) ? json.results : [], maxResults) || "（无结果）";
		// 部分引擎失败/降级时尾部提示（§3.4）
		const unresponsive = Array.isArray(json.unresponsive_engines) ? json.unresponsive_engines : [];
		if (unresponsive.length > 0) {
			const names = unresponsive
				.map((e) => (typeof e === "string" ? e : typeof e?.engine === "string" ? e.engine : JSON.stringify(e)))
				.filter(Boolean);
			if (names.length > 0) out += `\n\n部分引擎无响应：${names.join("、")}`;
		}
		return textResult(out);
	}

	if (backend === "tavily") {
		const json = await tavilySearch(query, { maxResults, timeRange });
		const out = formatResults(normalizeTavilyResults(json.results), maxResults) || "（无结果）";
		return textResult(out);
	}

	return textResult(`不支持的搜索后端：${backend}（可选 searxng / tavily）`, true);
}

const server = new Server({ name: "liyuan-websearch", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const { name, arguments: args } = req.params;
	try {
		if (name === "web_search") return await handleWebSearch(args ?? {});
		return textResult(`未知工具：${name}`, true);
	} catch (e) {
		return textResult(e instanceof Error ? e.message : String(e), true);
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
log("ready (stdio)");
