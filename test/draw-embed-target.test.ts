/**
 * 嵌入目标定位单测（2026-08-12 修复「生图/改稿嵌错楼层」）：
 * - matchAnchor：四层命中判定（精确/最长子串/尾部/去标点模糊）
 * - findEntryByAnchor：全树搜索含 anchor 的条目（多条命中取最后）
 * - resolveEmbedTarget：默认目标 / anchor 参与选目标 / 目标不在分支报错 / 无命中报错
 * 运行：node --test test/draw-embed-target.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { matchAnchor, findEntryByAnchor, resolveEmbedTarget } from "../src/draw-plugins/draw-pipeline/anchor.ts";

// ---------- 1. matchAnchor ----------

test("matchAnchor：全文精确命中", () => {
	assert.equal(matchAnchor("他推开酒馆的门，走进温暖的灯火里。", "他推开酒馆的门"), "exact");
});

test("matchAnchor：最长子串命中（anchor 含正文没有的尾巴）", () => {
	// anchor 逐字摘录自正文但结尾被模型改动 → 子串匹配
	assert.equal(matchAnchor("她站在门口，手里拎着一只小巧的纸袋。", "她站在门口，手里拎着一只小巧的纸袋和一把伞"), "substring");
});

test("matchAnchor：尾部片段命中（最长子串覆盖尾部场景）", () => {
	// anchor 的尾部 10 字符在正文中 → 最长子串先命中（tail 分支被 substring 覆盖，同 buildInsertPatch 语义）
	assert.equal(matchAnchor("加藤惠推开门，阳光洒了进来。", "阳光洒了进来。加藤惠推开门"), "substring");
});

test("matchAnchor：去标点模糊命中（连续片段均 <3 字，仅标点差异）", () => {
	// 标点打断所有 ≥3 字的连续片段（含结尾）→ 精确/子串/尾部均失败 → 归一后 fuzzy 命中
	assert.equal(matchAnchor("凯尔。惠。走了！", "凯尔，惠，走了。"), "fuzzy");
});

test("matchAnchor：未命中返回 null", () => {
	assert.equal(matchAnchor("星辉历332年5月6日，午后。", "完全不存在的锚点文本"), null);
});

test("matchAnchor：空 anchor / 空正文返回 null", () => {
	assert.equal(matchAnchor("正文", ""), null);
	assert.equal(matchAnchor("", "锚点"), null);
	assert.equal(matchAnchor("", ""), null);
});

// ---------- 2. findEntryByAnchor ----------

const entries = [
	{ id: "aaa00001", text: "粉色卧室里，茶香混着烤饼干的甜味在空气里打转。" },
	{ id: "aaa00002", text: "凯尔托着她的背，把她重新放回绒毯上，让她侧躺着。" },
	{ id: "aaa00003", text: "她挂在他身上，蓝色的眼睛还湿漉漉地望着他。" },
];

test("findEntryByAnchor：精确命中唯一条目", () => {
	const r = findEntryByAnchor(entries, "凯尔托着她的背");
	assert.ok(r);
	assert.equal(r!.entryId, "aaa00002");
	assert.equal(r!.matched, "exact");
});

test("findEntryByAnchor：多条命中取最后出现的（最近的楼层）", () => {
	const dup = [
		{ id: "aaa00001", text: "凯尔托着她的背，说了一句话。" },
		{ id: "aaa00002", text: "凯尔托着她的背，又重复了一遍。" },
	];
	const r = findEntryByAnchor(dup, "凯尔托着她的背");
	assert.ok(r);
	assert.equal(r!.entryId, "aaa00002");
});

test("findEntryByAnchor：无命中返回 null", () => {
	assert.equal(findEntryByAnchor(entries, "赫斯提雅的小穴破处"), null);
});

test("findEntryByAnchor：空 anchor 返回 null", () => {
	assert.equal(findEntryByAnchor(entries, ""), null);
});

test("findEntryByAnchor：跳过无正文条目", () => {
	const withEmpty = [{ id: "aaa00001", text: "" }, { id: "aaa00002", text: "凯尔托着她的背。" }];
	const r = findEntryByAnchor(withEmpty, "凯尔托着她的背");
	assert.ok(r);
	assert.equal(r!.entryId, "aaa00002");
});

// ---------- 3. resolveEmbedTarget ----------

const allItems = [
	{ id: "aaa00001", text: "粉色卧室里，茶香混着烤饼干的甜味在空气里打转。" },
	{ id: "aaa00002", text: "凯尔托着她的背，把她重新放回绒毯上，让她侧躺着。" },
	{ id: "aaa00003", text: "星辉历332年5月6日，午后。温泉位面，丰之崎温泉酒店经理室。" },
	{ id: "aaa00004", text: "她瘫在他怀里，白裙堆在腰际，喘息声又急又碎。" },
];
// 当前分支 = 全部四条（无漂移）
const branchAll = ["aaa00001", "aaa00002", "aaa00003", "aaa00004"];
// 漂移分支 = 只有前两条（后两条离开当前叙事）
const branchDrifted = ["aaa00001", "aaa00002"];

test("resolveEmbedTarget：无 anchor → 默认当前分支最后一条 assistant", () => {
	const r = resolveEmbedTarget(allItems, branchAll, undefined);
	assert.ok(r.ok);
	assert.equal(r.ok && r.entryId, "aaa00004");
	assert.equal(r.ok && r.matched, "default");
});

test("resolveEmbedTarget：anchor 命中默认目标 → 用默认目标", () => {
	const r = resolveEmbedTarget(allItems, branchAll, "她瘫在他怀里，白裙堆在腰际");
	assert.ok(r.ok);
	assert.equal(r.ok && r.entryId, "aaa00004");
});

test("resolveEmbedTarget：anchor 未命中默认目标但命中当前分支历史楼层 → 用该楼层", () => {
	const r = resolveEmbedTarget(allItems, branchAll, "凯尔托着她的背");
	assert.ok(r.ok);
	assert.equal(r.ok && r.entryId, "aaa00002");
});

test("resolveEmbedTarget：anchor 命中楼层不在当前分支（叶漂移）→ 报错", () => {
	const r = resolveEmbedTarget(allItems, branchDrifted, "她瘫在他怀里，白裙堆在腰际");
	assert.ok(!r.ok);
	assert.ok(!r.ok && r.error.includes("不在当前分支"));
});

test("resolveEmbedTarget：anchor 全树无命中 → 报错", () => {
	const r = resolveEmbedTarget(allItems, branchAll, "完全不存在的锚点文本");
	assert.ok(!r.ok);
	assert.ok(!r.ok && r.error.includes("未在剧情正文命中"));
});

test("resolveEmbedTarget：无任何 assistant 条目 → 报错", () => {
	const r = resolveEmbedTarget([], [], "锚点");
	assert.ok(!r.ok);
	assert.equal(!r.ok && r.error, "暂无剧情消息可嵌入");
});
