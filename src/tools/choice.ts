/**
 * choice 工具（PLAN-RP-TOOLING）：台上专用「给用户出选择卡」。
 *
 * 助手面已有 ask_user（typebox 内联），本工具只进台上（surface ["stage"]），避免重复。
 * 语义与宿主 askChoice / uiContext.select 对齐：选项 2-4 个、用户可自由输入、可停止。
 *
 * 使用情境（剧情分叉 / 需要用户拍板时）：**先自己检索知识库**（lorebook_search /
 * memory_search / codex_read）给出候选选项，再出卡——选项要具体、IC（in-story）化、
 * 用剧情原语言，2-4 个；用户可自由输入或选择停止。拿到选择后以角色身份继续演。
 */

import { errText, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

export interface ChoiceDeps {
	/** 向用户发选择卡；返回用户选择；undefined = 用户停止 */
	select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
}

export const choiceTool: ToolSpec<ChoiceDeps> = {
	name: "choice",
	domain: "choice",
	mode: "read",
	surfaces: ["stage"],
	label: "给用户出选择卡",
	description: () =>
		"剧情出现分叉、或需要用户拍板时，给用户出**选择卡**：" +
		"先自己检索知识库（lorebook_search / memory_search / codex_read）给出候选，再调用本工具。" +
		"选项 2-4 个、用剧情原语言写、要具体（IC 化的下一步）；用户可自由输入或选择停止。" +
		"**选择卡是唯一可点击的选项入口**——不要用正文文字罗列选项。拿到选择后以角色身份继续演，不要跳出剧情。",
	parameters: () => ({
		type: "object",
		properties: {
			question: { type: "string", description: "问用户的问题（说明要拍板什么，用剧情原语言）" },
			options: {
				type: "array",
				items: { type: "string" },
				description: "2-4 个具体选项（IC 化的下一步，剧情原语言）",
			},
			placeholder: { type: "string", description: "自由输入框的占位提示（可省）" },
		},
		required: ["question", "options"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.select) return { text: "本环境不支持向用户出选择卡。" };

		const question = strArg(args, "question");
		if (!question) return { text: "缺少 question 参数。" };

		const options = Array.isArray(args.options)
			? args.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
			: [];
		if (options.length < 2) return { text: "缺少 options 参数（至少 2 个选项）。" };

		const placeholder = strArg(args, "placeholder");
		let answer: string | undefined;
		try {
			answer = await deps.select(question, options.slice(0, 4), {});
		} catch (err) {
			return { text: `选择卡发送失败：${errText(err)}` };
		}
		if (answer === undefined) return { text: "用户已停止选择。" };
		return { text: `用户选择：${answer}` };
	},
};
