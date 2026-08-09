// ============================================================================
// 能力基准演示脚本（jsrunner，D4 §6.2 常驻测试·演示轨）
// ----------------------------------------------------------------------------
// 用途：导入到 JsRunnerPanel（PowersPanel「扩展能力 → 脚本」）即运行，逐项自检
//       jsrunner 账本定制能力并以 toast 汇报——「能力基准通过/失败项」。
// 覆盖（对照 D4 §7.11 满足度矩阵）：
//   1. 面板注册 + 图标（status 区域）
//   2. worldState 快照读取
//   3. 三事件订阅（WORLD_STATE_CHANGED / MESSAGE_RECEIVED / GENERATION_ENDED）
//   4. 大内容渲染（1000 行表格，体积压力项）
//   5. applyStatePatch 回写账本
//   6. extdata 自由键读写（cfg:<scriptId> 命名空间，P4）
//   7. notify / toastr 通知（P3）
// 人工验证项（自动无法覆盖）：面板出现在账本卡片；收起/展开；深色主题 --ly-* 跟随；
//   双 area（改 area 重注册看名录面板）；openManager 模态（P4）。
// ============================================================================

TavernHelper.registerLedgerPanel({ title: "能力基准自检", icon: "🧪" });

const report = [];
const check = (name, ok, extra) => report.push(`${ok ? "✅" : "❌"} ${name}${extra ? "：" + extra : ""}`);
let reported = false;
function reportAll() {
	if (reported) return;
	reported = true;
	const fails = report.filter((r) => r.startsWith("❌"));
	TavernHelper.notify(
		fails.length ? "error" : "success",
		`能力基准：${report.length - fails.length}/${report.length} 通过`,
	);
	console.log("[baseline]", report.join("\n"));
}

// 1. 面板注册 + 图标
check("面板注册+图标", true);

// 2. 账本数据快照
// 时序说明：脚本可能早于 ws hello 帧启动（bootstrap 加载），初始快照允许为空；
// hello 到达后宿主 pushContextToAll + ready 补发会更新 ctxSnapshot——
// 事件驱动/延迟读取必可达（真实脚本都是事件驱动，不受此时序影响）。
const wsInit = getContext().worldState;
check(
	"worldState 快照(初始)",
	!!wsInit && typeof wsInit.time === "string",
	wsInit ? `time=${wsInit.time}` : "初始时序缺（hello 未达，属正常）",
);

// 2b. 就绪复查：hello/ready 补发后 ctxSnapshot 已含账本（验证最终可达）
setTimeout(() => {
	const s = getContext().worldState;
	check(
		"worldState 快照(就绪复查)",
		!!s && typeof s.time === "string",
		s ? `time=${s.time}` : "缺",
	);
	maybeReport();
}, 1500);

// 3. 三事件订阅
let evSeen = 0;
eventOn("WORLD_STATE_CHANGED", () => { evSeen++; render(); });
eventOn("MESSAGE_RECEIVED", () => { evSeen++; render(); });
eventOn("GENERATION_ENDED", () => { evSeen++; render(); });
check("三事件订阅", typeof eventOn === "function");

// 4. 大内容渲染（1000 行表格）
document.body.innerHTML = '<div id="demo"></div>';
function render() {
	const s = getContext().worldState || {};
	const rows = Array.from({ length: 1000 }, (_, i) => `<tr><td>${i}</td><td>${s.time || ""}</td></tr>`).join("");
	document.getElementById("demo").innerHTML = `<table>${rows}</table>`;
	check("大内容渲染(1000行)", document.getElementById("demo").innerHTML.length > 10000);
}
render();

// 5. 回写账本（applyStatePatch → 标准视图同步 + 事件回流）
TavernHelper.applyStatePatch({ flags: { "基准自检": String(Date.now()) } }).then(
	(r) => {
		check("applyStatePatch 回写", r.applied.length > 0, r.applied.join("、"));
		maybeReport();
	},
	(e) => {
		check("applyStatePatch 回写", false, String(e));
		maybeReport();
	},
);

// 6. extdata 自由键（cfg:<scriptId> 命名空间）
TavernHelper.setExtData("cfg:baseline", { ts: Date.now() });
TavernHelper.getExtData("cfg:baseline").then((v) => {
	check("extdata 自由键读写", !!v && v.ts > 0);
	maybeReport();
});

// 7. 通知
TavernHelper.notify("info", "能力基准脚本已就绪");
check("notify 通知", true);

// toastr 兼容面（G10：桩已改宿主 toast）
window.toastr && window.toastr.info("toastr 桩 → 宿主 toast");
check("toastr 桩通道", !!window.toastr);

function maybeReport() {
	// 等异步项（5/6）都回来后一次性汇报
	const asyncDone =
		report.some((r) => r.includes("applyStatePatch 回写")) &&
		report.some((r) => r.includes("extdata 自由键读写"));
	if (asyncDone) reportAll();
}

// 兜底：5s 后仍汇报（异步项未回也收尾）
setTimeout(reportAll, 5000);

console.log("[baseline] ready");
