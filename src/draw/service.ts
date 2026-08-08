/**
 * 生图服务编排：接线层/插件的唯一入口。
 *
 * 流程：加载配置 → 选定 provider → 参数求值（preset / opts.params 覆盖 / aspect / 全局风格）
 * → 全局单例请求队列（限流+冷却）→ sendDrawRequest（fetch 可注入）→ 落盘到 cache 目录。
 * 零 pi 依赖（D3 合规）。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { dir } from "../paths.ts";
import { activeProvider, loadDrawConfig } from "./config.ts";
import type { DrawConfig, DrawParams, DrawProvider, DrawStyle } from "./config.ts";
import { DrawError } from "./errors.ts";
import { effectiveParams, resolveAspectSize } from "./params.ts";
import { DrawRequestQueue } from "./queue.ts";
import { buildEnhanceBody, buildGenerateBody, sendDrawRequest } from "./novelai.ts";

/** 额外覆盖参数：DrawParams 驼峰字段 + seed（seed -1 表示随机） */
export type DrawParamsOverrides = Partial<DrawParams> & { seed?: number };

export interface GenerateImageOptions {
	prompt: string; // 已组装的画面描述/tag（不含质量前缀）
	negativePrompt?: string;
	aspect?: "portrait" | "landscape" | "square"; // 缺省不改尺寸
	providerId?: string; // 缺省用配置默认
	presetId?: string; // 参数预设
	styleId?: string; // 全局风格预设；缺省用 defaultStyleId；"" 显式不用
	params?: DrawParamsOverrides; // 额外覆盖（steps/cfg/seed/width/height/smea 等，seed -1 表示随机）
	signal?: AbortSignal;
	fetchImpl?: typeof fetch; // 测试注入
}

export interface GenerateImageResult {
	src: string; // "/cache/draw-{ts}-{rand}.png"
	slotId: string; // "slot-" + randomUUID()
	providerId: string;
	params: DrawParams; // 实际生效参数快照
}

export interface EnhanceImageOptions {
	source: string; // "/cache/..." 或 "/media/..." 或绝对路径
	op: "redraw" | "enhance" | "upscale" | "inpaint";
	strength?: number; // redraw 0.55 / enhance 0.15 / upscale 0.1
	scaleBy?: number; // upscale 2
	maskBase64?: string; // inpaint（白底黑区）
	providerId?: string;
	presetId?: string;
	styleId?: string; // 预留：本期增强不做风格合并
	params?: DrawParamsOverrides;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

export interface EnhanceImageResult {
	src: string; // "/cache/..." 新图（新版本由插件层管理，此处不生成新 slotId）
	providerId: string;
	params: DrawParams;
}

/** 全局请求队列（模块级单例；默认冷却 15-30s，防连点烧额度） */
const queue = new DrawRequestQueue();

/** 解析全局风格：显式 styleId ?? 配置默认；空串（""）显式不用 */
function resolveStyle(cfg: DrawConfig, styleId: string | undefined): DrawStyle | null {
	const id = styleId ?? cfg.defaultStyleId ?? "";
	if (!id) return null;
	return cfg.styles.find((s) => s.id === id) ?? null;
}

/** 解析源图路径：/cache/ /media/ 前缀 → cwd 下实际目录（.liyuan-cache/.liyuan-media）；绝对路径直接用 */
function resolveSourcePath(cwd: string, source: string): string {
	// 注意：Windows 上 path.isAbsolute("/cache/x.png") 为 true（盘符相对），前缀判断须先于 isAbsolute；
	// URL 前缀的磁盘目录带点前缀（.liyuan-cache/.liyuan-media），不能只去斜杠拼接（曾拼成 cache/ 导致源图不存在）
	if (source.startsWith("/cache/")) return join(cwd, ".liyuan-cache", source.slice("/cache/".length));
	if (source.startsWith("/media/")) return join(cwd, ".liyuan-media", source.slice("/media/".length));
	if (isAbsolute(source)) return source;
	return join(cwd, source);
}

/** 外部 signal 中止时拒绝本次调用（队列为全局单例，不能整体 abort，只拒绝当前等待/请求） */
function withSignal<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return p;
	return new Promise<T>((resolve, reject) => {
		const fail = () => reject(new DrawError("timeout", "请求已取消"));
		if (signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
		// 无论是否立即失败，都挂上 p 的拒绝处理，避免队列任务的延迟拒绝变成 unhandledRejection
		p.then(
			(v) => {
				signal.removeEventListener("abort", fail);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", fail);
				reject(e);
			},
		);
	});
}

/** 选 provider：显式 providerId 优先，否则配置默认；无可用 → null */
function pickProvider(cfg: DrawConfig, providerId: string | undefined): DrawProvider | null {
	return providerId ? cfg.providers.find((p) => p.id === providerId) ?? null : activeProvider(cfg);
}

/** 参数求值：preset → opts.params 覆盖（seed 单独抽走） */
function mergeOverrides(provider: DrawProvider, presetId: string | undefined, overrides: DrawParamsOverrides | undefined) {
	let params = effectiveParams(provider, presetId);
	let seed: number | undefined;
	if (overrides) {
		const { seed: s, ...rest } = overrides;
		seed = s;
		params = { ...params, ...rest };
	}
	return { params, seed };
}

/** 文生图：返回新图（src + slotId + 生效参数快照） */
export async function generateImage(cwd: string, opts: GenerateImageOptions): Promise<GenerateImageResult> {
	if (opts.signal?.aborted) throw new DrawError("timeout", "请求已取消");
	const cfg = loadDrawConfig(cwd);
	if (cfg.providers.length === 0) throw new DrawError("unknown", "未配置画图后端");
	const provider = pickProvider(cfg, opts.providerId);
	if (!provider) throw new DrawError("unknown", "未配置画图后端");
	if (provider.type !== "novelai") throw new DrawError("unknown", `${provider.type} 尚未实现（预留）`);

	// 生效参数：preset → opts.params 覆盖 → aspect（动态分辨率：档位取自配置 cfg.aspects，缺省回退默认表）
	const { params, seed } = mergeOverrides(provider, opts.presetId, opts.params);
	const resolved = opts.aspect ? resolveAspectSize(opts.aspect, params, cfg.aspects) : params;

	// 全局风格合并（positive 前缀 + negative 前缀）
	const style = resolveStyle(cfg, opts.styleId);
	let positive = opts.prompt;
	let negative = opts.negativePrompt ?? resolved.negativePrompt;
	if (style) {
		if (style.positivePrefix) positive = `${style.positivePrefix}, ${positive}`;
		negative = [style.negativePrefix, negative].filter(Boolean).join(", ");
	}

	const body = buildGenerateBody({
		scene: positive,
		characterPrompts: [],
		negativePrompt: negative,
		params: resolved,
		model: provider.model,
		seed,
	});

	const resp = await withSignal(
		queue.enqueue(async (sig) => {
			if (opts.signal?.aborted || sig.aborted) throw new DrawError("timeout", "请求已取消");
			return sendDrawRequest({ apiKey: provider.apiKey, baseUrl: provider.baseUrl, body, fetchImpl: opts.fetchImpl });
		}),
		opts.signal,
	);

	// 落盘：dir(cwd, "cache")（.liyuan-cache）+ draw-{ts}-{rand}.png
	const cacheDir = dir(cwd, "cache");
	mkdirSync(cacheDir, { recursive: true });
	const fileName = `draw-${Date.now()}-${randomBytes(3).toString("hex")}.png`;
	writeFileSync(join(cacheDir, fileName), resp.buffer);

	return { src: `/cache/${fileName}`, slotId: `slot-${randomUUID()}`, providerId: provider.id, params: resolved };
}

/** img2img 增强/重绘/放大/局部重绘：返回新图（不生成新 slotId） */
export async function enhanceImage(cwd: string, opts: EnhanceImageOptions): Promise<EnhanceImageResult> {
	if (opts.signal?.aborted) throw new DrawError("timeout", "请求已取消");
	const cfg = loadDrawConfig(cwd);
	if (cfg.providers.length === 0) throw new DrawError("unknown", "未配置画图后端");
	const provider = pickProvider(cfg, opts.providerId);
	if (!provider) throw new DrawError("unknown", "未配置画图后端");
	if (provider.type !== "novelai") throw new DrawError("unknown", `${provider.type} 尚未实现（预留）`);

	// 解析源图路径并读入 base64
	const sourcePath = resolveSourcePath(cwd, opts.source);
	if (!existsSync(sourcePath)) throw new DrawError("parse", "源图不存在");
	const imageBase64 = readFileSync(sourcePath).toString("base64");

	// 生效参数：preset → opts.params 覆盖
	const { params, seed } = mergeOverrides(provider, opts.presetId, opts.params);

	// op → strength/noise/scaleBy/maskImage 映射
	const map: Record<EnhanceImageOptions["op"], { strength: number; noise: number; scaleBy: number; maskImage?: string }> = {
		redraw: { strength: opts.strength ?? 0.55, noise: 0, scaleBy: 1 },
		enhance: { strength: opts.strength ?? 0.15, noise: 0, scaleBy: 1 },
		upscale: { strength: opts.strength ?? 0.1, noise: 0, scaleBy: opts.scaleBy ?? 2 },
		inpaint: { strength: opts.strength ?? 0.55, noise: 0, scaleBy: 1, maskImage: opts.maskBase64 },
	};
	const m = map[opts.op];

	const body = buildEnhanceBody({
		scene: "",
		characterPrompts: [],
		negativePrompt: params.negativePrompt,
		params,
		model: provider.model,
		seed,
		imageBase64,
		strength: m.strength,
		noise: m.noise,
		scaleBy: m.scaleBy,
		...(m.maskImage ? { maskImage: m.maskImage } : {}),
	});

	const resp = await withSignal(
		queue.enqueue(async (sig) => {
			if (opts.signal?.aborted || sig.aborted) throw new DrawError("timeout", "请求已取消");
			return sendDrawRequest({ apiKey: provider.apiKey, baseUrl: provider.baseUrl, body, fetchImpl: opts.fetchImpl });
		}),
		opts.signal,
	);

	// 落盘：dir(cwd, "cache") + draw-{ts}-{rand}.png
	const cacheDir = dir(cwd, "cache");
	mkdirSync(cacheDir, { recursive: true });
	const fileName = `draw-${Date.now()}-${randomBytes(3).toString("hex")}.png`;
	writeFileSync(join(cacheDir, fileName), resp.buffer);

	return { src: `/cache/${fileName}`, providerId: provider.id, params };
}
