/**
 * 生图参数工具：aspect 分辨率映射 + provider 生效参数求值。
 * resolveAspectSize 自 src/novelai.ts 迁入；effectiveParams 自 src/draw-config.ts 迁入。
 * export 位置统一在此，config.ts / novelai.ts 不再保留。
 */

import { DEFAULT_DRAW_ASPECTS, type DrawAspects, type DrawParams, type DrawProvider } from "./config.ts";

/**
 * aspect → 分辨率（动态分辨率）：优先取配置档位（liyuan.draw.json 顶层 aspects），
 * 缺省/非法回退默认表（DEFAULT_DRAW_ASPECTS）。档位永远覆盖 base 的 width/height
 * （显式 width/height 仅在未传 aspect 时生效）。
 */
export function resolveAspectSize(
	aspect: "portrait" | "landscape" | "square" | undefined,
	base: DrawParams,
	aspects?: DrawAspects,
): DrawParams {
	if (!aspect) return { ...base };
	const size = aspects?.[aspect] ?? DEFAULT_DRAW_ASPECTS[aspect];
	return { ...base, width: size.width, height: size.height };
}

/** 求 provider 生效参数：preset.params 部分覆盖 defaultParams */
export function effectiveParams(provider: DrawProvider, presetId?: string): DrawParams {
	if (!presetId) return { ...provider.defaultParams };
	const preset = provider.presets.find((p) => p.id === presetId);
	if (!preset) return { ...provider.defaultParams };
	return { ...provider.defaultParams, ...preset.params };
}
