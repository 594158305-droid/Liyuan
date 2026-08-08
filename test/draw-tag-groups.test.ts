/**
 * 自定义标签组新语义单测（LWB 对齐批次 3，TODO-DRAW §4.2）：
 * characterId（角色绑定组）+ selectedGroupId（全局当前选中组）。
 * 运行：node --test test/draw-tag-groups.test.ts
 * 全部用 mkdtempSync 临时目录，不污染仓库。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	deleteTagGroup,
	exportTagGroups,
	getEnabledGroupTags,
	getGlobalSelectedGroupTags,
	getRoleGroupTags,
	importTagGroups,
	loadTagGroups,
	saveTagGroup,
	setGlobalSelectedGroup,
	setTagGroupEnabled,
} from "../src/draw-plugins/draw-role/tag-groups.ts";

const tmpCwd = (): string => mkdtempSync(join(tmpdir(), "liyuan-taggroups-"));

test("tag-groups：characterId 绑定角色组 + load/export 透出", () => {
	const cwd = tmpCwd();
	const g = saveTagGroup(cwd, { name: "角色组", tags: "royal_dress", characterId: "伊利亚斯" });
	assert.equal(g.groups[0]!.characterId, "伊利亚斯");
	// load 往返保留
	assert.equal(loadTagGroups(cwd).groups[0]!.characterId, "伊利亚斯");
	// 全局组（无 characterId）也共存
	saveTagGroup(cwd, { name: "全局组", tags: "global_tag" });
	assert.equal(loadTagGroups(cwd).groups.length, 2);
	// export 透出 characterId
	const exported = exportTagGroups(cwd);
	assert.equal(exported.length, 2);
	assert.equal(exported.find((x) => x.id === g.groups[0]!.id)?.characterId, "伊利亚斯");
});

test("tag-groups：getEnabledGroupTags 保持原行为（全部 enabled 组，含角色组）", () => {
	const cwd = tmpCwd();
	saveTagGroup(cwd, { name: "角色组", tags: "role_tags", characterId: "甲" });
	saveTagGroup(cwd, { name: "全局组", tags: "global_tags" });
	assert.equal(getEnabledGroupTags(cwd), "role_tags global_tags");
	// 关闭后不拼
	const id = loadTagGroups(cwd).groups.find((x) => x.name === "角色组")!.id;
	setTagGroupEnabled(cwd, id, false);
	assert.equal(getEnabledGroupTags(cwd), "global_tags");
});

test("tag-groups：setGlobalSelectedGroup 写顶层 + getGlobalSelectedGroupTags 语义（回退/选中/清除/忽略不存在）", () => {
	const cwd = tmpCwd();
	saveTagGroup(cwd, { name: "全局A", tags: "sel_tags" });
	const file = loadTagGroups(cwd);
	const selId = file.groups[0]!.id;
	// 未选中 → 回退 enabled 全局组
	assert.equal(getGlobalSelectedGroupTags(cwd), "sel_tags");
	// 选中 → 只返回选中组 tags
	setGlobalSelectedGroup(cwd, selId);
	assert.equal(loadTagGroups(cwd).selectedGroupId, selId);
	assert.equal(getGlobalSelectedGroupTags(cwd), "sel_tags");
	// null 清除 → 顶层无 selectedGroupId → 回退 enabled
	setGlobalSelectedGroup(cwd, null);
	assert.equal(loadTagGroups(cwd).selectedGroupId, undefined);
	assert.equal(getGlobalSelectedGroupTags(cwd), "sel_tags");
	// 不存在的 id → 忽略（不写入）
	setGlobalSelectedGroup(cwd, "nope");
	assert.equal(loadTagGroups(cwd).selectedGroupId, undefined);
});

test("tag-groups：getRoleGroupTags 找 characterId===name 且 id===selectedGroupId 的组 tags", () => {
	const cwd = tmpCwd();
	const g = saveTagGroup(cwd, { name: "甲组", tags: "armor", characterId: "甲" });
	saveTagGroup(cwd, { name: "乙组", tags: "cloak", characterId: "乙" });
	saveTagGroup(cwd, { name: "全局", tags: "global" });
	const groups = loadTagGroups(cwd).groups;
	const gid = g.groups[0]!.id;
	const otherId = groups.find((x) => x.name === "乙组")!.id;
	const globalId = groups.find((x) => x.name === "全局")!.id;
	assert.equal(getRoleGroupTags(cwd, "甲", gid), "armor");
	// 组 id 绑定别的角色 → ""
	assert.equal(getRoleGroupTags(cwd, "甲", otherId), "");
	// 全局组 id 传角色 → ""（characterId 不匹配）
	assert.equal(getRoleGroupTags(cwd, "甲", globalId), "");
	// 无 selectedGroupId → ""
	assert.equal(getRoleGroupTags(cwd, "甲"), "");
	// 不存在的 id → ""
	assert.equal(getRoleGroupTags(cwd, "甲", "zzz"), "");
});

test("tag-groups：删除选中的组清除 selectedGroupId；setTagGroupEnabled/importTagGroups 保留", () => {
	const cwd = tmpCwd();
	saveTagGroup(cwd, { name: "全局A", tags: "t" });
	const id = loadTagGroups(cwd).groups[0]!.id;
	setGlobalSelectedGroup(cwd, id);
	assert.equal(loadTagGroups(cwd).selectedGroupId, id);
	// 开关 / 导入保留 selectedGroupId
	setTagGroupEnabled(cwd, id, false);
	assert.equal(loadTagGroups(cwd).selectedGroupId, id);
	importTagGroups(cwd, [{ id: "import-1", name: "导入", tags: "x", enabled: true, createdAt: 0 }]);
	assert.equal(loadTagGroups(cwd).selectedGroupId, id);
	// 删除选中组 → 清除 selectedGroupId
	deleteTagGroup(cwd, id);
	assert.equal(loadTagGroups(cwd).selectedGroupId, undefined);
});
