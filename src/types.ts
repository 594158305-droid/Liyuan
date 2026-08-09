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
	/** true = 场记每轮自动维护 + 每轮全量注入上下文；非 auto 表只注入索引，内容走 table_query */
	auto?: boolean;
}

/** 模板里的表定义（比 CustomTable 多触发器/初始行，DESIGN-template-system §1） */
export interface TableTemplate {
	name: string;
	description?: string;
	columns: CustomTableColumn[];
	/** true = 场记自动维护 + 每轮全量注入（建表时写入 CustomTable.auto） */
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
};

/** 宏替换上下文 */
export interface MacroContext {
	charName: string;
	userName: string;
}
