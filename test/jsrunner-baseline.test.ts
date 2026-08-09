/**
 * JS Runner 账本定制——常驻基准测试（自动化，D4 §6.1）。
 *
 * 范围（A5 边界）：只测纯逻辑模块（node 无 DOM 环境）——
 * - ledger.ts 面板注册中心状态机（快照稳定性 / 订阅 / manager / toast 通道）
 * - plan.ts 增量同步计划（file 优先于 content）
 * - events.ts 帧 → 脚本事件投影（D4 §5.2 三事件）
 *
 * 不进 node 的部分（归演示脚本 + 人工冒烟）：DOM 挂载/收起/占位、iframe 行为、
 * applyStatePatch/notify 的 fetch mock（helper import 链含 `?raw`，node 无法加载）。
 *
 * 运行：npm test（node --test test/*.test.ts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ledger, notifyToast, setToastHandler } from "../web/src/jsrunner/ledger.ts";
import { planScriptSync } from "../web/src/jsrunner/plan.ts";
import { mapFrameToScriptEvents } from "../web/src/jsrunner/events.ts";
import type { ScriptMeta } from "../web/src/jsrunner/types.ts";
import type { ServerFrame } from "../web/src/wire.ts";

const spec = { title: "基准面板", area: "status" as const };

// ---------- ledger 状态机 ----------

test("ledger: upsert 注册 → getPanels 含条目；重复注册覆盖；remove 清空", () => {
	ledger.upsert("s1", spec);
	assert.equal(ledger.getPanels().length, 1);
	assert.equal(ledger.getPanels()[0].scriptId, "s1");
	assert.equal(ledger.getPanels()[0].entry.spec.title, "基准面板");

	ledger.upsert("s1", { title: "改名", area: "roster" });
	assert.equal(ledger.getPanels().length, 1, "重复注册不增条目");
	assert.equal(ledger.getPanels()[0].entry.spec.title, "改名");
	assert.equal(ledger.getPanels()[0].entry.spec.area, "roster");

	ledger.remove("s1");
	assert.equal(ledger.getPanels().length, 0);
	ledger.remove("s1"); // 幂等不炸
});

test("ledger: 快照稳定性（A2）——无变更时 getPanels 返回同一引用；变更后新引用", () => {
	const a = ledger.getPanels();
	const b = ledger.getPanels();
	assert.equal(a, b, "无变更必须同一引用（useSyncExternalStore 依赖）");
	ledger.upsert("s2", spec);
	const c = ledger.getPanels();
	assert.notEqual(a, c, "upsert 后新引用");
	assert.equal(c, ledger.getPanels(), "变更后缓存稳定");
	ledger.remove("s2");
});

test("ledger: subscribe 通知次数；remove/upsert 触发，值未变不通知", () => {
	let n = 0;
	const off = ledger.subscribe(() => n++);
	ledger.upsert("s3", spec);
	ledger.setHeight("s3", 100);
	assert.equal(n, 2, "upsert + setHeight 各通知一次");
	ledger.setHeight("s3", 100); // 同值不通知
	assert.equal(n, 2, "同值 setHeight 不通知（防 ResizeObserver 抖动）");
	ledger.setReady("s3", true);
	ledger.setModalized("s3", true);
	assert.equal(n, 4);
	ledger.toggleCollapsed("s3");
	assert.equal(n, 5);
	ledger.setReady("s3", true); // 同值不通知
	assert.equal(n, 5);
	ledger.remove("s3");
	off();
});

test("ledger: setHeight 归一化（非正数 → 0）", () => {
	ledger.upsert("s4", spec);
	ledger.setHeight("s4", -5);
	assert.equal(ledger.getPanels().find((p) => p.scriptId === "s4")?.entry.height, 0);
	ledger.setHeight("s4", 123.6);
	assert.equal(ledger.getPanels().find((p) => p.scriptId === "s4")?.entry.height, 124);
	ledger.remove("s4");
});

test("ledger: manager 请求通道（P4 openManager）", () => {
	const got: string[] = [];
	const off = ledger.onManagerRequest((id) => got.push(id));
	ledger.requestManager("s5");
	ledger.requestManager("s6");
	assert.deepEqual(got, ["s5", "s6"]);
	off();
	ledger.requestManager("s7");
	assert.deepEqual(got, ["s5", "s6"], "退订后不再收到");
});

test("ledger: toast 通道（setToastHandler / notifyToast）", () => {
	const got: Array<[string, string]> = [];
	setToastHandler((level, text) => got.push([level, text]));
	notifyToast("info", "hi");
	notifyToast("error", "bad");
	assert.deepEqual(got, [
		["info", "hi"],
		["error", "bad"],
	]);
	setToastHandler(null);
	notifyToast("warning", "静默");
	assert.equal(got.length, 2, "未注册 handler 静默丢弃");
});

// ---------- plan.ts 增量同步 ----------

const meta = (id: string, patch: Partial<ScriptMeta> = {}): ScriptMeta => ({
	id,
	name: id,
	file: undefined,
	content: undefined,
	enabled: true,
	...patch,
});

test("plan: file 优先于 content（P0 拆文件存储增量键）", () => {
	// 运行中 key=file；列表 file 未变 → toKeep
	const cur = [{ id: "a", key: "uploads-1.js" }];
	const list = [meta("a", { file: "uploads-1.js" })];
	const p = planScriptSync(cur, list);
	assert.deepEqual(p.toRemove, []);
	assert.deepEqual(p.toCreate, []);
	assert.deepEqual(p.toKeep.map((m) => m.id), ["a"]);

	// file 变化 → toCreate
	const p2 = planScriptSync(cur, [meta("a", { file: "uploads-2.js" })]);
	assert.deepEqual(p2.toCreate.map((m) => m.id), ["a"]);
	assert.deepEqual(p2.toKeep, []);
});

test("plan: content 兜底（旧数据迁移兼容）；停用移除；新增启用创建", () => {
	const p = planScriptSync(
		[{ id: "legacy", key: "旧内容字符串" }],
		[meta("legacy", { content: "旧内容字符串" })],
	);
	assert.deepEqual(p.toKeep.map((m) => m.id), ["legacy"], "content 与运行键一致 → 保留");

	const p2 = planScriptSync(
		[{ id: "legacy", key: "旧内容字符串" }],
		[meta("legacy", { content: "旧内容字符串", enabled: false })],
	);
	assert.deepEqual(p2.toRemove, ["legacy"], "停用 → 移除");

	const p3 = planScriptSync([], [meta("fresh")]);
	assert.deepEqual(p3.toCreate.map((m) => m.id), ["fresh"], "新增启用 → 创建");
});

// ---------- events.ts 事件投影（D4 §5.2） ----------

test("events: state 帧 → WORLD_STATE_CHANGED([state])", () => {
	const frame = { type: "state", state: { time: "黄昏" } } as unknown as ServerFrame;
	assert.deepEqual(mapFrameToScriptEvents(frame), [
		{ name: "WORLD_STATE_CHANGED", args: [{ time: "黄昏" }] },
	]);
});

test("events: message 非 user 通道 → MESSAGE_RECEIVED；user 通道不触发", () => {
	const asst = {
		type: "message",
		message: { channel: "narrative", text: "正文", role: "assistant" },
	} as unknown as ServerFrame;
	assert.deepEqual(mapFrameToScriptEvents(asst), [
		{ name: "MESSAGE_RECEIVED", args: [{ mes: "正文", is_user: false }] },
	]);

	const user = {
		type: "message",
		message: { channel: "user", text: "你好", role: "user" },
	} as unknown as ServerFrame;
	assert.deepEqual(mapFrameToScriptEvents(user), [], "user 消息不产生事件");
});

test("events: agent end → GENERATION_ENDED；start 不触发", () => {
	const end = { type: "agent", state: "end" } as unknown as ServerFrame;
	assert.deepEqual(mapFrameToScriptEvents(end), [{ name: "GENERATION_ENDED", args: [] }]);

	const start = { type: "agent", state: "start" } as unknown as ServerFrame;
	assert.deepEqual(mapFrameToScriptEvents(start), []);
});

test("events: 其它帧（hello/delta/panels 等）→ 空数组", () => {
	for (const t of ["hello", "delta", "panels", "stats", "activity"]) {
		const frame = { type: t } as unknown as ServerFrame;
		assert.deepEqual(mapFrameToScriptEvents(frame), [], `${t} 不产生事件`);
	}
});
