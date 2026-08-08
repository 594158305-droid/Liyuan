/**
 * 插件 A draw-role 二期单测：未知角色自动学习、自定义标签组、在线标签库。
 * 运行：node --test test/draw-role-learn.test.ts
 * 全部用 mkdtempSync 临时目录，不污染仓库。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	confirmLearnCharacter,
	dismissLearnCandidate,
	listLearnCandidates,
	loadLearnCandidates,
	recordUnknownCharacters,
} from "../src/draw-plugins/draw-role/learn-candidates.ts";
import {
	deleteTagGroup,
	exportTagGroups,
	getEnabledGroupTags,
	importTagGroups,
	loadTagGroups,
	saveTagGroup,
	setTagGroupEnabled,
} from "../src/draw-plugins/draw-role/tag-groups.ts";
import {
	getOnlineTagDbStatus,
	searchOnlineTags,
	searchTagsWithOnline,
	updateOnlineTagDb,
} from "../src/draw-plugins/draw-role/tagdb.ts";
import { loadWardrobe } from "../src/wardrobe.ts";

const tmpCwd = (): string => mkdtempSync(join(tmpdir(), "liyuan-learn-"));

/** 临时目录造一个最小可读的 liyuan.config.json（resolveConfigPath 用） */
function withConfig(cwd: string, card = "assets/cards/test.json"): void {
	mkdirSync(join(cwd, "assets", "cards"), { recursive: true });
	writeFileSync(join(cwd, "liyuan.config.json"), `${JSON.stringify({ card }, null, "\t")}\n`, "utf8");
}

// ---------- 1. 未知角色自动学习 ----------

test("learn：recordUnknownCharacters 去重 + firstSeenAt 刷新 + learned/ignored 不覆盖", async () => {
	const cwd = tmpCwd();
	recordUnknownCharacters(cwd, ["伊利亚斯", "凯尔", "伊利亚斯"]);
	let file = loadLearnCandidates(cwd);
	assert.equal(file.candidates.length, 2);
	const e = file.candidates.find((c) => c.name === "伊利亚斯");
	assert.equal(e?.status, "pending");
	assert.equal(e?.source, "pipeline");
	const firstSeen = e?.firstSeenAt ?? 0;
	await new Promise((r) => setTimeout(r, 10));
	// 同名刷新 firstSeenAt（source 保留 pipeline）
	recordUnknownCharacters(cwd, ["伊利亚斯"]);
	file = loadLearnCandidates(cwd);
	assert.ok((file.candidates.find((c) => c.name === "伊利亚斯")?.firstSeenAt ?? 0) > firstSeen);
	// learned 后不覆盖
	confirmLearnCharacter(cwd, "凯尔", "assets/cards/test.json");
	recordUnknownCharacters(cwd, ["凯尔"]);
	file = loadLearnCandidates(cwd);
	assert.equal(file.candidates.find((c) => c.name === "凯尔")?.status, "learned");
});

test("learn：confirmLearnCharacter 写 wardrobe + 标 learned；dismiss 标 ignored", async () => {
	const cwd = tmpCwd();
	withConfig(cwd);
	recordUnknownCharacters(cwd, ["新角色"]);
	const r = confirmLearnCharacter(cwd, "新角色");
	assert.ok(r.ok);
	// wardrobe 里出现该角色
	const wb = loadWardrobe(cwd, "assets/cards/test.json");
	assert.ok(wb.characters.some((c) => c.name === "新角色"));
	const file = loadLearnCandidates(cwd);
	assert.equal(file.candidates.find((c) => c.name === "新角色")?.status, "learned");
	// dismiss
	recordUnknownCharacters(cwd, ["另个"]);
	dismissLearnCandidate(cwd, "另个");
	const file2 = loadLearnCandidates(cwd);
	assert.equal(file2.candidates.find((c) => c.name === "另个")?.status, "ignored");
	// list 过滤
	assert.equal(listLearnCandidates(cwd, "pending").length, 0);
	assert.equal(listLearnCandidates(cwd, "learned").length, 1);
});

test("learn：空名字 → 错误；无配置时 card 回退 DEFAULT_CONFIG（仍可写入默认卡）", () => {
	const cwd = tmpCwd();
	withConfig(cwd);
	assert.equal(confirmLearnCharacter(cwd, "").ok, false);
	// 无 config：loadConfig 回退 DEFAULT_CONFIG.card（非空），confirm 仍成功写入默认卡
	const cwd2 = tmpCwd();
	const r = confirmLearnCharacter(cwd2, "某角色");
	assert.ok(r.ok);
});

// ---------- 2. 自定义标签组 ----------

test("tag-groups：CRUD + 启用拼接 + 导入导出", async () => {
	const cwd = tmpCwd();
	// 添加（无 id → 生成）
	let file = saveTagGroup(cwd, { name: "质量词", tags: "best quality, masterpiece" });
	assert.equal(file.groups.length, 1);
	const id = file.groups[0]!.id;
	assert.ok(id.length > 0);
	// 更新（有 id）
	file = saveTagGroup(cwd, { id, name: "质量词", tags: "best quality, masterpiece, highres" });
	assert.equal(file.groups[0]!.tags, "best quality, masterpiece, highres");
	// 未启用组不进拼接
	assert.equal(getEnabledGroupTags(cwd), "best quality, masterpiece, highres");
	// 开关
	setTagGroupEnabled(cwd, id, false);
	assert.equal(getEnabledGroupTags(cwd), "");
	setTagGroupEnabled(cwd, id, true);
	// 导出
	assert.equal(exportTagGroups(cwd).length, 1);
	// 删除
	deleteTagGroup(cwd, id);
	assert.equal(loadTagGroups(cwd).groups.length, 0);
});

test("tag-groups：importTagGroups 按 id 去重覆盖 + 返回导入数", async () => {
	const cwd = tmpCwd();
	const a = saveTagGroup(cwd, { name: "A", tags: "t1" }).groups[0]!;
	// 导入同 id（覆盖）+ 新 id
	const imported = importTagGroups(cwd, [
		{ ...a, tags: "t1, t2" },
		{ id: "new-1", name: "B", tags: "t3", enabled: false, createdAt: 0 },
	]);
	assert.equal(imported, 2);
	const groups = loadTagGroups(cwd).groups;
	assert.equal(groups.length, 2);
	assert.equal(groups.find((g) => g.id === a.id)?.tags, "t1, t2");
	assert.equal(groups.find((g) => g.id === "new-1")?.name, "B");
});

// ---------- 3. 在线标签库 ----------

test("online-tags：fake fetchImpl 更新缓存 + 状态 + 搜索合并", async () => {
	const cwd = tmpCwd();
	const r = await updateOnlineTagDb(cwd, {
		fetchImpl: (async () =>
			({
				ok: true,
				text: async () => "long_hair,867\nbad_tail,3\n\nweird_line\n",
			}) as Response) as typeof fetch,
	});
	assert.ok(r.ok);
	assert.equal((r as { entries: number }).entries, 2, "坏行/空行跳过");
	const st = getOnlineTagDbStatus(cwd);
	assert.ok(st && st.entries === 2);
	// 在线搜索
	const hits = searchOnlineTags(cwd, "tail");
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.tag, "bad_tail");
	// 合并搜索：bad_tail 离线没有 → 在线补全（count=在线次数）
	const merged = searchTagsWithOnline(cwd, "bad_tail");
	assert.ok(merged.some((t) => t.tag === "bad_tail" && t.count === 3));
});

test("online-tags：下载失败返回错误不抛；无缓存 status=null", async () => {
	const cwd = tmpCwd();
	assert.equal(getOnlineTagDbStatus(cwd), null);
	const r = await updateOnlineTagDb(cwd, {
		fetchImpl: (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch,
	});
	assert.ok(!r.ok);
	assert.ok("error" in r && (r as { error: string }).error.includes("500"));
});