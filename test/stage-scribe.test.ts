import assert from "node:assert/strict";
import { test } from "node:test";

import { runScribeTurn, type ScribeRunDeps } from "../src/stage/scribe-run.ts";
import { buildTableTodo } from "../src/table-todo.ts";
import { defaultState } from "../src/state.ts";
import type { WorldState } from "../src/types.ts";

const baseInput = {
	state: defaultState(),
	userText: "我把怀表递给她。",
	assistantText: "云澜接过怀表，指尖顿了顿。",
	charName: "云澜",
	userName: "沈舟",
};

/**
 * 记录旁路提示词与过程条的假依赖。
 * 8/13 域分工后 runScribeTurn 不再自行落树/落盘——落账（appendStateEntry/saveState）
 * 由调用方统一做，返回 applied 的 state 即最终账本；本测试直接断言 r.state。
 */
const makeDeps = (
	respond: string | { error: string },
	over: Partial<ScribeRunDeps> = {},
): ScribeRunDeps & { activities: string[]; prompts: string[]; systemPrompts: string[] } => {
	const activities: string[] = [];
	const prompts: string[] = [];
	const systemPrompts: string[] = [];
	return {
		activities,
		prompts,
		systemPrompts,
		sideText: async (sp, ut) => {
			systemPrompts.push(sp);
			prompts.push(ut);
			return respond;
		},
		getLeafId: () => "leaf-1",
		onActivity: (d) => activities.push(d),
		...over,
	};
};

/** 单表 auto 账本（tables-only 用例基底） */
const autoState = (): WorldState => ({
	...defaultState(),
	characters: { 云澜: { affinity: 5, status: "在场", notes: "" } },
	tables: {
		在场角色表: { name: "在场角色表", auto: true, columns: [{ name: "姓名" }], rows: [{ 姓名: "云澜" }] },
	},
});

test("场记：patch 应用 + 返回最终账本 + 过程条", async () => {
	const deps = makeDeps(
		JSON.stringify({
			patch: {
				time: "戌时",
				location: "溪桥",
				characters: { 云澜: { affinity: 6, status: "手持怀表" } },
				inventory: ["黄铜怀表（云澜持有）"],
			},
		}),
	);
	const r = await runScribeTurn(deps, baseInput);

	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	assert.equal(r.state.time, "戌时");
	assert.equal(r.state.location, "溪桥");
	assert.equal(r.state.characters["云澜"]?.affinity, 6);
	assert.deepEqual(r.state.inventory, ["黄铜怀表（云澜持有）"]);
	assert.ok(deps.activities.some((a) => a.startsWith("记账")), "有记账过程条");
	// 场记看到的是账本 + 本拍对白
	assert.ok(deps.prompts[0].includes("云澜接过怀表"));
});

test("场记：叶守卫——调用期间分支变了则整体丢弃（R9）", async () => {
	let leaf = "leaf-1";
	const deps = makeDeps(JSON.stringify({ patch: { time: "亥时" } }), {
		sideText: async () => {
			leaf = "leaf-2"; // 模拟调用期间用户 swipe
			return JSON.stringify({ patch: { time: "亥时" } });
		},
		getLeafId: () => leaf,
	});
	const r = await runScribeTurn(deps, baseInput);

	assert.equal(r.kind, "stale");
	assert.ok(deps.activities.some((a) => a.includes("切换了分支")));
});

test("场记：空 patch / 不可解析 / 调用失败都不产生 applied", async () => {
	const empty = makeDeps(JSON.stringify({ patch: {} }));
	assert.deepEqual(await runScribeTurn(empty, baseInput), { kind: "skipped", reason: "empty-patch" });

	const garbage = makeDeps("模型今天想聊天，不想输出 JSON。");
	const gr = await runScribeTurn(garbage, baseInput);
	assert.equal(gr.kind, "failed");
	assert.ok(gr.kind === "failed" && gr.error.includes("不可解析"), "失败信息带原文，便于诊断格式跑偏");

	const failed = makeDeps({ error: "429 rate limited" });
	assert.deepEqual(await runScribeTurn(failed, baseInput), { kind: "failed", error: "429 rate limited" });

	const noText = makeDeps(JSON.stringify({ patch: { time: "子时" } }));
	assert.deepEqual(await runScribeTurn(noText, { ...baseInput, assistantText: "  " }), {
		kind: "skipped",
		reason: "no-text",
	});
});

test("场记：角色名归一（大小写/空白变体不开新条目）", async () => {
	const state: WorldState = { ...defaultState(), characters: { 云澜: { affinity: 3, status: "", notes: "" } } };
	const deps = makeDeps(JSON.stringify({ patch: { characters: { " 云澜 ": { affinity: 8 } } } }));
	const r = await runScribeTurn(deps, { ...baseInput, state });

	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	assert.deepEqual(Object.keys(r.state.characters), ["云澜"], "不得记成两份");
	assert.equal(r.state.characters["云澜"]?.affinity, 8);
});

test("场记：快照带登场名录（applyPatch 咽喉点自动登记）", async () => {
	const deps = makeDeps(
		JSON.stringify({ patch: { characters: { 老松道人: { affinity: 0, status: "山门守卫" } }, plot_threads: ["寻回师门信物"] } }),
	);
	const r = await runScribeTurn(deps, baseInput);
	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	const roster = r.state.roster;
	assert.ok(roster?.characters["老松道人"] !== undefined, "人物进名录");
	assert.ok(roster?.events["寻回师门信物"] !== undefined, "剧情线进名录");
});

test("场记：tables-only 无 auto 表 → skipped（省一次旁路调用）", async () => {
	const deps = makeDeps(JSON.stringify({ patch: {} }));
	const r = await runScribeTurn(deps, { ...baseInput, scope: "tables-only" });
	assert.deepEqual(r, { kind: "skipped", reason: "no-auto-tables" });
	assert.equal(deps.prompts.length, 0, "未发起调用");
});

test("场记：tables-only 逐表派发——补丁应用在 baseState（主演 patch 投影）上", async () => {
	const base = autoState();
	// 单表 ops 格式（提取器输出）：{ insert/update/delete }，不再是场记全量 patch 格式
	const deps = makeDeps(JSON.stringify({ insert: [{ 姓名: "沈舟" }] }));
	const r = await runScribeTurn(deps, { ...baseInput, state: defaultState(), baseState: base, scope: "tables-only" });

	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	assert.deepEqual(
		r.state.tables["在场角色表"].rows,
		[{ 姓名: "云澜" }, { 姓名: "沈舟" }],
		"行叠加在主演投影后的账本上",
	);
	assert.ok(deps.prompts[0].includes("【本轮对话】"), "数据源标签为本轮对话");
});

test("场记：tables-only 逐表派发——每表注入该表状态而非全量账本", async () => {
	const base = autoState();
	const deps = makeDeps(JSON.stringify({ insert: [] }));
	await runScribeTurn(deps, { ...baseInput, state: base, baseState: base, scope: "tables-only" });

	const user = deps.prompts[0];
	assert.ok(user.includes("【当前表状态】"), "注入该表状态（含现有行，供 match 唯一键）");
	assert.ok(user.includes("【表说明（description，优先级最高）】"), "表说明（头提示词）进提示词");
	assert.ok(user.includes("【本轮对话】"), "数据源为本轮对话");
	assert.ok(deps.systemPrompts[0].includes("表格数据提取器"), "提取器头提示词");
});

test("场记：tables-only TODO 空 → skipped（正文未提任何表且无时间链）", async () => {
	const base = autoState();
	const deps = makeDeps(JSON.stringify({ insert: [] }));
	const r = await runScribeTurn(deps, {
		...baseInput,
		userText: "雨下大了。",
		assistantText: "窗外的雨声渐渐密集起来，落在屋檐上噼啪作响。",
		state: base,
		baseState: base,
		scope: "tables-only",
	});

	assert.deepEqual(r, { kind: "skipped", reason: "no-related-tables" });
	assert.equal(deps.prompts.length, 0, "未发起调用");
});

test("场记：逐表派发——单表调用失败/输出垃圾不影响其他表", async () => {
	const base = autoState();
	base.tables["恋爱对象表"] = {
		name: "恋爱对象表",
		auto: true,
		columns: [{ name: "姓名" }],
		rows: [{ 姓名: "加藤惠" }],
	};
	const responses = [
		{ error: "429 rate limited" }, // 在场角色表：调用失败 → 跳过
		JSON.stringify({ insert: [{ 姓名: "路人甲" }] }), // 恋爱对象表：正常应用
	];
	const deps = makeDeps("", {
		maxTableRetries: 0, // 关闭退避重试，直接测「失败跳过」
		sideText: async () => responses.shift() ?? { error: "unexpected" },
	});
	const r = await runScribeTurn(deps, {
		...baseInput,
		userText: "我把怀表递给她，加藤惠在旁边看着。",
		assistantText: "云澜接过怀表，指尖顿了顿，朝加藤惠点了点头。",
		state: base,
		baseState: base,
		scope: "tables-only",
	});

	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	assert.deepEqual(r.state.tables["恋爱对象表"].rows, [{ 姓名: "加藤惠" }, { 姓名: "路人甲" }], "失败表跳过、成功表照常");
	assert.deepEqual(r.state.tables["在场角色表"].rows, [{ 姓名: "云澜" }], "失败表未被改动");
});

test("场记：full 顶层兜底 + 表格域逐表合并；顶层 patch 里的 tables 剥掉不双重写", async () => {
	const base = autoState();
	base.time = "午时";
	let call = 0;
	const deps = makeDeps("", {
		sideText: async () => {
			call++;
			if (call === 1) {
				// 顶层兜底：full patch 格式，即便带了 tables 也会被剥掉
				return JSON.stringify({
					patch: { time: "未时", location: "溪桥", tables: { 在场角色表: { insert: [{ 姓名: "幽灵行" }] } } },
				});
			}
			// 表格域：单表 ops 格式
			return JSON.stringify({ insert: [{ 姓名: "沈舟" }] });
		},
	});
	const r = await runScribeTurn(deps, { ...baseInput, state: base, baseState: base });

	assert.equal(r.kind, "applied");
	if (r.kind !== "applied") return;
	assert.equal(r.state.time, "未时", "顶层应用");
	assert.equal(r.state.location, "溪桥");
	assert.equal(call, 2, "顶层一次 + 表格域一次");
	// 顶层 patch 的 tables 被剥掉（幽灵行不出现），表格只经逐表通道写入
	assert.deepEqual(r.state.tables["在场角色表"].rows, [{ 姓名: "云澜" }, { 姓名: "沈舟" }]);
});

test("场记 TODO：正文提及行实体 → 命中；未提及 → 不命中", async () => {
	const tables = {
		在场角色表: { name: "在场角色表", auto: true, columns: [{ name: "姓名" }], rows: [{ 姓名: "云澜" }] },
		商店商品表: { name: "商店商品表", auto: true, columns: [{ name: "商品名" }], rows: [] },
	};
	assert.deepEqual(buildTableTodo("云澜接过了怀表。", tables), ["在场角色表"], "行实体命中");
	assert.deepEqual(buildTableTodo("天气很好。", tables), [], "无关正文不命中");
});

test("场记 TODO：时间/地点/纪要链表强制入列（列名特征，正文不点名也维护）", async () => {
	const tables = {
		全局数据表: {
			name: "全局数据表",
			auto: true,
			columns: [{ name: "当前时间" }, { name: "当前详细地点" }],
			rows: [],
		},
		恋爱对象表: { name: "恋爱对象表", auto: true, columns: [{ name: "姓名" }], rows: [{ 姓名: "加藤惠" }] },
	};
	// 正文完全无关：全局数据表（列含「时间/地点」）强制入列；恋爱对象表（行实体未提及）不入列
	assert.deepEqual(buildTableTodo("窗外下起了雨。", tables), ["全局数据表"]);
});

test("场记：full 顶层失败不短路表格域——表格照常逐表记账", async () => {
	const base = autoState();
	let call = 0;
	const deps = makeDeps("", {
		sideText: async () => {
			call++;
			if (call === 1) return { error: "最终消息无文本" }; // 顶层兜底空输出
			return JSON.stringify({ insert: [{ 姓名: "沈舟" }] }); // 表格域照常
		},
	});
	const r = await runScribeTurn(deps, { ...baseInput, state: base, baseState: base });

	assert.equal(r.kind, "applied", "顶层失败不阻断表格记账");
	if (r.kind !== "applied") return;
	assert.deepEqual(r.state.tables["在场角色表"].rows, [{ 姓名: "云澜" }, { 姓名: "沈舟" }], "表格已更新");
	assert.equal(call, 2, "顶层一次 + 表格域一次");
});

test("场记：full 顶层输入裁剪——【当前账本】不含 tables（表格由逐表通道维护）", async () => {
	const base = autoState();
	base.tables["恋爱对象表"] = { name: "恋爱对象表", auto: true, columns: [{ name: "姓名" }], rows: [] };
	const deps = makeDeps(JSON.stringify({ patch: { time: "未时" } }), { maxTableRetries: 0 });
	await runScribeTurn(deps, { ...baseInput, state: base, baseState: base });

	const user = deps.prompts[0];
	const ledgerBlock = user.slice(user.indexOf("【当前账本】"), user.indexOf("【本轮对话】"));
	const parsed = JSON.parse(ledgerBlock.slice(ledgerBlock.indexOf("{"))) as { tables?: unknown };
	assert.equal(parsed.tables, undefined, "顶层兜底注入不含表格全量（19 表 JSON 是空输出主因）");
});

test("场记：逐表单表失败按退避重试，重试成功照样应用", async () => {
	const base = autoState();
	const responses = [{ error: "空输出" }, JSON.stringify({ insert: [{ 姓名: "沈舟" }] })];
	const deps = makeDeps("", {
		retryTableDelayMs: 1, // 测试里退避压缩到 1ms
		sideText: async () => responses.shift() ?? { error: "unexpected" },
	});
	const r = await runScribeTurn(deps, { ...baseInput, state: base, baseState: base, scope: "tables-only" });

	assert.equal(r.kind, "applied", "重试成功");
	if (r.kind !== "applied") return;
	assert.deepEqual(r.state.tables["在场角色表"].rows, [{ 姓名: "云澜" }, { 姓名: "沈舟" }]);
});
