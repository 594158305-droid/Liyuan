import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SessionManager } from "@liyuan/agent-runtime";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@liyuan/ai/providers/faux";
import { registerFauxProvider, streamSimple } from "@liyuan/ai/compat";

import { StageEngine, type StageStreamFn } from "../src/stage/engine.ts";

/** 临时舞台：配置+卡+独立会话目录 */
const makeStage = () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-eng-"));
	writeFileSync(
		join(cwd, "card.json"),
		JSON.stringify({ data: { name: "云澜", description: "{{user}}的师姐", first_mes: "你来了。" } }),
	);
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟" }));
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	return { cwd, sm };
};

const makeEngine = (
	cwd: string,
	sm: InstanceType<typeof SessionManager>,
	model: unknown,
	events: ConstructorParameters<typeof StageEngine>[0]["events"] = {},
) =>
	new StageEngine({
		cwd,
		getSessionManager: () => sm as never,
		getModel: () => model as never,
		getAuth: async () => ({}),
		streamFn: streamSimple as unknown as StageStreamFn,
		events,
	});

/**
 * 场记那一发（M3 起每个干净收笔的拍都会发起）。
 * 空 patch = 不落快照不出过程条，用于「本测试不关心记账」的场合。
 */
const fauxScribeEmpty = () => fauxAssistantMessage(JSON.stringify({ patch: {} }));

test("引擎：一拍全链路（user 落树 → 流式 → assistant 落树 → 谢幕）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage("云澜垂眸受了半礼。「山门夜巡未归的人，是你？」"), fauxScribeEmpty()]);
		let partials = 0;
		let end: { aborted: boolean; entryId?: string; error?: string } | null = null;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: () => partials++,
			onTurnEnd: (info) => (end = info),
		});

		await engine.performTurn("我上前行礼。");

		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>;
		const roles = branch.filter((e) => e.type === "message").map((e) => e.message?.role);
		assert.deepEqual(roles, ["user", "assistant"]);
		assert.ok(partials > 0, "流式部分事件应外发");
		assert.ok(end && !end.aborted && !end.error && end.entryId, "谢幕信息应带落树条目 id");
		assert.ok(JSON.stringify(branch).includes("山门夜巡"), "正文在树上");
		assert.equal(engine.isStreaming, false);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：忙时排队（R9 回合互斥）——两拍依序完成", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("第一拍回应。"),
			fauxScribeEmpty(),
			fauxAssistantMessage("第二拍回应。"),
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));

		const p1 = engine.performTurn("第一句。");
		const p2 = engine.performTurn("第二句。"); // 忙 → 入队
		await Promise.all([p1, p2]);

		const text = JSON.stringify(sm.getBranch());
		assert.ok(text.includes("第一拍回应"));
		assert.ok(text.includes("第二拍回应"));
		const idx1 = text.indexOf("第一拍回应");
		const idx2 = text.indexOf("第二拍回应");
		assert.ok(idx1 < idx2, "第二拍必须排在第一拍之后");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：regenerate 在钉回的 user 下挂 sibling（swipe 语义）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("第一版回复。"),
			fauxScribeEmpty(),
			fauxAssistantMessage("重演的第二版。"),
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));

		await engine.performTurn("走进殿内。");
		const userId = (sm.getBranch() as Array<{ id: string; type: string; message?: { role?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "user",
		)?.id;
		assert.ok(userId);

		sm.branch(userId);
		await engine.regenerate();

		const branchText = JSON.stringify(sm.getBranch());
		assert.ok(branchText.includes("重演的第二版"), "当前分支是重演稿");
		assert.ok(!branchText.includes("第一版回复"), "旧变体不在当前分支");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：abort 半拍——已流出的正文落树、标记 aborted", async () => {
	const { cwd, sm } = makeStage();
	// 放慢出字速度，保证 abort 打在流中
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }], tokensPerSecond: 30 });
	try {
		reg.setResponses([
			fauxAssistantMessage("很长的一拍正文，慢慢地流出来，一句接一句，足够被中途打断的长度，再加一句压秤。"),
		]);
		let end: { aborted: boolean; entryId?: string } | null = null;
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: (kind, delta) => {
				if (kind !== "text") return;
				streamed += delta;
				if (streamed.length >= 8 && engine.isStreaming) engine.abort();
			},
			onTurnEnd: (info) => (end = info),
		});
		await engine.performTurn("开演。");

		assert.ok(end, "谢幕必须发生");
		assert.equal((end as { aborted: boolean }).aborted, true, "应标记为中断");
		const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string; stopReason?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "assistant",
		);
		assert.ok(asst, "半拍正文仍应落树（用户看过的戏不消失）");
		assert.equal(asst?.message?.stopReason, "aborted");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：无模型/无用户输入的失败路径走通知，不落错误正文", async () => {
	const { cwd, sm } = makeStage();
	const notices: string[] = [];
	const engine = new StageEngine({
		cwd,
		getSessionManager: () => sm as never,
		getModel: () => undefined,
		getAuth: async () => ({}),
		streamFn: streamSimple as unknown as StageStreamFn,
		events: { onNotify: (_l, t) => notices.push(t) },
	});
	await engine.performTurn("你好。");
	assert.ok(notices.some((t) => t.includes("剧情模型")), "无模型应有人话提示");
	const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string } }>).filter(
		(e) => e.type === "message" && e.message?.role === "assistant",
	);
	assert.equal(asst.length, 0, "不落任何 assistant 消息");
	rmSync(cwd, { recursive: true, force: true });
});

// ---------------- M-A：宽进严出 + 验收报告喂回（取代 M2 幕后精修） ----------------

import { writeFileSync as wf } from "node:fs";
import { rebuildHistory, type BranchEntryLike } from "../src/stage/assemble.ts";

/** 在临时舞台上加一个带纪律块（禁词表）的预设 */
const addBannedWordPreset = (cwd: string) => {
	wf(
		join(cwd, "preset.json"),
		JSON.stringify({
			blocks: [{ id: "pol", channel: "system", enabled: true, content: '词汇黑名单 = { "闪过" }' }],
			samplers: {},
		}),
	);
	wf(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟", preset: "preset.json" }));
};

test("引擎循环：违禁直出→代收+报告喂回→模型 draft_write 重交→定稿（精修可见化）", async () => {
	const { cwd, sm } = makeStage();
	addBannedWordPreset(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const contexts: Array<{ systemPrompt?: string; messages: unknown[] }> = [];
		reg.setResponses([
			(ctx) => {
				contexts.push(ctx);
				return fauxAssistantMessage("她眼中闪过一丝冷意，收剑入鞘。");
			},
			(ctx) => {
				contexts.push(ctx);
				// 模型看到验收报告，自己重交全文（精修从幕后偷做改成模型可见）
				return fauxAssistantMessage([fauxToolCall("draft_write", { content: "她沉下一层霜色，收剑入鞘。" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(""), // 收稿即验全绿 → 模型收笔
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
		});
		await engine.performTurn("拔剑指向她。");

		// 定稿 = 模型重交的稿；禁词消失
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("沉下一层霜色"), "定稿是模型重交的文本");
		assert.ok(!finalText.includes("闪过"), "禁词已消失");

		// 报告喂回是模型可见的（第二轮上下文里有验收报告）
		const fed = JSON.stringify(contexts[1].messages);
		assert.ok(fed.includes("验收报告"), "模型看到了验收报告");
		assert.ok(fed.includes("draft_write"), "报告指路 draft_write");

		// 过程条：代收 → 交稿；R7 仍守：写作阶段 system 不见禁词细则
		assert.ok(activities.some((a) => a.includes("代收")));
		assert.ok(activities.some((a) => a.includes("交稿")));
		assert.ok(!String(contexts[0].systemPrompt).includes("词汇黑名单"), "初稿阶段不见禁词表");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：报告喂回后模型不改（只闲聊收笔）→ 保留现稿如实交付，闲聊不落树", async () => {
	const { cwd, sm } = makeStage();
	addBannedWordPreset(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("她眼中闪过一丝冷意，收剑入鞘。"),
			fauxAssistantMessage("就这样吧。"), // 模型无视报告直接收笔
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("拔剑指向她。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("闪过"), "模型拒改 → 保留现稿（引擎不替模型做决定）");
		assert.ok(!finalText.includes("就这样吧"), "收笔闲聊不进正文");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：干净直出=代收即全绿，零额外调用（快路径）", async () => {
	const { cwd, sm } = makeStage(); // 无预设
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage("干净的一拍正文。"), fauxScribeEmpty()]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
		});
		await engine.performTurn("走进殿内。");
		assert.equal(reg.getPendingResponseCount(), 0, "初稿一发 + 场记兜底一发（全绿不加轮）");
		assert.deepEqual(activities, ["直出正文已代收为 draft_write"], "快路径只有一条代收过程条");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M3：场记记账（R8 独占 + R4 账本=f(分支)） ----------------

import { stateFromBranch } from "../src/stage/assemble.ts";

const fauxScribe = (patch: Record<string, unknown>) => fauxAssistantMessage(JSON.stringify({ patch }));

test("引擎记账：定稿后场记落 rp-state 快照；账本 = f(分支)", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const scribeCtx: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			fauxAssistantMessage("云澜接过怀表，指尖顿了顿。"),
			(ctx) => {
				scribeCtx.push(ctx);
				return fauxScribe({ time: "戌时", location: "溪桥", inventory: ["黄铜怀表（云澜持有）"] });
			},
		]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("我把怀表递给她。");

		const state = stateFromBranch(sm.getBranch() as BranchEntryLike[]);
		assert.equal(state.time, "戌时");
		assert.equal(state.location, "溪桥");
		assert.deepEqual(state.inventory, ["黄铜怀表（云澜持有）"]);
		assert.ok(activities.some((a) => a.startsWith("记账")), "记账过程条");
		// 场记读到的是本拍定稿正文
		assert.ok(JSON.stringify(scribeCtx[0].messages).includes("指尖顿了顿"));
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎记账：swipe 重演后账本自动回滚（8/02 泄漏事故复测）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("她收下了怀表。"),
			fauxScribe({ inventory: ["黄铜怀表（云澜持有）"], flags: { 赠礼: "已收下" } }),
			fauxAssistantMessage("她把怀表推了回来。"),
			fauxScribe({ inventory: ["黄铜怀表（沈舟持有）"], flags: { 赠礼: "被拒绝" } }),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("我把怀表递给她。");
		assert.deepEqual(stateFromBranch(sm.getBranch() as BranchEntryLike[]).inventory, ["黄铜怀表（云澜持有）"]);

		// swipe：叶钉回 user，重演一版
		const userId = (sm.getBranch() as Array<{ id: string; type: string; message?: { role?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "user",
		)?.id;
		assert.ok(userId);
		sm.branch(userId);
		await engine.regenerate();

		const after = stateFromBranch(sm.getBranch() as BranchEntryLike[]);
		assert.deepEqual(after.inventory, ["黄铜怀表（沈舟持有）"], "废弃分支的账本不得泄漏到新分支");
		assert.equal(after.flags["赠礼"], "被拒绝");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎记账：中断的半拍不记账（半截正文不进账本）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }], tokensPerSecond: 30 });
	try {
		reg.setResponses([
			fauxAssistantMessage("很长的一拍正文，慢慢地流出来，一句接一句，足够被中途打断的长度，再加一句压秤。"),
			fauxScribe({ time: "不该被记下的时间" }),
		]);
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: (kind, delta) => {
				if (kind !== "text") return;
				streamed += delta;
				if (streamed.length >= 8 && engine.isStreaming) engine.abort();
			},
		});
		await engine.performTurn("开演。");

		const snaps = (sm.getBranch() as Array<{ type?: string; customType?: string }>).filter(
			(e) => e.type === "custom" && e.customType === "rp-state",
		);
		assert.equal(snaps.length, 0, "中断拍不落账本快照");
		assert.equal(reg.getPendingResponseCount(), 1, "场记那一发根本没发出");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M3：台上检索工具循环（R2 查资料 + R6 动笔即收敛） ----------------

/** 带一条可被检索命中的世界书的舞台 */
const addLorebook = (cwd: string) => {
	wf(
		join(cwd, "lore.json"),
		JSON.stringify({
			entries: {
				"0": {
					uid: 0,
					key: ["骨誓", "北境"],
					comment: "北境骨誓",
					content: "北境以骨为契：折骨立誓，背誓者终身不得入祠。",
					constant: false,
					enabled: true,
					order: 100,
				},
			},
		}),
	);
	wf(
		join(cwd, "liyuan.config.json"),
		JSON.stringify({ card: "card.json", userName: "沈舟", lorebooks: ["lore.json"] }),
	);
};

test("引擎工具：查设定 → 结果回喂 → 续演正文；工具装配进 Context", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ tools?: Array<{ name: string }>; messages: unknown[] }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage([fauxToolCall("lorebook_search", { query: "骨誓" })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("她提起北境的规矩：折骨立誓，背誓不得入祠。");
			},
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d) => {
				if (kind === "text") streamed += d;
			},
		});
		await engine.performTurn("北境的骨誓是什么规矩？");

		// 读侧 + 写侧全清单装配进首轮。lorebook_toggle / codex_mount / choice 不在其中：
		// 本用例未注入 setDisabledLore / mountCodex / select，统一层按依赖过滤
		// （依赖缺失的工具不上清单，见 adapters/stage.ts）。codex 读/写五件只依赖 cwd，
		// 引擎恒注入，故在清单上。
		const names = (ctxs[0].tools ?? []).map((t) => t.name).sort();
		assert.deepEqual(names, [
			"assistant_run",
			"card_read",
			"codex_create",
			"codex_delete",
			"codex_list",
			"codex_read",
			"codex_write",
			"draft_check",
			"draft_edit",
			"draft_read",
			"draft_search",
			"draft_write",
			"lorebook_list",
			"lorebook_search",
			"lorebook_write",
			"memory_search",
			"world_state_get",
			"world_state_update",
		]);

		// 检索结果以 toolResult 回喂
		const fed = JSON.stringify(ctxs[1].messages);
		assert.ok(fed.includes("toolResult"), "工具结果以 toolResult 角色回喂");
		assert.ok(fed.includes("折骨立誓"), "命中的设定正文在场");

		// 续演正文流式上屏 + 落树
		assert.ok(streamed.includes("背誓不得入祠"), "工具轮后的正文照常流式");
		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string } }>;
		assert.deepEqual(
			branch.filter((e) => e.type === "message").map((e) => e.message?.role),
			["user", "assistant"],
			"工具过程不落树（R3：过程不进历史）",
		);
		assert.ok(JSON.stringify(branch).includes("背誓不得入祠"), "定稿在树上");
		assert.ok(activities.some((a) => a.includes("查设定「骨誓」")), "过程条报告检索");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：draft_write 工具交稿 → 收稿即验回喂 → 收笔定稿", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage([fauxToolCall("draft_write", { content: "她点头应下此事。" })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage(""); // 看到全绿报告 → 收笔
			},
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const draftFlags: boolean[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d, draft) => {
				if (kind === "text") {
					streamed += d;
					if (draft) draftFlags.push(true);
				}
			},
		});
		await engine.performTurn("此事你应是不应？");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		assert.equal(history[history.length - 1].text, "她点头应下此事。", "定稿 = 工具提交的稿");
		assert.equal(streamed, "她点头应下此事。", "D1：draft_write 的 content 走 text 通道上屏");
		assert.ok(draftFlags.length > 0, "draft_write 转发带 draft 标记（前端替换语义）");
		assert.ok(JSON.stringify(ctxs[1].messages).includes("已收稿"), "收稿+验收报告以 toolResult 回喂");
		assert.ok(activities.some((a) => a.includes("交稿")), "过程条报告交稿");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：格式尾巴（状态栏占位+catsay）走 text 通道 → 并入定稿正文与持久化时间线", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 8/05 实锤形态：draft_write 只交正文，思考里宣告还要写状态栏与点评
			fauxAssistantMessage(
				[
					fauxThinking("The user decides. Now the status bar and cat commentary."),
					fauxToolCall("draft_write", { content: "暮色四合，两人到了溪桥。" }),
				],
				{ stopReason: "toolUse" },
			),
			// 尾巴轮：状态栏占位 + 咪咪点评（预设格式栈，不走 draft_write）
			fauxAssistantMessage(
				"<StatusPlaceHolderImpl/>\n\n<catsay>\n<details><summary>😼咪咪点评</summary>\n选天赋磨叽半天喵呜。\n</details>\n</catsay>",
			),
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d) => {
				if (kind === "text") streamed += d;
			},
		});
		await engine.performTurn("往溪桥去。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		// 树上正文 = 用户面定稿：正文 + 状态栏占位 + 咪咪点评都在
		const branch = sm.getBranch() as Array<{
			type: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
		}>;
		const lastMsg = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
		const treeText = (lastMsg?.message?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		assert.ok(treeText.includes("暮色四合"), "正文在树上");
		assert.ok(treeText.includes("StatusPlaceHolderImpl"), "状态栏占位并入定稿——不再被过滤");
		assert.ok(treeText.includes("咪咪点评"), "咪咪点评并入定稿——不再被过滤");
		assert.ok(streamed.includes("咪咪点评"), "尾巴也流式上屏过");
		// 模型面历史仍整块剥 catsay（防往拍模仿）——「历史剥、树留」双语义各就位
		assert.ok(history[history.length - 1].text.includes("暮色四合"), "历史含正文");
		assert.ok(!history[history.length - 1].text.includes("咪咪点评"), "历史剥掉格式栈（往拍模仿源）");

		// 时间线随 details 持久化：resync/刷新后尾巴仍在
		const entry = branch.filter((e) => e.type === "message" && e.message?.content).pop();
		const timeline = entry?.message?.details?.rpTimeline as Array<{ kind: string; text?: string }> | undefined;
		assert.ok(Array.isArray(timeline), "rpTimeline 落树持久化");
		const tlText = (timeline ?? []).filter((s) => s.kind === "text").map((s) => s.text ?? "").join("");
		assert.ok(tlText.includes("咪咪点评"), "持久化时间线的正文段含尾巴（吸收不重复）");
		assert.ok((timeline ?? []).filter((s) => s.kind === "text").length <= 1, "尾巴段被吸收，不重复上屏");
		assert.ok(activities.some((a) => a.includes("交稿")), "过程条照常");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：world_state_update 记账——模型提交 patch，账本落树，场记旁路不再发出", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("world_state_update", { patch: { time: "戌时", location: "溪桥" } }),
					fauxToolCall("draft_write", { content: "暮色四合，两人到了溪桥。" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(""), // 收笔
			// 注意：没有场记那一发——模型已记账，旁路兜底不得发出
		]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("往溪桥去。");

		const state = stateFromBranch(sm.getBranch() as BranchEntryLike[]);
		assert.equal(state.time, "戌时");
		assert.equal(state.location, "溪桥");
		assert.equal(reg.getPendingResponseCount(), 0, "两发用尽——场记旁路没有发出（D5 兜底只在无 patch 时）");
		assert.ok(activities.some((a) => a.includes("记账")), "记账过程条");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：空手停笔（0 字病灶）→ 催稿一轮 → 补交定稿", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			fauxAssistantMessage(""), // 思考完不写正文（实弹三拍 0 字的复现）
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("补上的正文。");
			},
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开演。");

		assert.ok(JSON.stringify(ctxs[0].messages).includes("你还没有交稿"), "催稿信息喂回");
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		assert.equal(history[history.length - 1].text, "补上的正文。", "补交的正文成为定稿——空拍被结构性消灭");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：催稿后仍空手 → 认栽收拍并通知（不再静默丢拍）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
		const notices: string[] = [];
		let end: { error?: string } | null = null;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onNotify: (_l, t) => notices.push(t),
			onTurnEnd: (info) => (end = info),
		});
		await engine.performTurn("开演。");

		assert.ok(notices.some((t) => t.includes("未交出任何正文")), "空拍必须有人话通知");
		assert.equal((end as { error?: string } | null)?.error, "no-draft");
		const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string } }>).filter(
			(e) => e.type === "message" && e.message?.role === "assistant",
		);
		assert.equal(asst.length, 0, "空拍不落树");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎工具：不查资料的一拍零额外调用（工具是可选的，不是必经的）", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage("她点了点头，没多问。"), fauxScribeEmpty()]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("我说了声走吧。");

		assert.equal(reg.getPendingResponseCount(), 0, "初稿 + 场记两发，无工具轮");
		assert.ok(!activities.some((a) => a.startsWith("查")), "没查就不出检索过程条");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M4 长局压缩（引擎自管） ----------------

/** 写配置：压缩周期可调 */
const setCompactEvery = (cwd: string, everyNTurns: number) =>
	writeFileSync(
		join(cwd, "liyuan.config.json"),
		JSON.stringify({ card: "card.json", userName: "沈舟", compactEveryNTurns: everyNTurns }),
	);

test("引擎压缩：攒够拍数后自管落 rp-summary，被覆盖的正文不再进上下文", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 2);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: Array<{ content?: unknown }> }> = [];
		const long = (i: number) => `第 ${i} 拍的正文。${"云".repeat(1200)}`;
		// 8 拍：保留 6 + 周期 2 → 第 8 拍收尾时应触发一次压缩
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push((ctx: unknown) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage(long(i));
			});
			responses.push(fauxScribeEmpty());
		}
		// 压缩那一发（第 8 拍尾）
		responses.push(fauxAssistantMessage("## 前情提要\n沈舟与云澜在山门相遇。\n## 当前场景\n第三天黄昏，后山。"));
		reg.setResponses(responses as never);

		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		const branch = sm.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>;
		const summaries = branch.filter((e) => e.type === "custom" && e.customType === "rp-summary");
		assert.equal(summaries.length, 1, "应恰好落一条 rp-summary");
		const data = summaries[0].data as { summary: string; coversThroughId: string; turns: number };
		assert.ok(data.summary.includes("前情提要"));
		assert.equal(data.turns, 2, "8 拍保留 6 → 覆盖前 2 拍");
		assert.ok(activities.some((a) => a.includes("前情已压缩")), "过程条报告压缩");

		// 树只追加：原文楼层照旧全在（重放/回看不受影响）
		assert.ok(JSON.stringify(branch).includes("第 1 拍的正文"), "被覆盖的正文仍在树上");
		assert.equal(reg.getPendingResponseCount(), 0, "八拍 + 八次记账 + 一次压缩");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎压缩：下一拍装配读回【前情提要】，被覆盖的往拍原文消失（长局提速的实质）", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 2);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: Array<{ content?: unknown }> }> = [];
		const cap = (text: string) => (ctx: unknown) => {
			ctxs.push(ctx as never);
			return fauxAssistantMessage(text);
		};
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(cap(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxScribeEmpty());
		}
		responses.push(fauxAssistantMessage("## 前情提要\n沈舟与云澜在山门相遇，立了骨誓。"));
		// 压缩之后的第 9 拍
		responses.push(cap("第 9 拍的正文。"));
		responses.push(fauxScribeEmpty());
		reg.setResponses(responses as never);

		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 9; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		const last = ctxs[ctxs.length - 1];
		const flat = JSON.stringify(last.messages);
		assert.ok(flat.includes("【前情提要】"), "摘要以前情提要块回读进上下文");
		assert.ok(flat.includes("立了骨誓"), "摘要正文在场");
		assert.ok(!flat.includes("第 1 拍的正文"), "被覆盖的往拍原文不再进上下文");
		assert.ok(!flat.includes("第 2 拍的正文"), "被覆盖的往拍原文不再进上下文");
		assert.ok(flat.includes("第 7 拍的正文"), "保留区往拍逐字仍在");

		// 用户当拍的话仍是最后一句（8/03 教训不能被压缩打破）
		const lastMsg = last.messages[last.messages.length - 1] as { content: Array<{ text: string }> };
		assert.ok(lastMsg.content[0].text.trimEnd().endsWith("第 9 拍我说的话。"), "用户当拍的话必须是上下文最后一句");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎压缩：中断的半拍不触发压缩（脏拍不压）", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 1);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(fauxAssistantMessage(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxScribeEmpty());
		}
		// 第 8 拍收尾时可裁正文（前 2 拍）才越过字数地板 → 恰好压一次
		responses.push(fauxAssistantMessage("## 前情提要\n前两拍的摘要。"));
		reg.setResponses(responses as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);
		const before = (sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary");
		assert.equal(before.length, 1, "干净收笔的拍会压缩");

		// 中断的半拍：只出正文不出场记/压缩
		reg.setResponses([fauxAssistantMessage(`第 9 拍。${"云".repeat(1200)}`, { stopReason: "aborted" })]);
		await engine.performTurn("第 9 拍我说的话。");
		const after = (sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary");
		assert.equal(after.length, 1, "中断半拍不得触发新压缩");
		assert.equal(reg.getPendingResponseCount(), 0);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎压缩：compactNow() 手动压缩不等周期；流式中拒绝", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 0); // 自动压缩关闭
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(fauxAssistantMessage(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxScribeEmpty());
		}
		reg.setResponses(responses as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		assert.equal(
			(sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary").length,
			0,
			"everyNTurns=0 时不自动压缩",
		);

		reg.setResponses([fauxAssistantMessage("## 前情提要\n手动压缩产出的摘要。")]);
		const r = await engine.compactNow();
		assert.equal(r.kind, "compacted");
		assert.equal(
			(sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary").length,
			1,
			"手动压缩落一条摘要",
		);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});
