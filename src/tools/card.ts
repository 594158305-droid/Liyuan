/**
 * 角色库族工具（PLAN-RP-TOOLING M-D4）。
 *
 * 合一前仅助手侧有 `card_create` 一件（typebox 内联，未走统一层），
 * 台上与扩展各零件。`card_read` 是新增。
 *
 * ## 写侧保护（本窗口只做读 + 创建）
 *
 * `updateCardFields` 直接 `writeFileSync` 覆盖用户原卡文件（PNG/JSON），无备份、无 overlay。
 * 与世界书族「用户原始资料只读、写入落独立 overlay」的纪律冲突。本窗口**不做 card_update**，
 * 等有备份/overlay 保护后再开写侧。
 *
 * `card_create` 是**安全写**：创建新文件（同名拒写 + 写入后 loadCardFile 回读自检，
 * 解析失败 unlinkSync 回滚），不碰用户现有卡数据。
 */

import { errText, intArg, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

export interface CardDeps {
	// ---- 读者 ----
	/** 读取当前装载的卡（字段级）；返回 null = 未装载卡 */
	readCard: () => { name: string; description?: string; personality?: string; scenario?: string;
		firstMes?: string; mesExample?: string; systemPrompt?: string; creatorNotes?: string;
		tags?: string[]; alternateGreetings?: string[] } | null;

	// ---- 创建者 ----
	/** 创建一张新角色卡（JSON CharaCard V3）；同名拒写。返回 (name, path) 或 null=同名已存在 */
	createCard?: (input: { name: string; description?: string; personality?: string; scenario?: string;
		firstMes: string; mesExample?: string; alternateGreetings?: string[] }) => { name: string; path: string } | null;
}

/**
 * 调用情境：诊断卡面内容——用户问「这张卡的描述是什么/有几个备选开场白」或
 * 助手需要根据卡面信息回答配置问题。类比 `lorebook_list`（给目录不给正文）。
 */
export const cardRead: ToolSpec<CardDeps> = {
	name: "card_read",
	domain: "card",
	mode: "read",
	surfaces: ["stage", "assistant"],
	label: "读取角色卡",
	description: () =>
		"读取当前装载的角色卡字段（description/personality/scenario/first_mes/mes_example/system_prompt/creator_notes/tags/alternate_greetings）。" +
		"拿不准卡面某字段的内容时调用。",
	parameters: () => ({
		type: "object",
		properties: {},
		required: [],
	}),
	async run(_args, deps): Promise<ToolResult> {
		let card: ReturnType<CardDeps["readCard"]>;
		try {
			card = deps.readCard();
		} catch (err) {
			return { text: `读取角色卡失败：${errText(err)}` };
		}
		if (!card) return { text: "当前未装载角色卡。" };

		const text = [
			`角色卡「${card.name}」：`,
			card.description ? `**描述**：${card.description.slice(0, 2000)}` : "",
			card.personality ? `**性格**：${card.personality.slice(0, 1200)}` : "",
			card.scenario ? `**场景**：${card.scenario.slice(0, 1200)}` : "",
			card.firstMes ? `**开场白**：${card.firstMes.slice(0, 2000)}` : "",
			card.mesExample ? `**对话范例**：${card.mesExample.slice(0, 2000)}` : "",
			card.systemPrompt ? `**系统提示**：${card.systemPrompt.slice(0, 800)}` : "",
			card.creatorNotes ? `**作者注**：${card.creatorNotes.slice(0, 1200)}` : "",
			card.tags?.length ? `**标签**：${card.tags.join("、")}` : "",
			card.alternateGreetings?.length
				? `**备选开场白（${card.alternateGreetings.length} 条）**：\n${card.alternateGreetings.map((g, i) => `${i + 1}. ${g.slice(0, 200)}`).join("\n")}`
				: "",
		]
			.filter(Boolean)
			.join("\n\n");
		return { text, activity: "读卡" };
	},
};

/**
 * 调用情境：用户说「帮我做一张 X 的角色卡」。创建的是新文件（同名拒写），
 * 写入后回读自检——做出来的是什么，回执就报什么。
 *
 * 迁移自 server/assistant.ts:694 的旧 typebox 内联实现，语义不变。
 */
export const cardCreate: ToolSpec<CardDeps> = {
	name: "card_create",
	domain: "card",
	mode: "write",
	surfaces: ["assistant"],
	label: "创建角色卡",
	description: () =>
		"创建一张新角色卡（CharaCard V3 JSON）。同名卡已存在时拒写。用于用户要求做新卡时。" +
		"参数全部用剧情原语言填写。" +
		"写完后**不会自动切换到新卡**——请用户自行在卡库中打开。",
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "卡名（也是文件名；不限语言）" },
			description: { type: "string", description: "外貌/背景描述" },
			personality: { type: "string", description: "性格特征" },
			scenario: { type: "string", description: "当前场景/处境" },
			first_mes: { type: "string", description: "开场白（必填，新会话的首条消息）" },
			mes_example: { type: "string", description: "对话范例（展示说话风格）" },
			alternate_greetings: {
				type: "array",
				items: { type: "string" },
				description: "备选开场白（多条，第一条即 first_mes 可不重复填）",
			},
		},
		required: ["name", "first_mes"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.createCard) return { text: "本环境不支持创建角色卡。" };

		const name = strArg(args, "name");
		if (!name) return { text: "缺少 name 参数（卡名 / 文件名）。" };

		const firstMes = strArg(args, "first_mes");
		if (!firstMes) return { text: "缺少 first_mes 参数（开场白，新会话首条消息）。" };

		const alternates = Array.isArray(args.alternate_greetings)
			? args.alternate_greetings.filter((g): g is string => typeof g === "string" && g.trim().length > 0).map((g) => g.trim())
			: [];

		let r: { name: string; path: string } | null;
		try {
			r = deps.createCard({
				name,
				...(strArg(args, "description") ? { description: strArg(args, "description") } : {}),
				...(strArg(args, "personality") ? { personality: strArg(args, "personality") } : {}),
				...(strArg(args, "scenario") ? { scenario: strArg(args, "scenario") } : {}),
				firstMes,
				...(strArg(args, "mes_example") ? { mesExample: strArg(args, "mes_example") } : {}),
				...(alternates.length ? { alternateGreetings: alternates } : {}),
			});
		} catch (err) {
			return { text: `创建角色卡失败：${errText(err)}` };
		}
		if (!r) return { text: `角色卡「${name}」已存在（同名卡拒写），请换一个名字。` };

		return {
			text:
				`已创建角色卡「${r.name}」（${r.path}）。` +
				`不会自动切换到此卡——请在卡库中手动打开。`,
			activity: `创建角色卡「${r.name}」`,
			details: { name: r.name, path: r.path },
		};
	},
};

/** 角色库族全部工具（M-D4：读 + 创建；写侧 card_update 待补保护层后开放） */
export const cardTools: ToolSpec<CardDeps>[] = [cardRead, cardCreate];
