/**
 * 能力包注册表单测（DESIGN-draw §3.0）：扫描 / 校验 / 拓扑 / 过滤 / 加载 / 初始化 / skills 复制。
 *
 * 运行：node --test test/draw-plugins.test.ts
 * 全部使用 mkdtempSync 临时目录，不污染仓库。registry 模块级缓存跨测试共享——
 * 涉及 initPlugins 的用例开头先 resetPluginsForTest()。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	enabledManifests,
	enabledPluginToolDefs,
	enabledPluginToolNames,
	initPlugins,
	pluginRuntime,
	resetPluginsForTest,
	scanPluginManifests,
	topoSort,
	validateManifests,
} from "../src/draw-plugins/registry.ts";
import type { PluginManifest } from "../src/draw-plugins/types.ts";

// ---------- 工具 ----------

/** 造最小 manifest（测试拓扑/校验用） */
const mkManifest = (id: string, requires: string[] = []): PluginManifest => ({
	id,
	name: id,
	version: "0.1.0",
	description: `测试插件 ${id}`,
	tools: [],
	panels: [],
	skills: [],
	requires,
});

/** 在临时目录造一个可加载的假插件（plugin.json + index.ts + 可选 skills），返回其 cwd */
function makeFakePlugin(
	id: string,
	opts: { skills?: string[]; manifestOverride?: Partial<PluginManifest>; initThrows?: boolean } = {},
): string {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-plugin-"));
	const dir = join(cwd, "src", "draw-plugins", id);
	mkdirSync(dir, { recursive: true });
	const manifest: PluginManifest = {
		id,
		name: id,
		version: "0.1.0",
		description: `测试插件 ${id}`,
		tools: ["fake_tool"],
		panels: [],
		skills: opts.skills ?? [],
		requires: [],
		...opts.manifestOverride,
	};
	writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, "\t"), "utf8");
	const initBody = opts.initThrows ? `export const init = () => { throw new Error("init boom"); };` : `export const init = (ctx) => { globalThis.__pluginCtx__ = ctx; };`;
	const toolsJson = JSON.stringify([
		{
			name: "fake_tool",
			label: "假工具",
			description: "测试工具",
			parameters: { type: "object", properties: {} },
			execute: () => ({ content: [{ type: "text", text: "fake ok" }] }),
		},
	]);
	writeFileSync(
		join(dir, "index.ts"),
		`export const manifest = ${JSON.stringify(manifest)};\n` +
			`export const tools = ${toolsJson};\n` +
			initBody +
			`\n`,
		"utf8",
	);
	if (opts.skills) {
		mkdirSync(join(dir, "skills"), { recursive: true });
		for (const s of opts.skills) {
			writeFileSync(join(dir, "skills", s), `# ${s}\n`, "utf8");
		}
	}
	return cwd;
}

/** 插件目录 = <cwd>/src/draw-plugins（与 registry 内部约定一致） */
const pluginsDirOf = (cwd: string): string => join(cwd, "src", "draw-plugins");

// ---------- 1. 扫描 ----------

test("scanPluginManifests：读到 draw-role/plugin.json", () => {
	const dir = resolve(process.cwd(), "src", "draw-plugins");
	const manifests = scanPluginManifests(dir);
	const role = manifests.find((m) => m.id === "draw-role");
	assert.ok(role, "应扫到 draw-role");
	assert.equal(role!.name, "角色管理");
	assert.deepEqual(role!.tools, ["wardrobe_list", "wardrobe_update", "tag_search"]);
	assert.deepEqual(role!.panels, ["DrawRolePanel"]);
	assert.deepEqual(role!.skills, []);
	assert.deepEqual(role!.requires, []);
});

test("scanPluginManifests：目录不存在返回空数组", () => {
	assert.deepEqual(scanPluginManifests(join(tmpdir(), "no-such-dir")), []);
});

// ---------- 2. 校验 ----------

test("validateManifests：非法 id / requires 引用不存在 / tools 非字符串数组 的警告行为", () => {
	const { manifests, warnings } = validateManifests([
		mkManifest("bad id!"), // 非法 id
		mkManifest("ok", ["missing"]), // requires 引用不存在
		{ ...mkManifest("bad-tools"), tools: [123 as unknown as string] }, // tools 非字符串数组
		mkManifest("good"),
	]);
	const ids = manifests.map((m) => m.id);
	assert.ok(!ids.includes("bad id!"), "非法 id 应被剔除");
	assert.ok(ids.includes("ok"), "requires 引用不存在只警告不剔除");
	assert.ok(!ids.includes("bad-tools"), "tools 非字符串数组应被剔除");
	assert.ok(ids.includes("good"));
	assert.ok(warnings.some((w) => w.includes("bad id!")));
	assert.ok(warnings.some((w) => w.includes("missing")));
	assert.ok(warnings.some((w) => w.includes("bad-tools")));
});

test("validateManifests：重复 id 保留先出现者；重复 requires 去重", () => {
	const a = { ...mkManifest("dup"), requires: ["x", "x", "y"] };
	const b = mkManifest("dup");
	const { manifests, warnings } = validateManifests([a, b]);
	assert.equal(manifests.length, 1);
	assert.equal(manifests[0].id, "dup");
	assert.deepEqual(manifests[0].requires, ["x", "y"]);
	assert.ok(warnings.some((w) => w.includes("重复")));
});

// ---------- 3. 拓扑 ----------

test("topoSort：线性依赖顺序正确（被依赖者在前）", () => {
	const a = mkManifest("a");
	const b = mkManifest("b", ["a"]);
	const c = mkManifest("c", ["b"]);
	const sorted = topoSort([c, a, b]);
	assert.deepEqual(sorted.map((m) => m.id), ["a", "b", "c"]);
});

test("topoSort：环检测抛错（中文消息含环路径）", () => {
	const a = mkManifest("a", ["b"]);
	const b = mkManifest("b", ["a"]);
	assert.throws(() => topoSort([a, b]), (e: unknown) => {
		const msg = e instanceof Error ? e.message : String(e);
		return msg.includes("环") && msg.includes("a") && msg.includes("b");
	});
});

// ---------- 4. enabled 过滤 ----------

test("enabledManifests：config 缺省全关（空数组）", () => {
	const cwd = makeFakePlugin("p1");
	try {
		assert.deepEqual(enabledManifests(cwd, {}), []);
		assert.deepEqual(enabledManifests(cwd, { plugins: { p1: {} } }), []);
	} finally {
		// 临时目录无需清理（系统 tmp）；registry 未初始化，无缓存污染
	}
});

test("enabledManifests：enabled:true 才出现；顺序为拓扑序", () => {
	const cwd = makeFakePlugin("p1");
	try {
		const enabled = enabledManifests(cwd, { plugins: { p1: { enabled: true } } });
		assert.deepEqual(enabled.map((m) => m.id), ["p1"]);
	} finally {
		/* ignore */
	}
});

// ---------- 5. initPlugins 端到端 ----------

test("initPlugins：默认全关 → 空工具面；模块级缓存未初始化", async () => {
	resetPluginsForTest();
	const cwd = makeFakePlugin("p1");
	try {
		const rt = await initPlugins(cwd, {});
		assert.equal(rt.toolDefs.length, 0);
		assert.equal(rt.toolNames.length, 0);
		assert.deepEqual(enabledPluginToolNames(), []);
	} finally {
		resetPluginsForTest();
	}
});

test("initPlugins：启用后返回其工具；幂等（二次调用直接返回缓存）", async () => {
	resetPluginsForTest();
	const cwd = makeFakePlugin("p1");
	try {
		const rt = await initPlugins(cwd, { plugins: { p1: { enabled: true, settings: { a: 1 } } } });
		assert.equal(rt.toolNames.length, 1);
		assert.equal(rt.toolNames[0], "fake_tool");
		assert.deepEqual(enabledPluginToolNames(), ["fake_tool"]);
		assert.equal(enabledPluginToolDefs().length, 1);
		assert.ok(pluginRuntime() !== null);
		// 幂等：二次调用同一实例
		const rt2 = await initPlugins(cwd, { plugins: { p1: { enabled: true } } });
		assert.equal(rt, rt2);
	} finally {
		resetPluginsForTest();
	}
});

test("initPlugins：skills 缺失时复制进 .liyuan-skills/；已有则跳过", async () => {
	resetPluginsForTest();
	const cwd = makeFakePlugin("p1", { skills: ["demo.md"] });
	try {
		await initPlugins(cwd, { plugins: { p1: { enabled: true } } });
		const dest = join(cwd, ".liyuan-skills", "demo.md");
		assert.ok(existsSync(dest), "应复制 skills/demo.md 到 .liyuan-skills/");
	} finally {
		resetPluginsForTest();
	}
});

test("initPlugins：init 抛错 → 记 warning、tools 不注册、其余插件继续", async () => {
	resetPluginsForTest();
	const cwd = makeFakePlugin("bad", { initThrows: true });
	// 同目录再造一个正常插件，验证「坏插件不阻断其余插件」
	const goodId = "good";
	const goodDir = join(cwd, "src", "draw-plugins", goodId);
	mkdirSync(goodDir, { recursive: true });
	const goodManifest = mkManifest(goodId);
	goodManifest.tools = ["good_tool"];
	writeFileSync(join(goodDir, "plugin.json"), JSON.stringify(goodManifest, null, "\t"), "utf8");
	writeFileSync(
		join(goodDir, "index.ts"),
		`export const manifest = ${JSON.stringify(goodManifest)};\n` +
			`export const tools = [{ name: "good_tool", label: "好工具", description: "t", parameters: { type: "object", properties: {} }, execute: () => ({ content: [{ type: "text", text: "ok" }] }) }];\n`,
		"utf8",
	);
	try {
		const rt = await initPlugins(cwd, { plugins: { bad: { enabled: true }, good: { enabled: true } } });
		assert.deepEqual(rt.toolNames, ["good_tool"], "坏插件 tools 不注册，好插件继续");
		assert.ok(rt.warnings.some((w) => w.includes("init 失败")));
	} finally {
		resetPluginsForTest();
	}
});

test("initPlugins：模块缺少 manifest 导出 → 抛错", async () => {
	resetPluginsForTest();
	const cwd = makeFakePlugin("p1");
	// 覆盖 index.ts 使其不导出 manifest
	writeFileSync(
		join(cwd, "src", "draw-plugins", "p1", "index.ts"),
		`export const tools = [];\n`,
		"utf8",
	);
	try {
		await assert.rejects(
			() => initPlugins(cwd, { plugins: { p1: { enabled: true } } }),
			(e: unknown) => (e instanceof Error ? e.message.includes("manifest") : false),
		);
	} finally {
		resetPluginsForTest();
	}
});

// ---------- 6. 真实 draw-role 加载（经临时配置启用） ----------

test("initPlugins：真实 draw-role 可加载（enabled 时工具面含 wardrobe_list/wardrobe_update）", async () => {
	resetPluginsForTest();
	// 用仓库根作 cwd：src/draw-plugins 就是真实插件目录
	const cwd = resolve(process.cwd());
	try {
		const rt = await initPlugins(cwd, { plugins: { "draw-role": { enabled: true } } });
		assert.ok(rt.toolNames.includes("wardrobe_list"));
		assert.ok(rt.toolNames.includes("wardrobe_update"));
	} finally {
		resetPluginsForTest();
	}
});
