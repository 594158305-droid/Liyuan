/**
 * LWB 黑盒对齐批次 1：版本选中持久化 + 结构化 tags 存储。
 * 运行：node --test test/draw-slot-select.test.ts
 * 全部用 mkdtempSync 临时目录，不污染仓库。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendVersion,
	createSlot,
	getSlotInfo,
	loadSlotStore,
	listSlotSummaries,
	saveSlot,
	saveSlotStoreNow,
	setSelectedVersionIndex,
	updateVersionTags,
} from "../src/draw-plugins/draw-slot/slot-store.ts";

const tmpCwd = (): string => mkdtempSync(join(tmpdir(), "liyuan-slot-sel-"));

const makeCache = (cwd: string, name: string, content: string): void => {
	mkdirSync(join(cwd, ".liyuan-cache"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan-cache", name), content, "utf8");
};

/** 造一个两版本 slot：v0=cache-a，v1=cache-b（各自文件不同内容） */
function makeTwoVersionSlot(cwd: string, slotId = "slot-1"): void {
	makeCache(cwd, "draw-a.png", "content-a");
	makeCache(cwd, "draw-b.png", "content-b");
	const store = createSlot(cwd, {
		slotId,
		chatId: "c",
		messageId: "m",
		file: ".liyuan-cache/draw-a.png",
		params: { scene: "scene-a", prompt: "old-a", positive: "pos-a" },
	});
	store.slots[slotId] = {
		...store.slots[slotId],
		versions: [...store.slots[slotId]!.versions, { file: ".liyuan-cache/draw-b.png", params: { scene: "scene-b", positive: "pos-b" }, savedAt: 0, discarded: false }],
	};
	saveSlotStoreNow(cwd, store);
}

// ---------- 1. selectedVersionIndex 持久化 ----------

test("setSelectedVersionIndex：写入 + loadSlotStore 往返保留", async () => {
	const cwd = tmpCwd();
	makeTwoVersionSlot(cwd);
	const r = setSelectedVersionIndex(cwd, "slot-1", 1);
	assert.deepEqual(r, { ok: true });
	const store = loadSlotStore(cwd);
	assert.equal(store.slots["slot-1"]?.selectedVersionIndex, 1);
	// listSlotSummaries 透出
	const sum = listSlotSummaries(cwd).find((s) => s.slotId === "slot-1");
	assert.equal(sum?.selectedVersionIndex, 1);
});

test("setSelectedVersionIndex：slot 不存在 / 下标越界 → 错误", () => {
	const cwd = tmpCwd();
	makeTwoVersionSlot(cwd);
	assert.ok(!setSelectedVersionIndex(cwd, "nope", 0).ok);
	assert.ok(!setSelectedVersionIndex(cwd, "slot-1", 5).ok);
	assert.ok(!setSelectedVersionIndex(cwd, "slot-1", -1).ok);
});

test("selectedVersionIndex 指向的版本成为 currentVersion（getSlotInfo.src 跟随）", async () => {
	const cwd = tmpCwd();
	makeTwoVersionSlot(cwd);
	// 缺省：最新非 discarded（v1=draw-b）
	let info = getSlotInfo(cwd, "slot-1");
	assert.equal(info?.src, "/cache/draw-b.png");
	// 选中 v0 → src 变为 draw-a
	setSelectedVersionIndex(cwd, "slot-1", 0);
	info = getSlotInfo(cwd, "slot-1");
	assert.equal(info?.src, "/cache/draw-a.png");
	assert.equal(info?.selectedVersionIndex, 0);
});

// ---------- 2. updateVersionTags 覆盖保存 ----------

test("updateVersionTags：覆盖 scene/characterPrompts/positive，保留其他 params", () => {
	const cwd = tmpCwd();
	makeTwoVersionSlot(cwd);
	// v0 有旧 prompt/params → 更新后保留 prompt 等未覆盖字段
	const r = updateVersionTags(cwd, "slot-1", 0, { scene: "scene-a-v2", characterPrompts: [{ name: "伊利亚斯", prompt: "blond_hair" }] });
	assert.ok(r.ok);
	const store = loadSlotStore(cwd);
	const v0 = store.slots["slot-1"]!.versions[0]!;
	assert.equal(v0.params.scene, "scene-a-v2");
	assert.equal(v0.params.positive, "pos-a"); // 保留
	assert.equal(v0.params.prompt, "old-a"); // 保留
	assert.deepEqual(v0.params.characterPrompts, [{ name: "伊利亚斯", prompt: "blond_hair" }]);
});

test("updateVersionTags：index 越界 / slot 不存在 → 错误", () => {
	const cwd = tmpCwd();
	makeTwoVersionSlot(cwd);
	assert.ok(!updateVersionTags(cwd, "slot-1", 9, { scene: "x" }).ok);
	assert.ok(!updateVersionTags(cwd, "nope", 0, { scene: "x" }).ok);
});

test("getSlotInfo.versions：tags 从 params 读 + 旧 prompt 回退 scene", () => {
	const cwd = tmpCwd();
	makeCache(cwd, "draw-a.png", "content-a");
	const store = createSlot(cwd, { slotId: "slot-1", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-a.png", params: { prompt: "legacy-prompt" } });
	saveSlotStoreNow(cwd, store);
	const info = getSlotInfo(cwd, "slot-1");
	assert.ok(info && info.versions.length === 1);
	assert.equal(info.versions[0]!.tags.scene, "legacy-prompt"); // 无 scene 回退 prompt
	assert.equal(info.versions[0]!.src, "/cache/draw-a.png");
	assert.equal(info.versions[0]!.discarded, false);
});

// ---------- 3. saveSlot 指定版本 ----------

test("saveSlot(versionIndex)：只移动指定版本文件", async () => {
	const cwd = tmpCwd();
	makeTwoVersionSlot(cwd);
	// 保存 v0（cache-a）→ media 出现 content-a 的 md5 文件，draw-b 仍在 cache
	const r = saveSlot(cwd, "slot-1", 0);
	assert.ok(r.ok);
	const mediaFiles = readdirSync(join(cwd, ".liyuan-media"));
	assert.equal(mediaFiles.length, 1);
	// v0 已 savedAt>0，v1 仍指向 cache
	const store = loadSlotStore(cwd);
	assert.ok(store.slots["slot-1"]!.versions[0]!.savedAt > 0);
	assert.ok(store.slots["slot-1"]!.versions[1]!.file.endsWith("draw-b.png"));
	assert.ok(existsSync(join(cwd, ".liyuan-cache", "draw-b.png")), "未选中的 v1 文件应保留在 cache");
});

test("saveSlot 缺省 versionIndex：用 selectedVersionIndex，再缺省最新有效", () => {
	const cwd = tmpCwd();
	makeTwoVersionSlot(cwd);
	// 缺省：最新（v1）→ 保存 draw-b
	const r = saveSlot(cwd, "slot-1");
	assert.ok(r.ok);
	let media = readdirSync(join(cwd, ".liyuan-media"));
	assert.equal(media.length, 1);
	// 再建一个 slot 选 v0 后缺省保存 → 保存 v0
	const cwd2 = tmpCwd();
	makeTwoVersionSlot(cwd2, "slot-x");
	setSelectedVersionIndex(cwd2, "slot-x", 0);
	const r2 = saveSlot(cwd2, "slot-x");
	assert.ok(r2.ok);
	const media2 = readdirSync(join(cwd2, ".liyuan-media"));
	assert.equal(media2.length, 1);
	const store2 = loadSlotStore(cwd2);
	assert.ok(store2.slots["slot-x"]!.versions[0]!.savedAt > 0, "选中 v0 应被保存");
	assert.ok(store2.slots["slot-x"]!.versions[1]!.savedAt === 0, "未选中 v1 不应保存");
});

test("saveSlot：index 越界 → 错误", () => {
	const cwd = tmpCwd();
	makeTwoVersionSlot(cwd);
	assert.ok(!saveSlot(cwd, "slot-1", 9).ok);
});
