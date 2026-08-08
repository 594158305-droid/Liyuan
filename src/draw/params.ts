/**
 * 生图参数工具：aspect 分辨率映射 + provider 生效参数求值。
 * resolveAspectSize 自 src/novelai.ts 迁入；effectiveParams 自 src/draw-config.ts 迁入。
 * export 位置统一在此，config.ts / novelai.ts 不再保留。
 */

import type { DrawParams, DrawProvider } from "./config.ts";

/** aspect → 分辨率（NovelAI 常用档；用户可在 provider 参数里覆盖） */
export function resolveAspectSize(aspect: "portrait" | "landscape" | "square" | undefined, base: DrawParams): DrawParams {
	if (!aspect) return { ...base };
	const map = {
		portrait: { width: 832, height: 1216 },
		landscape: { width: 1216, height: 832 },
		square: { width: 1024, height: 1024 },
	} as const;
	const size = map[aspect];
	return { ...base, width: size.width, height: size.height };
}

/** 求 provider 生效参数：preset.params 部分覆盖 defaultParams */
export function effectiveParams(provider: DrawProvider, presetId?: string): DrawParams {
	if (!presetId) return { ...provider.defaultParams };
	const preset = provider.presets.find((p) => p.id === presetId);
	if (!preset) return { ...provider.defaultParams };
	return { ...provider.defaultParams, ...preset.params };
}
