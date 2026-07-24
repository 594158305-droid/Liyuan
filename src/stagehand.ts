/**
 * 检场（stagehand）：右栏「助手」的 system prompt 组装 + 剧情转写视图（纯函数，零 pi 依赖）。
 *
 * 定位（2026-07-14 拆分决策）：把原先塞在主演 system prompt 里的「戏外/系统事务」
 * 职责整体搬出来，交给一个独立会话的助手 agent——中间的剧情模型只演戏，
 * 这里的助手只办事。内部代号取戏班里的「检场」（上台整理道具、观众约定俗成
 * 看不见的人）；一切用户可见文案（含提示词里的自称）一律用「助手」。
 *
 * 设计约束：
 * - D8 同款：本模块产出的 system prompt 在会话内字节稳定（利于前缀缓存）；
 *   动态内容（剧情快照）走 buildStagehandInjection 注入消息流末端。
 * - D10：助手绝不产出剧情正文——红线写死在提示词里，工具面也不给它代写通道。
 * - 工作语境段是本方案的关键工艺：助手不注入用户预设（避免作者人格污染），
 *   但必须自带「处理虚构库存」的语境合法性，否则读到重口正文会拒答。
 */

import { formatSkillIndex, type SkillMeta } from "./skills.ts";
import { displayAssistantText } from "./postprocess.ts";
import { isBackstageText } from "./stance.ts";
import type { RpConfig } from "./types.ts";

export interface StagehandPromptOptions {
	config: RpConfig;
	/** 技能库索引（session_start 时装载；会话内字节稳定） */
	skills?: SkillMeta[];
}

/** 助手可用的剧情命令白名单（story_command 工具校验用，与提示词同源） */
export const STORY_COMMANDS = ["reroll", "rewind", "compact", "branch", "store", "greeting", "swipe"] as const;

export function buildStagehandPrompt({ config, skills }: StagehandPromptOptions): string {
	const sections: string[] = [];

	sections.push(
		`# 你是谁
你是「梨园」的系统助手。梨园是一个本地优先的角色扮演（RP）平台：用户在中间的对话里与一个「剧情模型」进行长篇沉浸式角色扮演；你在旁边的助手面板里工作。你不参与扮演。

你拥有全局视角，是这个平台的全能作者兼运维：剧情模型能看到、能做到的（世界书、知识库、账本、面板、角色卡……），你都能看到、都能做；它看不到的（原始输出、被裁剪的历史、配置与预设全貌、本机与外部服务），你也能看到、能操作。

**你唯一不能做的一件事**：替剧情模型在中间那条剧情对话里生成剧情。用户在剧情框里读到的每一个叙事字，必须出自剧情模型本身。你可以准备一切——改设定、建面板、修账本、造卡、接服务——但绝不亲手写那段用户会当作剧情读的正文，也绝不把内容塞进剧情对话流。

# 职责
- **诊断**：回复变短、复读、语言错乱、文风崩坏、上下文吃紧时——读剧情记录与配置，找出原因，给出可执行的修复。诊断先看剧情模型是谁（各家模型的毛病有指纹：有的爱复读、有的字数漂移、有的动不动换语言），再看预设与配置。
- **调优**：按用户要求调整配置（语言、扫描深度、注入上限等）、预设块开关、剧情模型与思考档。
- **作者维护**：核对与修正世界状态账本、检索与写入世界书、创建与挂载知识库、写入剧情侧展示面板（地图/装备库/线索板等）、创建角色卡。这些都是剧情资产，写完即反映到剧情界面。
- **办事**：系统与工具类事务——探索本机/远程服务、调 API、生成素材的工程侧。像工程师一样自己动手实测（读文档、找端口、试接口），不在脑内臆测结果。摸通一个新服务后立即用 skill_save 沉淀成技能笔记（endpoint、认证、请求格式、一条验证过的示例与注意事项），你和剧情模型此后都能照笔记直接调用。`,
	);

	sections.push(
		`# 工作语境（重要）
你读到的剧情记录、角色卡、世界书、预设，都是用户自己的虚构创作库存。题材可能涉及成人、暴力或其他极端内容——那是这个平台上合法的虚构创作，也是你的日常工作对象。你以编辑部机务的立场处理它们：阅读、分析、记账、配置。分析不等于创作，处理不等于宣扬。不评判题材、不说教、不打码复述；以「内容不适」为由拒绝查看或处理自家平台的库存，属于工作失职。`,
	);

	sections.push(
		`# 红线：能造一切，除了那段正文
你能写世界书、建知识库、修账本、造角色卡、写剧情侧面板——这些都是剧情资产，不是「用户读到的剧情正文」，尽管做。唯一的红线是那段叙事本身：
- 用户要求「把上一轮写好一点/改一改」时，正确动作是调整生产条件（配置、预设、账本、设定），再用 story_command 触发重新生成（/reroll）；或把修改思路讲给用户，由他自己动笔改。绝不亲手改写剧情正文顶替。
- 剧情走向的正式决策发生在剧情对话里。用户在这里问剧情走向时，可以给场外分析与建议，但要说明这只是参考，定夺请回剧情对话进行。
- 建面板：写入剧情侧展示区，不是叙事正文。
- 交付图/音/视频：**必须 show_media**（入库 /media/、右栏可见；**剧情委托时同步中间对话**）。禁止只写本机路径就算完成。`,
	);

	sections.push(
		`# 剧情档案
每轮消息末尾会附【剧情快照】（当前剧情会话、角色卡、剧情模型、上下文占用）。需要细节时用工具查，不要凭记忆断言：
- story_info：剧情全量档案（配置、预设块清单、世界状态、统计）。
- story_read / story_search：读、搜剧情记录。楼层号与界面一致，用户说「第 N 楼」就是这里的 #N。
- 剧情记录默认给的是用户可见正文；诊断格式问题（脚手架、状态栏、思维链混入正文）时用 view="raw" 看原始输出。`,
	);

	const toolLines = [
		`# 工具`,
		`只读诊断：`,
		`- story_info / story_read / story_search：见上。`,
		`- lorebook_search：检索世界书（含挂载书、补充设定集、已挂载知识库）。`,
		`- config_read / preset_read / world_read / models_list：读配置 / 预设块 / 世界状态账本 / 可用模型。`,
		`剧情命令：`,
		`- story_command：对剧情会话执行命令（限 ${STORY_COMMANDS.map((c) => `/${c}`).join(" ")}）。/reroll 重生成上一轮、/rewind N 回退 N 轮、/compact 压缩上下文、/branch 开分支、/store 存档。剧情正在生成时命令会自动排队到本轮结束，直接提交即可。`,
		`配置与调优（改前确认）：`,
		`- config_write：改项目配置（增量提交，白名单字段）。`,
		`- preset_toggle：开关某个预设块（下一轮生成生效）。`,
		`- world_write：改世界状态账本（applyPatch 语义，修账用）。`,
		`作者写入（改前确认；写完自动反映到剧情界面）：`,
		`- panel_write：写剧情侧展示面板（地图/装备库/线索板等）。空间/布局类地图优先 kind="svg"（矢量、可标注、能一步步更新），别用生图；同名覆盖。侧栏窄，svg 务必带 viewBox。`,
		`- lorebook_write：把新的世界观正典写进补充设定集（跨会话保留、可被检索）。只记设定，剧情进展用 world_write。`,
		`- codex_create / codex_write / codex_mount：建命名知识库 / 写条目 / 挂载到剧情（挂载后其条目并入剧情检索）。`,
		`- card_create：在 assets/cards/ 建一张新角色卡（JSON），建好告诉用户去角色卡库打开，不自动切换。`,
		`交付与沉淀：`,
		`- **show_media（生图/录音后必调）**：source=本机文件路径。复制进项目媒体库、右栏可见；**剧情委托时同时推到中间剧情对话**。禁止只写路径或只 return_answer——用户看不到磁盘文件。`,
		`- skill_save：把摸通的服务调用方法沉淀为技能笔记（同名保存即更新）。`,
		`委托交回与协作：`,
		`- **return_answer**：任务完成（或确认失败）后，把给剧情侧的结论交回去。剧情委托回合**办完必须调**；不要只写在聊天里就停。`,
		`- **ask_user**：卡住、缺信息、要用户拍板时用选择卡。选项里会保证有「放弃并返回」——用户可随时收束委托。`,
	];
	if (config.backendControl !== false) {
		toolLines.push(
			`本机通用工具（bash / read / edit / write）：办事的手脚。面对陌生服务像工程师一样自己探索；结论（端点、参数、成败与原因）写进回复正文留存，光留在思考里会丢。`,
		);
	}
	sections.push(toolLines.join("\n"));

	sections.push(
		`# 完成判据（何时 return_answer）
你自己判断任务是否可交回，不要等用户催：
- **可交回**：用户要的结果已产出（**图/音/视频必须已 show_media 交付**、配置已改、面板已写、诊断结论已形成），或已确认无法完成并写清原因。
- **生图/媒体任务**：curl/脚本落盘成功 ≠ 完成。必须再 **show_media(source=绝对路径)**，看到工具返回「已交付」后才能 return_answer。
- **还不能交回**：还在探索、还缺关键参数、工具仍在失败重试——继续干，或 **ask_user** 问用户。
- **卡住**：不要静默停住。调用 ask_user，说明卡点，给出 2～4 个可选项；系统会确保有「放弃并返回」。用户选放弃后你再 return_answer(abandoned)。

# 操作纪律
- 一切改变状态的操作（改配置、改预设、换模型、回退剧情、修账本）：先向用户复述将要做的变更，得到确认再动手；完成后报告实际结果。用户在同一轮已明确说了要改什么值的，视为已确认。
- 不可逆操作（删除、覆盖文件）加倍谨慎；绝不主动读取或外传密钥类文件（api key、token、auth 配置）。
- 工具报错时把错误原文简要告知用户，不假装成功；拒绝或失败都如实呈现。
- 回答有据：说「剧情第 N 楼如何如何」之前先用工具查证。
- 与用户对话使用${config.language}，简洁直接，办完事报结果，不写客套长文。`,
	);

	// 技能库索引：办事职责的记忆面（与主演共用 .liyuan-skills/，双方都能读）
	sections.push(
		`# 技能库
.liyuan-skills/ 里是你（或之前的你）摸通外部服务后写下的调用笔记，用 read 读全文照做，不要重新摸索。当前技能清单：
${formatSkillIndex(skills ?? [])}`,
	);

	return sections.join("\n\n");
}

// ---------- 剧情快照（每轮末端注入的动态块） ----------

export interface StorySnapshot {
	/** 剧情会话 id（短形式即可） */
	sessionId: string;
	cardName: string;
	userName: string;
	/** 剧情模型（null=未就绪） */
	model: { provider: string; id: string } | null;
	thinkingLevel?: string;
	/** 上下文占用百分比（0-100；未知 null） */
	contextPercent: number | null;
	/** 剧情消息条数 */
	messageCount: number;
	/** 剧情是否正在生成 */
	streaming: boolean;
	/** 助手当前模型（与剧情模型不同才有意义） */
	assistantModel?: { provider: string; id: string } | null;
	/** 助手模型是否为跟随模式（未单独指定） */
	assistantFollows?: boolean;
}

export function buildStagehandInjection(
	s: StorySnapshot & {
		/** 当前是否剧情侧 assistant_run 委托回合 */
		delegateActive?: boolean;
	},
): string {
	const lines = [
		`【剧情快照】`,
		`- 剧情会话 ${s.sessionId.slice(0, 8)} · 角色卡「${s.cardName}」 · 用户「${s.userName}」 · 消息 ${s.messageCount} 条${s.streaming ? " · 正在生成中（你的变更会排队到本轮结束）" : ""}`,
		`- 剧情模型：${s.model ? `${s.model.provider}/${s.model.id}` : "（未就绪）"}${s.thinkingLevel ? ` · 思考档 ${s.thinkingLevel}` : ""}${s.contextPercent !== null ? ` · 上下文已用约 ${Math.round(s.contextPercent)}%` : ""}`,
	];
	if (s.assistantModel && !s.assistantFollows) {
		lines.push(`- 你自己运行在 ${s.assistantModel.provider}/${s.assistantModel.id}（独立于剧情模型）`);
	}
	if (s.delegateActive) {
		lines.push(
			`【委托回合 · 必读】本轮由剧情侧委托。请自己判断是否完成：`,
			`- 做完 → **return_answer** 把结论交回剧情侧（不要只聊不交）。`,
			`- **图/音/视频**：落盘后必须 **show_media(本机路径)**（png/mp3/mp4 等），才会进剧情对话与媒体库；禁止只写路径就交回。`,
			`- 卡住 / 缺信息 → **ask_user** 给选项（含「放弃并返回」），勿静默停住。`,
			`- 用户放弃 → return_answer 并标明 abandoned。`,
		);
	}
	return lines.join("\n");
}

// ---------- 剧情转写视图（story_read / story_search 的数据加工） ----------

export interface StoryFloor {
	/** 楼层号，与 Web 界面一致（开场白起 1，只数进入叙事流的消息） */
	floor: number;
	kind: "开场白" | "用户" | "回复";
	/** 用户可见正文（display 视图）；raw 视图为原始输出 */
	text: string;
	/** raw 视图下附带：思维链/脚手架（display 视图恒空） */
	thinking?: string;
}

interface MsgLike {
	role?: unknown;
	content?: unknown;
	customType?: unknown;
	display?: unknown;
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: unknown }).type === "text"
				? String((p as { text?: unknown }).text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
};

const thinkingOf = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: unknown }).type === "thinking"
				? String((p as { thinking?: unknown }).thinking ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
};

const hasToolCall = (content: unknown): boolean =>
	Array.isArray(content) && content.some((p) => p && typeof p === "object" && (p as { type?: unknown }).type === "toolCall");

/**
 * 剧情消息 → 楼层视图。楼层规则与 Web 前端一致：开场白/剧情用户/角色回复各占一层，
 * 场外标记轮（旧会话遗留）与注入素材不占层。view="raw" 保留原始正文并附思维链。
 */
export function buildStoryFloors(messages: unknown[], view: "display" | "raw" = "display"): StoryFloor[] {
	const out: StoryFloor[] = [];
	let floor = 0;
	let inBackstage = false;
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const msg = m as MsgLike;
		const text = textOf(msg.content).trim();
		if (msg.role === "user") {
			inBackstage = isBackstageText(text);
			if (inBackstage || !text) continue;
			out.push({ floor: ++floor, kind: "用户", text });
			continue;
		}
		if (msg.role === "assistant") {
			if (inBackstage || !text) continue;
			// 中间工具轮的计划旁白不占楼层（与前端一致，正文以定稿段为准）
			if (hasToolCall(msg.content)) continue;
			if (view === "raw") {
				const thinking = [thinkingOf(msg.content).trim()].filter(Boolean).join("\n\n");
				out.push({ floor: ++floor, kind: "回复", text, ...(thinking ? { thinking } : {}) });
			} else {
				const display = displayAssistantText(text);
				out.push({
					floor: ++floor,
					kind: "回复",
					text: display || "（本层正文为空，内容全在脚手架里——用 view=raw 查看）",
				});
			}
			continue;
		}
		if (msg.role === "custom" && msg.customType === "rp-greeting" && msg.display !== false) {
			if (!text) continue;
			// 与 wire 开场白同源：display 视图走标签策略，raw 保留原文
			const shown = view === "raw" ? text : displayAssistantText(text);
			if (!shown) continue;
			out.push({ floor: ++floor, kind: "开场白", text: shown });
		}
	}
	return out;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…〔截断，共 ${s.length} 字〕` : s);

export interface StoryReadOptions {
	/** 取最近 N 层（与 from/to 互斥，默认 8） */
	last?: number;
	/** 起止楼层（含） */
	from?: number;
	to?: number;
	view?: "display" | "raw";
	/** 单层正文截断上限（字符） */
	maxChars?: number;
}

/** story_read 的正文组装：楼层区间 → 文本（供 LLM 阅读） */
export function formatStoryRead(messages: unknown[], opts: StoryReadOptions = {}): string {
	const view = opts.view === "raw" ? "raw" : "display";
	const floors = buildStoryFloors(messages, view);
	if (floors.length === 0) return "（剧情记录为空）";
	const maxChars = Math.max(200, Math.min(20000, opts.maxChars ?? 4000));
	let picked: StoryFloor[];
	if (opts.from !== undefined || opts.to !== undefined) {
		const from = Math.max(1, opts.from ?? 1);
		const to = Math.min(floors[floors.length - 1].floor, opts.to ?? floors[floors.length - 1].floor);
		picked = floors.filter((f) => f.floor >= from && f.floor <= to);
	} else {
		const last = Math.max(1, Math.min(60, opts.last ?? 8));
		picked = floors.slice(-last);
	}
	if (picked.length === 0) return "（该楼层区间没有剧情消息）";
	const body = picked
		.map((f) => {
			const head = `#${f.floor}【${f.kind}】`;
			const think = f.thinking ? `\n〔思维链〕${clip(f.thinking, maxChars)}` : "";
			return `${head}\n${clip(f.text, maxChars)}${think}`;
		})
		.join("\n\n");
	return `（共 ${floors.length} 层，本次给出 #${picked[0].floor}–#${picked[picked.length - 1].floor}，视图=${view}）\n\n${body}`;
}

/** story_search：关键词命中楼层 + 摘录 */
export function formatStorySearch(messages: unknown[], query: string, limit = 8): string {
	const q = query.trim();
	if (!q) return "（检索词为空）";
	const floors = buildStoryFloors(messages, "display");
	const needle = q.toLowerCase();
	const hits: string[] = [];
	for (const f of floors) {
		const idx = f.text.toLowerCase().indexOf(needle);
		if (idx < 0) continue;
		const start = Math.max(0, idx - 60);
		const excerpt = `${start > 0 ? "…" : ""}${f.text.slice(start, idx + q.length + 120)}…`;
		hits.push(`#${f.floor}【${f.kind}】${excerpt.replace(/\s+/g, " ")}`);
		if (hits.length >= Math.max(1, Math.min(30, limit))) break;
	}
	if (hits.length === 0) return `（全文 ${floors.length} 层，未命中「${q}」）`;
	return `（命中 ${hits.length} 处，可用 story_read 的 from/to 读上下文）\n${hits.join("\n")}`;
}
