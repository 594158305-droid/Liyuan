/**
 * 回合意图：决定本轮是否装配「剧情预设」。
 *
 * 用户自备 ST 预设（system + postHistory + 字数/思维链模板）只服务**剧情生成**。
 * 纯非剧情（办事 / 面板维护 / 配置）由 harness 跳过预设注入，避免「必须 1000 字 + 强制 thinking」压过办事意图。
 *
 * 默认走预设（剧情是主路径）；仅高置信非剧情返回 false。
 * 混写（既办事又要续演）一律走预设。
 */

import { isBackstageText } from "./stance.ts";

/** 用户明确要求推进/续写场面 → 强制走预设 */
const WANTS_STORY =
	/(继续|续写|接着演|接着写|往下写|推进剧情|写一段|开写|演戏|写剧情|场景推进|然后写|办完继续|办完再写|办完续|边办边演|continue\s*(the\s*)?(story|scene)|keep\s*writ)/i;

/** 高置信纯办事 / 维护（无续写诉求时跳过预设） */
const PURE_OPS =
	// 配置 / 模型 / 诊断
	/(改配置|写配置|切换模型|换模型|换预设|改预设|开预设|关预设|预设采样|采样参数|temperature|诊断|排错|看日志|\bMCP\b|技能笔记|沉淀技能|装技能)/i.source +
	"|" +
	// 面板 / 账本 / 设定维护
	/(角色仓库|更新面板|改面板|写面板|同步面板|关面板|面板更新|状态栏|账本|世界状态|补设定|写设定|挂载知识|知识库|lorebook)/i
		.source +
	"|" +
	// 媒体 / API
	/(调\s*API|调接口|生图|文生图|配音|\bTTS\b|合成语音|生成视频|上传文件)/i.source +
	"|" +
	// 明确不要剧情
	/(只改|仅改|只要改|只更新|仅更新|不用写|别写正文|不要正文|别续写|先别写|不要推进|别推进|纯办事|系统事务|不要剧情|别演)/i
		.source +
	"|" +
	// 显式助手
	/(让助手|叫助手|委托助手|右栏助手)/i.source;

const PURE_OPS_RE = new RegExp(PURE_OPS, "i");

/**
 * 本轮是否应装配用户剧情预设（system 块 + postHistory 块）。
 * @returns true = 剧情生成回合，走预设；false = 纯非剧情，跳过预设
 */
export function shouldApplyStoryPreset(userText: string): boolean {
	const t = userText.trim();
	if (!t) return true;

	// 场外标记（// / 双括号 / 整段括号）：按非剧情办事处理
	if (isBackstageText(t)) return false;

	// 长段用户正文（动作/对白）默认剧情
	if (t.length > 280) return true;

	// 混写或明确续写 → 预设
	if (WANTS_STORY.test(t)) return true;

	// 短句 + 纯办事信号 → 不走预设
	if (PURE_OPS_RE.test(t)) return false;

	return true;
}
