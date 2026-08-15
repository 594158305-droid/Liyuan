/**
 * 领域层共享类型。
 * 本目录（src/）不允许 import pi 的任何东西（PLAN.md D3）。
 */

import type { DisplayRule, RuleGroup } from "./cardfront.ts";

/** 归一化后的角色卡（兼容 V1 / V2 chara_card_v2 / V3 chara_card_v3 / ST 导出格式） */
export interface CharacterCard {
	name: string;
	description: string;
	personality: string;
	scenario: string;
	firstMes: string;
	mesExample: string;
	/** 卡作者自带的 system prompt（规范语义：非空时优先于应用默认主提示） */
	systemPrompt: string;
	/** 卡作者的 post-history instructions（注入上下文末端） */
	postHistoryInstructions: string;
	creatorNotes: string;
	alternateGreetings: string[];
	tags: string[];
	/** 卡内嵌世界书（character_book），已归一化 */
	book: LorebookEntry[];
}

/** 归一化后的世界书条目（兼容 ST world info 格式与卡内嵌 character_book 格式） */
export interface LorebookEntry {
	uid: number;
	keys: string[];
	secondaryKeys: string[];
	comment: string;
	content: string;
	constant: boolean;
	enabled: boolean;
	/** 是否要求次要关键词也命中（AND_ANY 语义，v0 仅实现该逻辑） */
	selective: boolean;
	order: number;
}

/**
 * 登场名录：人物/物品/事件三张**追加式索引表**（供 agent 索引，不是给正文全量注入的内容）。
 * 登场过就永远在案——活跃状态里删掉（离场/消耗/了结）后名录仍保留，
 * 配合 memory_search 可召回细节。值为登记时的一句话（可空）。
 */
export interface StateRoster {
	characters: Record<string, string>;
	items: Record<string, string>;
	events: Record<string, string>;
}

/** 列类型元数据（advisory：仅提示，不做强制类型约束） */
export type TableColumnType = "text" | "integer" | "number" | "boolean";

export interface CustomTableColumn {
	name: string;
	type?: TableColumnType;
	/** 列说明（TavernDB 导入时取自 DDL 注释、与中文表头对齐；advisory，供模型/场记参考） */
	description?: string;
}

export interface CustomTable {
	name: string;
	description?: string;
	columns: CustomTableColumn[];
	rows: Record<string, unknown>[];
	/** true = 场记每轮自动维护；内容不注入上下文，与其它表一样走索引 + table_query 现查 */
	auto?: boolean;
}

/** 模板里的表定义（比 CustomTable 多触发器/初始行，DESIGN-template-system §1） */
export interface TableTemplate {
	name: string;
	description?: string;
	columns: CustomTableColumn[];
	/** true = 场记自动维护（建表时写入 CustomTable.auto；内容不注入上下文） */
	auto?: boolean;
	/** 表格说明（TavernDB note；物化时并入表 description） */
	note?: string;
	/** 初始化触发器（TavernDB initNode） */
	initNode?: string;
	/** 新增触发器（TavernDB insertNode） */
	insertNode?: string;
	/** 更新触发器（TavernDB updateNode；有则 auto=true 启发式） */
	updateNode?: string;
	/** 删除触发器（TavernDB deleteNode） */
	deleteNode?: string;
	/** 初始数据行（TavernDB content 数据区；物化建表后填入，表已存在则跳过不重复插） */
	rows?: Record<string, unknown>[];
	/** 维护规则旧字段（历史模板文件的 updateNode+initNode+deleteNode 合并版；新解析不再产出，读旧文件时映射到 updateNode） */
	instructions?: string;
}

/** 一个模板 = 一组表定义（DESIGN-template-system §1；name 为文件标识） */
export interface TableTemplateDef {
	/** 模板名（≤40 字，作文件标识，防路径穿越） */
	name: string;
	description?: string;
	tables: TableTemplate[];
}

/** 结构化世界状态（v0 schema，可扩展） */
export interface WorldState {
	/** 剧情内时间，自由文本（如「第二天清晨」） */
	time: string;
	/** 当前地点 */
	location: string;
	/** 出场角色状态，键为角色名 */
	characters: Record<string, CharacterState>;
	/** {{user}} 的物品栏 */
	inventory: string[];
	/** 自由键值对（誓言、秘密、天气等） */
	flags: Record<string, string>;
	/** 未了结的剧情线/伏笔 */
	plot_threads: string[];
	/** 登场名录（applyPatch 咽喉点自动登记；旧存档无此字段按空处理） */
	roster?: StateRoster;
	/** 自定义表格（键为表名；随世界线/回档一致回退；旧存档无此字段按空处理） */
	tables?: Record<string, CustomTable>;
}

export interface CharacterState {
	/** 对 {{user}} 的好感/态度，-100..100 */
	affinity: number;
	/** 当前身体/处境状态 */
	status: string;
	/** 备注（承诺、得知的秘密等） */
	notes: string;
	/** 当前穿着（服装档案里的 outfit id；随世界线回档） */
	outfit?: string;
}

/**
 * 自定义 agent 的桥权限（storyBridge 按此裁剪，DESIGN-custom-agents §2/§4）。
 * 写权限默认全 false——用户必须显式声明；配错最多是「委托报无权限」，不会产生越权写。
 */
export interface AgentBridgePermissions {
	/** 只读组一键开关：storyMessages / snapshot / worldState / cardName / listModels / deliverMedia。低危。 */
	readStory: boolean;
	/** 写面板：writePanels。中危（面板内容会进上下文，可能被诱导注入指令）。 */
	writePanels: boolean;
	/** 显式改稿：storyEdit（须征得用户同意，走 rp-edited 分支，原文可回滚）。中危。 */
	storyEdit: boolean;
	/** 危险：可触发剧情侧任何斜杠命令（/back /store 等全部命令）。默认 false。 */
	queueCommand: boolean;
	/** 写世界状态：applyStatePatch（用户主权字段直接落盘）。高危。 */
	applyStatePatch: boolean;
	/** 自定义表格读写：tableOps（DESIGN-custom-tables §7，table_create/drop/insert/update/delete 走账本）。中危。 */
	tableOps: boolean;
	/** 发媒体：emitStoryMedia。中危（可在剧情中投放图片/音频）。 */
	emitMedia: boolean;
	/** 刷新素材：refreshStoryMaterials。中危（重装素材/会话，可能打断当前生成）。 */
	refreshMaterials: boolean;
	/** 挂载知识库：mountCodex。低危（只改挂载清单）。 */
	mountCodex: boolean;
	/** 助手生图嵌入剧情正文（Q15）：embedStoryImage。中危（写正文补丁 + slot 登记）。 */
	embedStoryImage: boolean;
}

/**
 * 声明式自定义 agent（liyuan.config.json 的 agents 段，DESIGN-custom-agents §2）。
 * v1 只支持「叙事外」agent（ops/规划/诊断/文审类，不进世界线）；经 assistant_run 工具按 id 委托。
 */
export interface AgentConfig {
	/** 唯一 id（/^[a-z][a-z0-9-]*$/：小写字母开头，后接小写字母/数字/连字符）；委托时引用 */
	id: string;
	/** 面板显示名 */
	name: string;
	/** 显示在 agent 选择器的简介 */
	description?: string;
	/** 独立模型；缺省跟随剧情模型（同助手 syncFollowModel 语义） */
	model?: { provider: string; id: string };
	/** systemPrompt 全文；与 promptFile 二选一 */
	prompt?: string;
	/** 相对 cwd 的 .md 文件路径（systemPrompt 内容来源）；与 prompt 二选一 */
	promptFile?: string;
	/** 可见技能白名单（复用 skills 机制）；缺省为空 */
	skills?: string[];
	/** 工具白名单（只读面由 bridge.readStory 控制）；缺省为空 */
	tools?: string[];
	/** 桥权限；写权限默认全 false（用户必须显式声明） */
	bridge: AgentBridgePermissions;
}

/** 项目配置（app/liyuan.config.json；旧名 rp.config.json 启动时迁移） */
export interface RpConfig {
	/** 角色卡路径（.png 或 .json），相对项目根 */
	card: string;
	/**
	 * 已挂载的独立世界书路径列表（可 0..N 本同时启用；与角色卡无关，换卡不清除）。
	 * 装配顺序即数组合序；条目按内容指纹去重。
	 */
	lorebooks?: string[];
	/**
	 * @deprecated 旧版单本挂载；读时迁入 lorebooks，写盘时只保留 lorebooks。
	 */
	lorebook?: string;
	/** {{user}} 的名字 */
	userName: string;
	/** Web 顶栏的角色显示名覆盖（可选；不影响 {{char}} 宏与提示词，仅显示层。适用于卡 name 是剧本标题的场景卡） */
	displayName?: string;
	/** {{user}} 的人设描述（可选） */
	userPersona: string;
	/** 回复语言 */
	language: string;
	/** 关键词扫描回溯的消息条数 */
	scanDepth: number;
	/** 每轮关键词自动注入的条目上限 */
	maxLoreInjections: number;
	/** 是否在新会话注入开场白 */
	greeting: boolean;
	/** 开场白选择：0=卡的 first_mes（默认），1..n=alternate_greetings 第 n 条；越界回落 first_mes */
	greetingIndex?: number;
	/** 被用户停用的世界书条目（内容指纹列表，见 lorebook.ts loreFingerprint；跨 uid 冲突稳定） */
	disabledLore?: string[];
	/** /import 清洗时额外剥离的标签（叠加在默认思维链/状态栏列表之上，按预设约定配置） */
	importStripTags?: string[];
	/** 转换后的预设文件路径（liyuan-preset.json，可选；由 scripts/convert-preset.mjs 生成） */
	preset?: string;
	/** 本机工具总开关：开则 bash/读写等回到工具底座；本机开发默认开，分发默认关 */
	backendControl?: boolean;
	/** 决策门禁档位（PLAN-PHASE4 柱 1）：ask=关键剧情决策点停笔询问用户；silent=不问，等同旧行为。默认 silent */
	creationMode?: "ask" | "silent";
	/**
	 * 固定楼层压缩：每 N 个叙事轮主动压缩一次早期正文（被裁正文先完整归档进剧情库供召回）。
	 * 0 = 关闭主动压缩，仅保留上下文吃紧时的被动压缩。缺省 30。
	 */
	compactEveryNTurns?: number;
	/**
	 * 给排练断粮（M4.5 慢因 A）：末端明示「思考只用于读题与决定，不在思考里起草正文」。
	 * **默认关**——2026-08-03 high 档 3 轮对照实测证伪：墙钟 +10%、思考 +39%，且组内
	 * σ≈5.9s 远大于组间差 2.5s（模型 high 档思考量本身随机，与这句话无关）。
	 * 保留开关只为将来换模型/换档位时可再测，不作为默认策略。
	 */
	rehearsalGuard?: boolean;
	/**
	 * 右栏「助手」的独立模型（2026-07-14 拆分决策）：缺省=跟随剧情模型。
	 * 剧情尺度大时可在助手面板单独指定宽容系模型（拒答风险与剧情模型解耦）。
	 */
	assistantModel?: { provider: string; id: string };
	/** 一档卡皮肤:显示向美化正则被用户关闭的卡路径列表(默认开;spec 2026-07-22 §7 P1) */
	cardSkinOff?: string[];
	/**
	 * @deprecated 旧版平铺用户显示正则（v1 形态）。读取时若 userRuleGroups 缺失且本字段存在，
	 * 自动迁移为未分组组；写入永远只写 userRuleGroups。
	 */
	userRules?: DisplayRule[];
	/** 用户自建全局正则分组（三分类之一，写入形态；旧 userRules 迁移读取见 cardfront.ts userGroupsOf） */
	userRuleGroups?: RuleGroup[];
	/** 角色正则分组（三分类之二）：卡路径 → 组列表，同 cardRuleOff 模式 */
	cardRuleGroups?: Record<string, RuleGroup[]>;
	/** 卡路径 → 被关闭的卡内嵌显示规则键列表(同 cardSkinOff 模式;键为规则 id/name/source,见 cardfront.ts ruleKey) */
	cardRuleOff?: Record<string, string[]>;
	/**
	 * 卡内嵌规则编辑覆盖层(需求:卡内嵌规则可编辑,不改卡文件):
	 * 卡路径 → 规则键 → 覆盖规则;键 = ruleKey(id??name??source),与 cardRuleOff 同一键体系。
	 * 覆盖后的规则替换原卡内嵌规则进入快照(cardRules 存生效后的 eff);还原 = 删除该键。
	 * 覆盖里的 disabled=true 同样参与关闭判定,与 ruleOff 双保险无冲突。
	 */
	cardRuleOverrides?: Record<string, Record<string, DisplayRule>>;
	/** 自定义 agent 声明（DESIGN-custom-agents §2）：每项一个独立会话/模型/提示词/工具面，经 assistant_run 按 id 委托；v1 只支持叙事外 agent */
	agents?: AgentConfig[];
	/**
	 * 生图插件（能力包）开关（DESIGN-draw §3.0）：插件 id → { enabled, settings }。
	 * 缺省视为 disabled（插件默认关闭，防无感消耗额度）。扫描/加载见 src/draw-plugins/registry.ts。
	 */
	plugins?: Record<string, { enabled?: boolean; settings?: Record<string, unknown> }>;
	/**
	 * 按角色卡绑定的自定义表格模板（DESIGN-template-system §4）：卡 name → 模板名列表；
	 * 用该卡开聊时把绑定的模板表建进聊天 state（幂等，只建结构不填数据）。
	 */
	cardTemplates?: Record<string, string[]>;
	/**
	 * 导入场景的表回填阈值（DESIGN-import-raw §1 表格回填）：auto 表数 > 该值时，
	 * 导入流程改为逐表独立 LLM 调用回填（每表一次提取链，分块增量填，避免单次场记
	 * 建账塞不下多张表）；≤ 阈值时由场记建账顺手填充。缺省 6。
	 */
	tableBackfillThreshold?: number;
	/**
	 * 旁挂模型（2026-08-10）：旁路 LLM 调用（表格回填/回放场记/导入建账与摘要/世界书别名/
	 * 生图规划等）统一使用的独立模型。空 = 跟随剧情模型（session.model）。
	 * 解析经 modelRegistry.find(provider, id)，找不到回退剧情模型。
	 */
	sideModel?: { provider: string; id: string };
	/**
	 * 破甲提示词（2026-08-10，可选）：固定拼接在旁路调用 systemPrompt 的最前面，
	 * 用于绕过模型内容限制。除「每轮剧情场记」（agent_end 钩子）外所有旁路调用生效；
	 * 空 = 不注入。用户主动配置，默认保护不变。
	 */
	sideJailbreak?: string;
	/**
	 * 开发者模式（2026-08-11）：总开关，打开后在设置面板显示开发者选项。
	 * 纯 UI/配置位，具体行为由各子选项（如 chatTrace）决定。
	 */
	developerMode?: boolean;
	/**
	 * 主聊天跟踪（2026-08-11，开发调试用）：开启后把当前聊天全过程
	 * （送模提示词/思考/工具调用/草稿/旁路模型/定稿）按事件追加写入
	 * `.liyuan-state/trace/<sessionId>.jsonl`（JSONL 机器格式，见 docs/DESIGN-debug-trace.md）。
	 * 每回合现读配置，保存后下一回合生效；按会话分文件。
	 */
	chatTrace?: boolean;
	/**
	 * 轮次卡模板覆盖（2026-08-13，DESIGN-flow-config §2）：assets/flow/round-cards.json
	 * 之上按 key 同名替换（7 个固定 key：plan/open/fix/curtain/review/extend/seal）。
	 * 只改不删——配置删掉的 key 用内置模板补回。占位符见 docs/DESIGN-flow-config.md。
	 */
	flowTemplates?: FlowTemplateConfig[];
	/**
	 * 预设拆层表覆盖（2026-08-13，DESIGN-flow-config §3）：assets/flow/split-tables.json
	 * 之上按 key 同名替换内置表（liyuan-custom / tgbreak-v2 / shuangren-v10 / xiajin-v2 /
	 * dreamwhale-v5）。RegExp 字段（stripLines / segments.match）为字符串，加载时编译，
	 * 非法正则跳过该规则（宁漏勿伤）。
	 */
	splitTables?: SplitTableOverride[];
	/**
	 * 回合意图分类正则覆盖（2026-08-13，DESIGN-flow-config §4）：turn-intent 的
	 * WANTS_STORY / PURE_OPS 正则清单外置。**当前无调用点**（shouldApplyStoryPreset 为
	 * 预留接口，未挂进回合流程），仅声明字段与 factory 支持，为将来激活而设。
	 */
	intentRegex?: IntentRegexConfig;
	/**
	 * 语义评审（2026-08-14，DESIGN-semantic-review）：封笔后由旁路模型做一次
	 * 设定一致性/人物一致性/文风与 AI 味评审，major 问题并入修复门禁
	 * （主演 draft_edit 定点修，与机械违规同一通道）。
	 * 缺省开启（enabled=true, gate=major）；成本敏感可 enabled=false 关闭。
	 */
	semanticReview?: SemanticReviewConfig;
	/**
	 * 文风卡覆盖（2026-08-15，DESIGN-style-baseline）：assets/flow/style-baseline.json
	 * 之上按 key 覆盖——default 键替换默认卡；presets 内同名键替换预设卡，未提供的继承。
	 * 文风卡是本场唯一文风来源；harness 只引用它，不定义文风。
	 */
	styleBaseline?: StyleBaselineConfig;
}

/** 文风卡（DESIGN-style-baseline §2）：唯一文风来源，四要素齐全才算合法 */
export interface StyleBaselineCard {
	/** 声音：叙述者是谁、对谁说，一句话 */
	voice: string;
	/** 参考系：一个可替换的文风方向（单选，不叠加） */
	reference: string;
	/** 正例：目标声音的一段完整示范 */
	positive: string;
	/** 反例：三个跑偏原型（分镜腔 / 散文腔 / 流水账腔），不是穷举清单 */
	negatives: {
		shot: string;
		prose: string;
		ledger: string;
	};
	/** 自检问题：落笔前后各问一次 */
	check: string;
}

/** 文风卡配置覆盖（DESIGN-style-baseline §4）：default 盖默认卡，presets 按 key 盖预设卡 */
export interface StyleBaselineConfig {
	default?: StyleBaselineCard;
	presets?: Record<string, StyleBaselineCard>;
}

/** 语义评审配置（2026-08-14，DESIGN-semantic-review §配置） */
export interface SemanticReviewConfig {
	/** 总开关（缺省 true：封笔后有戏的一拍自动评审一次） */
	enabled?: boolean;
	/** 拦推进的问题门槛（缺省 major：只拦崩人设/吃设定/明显 AI 味，minor 提示不拦） */
	gate?: "major" | "all";
}

/** 轮次卡模板（DESIGN-flow-config §2）：key 为程序判定键，title 含【】卡名，body 含占位符 */
export interface FlowTemplateConfig {
	key: string;
	title: string;
	body: string;
}

/** 拆层表覆盖（DESIGN-flow-config §3）：JSON 数据形态，RegExp 字段为字符串 */
export interface SplitTableOverride {
	/** 表标识；与内置表同 key 即替换 */
	key: string;
	/** 启用块名指纹（≥2 命中认表） */
	fingerprints?: string[];
	blocks?: Array<{
		name: string;
		nature: string;
		fate: "resident" | "skill" | "rules-only" | "drop";
		section?: "A" | "B" | "C";
		topic?: string;
		/** 句级：摘掉命中行（正则字符串） */
		stripLines?: string[];
		segments?: Array<{
			match: string;
			fate: "resident" | "skill" | "rules-only" | "drop";
			section?: "A" | "B" | "C";
			topic?: string;
		}>;
		/** 该块声明了自定义用户代言边界 → 主权检查降档 */
		sovereigntyOverride?: boolean;
		note?: string;
	}>;
	/** 变量级去向（值从求值后的变量表取） */
	vars?: Array<{
		name: string;
		fate: "resident" | "skill" | "drop";
		section?: "B" | "C";
		topic?: string;
		stripLines?: string[];
	}>;
	/** 从被退场块转述救出的规则句 */
	supplements?: Array<{ section: "B" | "C"; text: string; source: string }>;
}

/** 回合意图分类正则清单（DESIGN-flow-config §4）：字符串数组，加载时 join("|") 编译 */
export interface IntentRegexConfig {
	/** 明确要求推进/续写场面（命中走剧情预设） */
	wantsStory?: string[];
	/** 高置信纯办事/维护（短句命中跳过预设） */
	pureOps?: string[];
}

export const DEFAULT_CONFIG: RpConfig = {
	card: "assets/cards/default_Qingwu.json",
	// 默认不挂书：角色卡与世界书解耦，用户按需多选挂载
	lorebooks: [],
	userName: "旅人",
	userPersona: "",
	language: "中文",
	scanDepth: 4,
	maxLoreInjections: 3,
	greeting: true,
	backendControl: true,
	compactEveryNTurns: 30,
	// 导入时 auto 表超过该数则逐表独立回填（每表一次 LLM 提取链）
	tableBackfillThreshold: 6,
	// 默认无自定义 agent（declarative，见 AgentConfig）
	agents: [],
	// 开发者功能默认全关（调试记录涉及完整提示词/思考，按需开启）
	developerMode: false,
	chatTrace: false,
};

/** 宏替换上下文 */
export interface MacroContext {
	charName: string;
	userName: string;
}
