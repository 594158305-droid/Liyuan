/**
 * 能力包注册表（DESIGN-draw §3.0）：扫描 / 校验 / 拓扑 / 加载 / 初始化 / 缓存。
 *
 * 插件目录约定：<cwd>/src/draw-plugins/<id>/（plugin.json + index.ts + skills/）。
 * 插件是领域层（src/ 范畴）：本模块零 pi 依赖；工具经接线层（server/assistant.ts）注册。
 * 默认全关：config.plugins.<id>.enabled !== true 即视为 disabled。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { DrawPlugin, PluginManifest, PluginToolDef, TurnEndHookInfo } from "./types.ts";

export interface PluginRuntime {
	/** 全部启用的插件模块（按 requires 拓扑顺序） */
	plugins: DrawPlugin[];
	/** 启用插件的全部工具定义（拓扑顺序） */
	toolDefs: PluginToolDef[];
	/** 启用插件的全部工具名 */
	toolNames: string[];
	/** 校验/加载过程中的警告 */
	warnings: string[];
}

/** 插件私有数据目录（.liyuan-plugins/<id>/） */
export const PLUGIN_DATA_DIR = ".liyuan-plugins";

const PLUGIN_ID_RE = /^[a-z0-9-]+$/;

/** 模块级缓存：initPlugins 幂等；测试经 resetPluginsForTest 清理 */
let runtimeCache: PluginRuntime | null = null;

/** 回合结束钩子（启用插件注册；host 在 onTurnEnd 后批量调用） */
const turnEndHookList: Array<(info: TurnEndHookInfo) => Promise<void> | void> = [];

/**
 * 扫描 src/draw-plugins/ 下各子目录的 plugin.json，返回按目录发现的 manifest 列表（不校验顺序）。
 * 目录缺失 / 声明文件损坏 → 跳过（静默，后续校验再报结构问题）。
 */
export function scanPluginManifests(pluginsDir: string): PluginManifest[] {
	const out: PluginManifest[] = [];
	let entries: string[];
	try {
		entries = readdirSync(pluginsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return out; // 目录不存在
	}
	for (const id of entries) {
		const pj = join(pluginsDir, id, "plugin.json");
		if (!existsSync(pj)) continue;
		try {
			const raw = JSON.parse(readFileSync(pj, "utf8")) as unknown;
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				out.push(raw as PluginManifest);
			}
		} catch {
			// 声明文件损坏：跳过
		}
	}
	return out;
}

/** 字符串数组校验失败时给的中文警告 */
const nonStringArray = (id: string, key: string): string => `插件「${id}」的 ${key} 必须是字符串数组`;

/**
 * 校验 manifest：
 * - id 唯一（重复：保留先出现者，后出现者丢弃并警告）
 * - id 只允许 /^[a-z0-9-]+$/（非法则丢弃并警告）
 * - tools/panels/skills/requires 均为字符串数组（否则丢弃并警告）
 * - requires 引用的 id 必须存在于扫描结果（否则警告并视为满足但记录 warning）
 * - 重复 requires 去重
 */
export function validateManifests(manifests: PluginManifest[]): { manifests: PluginManifest[]; warnings: string[] } {
	const warnings: string[] = [];
	const out: PluginManifest[] = [];
	const seen = new Set<string>();
	for (const m of manifests) {
		if (!m || typeof m !== "object") continue;
		const id = typeof m.id === "string" ? m.id.trim() : "";
		if (!id) {
			warnings.push("发现缺少 id 的 plugin.json，已跳过");
			continue;
		}
		if (!PLUGIN_ID_RE.test(id)) {
			warnings.push(`插件「${id}」id 非法（只允许小写字母/数字/连字符），已跳过`);
			continue;
		}
		if (seen.has(id)) {
			warnings.push(`插件 id 重复「${id}」，保留先出现者`);
			continue;
		}
		let bad = false;
		for (const key of ["tools", "panels", "skills", "requires"] as const) {
			const v = (m as unknown as Record<string, unknown>)[key];
			if (!Array.isArray(v) || (v as unknown[]).some((x) => typeof x !== "string")) {
				warnings.push(nonStringArray(id, key));
				bad = true;
				break;
			}
		}
		if (bad) continue;
		seen.add(id);
		// 结构健全后丢弃 manifests 之外的多余字段；requires 去重保序
		out.push({
			id,
			name: typeof m.name === "string" ? m.name : id,
			version: typeof m.version === "string" ? m.version : "0.0.0",
			description: typeof m.description === "string" ? m.description : "",
			tools: [...m.tools],
			panels: [...m.panels],
			skills: [...m.skills],
			requires: [...new Set(m.requires)],
		});
	}
	// requires 引用存在性：只警告、视为满足（无动态解析，契约一期范围）
	for (const m of out) {
		for (const dep of m.requires) {
			if (!seen.has(dep)) {
				warnings.push(`插件「${m.id}」requires 引用「${dep}」不存在，按满足处理`);
			}
		}
	}
	return { manifests: out, warnings };
}

/**
 * 拓扑排序：按 requires 依赖做 DFS 后序（被依赖者先出）。
 * 环检测：存在环则抛 Error（中文消息列出环路径）。
 */
export function topoSort(manifests: PluginManifest[]): PluginManifest[] {
	const byId = new Map(manifests.map((m) => [m.id, m]));
	const order: PluginManifest[] = [];
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];

	const visit = (id: string): void => {
		const st = state.get(id);
		if (st === "done") return;
		if (st === "visiting") {
			const idx = stack.indexOf(id);
			const cycle = [...stack.slice(idx), id].join(" → ");
			throw new Error(`插件依赖存在环：${cycle}`);
		}
		state.set(id, "visiting");
		stack.push(id);
		const m = byId.get(id)!;
		for (const dep of m.requires) {
			if (byId.has(dep)) visit(dep);
		}
		stack.pop();
		state.set(id, "done");
		order.push(m);
	};

	for (const m of manifests) visit(m.id);
	return order;
}

/** 插件配置段形状（与 RpConfig.plugins 一致；独立声明避免引 server 层类型） */
export interface PluginConfigSegment {
	enabled?: boolean;
	settings?: Record<string, unknown>;
}

/**
 * 按 config.plugins.<id>.enabled 过滤（缺省视为 disabled——插件默认关闭）。
 * 返回 (cwd, config) → 启用的 manifest 列表（拓扑序）。
 */
export function enabledManifests(
	cwd: string,
	config: { plugins?: Record<string, PluginConfigSegment> },
): PluginManifest[] {
	const pluginsDir = join(cwd, "src", "draw-plugins");
	const scanned = scanPluginManifests(pluginsDir);
	const { manifests } = validateManifests(scanned);
	const sorted = topoSort(manifests);
	return sorted.filter((m) => config.plugins?.[m.id]?.enabled === true);
}

/** 数据目录 .liyuan-plugins/<id>/（mkdir -p 后返回） */
export function pluginDataDir(cwd: string, pluginId: string): string {
	const dir = join(cwd, PLUGIN_DATA_DIR, pluginId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * 异步加载并初始化插件（幂等：已初始化则直接返回缓存）。
 * 流程：扫描 → 校验 → 拓扑 → 按 config 过滤 → 逐个动态 import → 校验模块导出
 * → skills 复制 → 按拓扑序 init（init 抛错：该插件记 warning、tools 不注册，其余继续）
 * → 填充模块级缓存。
 */
export async function initPlugins(
	cwd: string,
	config: { plugins?: Record<string, PluginConfigSegment> },
): Promise<PluginRuntime> {
	if (runtimeCache) return runtimeCache;

	const warnings: string[] = [];
	const pluginsDir = join(cwd, "src", "draw-plugins");

	const scanned = scanPluginManifests(pluginsDir);
	const { manifests, warnings: vw } = validateManifests(scanned);
	warnings.push(...vw);

	let sorted: PluginManifest[];
	try {
		sorted = topoSort(manifests);
	} catch (err) {
		throw err; // 环检测：交给调用方（main.ts 捕获记 warning）
	}

	const enabled = sorted.filter((m) => config.plugins?.[m.id]?.enabled === true);

	const plugins: DrawPlugin[] = [];
	const toolDefs: PluginToolDef[] = [];
	const toolNames: string[] = [];

	for (const manifest of enabled) {
		// 动态 import：模块路径由 cwd 派生（支持临时目录测试场景）
		const moduleUrl = pathToFileURL(join(pluginsDir, manifest.id, "index.ts")).href;
		let mod: Partial<DrawPlugin>;
		try {
			mod = (await import(moduleUrl)) as Partial<DrawPlugin>;
		} catch (err) {
			// 加载失败：记 warning 跳过该插件（不让一个坏插件拖垮全部）
			warnings.push(`插件「${manifest.id}」加载失败：${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (!mod.manifest) {
			throw new Error(`插件「${manifest.id}」index.ts 未导出 manifest`);
		}
		if (mod.manifest.id !== manifest.id) {
			throw new Error(
				`插件「${manifest.id}」index.ts 的 manifest.id（${mod.manifest.id}）与 plugin.json 不一致`,
			);
		}

		// skills 复制：发布侧缺失时复制进 .liyuan-skills/（复制失败记 warning 不抛）
		for (const skill of manifest.skills ?? []) {
			const dest = join(cwd, ".liyuan-skills", skill);
			if (existsSync(dest)) continue;
			const src = join(pluginsDir, manifest.id, "skills", skill);
			try {
				mkdirSync(dirname(dest), { recursive: true });
				copyFileSync(src, dest);
			} catch (err) {
				warnings.push(
					`插件「${manifest.id}」skill「${skill}」复制失败：${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// init（抛错 → 该插件标记失败：记 warning，tools 不注册，其余继续）
		let initOk = true;
		if (mod.init) {
			try {
				await mod.init({
					cwd,
					dataDir: pluginDataDir(cwd, manifest.id),
					settings: config.plugins?.[manifest.id]?.settings ?? {},
					log: (msg) => console.log(`[draw-plugin:${manifest.id}] ${msg}`),
				});
			} catch (err) {
				initOk = false;
				warnings.push(
					`插件「${manifest.id}」init 失败（其 tools 未注册）：${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		if (!initOk) continue;

		plugins.push(mod as DrawPlugin);
		for (const def of mod.tools ?? []) {
			toolDefs.push(def);
			toolNames.push(def.name);
		}
		// 回合结束钩子（onTurnEnd）：收集启用插件的钩子供 host 调用
		if (mod.hooks?.onTurnEnd) {
			turnEndHookList.push(mod.hooks.onTurnEnd);
		}
	}

	runtimeCache = { plugins, toolDefs, toolNames, warnings };
	return runtimeCache;
}

/** 同步读缓存（未初始化时返回空） */
export function enabledPluginToolDefs(): PluginToolDef[] {
	return runtimeCache?.toolDefs ?? [];
}

/** 同步读缓存（未初始化时返回空） */
export function enabledPluginToolNames(): string[] {
	return runtimeCache?.toolNames ?? [];
}

/** 同步读缓存（未初始化时返回 null） */
export function pluginRuntime(): PluginRuntime | null {
	return runtimeCache;
}

/** 回合结束钩子总线（启用插件的 onTurnEnd 列表；host 在 onTurnEnd 回调里调用） */
export function turnEndHooks(): Array<(info: TurnEndHookInfo) => Promise<void> | void> {
	return [...turnEndHookList];
}

/** 清缓存（仅供测试；生产路径不调用） */
export function resetPluginsForTest(): void {
	runtimeCache = null;
	turnEndHookList.length = 0;
}
