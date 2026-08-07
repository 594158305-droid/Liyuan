/**
 * 生图配置（liyuan.draw.json）：provider 注册表 + 参数预设 + 默认值。
 *
 * 密钥不入库（.gitignore，与 liyuan.agent.json 同列）。零 pi 依赖（D3 合规）。
 * type 预留 sd-webui / comfyui，本期仅实现 novelai（框架通用）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readJsonFile } from "./jsonio.ts";

export const DRAW_CONFIG_FILE = "liyuan.draw.json";

/** 生图参数（NovelAI 兼容；provider 扩展时按需加字段） */
export interface DrawParams {
	/** 采样器，如 k_euler_ancestral */
	sampler: string;
	/** 噪声调度，如 karras */
	scheduler: string;
	steps: number;
	/** CFG scale */
	scale: number;
	width: number;
	height: number;
	/** 整图负面提示词（负面角色级 uc 由角色条目单独给） */
	negativePrompt: string;
	/** NovelAI uc 预设档（0 = 默认） */
	ucPreset: number;
	/** V4.5 quality toggle（1.0.0 之前版本无此开关） */
	qualityToggle: boolean;
	/** V4.5 autoSmea */
	autoSmea: boolean;
	/** cfg_rescale（V4.5） */
	cfgRescale: number;
	/** V4.5 variety_boost（低 CFG 高 sigma 采样，出图更发散） */
	varietyBoost?: boolean;
}

/** 参数预设（同一 provider 下可存多套，如「3D 风格」「精细插画」） */
export interface DrawPreset {
	id: string;
	name: string;
	model: string;
	/** 部分覆盖 defaultParams */
	params: Partial<DrawParams>;
}

export interface DrawProvider {
	id: string;
	/** novelai 本期实现；sd-webui / comfyui 预留 */
	type: "novelai" | "sd-webui" | "comfyui";
	name: string;
	apiKey: string;
	/** 可覆盖（自托管网关时用） */
	baseUrl: string;
	model: string;
	defaultParams: DrawParams;
	presets: DrawPreset[];
	enabled: boolean;
	/** agent 剧情内生图前是否 ask_user 确认（防烧额度） */
	autoConfirm: boolean;
}

export interface DrawConfig {
	version: number;
	defaultProvider: string;
	providers: DrawProvider[];
	/** 全局默认：agent 生图前是否询问确认（provider 级 autoConfirm 覆盖） */
	autoConfirm: boolean;
}

/** V4.5 Full 默认参数（移植 LittleWhiteBox DEFAULT_PARAMS_PRESET，Apache 2.0） */
export const DEFAULT_DRAW_PARAMS: DrawParams = {
	sampler: "k_euler_ancestral",
	scheduler: "karras",
	steps: 28,
	scale: 6,
	width: 1216,
	height: 832,
	negativePrompt:
		"lowres, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry",
	ucPreset: 0,
	qualityToggle: true,
	autoSmea: false,
	cfgRescale: 0,
};

/** 3D 风格默认负面（移植 LittleWhiteBox DEFAULT_PARAMS_PRESET_2 的 negativePrefix） */
export const DEFAULT_NEGATIVE_3D =
	"easynegative, bad, bad anatomy, bad composition, bad feet, bad hands, blurry, cropped, deformed, digit, error, extra digit, extra limb, extra missing fingers, fewer digits, imperfect eyes, inaccurate eyes, inaccurate limb, jpeg artifacts, low quality, lowres, negative_hand, missing limbs, normal quality, painting by bad-artist, signature, skewed eyes, text, ugly, ugly body, unnatural body, unnatural face, username, watermark, worst quality, missing fingers";

export const DEFAULT_MODEL = "nai-diffusion-4-5-full";

export function emptyDrawConfig(): DrawConfig {
	return { version: 1, defaultProvider: "", providers: [], autoConfirm: false };
}

export function drawConfigPath(cwd: string): string {
	return join(cwd, DRAW_CONFIG_FILE);
}

/** 规范化单条 provider（缺失字段回默认；坏字段静默丢弃） */
export function normalizeDrawProvider(raw: unknown): DrawProvider | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : "";
	const type = o.type === "sd-webui" || o.type === "comfyui" ? o.type : "novelai";
	const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : id || "未命名";
	if (!id) return null;
	const rawParams = (o.defaultParams && typeof o.defaultParams === "object" ? o.defaultParams : {}) as Record<string, unknown>;
	const dp = { ...DEFAULT_DRAW_PARAMS };
	if (typeof rawParams.sampler === "string" && rawParams.sampler) dp.sampler = rawParams.sampler;
	if (typeof rawParams.scheduler === "string" && rawParams.scheduler) dp.scheduler = rawParams.scheduler;
	if (typeof rawParams.steps === "number" && Number.isFinite(rawParams.steps) && rawParams.steps > 0) dp.steps = Math.round(rawParams.steps);
	if (typeof rawParams.scale === "number" && Number.isFinite(rawParams.scale) && rawParams.scale > 0) dp.scale = rawParams.scale;
	if (typeof rawParams.width === "number" && Number.isFinite(rawParams.width) && rawParams.width > 0) dp.width = Math.round(rawParams.width);
	if (typeof rawParams.height === "number" && Number.isFinite(rawParams.height) && rawParams.height > 0) dp.height = Math.round(rawParams.height);
	if (typeof rawParams.negativePrompt === "string") dp.negativePrompt = rawParams.negativePrompt;
	if (typeof rawParams.ucPreset === "number" && Number.isFinite(rawParams.ucPreset)) dp.ucPreset = rawParams.ucPreset;
	if (typeof rawParams.qualityToggle === "boolean") dp.qualityToggle = rawParams.qualityToggle;
	if (typeof rawParams.autoSmea === "boolean") dp.autoSmea = rawParams.autoSmea;
	if (typeof rawParams.cfgRescale === "number" && Number.isFinite(rawParams.cfgRescale)) dp.cfgRescale = rawParams.cfgRescale;
	if (typeof rawParams.varietyBoost === "boolean") dp.varietyBoost = rawParams.varietyBoost;

	const presets = Array.isArray(o.presets)
		? o.presets
				.map((p): DrawPreset | null => {
					if (!p || typeof p !== "object") return null;
					const po = p as Record<string, unknown>;
					const pid = typeof po.id === "string" && po.id.trim() ? po.id.trim() : "";
					if (!pid) return null;
					const pname = typeof po.name === "string" && po.name.trim() ? po.name.trim() : pid;
					const pmodel = typeof po.model === "string" && po.model.trim() ? po.model.trim() : DEFAULT_MODEL;
					const pparams =
						po.params && typeof po.params === "object"
							? { ...DEFAULT_DRAW_PARAMS, ...normalizePartialParams(po.params as Record<string, unknown>) }
							: { ...DEFAULT_DRAW_PARAMS };
					return { id: pid, name: pname, model: pmodel, params: pparams };
				})
				.filter((p): p is DrawPreset => p !== null)
		: [];

	return {
		id,
		type,
		name,
		apiKey: typeof o.apiKey === "string" ? o.apiKey : "",
		baseUrl: typeof o.baseUrl === "string" && o.baseUrl.trim() ? o.baseUrl.trim() : "https://image.novelai.net",
		model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : DEFAULT_MODEL,
		defaultParams: dp,
		presets,
		enabled: o.enabled !== false,
		autoConfirm: o.autoConfirm === true,
	};
}

function normalizePartialParams(o: Record<string, unknown>): Partial<DrawParams> {
	const out: Partial<DrawParams> = {};
	if (typeof o.sampler === "string" && o.sampler) out.sampler = o.sampler;
	if (typeof o.scheduler === "string" && o.scheduler) out.scheduler = o.scheduler;
	if (typeof o.steps === "number" && Number.isFinite(o.steps) && o.steps > 0) out.steps = Math.round(o.steps);
	if (typeof o.scale === "number" && Number.isFinite(o.scale) && o.scale > 0) out.scale = o.scale;
	if (typeof o.width === "number" && Number.isFinite(o.width) && o.width > 0) out.width = Math.round(o.width);
	if (typeof o.height === "number" && Number.isFinite(o.height) && o.height > 0) out.height = Math.round(o.height);
	if (typeof o.negativePrompt === "string") out.negativePrompt = o.negativePrompt;
	if (typeof o.ucPreset === "number" && Number.isFinite(o.ucPreset)) out.ucPreset = o.ucPreset;
	if (typeof o.qualityToggle === "boolean") out.qualityToggle = o.qualityToggle;
	if (typeof o.autoSmea === "boolean") out.autoSmea = o.autoSmea;
	if (typeof o.cfgRescale === "number" && Number.isFinite(o.cfgRescale)) out.cfgRescale = o.cfgRescale;
	if (typeof o.varietyBoost === "boolean") out.varietyBoost = o.varietyBoost;
	return out;
}

/** 读配置（文件缺失/损坏时安静降级为空配置） */
export function loadDrawConfig(cwd: string): DrawConfig {
	const path = drawConfigPath(cwd);
	if (!existsSync(path)) return emptyDrawConfig();
	try {
		const raw = readJsonFile(path) as Record<string, unknown>;
		const providers = Array.isArray(raw.providers)
			? raw.providers.map(normalizeDrawProvider).filter((p): p is DrawProvider => p !== null)
			: [];
		const defaultProvider =
			typeof raw.defaultProvider === "string" && providers.some((p) => p.id === raw.defaultProvider)
				? raw.defaultProvider
				: providers.find((p) => p.enabled)?.id ?? "";
		return {
			version: 1,
			defaultProvider,
			providers,
			autoConfirm: raw.autoConfirm === true,
		};
	} catch {
		return emptyDrawConfig();
	}
}

/** 写配置（缺目录则建；key 原样保留） */
export function saveDrawConfig(cwd: string, cfg: DrawConfig): void {
	const path = drawConfigPath(cwd);
	mkdirSync(join(cwd), { recursive: true });
	writeFileSync(path, `${JSON.stringify(cfg, null, "\t")}\n`, "utf8");
}

/** 当前生效 provider（默认 provider 不可用则取第一个 enabled） */
export function activeProvider(cfg: DrawConfig): DrawProvider | null {
	return cfg.providers.find((p) => p.id === cfg.defaultProvider) ?? cfg.providers.find((p) => p.enabled) ?? null;
}

export function newProviderId(): string {
	return randomBytes(4).toString("hex");
}

/** 求 provider 生效参数：preset.params 部分覆盖 defaultParams */
export function effectiveParams(provider: DrawProvider, presetId?: string): DrawParams {
	if (!presetId) return { ...provider.defaultParams };
	const preset = provider.presets.find((p) => p.id === presetId);
	if (!preset) return { ...provider.defaultParams };
	return { ...provider.defaultParams, ...preset.params };
}
