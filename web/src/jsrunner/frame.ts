/**
 * JS Runner 脚本 iframe 的 srcdoc 组装（M3a，纯函数）。
 *
 * 与 frameDoc.ts 的 buildSrcDoc 同一组装思路：CSP meta + 按序注入 <head>/<body> 的
 * <script>。本文件是「脚本运行」专用帧：CSP 放行内联脚本/远程资源/WS（与程序卡一致），
 * 但不渲染任何 UI（隐藏 iframe 只需跑脚本）。
 *
 * 复用点：
 * - CSP 常量复制自 frameDoc.ts buildSrcDoc 的「scripts 分支」（该文件第 262-263 行），
 *   为不扰动程序卡逻辑，这里复制并注明出处；
 * - `</script` 转义思路对齐 frameDoc.ts escapeScriptEndTags（其正文替换步
 *   `body.replace(/<\/script/gi, "<\\/script")`）；本文件面向「整段原始 JS 字符串」，
 *   用更直接的内联转义。
 */
import { vendorScripts } from "./vendor.ts";
import type { ScriptMeta } from "./types.ts";

/**
 * 脚本帧 CSP：与 frameDoc.ts 程序卡分支一致
 * （web/src/frameDoc.ts buildSrcDoc 第 262-263 行，scripts 分支原文）。
 * 必需：`unsafe-inline`/`unsafe-eval`（内联脚本 + eval），
 * connect-src 放行 https/http/ws/wss（脚本可拉远程数据/连 WS），
 * frame-src 'none' 禁止嵌套帧（脚本 iframe 只跑自身脚本）。
 */
export const SCRIPT_FRAME_CSP =
	`default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:; ` +
	`style-src 'unsafe-inline' https: http: data:; img-src data: blob: https: http:; ` +
	`font-src data: https: http:; media-src data: blob: https: http:; ` +
	`connect-src https: http: ws: wss: data: blob:; worker-src blob: data:; frame-src 'none'`;

/**
 * 整段 JS 源码内联进 <script> 前的 `</script` 转义（对齐 frameDoc.escapeScriptEndTags
 * 正文替换步：`</script` → `<\/script`，JS 字符串/模板里反斜杠转义后 HTML 解析器不再截断）。
 */
export function escapeInlineScript(src: string): string {
	return src.replace(/<\/script/gi, "<\\/script");
}

/**
 * 本任务的最小桥占位（M3b 用真实 TavernHelper/getContext 桥替换）：
 * 标记桥已就绪 + 向宿主上报 ready，让协议先跑通。
 */
export const MINIMAL_BRIDGE_JS = `(function () {
	window.__JSRUNNER_BRIDGE_READY__ = true;
	try {
		parent.postMessage({ kind: "ready" }, "*");
	} catch (e) {
		console.error("[jsrunner bridge] ready 上报失败", e);
	}
})();`;

/**
 * 组装脚本 iframe 的 srcdoc。
 *
 * @param meta      脚本条目（content 作为脚本本体注入）
 * @param bridgeJs  桥源码字符串（M3b 提供；空串/纯空白时退化为 MINIMAL_BRIDGE_JS 占位）
 *
 * 注入顺序（按 <head>/<body> 排列）：
 *   <head>
 *     1. CSP meta（+ charset）
 *     2. vendor：jquery → 全局 `$`/`jQuery`；js-yaml UMD → 全局 `jsyaml`，随后别名 `YAML`
 *     3. bridgeJs（原样注入，包 <script>）
 *   <body>
 *     4. 脚本本体（meta.content，`type="module"` —— 上游脚本生态（RisuAI 风格）是 ES module，
 *        顶层 `import` / `import()` 必须 module 上下文才能跑；module 在文档解析完后执行，
 *        桥（head 经典脚本）先于它就位，就绪上报的 setTimeout(0) 也在 module 执行后触发）
 * 高度上报不做：隐藏 iframe 不需要（与 frameDoc 的 HEIGHT_REPORTER_SNIPPET 不同场景）。
 */
export function buildScriptSrcDoc(meta: ScriptMeta, bridgeJs: string): string {
	const bridge = bridgeJs && bridgeJs.trim() ? bridgeJs : MINIMAL_BRIDGE_JS;
	const head =
		`<meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="${SCRIPT_FRAME_CSP}">` +
		// 2a. jquery（全局 $ / jQuery）
		`<script>${escapeInlineScript(vendorScripts.jquerySrc)}</script>` +
		// 2b. js-yaml UMD（全局 jsyaml）
		`<script>${escapeInlineScript(vendorScripts.yamlSrc)}</script>` +
		// 2c. 别名：ST 脚本用 YAML.parse/load，挂 window.YAML
		`<script>window.YAML = window.jsyaml;</script>` +
		// 3. 桥（原样注入）
		`<script>${escapeInlineScript(bridge)}</script>`;
	// 4. 脚本本体（type="module"：支持顶层 import / import()，上游脚本生态的 ES module 写法）
	const body = `<script type="module">${escapeInlineScript(meta.content ?? "")}</script>`;
	return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}
