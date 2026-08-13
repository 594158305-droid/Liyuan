/**
 * 插件 C「图像存储映射」领域层单测（DESIGN-draw §3.3）：占位符、映射读写、
 * 保存（cache→media 内容寻址迁移）、删除、过期清理、重建、原子写。
 * 运行：node --test test/draw-slot.test.ts
 * 全部用 mkdtempSync 临时目录，不污染仓库。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	appendVersion,
	cleanupExpired,
	createPlaceholder,
	createSlot,
	deleteAllSlots,
	deleteSlot,
	extractSlotIds,
	getSlotInfo,
	listSlotSummaries,
	loadSlotStore,
	saveAllSlots,
	saveSlot,
	saveSlotStoreNow,
	scanMediaDisk,
	slotStorePath,
} from "../src/draw-plugins/draw-slot/slot-store.ts";

// ---------- 工具 ----------

const tmpCwd = (): string => mkdtempSync(join(tmpdir(), "liyuan-slot-"));

/** 造一个假 cache 图片文件（内容可控，便于断言内容寻址命名） */
const makeCacheFile = (cwd: string, name: string, content: string): string => {
	const cacheDir = join(cwd, ".liyuan-cache");
	mkdirSync(cacheDir, { recursive: true });
	const p = join(cacheDir, name);
	writeFileSync(p, content, "utf8");
	return p;
};

/** 造一个假 media 文件 */
const makeMediaFile = (cwd: string, name: string, content: string): string => {
	const mediaDir = join(cwd, ".liyuan-media");
	mkdirSync(mediaDir, { recursive: true });
	const p = join(mediaDir, name);
	writeFileSync(p, content, "utf8");
	return p;
};

// ---------- 1. 占位符 ----------

test("占位符：生成/提取/正则往返", () => {
	assert.equal(createPlaceholder("slot-abc"), "[image:slot-abc]");
	assert.deepEqual(extractSlotIds("正文 [image:a] 和 [image:b] 再 [image:a]"), ["a", "b"]);
	assert.deepEqual(extractSlotIds("无占位符"), []);
	assert.deepEqual(extractSlotIds("[image:bad_slot] 非法字符不入"), []);
});

// ---------- 2. createSlot → 落盘 ----------

test("createSlot：落盘文件存在、结构正确（saved=false、versions[0].file 指向 cache）", async () => {
	const cwd = tmpCwd();
	const cacheFile = makeCacheFile(cwd, "draw-1-abc.png", "img1");
	createSlot(cwd, { slotId: "slot-1", chatId: "chat-1", messageId: "msg-1", file: `.liyuan-cache/${cacheFile.split(/[\\/]/).pop()}` });
	// 防抖 300ms：等落盘
	await new Promise((r) => setTimeout(r, 450));
	const store = loadSlotStore(cwd);
	assert.ok(store.slots["slot-1"], "映射应落盘");
	const e = store.slots["slot-1"];
	assert.equal(e.chatId, "chat-1");
	assert.equal(e.messageId, "msg-1");
	assert.equal(e.versions.length, 1);
	assert.equal(e.versions[0].savedAt, 0);
	assert.equal(e.versions[0].discarded, false);
	assert.ok(e.versions[0].file.endsWith(".png"));
	assert.ok(existsSync(slotStorePath(cwd)), "映射文件存在");
	// cleanup: 移除临时 store（避免防抖写残留）
	saveSlotStoreNow(cwd, { version: 1, slots: {} });
});

// ---------- 3. saveSlot：cache → media ----------

test("saveSlot：cache 文件迁移到 .liyuan-media/（内容寻址）+ savedAt>0 + cache 已删", async () => {
	const cwd = tmpCwd();
	const content = "slot-image-content";
	const cacheRel = "draw-1-def.png";
	makeCacheFile(cwd, cacheRel, content);
	const store = createSlot(cwd, { slotId: "slot-1", chatId: "c", messageId: "m", file: `.liyuan-cache/${cacheRel}` });
	saveSlotStoreNow(cwd, store); // 立即落盘，避免防抖干扰断言
	const r = saveSlot(cwd, "slot-1");
	assert.deepEqual(r, { ok: true });
	const after = loadSlotStore(cwd);
	assert.ok(after.slots["slot-1"].versions[0].savedAt > 0, "savedAt 应更新");
	// cache 文件应已删除
	assert.ok(!existsSync(join(cwd, ".liyuan-cache", cacheRel)), "cache 源文件应删除");
	// media 出现内容寻址文件
	const mediaFiles = readdirSync(join(cwd, ".liyuan-media")).filter((f) => /\.png$/.test(f));
	assert.equal(mediaFiles.length, 1);
	const mediaContent = readFileSync(join(cwd, ".liyuan-media", mediaFiles[0]), "utf8");
	assert.equal(mediaContent, content);
	// 命名 = md5 前 16 位 + .png
	assert.match(mediaFiles[0], /^[0-9a-f]{16}\.png$/);
});

test("saveSlot：slot 不存在 → { ok:false }", () => {
	const cwd = tmpCwd();
	const r = saveSlot(cwd, "no-such");
	assert.equal(r.ok, false);
	assert.ok("error" in r && (r as { error: string }).error.includes("不存在"));
});

// ---------- 4. saveAllSlots / deleteSlot ----------

test("saveAllSlots：全部未保存 slot 转存；deleteSlot 删文件 + 移除映射", async () => {
	const cwd = tmpCwd();
	makeCacheFile(cwd, "draw-a.png", "a");
	makeCacheFile(cwd, "draw-b.png", "b");
	let store = createSlot(cwd, { slotId: "slot-a", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-a.png" });
	store = createSlot(cwd, { slotId: "slot-b", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-b.png" });
	saveSlotStoreNow(cwd, store);
	const r = saveAllSlots(cwd);
	assert.equal(r.saved, 2);
	assert.equal(r.skipped, 0);
	// 已保存后再次 saveAll：全部 skipped（幂等）
	const r2 = saveAllSlots(cwd);
	assert.equal(r2.saved, 0);
	assert.equal(r2.skipped, 2);
	// deleteSlot：删文件 + 移除映射
	const removed = deleteSlot(cwd, "slot-a");
	assert.equal(removed, 1); // 只删 media 文件（cache 已被 saveSlot 删）
	assert.ok(!loadSlotStore(cwd).slots["slot-a"], "映射应移除");
	assert.ok(loadSlotStore(cwd).slots["slot-b"], "另一 slot 保留");
});

// 回归：旧数据 file 以 /cache/（前导斜杠、无点）开头——解析缺一个点会落到 cache/ 目录，
// 误报「文件不存在」导致保存/删除/清理整批失败（修复：resolveSlotAbs 统一解析）
test("saveSlot/deleteSlot：旧式 /cache/ 前缀 file 也能正确解析保存", async () => {
	const cwd = tmpCwd();
	makeCacheFile(cwd, "draw-old.png", "old-img");
	const store = createSlot(cwd, { slotId: "slot-old", chatId: "c", messageId: "m", file: "/cache/draw-old.png" });
	saveSlotStoreNow(cwd, store);
	const r = saveSlot(cwd, "slot-old");
	assert.deepEqual(r, { ok: true }, "旧式 /cache/ 前缀应保存成功");
	const after = loadSlotStore(cwd);
	assert.ok(after.slots["slot-old"].versions[0].savedAt > 0, "savedAt 应更新");
	assert.ok(!existsSync(join(cwd, ".liyuan-cache", "draw-old.png")), "cache 源文件应删除");
	// deleteSlot 同前缀：media 文件应被删
	makeMediaFile(cwd, "oldmedia.png", "m");
	createSlot(cwd, { slotId: "slot-old2", chatId: "c", messageId: "m", file: "/media/oldmedia.png" });
	const removed = deleteSlot(cwd, "slot-old2");
	assert.equal(removed, 1, "旧式 /media/ 前缀文件应被删");
});

// ---------- 5. cleanupExpired ----------

test("cleanupExpired：retentionDays=0 未保存 slot 被清、已保存不受影响", async () => {
	const cwd = tmpCwd();
	makeCacheFile(cwd, "draw-x.png", "x");
	makeCacheFile(cwd, "draw-y.png", "y");
	let store = createSlot(cwd, { slotId: "slot-x", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-x.png" });
	store = createSlot(cwd, { slotId: "slot-y", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-y.png" });
	saveSlotStoreNow(cwd, store);
	// 先保存 slot-x（已保存应不受清理影响）
	saveSlot(cwd, "slot-x");
	// slot-y 保持未保存，retention=0 → 应被清
	const r = cleanupExpired(cwd, 0);
	assert.equal(r.removedSlots, 1);
	const after = loadSlotStore(cwd);
	assert.ok(after.slots["slot-x"], "已保存 slot 保留");
	assert.ok(!after.slots["slot-y"], "未保存 slot 被清");
	// cache-y 文件被删、cache-x 的 media 保留
	assert.ok(!existsSync(join(cwd, ".liyuan-cache", "draw-y.png")), "未保存 cache 文件应删除");
});

test("cleanupExpired：discarded 版本超期被清，当前版本保留", async () => {
	const cwd = tmpCwd();
	makeCacheFile(cwd, "draw-v1.png", "v1");
	const store0 = createSlot(cwd, { slotId: "slot-1", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-v1.png" });
	// 追加第二个版本（不 discarded）
	makeCacheFile(cwd, "draw-v2.png", "v2");
	const store1 = appendVersion(cwd, "slot-1", { file: ".liyuan-cache/draw-v2.png" });
	// 手动把第一个版本标记为 discarded 且已保存很久（超期）
	const entry = store1.slots["slot-1"];
	entry.versions[0] = { ...entry.versions[0], savedAt: 1, discarded: true };
	saveSlotStoreNow(cwd, store1);
	// 未保存整体清理会清掉整个 slot（因为当前版本未保存）——先保存 slot 让当前版本保留
	saveSlot(cwd, "slot-1");
	// 现在 v1 discarded+savedAt=1（超期），v2 已保存
	const r = cleanupExpired(cwd, 0);
	assert.equal(r.removedSlots, 0);
	const after = loadSlotStore(cwd);
	assert.equal(after.slots["slot-1"].versions.length, 1, "超期 discarded 版本被移除");
	assert.equal(after.slots["slot-1"].versions[0].discarded, false);
});

// ---------- 6. 重建（rebuild 的领域部分：提取/孤儿登记） ----------

test("scanMediaDisk：孤儿文件统计（有文件无映射）", async () => {
	const cwd = tmpCwd();
	makeMediaFile(cwd, "aaaaaaaaaaaaaaaa.png", "orphan");
	makeMediaFile(cwd, "bbbbbbbbbbbbbbbb.png", "orphan2");
	// 登记一个已保存 slot 引用同名文件
	let store = createSlot(cwd, { slotId: "slot-ref", chatId: "c", messageId: "m", file: ".liyuan-media/aaaaaaaaaaaaaaaa.png", params: {} });
	store.slots["slot-ref"].versions[0] = { ...store.slots["slot-ref"].versions[0], savedAt: 1 };
	saveSlotStoreNow(cwd, store);
	const { files, orphanFiles } = scanMediaDisk(cwd);
	assert.equal(files.length, 2);
	assert.deepEqual(orphanFiles, ["bbbbbbbbbbbbbbbb.png"]);
});

// ---------- 7. 原子写 ----------

test("saveSlotStoreNow：立即写盘且文件合法可读", async () => {
	const cwd = tmpCwd();
	// 直接用 createSlot 返回的 store 落盘（防抖 pending 尚未写盘，不能从磁盘重读）
	const store = createSlot(cwd, { slotId: "slot-1", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-1.png" });
	saveSlotStoreNow(cwd, store);
	await new Promise((r) => setTimeout(r, 50));
	const parsed = JSON.parse(readFileSync(slotStorePath(cwd), "utf8"));
	assert.equal(parsed.version, 1);
	assert.ok(parsed.slots["slot-1"]);
	assert.ok(!existsSync(`${slotStorePath(cwd)}.tmp`), "无残留 tmp 文件");
});

// ---------- 8. getSlotInfo ----------

test("getSlotInfo：未保存返回 cache 前缀 src + saved=false；不存在返回 null", async () => {
	const cwd = tmpCwd();
	const store = createSlot(cwd, { slotId: "slot-1", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-1.png" });
	saveSlotStoreNow(cwd, store);
	const info = getSlotInfo(cwd, "slot-1");
	assert.ok(info);
	assert.equal(info!.saved, false);
	assert.equal(info!.src, "/cache/draw-1.png");
	assert.equal(info!.versionCount, 1);
	assert.equal(getSlotInfo(cwd, "nope"), null);
});

// ---------- 9. failed 状态（批次 2/3：失败占位符） ----------

test("failed：createSlot/appendVersion 落 failed；getSlotInfo 透出 failed/hasFailed + 版本视图", async () => {
	const cwd = tmpCwd();
	const store = createSlot(cwd, {
		slotId: "slot-fail",
		chatId: "c",
		messageId: "m",
		file: "",
		failed: { reason: "额度不足" }, // code 缺省 → unknown
	});
	saveSlotStoreNow(cwd, store);
	// appendVersion 带 failed（code 显式）
	makeCacheFile(cwd, "draw-ok.png", "ok");
	appendVersion(cwd, "slot-fail", { file: ".liyuan-cache/draw-ok.png", failed: { code: "quota", reason: "anlas" } });
	await new Promise((r) => setTimeout(r, 400));
	const info = getSlotInfo(cwd, "slot-fail");
	assert.ok(info);
	assert.ok(info!.hasFailed, "任一版本 failed → hasFailed");
	assert.equal(info!.versions.length, 2);
	assert.deepEqual(info!.versions[0].failed, { code: "unknown", reason: "额度不足" });
	assert.deepEqual(info!.versions[1].failed, { code: "quota", reason: "anlas" });
	// 当前生效版本 = 最后一个非 discarded（versions[1]，带 failed）→ 顶层 failed 透出
	assert.deepEqual(info!.failed, { code: "quota", reason: "anlas" });
	// 空串 file → src 空（失败占位无文件）
	assert.equal(getSlotInfo(cwd, "slot-fail")!.versions[0].src, "");
	// listSlotSummaries 也透出 failed/hasFailed
	const sum = listSlotSummaries(cwd).find((s) => s.slotId === "slot-fail");
	assert.ok(sum?.hasFailed);
	assert.deepEqual(sum?.failed, { code: "quota", reason: "anlas" });
});

test("failed：appendVersion 不带 failed 的版本不产生 failed；loadSlotStore 容错旧数据", async () => {
	const cwd = tmpCwd();
	makeCacheFile(cwd, "draw-v1.png", "v1");
	const store = createSlot(cwd, { slotId: "slot-1", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-v1.png" });
	saveSlotStoreNow(cwd, store);
	const info = getSlotInfo(cwd, "slot-1");
	assert.equal(info!.hasFailed, undefined);
	assert.equal(info!.versions[0].failed, undefined);
	// 直接写一份无 failed 字段的旧 store 文件 → 正常读
	mkdirSync(dirname(slotStorePath(cwd)), { recursive: true });
	writeFileSync(
		slotStorePath(cwd),
		JSON.stringify({
			version: 1,
			slots: {
				old: {
					chatId: "c",
					messageId: "m",
					createdAt: 1,
					versions: [{ file: ".liyuan-cache/draw-old.png", params: {}, savedAt: 0, discarded: false }],
				},
			},
		}),
	);
	const loaded = loadSlotStore(cwd);
	assert.equal(loaded.slots["old"].versions.length, 1);
	assert.equal(loaded.slots["old"].versions[0].failed, undefined);
});

// ---------- 10. deleteAllSlots ----------

test("deleteAllSlots：删除全部 slot（含文件），返回删除的 slot 数", async () => {
	const cwd = tmpCwd();
	makeCacheFile(cwd, "draw-a.png", "a");
	makeCacheFile(cwd, "draw-b.png", "b");
	let store = createSlot(cwd, { slotId: "s1", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-a.png" });
	store = createSlot(cwd, { slotId: "s2", chatId: "c", messageId: "m", file: ".liyuan-cache/draw-b.png" });
	saveSlotStoreNow(cwd, store);
	assert.equal(Object.keys(loadSlotStore(cwd).slots).length, 2);
	const n = deleteAllSlots(cwd);
	assert.equal(n, 2);
	assert.equal(Object.keys(loadSlotStore(cwd).slots).length, 0);
	// cache 文件已删
	assert.ok(!existsSync(join(cwd, ".liyuan-cache", "draw-a.png")));
	assert.ok(!existsSync(join(cwd, ".liyuan-cache", "draw-b.png")));
	// 空 store：返回 0
	assert.equal(deleteAllSlots(cwd), 0);
});
