/**
 * NovelAI 生图适配（移植自 LittleWhiteBox draw 模块，Apache 2.0，作者 biex）。
 *
 * 覆盖：V4.5 / V3 请求体构造（generate + img2img 增强）、zip 响应解图、
 * 错误分类（401 认证 / 402 Anlas 不足 / 429 繁忙 / 超时）。
 * 零 pi 依赖（D3 合规）；fetch 走注入便于单测。
 * DrawError/DrawErrorCode/parseApiError/classifyError 自 ./errors.ts 引入；
 * resolveAspectSize 已迁往 ./params.ts，不再在此导出。
 */

import { execFileSync } from "node:child_process";
import { readZipEntryBytes } from "../ziplite.ts";
import type { DrawParams } from "./config.ts";
import { DrawError, classifyError, parseApiError } from "./errors.ts";

export const NOVELAI_IMAGE_API = "https://image.novelai.net/ai/generate-image";

// ---------- 代理支持（Windows 系统代理 / 环境变量） ----------
// Node 的全局 fetch（undici）默认不读系统代理；本机走代理访问 NovelAI 时直连会超时。
// 有代理时改用 undici request()（与 ProxyAgent 同源，避免版本混用报 invalid onRequestStart）。

let proxyAgent: unknown | null = null;
let proxyUrlCache: string | undefined | null = null;

/** 解析本机代理：环境变量优先，其次 Windows 注册表系统代理（与浏览器/PS 同款） */
function systemProxyUrl(): string | undefined {
	if (proxyUrlCache !== null) return proxyUrlCache ?? undefined;
	for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
		const v = process.env[k];
		if (v && v.trim()) {
			proxyUrlCache = v.trim();
			return proxyUrlCache;
		}
	}
	if (process.platform === "win32") {
		try {
			const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
			const enable = execFileSync("reg", ["query", key, "/v", "ProxyEnable"], { encoding: "utf8" });
			if (!/0x([0-9a-fA-F]+)/.exec(enable)?.[1] || parseInt(/0x([0-9a-fA-F]+)/.exec(enable)![1]!, 16) === 0) {
				proxyUrlCache = null;
				return undefined;
			}
			const server = execFileSync("reg", ["query", key, "/v", "ProxyServer"], { encoding: "utf8" });
			const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(server);
			const host = m?.[1]?.trim();
			if (!host) {
				proxyUrlCache = null;
				return undefined;
			}
			proxyUrlCache = /^https?:\/\//i.test(host) ? host : `http://${host}`;
			return proxyUrlCache;
		} catch {
			proxyUrlCache = null;
			return undefined;
		}
	}
	proxyUrlCache = null;
	return undefined;
}

/** 惰性构建 ProxyAgent（undici 同源，配合 request() 使用） */
async function getProxyAgent(): Promise<unknown | null> {
	if (proxyAgent !== null) return proxyAgent;
	const url = systemProxyUrl();
	if (!url) return null;
	try {
		const { ProxyAgent } = (await import("undici")) as typeof import("undici");
		proxyAgent = new ProxyAgent(url);
	} catch {
		proxyAgent = null;
	}
	return proxyAgent;
}

/** 单角色生图条目（对应 output-format.md 的 characters[].name/appear/costume/action/uc/center） */
export interface CharacterPrompt {
	/** 角色完整 tag 提示词（appear + costume + action 合并） */
	prompt: string;
	/** 角色级排除 tag（互斥/遮挡导致不可见的部分） */
	uc: string;
	/** 画面中心，0..1 归一化（C3 网格 = {x:0.5,y:0.5}） */
	center: { x: number; y: number };
	/** 参考图 base64（可选，角色外观参考） */
	referenceImage?: string;
	referenceImageStrength?: number;
	referenceImageType?: "character" | "style";
}

/** output-format.md 的 5×5 网格坐标（A1~E5）→ 归一化中心点 */
export function gridToCenter(grid: string): { x: number; y: number } {
	const m = /^([A-Ea-e])([1-5])$/.exec((grid ?? "").trim());
	if (!m) return { x: 0.5, y: 0.5 };
	const x = (m[1].toUpperCase().charCodeAt(0) - 65 + 0.5) / 5;
	const y = (Number(m[2]) - 0.5) / 5;
	return { x, y };
}

const MAX_SEED = 0xffffffff;

export interface GenerateInput {
	scene: string;
	characterPrompts: CharacterPrompt[];
	negativePrompt: string;
	params: DrawParams;
	/** 模型 id（默认 nai-diffusion-4-5-full；V3 模型自动走旧结构） */
	model?: string;
	seed?: number;
}

function stripDataPrefix(str: string | undefined): string | undefined {
	if (typeof str !== "string") return undefined;
	const idx = str.indexOf("base64,");
	return idx !== -1 ? str.slice(idx + 7) : str;
}

function seedOrDefault(seed: number | undefined): number {
	return seed !== undefined && seed >= 0 ? seed : Math.floor(Math.random() * (MAX_SEED + 1));
}

/** V4.5 模型（含 furry-4 等）走 params_version 3 结构；V3 走旧结构 */
function isV3(model: string): boolean {
	return model.includes("nai-diffusion-3") || model.includes("furry-3");
}

function v45Params(
	scene: string,
	characterPrompts: CharacterPrompt[],
	negativePrompt: string,
	params: DrawParams,
	seed: number,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	const useCoords = characterPrompts.some((cp) => cp.center.x !== 0.5 || cp.center.y !== 0.5);
	const charCaptions = characterPrompts.map((cp) => ({ char_caption: cp.prompt, centers: [cp.center] }));
	const negCharCaptions = characterPrompts.map((cp) => ({ char_caption: cp.uc, centers: [cp.center] }));
	const skipCfgAboveSigma =
		params.varietyBoost === true ? Math.pow((params.width * params.height) / 1011712, 0.5) * 58 : null;
	return {
		params_version: 3,
		width: params.width,
		height: params.height,
		scale: params.scale,
		seed,
		sampler: params.sampler,
		noise_schedule: params.scheduler,
		steps: params.steps,
		n_samples: 1,
		ucPreset: params.ucPreset,
		qualityToggle: params.qualityToggle,
		autoSmea: params.autoSmea,
		cfg_rescale: params.cfgRescale,
		dynamic_thresholding: false,
		controlnet_strength: 1,
		legacy: false,
		legacy_v3_extend: false,
		use_coords: useCoords,
		legacy_uc: false,
		normalize_reference_strength_multiple: true,
		deliberate_euler_ancestral_bug: false,
		prefer_brownian: true,
		image_format: "png",
		skip_cfg_above_sigma: skipCfgAboveSigma,
		...extra,
		characterPrompts: characterPrompts.map((cp) => ({
			prompt: cp.prompt || "",
			uc: cp.uc || "",
			center: cp.center,
			enabled: true,
			...(cp.referenceImage
				? {
						reference_image: stripDataPrefix(cp.referenceImage),
						reference_image_strength: cp.referenceImageStrength ?? 0.8,
						reference_image_type: cp.referenceImageType || "character",
					}
				: {}),
		})),
		v4_prompt: {
			caption: { base_caption: scene, char_captions: charCaptions },
			use_coords: useCoords,
			use_order: true,
		},
		v4_negative_prompt: {
			caption: { base_caption: negativePrompt, char_captions: negCharCaptions },
			legacy_uc: false,
		},
		negative_prompt: negativePrompt,
	};
}

/** 文生图请求体（V4.5 / V3 双结构，移植 buildNovelAIRequestBody） */
export function buildGenerateBody(input: GenerateInput): Record<string, unknown> {
	const { scene, characterPrompts, negativePrompt, params, seed } = input;
	const s = seedOrDefault(seed);
	const model = input.model ?? "nai-diffusion-4-5-full";
	if (isV3(model)) {
		const allCharPrompts = characterPrompts.map((cp) => cp.prompt).filter(Boolean).join(", ");
		const fullPrompt = scene ? `${scene}, ${allCharPrompts}` : allCharPrompts;
		const allNegative = [negativePrompt, ...characterPrompts.map((cp) => cp.uc)].filter(Boolean).join(", ");
		const firstRef = characterPrompts.find((cp) => cp.referenceImage)?.referenceImage;
		return {
			action: "generate",
			input: fullPrompt,
			model,
			parameters: {
				width: params.width,
				height: params.height,
				scale: params.scale,
				seed: s,
				sampler: params.sampler,
				noise_schedule: params.scheduler,
				steps: params.steps,
				n_samples: 1,
				negative_prompt: allNegative,
				ucPreset: params.ucPreset,
				sm: false,
				sm_dyn: false,
				dynamic_thresholding: false,
				...(firstRef
					? {
							reference_image: stripDataPrefix(firstRef),
							reference_image_strength: 0.8,
							reference_image_type: "character",
						}
					: {}),
			},
		};
	}
	return {
		action: "generate",
		input: scene,
		model,
		parameters: v45Params(scene, characterPrompts, negativePrompt, params, s),
	};
}

export interface EnhanceInput extends GenerateInput {
	/** 原图 base64（无 data: 前缀） */
	imageBase64: string;
	strength: number;
	noise: number;
	scaleBy: number;
	/** 局部重绘 mask（白底黑区，base64；NovelAI V4 img2img 支持） */
	maskImage?: string;
}

/** img2img 增强/重绘/放大请求体（移植 buildEnhanceRequestBody） */
export function buildEnhanceBody(input: EnhanceInput): Record<string, unknown> {
	const { scene, characterPrompts, negativePrompt, params, seed } = input;
	const s = seedOrDefault(seed);
	const model = input.model ?? "nai-diffusion-4-5-full";
	const enhanceParams = {
		image: input.imageBase64,
		strength: Number(input.strength) || 0,
		noise: Number(input.noise) || 0,
		scaleBy: Number(input.scaleBy) || 1,
		...(input.maskImage ? { mask_image: input.maskImage } : {}),
	};
	if (isV3(model)) {
		const allCharPrompts = characterPrompts.map((cp) => cp.prompt).filter(Boolean).join(", ");
		const fullPrompt = scene ? `${scene}, ${allCharPrompts}` : allCharPrompts;
		const allNegative = [negativePrompt, ...characterPrompts.map((cp) => cp.uc)].filter(Boolean).join(", ");
		const firstRef = characterPrompts.find((cp) => cp.referenceImage)?.referenceImage;
		return {
			action: "img2img",
			input: fullPrompt,
			model,
			parameters: {
				width: params.width,
				height: params.height,
				scale: params.scale,
				seed: s,
				sampler: params.sampler,
				noise_schedule: params.scheduler,
				steps: params.steps,
				n_samples: 1,
				negative_prompt: allNegative,
				ucPreset: params.ucPreset,
				sm: false,
				sm_dyn: false,
				dynamic_thresholding: false,
				...enhanceParams,
				...(firstRef
					? {
							reference_image: stripDataPrefix(firstRef),
							reference_image_strength: 0.8,
							reference_image_type: "character",
						}
					: {}),
			},
		};
	}
	return {
		action: "img2img",
		input: scene,
		model,
		parameters: v45Params(scene, characterPrompts, negativePrompt, params, s, enhanceParams),
	};
}

/** 从 NovelAI zip 响应中解出第一张图（.png/.webp） */
export function extractImageFromZip(buf: Buffer): Buffer {
	const img = readZipEntryBytes(buf, (name) => name.endsWith(".png") || name.endsWith(".webp"));
	if (!img) throw new DrawError("parse", "ZIP 响应中无图片");
	return img;
}

export interface DrawResponse {
	buffer: Buffer;
	width: number;
	height: number;
}

/**
 * 发送生图请求（fetch 注入便于单测）。
 * timeoutMs 默认 120s（NovelAI 生图通常 10-60s）。
 * 真实 fetch 时自动走系统代理（Windows 注册表 / 环境变量）。
 */
export async function sendDrawRequest(
	opts: {
		apiKey: string;
		baseUrl: string;
		body: Record<string, unknown>;
		timeoutMs?: number;
		fetchImpl?: typeof fetch;
	},
): Promise<DrawResponse> {
	const { apiKey, baseUrl, body, timeoutMs = 120_000, fetchImpl = fetch } = opts;
	if (!apiKey) throw new DrawError("auth", "未配置 API Key");
	const controller = new AbortController();
	const tid = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const url = `${baseUrl.replace(/\/+$/, "")}/ai/generate-image`;
		const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
		// 测试注入的 fetchImpl：直接走注入（无代理概念）
		if (fetchImpl !== fetch) {
			const res = await fetchImpl(url, {
				method: "POST",
				headers,
				signal: controller.signal,
				body: JSON.stringify(body),
			});
			if (!res.ok) throw parseApiError(res.status, await res.text().catch(() => ""));
			return { buffer: extractImageFromZip(Buffer.from(await res.arrayBuffer())), width: 0, height: 0 };
		}
		// 真实请求：有代理走 undici request（与 ProxyAgent 同源），否则全局 fetch
		const agent = await getProxyAgent();
		if (agent) {
			const { request } = (await import("undici")) as typeof import("undici");
			const r = await request(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
				dispatcher: agent,
			});
			const chunks: Buffer[] = [];
			for await (const c of r.body) chunks.push(Buffer.from(c));
			const buf = Buffer.concat(chunks);
			if (r.statusCode < 200 || r.statusCode >= 300) {
				throw parseApiError(r.statusCode, buf.toString("utf8"));
			}
			return { buffer: extractImageFromZip(buf), width: 0, height: 0 };
		}
		const res = await fetchImpl(url, {
			method: "POST",
			headers,
			signal: controller.signal,
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw parseApiError(res.status, text);
		}
		const buf = Buffer.from(await res.arrayBuffer());
		return { buffer: extractImageFromZip(buf), width: 0, height: 0 };
	} catch (e) {
		if (controller.signal.aborted && !(e instanceof DrawError)) throw new DrawError("timeout", "请求超时");
		throw classifyError(e);
	} finally {
		clearTimeout(tid);
	}
}

/** 测试连接：最小请求（1 step，64×64） */
export async function testNovelAiConnection(opts: {
	apiKey: string;
	baseUrl?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	await sendDrawRequest({
		apiKey: opts.apiKey,
		baseUrl: opts.baseUrl ?? "https://image.novelai.net",
		timeoutMs: opts.timeoutMs ?? 15_000,
		fetchImpl: opts.fetchImpl,
		body: { input: "test", model: "nai-diffusion-3", action: "generate", parameters: { width: 64, height: 64, steps: 1 } },
	});
}
