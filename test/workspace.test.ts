import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyDraftRules } from "../src/draft.ts";
import { defaultState } from "../src/state.ts";
import {
	createWorkspace,
	projectedState,
	runWriteTool,
	type WorkspaceDeps,
} from "../src/stage/workspace.ts";
import { writeTools } from "../src/stage/tools.ts";

const deps = (): WorkspaceDeps => ({
	rules: emptyDraftRules(),
	userName: "凌云",
	charName: "林霜",
	baseState: defaultState(),
});

test("writeTools：写侧八件在清单里，两种落笔写法并列、draft_edit 声明批量原子", () => {
	const names = writeTools("中文").map((t) => t.name);
	assert.deepEqual(names, [
		"draft_write",
		"draft_append",
		"draft_seal",
		"draft_edit",
		"draft_read",
		"draft_search",
		"draft_check",
		"world_state_update",
	]);
	const byName = new Map(writeTools("中文").map((t) => [t.name, t.description]));
	assert.match(byName.get("draft_write") ?? "", /全量/);
	assert.match(byName.get("draft_append") ?? "", /追加|续写/);
	assert.match(byName.get("draft_seal") ?? "", /封笔/);
	assert.match(byName.get("draft_edit") ?? "", /整批不套用/);
});

test("draft_write：收稿落工作区并自动验收；空 content 拒收", () => {
	const ws = createWorkspace();
	const d = deps();
	const bad = runWriteTool(ws, d, "draft_write", { content: "  " });
	assert.equal(bad.ok, false);
	assert.equal(ws.writes, 0);

	const r = runWriteTool(ws, d, "draft_write", { content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "山门外的雪落了一夜。");
	assert.equal(ws.writes, 1);
	assert.equal(ws.checks, 1); // 收稿即验，省一轮往返
	assert.match(r.text, /已收稿（第 1 稿/);
});

// ---------------- M-E：draft_append / draft_seal（分段续写） ----------------

const minRules = (): WorkspaceDeps => ({
	...deps(),
	rules: { ...emptyDraftRules(), wordRange: { min: 800, max: 2000 } },
});

test("draft_append：追加不覆盖；未封笔时字数不算违规，封笔后按完整稿验收", () => {
	const ws = createWorkspace();
	const d = minRules();
	// 第一段只有 300 字——若按完整稿 800 字下限判，必违规；但这是分段续写的第一段
	const r1 = runWriteTool(ws, d, "draft_append", { segment: "山门外雪落了一夜。他推门进屋，炉火将熄。" });
	assert.equal(r1.ok, true);
	assert.equal(ws.draft, "山门外雪落了一夜。他推门进屋，炉火将熄。");
	assert.equal(ws.appends, 1);
	assert.equal(ws.sealed, false);
	assert.doesNotMatch(r1.text, /违规/); // 未封笔：字数不算违规
	assert.match(r1.text, /续写中/);
	// 追加第二段：不覆盖，续在末尾
	runWriteTool(ws, d, "draft_append", { segment: "她还在窗边坐着，像在等什么。" });
	assert.ok(ws.draft.includes("山门外雪落了一夜。"));
	assert.ok(ws.draft.includes("她还在窗边坐着"));
	assert.equal(ws.appends, 2);
	// 未封笔时 lastGreen 恒 false（谢幕判定：稿子还没写完，不算完成）
	assert.equal(ws.lastGreen, false);
	// 封笔：按完整稿验收（这里字数仍不足 800 → 会判违规）
	const r3 = runWriteTool(ws, d, "draft_seal", {});
	assert.equal(ws.sealed, true);
	assert.match(r3.text, /已封笔/);
});

test("draft_append：追加进时间线是追加段（draft=true），不塌成替换", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "第一段。" });
	runWriteTool(ws, d, "draft_append", { segment: "第二段。" });
	const draftSegs = ws.timeline.filter((s) => s.kind === "text" && s.draft === true);
	assert.equal(draftSegs.length, 2, "两段续写应为两个独立稿段");
	assert.equal((draftSegs[0] as { text: string }).text, "第一段。");
	assert.equal((draftSegs[1] as { text: string }).text, "第二段。");
});

test("draft_append：续写后 draft_edit 改一处，时间线保持分段不塌成一整块", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "山门外的雪落了一夜。" });
	runWriteTool(ws, d, "draft_append", { segment: "他推门进屋，炉火将熄。" });
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "推门进屋", new: "推门进了屋" }] });
	assert.equal(r.ok, true);
	assert.equal(ws.edits, 1);
	const segs = ws.timeline.filter((s) => s.kind === "text" && s.draft === true);
	assert.equal(segs.length, 2, "改稿后仍是两个稿段（分段形态不塌）");
});

test("draft_seal：空工作区封笔被拒", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_seal", {});
	assert.equal(r.ok, false);
	assert.match(r.text, /draft_write|draft_append/);
});

test("draft_seal：封笔后 draft_edit 仍可改（封笔≠锁稿，改完再验）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "山门外的雪落了一夜。" });
	runWriteTool(ws, d, "draft_append", { segment: "她还在窗边。" });
	runWriteTool(ws, d, "draft_seal", {});
	assert.equal(ws.sealed, true);
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "窗边", new: "廊下" }] });
	assert.equal(r.ok, true);
	assert.ok(ws.draft.includes("廊下"));
});

test("draft_write：全量替换语义——第二稿覆盖第一稿", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "第一稿。" });
	runWriteTool(ws, d, "draft_write", { content: "第二稿。" });
	assert.equal(ws.draft, "第二稿。");
	assert.equal(ws.writes, 2);
});

test("draft_check：无稿先提示交稿；有稿出报告并记录全绿", () => {
	const ws = createWorkspace();
	const d = deps();
	const empty = runWriteTool(ws, d, "draft_check", {});
	assert.equal(empty.ok, false);
	assert.match(empty.text, /先用 draft_write/);

	runWriteTool(ws, d, "draft_write", { content: "雪停了。" });
	const r = runWriteTool(ws, d, "draft_check", {});
	assert.equal(r.ok, true);
	assert.equal(ws.lastGreen, true); // 空规则 + 无主权违规 = 全绿
});

test("world_state_update：只验不改——合格入队，定稿前基准账本不动", () => {
	const ws = createWorkspace();
	const d = deps();
	const r = runWriteTool(ws, d, "world_state_update", {
		patch: { location: "藏经阁", characters: { 林霜: { affinity: 35 } } },
	});
	assert.equal(r.ok, true);
	assert.match(r.text, /已记账（定稿后生效）/);
	assert.equal(ws.patches.length, 1);
	assert.equal(d.baseState.location, ""); // 基准未被改动
	const proj = projectedState(ws, d.baseState);
	assert.equal(proj.location, "藏经阁");
	assert.equal(proj.characters["林霜"].affinity, 35);
});

test("world_state_update：非法 patch 拒收（非对象 / 全字段无效）", () => {
	const ws = createWorkspace();
	const d = deps();
	assert.equal(runWriteTool(ws, d, "world_state_update", { patch: "藏经阁" }).ok, false);
	assert.equal(runWriteTool(ws, d, "world_state_update", { patch: [1] }).ok, false);
	const r = runWriteTool(ws, d, "world_state_update", { patch: { time: 42 } });
	assert.equal(r.ok, false);
	assert.match(r.text, /记账被拒/);
	assert.equal(ws.patches.length, 0);
});

test("world_state_update：角色键在投影上归一（大小写变体不裂成两人）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "world_state_update", { patch: { characters: { Alice: { affinity: 10 } } } });
	runWriteTool(ws, d, "world_state_update", { patch: { characters: { "alice ": { status: "警惕" } } } });
	const proj = projectedState(ws, d.baseState);
	assert.deepEqual(Object.keys(proj.characters), ["Alice"]);
	assert.equal(proj.characters.Alice.affinity, 10);
	assert.equal(proj.characters.Alice.status, "警惕");
});

test("未知写侧工具名：可读文本，不抛", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_fly", {});
	assert.equal(r.ok, false);
	assert.match(r.text, /未知写侧工具/);
});

// ---------------- M-B：draft_edit / draft_read / draft_search ----------------

test("draft_edit：无稿时拒绝——改稿之前必须先落笔（两种写法都指路）", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_edit", { edits: [{ old: "甲", new: "乙" }] });
	assert.equal(r.ok, false);
	assert.equal(ws.edits, 0);
	assert.match(r.text, /draft_append/);
	assert.match(r.text, /draft_write/);
});

test("draft_edit：多处定点替换一次套用，改稿即验，稿次不增而 edits 增", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "他推开门。屋里很暗。她抬起头。" });
	const r = runWriteTool(ws, d, "draft_edit", {
		edits: [
			{ old: "他推开门。", new: "他一把推开门。" },
			{ old: "她抬起头。", new: "她缓缓抬起头。" },
		],
	});
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "他一把推开门。屋里很暗。她缓缓抬起头。");
	assert.equal(ws.edits, 1);
	assert.equal(ws.writes, 1, "定点改稿不算新稿次");
	assert.ok(ws.checks >= 2, "改稿后自动复验");
});

test("draft_edit：批量原子——任一处定位失败则整批不改", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "他推开门。屋里很暗。" });
	const before = ws.draft;
	const r = runWriteTool(ws, d, "draft_edit", {
		edits: [
			{ old: "他推开门。", new: "他一把推开门。" },
			{ old: "根本不存在的句子", new: "X" },
		],
	});
	assert.equal(r.ok, false);
	assert.equal(ws.draft, before, "第一处也不能落笔");
	assert.equal(ws.edits, 0);
	assert.match(r.text, /整批未套用/);
	assert.match(r.text, /根本不存在的句子/, "回显模型自己声称的 old");
});

test("draft_edit：old 不唯一时拒绝并要求扩大引用范围", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "她笑了。他也笑了。" });
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "笑了", new: "哭了" }] });
	assert.equal(r.ok, false);
	assert.match(r.text, /2 处/);
	assert.match(r.text, /唯一/);
});

test("draft_edit：中文标点变体按归一命中，并回报命中级别", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "他说：“走吧。”然后转身。" });
	// 模型用直角引号引用——归一后应命中
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "「走吧。」", new: "「再等等。」" }] });
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "他说：「再等等。」然后转身。", "下标映射回原文必须精确");
	assert.match(r.text, /标点归一/, "非精确命中要告知模型");
});

test("draft_search：命中给上下文引用；多处命中提示 old 需唯一", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "她笑了。风很大。他也笑了。" });
	const one = runWriteTool(ws, d, "draft_search", { query: "风很大" });
	assert.equal(one.ok, true);
	assert.match(one.text, /命中 1 处/);

	const many = runWriteTool(ws, d, "draft_search", { query: "笑了" });
	assert.match(many.text, /命中 2 处/);
	assert.match(many.text, /必须唯一/);

	const none = runWriteTool(ws, d, "draft_search", { query: "不存在" });
	assert.match(none.text, /找不到/);
});

test("draft_read：回现稿全文与验收口径字数（标签模块不计入）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "山门外落了一夜雪。<StatusBlock>地点：山门</StatusBlock>" });
	const r = runWriteTool(ws, d, "draft_read", {});
	assert.equal(r.ok, true);
	assert.match(r.text, /山门外落了一夜雪/);
	assert.match(r.text, /正文 9 字/, "extractDraftBody 口径，状态栏不计入");
});
