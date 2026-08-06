// ST 预设转换�?CLI：node scripts/convert-preset.mjs <ST预设.json> [输出=liyuan-preset.json]
// 输出：我们自己的 liyuan-preset.json + 结构化分诊报告（只列块名/去向/长度，内容不外显——内容中立协议）
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { convertStPreset } from "../src/preset.ts";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg) {
	console.error("用法：node scripts/convert-preset.mjs <ST预设.json> [输出路径=liyuan-preset.json]");
	process.exit(1);
}
const inputPath = isAbsolute(inputArg) ? inputArg : join(appDir, inputArg);
const outputPath = isAbsolute(outputArg ?? "") ? outputArg : join(appDir, outputArg ?? "liyuan-preset.json");

const raw = JSON.parse(readFileSync(inputPath, "utf8"));
const presetName = basename(inputPath).replace(/\.json$/i, "");
const { preset, report } = convertStPreset(raw, presetName);

writeFileSync(outputPath, JSON.stringify(preset, null, "\t"), "utf8");

console.log(`\n预设转换报告�?{presetName}`);
console.log("─".repeat(72));
for (const r of report) {
	const chars = r.contentChars > 0 ? `${r.contentChars} 字符` : "";
	console.log(`  ${r.action.padEnd(14)} ${r.name || r.identifier}  ${chars}`);
}
console.log("─".repeat(72));
const count = (a) => report.filter((r) => r.action === a).length;
console.log(
	`system 区块 ${count("system")} · 末端区块 ${count("postHistory")} · marker �?${count("marker（槽位，弃）")} · 禁用保留 ${count("禁用（保留可开启）")} · 缺失 ${count("缺失定义")}`,
);
console.log(`采样参数�?{JSON.stringify(preset.samplers)}`);
console.log(`已写�?${outputPath}`);
console.log("\n提示：在 liyuan.config.json �?\"preset\": \"liyuan-preset.json\" 启用；不需要的块把 enabled 改为 false�?);
console.log("分诊建议：机制补偿类块（状态栏指令/防复�?CoT 模板）建议禁用——其意图已由场记/审计/思考通道实现�?);
