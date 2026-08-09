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
// 4a. AutoCardUpdaterAPI 最小桩（P1 外壳）：让主流程就绪轮询立即通过——
//     轮询条件是 t 存在且 registerTableUpdateCallback 为函数（bundle 分析确认），
//     exportTableAsJson 期望返回 {sheet_xxx: {...}} 结构（空对象即可让遍历无害）；
//     真实数据桥（worldState/内嵌库）留 P2。
window.AutoCardUpdaterAPI = {
	registerTableUpdateCallback: () => {},
	exportTableAsJson: () => ({}),
	importTableAsJson: () => ({ ok: true }),
	importTemplateFromData: () => ({ ok: true }),
	switchTemplatePreset: () => ({ ok: true }),
};

// 4c. ST 世界书 API 桩（脚本内本地覆盖，**不改 Liyuan 宿主代码**）：
//     bundle play-wb 模块调用 TavernHelper.getCharWorldbookNames 等 7 个 ST 世界书方法，
//     宿主 helper.ts 无这些方法（按「无对等 → 桩」原则在脚本侧补桩，宿主零改动）。
//     用本地 Proxy 包装：已知世界书方法返回空值桩，其余方法回退原 TavernHelper（invoke 面）。
const __lyOrigTavernHelper = window.TavernHelper;
const __lyWorldbookStubs = {
	getCharWorldbookNames: () => [],
	getWorldbookNames: () => [],
	getGlobalWorldbookNames: () => [],
	getWorldbook: () => null,
	getOrCreateChatWorldbook: () => null,
	deleteWorldbook: () => undefined,
	rebindGlobalWorldbooks: () => undefined,
};
window.TavernHelper = new Proxy({}, {
	get(_t, method) {
		if (typeof method === "string" && method in __lyWorldbookStubs) {
			return __lyWorldbookStubs[method];
		}
		return __lyOrigTavernHelper[method];
	},
});

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
