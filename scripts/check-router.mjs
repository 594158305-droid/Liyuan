/**
 * 梨园化 router 生效检查（docs/DESIGN-router.md §9）：零 LLM、零服务。
 *
 * 走与引擎 #turn 完全相同的装配路径（loadStageMaterials → resolveRouterConfig →
 * classifyTask/isComplexTask → personaFor/cardFor → buildStageSystemPrompt），
 * 打印：解析后的 router 配置、system 区 # 演出姿态 段、示例用户消息的分类与模式卡。
 *
 * 用法：
 *   node scripts/check-router.mjs                  # 默认：deepseek-v4-pro + 三条示例消息
 *   node scripts/check-router.mjs deepseek-v4-flash # 指定模型（观察 flash 分档人格/防太浅句）
 *   node scripts/check-router.mjs pro "继续推进，新角色登场"  # 自定义一条消息
 *
 * 返回码：0 = 已生效（enabled && system 含 # 演出姿态）；1 = 未生效/错误。
 */

import { resolveRouterConfig, loadRouterFile } from "../src/router-config.ts";
import { buildStageSystemPrompt } from "../src/stage/assemble.ts";
import { loadStageMaterials, loadStageConfig } from "../src/stage/materials.ts";
import { cardFor, classifyTask, isComplexTask, personaFor } from "../src/router-core.ts";

const cwd = process.cwd();
const argModel = process.argv[2];
const argMsg = process.argv[3];

const modelId = argModel === "flash" ? "deepseek-v4-flash" : argModel === "pro" ? "deepseek-v4-pro" : (argModel ?? "deepseek-v4-pro");

const config = loadStageConfig(cwd);
const router = resolveRouterConfig(config.router, loadRouterFile(cwd));
const materials = loadStageMaterials(cwd);

console.log("── router 配置（liyuan.config.json.router 缺省 = 全部默认开）");
console.log(`  enabled=${router.enabled} personaMode=${router.personaMode} toolStaging=${router.toolStaging} modeCards=${router.modeCards} convergeTail=${router.convergeTail} agents=${router.agentsEnabled}`);
if (config.router) console.log("  配置来源：liyuan.config.json router 段 →", JSON.stringify(config.router));
else console.log("  配置来源：缺省（用户拍板：默认开、perTurn 唯一推荐形态）");

const persona = personaFor("weak", modelId, router.personas);
const sp = buildStageSystemPrompt({
	card: materials.card,
	config,
	constantLore: [],
	styleBaseline: materials.styleBaseline,
	presetResident: { aBlocks: materials.presetResidentA, styleTexts: materials.presetResidentB, boundaryTexts: materials.presetResidentC },
	skillTopics: [],
	presetActive: materials.presetActive,
	statusBarFormats: materials.statusBarFormats,
	tools: false,
	routerPersona: router.enabled ? persona : undefined,
});

console.log("\n── system prompt 区：router 弱人格（# 演出姿态）");
if (sp.includes("# 演出姿态")) {
	const seg = sp.split("# 演出姿态")[1]?.split("\n\n# ")[0] ?? "";
	console.log(`  ✅ 已注入（${modelId}）：# 演出姿态`);
	console.log("  " + (persona || "").replace(/\n/g, "\n  "));
} else {
	console.log(`  ❌ 未注入（${modelId}）——router.enabled=${router.enabled}`);
}

console.log("\n── 模式卡（当拍分类 → 注入区卡；weak 无卡）");
const samples = argMsg
	? [argMsg]
	: ["继续推进，新角色登场", "上一拍文风崩了，重写", "这场战役的群像戏太浅了，重写，设定密集", "嗯"];
for (const msg of samples) {
	const task = classifyTask(msg, router.lexicon);
	const complex = isComplexTask(msg, router.lexicon);
	const card = cardFor(task, { complex, modelId, cards: router.cards });
	const tag = task === "react" ? "构造" : task === "spec" ? "修复" : "模糊";
	console.log(`  「${msg}」 → ${tag}${complex ? "·复杂" : ""} ${card ? `→ ${card.title}${card.body}` : "→ 无卡（weak 靠 system 弱人格）"}`);
}

console.log("\n── 真实会话肉眼验证（有 LLM 时）");
console.log("  1) 设置 → 开发者模式 → 主聊天跟踪 打开");
console.log("  2) 演一拍（构造或修复话术）");
console.log("  3) 读 .liyuan-state/trace/<sessionId>.jsonl：");
console.log('     - kind:"prompt" 事件的 systemPrompt 含 "# 演出姿态"');
console.log("     - messages 末条（用户话之前的注入）含 【构造拍】/【修复拍】/【深度拍】");
console.log("     - 相邻两拍 systemPrompt 逐字节一致（缓存稳定）");

const ok = router.enabled && sp.includes("# 演出姿态");
console.log(ok ? "\n✅ router 已生效（enabled + system 弱人格 + 模式卡链路就绪）" : "\n❌ router 未生效");
process.exit(ok ? 0 : 1);
