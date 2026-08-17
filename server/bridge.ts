/**
 * 桥权限模型（自定义 agent 能力阶段二，设计稿 DESIGN-custom-agents §4）：
 * 把 storyBridge 从单对象改造成按权限裁剪的工厂。内置助手/剧情侧用全权限，
 * 自定义 agent 将按各自配置（liyuan.config.json 的 agents[].bridge）裁剪。
 *
 * 只 import 类型 StoryBridge，避免运行时循环依赖（assistant.ts 运行时引用 main.ts 的桥实例，
 * main.ts 引用本模块，本模块只做类型层面引用 assistant.ts）。
 */
import type { StoryBridge } from "./assistant.ts";

/** 桥权限配置：每个开关对应 StoryBridge 上一组方法的授权 */
export interface BridgePermissions {
	/** 只读组一键开关：storyMessages / snapshot / worldState / listModels / cardName / deliverMedia */
	readStory: boolean;
	/** 写面板（落盘 + 收编剧情扩展内存） */
	writePanels: boolean;
	/** 显式改稿（DESIGN-story-edit §3，独立权限） */
	storyEdit: boolean;
	/** 剧情命令桥（含 /back /store 等全部斜杠命令，可触发剧情侧任意操作，默认 false） */
	queueCommand: boolean;
	/** 账本补丁（落盘 + await statesync） */
	applyStatePatch: boolean;
	/** 自定义表格读写（DESIGN-custom-tables §7：table_create/drop/insert/update/delete 走账本 applyTableOperation） */
	tableOps: boolean;
	/** 委托模式媒体推送（与 show_image 同源 wire 通道） */
	emitMedia: boolean;
	/** 配置/设定热载与素材收编（softRefreshConfig / refreshStoryMaterials 同源 restHost 操作） */
	refreshMaterials: boolean;
	/** 知识库挂载桥（/codexmount 命令） */
	mountCodex: boolean;
	/** 助手生图嵌入剧情正文（Q15：draw_generate 默认嵌入最近一条剧情消息，rp-draft-op 补丁 + slot 登记） */
	embedStoryImage: boolean;
}

/** 全权限：内置助手/剧情侧使用 */
export const FULL_BRIDGE_PERMISSIONS: BridgePermissions = {
	readStory: true,
	writePanels: true,
	storyEdit: true,
	queueCommand: true,
	applyStatePatch: true,
	tableOps: true,
	emitMedia: true,
	refreshMaterials: true,
	mountCodex: true,
	embedStoryImage: true,
};

/**
 * 按权限裁剪桥：返回代理对象，每个方法包装后检查对应权限。
 * 未授权方法抛错（错误文案含方法名），由工具执行层捕获并转成助手/agent 可见的「无权限」工具错误；
 * 只读组（storyMessages/snapshot/worldState/listModels/cardName/deliverMedia）由 readStory 一键开关。
 * 保持与 StoryBridge 接口逐方法一致（含新加的 storyEdit）；基础实现闭包不依赖 this，bind 仅为防御。
 */
export function createStoryBridge(base: StoryBridge, perms: BridgePermissions): StoryBridge {
	/** 权限不足：抛出带方法名的授权错误，让调用方（工具执行层）转成可见错误 */
	const deny = (method: string): never => {
		throw new Error(`bridge 权限未授予: ${method}`);
	};

	return {
		// ---- 只读组：readStory 一键开关 ----
		storyMessages: perms.readStory ? base.storyMessages.bind(base) : () => deny("storyMessages"),
		snapshot: perms.readStory ? base.snapshot.bind(base) : () => deny("snapshot"),
		worldState: perms.readStory ? base.worldState.bind(base) : () => deny("worldState"),
		listTables: perms.readStory ? base.listTables.bind(base) : () => deny("listTables"),
		listModels: perms.readStory ? base.listModels.bind(base) : () => deny("listModels"),
		cardName: perms.readStory ? base.cardName.bind(base) : () => deny("cardName"),
		deliverMedia: perms.readStory ? base.deliverMedia.bind(base) : () => deny("deliverMedia"),
		// ---- 向量记忆作用域 / 世界线视图 / 面板读取 / 知识库挂载清单：只读查询，随 readStory ----
		memoryScope: perms.readStory ? base.memoryScope.bind(base) : () => deny("memoryScope"),
		worldlineView: perms.readStory ? base.worldlineView.bind(base) : () => deny("worldlineView"),
		storyPanels: perms.readStory ? base.storyPanels.bind(base) : () => deny("storyPanels"),
		mountedCodexes: perms.readStory ? base.mountedCodexes.bind(base) : () => deny("mountedCodexes"),
		// ---- 写面板：独立权限 ----
		writePanels: perms.writePanels ? base.writePanels.bind(base) : () => deny("writePanels"),
		// ---- 显式改稿：独立权限（DESIGN-story-edit §3）----
		storyEdit: perms.storyEdit ? base.storyEdit.bind(base) : () => deny("storyEdit"),
		// ---- 剧情命令桥：危险权限，默认 false ----
		queueStoryCommand: perms.queueCommand ? base.queueStoryCommand.bind(base) : () => deny("queueStoryCommand"),
		// ---- 账本补丁：独立权限 ----
		applyStatePatch: perms.applyStatePatch ? base.applyStatePatch.bind(base) : () => deny("applyStatePatch"),
		// ---- 自定义表格读写：独立权限（DESIGN-custom-tables §7） ----
		applyTableOp: perms.tableOps ? base.applyTableOp.bind(base) : () => deny("applyTableOp"),
		// ---- 自定义表格模板物化（DESIGN-template-system §6）：物化即建表，随 tableOps 权限面 ----
		applyTemplate: perms.tableOps ? base.applyTemplate.bind(base) : () => deny("applyTemplate"),
		// ---- 表格历史回填（DESIGN-table-backfill §3）：从当前分支楼层提取数据填充表；随 tableOps 权限面 ----
		applyTableBackfill: perms.tableOps ? base.applyTableBackfill.bind(base) : () => deny("applyTableBackfill"),
		// ---- 委托模式媒体推送：独立权限（emitStoryMedia 在接口里是可选项，授权不足也按抛错处理）----
		emitStoryMedia: perms.emitMedia ? base.emitStoryMedia.bind(base) : () => deny("emitStoryMedia"),
		// ---- 配置/设定热载与素材收编：refreshMaterials 一键管两个同源方法 ----
		refreshStoryMaterials: perms.refreshMaterials ? base.refreshStoryMaterials.bind(base) : () => deny("refreshStoryMaterials"),
		softRefreshConfig: perms.refreshMaterials ? base.softRefreshConfig.bind(base) : () => deny("softRefreshConfig"),
		// ---- P8 显示重放：仅广播 hello 帧（无状态写入、无素材重装），不做权限裁剪 ----
		resyncStory: base.resyncStory.bind(base),
		// ---- 知识库挂载桥：独立权限 ----
		mountCodex: perms.mountCodex ? base.mountCodex.bind(base) : () => deny("mountCodex"),
		// ---- 助手生图嵌入剧情正文：独立权限（Q15） ----
		embedStoryImage: perms.embedStoryImage ? base.embedStoryImage.bind(base) : () => deny("embedStoryImage"),
	};
}
