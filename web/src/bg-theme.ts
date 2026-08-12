/**
 * 背景图取样配色：把背景图缩略绘制到小 canvas 取平均主色，按主色明暗生成一套
 * 色板（背景/表面/分割线 + 黑白系文字），以 html 行内 CSS 变量覆盖主题变量——
 * 行内优先级高于 :root 与 html[data-theme]，关掉自动配色后删除行内变量即回落到主题色。
 * 远程 URL 受 CORS 限制时（canvas 污染抛 SecurityError）降级：仅显示背景图、跳过配色。
 * 品牌朱砂（--accent）不参与取样，保持不变。
 */

/** 与纯色（白/黑）在 HSL 空间混合：白 → 提亮降饱和，黑 → 压暗降饱和，色相不变 */
type Rgb = [number, number, number];

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = 0;
	if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
	else if (max === gn) h = ((bn - rn) / d + 2) / 6;
	else h = ((rn - gn) / d + 4) / 6;
	return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
	if (s === 0) {
		const v = Math.round(l * 255);
		return [v, v, v];
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const f = (t: number) => {
		let tt = t;
		if (tt < 0) tt += 1;
		if (tt > 1) tt -= 1;
		if (tt < 1 / 6) return p + (q - p) * 6 * tt;
		if (tt < 1 / 2) return q;
		if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
		return p;
	};
	return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

function mixWithHsl(hsl: [number, number, number], white: boolean, t: number): [number, number, number] {
	const [h, s, l] = hsl;
	if (white) return [h, s * (1 - t), l + (1 - l) * t];
	return [h, s * (1 - t), l * (1 - t)];
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const fmt = ([r, g, b]: Rgb) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** 文字色板沿用 app.css 两套主题的文字值：图亮用亮底黑字系，图暗用暗底白字系 */
const TEXT_LIGHT = { text: "#3d3833", strong: "#1c1917", soft: "#6a635c", faint: "#a39c94" };
const TEXT_DARK = { text: "#eee8e1", strong: "#faf6f1", soft: "#c4bbb1", faint: "#9a9188" };

/** bg-theme 管理的行内 CSS 变量（清除时只删这些，不误伤 --chat-w/--glass-opacity 等） */
const PALETTE_VARS = [
	"--bg",
	"--bg-glow",
	"--surface",
	"--surface-dim",
	"--surface-deep",
	"--hairline",
	"--hairline-strong",
	"--text",
	"--text-strong",
	"--text-soft",
	"--text-faint",
] as const;

function clearPalette(): void {
	const st = document.documentElement.style;
	for (const v of PALETTE_VARS) st.removeProperty(v);
}

/** 按主色生成色板：暗图 → 暗底白字系；亮图 → 亮底黑字系（surface 与 bg 的明暗关系仿 app.css 两套主题） */
function buildPalette(rgb: Rgb): Record<(typeof PALETTE_VARS)[number], string> {
	const [r, g, b] = rgb;
	const hsl = rgbToHsl(rgb);
	const dark = 0.299 * r + 0.587 * g + 0.114 * b < 128;
	const bg = dark ? mixWithHsl(hsl, false, 0.06) : mixWithHsl(hsl, true, 0.1);
	const bgGlow = mixWithHsl(bg, true, 0.06);
	const surface = dark ? mixWithHsl(bg, true, 0.1) : mixWithHsl(bg, true, 0.55);
	const surfaceDim = dark ? mixWithHsl(surface, true, 0.08) : mixWithHsl(surface, false, 0.08);
	const surfaceDeep = dark ? mixWithHsl(surface, true, 0.16) : mixWithHsl(surface, false, 0.16);
	const hairline = dark ? mixWithHsl(surface, true, 0.16) : mixWithHsl(surface, false, 0.18);
	const hairlineStrong = dark ? mixWithHsl(surface, true, 0.3) : mixWithHsl(surface, false, 0.32);
	const text = dark ? TEXT_DARK : TEXT_LIGHT;
	return {
		"--bg": fmt(hslToRgb(bg)),
		"--bg-glow": fmt(hslToRgb(bgGlow)),
		"--surface": fmt(hslToRgb(surface)),
		"--surface-dim": fmt(hslToRgb(surfaceDim)),
		"--surface-deep": fmt(hslToRgb(surfaceDeep)),
		"--hairline": fmt(hslToRgb(hairline)),
		"--hairline-strong": fmt(hslToRgb(hairlineStrong)),
		"--text": text.text,
		"--text-strong": text.strong,
		"--text-soft": text.soft,
		"--text-faint": text.faint,
	};
}

/** 竞态 token：快速连续切换背景图时，旧图的异步取样结果不得覆盖新图 */
let applyToken = 0;

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("背景图加载失败"));
		img.src = src;
	});
}

/** 缩略采样取平均主色（透明像素不参与）；canvas 污染（CORS）时抛 SecurityError 由调用方降级 */
function sampleAverage(img: HTMLImageElement): Rgb {
	const SIZE = 64;
	const c = document.createElement("canvas");
	c.width = SIZE;
	c.height = SIZE;
	const ctx = c.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("无法创建画布");
	ctx.drawImage(img, 0, 0, SIZE, SIZE);
	const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
	let r = 0;
	let g = 0;
	let b = 0;
	let n = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] === 0) continue; // 透明像素（如 PNG 贴图）不参与
		r += data[i];
		g += data[i + 1];
		b += data[i + 2];
		n++;
	}
	if (n === 0) throw new Error("背景图无可采样像素");
	return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * 按背景图取样配色：enabled 且 src 非空 → 异步取样并应用色板；否则清除已应用色板。
 * 图片加载失败或取色被 CORS 拦截 → 仅保留背景图显示，配色回落主题，console 提示。
 */
export function applyBgTheme(src: string, enabled: boolean): void {
	const t = ++applyToken;
	if (!enabled || !src) {
		clearPalette();
		return;
	}
	loadImage(src)
		.then((img) => {
			if (t !== applyToken) return; // 已被更新的设置取代
			const rgb = sampleAverage(img);
			if (t !== applyToken) return;
			const palette = buildPalette(rgb);
			const st = document.documentElement.style;
			for (const v of PALETTE_VARS) st.setProperty(v, palette[v]);
		})
		.catch((err: unknown) => {
			if (t !== applyToken) return;
			clearPalette();
			console.warn("背景图取样配色失败（远程图可能受 CORS 限制，仅显示背景图）", err);
		});
}

/** 本地图片压缩为 dataURL：最长边压到 1920、JPEG 0.85，防 localStorage 超容量 */
const MAX_EDGE = 1920;
const MAX_DATA_URL_LEN = 3_500_000; // localStorage 约 5MB，留余量

export function readImageAsCompressedDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const objUrl = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			try {
				const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
				const w = Math.max(1, Math.round(img.naturalWidth * scale));
				const h = Math.max(1, Math.round(img.naturalHeight * scale));
				const c = document.createElement("canvas");
				c.width = w;
				c.height = h;
				const ctx = c.getContext("2d");
				if (!ctx) throw new Error("无法创建画布");
				ctx.drawImage(img, 0, 0, w, h);
				const dataUrl = c.toDataURL("image/jpeg", 0.85);
				if (dataUrl.length > MAX_DATA_URL_LEN) {
					throw new Error("图片压缩后仍过大，请换一张较小的图");
				}
				resolve(dataUrl);
			} catch (e) {
				reject(e);
			} finally {
				URL.revokeObjectURL(objUrl);
			}
		};
		img.onerror = () => {
			URL.revokeObjectURL(objUrl);
			reject(new Error("图片读取失败"));
		};
		img.src = objUrl;
	});
}
