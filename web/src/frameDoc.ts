/** srcdoc 组装(纯函数,供 HtmlFrame 与测试):seamless 模式样式主权让位给卡(spec §4) */

const LEGACY_BASE_CSS =
	`html,body{margin:0;padding:0;background:transparent;color:#3f3f3f;` +
	`font:13.5px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans SC","Segoe UI",sans-serif}` +
	`img,video{max-width:100%;height:auto}` +
	`* {box-sizing:border-box}`;

/** 无痕模式兜底:只保透明底与媒体不溢出,字体配色全归卡作者 */
const SEAMLESS_BASE_CSS =
	`html,body{margin:0;padding:0;background:transparent}` + `img,video{max-width:100%;height:auto}`;

export const HEIGHT_REPORTER_SNIPPET =
	`<script>(function(){var last=0;function post(){var h=Math.max(` +
	`document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);` +
	`if(h!==last){last=h;parent.postMessage({liyuanFrameHeight:h,frameId:window.name},"*");}}` +
	`if(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement);}` +
	`window.addEventListener("load",post);setInterval(post,800);})();</script>`;

export function buildSrcDoc(html: string, scripts: boolean, seamless: boolean): string {
	const trimmed = html.trim();
	const isFull = /^\s*<(!doctype|html[\s>])/i.test(trimmed);
	const csp = scripts
		? `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:; style-src 'unsafe-inline' https: http: data:; img-src data: blob: https: http:; font-src data: https: http:; media-src data: blob: https: http:; connect-src https: http: ws: wss:; frame-src 'none'`
		: `default-src 'none'; style-src 'unsafe-inline' https: http: data:; img-src data: blob: https: http:; font-src data: https: http:; media-src data: blob: https: http:`;
	const head =
		`<meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
		`<style>${seamless ? SEAMLESS_BASE_CSS : LEGACY_BASE_CSS}</style>`;
	const tail = scripts && seamless ? HEIGHT_REPORTER_SNIPPET : "";
	if (isFull) {
		const withHead = /<head[\s>]/i.test(trimmed) ? trimmed.replace(/<head([^>]*)>/i, `<head$1>${head}`) : trimmed;
		return tail ? withHead.replace(/<\/body>/i, `${tail}</body>`) : withHead;
	}
	return `<!doctype html><html><head>${head}</head><body>${trimmed}${tail}</body></html>`;
}
