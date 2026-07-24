import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryScopeId } from "../src/memory/config.ts";
import { cosine, embedTextLocal } from "../src/memory/embed.ts";
import {
	getMemoryStatus,
	memoryDeleteChunk,
	memoryImportText,
	memoryListChunks,
	memoryManualAdd,
	memoryRecallForTurn,
	memoryReembedScope,
	memorySearch,
	onNarrativeTurnEnd,
	updateMemoryConfig,
	updateStoreConfig,
} from "../src/memory/service.ts";
import { loadChunks, splitTextChunks } from "../src/memory/store.ts";

const scopeA = { sessionId: "sess-a", card: "assets/cards/hero.png" };
const scopeB = { sessionId: "sess-b", card: "assets/cards/hero.png" };
const scopeOtherCard = { sessionId: "sess-a", card: "assets/cards/other.png" };

test("embed local: 相似文本余弦更高", () => {
	const a = embedTextLocal("主角在圣魂村觉醒了镜子武魂");
	const b = embedTextLocal("陈默于圣魂村觉醒武魂，是一面镜子");
	const c = embedTextLocal("今天天气真好适合去海边游泳");
	assert.ok(cosine(a, b) > cosine(a, c));
});

test("splitTextChunks: 长文切开", () => {
	const parts = splitTextChunks("甲".repeat(1000), 300);
	assert.ok(parts.length >= 3);
});

test("memoryScopeId: 不同卡或不同会话 → 不同 id", () => {
	assert.notEqual(memoryScopeId(scopeA), memoryScopeId(scopeB));
	assert.notEqual(memoryScopeId(scopeA), memoryScopeId(scopeOtherCard));
	assert.equal(memoryScopeId(scopeA), memoryScopeId({ ...scopeA, card: "ASSETS/cards/hero.png" }));
});

test("memory: 默认库名 剧情/额外", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mem-name-"));
	try {
		const st = getMemoryStatus(cwd, scopeA);
		assert.equal(st.stores.find((s) => s.id === "narrative")?.name, "剧情数据库");
		assert.equal(st.stores.find((s) => s.id === "external")?.name, "额外数据库");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("memory: 额外库导入检索", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mem-"));
	try {
		updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
		updateStoreConfig(cwd, "external", { enabled: true });
		const imp = await memoryImportText(
			cwd,
			scopeA,
			"external",
			"第一章\n\n少年在山中修炼，习得吐纳之法。\n\n第二章\n\n他遇到了青梧仙子，约定三年后再见。",
			"demo.txt",
		);
		assert.ok(imp.added >= 1);
		const hits = await memorySearch(cwd, scopeA, "external", "青梧仙子 三年", 3);
		assert.ok(hits.length >= 1);
		assert.ok(hits[0]!.text.includes("青梧") || hits.some((h) => h.text.includes("青梧")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("memory: 禁止向剧情库导入", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mem-ban-"));
	try {
		updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
		await assert.rejects(
			() => memoryImportText(cwd, scopeA, "narrative", "不该写入剧情库的内容足够长", "x.txt"),
			/剧情数据库|不能手动/,
		);
		await assert.rejects(
			() => memoryManualAdd(cwd, scopeA, "手动也不该进剧情库的一段话", { storeId: "narrative" }),
			/剧情数据库|不能手动/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("memory: 剧情合并入库不每轮一条", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mem-n-"));
	try {
		updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
		updateStoreConfig(cwd, "narrative", { enabled: true, everyNTurns: 1 });
		const t1 = await onNarrativeTurnEnd(
			cwd,
			scopeA,
			"第一轮正文内容足够长用于入库测试：青梧在谷口等候旅人归来。",
		);
		assert.equal(t1.stored, true);
		assert.equal(t1.merged, false); // 首条
		const t2 = await onNarrativeTurnEnd(
			cwd,
			scopeA,
			"第二轮正文：旅人递上玉佩，两人约定三年后再见于青梧谷。",
		);
		assert.equal(t2.stored, true);
		assert.equal(t2.merged, true); // 并入上一条
		const chunks = loadChunks(cwd, scopeA, "narrative");
		assert.equal(chunks.length, 1, "两次应仍只有 1 条（合并）");
		assert.ok(chunks[0]!.text.includes("青梧"));
		assert.ok(chunks[0]!.text.includes("玉佩"));
		assert.ok((chunks[0]!.meta.mergeCount ?? 0) >= 2);

		// 另一会话看不到
		const hitsB = await memorySearch(cwd, scopeB, "narrative", "青梧 玉佩", 3);
		assert.equal(hitsB.length, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("memory: 手动写入额外库 + 列表 + 删除单条", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mem-man-"));
	try {
		updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
		updateStoreConfig(cwd, "external", { enabled: true });
		const a = await memoryManualAdd(cwd, scopeA, "设定A：青梧仙子掌管谷中灵泉与千年古树。", {
			title: "设定A",
		});
		assert.ok(a.added >= 1);
		const b = await memoryManualAdd(cwd, scopeA, "设定B：魔尊九重封印埋在黑渊底层。", { title: "设定B" });
		assert.ok(b.added >= 1);
		const list = memoryListChunks(cwd, scopeA, "external");
		assert.ok(list.length >= 2);
		const id = list[0]!.id;
		assert.equal(memoryDeleteChunk(cwd, scopeA, "external", id), true);
		const list2 = memoryListChunks(cwd, scopeA, "external");
		assert.equal(list2.length, list.length - 1);
		assert.ok(!list2.some((c) => c.id === id));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("memory: recallForTurn 受 injectOnTurn 控制", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mem-r-"));
	try {
		updateMemoryConfig(cwd, { enabled: true, injectOnTurn: true, searchTopK: 3, embedMode: "local" });
		updateStoreConfig(cwd, "narrative", { enabled: true, everyNTurns: 1 });
		await onNarrativeTurnEnd(cwd, scopeA, "青梧在月下承诺永不离开旅人，并将玉佩相赠作为信物");
		const hits = await memoryRecallForTurn(cwd, scopeA, "青梧 玉佩 承诺");
		assert.ok(hits.length >= 1);
		updateMemoryConfig(cwd, { injectOnTurn: false });
		assert.equal((await memoryRecallForTurn(cwd, scopeA, "青梧 玉佩")).length, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("memory: 配置云端字段不落明文到 public", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mem-c-"));
	try {
		updateMemoryConfig(cwd, {
			enabled: true,
			embedMode: "cloud",
			cloudEmbed: {
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-secret-test",
				model: "text-embedding-3-small",
			},
		});
		const pub = getMemoryStatus(cwd, scopeA).config;
		assert.equal(pub.embedMode, "cloud");
		assert.equal(pub.cloudEmbedConfigured, true);
		assert.ok(pub.cloudEmbed.apiKey.includes("•") || pub.cloudEmbed.apiKey === "");
		assert.ok(!pub.cloudEmbed.apiKey.includes("sk-secret"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("memory: 重向量化保留原文", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mem-re-"));
	try {
		updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
		updateStoreConfig(cwd, "external", { enabled: true });
		await memoryImportText(
			cwd,
			scopeA,
			"external",
			"重向量化测试：青梧在月下把玉佩交给旅人，约好三年后于青梧谷再见。",
			"re.txt",
		);
		const before = loadChunks(cwd, scopeA, "external");
		assert.ok(before.length >= 1);
		const text0 = before[0]!.text;
		const r = await memoryReembedScope(cwd, scopeA);
		assert.ok(r.totalUpdated >= 1);
		const after = loadChunks(cwd, scopeA, "external");
		assert.equal(after[0]!.text, text0);
		assert.equal(after[0]!.meta.embedMode, "local");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
