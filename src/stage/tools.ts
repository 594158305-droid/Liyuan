/**
 * 台上检索工具（PLAN-RP-HARNESS M3，R2 工作区 = 稿纸 + 世界）。
 *
 * 对标 Claude Code 的 Read/Grep：动笔前查资料，不靠脑补。
 * 世界书族（lorebook_*）与向量库族（memory_*）已迁入统一工具层
 * （`src/tools/`，PLAN-RP-TOOLING M-D1~M-D3）；本模块只剩 world_state_get
 * 与 writing_guide，外加统一层的装配与派发入口。
 *
 * 封顶 MAX_LOOKUPS 次/拍：模型输出正文即视为动笔，工具循环自然结束。
 *
 * 工具 schema 与执行分离：schema 是纯数据（引擎装配进 Context.tools），
 * 执行依赖注入（检索函数），因此本模块可离线单测。
 */

import { runUnifiedStageTool, unifiedStageTools } from "../tools/adapters/stage.ts";
import type { LoreDeps, LoreHitLike } from "../tools/lore.ts";
import type { MemoryDeps, MemoryHitLike } from "../tools/memory.ts";
import type { CardDeps } from "../tools/card.ts";
import type { WorldlineDeps } from "../tools/worldline.ts";
import type { PanelDeps } from "../tools/panels.ts";
import type { WorldState } from "../types.ts";

/** 一拍内最多允许的检索次数（超出后撤掉工具，强制动笔） */
export const MAX_LOOKUPS = 3;

/** agent 循环安全阀（PLAN-RP-AGENT-EXEC §2.3）：开放式循环的轮数上限，触阀以现稿定稿 */
export const MAX_ROUNDS = 12;

/** @liyuan/ai Tool 的结构子集（parameters 用裸 JSON Schema，避免 src/ 依赖 typebox） */
export interface StageTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** 命中形（M-D1/M-D3 起由统一工具层定义，此处再导出保持既有引用不变） */
export type { LoreHitLike, MemoryHitLike };

/**
 * 台上工具执行依赖。五族（世界书 / 向量库 / 角色库 / 世界线 / 面板）由统一工具层
 * 定义，此处继承——一处增减、全链路同步。台上的可用工具按注入函数的存在性过滤。
 */
export interface StageToolDeps extends LoreDeps, MemoryDeps, CardDeps, WorldlineDeps, PanelDeps {
	/** 世界状态账本（getState 必在；formatState 用于展示） */
	getState: () => WorldState;
	formatState: (s: WorldState) => string;
	/** 写作方法论包（M-C 拆层 D/E 类）：topic → 文本；未注入＝无 writing_guide 工具 */
	getSkill?: (topic: string) => string | undefined;
}

const STR = { type: "string" } as const;

/**
 * 工具清单（纯数据）。language 用于把「用哪种语言查」写进描述。
 * deps 给出时按注入情况过滤统一层工具（依赖缺失的不上清单，见 adapters/stage.ts）。
 */
export function stageTools(language: string, deps?: StageToolDeps): StageTool[] {
	return [
		// 世界书族（M-D1/M-D2）与向量库族（M-D3）已迁入统一工具层：一份实现多面共用
		...unifiedStageTools(language, deps),
		{
			name: "world_state_get",
			description: "读取当前世界状态账本（时间/地点/人物好感与状态/物品归属/标记/剧情线）。拿不准既定事实时调用。",
			parameters: { type: "object", properties: {}, required: [] },
		},
	];
}

/**
 * 写作方法论工具（M-C，PLAN-RP-AGENT-EXEC §4 D-C2）：预设的 D/E 类内容按需读取。
 * 关键性质：工具结果**不落历史**（rebuildHistory 只留定稿正文）——方法论只活在当拍，
 * 谢幕即蒸发＝skill 的「按需加载、用完即走」。topics 为空时不要注册本工具（不凭空点名）。
 */
export function writingGuideTool(language: string, topics: string[]): StageTool {
	return {
		name: "writing_guide",
		description:
			`读取本预设附带的写作方法论（${language}）。可用主题：${topics.join(" / ")}。` +
			`动笔前按本拍场景读相关主题一次，照着写即可。这是**参考不是验收清单**——` +
			`字数/禁词/格式等机械纪律由验收器在交稿时程序化把关，不要在思考里逐条自查。`,
		parameters: {
			type: "object",
			properties: { topic: { type: "string", enum: topics, description: "要读取的方法论主题" } },
			required: ["topic"],
		},
	};
}

/**
 * 写侧五件（M-A 三件 + M-B 的 draft_edit/read/search）。
 * schema 在此，执行在 workspace.ts（工作区状态归引擎单拍持有）。
 */
export function writeTools(language: string): StageTool[] {
	return [
		{
			name: "draft_write",
			description:
				`提交本拍正文（${language}）。这是**唯一交稿方式**——不调用写工具即无正文产出。` +
				`全量替换语义：每次提交完整正文，覆盖上一稿。` +
				`不要在思考里反复排练——先落笔，再按验收报告改。` +
				`可以一次性写完整篇；也可以先写一部分，之后用 draft_append 接着写。` +
				`**已有稿之后的局部修改一律用 draft_edit 定点改，不要重交全文。**`,
			parameters: {
				type: "object",
				properties: { content: { ...STR, description: "完整正文（纯剧情文字，不含状态栏等格式区块）" } },
				required: ["content"],
			},
		},
		{
			name: "draft_append",
			description:
				`在现稿末尾**追加**一段正文（${language}），不覆盖已写部分。` +
				`适合边写边推进：写完一段就交一段，已写的就是已经发生的事，不会被打回。` +
				`追加后自动给出当前状态（字数/禁词/是否正站在分岔口）。` +
				`全部写完后调用 draft_seal 封笔，按完整稿验收。`,
			parameters: {
				type: "object",
				properties: { segment: { ...STR, description: "要续写的正文段落（自然段，不含状态栏等格式区块）" } },
				required: ["segment"],
			},
		},
		{
			name: "draft_seal",
			description:
				"封笔：声明正文已全部写完，按完整稿验收（字数/禁词/模块/主权全量判定）。" +
				"分段续写（draft_append）结束后必须调用本工具，否则本拍没有最终正文。",
			parameters: { type: "object", properties: {}, required: [] },
		},
		{
			name: "draft_edit",
			description:
				"对现稿做定点替换（改稿的**首选方式**，不要为改几句话重交全文）。" +
				"edits 可一次给多处，一并套用后自动复验。" +
				"每处的 old 必须逐字引用现稿原文且在全文中唯一——不唯一就前后多带一句；" +
				"引不准可先用 draft_search 取回精确原文。" +
				"**任一处定位失败则整批不套用**，按返回的说明修正后重新提交整批。",
			parameters: {
				type: "object",
				properties: {
					edits: {
						type: "array",
						description: "定点替换列表（可多处）",
						items: {
							type: "object",
							properties: {
								old: { ...STR, description: "现稿中要被替换的原文（须唯一）" },
								new: { ...STR, description: "替换成的新文字（传空串即删除该片段）" },
							},
							required: ["old", "new"],
						},
					},
				},
				required: ["edits"],
			},
		},
		{
			name: "draft_read",
			description:
				"读回当前稿全文，附稿次与**验收口径字数**（与字数规则同一口径，不含标签模块）。" +
				"改了多轮后拿不准现稿长什么样、或要给 draft_edit 取原文时调用。",
			parameters: { type: "object", properties: {}, required: [] },
		},
		{
			name: "draft_search",
			description:
				"在**当前稿**中查找文字，返回命中处的上下文引用——供 draft_edit 取精确的 old。" +
				"（查历史剧情用 memory_search，两者不是一回事。）",
			parameters: {
				type: "object",
				properties: { query: { ...STR, description: "要查找的文字片段" } },
				required: ["query"],
			},
		},
		{
			name: "draft_check",
			description:
				"对当前稿运行验收（代码判：字数/禁词/格式/主权红线），返回报告。" +
				"draft_write 收稿与 draft_edit 改稿时都已自动验收；此工具用于额外复验。全绿即可定稿。",
			parameters: { type: "object", properties: {}, required: [] },
		},
		{
			name: "world_state_update",
			description:
				"提交世界状态账本补丁（合并语义）：time/location 字符串整体替换；characters 按角色名合并字段" +
				"（affinity 数值/status/notes，传 null 删除该角色）；flags 按键合并（null 删除）；" +
				"inventory/plot_threads 传**字符串数组**整体替换（如 [\"补气丹（已服用）\"]，元素不能是对象）。" +
				"本拍剧情改变了世界（时间流逝/移动/关系变化/" +
				"获得失去物品/剧情推进）就在定稿前提交——你是唯一知道现场发生了什么的人，不提交账本就会漂移。",
			parameters: {
				type: "object",
				properties: {
					patch: {
						type: "object",
						description: '合并补丁，如 {"time":"入夜","characters":{"林霜":{"affinity":35}}}',
					},
				},
				required: ["patch"],
			},
		},
	];
}

export interface ToolRunResult {
	/** 回给模型的 toolResult 文本 */
	text: string;
	/** 过程条短句（无则不出条） */
	activity?: string;
}

/**
 * 执行一次工具调用。未知工具名/参数缺失都返回可读文本（不抛，不打断本拍）。
 * language 供统一工具层装配上下文（M-D1）；省略时按中文。
 */
export async function runStageTool(
	deps: StageToolDeps,
	name: string,
	args: Record<string, unknown>,
	language = "中文",
): Promise<ToolRunResult> {
	// 统一工具层优先（PLAN-RP-TOOLING M-D1/M-D3）：世界书族与向量库族由那一份实现作答
	const unified = await runUnifiedStageTool(deps, name, args, language);
	if (unified) return { text: unified.text, ...(unified.activity ? { activity: unified.activity } : {}) };

	if (name === "writing_guide") {
		const topic = typeof args.topic === "string" ? args.topic.trim() : "";
		const text = topic ? deps.getSkill?.(topic) : undefined;
		if (!text) {
			return { text: `没有主题「${topic}」的方法论。按已有理解直接动笔即可。` };
		}
		return {
			text: `【写作方法论·${topic}】以下为本预设的写作参考——照着写；机械纪律由验收器把关，无需自查。\n\n${text}`,
			activity: `读方法论「${topic}」`,
		};
	}

	if (name === "world_state_get") {
		const s = deps.getState();
		return { text: `${deps.formatState(s)}\n\nRAW:\n${JSON.stringify(s)}`, activity: "查账本" };
	}

	return { text: `未知工具 ${name}——本拍可用：lorebook_search / memory_search / world_state_get。` };
}
