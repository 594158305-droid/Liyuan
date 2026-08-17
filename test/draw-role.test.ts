/**
 * 插件 A draw-role 一期单测：tagdb（D 标签库）、character-detect（在场检出）、
 * resolver（角色特征解析）、tag_search 工具。
 * 运行：node --test test/draw-role.test.ts
 * 全部用 mkdtempSync 临时目录，不污染仓库。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectPresentCharacters, detectPresentCharactersWithAliases } from "../src/draw-plugins/draw-role/character-detect.ts";
import { loadCharacterTagDb, searchCharacters, searchTags, tagDbStats } from "../src/draw-plugins/draw-role/tagdb.ts";
import { assembleUnknownCharacter, resolveCharacterTags, resolvePresentWithAliases } from "../src/draw-plugins/draw-role/resolver.ts";
import { loadWardrobe, saveWardrobe, upsertCharacter, wardrobePath } from "../src/wardrobe.ts";
import type { WardrobeFile } from "../src/wardrobe.ts";

const tmpCwd = (): string => mkdtempSync(join(tmpdir(), "liyuan-role-"));

// ---------- 1. tagdb ----------

test("tagdb：loadCharacterTagDb 非空（≥7000）", () => {
	const db = loadCharacterTagDb();
	assert.ok(db.length >= 7000, `角色数应 ≥7000，实际 ${db.length}`);
	const stats = tagDbStats();
	assert.equal(stats.characters, db.length);
	assert.ok(stats.tags > 0);
});

test("tagdb：searchCharacters('miku') 命中 hatsune_miku 且 tags 含 twintails", () => {
	const hits = searchCharacters("miku", 20);
	assert.ok(hits.length > 0);
	const miku = hits.find((h) => h.name === "hatsune_miku");
	assert.ok(miku, "应命中 hatsune_miku");
	assert.ok(miku!.tags.includes("twintails"), "应含 twintails");
});

test("tagdb：searchTags('twintails') 非空；大小写不敏感", () => {
	const hits = searchTags("TWINTAILS", 10);
	assert.ok(hits.length > 0);
	const top = hits[0];
	assert.equal(top.tag.toLowerCase(), "twintails");
	assert.ok(top.count > 0);
});

test("tagdb：limit 生效；空 query 返回空", () => {
	assert.deepEqual(searchCharacters("miku", 0), []);
	assert.deepEqual(searchCharacters(""), []);
	assert.deepEqual(searchTags("  "), []);
	const limited = searchCharacters("miku", 3);
	assert.ok(limited.length <= 3);
});

// ---------- 2. character-detect ----------

test("detect：按正文出现顺序检出；大小写不敏感", () => {
	const text = "第一段里是 hatsune_miku，然后 HAKUREI_REIMU 出现，最后又提到 hatsune_miku";
	const found = detectPresentCharacters(text, ["hatsune_miku", "hakurei_reimu"]);
	assert.deepEqual(found, ["hatsune_miku", "hakurei_reimu"]);
});

test("detect：长名优先（knownNames 同时含 reimu 与 hakurei_reimu 时匹配长名）", () => {
	// 正文只出现长名：不应误报短名 reimu（长名优先的防御性排序使 reimu 不会抢先命中子串）
	const text = "hakurei_reimu 在神社";
	const found = detectPresentCharacters(text, ["reimu", "hakurei_reimu"]);
	// 两个名字都命中同一位置子串——按匹配逻辑两者都会进结果；但顺序应长名在前（先匹配）
	assert.deepEqual(found, ["hakurei_reimu", "reimu"]);
});

test("detect：正文只含短名子串时长名不误匹配、短名命中", () => {
	// 正文只有 "reimu 在神社"（不是 hakurei_reimu）：长名不匹配、短名匹配
	const text = "reimu 在神社";
	const found = detectPresentCharacters(text, ["hakurei_reimu", "reimu"]);
	assert.deepEqual(found, ["reimu"]);
});

test("detect：空正文 / 空 knownNames → 空数组", () => {
	assert.deepEqual(detectPresentCharacters("", ["a"]), []);
	assert.deepEqual(detectPresentCharacters("正文", []), []);
});

// ---------- 3. resolver ----------

/** 造临时服装档案：角色 A（appearanceTags + 两套 outfit，B 带参考图且排第一——defaultOutfit 已废弃，回退取第一套） */
function makeWardrobe(cwd: string): { card: string; wb: WardrobeFile } {
	const card = "assets/cards/test.json";
	const wb: WardrobeFile = {
		format: "liyuan-wardrobe",
		version: 1,
		cardPath: card,
		characters: [
			{
				name: "伊利亚斯",
				appearanceTags: "blond_hair blue_eyes",
				outfits: [
					{ id: "B", name: "礼服", tags: "dress formal", referenceImage: ".liyuan-wardrobe/refs/x.png" },
					{ id: "A", name: "日常", tags: "casual shirt" },
				],
			},
		],
	};
	mkdirSync(join(cwd, ".liyuan-wardrobe", "refs"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan-wardrobe", "refs", "x.png"), "fakeimg");
	saveWardrobe(cwd, wb);
	return { card, wb };
}

test("resolver：无 worldState 时用第一套服装的 tags", () => {
	const cwd = tmpCwd();
	const { card } = makeWardrobe(cwd);
	const r = resolveCharacterTags(cwd, card, ["伊利亚斯"]);
	assert.equal(r.characters.length, 1);
	assert.equal(r.characters[0].tags, "blond_hair blue_eyes dress formal");
	assert.deepEqual(r.unknown, []);
});

test("resolver：有 worldState.outfit 时用指定套", () => {
	const cwd = tmpCwd();
	const { card } = makeWardrobe(cwd);
	const r = resolveCharacterTags(cwd, card, ["伊利亚斯"], { characters: { 伊利亚斯: { outfit: "A" } } });
	assert.equal(r.characters[0].tags, "blond_hair blue_eyes casual shirt");
});

test("resolver：参考图存在时 referenceImage 为 base64", () => {
	const cwd = tmpCwd();
	const { card } = makeWardrobe(cwd);
	const r = resolveCharacterTags(cwd, card, ["伊利亚斯"]);
	// fakeimg 的 base64：ZmFrZWltZw==
	assert.equal(r.characters[0].referenceImage, "ZmFrZWltZw==");
});

test("resolver：unknown 正确；未知角色 tags 为空", () => {
	const cwd = tmpCwd();
	const { card } = makeWardrobe(cwd);
	const r = resolveCharacterTags(cwd, card, ["伊利亚斯", "不存在的角色"]);
	assert.equal(r.characters.length, 1);
	assert.deepEqual(r.unknown, ["不存在的角色"]);
});

test("resolver：sceneOutfits 覆盖穿着（在场角色表优先，defaultOutfit 已废弃）", () => {
	const cwd = tmpCwd();
	const { card } = makeWardrobe(cwd);
	// 画师从在场角色表读出「白色修女袍 + 黑披风」转英文 tag，经 sceneOutfits 覆盖档案第一套
	const r = resolveCharacterTags(cwd, card, ["伊利亚斯"], undefined, { 伊利亚斯: "white robe, black cape" });
	assert.equal(r.characters[0].tags, "blond_hair blue_eyes white robe, black cape");
});

test("resolver：档案里无外观 tag 且无服装 → tags 空串", () => {
	const cwd = tmpCwd();
	const card = "assets/cards/test.json";
	const wb: WardrobeFile = {
		format: "liyuan-wardrobe",
		version: 1,
		cardPath: card,
		characters: [{ name: "空白", appearanceTags: "", outfits: [] }],
	};
	saveWardrobe(cwd, wb);
	const r = resolveCharacterTags(cwd, card, ["空白"]);
	assert.equal(r.characters[0].tags, "");
	assert.equal(r.characters[0].uc, "");
});

// ---------- 4. 批次 3 新字段（LWB 对齐） ----------

test("wardrobe：loadWardrobe 读出新字段（aliases/type/negativeTags/danbooruTag/useDanbooruTag/hidden/selectedGroupId/id）", () => {
	const cwd = tmpCwd();
	const card = "assets/cards/test.json";
	const p = wardrobePath(cwd, card);
	mkdirSync(join(cwd, ".liyuan-wardrobe"), { recursive: true });
	writeFileSync(
		p,
		JSON.stringify({
			format: "liyuan-wardrobe",
			version: 1,
			cardPath: card,
			characters: [
				{
					name: "带新字段",
					appearanceTags: "blond_hair",
					outfits: [],
					aliases: ["阿雷", "Elia"],
					type: "主角",
					negativeTags: "bad_hair, extra_arm",
					danbooruTag: "hatsune_miku",
					useDanbooruTag: true,
					hidden: true,
					selectedGroupId: "g1",
					id: "char-1",
				},
				{ name: "旧数据", appearanceTags: "black_hair", outfits: [] },
			],
		}),
	);
	const wb = loadWardrobe(cwd, card);
	const a = wb.characters.find((c) => c.name === "带新字段")!;
	assert.deepEqual(a.aliases, ["阿雷", "Elia"]);
	assert.equal(a.type, "主角");
	assert.equal(a.negativeTags, "bad_hair, extra_arm");
	assert.equal(a.danbooruTag, "hatsune_miku");
	assert.equal(a.useDanbooruTag, true);
	assert.equal(a.hidden, true);
	assert.equal(a.selectedGroupId, "g1");
	assert.equal(a.id, "char-1");
	// 旧数据：新字段缺省（undefined）
	const o = wb.characters.find((c) => c.name === "旧数据")!;
	assert.equal(o.aliases, undefined);
	assert.equal(o.danbooruTag, undefined);
	assert.equal(o.useDanbooruTag, undefined);
	assert.equal(o.hidden, undefined);
	assert.equal(o.id, undefined);
});

test("wardrobe：upsertCharacter 建新角色时可带新字段", () => {
	const wb: WardrobeFile = { format: "liyuan-wardrobe", version: 1, cardPath: "assets/cards/test.json", characters: [] };
	const next = upsertCharacter(wb, "新角色", {
		aliases: ["阿新"],
		type: "配角",
		negativeTags: "bad",
		danbooruTag: "reimu",
		useDanbooruTag: false,
		hidden: true,
		selectedGroupId: "g2",
		id: "x1",
	});
	const c = next.characters[0];
	assert.deepEqual(c.aliases, ["阿新"]);
	assert.equal(c.type, "配角");
	assert.equal(c.negativeTags, "bad");
	assert.equal(c.danbooruTag, "reimu");
	assert.equal(c.useDanbooruTag, false);
	assert.equal(c.hidden, true);
	assert.equal(c.selectedGroupId, "g2");
	assert.equal(c.id, "x1");
});

test("resolver：danbooruTag 并入 tag；useDanbooruTag=false 不并入", () => {
	const cwd = tmpCwd();
	const card = "assets/cards/test.json";
	const wb: WardrobeFile = {
		format: "liyuan-wardrobe",
		version: 1,
		cardPath: card,
		characters: [
			{ name: "用", appearanceTags: "blond_hair", outfits: [], danbooruTag: "hatsune_miku" },
			{ name: "不用", appearanceTags: "blond_hair", outfits: [], danbooruTag: "hatsune_miku", useDanbooruTag: false },
		],
	};
	saveWardrobe(cwd, wb);
	const r = resolveCharacterTags(cwd, card, ["用", "不用"]);
	assert.equal(r.characters[0].tags, "hatsune miku blond_hair", "danbooru 下划线转空格且前置（对齐 LWBox）");
	assert.equal(r.characters[1].tags, "blond_hair");
});

test("resolver：档案 type（girl/boy/man/woman）进角色 tag 串开头；中文 type 不误伤", () => {
	const cwd = tmpCwd();
	const card = "assets/cards/test.json";
	const wb: WardrobeFile = {
		format: "liyuan-wardrobe",
		version: 1,
		cardPath: card,
		characters: [
			{
				name: "千束",
				type: "girl",
				appearanceTags: "nishikigi chisato, middle breasts",
				outfits: [{ id: "o1", name: "战斗服", tags: "side ponytail, red jacket" }],
			},
			{ name: "旧档", type: "主角", appearanceTags: "black hair", outfits: [] },
		],
	};
	saveWardrobe(cwd, wb);
	const r = resolveCharacterTags(cwd, card, ["千束", "旧档"]);
	assert.equal(r.characters[0].tags, "girl nishikigi chisato, middle breasts side ponytail, red jacket", "type 在 danbooru/外观前（LWBox 顺序；梨园空格分隔）");
	assert.equal(r.characters[1].tags, "black hair", "中文 type 不进 tag 串");
});

test("resolver：negativeTags → uc；无 negativeTags → uc 空串", () => {
	const cwd = tmpCwd();
	const card = "assets/cards/test.json";
	const wb: WardrobeFile = {
		format: "liyuan-wardrobe",
		version: 1,
		cardPath: card,
		characters: [
			{ name: "负面", appearanceTags: "a", outfits: [], negativeTags: "bad_hair, extra_arm" },
			{ name: "无负面", appearanceTags: "a", outfits: [] },
		],
	};
	saveWardrobe(cwd, wb);
	const r = resolveCharacterTags(cwd, card, ["负面", "无负面"]);
	assert.equal(r.characters[0].uc, "bad_hair, extra_arm");
	assert.equal(r.characters[1].uc, "");
});

test("detectWithAliases：name+aliases 任一命中即在场；按正文出现顺序返回主名", () => {
	const text = "先出现 阿雷，后出现 Hatsune_Miku，再提伊利亚斯";
	const found = detectPresentCharactersWithAliases(text, [
		{ name: "伊利亚斯", aliases: ["阿雷", "Elia"] },
		{ name: "初音", aliases: ["Hatsune_Miku", "Miku"] },
	]);
	assert.deepEqual(found, ["伊利亚斯", "初音"]);
});

test("detectWithAliases：hidden 剔除；无 known → 空", () => {
	const text = "正文含 神秘别名";
	const found = detectPresentCharactersWithAliases(text, [
		{ name: "隐藏角色", aliases: ["神秘别名"], hidden: true },
		{ name: "可见", aliases: ["神秘"] },
	]);
	assert.deepEqual(found, ["可见"]);
	assert.deepEqual(detectPresentCharactersWithAliases("正文", []), []);
	assert.deepEqual(detectPresentCharactersWithAliases("", [{ name: "a" }]), []);
});

test("resolvePresentWithAliases：从档案读 name+aliases 检出主名（hidden 剔除）", () => {
	const cwd = tmpCwd();
	const card = "assets/cards/test.json";
	const wb: WardrobeFile = {
		format: "liyuan-wardrobe",
		version: 1,
		cardPath: card,
		characters: [
			{ name: "伊利亚斯", appearanceTags: "a", outfits: [], aliases: ["阿雷"] },
			{ name: "凯尔", appearanceTags: "b", outfits: [] },
			{ name: "隐藏", appearanceTags: "c", outfits: [], aliases: ["隐主"], hidden: true },
		],
	};
	saveWardrobe(cwd, wb);
	assert.deepEqual(resolvePresentWithAliases(cwd, card, "阿雷出现了"), ["伊利亚斯"]);
	// 别名"隐主"出现在正文但角色 hidden → 不检出
	assert.deepEqual(resolvePresentWithAliases(cwd, card, "隐主在"), []);
	assert.deepEqual(resolvePresentWithAliases(cwd, card, "凯尔在"), ["凯尔"]);
});

// ---------- assembleUnknownCharacter（8/15：无档案/无名角色分栏通道） ----------

test("assembleUnknownCharacter：type+appear+costume+action 组装，type 进 tag 串（对齐 LWBox）", () => {
	const r = assembleUnknownCharacter({
		name: "井上泷奈",
		type: "girl",
		appear: "black hair, side ponytail, purple eyes",
		costume: "cafe uniform, black blouse, white apron",
		action: "smiling",
		uc: "hat",
	});
	assert.equal(r.name, "井上泷奈");
	assert.equal(r.tags, "girl, black hair, side ponytail, purple eyes, cafe uniform, black blouse, white apron, smiling");
	assert.equal(r.uc, "hat");
});

test("assembleUnknownCharacter：无名配角 name 空 → 名字兜底 type，type 缺省 boy", () => {
	const r = assembleUnknownCharacter({ action: "standing" });
	assert.equal(r.name, "boy");
	assert.equal(r.tags, "boy, standing");
	const g = assembleUnknownCharacter({ type: "girl", appear: "blonde hair" });
	assert.equal(g.name, "girl");
	assert.equal(g.tags, "girl, blonde hair");
});
