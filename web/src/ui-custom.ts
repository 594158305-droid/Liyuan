/**
 * 自定义 UI（页面宽度 + 字体比例 + 默认收起用户消息 + 玻璃透明度 + 背景图 + 自动配色）：
 * localStorage 持久化，行内 CSS 变量即时生效。字体比例用 html zoom 整体缩放（全站 px
 * 硬编码，逐处变量化不现实）；zoom 与宽度乘算，宽度反算 --chat-w = 设定px / zoom 保持
 * 视觉宽度准确。玻璃/背景图的 CSS 应用与异步取样配色见 bg-theme.ts。
 */

import { applyBgTheme } from "./bg-theme";

export type UiCustom = {
	/** 聊天列视觉宽度 px */
	chatW: number;
	/** 字体比例（百分比整数，100 = 原样） */
	fontScale: number;
	/** 用户消息默认收起（只露楼层头，点开才见正文/操作条） */
	collapseUser: boolean;
	/** 主聊天玻璃不透明度（百分比整数，0 = 关闭玻璃） */
	glass: number;
	/** 背景图 URL 或 dataURL，空串 = 不启用 */
	bgImage: string;
	/** 按背景图主色取样适配界面颜色 */
	bgAutoTheme: boolean;
};

const KEY = "liyuan.ui.custom";

export const UI_DEFAULTS: UiCustom = {
	chatW: 900,
	fontScale: 100,
	collapseUser: false,
	glass: 0,
	bgImage: "",
	bgAutoTheme: false,
};

export const UI_CHAT_W_MIN = 640;
export const UI_CHAT_W_MAX = 1400;
export const UI_CHAT_W_STEP = 20;
export const UI_FONT_MIN = 90;
export const UI_FONT_MAX = 120;
export const UI_FONT_STEP = 5;
export const UI_GLASS_MIN = 0;
export const UI_GLASS_MAX = 100;
export const UI_GLASS_STEP = 5;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function getUiCustom(): UiCustom {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? "") as Record<string, unknown>;
		if (raw && typeof raw === "object") {
			const chatW = typeof raw.chatW === "number" ? Math.round(raw.chatW) : NaN;
			const fontScale = typeof raw.fontScale === "number" ? Math.round(raw.fontScale) : NaN;
			// 核心字段缺失/无效 → 整体回落默认；新字段（glass 等）缺失按默认值，不拖垮旧数据
			if (Number.isFinite(chatW) && Number.isFinite(fontScale)) {
				return {
					chatW: clamp(chatW, UI_CHAT_W_MIN, UI_CHAT_W_MAX),
					fontScale: clamp(fontScale, UI_FONT_MIN, UI_FONT_MAX),
					collapseUser: raw.collapseUser === true,
					glass:
						typeof raw.glass === "number" && Number.isFinite(raw.glass)
							? clamp(Math.round(raw.glass), UI_GLASS_MIN, UI_GLASS_MAX)
							: UI_DEFAULTS.glass,
					bgImage: typeof raw.bgImage === "string" ? raw.bgImage : "",
					bgAutoTheme: raw.bgAutoTheme === true,
				};
			}
		}
	} catch {
		/* localStorage 不可用或未设置 */
	}
	return { ...UI_DEFAULTS };
}

export function applyUiCustom(ui: UiCustom): void {
	const html = document.documentElement;
	const zoom = ui.fontScale / 100;
	// zoom 与宽度乘算：视觉宽度 = --chat-w × zoom，反算保证设定值即视觉值
	html.style.setProperty("--chat-w", zoom === 1 ? `${ui.chatW}px` : `calc(${ui.chatW}px / ${zoom})`);
	html.style.zoom = String(zoom);
	// 主聊天玻璃：0% 时 color-mix 全透明、blur 为 0，退化为现状
	html.style.setProperty("--glass-opacity", `${ui.glass}%`);
	// 背景图：url() 内引号/反斜杠转义（dataURL 与含特殊字符的 URL 均安全）
	if (ui.bgImage) {
		html.style.setProperty(
			"--bg-image",
			`url("${ui.bgImage.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`
		);
	} else {
		html.style.removeProperty("--bg-image");
	}
	// 异步取样配色（带竞态保护）；关闭或无语图时清除色板
	applyBgTheme(ui.bgImage, ui.bgAutoTheme);
	try {
		localStorage.setItem(KEY, JSON.stringify(ui));
	} catch {
		/* 忽略写入失败 */
	}
}

/** 启动时尽早调用，避免刷新后闪回默认布局 */
export function initUiCustom(): void {
	applyUiCustom(getUiCustom());
}
