import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	deleteTemplate,
	listTemplates,
	loadTemplate,
	materializeTemplate,
	parseTavernDB,
	saveTemplate,
	TEMPLATES_DIR,
} from "../src/templates.ts";
import { defaultState } from "../src/state.ts";
import type { TableTemplateDef } from "../src/types.ts";

test("模板 CRUD：save → list → load → delete 全链路（含重名覆盖）", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-tmpl-"));
	try {
		const def: TableTemplateDef = {
			name: "主角档案",
			description: "每轮维护的主角信息",
			tables: [
				{ name: "主角信息表", columns: [{ name: "姓名" }, { name: "体力", type: "integer" }], auto: true, instructions: "每轮更新体力" },
				{ name: "世界观设定", columns: [{ name: "条目" }, { name: "内容" }] },
			],
		};
		assert.deepEqual(saveTemplate(cwd, def), { ok: true });
		assert.ok(existsSync(join(cwd, TEMPLATES_DIR, "主角档案.json")), "按模板名落盘 <name>.json");

		const loaded = loadTemplate(cwd, "主角档案");
		assert.ok(loaded);
		assert.equal(loaded.name, "主角档案");
		assert.equal(loaded.description, "每轮维护的主角信息");
		assert.equal(loaded.tables.length, 2);
		assert.equal(loaded.tables[0].auto, true);
		assert.deepEqual(loaded.tables[0].columns, [{ name: "姓名" }, { name: "体力", type: "integer" }]);

		const list = listTemplates(cwd);
		assert.equal(list.length, 1);
		assert.equal(list[0].name, "主角档案");
		assert.equal(list[0].tableCount, 2);
		assert.equal(list[0].description, "每轮维护的主角信息");

		// 重名覆盖
		saveTemplate(cwd, { name: "主角档案", tables: [{ name: "新表", columns: [{ name: "a" }] }] });
		assert.equal(loadTemplate(cwd, "主角档案")!.tables.length, 1);

		assert.deepEqual(deleteTemplate(cwd, "主角档案"), { ok: true });
		assert.equal(loadTemplate(cwd, "主角档案"), null);
		// 删除不存在的 → 报错
		assert.ok(!deleteTemplate(cwd, "主角档案").ok);
		// 空模板名删除 → 报错
		assert.ok(!deleteTemplate(cwd, "  ").ok);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("模板保存校验：空名/超长/路径分隔/无表/空列一律拒绝", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-tmpl-"));
	try {
		const okDef = (name: string, tables: TableTemplateDef["tables"]) => ({ name, tables });
		assert.ok(!saveTemplate(cwd, okDef("  ", [{ name: "a", columns: [{ name: "b" }] }])).ok, "空名拒绝");
		assert.ok(!saveTemplate(cwd, okDef("x".repeat(41), [{ name: "a", columns: [{ name: "b" }] }])).ok, "超 40 字拒绝");
		assert.ok(!saveTemplate(cwd, okDef("a/b", [{ name: "a", columns: [{ name: "b" }] }])).ok, "路径分隔符拒绝");
		assert.ok(!saveTemplate(cwd, okDef("a", [])).ok, "无表拒绝");
		assert.ok(!saveTemplate(cwd, okDef("a", [{ name: "x", columns: [] }])).ok, "空列拒绝");
		assert.deepEqual(saveTemplate(cwd, okDef("合法", [{ name: "t", columns: [{ name: "c" }] }])), { ok: true });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// 最小 chatSheets fixture（内联；结构与 TavernDB_template_色色灵感数据库模板V2.56.json 同构）
const MINI_CHATSHEETS = {
	mate: { type: "chatSheets", version: 2 },
	sheet_protagonist: {
		name: "主角信息表",
		sourceData: {
			note: "每轮维护的主角核心状态",
			initNode: "初始化时按模板设定建档",
			insertNode: "新增角色时登记基础信息",
			updateNode: "每轮按剧情推进更新主角状态",
			deleteNode: "角色退场时删除其记录",
			ddl: [
				"CREATE TABLE protagonist_info (",
				"  row_id INTEGER PRIMARY KEY, -- 行号",
				"  name TEXT, -- 姓名",
				"  ero_power INTEGER, -- 瑟瑟能力",
				"  stamina REAL, -- 体力",
				"  active BOOLEAN -- 是否在场",
				");",
			].join("\n"),
		},
		content: [
			["row_id", "姓名", "瑟瑟能力", "体力", "是否在场"],
			["1", "小明", "80", "12.5", "true"],
			["", "", "", "", ""],
			["2", "小红", "95", "8", "false"],
		],
	},
	sheet_settings: {
		name: "世界观设定表",
		sourceData: { note: "静态参考表" },
		content: [["条目", "内容"]],
	},
} as const;

test("parseTavernDB：捕获 note/4 触发器/rows/列 description，auto=有 updateNode", () => {
	const def = parseTavernDB(MINI_CHATSHEETS, "色色灵感库");
	assert.ok(def);
	assert.equal(def.name, "色色灵感库");
	assert.equal(def.tables.length, 2);

	const prot = def.tables[0];
	assert.equal(prot.name, "主角信息表");
	// 列：类型从 DDL 推断、description 从 DDL 注释提取（与中文表头对齐）
	assert.deepEqual(prot.columns, [
		{ name: "row_id", type: "integer", description: "行号" },
		{ name: "姓名", description: "姓名" },
		{ name: "瑟瑟能力", type: "integer", description: "瑟瑟能力" },
		{ name: "体力", type: "number", description: "体力" },
		{ name: "是否在场", type: "boolean", description: "是否在场" },
	]);
	// note 独立存
	assert.equal(prot.note, "每轮维护的主角核心状态");
	// 4 个触发器独立存（不再合并 instructions）
	assert.equal(prot.initNode, "初始化时按模板设定建档");
	assert.equal(prot.insertNode, "新增角色时登记基础信息");
	assert.equal(prot.updateNode, "每轮按剧情推进更新主角状态");
	assert.equal(prot.deleteNode, "角色退场时删除其记录");
	assert.equal(prot.instructions, undefined, "新解析不再产出 instructions");
	// 有 updateNode → auto=true
	assert.equal(prot.auto, true);
	// 初始数据行：content[1..] 按表头映射，空行跳过，值保留原样（类型在物化时转换）
	assert.deepEqual(prot.rows, [
		{ row_id: "1", 姓名: "小明", 瑟瑟能力: "80", 体力: "12.5", 是否在场: "true" },
		{ row_id: "2", 姓名: "小红", 瑟瑟能力: "95", 体力: "8", 是否在场: "false" },
	]);

	// 无 updateNode 的表：非 auto、触发器缺省；note 保留
	const settings = def.tables[1];
	assert.equal(settings.name, "世界观设定表");
	assert.equal(settings.auto, undefined);
	assert.equal(settings.note, "静态参考表");
	assert.equal(settings.updateNode, undefined);
	assert.equal(settings.rows, undefined, "无数据区的表不产出 rows");
});

test("parseTavernDB：模板名优先级 fallbackName > mate.name > 默认；失败返回 null", () => {
	const withMateName = { ...MINI_CHATSHEETS, mate: { ...MINI_CHATSHEETS.mate, name: "灵感库" } };
	assert.equal(parseTavernDB(withMateName)?.name, "灵感库", "mate.name 兜底");
	assert.equal(parseTavernDB(withMateName, "指定名")?.name, "指定名", "fallbackName 优先");
	assert.equal(parseTavernDB(MINI_CHATSHEETS)?.name, "TavernDB 导入", "无任何名字时用默认");
	// 解析失败：非对象 / 无 sheet_ 表 / 表头缺失
	assert.equal(parseTavernDB(null), null);
	assert.equal(parseTavernDB("not json"), null);
	assert.equal(parseTavernDB({ mate: { type: "chatSheets" } }), null);
	assert.equal(parseTavernDB({ sheet_x: { name: "无内容" } }), null);
});

test("materializeTemplate：建表 + instructions 并入 description + auto 传递 + 只建结构", () => {
	const state = defaultState();
	const def: TableTemplateDef = {
		name: "主角档案",
		tables: [
			{ name: "主角信息表", columns: [{ name: "姓名" }, { name: "体力", type: "integer" }], auto: true, description: "用途说明", instructions: "每轮更新体力" },
			{ name: "世界观设定", columns: [{ name: "条目" }] },
		],
	};
	const r = materializeTemplate(state, def);
	assert.equal(r.warnings.length, 0);
	assert.equal(r.applied.length, 2);

	const t = state.tables!["主角信息表"];
	assert.ok(t, "表已建进 state.tables");
	assert.equal(t.auto, true, "auto 传递到 CustomTable");
	assert.equal(t.rows.length, 0, "只建结构不填数据");
	assert.ok(t.description!.includes("用途说明"), "description 原样写入");
	assert.ok(t.description!.includes("每轮更新体力"), "instructions 并入 description");
	assert.ok(t.description!.startsWith("【全局填表纪律】"), "全局纪律注入在 description 最前");
	// 无 description/instructions 的表 → description 仅含全局纪律
	assert.ok(state.tables!["世界观设定"].description?.includes("【全局填表纪律】"), "纪律仍注入");
	assert.ok(!(state.tables!["世界观设定"].description ?? "").includes("每轮更新体力"), "不混入他表内容");
});

test("materializeTemplate：幂等——已存在的表跳过不重复建", () => {
	const state = defaultState();
	const def: TableTemplateDef = {
		name: "主角档案",
		tables: [{ name: "主角信息表", columns: [{ name: "姓名" }], auto: true }],
	};
	materializeTemplate(state, def);
	const r2 = materializeTemplate(state, def);
	assert.equal(r2.applied.length, 0, "第二次不再建表");
	assert.equal(r2.warnings.length, 1);
	assert.ok(r2.warnings[0].includes("已存在"));
	assert.equal(Object.keys(state.tables!).length, 1);
});

test("materializeTemplate：旧状态无 tables 字段时自动初始化", () => {
	const state = defaultState();
	delete (state as { tables?: unknown }).tables;
	const r = materializeTemplate(state, { name: "t", tables: [{ name: "表", columns: [{ name: "列" }] }] });
	assert.equal(r.warnings.length, 0);
	assert.ok(state.tables?.["表"]);
});

test("materializeTemplate：建表填初始行 + note/触发器并入 description + 幂等不重复插", () => {
	const state = defaultState();
	const def: TableTemplateDef = {
		name: "主角档案",
		tables: [
			{
				name: "主角信息表",
				columns: [{ name: "姓名" }, { name: "体力", type: "integer" }],
				note: "每轮维护的主角状态",
				updateNode: "每轮更新体力",
				initNode: "建档时初始化",
				rows: [
					{ 姓名: "小明", 体力: "80" },
					{ 姓名: "小红", 体力: "95" },
				],
			},
		],
	};
	const r = materializeTemplate(state, def);
	assert.equal(r.warnings.length, 0);
	assert.deepEqual(r.applied, ["表 主角信息表 已创建", "表「主角信息表」填充初始数据 2 行"]);

	const t = state.tables!["主角信息表"];
	assert.equal(t.auto, undefined, "模板未标 auto 不写 auto");
	// 初始行填入且列类型做 advisory 转换（integer ← "80"）
	assert.deepEqual(t.rows, [
		{ 姓名: "小明", 体力: 80 },
		{ 姓名: "小红", 体力: 95 },
	]);
	assert.ok(t.description!.includes("每轮维护的主角状态"), "note 并入 description");
	assert.ok(t.description!.includes("每轮更新体力"), "updateNode 并入 description");
	assert.ok(t.description!.includes("建档时初始化"), "initNode 并入 description");

	// 幂等：第二次不建表、不重复插初始行
	const r2 = materializeTemplate(state, def);
	assert.equal(r2.applied.length, 0, "第二次不再建表/插行");
	assert.ok(r2.warnings.some((w) => w.includes("已存在")));
	assert.equal(state.tables!["主角信息表"].rows.length, 2, "初始行不重复插入");
});

test("loadTemplate 向后兼容：旧模板 instructions 读时映射到 updateNode", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-tmpl-"));
	try {
		assert.deepEqual(
			saveTemplate(cwd, {
				name: "旧模板",
				tables: [{ name: "表", columns: [{ name: "a" }], auto: true, instructions: "旧合并规则" }],
			}),
			{ ok: true },
		);
		const loaded = loadTemplate(cwd, "旧模板");
		assert.ok(loaded);
		const t = loaded.tables[0];
		assert.equal(t.instructions, "旧合并规则");
		assert.equal(t.updateNode, "旧合并规则", "instructions 映射到 updateNode");
		assert.equal(t.auto, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
