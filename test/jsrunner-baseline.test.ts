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

test("ledger: manager 全屏载荷 opts + 关闭通道（C 路径延伸）", () => {
	const opened: Array<[string, boolean | undefined]> = [];
	const closed: string[] = [];
	const offOpen = ledger.onManagerRequest((id, opts) => opened.push([id, opts?.fullscreen]));
	const offClose = ledger.onManagerClose((id) => closed.push(id));
	ledger.requestManager("s8", { fullscreen: true });
	ledger.requestManager("s9"); // 不传 opts：行为不变
	ledger.requestManagerClose("s8");
	ledger.requestManagerClose("s9");
	assert.deepEqual(opened, [
		["s8", true],
		["s9", undefined],
	], "opts 载荷透传；不传 opts 时 undefined");
	assert.deepEqual(closed, ["s8", "s9"]);
	offOpen();
	offClose();
	ledger.requestManagerClose("s10");
	assert.deepEqual(closed, ["s8", "s9"], "退订后不再收到关闭请求");
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

test("ledger: V2-2 move 排序（同区域相对重排，未收录按注册序追加）", () => {
	ledger.upsert("o1", { title: "A", area: "status" });
	ledger.upsert("o2", { title: "B", area: "status" });
	ledger.upsert("o3", { title: "C", area: "status" });
	// 初始无 order → 注册序
	assert.deepEqual(ledger.getPanels().map((p) => p.scriptId), ["o1", "o2", "o3"]);
	// o3 移到同区域首位
	ledger.move("o3", 0);
	assert.deepEqual(ledger.getPanels().map((p) => p.scriptId), ["o3", "o1", "o2"]);
	// o1 移到同区域末位
	ledger.move("o1", 2);
	assert.deepEqual(ledger.getPanels().map((p) => p.scriptId), ["o3", "o2", "o1"]);
	// 跨区域：roster 面板保持独立；status 内部重排不影响其相对位置
	ledger.upsert("r1", { title: "R", area: "roster" });
	assert.deepEqual(ledger.getPanels().map((p) => p.scriptId), ["o3", "o2", "o1", "r1"]);
	// o3 拖到 status 区域队尾（越界按队尾钳制）——跨区域全局交错不影响各区域渲染
	ledger.move("o3", 3);
	const areaIds = (area: "status" | "roster") =>
		ledger.getPanels().filter((p) => (p.entry.spec.area ?? "status") === area).map((p) => p.scriptId);
	assert.deepEqual(areaIds("status"), ["o2", "o1", "o3"], "status 区域相对顺序正确");
	assert.deepEqual(areaIds("roster"), ["r1"], "roster 区域不受影响");
	// 清理
	for (const id of ["o1", "o2", "o3", "r1"]) ledger.remove(id);
	ledger.setOrder([]);
});

test("ledger: V2-2 setOrder/getOrder 持久化回灌（过滤未知/重复，同值不通知）", () => {
	ledger.upsert("p1", spec);
	ledger.upsert("p2", spec);
	ledger.setOrder(["p2", "p1"]);
	assert.deepEqual(ledger.getPanels().map((p) => p.scriptId), ["p2", "p1"]);
	// 未知/重复 id 过滤
	ledger.setOrder(["p2", "ghost", "p2", "p1"]);
	assert.deepEqual(ledger.getPanels().map((p) => p.scriptId), ["p2", "p1"]);
	assert.deepEqual([...ledger.getOrder()], ["p2", "p1"]);
	let n = 0;
	const off = ledger.subscribe(() => n++);
	ledger.setOrder(["p2", "p1"]); // 同值不通知
	assert.equal(n, 0, "同值 setOrder 不通知");
	off();
	// 清理
	ledger.remove("p1");
	ledger.remove("p2");
	ledger.setOrder([]);
});

test("ledger: V2-5 activeTab / getTabIds（position=tab 进 status tab 条）", () => {
	assert.equal(ledger.getActiveTab(), "standard", "默认标准视图");
	ledger.upsert("t1", { title: "脚本A", position: "tab", area: "status" });
	ledger.upsert("t2", { title: "脚本B", position: "tab", area: "status" });
	ledger.upsert("a1", { title: "普通", area: "status" });
	assert.deepEqual([...ledger.getTabIds()], ["t1", "t2"]);
	ledger.setActiveTab("t2");
	assert.equal(ledger.getActiveTab(), "t2");
	ledger.setActiveTab("ghost"); // 非法 id 忽略
	assert.equal(ledger.getActiveTab(), "t2");
	ledger.setActiveTab("a1"); // 非 tab 面板忽略
	assert.equal(ledger.getActiveTab(), "t2");
	ledger.setActiveTab("standard");
	assert.equal(ledger.getActiveTab(), "standard");
	// tab 面板被移除 → 激活项回落标准视图
	ledger.setActiveTab("t1");
	ledger.remove("t1");
	assert.equal(ledger.getActiveTab(), "standard", "tab 面板移除后回落标准视图");
	assert.deepEqual([...ledger.getTabIds()], ["t2"]);
	// 清理
	ledger.remove("t2");
	ledger.remove("a1");
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
