/**
 * 世界线族工具（PLAN-RP-TOOLING M-D5）。
 *
 * 合一前零工具——世界线操作全是 UI 命令（/store /back /rewind）或 REST 端点。
 * 此处首开工具化。
 *
 * ## 写侧语义
 *
 * - `worldline_store`：在当前叶位创建 rp-save 存档点。是**安全写**——只往树里追加
 *   `rp-save` custom 条目，不删不改任何现有条目。存档后继续演，不中断。
 * - `worldline_back`：导航到某个存档点。走 `navigateTree`（宿主 ctx 操作）---
 *   **不会删东西**（旧后续完整保留在树上，rewind 后走不同的路再 store 才分出新世界线）。
 *   仅**助手面**开放——台上 back 是侵入操作（导航树会打断当前生成回合），
 *   且留哪条时间线是用户的主权决定。`back` 被拒时提示用户用 `/back` 命令。
 *
 * ## 门禁
 *
 * `worldline_store` / `worldline_back` 都是写侧，但**不挂门禁**。
 * 理由：存档是时间轴快照——不覆写用户数据（不像 lorebook_write 改设定集），
 * 不跨会话污染（不像 memory_add 写进本对话的检索库），且全可逆
 * （back 后的旧后续可再导航回去；softDelete 只是软删）。
 */

import { errText, intArg, strArg, type ToolResult, type ToolSpec } from "./registry.ts";

/** 存档视图子集（不依赖 worldline.ts 全形，便于离线单测） */
export interface WorldlineSaveLite {
	id: string;
	name: string;
	worldlineId: string;
	worldlineName: string;
	createdAt: number;
	onCurrentBranch: boolean;
	entryId: string;
}

export interface WorldlineViewLite {
	saves: WorldlineSaveLite[];
	currentSaveId: string | null;
}

export interface WorldlineDeps {
	/**
	 * 返回全部存档的世界线视图（含已软删过滤 + 分支归属）。
	 * 内部调 `buildWorldlineView(extractSaves(...))`——
	 * 只在助手面调用（从树里抽），台上若无注入则不注册本族写侧工具。
	 */
	loadWorldline?: () => WorldlineViewLite;
	/**
	 * 创建存档（在当前叶位写 rp-save 条目并落盘 meta）。
	 * 返回新建的存档摘要；null = 无叶位可存。
	 */
	storeSave?: (name: string) => { id: string; name: string; worldlineName: string } | null;
	/**
	 * 导航到某个存档点（navigateTree），不删旧内容。
	 * 仅助手面注入——台上拿不到 navigateTree（StageSessionManager 无此能力）。
	 */
	navigateToSave?: (saveId: string) => { ok: boolean; error?: string };
}

const formatTime = (ts: number): string => {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 调用情境：用户/剧情到了「值得存档」的节点——一个篇章结束、关键决策后、
 * 或用户说「在这里存个档」。
 *
 * 读侧 `worldline_list` 给目录。
 */
export const worldlineStore: ToolSpec<WorldlineDeps> = {
	name: "worldline_store",
	domain: "worldline",
	mode: "write",
	surfaces: ["assistant"],
	label: "创建存档",
	description: () =>
		"在当前剧情节点创建一个存档点（rp-save）。不删不改任何现有内容——" +
		"存档后继续正常推进，之后再 store 会根据走向自动接续或分叉。" +
		"存档名可选，缺省为自动时间戳。" +
		"存档操作不产生新世界线——只有回退到旧存档后走出不同后续再存，才会分叉。",
	parameters: () => ({
		type: "object",
		properties: {
			name: { type: "string", description: "存档名（缺省自动生成「X月/X日 HH:MM」格式）" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.storeSave) return { text: "本环境不支持创建存档。" };

		const name = strArg(args, "name");
		let r: { id: string; name: string; worldlineName: string } | null;
		try {
			r = deps.storeSave(name);
		} catch (err) {
			return { text: `创建存档失败：${errText(err)}` };
		}
		if (!r) return { text: "无法创建存档（无当前叶位）。" };

		return {
			text: `已存档【${r.name}】（${r.worldlineName}）。` +
				`之后走不同的路再存会自动分叉出新世界线；回退到旧存档用 /back 命令。`,
			activity: `存档「${r.name}」`,
			details: { id: r.id, name: r.name, worldlineName: r.worldlineName },
		};
	},
};

/**
 * 调用情境：诊断时间轴——用户问「我存了几个档/哪条世界线」或
 * 要回退到某个存档点前先确认它的名字。
 *
 * 助手面可用：`surfaces: ["assistant"]`（台上拿不到分支树数据，
 * 且世界线是管理操作非生成内容）。
 */
export const worldlineList: ToolSpec<WorldlineDeps> = {
	name: "worldline_list",
	domain: "worldline",
	mode: "read",
	surfaces: ["assistant"],
	label: "列出世界线/存档",
	description: () =>
		"列出全部存档与世界线（按时间排序、标明当前分支归属）。" +
		"用于诊断「有过哪些存档」「当前在哪个存档之后」。" +
		"要看具体存档点的剧情内容请用 story_read（存档只是锚点，不含正文）。",
	parameters: () => ({
		type: "object",
		properties: {
			limit: { type: "number", description: "最多列几条存档（默认 20，最近优先）" },
		},
		required: [],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.loadWorldline) return { text: "本环境不支持查看世界线。" };

		let view: WorldlineViewLite;
		try {
			view = deps.loadWorldline();
		} catch (err) {
			return { text: `读取世界线失败：${errText(err)}` };
		}
		if (!view.saves.length) return { text: "尚无存档（用 worldline_store 或 /store 创建第一个存档点）。" };

		// 倒序（最新在前），封顶
		const limit = intArg(args, "limit", 20, 1, 100);
		const recent = view.saves.slice(-limit).reverse();
		const lines = recent.map((s) => {
			const cur = s.id === view.currentSaveId ? " ← 当前" : "";
			const branch = s.onCurrentBranch ? "★本分支" : "○其他分支";
			return `- [${s.id}] **${s.name}**｜${s.worldlineName}｜${formatTime(s.createdAt)}｜${branch}${cur}`;
		});
		const head = `共 ${view.saves.length} 个存档（${recent.length} 条）：`;
		return {
			text: `${head}\n${lines.join("\n")}`,
			activity: `列世界线 · ${recent.length} 条`,
			details: { total: view.saves.length, currentSaveId: view.currentSaveId },
		};
	},
};

/**
 * 调用情境：用户说「回到那个存档点」——**仅助手面**。
 *
 * ⚠ 不在台上开放：导航树会打断当前生成回合，且留哪条时间线是用户的主权决定。
 * 助手侧的 agent 经 `story_command` 本来就可以排 `/back` 命令，
 * 本工具只是给一个更精确的按 id 导航——同时也被拒概率更高
 * （saveId 是从 list 取的真实编号，不会拼错）。
 */
export const worldlineBack: ToolSpec<WorldlineDeps> = {
	name: "worldline_back",
	domain: "worldline",
	mode: "write",
	surfaces: ["assistant"],
	label: "回退到存档",
	description: () =>
		"导航到指定存档点（从 worldline_list 取 id）。**不删任何内容**——" +
		"旧后续完整保留在树上，之后再走不同的路 store 才会分出新世界线。" +
		"回退是用户级的决定——只在用户明确说「回到某个存档」时调用；" +
		"不要自作主张回退，不要反复问「要不要回退」。",
	parameters: () => ({
		type: "object",
		properties: {
			id: { type: "string", description: "存档 id（从 worldline_list 的 [id] 取）" },
		},
		required: ["id"],
	}),
	async run(args, deps): Promise<ToolResult> {
		if (!deps.navigateToSave) return { text: "本环境不支持导航到存档点。" };

		const id = strArg(args, "id");
		if (!id) return { text: "缺少 id 参数（存档编号从 worldline_list 取）。" };

		let r: { ok: boolean; error?: string };
		try {
			r = deps.navigateToSave(id);
		} catch (err) {
			return { text: `导航失败：${errText(err)}` };
		}
		if (!r.ok) return { text: r.error ?? `未找到存档 ${id}。` };

		return {
			text: `已导航到存档 ${id}。被回退的内容完整保留在树上——走不同的路再 store 会分叉出新世界线。`,
			activity: `回退到存档 ${id}`,
			details: { id },
		};
	},
};

/** 世界线族全部工具（M-D5：store/list/back；rewind 语义同 back、delete 永不开放） */
export const worldlineTools: ToolSpec<WorldlineDeps>[] = [worldlineStore, worldlineList, worldlineBack];
