/**
 * 规划 LLM 提示词组装（插件 B draw-pipeline，DESIGN-draw §3.2 管线模型）。
 * 纯函数：组装 system + user 提示词；LLM 调用经注入（便于测试）。
 */

import { DEFAULT_DRAW_ASPECTS, type DrawAspects } from "../../draw/config.ts";

export interface PlannerInput {
	/** 当前 AI 消息正文 */
	messageText: string;
	/** 前文（最近 1 条 user 消息，缺省 ""） */
	contextText: string;
	/** 更早的前文（最近 N 条拼接；在 contextText 之前注入，缺省 ""） */
	historyText?: string;
	/** 压缩摘要（rp-summary 内容，注入「前情提要」段；缺省 ""） */
	summaryText?: string;
	/** novelai-draw.md 内容（.liyuan-skills/ 读，缺失 null） */
	skillText: string | null;
	/** lore 检索结果（拼接，缺省 ""） */
	loreText: string;
	/** 在场角色档案摘要（resolveCharacterTags 结果的紧凑文本，缺省 ""） */
	characterNotes: string;
	/** 三档构图分辨率（动态分辨率；缺省回退默认表）——注入提示词让模型按真实比例构图 */
	aspects?: DrawAspects;
	maxImages: number;
	maxCharactersPerImage: number;
}

/**
 * 输出格式规范（严格只输出 YAML 块）。
 * aspect 行注入三档实际分辨率（动态分辨率）：LLM 只选档位，但构图描述按真实比例写。
 */
function buildOutputFormatSpec(aspects: DrawAspects): string {
	const { portrait, landscape, square } = aspects;
	return `你负责为一段剧情正文规划配图。严格只输出一个 <image_gen> YAML 块，不要输出任何其它文字、解释或围栏外内容。

<image_gen> 块格式（YAML）：
\`\`\`
<image_gen>
  - index: 1
    anchor: "正文锚点原文片段"        # 选填；缺省=消息末尾
    aspect: landscape                  # portrait(${portrait.width}x${portrait.height}) | landscape(${landscape.width}x${landscape.height}) | square(${square.width}x${square.height})
    scene: "1girl, tavern interior, warm candlelight, ..."   # 完整画面描述（Danbooru tag 或自然语言，70-100 个 tag/词）
    negative: ""                       # 选填：整图补充负面
    characters:                        # 选填：需要角色特征时
      - name: "角色名"
        action: "pushing open the door, surprised"
</image_gen>
\`\`\`

要求：
- 多张图时按正文出现顺序给 index: 1,2,3…
- scene 里的角色 tag 不要重复写（角色特征由系统从服装档案自动组装）——scene 只写场景、动作、氛围
- 分级：sfw 内容直接写；轻度擦边用 0.5::nsfw:: 前缀；重度 nsfw 在 scene 里显式写 nsfw 标签（NAI 会拒绝越界内容）
- 5×5 网格说明（每图可选，默认中心）：画面重心默认居中，多角色时注意构图平衡
- 每张图的画面描述 tag 配额 70-100 个（danbooru 下划线格式或自然语言混合，宁多勿少）`;
}

/** 组装规划提示词 */
export function buildPlannerPrompt(input: PlannerInput): { system: string; user: string } {
	const skillSection = input.skillText
		? `以下是生图 TAG 规范与构图规范（skill novelai-draw）：\n${input.skillText}`
		: "（未提供 TAG 规范文档——按你已知的 Danbooru 风格写画面描述）";

	const system = [
		skillSection,
		"",
		buildOutputFormatSpec(input.aspects ?? DEFAULT_DRAW_ASPECTS),
	].join("\n");

	const user = [
		// 顺序：前情提要 → 更早前文 → 最近 user 消息 → 世界设定(lore) → 角色 → 正文
		input.summaryText ? `前情提要（早期剧情摘要）：\n${input.summaryText}\n` : "",
		input.historyText ? `更早的前文：\n${input.historyText}\n` : "",
		input.contextText ? `前文（最近一条用户消息）：\n${input.contextText}\n` : "",
		input.loreText ? `\n相关世界观设定（lorebook 检索）：\n${input.loreText}` : "",
		input.characterNotes ? `\n在场角色档案（服装/外观 tag）：\n${input.characterNotes}` : "",
		`当前剧情正文（需配图）：\n${input.messageText}`,
		`\n当前配额：最多 ${input.maxImages} 张图，每张图最多 ${input.maxCharactersPerImage} 个角色。`,
		"请输出配图计划（严格只输出 <image_gen> YAML 块）。",
	]
		.filter(Boolean)
		.join("\n");

	return { system, user };
}
