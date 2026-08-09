/**
 * 瑟瑟灵感状态栏V2.67.js → liyuan-瑟瑟状态栏 转换脚本（P1 外壳）。
 *
 * 依据 docs/DESIGN-liyuan-statusbar.md 三层策略：
 * - 第一层外壳：Loader 宿主注入删除，改为 Liyuan 面板注册 + 自身 iframe 渲染
 * - bundle 内 parent.document/window.parent 重定向为自身
 * - 数据原样内联（PLAY_DATA/GACHA_DATA/PLAY_IMAGES/ACCIDENT_EVENTS_* 本就在 Loader 层）
 *
 * 用法：node scripts/convert-statusbar.mjs
 * 产出：assets/liyuan-statusbar/liyuan-瑟瑟状态栏.js（单文件，可经 JsRunnerPanel 直接导入）
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = "J:/SillyTavern/public/scripts/extensions/third-party/JS-Slash-Runner/my/瑟瑟灵感状态栏V2.67.js";
const OUT_DIR = join(ROOT, "assets", "liyuan-statusbar");
const OUT_FILE = join(OUT_DIR, "liyuan-瑟瑟状态栏.js");

const src = readFileSync(SRC, "utf8");
const lines = src.split("\n");

/** 按行前缀提取单行 var 的对象/数组字面量（Function eval 还原） */
function extractVar(prefix) {
	const line = lines.find((l) => l.trimStart().startsWith(prefix));
	if (!line) throw new Error(`未找到 ${prefix}`);
	const raw = line.slice(line.indexOf("=") + 1).trim();
	const body = raw.endsWith(";") ? raw.slice(0, -1) : raw;
	// eslint-disable-next-line no-eval
	return Function(`"use strict"; return (${body});`)();
}

/**
 * 提取跨行模板字符串（var X = ` ... `;）——EMBEDDED_HTML 跨 16-33 物理行，
 * 内部含 bundle 源码（真实换行）与转义 `\`` / `\${`。按转义规则扫描结束反引号。
 */
function extractTemplateVar(prefix) {
	const start = src.indexOf(prefix);
	if (start < 0) throw new Error(`未找到 ${prefix}`);
	const bodyStart = start + prefix.length;
	let i = bodyStart;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "\\") {
			i += 2; // 跳过转义字符（\` \${ \\ 等）
			continue;
		}
		if (ch === "`") break; // 模板字符串结束
		i++;
	}
	const raw = src.slice(bodyStart, i);
	// 还原模板字符串：内部 `\${` → `${`、`\`` → `` ` ``（eval 时转义规则）
	// eslint-disable-next-line no-eval
	return Function(`"use strict"; return \`${raw}\`;`)();
}

console.log("[convert] 提取 EMBEDDED_HTML / 数据 …");
const embeddedHtml = extractTemplateVar("var EMBEDDED_HTML = `");
const PLAY_DATA = extractVar("var PLAY_DATA");
const GACHA_DATA = extractVar("var GACHA_DATA");
const PLAY_IMAGES = extractVar("var PLAY_IMAGES");
const ACCIDENT_EVENTS_古代随机事件 = extractVar("var ACCIDENT_EVENTS_古代随机事件");
const ACCIDENT_EVENTS_现代随机事件 = extractVar("var ACCIDENT_EVENTS_现代随机事件");

/** 从 EMBEDDED_HTML 拆出 head 样式 / body 骨架 / module bundle 源码 */
function splitEmbedded(html) {
	const headMatch = html.match(/<head>([\s\S]*?)<\/head>/);
	const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
	// module bundle：head 内 `<script type="module">...</script>`（单行，webpack 打包）
	const bundleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
	// 其余 head 内容（style/link 等，去掉 module script）
	let headInner = headMatch ? headMatch[1] : "";
	headInner = headInner.replace(/<script type="module">[\s\S]*?<\/script>/, "");
	return {
		headInner,
		bodyInner: bodyMatch ? bodyMatch[1] : "",
		bundleSrc: bundleMatch ? bundleMatch[1] : "",
	};
}

const { headInner, bodyInner, bundleSrc } = splitEmbedded(embeddedHtml);
console.log(`[convert] head=${headInner.length}B body=${bodyInner.length}B bundle=${bundleSrc.length}B`);

if (!bundleSrc) throw new Error("未从 EMBEDDED_HTML 提取到 module bundle");

/** bundle 内宿主文档引用重定向（exp-4：45+89 处 parent.document/window.parent） */
function redirectParent(js) {
	return js
		.replace(/window\.parent\.document/g, "document")
		.replace(/parent\.document/g, "document")
		.replace(/window\.parent\.localStorage/g, "localStorage")
		.replace(/parent\.localStorage/g, "localStorage")
		.replace(/window\.parent\.jQuery/g, "window.jQuery")
		.replace(/parent\.jQuery/g, "window.jQuery")
		.replace(/window\.parent\.\$/g, "window.$")
		.replace(/parent\.\$/g, "window.$")
		// 其余 window.parent / parent 裸引用 → window（自身）
		.replace(/window\.parent\b(?!\.postMessage)/g, "window")
		.replace(/\bparent\.(?!postMessage)/g, "window.");
}

const bundleFixed = redirectParent(bundleSrc);
console.log(`[convert] bundle parent 重定向完成（${bundleSrc.length} → ${bundleFixed.length}B）`);

/** 生成适配主脚本 */
const out = `// ===== liyuan-瑟瑟状态栏（适配版 · P1 外壳）=====
// 适配日期: 2026-08-09 · 由 scripts/convert-statusbar.mjs 自动生成
// 原脚本: 瑟瑟灵感状态栏V2.67.js（SillyTavern JS-Slash-Runner 生态）
// 适配依据: docs/DESIGN-liyuan-statusbar.md（三层策略：外壳重写 / API 映射 / 数据替换）
// 已知降级: generateRaw 系功能（采访/立绘/天赋树/地图/特卖/大调查/日历/NSFW 指导）
//           依赖独立项 ext_generate（未实现）→ 面板内占位提示；
//           场景切换（改 ST API 预设）→ 无对等，已删除；
//           布局定位形态（fixed 悬浮）→ 不追求复刻，append 内嵌。

// ---------- 0. Liyuan 面板注册（V1/P2 通道） ----------
TavernHelper.registerLedgerPanel({ title: "瑟瑟状态栏", icon: "✨", area: "status", maxHeight: 480 });

// ---------- 1. tavern_events 常量表（G6 缺口补齐：bundle 用全局 tavern_events.X） ----------
window.tavern_events = {
	APP_READY: "APP_READY",
	CHAT_CHANGED: "CHAT_CHANGED",
	GENERATION_STARTED: "GENERATION_STARTED",
	GENERATION_ENDED: "GENERATION_ENDED",
	MESSAGE_SENT: "MESSAGE_SENT",
	MESSAGE_RECEIVED: "MESSAGE_RECEIVED",
	MESSAGE_SWIPED: "MESSAGE_SWIPED",
	MESSAGE_DELETED: "MESSAGE_DELETED",
	WORLD_STATE_CHANGED: "WORLD_STATE_CHANGED",
};

// ---------- 2. 数据暴露（原 Loader 内联数据，暴露到自身 window——bundle 同窗读取） ----------
window.__ub_play_data = ${JSON.stringify(PLAY_DATA)};
window.__ub_gacha_data = ${JSON.stringify(GACHA_DATA)};
window.__ub_play_images = ${JSON.stringify(PLAY_IMAGES)};
window.__ub_古代随机事件_events = ${JSON.stringify(ACCIDENT_EVENTS_古代随机事件)};
window.__ub_现代随机事件_events = ${JSON.stringify(ACCIDENT_EVENTS_现代随机事件)};

// ---------- 3. 自身 iframe 渲染（取代原 Loader 的宿主 body/head 注入） ----------
// 3a. head 样式（原 EMBEDDED_HTML 的 <style> 等）
document.head.insertAdjacentHTML("beforeend", ${JSON.stringify(headInner)});
// 3b. body 骨架（#ac-content / .minimal-container / 各弹层容器）
document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(bodyInner)});

// ---------- 4. 宿主全局补齐（冒烟实测：bundle 引用全局 Vue + AutoCardUpdaterAPI） ----------
// 4a. AutoCardUpdaterAPI 桩升级为 worldState 桥（P2 数据面）：
//     - exportTableAsJson() 从 getContext().worldState 构建 bundle 期望的表结构
//       （{sheet_xxx: {name, content: [[列名...],[行...]], ...}}，读侧 cj/z6 按列名匹配）
//     - 账本变化（WORLD_STATE_CHANGED）→ 重建表 + 触发 registerTableUpdateCallback（bundle 刷新）
//     - 脚本私有动态数据（瑟瑟能量/任务等）经 localStorage 代理落宿主（bundle 自带持久化）
//     - 写路径：bundle k9 操作内存表（界面即时生效）；账本字段单向 账本→状态栏
let __lyTableCb = null;
let __lySheets = null;

/** 构建 worldState 桥的表结构（每次调用重建——账本变化后刷新） */
function __lyBuildSheets() {
	const ws = getContext().worldState || {};
	const chars = (ws.characters && typeof ws.characters === "object" ? ws.characters : {}) || {};
	const charNames = Object.keys(chars);
	const hero = charNames[0] || "";
	const sheets = {};
	// 全局数据表：时间/地点/是否色色
	sheets["sheet_全局数据表"] = {
		name: "全局数据表",
		uid: "sheet_全局数据表",
		key: "全局数据表",
		content: [
			["当前时间", "当前详细地点", "是否色色"],
			[ws.time || "", ws.location || "", String(ws.flags?.["是否色色"] ?? "")],
		],
		sourceData: { ddl: "CREATE TABLE 全局数据表 (当前时间 TEXT, 当前详细地点 TEXT, 是否色色 TEXT)" },
	};
	// 主角信息表：姓名/瑟瑟能量/近况（好感）/身份背景（备注）
	sheets["sheet_主角信息表"] = {
		name: "主角信息表",
		uid: "sheet_主角信息表",
		key: "主角信息表",
		content: [
			["姓名", "瑟瑟能量", "近况", "性别", "年龄", "身份背景", "外貌特征"],
			[hero, String(chars[hero]?.affinity ?? ""), chars[hero]?.status || "", "", "", chars[hero]?.notes || "", ""],
		],
		sourceData: { ddl: "CREATE TABLE 主角信息表 (姓名 TEXT, 瑟瑟能量 TEXT, 近况 TEXT, 性别 TEXT, 年龄 TEXT, 身份背景 TEXT, 外貌特征 TEXT)" },
	};
	// 在场角色表：姓名/情绪/当前状态/当前穿搭/内心想法/过往经历
	sheets["sheet_在场角色表"] = {
		name: "在场角色表",
		uid: "sheet_在场角色表",
		key: "在场角色表",
		content: [
			["姓名", "情绪", "当前状态", "当前穿搭", "内心想法", "过往经历"],
			...charNames.map((n) => [n, "", chars[n]?.status || "", chars[n]?.outfit || "", chars[n]?.notes || "", ""]),
		],
		sourceData: { ddl: "CREATE TABLE 在场角色表 (姓名 TEXT, 情绪 TEXT, 当前状态 TEXT, 当前穿搭 TEXT, 内心想法 TEXT, 过往经历 TEXT)" },
	};
	// 物品表：物品名称/类型/数量/描述
	sheets["sheet_物品表"] = {
		name: "物品表",
		uid: "sheet_物品表",
		key: "物品表",
		content: [["物品名称", "类型", "数量", "描述"], ...(Array.isArray(ws.inventory) ? ws.inventory.map((i) => [i, "", "", ""]) : [])],
		sourceData: { ddl: "CREATE TABLE 物品表 (物品名称 TEXT, 类型 TEXT, 数量 TEXT, 描述 TEXT)" },
	};
	// 备忘录：flags 展平（键→条目）
	const flagRows = [];
	for (const k of Object.keys(ws.flags || {})) flagRows.push([k, String(ws.flags[k] ?? ""), ""]);
	sheets["sheet_备忘录"] = {
		name: "备忘录",
		uid: "sheet_备忘录",
		key: "备忘录",
		content: [["备忘", "状态", "相关角色"], ...flagRows],
		sourceData: { ddl: "CREATE TABLE 备忘录 (备忘 TEXT, 状态 TEXT, 相关角色 TEXT)" },
	};
	return sheets;
}

/** 账本变化 → 重建表 + 通知 bundle 刷新 */
function __lyRefreshSheets() {
	__lySheets = __lyBuildSheets();
	if (typeof __lyTableCb === "function") {
		try {
			__lyTableCb({ kind: "table-update", sheets: __lySheets });
		} catch (e) {
			console.warn("[liyuan-瑟瑟状态栏] table update 回调出错", e);
		}
	}
}
eventOn("WORLD_STATE_CHANGED", () => {
	__lyRefreshSheets();
});

window.AutoCardUpdaterAPI = {
	registerTableUpdateCallback: (cb) => {
		__lyTableCb = cb;
	},
	exportTableAsJson: () => {
		if (!__lySheets) __lySheets = __lyBuildSheets();
		return __lySheets;
	},
	importTableAsJson: () => ({ ok: true }),
	importTemplateFromData: () => ({ ok: true }),
	switchTemplatePreset: () => ({ ok: true }),
};

// 4c. ST 世界书 API 桩 + LLM 生成降级（脚本内本地覆盖，**不改 Liyuan 宿主代码**）：
//     - 世界书 7 方法（bundle play-wb 模块调用，宿主无这些方法 → 空值桩）
//     - generateRaw/generate（采访/立绘/天赋树等 13 调用点 → 立即 reject 降级占位，
//       依赖独立项 ext_generate；reject 由 bundle 内部 try/catch 消化，不炸宿主）
//     用本地 Proxy 包装：已知方法返回桩，其余方法回退原 TavernHelper（invoke 面）。
const __lyOrigTavernHelper = window.TavernHelper;
const __lyStubError = "LLM 生成通道未启用（依赖独立项 ext_generate，当前降级占位）";
const __lyWorldbookStubs = {
	getCharWorldbookNames: () => [],
	getWorldbookNames: () => [],
	getGlobalWorldbookNames: () => [],
	getWorldbook: () => null,
	getOrCreateChatWorldbook: () => null,
	deleteWorldbook: () => undefined,
	rebindGlobalWorldbooks: () => undefined,
	generateRaw: () => Promise.reject(new Error(__lyStubError)),
	generate: () => Promise.reject(new Error(__lyStubError)),
};
window.TavernHelper = new Proxy({}, {
	get(_t, method) {
		if (typeof method === "string" && method in __lyWorldbookStubs) {
			return __lyWorldbookStubs[method];
		}
		return __lyOrigTavernHelper[method];
	},
});

// 4d. 发送聊天替身（P3 交互）：bundle 的「写 #send_textarea + 点 #send_but」DOM 操作
//     （D()/R() 邂逅与选项栏发送）→ 脚本注入隐藏替身元素；send_but 点击 → triggerSlash
//     （exp-1 确认的唯一「带文本直接发送并生成」入口）。宿主零改动。
(function __lyInstallSendStub() {
	const ta = document.createElement("textarea");
	ta.id = "send_textarea";
	ta.style.display = "none";
	document.body.appendChild(ta);
	const btn = document.createElement("button");
	btn.id = "send_but";
	btn.style.display = "none";
	document.body.appendChild(btn);
	btn.addEventListener("click", () => {
		const text = (ta.value || "").trim();
		if (!text) return;
		ta.value = "";
		// 注意：主脚本模板内禁反引号，用字符串拼接
		TavernHelper.triggerSlash("/send " + text + "|/trigger").catch(() => {});
	});
})();

// 4b. Vue 全局注入（bundle 引用 ST 宿主全局 Vue；Liyuan iframe 无——异步加载 CDN 后注入 bundle）
const __liyuanLoadScript = (src) =>
	new Promise((resolve) => {
		const s = document.createElement("script");
		s.src = src;
		s.onload = () => resolve(true);
		s.onerror = () => resolve(false);
		document.head.appendChild(s);
	});

// ---------- 5. bundle 注入执行（module 脚本，import 远程 html2canvas 等） ----------
(async () => {
	// Vue 优先加载（bundle 内全局 Vue 引用；ST 用 Vue 2.x，CDN 主备）
	const vueLoaded = await __liyuanLoadScript("https://unpkg.com/vue@2.6.14/dist/vue.min.js");
	if (!vueLoaded) {
		console.warn("[liyuan-瑟瑟状态栏] Vue CDN 加载失败，bundle 可能报 Vue 未定义");
	}
	const __liyuanBundle = document.createElement("script");
	__liyuanBundle.type = "module";
	__liyuanBundle.textContent = ${JSON.stringify(bundleFixed)};
	document.head.appendChild(__liyuanBundle);
})();

// ---------- 5. 事件桥（Liyuan 前端投影 → bundle 期望的全局事件；bridge 已提供 window.eventOn） ----------
// Liyuan 无 CHAT_CHANGED 投影（exp-1）：MESSAGE_RECEIVED/GENERATION_ENDED 回调里比对
// currentChatId 变化即触发本地 CHAT_CHANGED（适配层包装）。
let __liyuanLastChatId = getContext().currentChatId || null;
eventOn("MESSAGE_RECEIVED", () => {
	const id = getContext().currentChatId || null;
	if (id !== __liyuanLastChatId) {
		__liyuanLastChatId = id;
		window.dispatchEvent(new CustomEvent("liyuan-chat-changed"));
		try {
			// 触发原脚本 CHAT_CHANGED 重建链（若 bundle 挂过 tavern_events.CHAT_CHANGED）
			window.eventEmit("CHAT_CHANGED", [{ sessionId: id }]);
		} catch (e) {}
	}
});

console.log("[liyuan-瑟瑟状态栏] 适配版已就绪（P1 外壳）");
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, out, "utf8");
console.log(`[convert] 完成 → ${OUT_FILE}（${out.length}B）`);
