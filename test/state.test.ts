import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyPatch, applyTableOperation, canonicalizeCharacterKeys, defaultState, formatState, formatTableIndex, loadState, saveState } from "../src/state.ts";

test("补丁：时间地点替换、角色合并、好感钳制", () => {
	let s = defaultState();
	let r = applyPatch(s, { time: "黄昏", location: "林间小屋", characters: { Alice: { affinity: 150, status: "警惕" } } });
	assert.equal(r.warnings.length, 0);
	s = r.state;
	assert.equal(s.time, "黄昏");
	assert.equal(s.characters["Alice"].affinity, 100, "好感应钳制到 100");

	r = applyPatch(s, { characters: { Alice: { status: "放松" } } });
	s = r.state;
	assert.equal(s.characters["Alice"].affinity, 100, "部分更新应保留旧字段");
	assert.equal(s.characters["Alice"].status, "放松");
});

test("补丁：null 删除角色与 flag", () => {
	let s = defaultState();
	s = applyPatch(s, { characters: { Bob: { affinity: 5 } }, flags: { 天气: "暴雨" } }).state;
	s = applyPatch(s, { characters: { Bob: null }, flags: { 天气: null } }).state;
	assert.equal(Object.keys(s.characters).length, 0);
	assert.equal(Object.keys(s.flags).length, 0);
});

test("补丁：数组整体替换、未知键告警", () => {
	let s = defaultState();
	s = applyPatch(s, { inventory: ["猎刀", "草药"] }).state;
	const r = applyPatch(s, { inventory: ["草药"], hp: 100 });
	assert.deepEqual(r.state.inventory, ["草药"]);
	assert.equal(r.warnings.length, 1);
	assert.ok(r.warnings[0].includes("hp"));
});

test("持久化 roundtrip 与缺失文件回退", () => {
	const dir = mkdtempSync(join(tmpdir(), "rp-state-"));
	try {
		const file = join(dir, "deep", "s.json");
		assert.deepEqual(loadState(file), defaultState(), "缺失文件应回退默认");
		const s = applyPatch(defaultState(), { time: "午夜", plot_threads: ["寻找失踪的商队"] }).state;
		saveState(file, s);
		assert.deepEqual(loadState(file), s);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("角色键归一化：大小写/空白变体归到已知名", () => {
	const patch = {
		time: "清晨",
		characters: {
			"alice ": { affinity: 20 },
			ALICE: { status: "警觉" },
			新角色: { affinity: 5 },
		},
	};
	const out = canonicalizeCharacterKeys(patch, ["Alice", "旅人"]);
	const chars = out.characters as Record<string, { affinity?: number; status?: string }>;
	assert.deepEqual(Object.keys(chars).sort(), ["Alice", "新角色"], "变体应合并到规范名，未知名保留");
	assert.equal(chars["Alice"].affinity, 20, "撞名浅合并应保留先写字段");
	assert.equal(chars["Alice"].status, "警觉");
	assert.equal((out as { time?: string }).time, "清晨", "非 characters 字段原样透传");
});

test("角色键归一化：无 characters 时原样返回", () => {
	const patch = { time: "午夜" };
	assert.deepEqual(canonicalizeCharacterKeys(patch, ["Alice"]), patch);
});

test("注入格式化", () => {
	const s = applyPatch(defaultState(), {
		time: "清晨",
		characters: { Alice: { affinity: 30, status: "守夜后疲惫" } },
		inventory: ["药茶"],
	}).state;
	const text = formatState(s);
	assert.ok(text.includes("清晨"));
	assert.ok(text.includes("Alice"));
	assert.ok(text.includes("药茶"));
	assert.ok(formatState(defaultState()).includes("尚无记录"));
});

test("inventory/plot_threads：非字符串元素不静默丢弃——warnings 说明期望形态", () => {
	// 实弹里模型传 [{name,数量}] 被 filter 掉后仍回报「成功」，只能反复试错（M-B S5）
	const r = applyPatch(defaultState(), { inventory: [{ name: "补气丹", 数量: 1 }, "草药"] } as never);
	assert.deepEqual(r.state.inventory, ["草药"], "字符串元素照常保留");
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0], /1 项不是字符串已丢弃/);
	assert.match(r.warnings[0], /补气丹/, "回显被丢的原值");
	assert.match(r.warnings[0], /字符串数组/, "说明期望形态");
});

test("inventory：全字符串数组不产生警告（不误报）", () => {
	const r = applyPatch(defaultState(), { inventory: ["猎刀", "草药"] });
	assert.deepEqual(r.warnings, []);
});

// ---------- 自定义表格 ----------

test("表格：create/drop/insert/update/delete/query 全链路", () => {
	let s = defaultState();
	let r = applyTableOperation(s, {
		kind: "create",
		name: "主角信息",
		columns: [{ name: "名字" }, { name: "年龄", type: "integer" }, { name: "清醒", type: "boolean" }],
		auto: true,
	});
	assert.equal(r.ok, true);
	assert.ok(r.state, "create 成功应给出状态");
	assert.ok(r.applied?.[0].includes("主角信息"));
	s = r.state!;
	const t = s.tables!["主角信息"];
	assert.equal(t.auto, true);
	assert.deepEqual(t.rows, [], "rows 初始为空");

	// 重复表名 / 无列 → error
	assert.equal(applyTableOperation(s, { kind: "create", name: "主角信息", columns: [{ name: "x" }] }).ok, false, "重名应报错");
	assert.equal(applyTableOperation(s, { kind: "create", name: "空表", columns: [] }).ok, false, "无列应报错");

	// insert：未知列丢弃 + warning；integer/boolean advisory 转换
	r = applyTableOperation(s, { kind: "insert", table: "主角信息", row: { 名字: "阿远", 年龄: "25", 清醒: "true", 未知列: "丢弃" } });
	assert.equal(r.ok, true);
	assert.ok(r.warnings?.some((w) => w.includes("未知列")), "未知列应告警");
	const row = s.tables!["主角信息"].rows[0];
	assert.deepEqual(row, { 名字: "阿远", 年龄: 25, 清醒: true }, "类型转换 + 未知列丢弃");

	// 不存在的表 → error
	assert.equal(applyTableOperation(s, { kind: "insert", table: "不存在", row: {} }).ok, false);
	assert.equal(applyTableOperation(s, { kind: "query", table: "不存在" }).ok, false);

	// query：filter 为空返回全部
	r = applyTableOperation(s, { kind: "query", table: "主角信息" });
	assert.equal(r.rows!.length, 1);

	// update：按 match 匹配（advisory 转换后比较）
	r = applyTableOperation(s, { kind: "update", table: "主角信息", match: { 名字: "阿远" }, changes: { 年龄: "26" } });
	assert.equal(r.ok, true);
	assert.equal(r.applied?.[0], "表 主角信息 更新 1 行");
	assert.equal(s.tables!["主角信息"].rows[0].年龄, 26, "changes 同样做 advisory 转换");

	// update 无匹配 → warning，不改行
	r = applyTableOperation(s, { kind: "update", table: "主角信息", match: { 名字: "不存在" }, changes: { 年龄: 30 } });
	assert.equal(r.ok, true);
	assert.ok(r.warnings?.some((w) => w.includes("无行匹配")));
	assert.equal(s.tables!["主角信息"].rows[0].年龄, 26);

	// query：按 filter 过滤
	r = applyTableOperation(s, { kind: "query", table: "主角信息", filter: { 年龄: 26 } });
	assert.equal(r.rows!.length, 1);
	r = applyTableOperation(s, { kind: "query", table: "主角信息", filter: { 年龄: 999 } });
	assert.equal(r.rows!.length, 0);

	// delete：按 match 删除
	r = applyTableOperation(s, { kind: "delete", table: "主角信息", match: { 名字: "阿远" } });
	assert.equal(r.ok, true);
	assert.equal(s.tables!["主角信息"].rows.length, 0);
	// delete 无匹配 → warning
	r = applyTableOperation(s, { kind: "delete", table: "主角信息", match: { 名字: "阿远" } });
	assert.ok(r.warnings?.some((w) => w.includes("无行匹配")));

	// drop
	r = applyTableOperation(s, { kind: "drop", name: "主角信息" });
	assert.equal(r.ok, true);
	assert.equal(s.tables!["主角信息"], undefined);
	assert.equal(applyTableOperation(s, { kind: "drop", name: "主角信息" }).ok, false, "drop 不存在应报错");
});

test("表格：create 列名去重、空白列名丢弃", () => {
	let s = defaultState();
	const r = applyTableOperation(s, { kind: "create", name: "t", columns: [{ name: "a" }, { name: "a" }, { name: " " }] });
	assert.equal(r.ok, true);
	assert.deepEqual(s.tables!["t"].columns.map((c) => c.name), ["a"]);
});

test("表格：setAuto 切换 auto 标志（不丢行）、表不存在报错", () => {
	let s = defaultState();
	s = applyTableOperation(s, {
		kind: "create",
		name: "主角信息",
		columns: [{ name: "名字" }],
		auto: true,
	}).state!;
	// 先插一行，确认 setAuto 只改标志、不碰行数据（前端 auto 开关不再走 drop→create→重插）
	s = applyTableOperation(s, { kind: "insert", table: "主角信息", row: { 名字: "阿远" } }).state!;

	// true → false（手动维护）
	let r = applyTableOperation(s, { kind: "setAuto", table: "主角信息", auto: false });
	assert.equal(r.ok, true);
	assert.equal(s.tables!["主角信息"].auto, false);
	assert.ok(r.applied?.[0].includes("手动维护"), "applied 应说明切到手动维护");
	assert.equal(s.tables!["主角信息"].rows.length, 1, "setAuto 不应丢行");

	// false → true（场记自动维护）
	r = applyTableOperation(s, { kind: "setAuto", table: "主角信息", auto: true });
	assert.equal(r.ok, true);
	assert.equal(s.tables!["主角信息"].auto, true);
	assert.ok(r.applied?.[0].includes("场记自动维护"), "applied 应说明切到场记自动维护");
	assert.equal(s.tables!["主角信息"].rows.length, 1);

	// 表不存在 → error
	r = applyTableOperation(s, { kind: "setAuto", table: "不存在", auto: true });
	assert.equal(r.ok, false);
	assert.ok(r.error?.includes("不存在"), "应报表不存在");
});

test("applyPatch tables：auto 表生效、非 auto 表与不存在表跳过并告警", () => {
	let s = defaultState();
	s = applyTableOperation(s, {
		kind: "create",
		name: "主角信息",
		columns: [{ name: "名字" }, { name: "年龄", type: "integer" }],
		auto: true,
	}).state!;
	s = applyTableOperation(s, { kind: "create", name: "世界地理", columns: [{ name: "地名" }], auto: false }).state!;

	const r = applyPatch(s, {
		tables: {
			"主角信息": {
				insert: [{ 名字: "阿远", 年龄: "25" }],
				update: [{ match: { 名字: "阿远" }, changes: { 年龄: 26 } }],
			},
			"世界地理": { insert: [{ 地名: "青梧山" }] },
			"不存在表": { insert: [{}] },
		},
	});
	const next = r.state;
	assert.equal(next.tables!["主角信息"].rows.length, 1);
	assert.equal(next.tables!["主角信息"].rows[0].年龄, 26, "update 作用在 insert 之后的行上");
	assert.equal(next.tables!["世界地理"].rows.length, 0, "非 auto 表不应被场记改动");
	assert.equal(next.tables!["不存在表"], undefined);
	assert.ok(r.warnings.some((w) => w.includes("非 auto")), "非 auto 表应告警");
	assert.ok(r.warnings.some((w) => w.includes("不存在表")), "不存在表应告警");
	assert.ok(r.applied.some((a) => a.includes("主角信息")), "auto 表的操作应计入 applied");
});

test("applyPatch tables：旧状态无 tables 字段时补丁自动初始化", () => {
	const legacy = applyPatch(defaultState(), { time: "正午" }).state;
	// 抹掉 tables 模拟旧存档
	delete (legacy as { tables?: unknown }).tables;
	const r = applyPatch(legacy, { tables: { x: { insert: [{}] } } });
	assert.ok(r.warnings.some((w) => w.includes("x")), "表不存在应告警，而非抛错");
	assert.ok(r.state.tables, "tables 字段应被初始化");
	assert.deepEqual(r.state.tables!.x, undefined);
});

test("formatState：追加 auto 表全量内容；formatTableIndex：只列非 auto 表", () => {
	let s = defaultState();
	s = applyTableOperation(s, {
		kind: "create",
		name: "主角信息",
		columns: [{ name: "名字" }, { name: "年龄", type: "integer" }],
		auto: true,
	}).state!;
	s = applyTableOperation(s, { kind: "insert", table: "主角信息", row: { 名字: "阿远", 年龄: 25 } }).state!;
	s = applyTableOperation(s, { kind: "create", name: "世界地理", columns: [{ name: "地名" }], auto: false }).state!;

	const text = formatState(s);
	assert.ok(text.includes("表格「主角信息」"), "auto 表应全量注入");
	assert.ok(text.includes("阿远") && text.includes("25"), "行数据应在");
	assert.ok(!text.includes("世界地理"), "非 auto 表不进全量注入");

	const idx = formatTableIndex(s);
	assert.ok(idx && idx.includes("世界地理"), "非 auto 表应进索引");
	assert.ok(!idx.includes("主角信息"), "auto 表不进索引");

	// 空 auto 表也亮出列名
	const s2 = applyTableOperation(defaultState(), { kind: "create", name: "空自动表", columns: [{ name: "a" }], auto: true }).state!;
	assert.ok(formatState(s2).includes("暂无数据"), "空 auto 表应提示暂无数据");

	// 只有 auto 表 / 无表 → 索引为空
	assert.equal(formatTableIndex(s2), undefined, "只有 auto 表时索引为空");
	assert.equal(formatTableIndex(defaultState()), undefined, "无表时索引为空");
});
