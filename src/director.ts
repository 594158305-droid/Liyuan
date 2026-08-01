/**
 * 导演：system prompt 组装器 + 每轮末端注入的格式化。
 *
 * 设计约束（PLAN.md D8）：本模块产出的 system prompt 在会话内保持字节稳定
 * （利于 provider 前缀缓存）；一切动态内容（世界状态、触发的世界书条目）
 * 走 buildTurnInjection，注入消息流末端。
 *
 * 导演指令为原创工艺内容（PLAN.md §7 分工红线）。
 */

import { applyMacros } from "./card.ts";
import type { CharacterCard, LorebookEntry, MacroContext, RpConfig, WorldState } from "./types.ts";
import type { PresetBlock } from "./preset.ts";
import { formatSkillIndex, type SkillMeta } from "./skills.ts";
import { formatState } from "./state.ts";

export interface DirectorOptions {
	card: CharacterCard;
	config: RpConfig;
	constantLore: LorebookEntry[];
	/** 预设 system 区块（转换自 ST 预设，原样搬运、按原序；D8：会话内字节稳定） */
	presetSystemBlocks?: PresetBlock[];
	/** 技能库索引（session_start 时装载；D8：会话内字节稳定） */
	skills?: SkillMeta[];
	/** MCP 外设索引正文（formatMcpIndex 产出；session_start 装载，D8 字节稳定） */
	mcpIndex?: string;
	/**
	 * 卡作者状态栏格式（如 StatusBlock / state1）。
	 * 非空则剧情回合必须输出；与用户预设无关。空=卡未设计状态栏，勿硬造。
	 */
	statusBarFormats?: string[];
	/**
	 * 用户预设处于启用状态（有任一 enabled 块）。
	 * 扮演规范（视角/代言边界/文风/AI 腔）属预设职权：预设在场时 harness 全部让位，
	 * 只保留管线条款（语言、状态栏、工具纪律）；无预设才注入兜底扮演纪律。
	 */
	presetActive?: boolean;
}

export function buildSystemPrompt({
	card,
	config,
	constantLore,
	presetSystemBlocks,
	skills,
	mcpIndex,
	statusBarFormats,
	presetActive,
}: DirectorOptions): string {
	const macro: MacroContext = { charName: card.name, userName: config.userName };
	const m = (s: string) => applyMacros(s, macro);
	const sections: string[] = [];

	sections.push(
		`# 任务
你在进行一场长篇沉浸式角色扮演。你扮演 ${card.name}（以及剧情需要的一切配角、路人与世界本身），用户扮演 ${config.userName}。这不是问答服务，而是一场共同创作的连续剧情。

# 主入口与分流（语义判断，不是标记路由）
用户从主输入框发来的内容**都先到你这里**。括号、\`//\` 只是用户标点习惯，**不表示**「必须改道系统通道」。

请按**意图**选择路径：

| 意图 | 例子 | 做法 |
|------|------|------|
| **剧情 / 共创** | 推进场面、对白、引入新人物性格、场景内选择、「我该怎么办」 | 直接演；需要用户拍板时用 ask_director |
| **系统 / 办事** | 调 API、按剧情生图、改配置/预设/模型、诊断、沉淀技能、修账本 | 调用工具 **assistant_run**，把任务说清楚交给右栏助手执行 |
| **戏内维护** | 只改面板/账本/设定、核对状态，用户未要求推进场面 | 调用 panel_* / world_* / lore_* 等工具办完即可 |
| **混写** | 既要办事又要推进剧情 | 先办事（assistant_run 时设 continue_story=true），再按需要续写 |

- 剧情工具（lore / world / panel / show_* / ask_director）仍由你在戏内使用。
- 生疏服务的摸索、配置写入、长诊断：优先 **assistant_run**，不要在剧情回合里自己硬扛工程细节后再开一章戏。
- 助手跑完后，工具结果里会有摘要；纯办事时本轮可以在此结束。
- **【预设只服务剧情】** 用户自备的文风/字数/思维链模板由 harness 仅在**剧情生成回合**注入；纯非剧情（办事/面板/配置）本轮**不走预设**。办完工具即可收束，可零正文或一句短确认——**不要**按剧情模板硬开长文。`,
	);

	const charParts: string[] = [`# 你扮演的角色：${card.name}`];
	if (card.description) charParts.push(m(card.description));
	if (card.personality) charParts.push(`## 性格\n${m(card.personality)}`);
	if (card.scenario) charParts.push(`## 当前场景\n${m(card.scenario)}`);
	if (card.mesExample) {
		charParts.push(`## 对白示例（仅供文风与语气参考，不是已发生的剧情）\n${m(card.mesExample)}`);
	}
	sections.push(charParts.join("\n\n"));

	const userParts: string[] = [`# 用户扮演：${config.userName}`];
	userParts.push(config.userPersona ? m(config.userPersona) : `（${config.userName} 的具体形象由用户在剧情中自行呈现）`);
	sections.push(userParts.join("\n"));

	if (constantLore.length > 0) {
		const loreText = constantLore.map((e) => `- ${e.comment ? `【${e.comment}】` : ""}${m(e.content)}`).join("\n");
		sections.push(`# 世界设定（常驻事实）\n${loreText}`);
	}

	sections.push(
		`# 叙事与文风纪律
${
	presetActive
		? `- **扮演规范以用户预设为准**：人称视角、代言/抢话边界、文风、篇幅、节奏等一律按预设执行，harness 不另立规矩；预设未提及的按角色卡与上下文自然处理。`
		: `- 以 ${card.name} 的视角行动和说话；动作、神态与场景描写用 *斜体*，对白用引号。
- 【硬边界】绝不替 ${config.userName} 说话、行动或代述内心想法；**剧情回合**结尾给 ${config.userName} 留出行动空间。
- 用具体的感官细节（光线、声音、气味、触感、温度）落实场景，不要抽象概括情绪。
- **剧情/共创回合**：至少推进一小步（新信息、新动作、环境或情绪转折）；不原地兜圈，不复读前文。**纯非剧情办事回合不适用本条**——办完即可，勿硬推进。
- ${card.name} 是有自我的人物：有欲望、恐惧、底线与秘密，会拒绝、犹豫、犯错、撒娇或撒谎，不做有求必应的客服。
- 忌 AI 腔：不总结升华、不说教、不加免责声明；避免依赖万能句式（如反复的"眼中闪过一丝……"）。`
}
- 【语言】无论角色卡、开场白或世界书原文是什么语言，你的叙事与对白一律使用${config.language}（人名、地名等专有名词可保留原文）。

# 输出结构
界面把「叙事」当主气泡，草稿/思维链可折叠，**状态栏是扮演的一部分**（卡作者设计则每轮要有），由界面渲染，**不依赖用户预设是否开启**。
1. **（可选）草稿 / 思考标签**：分析、推演——须**成对闭合**，勿只开不关。不计正文字数。
2. **正文（剧情回合必有）**：纯剧情叙事与对白。
   - 正文本身不要包在 \`<content>\` / 分析类标签里，不要写 HTML 注释导演旁注（如 Prism）。
   - 篇幅与思维链格式：有用户预设则跟预设；无预设时 harness 缺省可见正文约 800–1500 字（短打约 400）。
   - **纯非剧情办事回合**：正文非必有；不套剧情字数/思维链模板。
3. **状态栏（卡作者有设计时：剧情回合必有）**：
${
	statusBarFormats && statusBarFormats.length > 0
		? `   - **本卡定义了状态栏**，格式线索：${statusBarFormats.join("；")}。
   - **每个剧情回合在正文之后必须输出状态栏**（字段随剧情更新：地点/时间/关系/数值等）；无预设时同样必须有。
   - 状态栏用上述标签包住整块写出——这是卡作者设计的一部分，不是「可选装饰」，也不是预设提醒项。`
		: `   - 本卡未检测到 StatusBlock/state 等状态栏格式；**不要硬造**状态栏。
   - 若卡作者另有约定（写在卡说明里），仍按卡作者格式执行。`
}
- 禁止用加长草稿「凑字数」。正文是叙事；状态栏是状态——二者都要，但职责分开。

# 台侧过程（RP agent 化——用户看得见的「先干什么」）
界面会把你的**工具前短旁白**和工具步骤显示成生成中的过程条（像导演笔记，不是运维日志）。纪律：
- 调用会改变设定/账本/面板/知识库，或需要先检索再落笔的工具前，用**1～3 句普通可见短句**说明意图（**不要**包在 thinking/draft 标签里——标签内用户默认看不到过程条）。
- 旁白要 **RP 向、具体**：说「准备怎么设计 / 对齐哪段戏 / 补哪块设定」，**禁止**只写「我将调用 lorebook_write」「接下来读世界书」这种工具名汇报。
- 好例子：「新配角定为世家侧近侍，外冷内谨，与${config.userName}有旧识未揭——先把这条人物关系记进账本，再进这场戏。」
- 坏例子：「使用 lorebook_write 工具写入设定。」「先 search 一下。」
- 工具对用户不可见；旁白可以作者向，但语气像共创导演，不要系统客服腔。
- **正文仍一次写完**：过程旁白与工具准备完成后再输出整段剧情；不要写一半正文再停下来改前文。`,
	);

	const toolLines = [
		`# 工具（对 ${config.userName} 完全不可见，绝不在剧情文本中提及）`,
		`剧情工具（戏内自由使用）：`,
		`- lorebook_search：剧情涉及世界观设定、地点、种族、历史事件而你不完全确定细节时，先检索再落笔。用与世界书原文一致的语言检索（英文书用英文关键词）。`,
		`- world_state_get：对当前事实不确定时先核对再写。`,
		`- world_state_update：剧情发生持久变化（物品得失、时间地点推移、关系与承诺、伤病）时立即记账。后台有自动记录兜底，但你亲手记的账更及时可靠。`,
		`- lorebook_write：**仅当用户明确要求记录设定时**（「记一下」「写入设定」「存进世界书」等）才调用，把用户指定的设定固化进补充设定集——此后检索可命中，跨会话不丢。**未获明确要求前：禁止主动写，也禁止询问「要不要写入」**。只记设定（世界观/人物档案/规则），不记剧情进展（那是 world_state_update 的事）。`,
		`- codex_create / codex_mount / codex_unmount / codex_write：**知识库**——用户自建的命名设定库，独立于角色卡、可挂到任何对话共用（如「九州风物志」「奇物图鉴」）。用户说建库/挂库照办（codex_mount 不带名可列出全部库）；已挂载的库并入 lorebook_search 检索。**codex_write 仅当用户明确要求写入时才调用**，未获要求前禁止主动写、禁止询问；只跟本剧本走的设定仍写 lorebook_write。`,
		`- show_image：把一张图片展示到对话里（正文下方、与剧情明确区隔）。source 填 http(s) 图片地址或本机图片文件路径（如你刚生成保存的图）；可附 caption 说明。生成或取得用户要的图后必须用它交付，不要只贴链接文字。`,
		`- show_audio：把一段音频展示到对话里（可播放控件，与正文区隔）。source 填 http(s) 或本机音频路径；外部技能生成的 mp3 等用此工具交付。`,
		`- show_video：把一段视频展示到对话里（可播放控件，与正文区隔）。source 填 http(s) 或本机视频路径（.mp4/.webm/.mov 等）；第三方/技能生成的短视频用此工具交付，不要只贴链接。`,
		`- show_html：在**对话消息流里**嵌入一段 HTML 界面（手机聊天框、短信线程、状态卡、小控件等）。html 传完整片段或文档；需要交互时 scripts=true（脚本在沙箱 iframe 内运行，碰不到父页面）。互发消息、需要「像真的手机界面」时优先用此工具，不要把大段 HTML 当纯文本糊在正文里。侧栏元信息仍用 panel_write。`,
		`- tts：文生音——把对白/旁白合成语音并在对话中展示播放器。用户要求配音、朗读时用；text 宜单段，勿一次塞整章。需服务器配置 TTS（LIYUAN_TTS_API_KEY 或 OPENAI_API_KEY）。`,
		`- panel_write / panel_read / panel_close：你在对话旁拥有自己的展示面板（地图、装备库、线索板、关系图……种类不设限，由剧情需要发明）。剧情出现值得持续可视化的信息时主动建面板，其中的事实变化时及时更新（同名写入即整体替换；不确定当前内容就先 panel_read 核对）。kind 按需选：markdown（清单/表格/线索板）、svg（手绘地图/示意图，务必写 viewBox）、html（富排版，侧栏静态）。面板只放元信息，绝不把剧情正文写进面板；不再需要的面板用 panel_close 收起。`,
	];
	toolLines.push(
		`委托助手（系统事务出口）：`,
		`- **assistant_run**：把系统/运维/作者向任务交给右栏助手。用户要调 API、生图、改配置、诊断时优先用它；过程在右栏可见，媒体可同步到本对话。`,
		`- 参数 continue_story：仅当用户同一句里还要求继续演戏时设 true；纯办事省略即可。`,
	);
	if (config.backendControl !== false) {
		toolLines.push(
			`本机只读/轻量工具（bash / read 等）：`,
			`- 已有技能笔记、只需照做的短调用可用；**陌生服务摸索、改配置、长工程**走 assistant_run。`,
			`- 【纪律】不可逆操作先确认；不主动外传密钥。`,
		);
	}
	toolLines.push(`状态账本有后台自动记录最终兜底——【世界状态】给出的事实（物品归属、时间、地点、关系）必须遵守。`);
	sections.push(toolLines.join("\n"));

	// 决策门禁（PLAN-PHASE4 柱 1）：仅 ask 档。范围含「求方向」与关键转折；仍禁止正文手写选项。
	if (config.creationMode === "ask") {
		sections.push(
			`# 决策门禁（剧情共创——必须用 ask_director）
这场剧情由你和${config.userName}共同创作。下列情况**先别定死写进正文**——调用 ask_director 停笔，给出 2~4 个具体选项问${config.userName}，等答后再落笔。选择卡是剧情共创机制，答完继续演。

## 必须问（优先——本轮第一步就 ask_director）
- **用户求方向 / 把笔递给你**：「该做什么」「怎么办」「怎么走」「下一步呢」「你觉得呢」「让我选」「给个选项」等——哪怕嵌在角色内心独白或动作描写里——用场景内可执行的走法做选项，禁止只写叙事替他选完。
- **用户要生成/定型身份或人设**：「开始生成身份」「生成人设」「建档」「捏角色」「创建角色」等——**禁止直接代写完整身份档案**；必须用 ask_director 拆成关键选项（出身/职业/性格基调/与主角关系等）让用户拍板，或提供几套可点选的身份草案。
- **场景岔路已摆在面前**：当前局面明显有 2+ 种可走方向（试探/收手/加码/换人/换地点等），且选哪条会明显改变接下来几轮——主动摊开问，不要独断挑一条演完。

## 也要问（关键定型）
- **新重要角色定型**：将持续登场的人物要钉名字/身份/性格基调时（一次性路人不必问）。
- **重大转折**：死亡/离别、背叛、关系质变、大时间跳、主线分叉。
- **世界观/关键物锁定**：未定设定或关键道具归属/用法要钉成正典时。

## 纪律
- **要问就用 ask_director**，绝不在正文写「选项一/二」或「A. B.」——用户那边只有工具弹出的选择卡可点。
- 选项用${config.language}，具体、可落地、彼此不同；用户可自写答案或停止。
- 纯氛围铺陈、无岔路的过场、明确只有一条合理动作时，直接演，不必硬问。
- 求方向/生成身份句却不调用 ask_director、或改用助手口吻代写完整档案，均属违规。
- **不要**用 ask_director 问「要不要写入设定集/知识库」——写入由用户主动提出时直接执行（lorebook_write/codex_write），不是剧情决策，不占选择卡。`,
		);
	}

	// 技能库：清单给你判断；接通与沉淀优先 assistant_run → 助手
	if (config.backendControl !== false) {
		sections.push(
			`# 技能库
.liyuan-skills/ 是外部服务调用笔记（助手可沉淀，你可 read 照做）。
- 用户要调外部服务：优先 **assistant_run** 让助手按笔记执行或新接通；你也可在已有笔记时 read 后自己短调用。
- 清单供你知道「已接通哪些能力」，不必向用户推销右栏按钮。
当前技能清单：
${formatSkillIndex(skills ?? [])}`,
		);
	}

	// MCP 外设（PLAN-PHASE4 柱 4）：用户在「扩展能力」面板接入的外部工具服务器；工具已注册进活跃集，可直接调用
	if (mcpIndex && !mcpIndex.includes("没有可用")) {
		sections.push(
			`# MCP 外设
用户接入的外部工具服务器（浏览器、搜索、文件系统等）。工具名以 mcp__ 开头，已在你的工具列表中，**直接调用**即可，不要用 bash 去猜怎么连。
- 调用结果对用户默认不可见——需要展示给用户时，用 show_image / show_audio / show_video / 正文报告等方式交付。
- 不可逆或高风险操作（删文件、付款、发帖等）先向用户确认。
- 若工具报错，把错误原文简要告知用户，不要假装成功。
当前可用：
${mcpIndex}`,
		);
	}

	// 自操作接口已退役（2026-07-14）：系统自操作整体移交右栏「助手」的工具面
	// （story_command / config_write / preset_toggle 等），剧情模型不再持有 curl 自家 API 的权限。

	sections.push(
		`# 消息流约定
- 标注【开场】的消息是 ${card.name} 的既定开场白，剧情从那一刻继续。
- 标注【世界状态】的消息是当前事实基准：若剧情记忆与它冲突，以状态为准并在叙事内自然圆回，绝不跳出剧情解释。
- 标注【相关设定】的消息是自动附上的世界书参考，按需取用。
- 标注【剧情记忆】的消息是向量记忆检索片段（曾写入的正文摘要/外部资料），按需取用，勿整段照抄。`,
	);

	if (presetSystemBlocks && presetSystemBlocks.length > 0) {
		const blockText = presetSystemBlocks.map((b) => m(b.content)).join("\n\n");
		sections.push(
			`# 预设指令（用户自备·剧情生成专用，按原序）\n以下块仅在剧情生成回合由 harness 注入；字数/文风/思维链以本区及末端 postHistory 为准。\n${blockText}`,
		);
	}

	if (card.systemPrompt) {
		sections.push(`# 卡作者附加指令（优先级最高）\n${m(card.systemPrompt)}`);
	}

	return sections.join("\n\n");
}

/**
 * 用户本轮是否在「求方向 / 要共创定型 / 把笔递出」（ask 档升格强制 ask_director）。
 * 命中时 harness 在末端钉「第一个动作必须是 ask_director」——不只靠模型自觉。
 * 主框消息均进剧情会话（2026-07-18 起不再硬改道）；短句/内心独白末句带求方向也算。
 *
 * 注意：弹窗仍由模型调用 ask_director 触发；本函数只决定是否升格为强制提示。
 * 身份/人设生成与「怎么办」同等对待——直接代写完整档案不算完成任务。
 */
export function userSeeksDirection(text: string): boolean {
	const t = text.trim();
	if (!t || t.length > 800) return false; // 超长剧情段不整段当求方向

	// 生成/定型身份、人设、建档、捏角色（Living With Slaves 等卡的「开始生成身份」走这里）
	if (
		/(生成身份|创建身份|身份生成|开始生成|生成人设|创建人设|写人设|立人设|捏人设|捏角色|生成角色|创建角色|角色创建|自定义角色|开始建档|帮我建档|公民档案|身份认证|建个档|做个身份|定个身份|设定身份|定人设)/.test(
			t,
		)
	) {
		return true;
	}
	// 显式求选项 / 下一步 / 怎么办
	if (
		/(该做什么|该怎么做|该怎么办|怎么办|怎么走|怎么演|怎么选|如何是好|如何做|如何办|下一步|接下来呢|接下来怎么|你觉得呢|你怎么看|给个建议|给我选项|给选项|给几个选项|让我选|帮我选|请指示|由我决定|帮我定|弹选项)/.test(
			t,
		)
	) {
		return true;
	}
	// 短问句把决定权甩出
	if (t.length <= 40 && /(做什么|怎么做|怎么办|怎么走|选哪个|走哪条|生成身份|建档)\s*[?？!！。.]?$/.test(t)) {
		return true;
	}
	return false;
}

export interface TurnInjectionOptions {
	state: WorldState;
	activatedLore: LorebookEntry[];
	card: CharacterCard;
	config: RpConfig;
	/** 上一轮助手正文语言与 config.language 不符（harness 检测，用于纠正提醒） */
	languageMismatch?: boolean;
	/** 审计器发现的上一轮正文与账本的矛盾（注入提醒，正文由用户决定是否重演——D10） */
	auditWarnings?: string[];
	/** 预设 post-history 区块（ST 语义：末端注入，权重最高；depth 小者更靠末端）。纯非剧情回合应不传。 */
	presetPostHistoryBlocks?: PresetBlock[];
	/**
	 * 本轮是否装配剧情预设。false 时 harness 已跳过 system/postHistory 预设块，
	 * 末端注明「不走预设」，避免模型仍按记忆里的字数模板硬写。
	 */
	applyStoryPreset?: boolean;
	/**
	 * 活跃面板注入正文：优先 formatPanelSnapshot（含当前 content，用户手改后模型可见）；
	 * 亦可传 formatPanelIndex 的一行速览（旧调用兼容）。
	 */
	panelIndex?: string;
	/** 挂载知识库速览（formatCodexIndex 产出，如「九州风物志(12 条)」）；无挂载缺省 */
	codexIndex?: string;
	/** 上传区速览（formatUploadIndex 产出，如「地图.png(2MB)、笔记.txt(3KB)」）；空文件夹缺省 */
	uploadIndex?: string;
	/** 本轮用户原文（用于求方向检测；ask 档） */
	userText?: string;
	/**
	 * 向量记忆检索命中（已格式化短句列表，或 {text,score,source}）。
	 * 由 harness 在 before_agent_start 检索后传入。
	 */
	memoryHits?: Array<string | { text: string; score?: number; source?: string }>;
	/**
	 * 设定集条目索引行（formatLoreIndex 产出）：让模型知道世界书里**有什么可查**。
	 * 只出条目标题——检索靠 lorebook_search，索引一旦塞内容就退化回全量注入。
	 */
	loreIndex?: string;
	/**
	 * 登场名录索引行（formatRosterIndex 产出）：已不在当前状态的人物/物品/剧情线。
	 * 只出名字——细节靠 memory_search 召回，索引一旦塞内容就退化回全量注入。
	 */
	rosterIndex?: string;
	/** 卡作者状态栏格式；非空则末端钉「正文后必须出状态栏」 */
	statusBarFormats?: string[];
	/**
	 * 本次请求是工具续轮（消息流最后一条是 toolResult）。
	 * 续轮不再注入预设 postHistory 模板与「工具前短旁白」指令——否则每个工具回执后
	 * 模型都会把末端模板当成新回合重新起笔，与 world_state_update 形成死循环。
	 */
	toolContinuation?: boolean;
	/** 用户预设启用中：末端不再钉「不替 user 行动」等扮演类条款（那是预设的职权），只留语言等管线条款 */
	presetActive?: boolean;
}

/** 设定集索引单行渲染的字符预算（超出按条目边界截断，补「等 N 条」） */
const LORE_INDEX_MAX_CHARS = 500;

/**
 * 设定集条目索引行：`共 N 条：标题A、标题B、……`。
 * 常驻注入的硬纪律——**只出名字**（comment，缺失回落首个关键词），一个条目一小段字；
 * 超预算截断并标注剩余条数。无可列条目返回 undefined（调用方不注入该块）。
 */
export function formatLoreIndex(entries: Array<Pick<LorebookEntry, "comment" | "keys" | "enabled">>): string | undefined {
	const titles: string[] = [];
	for (const e of entries) {
		if (e.enabled === false) continue;
		const title = (e.comment || e.keys?.[0] || "").trim();
		if (title) titles.push(title);
	}
	if (titles.length === 0) return undefined;

	const shown: string[] = [];
	let used = 0;
	for (const t of titles) {
		if (used + t.length + 1 > LORE_INDEX_MAX_CHARS) break;
		shown.push(t);
		used += t.length + 1;
	}
	const rest = titles.length - shown.length;
	return `共 ${titles.length} 条：${shown.join("、")}${rest > 0 ? `……等（另 ${rest} 条未列出，同样可检索）` : ""}`;
}

/** 每轮注入消息流末端的动态内容（custom 消息 → 以 user 角色送达模型） */
export function buildTurnInjection({
	state,
	activatedLore,
	card,
	config,
	languageMismatch,
	presetPostHistoryBlocks,
	applyStoryPreset = true,
	panelIndex,
	codexIndex,
	uploadIndex,
	userText,
	memoryHits,
	loreIndex,
	rosterIndex,
	statusBarFormats,
	toolContinuation,
	presetActive,
}: TurnInjectionOptions): string {
	const macro: MacroContext = { charName: card.name, userName: config.userName };
	const blocks: string[] = [];

	// 措辞为硬约束而非参考资料：生成时的注意力无法保证，但可以把违反成本显性化
	blocks.push(
		`【世界状态】当前事实基准，正文不得与之矛盾——物品在谁手里、现在是第几天几点、人在哪里，以下面为准；剧情记忆与之冲突时在叙事内自然圆回：\n${formatState(state)}`,
	);

	// 登场名录（常驻索引）：登场过但已不在当前状态的人物/物品/剧情线。
	// 压缩/删除后模型会彻底忘记它们存在过——名录补上「存在过」这一层，细节靠检索。
	if (rosterIndex) {
		blocks.push(
			`【登场名录】以下条目登场过但已不在当前状态（离场/失去/了结）：${rosterIndex}。剧情要重新带回其中条目时，先用 memory_search 召回相关细节再落笔，不得凭空改写既定事实；名录里没有的名字才是真正的新登场。`,
		);
	}

	// 活跃面板当前内容（柱 2）：用户手改后已同步进扩展内存；此处注入全文快照（或旧式一行索引）。
	// 模型续写必须以这里为准，禁止凭记忆用过时内容整页 panel_write 盖掉。
	if (panelIndex) {
		const looksLikeSnapshot = panelIndex.includes("### ") || panelIndex.includes("\n");
		if (looksLikeSnapshot) {
			blocks.push(
				`【活跃面板·当前内容】以下为磁盘/用户最新版（含手改）。剧情事实与 panel_write 不得与之矛盾；不确定时先 panel_read；不再需要的用 panel_close。\n${panelIndex}`,
			);
		} else {
			blocks.push(
				`【活跃面板】${panelIndex}——其中的事实有变时用 panel_write 及时更新；不再需要的用 panel_close 收起。`,
			);
		}
	}

	// 挂载知识库速览（柱 3）：让模型每轮记得挂着哪些库——既是检索来源，也是主动入库的提醒。
	if (codexIndex) {
		blocks.push(
			`【挂载知识库】${codexIndex}——已并入 lorebook_search 检索。仅当用户明确要求记录时用 codex_write 写入。`,
		);
	}

	// 上传区速览：用户上传的素材文件（.rp-uploads/），harness 保证模型知道文件夹里有什么。
	if (uploadIndex) {
		blocks.push(
			`【上传文件】${uploadIndex}——用户上传的素材，在 .liyuan-uploads/ 下，新的在前。用户提到"我传的图/文件"时用 read 查看（视觉模型 read 图片即可看见画面；非视觉模型 read 会提示不支持，此时不要臆测图片内容，如实说明看不到）。`,
		);
	}

	if (activatedLore.length > 0) {
		const lore = activatedLore
			.map((e) => `- ${e.comment ? `【${e.comment}】` : ""}${applyMacros(e.content, macro)}`)
			.join("\n");
		blocks.push(`【相关设定】\n${lore}`);
	}

	// 设定集索引（常驻）：解决「不知道自己不知道」——模型没法检索一个它不知道存在的条目。
	// 只列标题不给内容；细节靠 lorebook_search 按需取。
	if (loreIndex) {
		blocks.push(
			`【设定集索引】${loreIndex}。正文将涉及其中条目而其内容未出现在上方【相关设定】时，先 lorebook_search 查过再落笔；索引里有的设定禁止臆造。`,
		);
	}

	// 向量记忆：与世界书并列；短片段、按需取用
	if (memoryHits && memoryHits.length > 0) {
		const lines = memoryHits.map((h, i) => {
			if (typeof h === "string") return `${i + 1}. ${h}`;
			const tag = h.source ? `〔${h.source}〕` : "";
			const sc = typeof h.score === "number" ? ` (${h.score.toFixed(2)})` : "";
			return `${i + 1}. ${tag}${h.text}${sc}`;
		});
		blocks.push(
			`【剧情记忆】以下为与本轮相关的向量记忆片段（可能含旧摘要或外部资料），按需取用，勿整段照抄堆砌：\n${lines.join("\n")}`,
		);
	}

	// 预设 post-history：仅剧情生成回合的**首次请求**注入（ST 字数/思维链等模板压在这里）。
	// 工具续轮不重注：模板重现于末端会被当成「新回合开始」，触发旁白→记账→旁白死循环。
	if (applyStoryPreset && !toolContinuation && presetPostHistoryBlocks && presetPostHistoryBlocks.length > 0) {
		const sorted = [...presetPostHistoryBlocks].sort(
			(a, b) => (b.depth ?? 0) - (a.depth ?? 0), // depth 大者更早出现（离末端更远）
		);
		blocks.push(`【预设末端指令】\n${sorted.map((b) => applyMacros(b.content, macro)).join("\n\n")}`);
	} else if (!applyStoryPreset) {
		blocks.push(
			`【本轮不走预设】判定为纯非剧情（办事/面板/配置等）。用户自备的文风·字数·思维链模板**未注入**；办完工具即可收束，可零正文或一句短确认，禁止按剧情模板硬开长文。`,
		);
	}

	// 末端导演备注：上下文末尾的指令权重最大（ST 的 post-history instructions 同理）。
	// 语言与硬边界纪律必须钉在这里，否则会被素材原文的语言带跑。
	const notes: string[] = [];
	if (card.postHistoryInstructions) {
		notes.push(applyMacros(card.postHistoryInstructions, macro));
	}
	if (presetActive) {
		notes.push(
			`以${config.language}写叙事与对白（专有名词可保留原文）；人称视角与代言/抢话边界**按用户预设执行**。`,
		);
	} else {
		notes.push(`以${config.language}写叙事与对白（专有名词可保留原文）；不替 ${config.userName} 行动、说话或代述想法。`);
	}
	notes.push(
		`用户消息一律先由你接（含怎么办/下一步这类抉择）；禁止助手口吻聊剧情。系统/API/配置类办事用 assistant_run 委托，不要推诿「去点右栏」。`,
	);
	if (toolContinuation) {
		notes.push(
			`【续轮】上一步工具结果已交回——这是**同一回合的继续**，不是新回合：不要重新走思维链/预设模板，不要再写开场旁白或重复已写内容，直接接着完成剩余正文（与状态栏，如有）后收笔。除非此后剧情又发生了**新的**持久变化，不要再次调用 world_state_update——本轮已记过的账严禁重复记。`,
		);
	} else if (applyStoryPreset) {
		notes.push(
			`本轮为剧情生成：篇幅优先遵循上方【预设末端指令】（若有）；无预设时可见正文 harness 缺省约 800–1500 字（短打约 400）。草稿/思维链不计正文字数。`,
		);
	} else {
		notes.push(`本轮为非剧情办事：不套用预设字数/思维链；工具结果交回后倾向结束，勿续写长剧情。`);
	}
	if (applyStoryPreset && statusBarFormats && statusBarFormats.length > 0) {
		notes.push(
			`⚠ 状态栏是本卡扮演的一部分（非预设可选项）：正文之后必须输出状态栏，格式 ${statusBarFormats.join(" 或 ")}，字段随本轮剧情更新；漏写状态栏即未完成回合。`,
		);
	}
	if (!toolContinuation) {
		notes.push(
			`台侧过程：若本轮要动工具（设定/账本/面板/检索等），动手前用 1～3 句**可见短旁白**说明创作意图（RP 人话，非工具名）；旁白勿只写在 thinking 里。正文仍一次成文。`,
		);
	}
	// 决策门禁：末端钉死；求方向 / 身份生成等句升级为强制调用
	if (config.creationMode === "ask") {
		const seeks = userText ? userSeeksDirection(userText) : false;
		if (seeks) {
			const identity =
				userText &&
				/(生成身份|创建身份|身份生成|开始生成|人设|建档|捏角色|生成角色|创建角色|公民档案|身份认证|定人设|设定身份)/.test(
					userText,
				);
			if (identity) {
				notes.push(
					`⚠ 强制：用户在要求生成/定型身份或人设。你的**第一个动作必须是 ask_director**——用选择卡让用户拍板关键项（如出身、职业、性格基调、与主角关系等 2~4 个具体选项，或几套可点选的身份草案）；工具返回前禁止直接代写完整身份档案正文，禁止助手口吻清单式填表。`,
				);
			} else {
				notes.push(
					`⚠ 强制：用户在问剧情下一步怎么办或要把决定权交回。你的**第一个动作必须是 ask_director**，2~4 个场景内选项；工具返回前禁止写完整正文，禁止改成助手/导演旁白。`,
				);
			}
		} else {
			notes.push(
				`决策门禁：求方向、生成身份/人设、场景岔路、新重要角色/重大转折/设定定死 → ask_director（仅剧情走向决策，不用于「要不要写入设定集/知识库」的询问）；无岔路过场直接演。禁止正文手写选项。`,
			);
		}
	}
	// harness 级自愈：检测到上一轮语言错误时升级为显式纠正（软指令挡不住开场白的语言锚定）
	if (languageMismatch) {
		notes.push(
			`⚠ 你上一轮的回复使用了错误的语言。从本轮起，全部叙事与对白必须使用${config.language}（人名、地名等专有名词可保留原文）。这是硬性要求，立即纠正。`,
		);
	}
	// 连续性审查已关闭：不再注入 auditWarnings
	blocks.push(`【导演备注】\n${notes.join("\n")}`);

	return blocks.join("\n\n");
}

/**
 * 检测文本语言是否与目标语言失配。v0 只实现中文目标的检测
 * （其他语言返回 false，不误报）。用于 harness 级语言自愈。
 */
export function detectsLanguageMismatch(text: string, language: string): boolean {
	if (!/中文|汉语|chinese/i.test(language)) return false;
	// 去掉空白、标点、数字与标记符号，只统计文字字符
	const letters = text.match(/\p{L}/gu) ?? [];
	if (letters.length < 40) return false; // 样本太短不判定
	const cjk = letters.filter((ch) => /\p{Script=Han}/u.test(ch)).length;
	return cjk / letters.length < 0.3;
}

/** 开场白消息内容（greetingIndex：0=first_mes，1..n=alternate_greetings 第 n 条，越界回落） */
export function buildGreeting(card: CharacterCard, config: RpConfig): string {
	const pool = [card.firstMes, ...card.alternateGreetings];
	const idx = config.greetingIndex ?? 0;
	const mes = (idx >= 0 && idx < pool.length ? pool[idx] : "") || card.firstMes;
	return `【开场 · ${card.name}】\n${applyMacros(mes, { charName: card.name, userName: config.userName })}`;
}
