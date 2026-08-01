import assert from "node:assert/strict";
import test from "node:test";
import { buildSrcDoc, looksLikeProgramApp, programViewportHeight } from "../web/src/frameDoc.ts";

test("programViewportHeight: 约 78vh 且有上下限", () => {
	assert.equal(programViewportHeight({ innerHeight: 1000 }), 780);
	assert.ok(programViewportHeight({ innerHeight: 400 }) >= 480);
	assert.ok(programViewportHeight({ innerHeight: 4000 }) <= 2400);
});

/** 道渊开局创建器形态：根级接管 CSS + 100vh 容器 + fixed 星空层 */
const takeoverDoc =
	"<!doctype html><html><head><style>html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }" +
	"#main { width: 100%; height: 100vh; position: relative; }" +
	"#stars { position: fixed; inset: 0; }</style></head>" +
	"<body><div id=main><div id=stars></div></div><script>1</script></body></html>";

/** 道渊「开局创造角色」形态：根级接管 CSS 但全程无 position:fixed */
const takeoverNoFixed =
	"<!doctype html><html><head><style>html, body{height:100%;overflow:hidden}" +
	".stage{height:100vh}</style></head><body><div class=stage></div><script>1</script></body></html>";

/** 道渊 MVU/XML 状态栏形态：大体积整页 + fixed 弹窗，但零 vh、根级无接管 CSS → 内容流 */
const statusBigDoc =
	"<!doctype html><html><head><style>.modal{position:fixed;inset:0;display:none}.card{width:100%}</style></head>" +
	"<body><div class=card>状态</div><script>" +
	"x".repeat(180_000) +
	"</script></body></html>";

test("looksLikeProgramApp: 视口接管 CSS / fixed+vh 才算；体积不作数", () => {
	assert.equal(looksLikeProgramApp("<div>hi</div>", true), false);
	// 旧「≥25KB 即程序卡」规则的回归钉：大体积裸文本/大状态栏不得锁 78vh（道渊 MVU 事故）
	assert.equal(looksLikeProgramApp("x".repeat(25_000), true), false);
	assert.equal(looksLikeProgramApp(statusBigDoc, true), false);
	assert.equal(looksLikeProgramApp(takeoverDoc, false), false, "scripts=false 一律非程序卡");
	// 短 doctype+script（状态栏）不得锁 78vh
	assert.equal(
		looksLikeProgramApp("<!doctype html><html><body><script>1</script></body></html>", true),
		false,
	);
	// 根级接管 CSS：有无 fixed 都认（道渊两个开局创建器）
	assert.equal(looksLikeProgramApp(takeoverDoc, true), true);
	assert.equal(looksLikeProgramApp(takeoverNoFixed, true), true);
	// fixed 铺满 + 视口单位（body 内联样式，无根级 CSS 块）
	assert.equal(
		looksLikeProgramApp(
			"<!doctype html><html><body style='position:fixed;inset:0;height:100vh'><script>1</script></body></html>",
			true,
		),
		true,
	);
	// min-height:100vh 是「至少一屏」的内容流写法，不算接管
	assert.equal(
		looksLikeProgramApp(
			"<!doctype html><html><head><style>body{min-height:100%;overflow:hidden}</style></head><body><script>1</script></body></html>",
			true,
		),
		false,
	);
	// LWS 量级状态栏（约 11KB + script）不应当 program
	const statusLike =
		"<!doctype html><html><head></head><body><div class='card'>状态</div><script>" +
		"x".repeat(10_000) +
		"</script></body></html>";
	assert.equal(looksLikeProgramApp(statusLike, true), false);
});

test("buildSrcDoc 接管型:不注入 height:auto 覆盖、不注入高度上报（道渊抖动/塌陷根修）", () => {
	const doc = buildSrcDoc(takeoverDoc, true, true);
	assert.ok(!doc.includes("height:auto!important"), "不得打断卡自己的 height:100% 链");
	assert.ok(!doc.includes("overflow:visible!important"), "不得掀开卡自己的 overflow:hidden");
	assert.ok(!doc.includes("liyuanFrameHeight"), "视口锁高，不上报内容高（防乒乓抖动）");
	assert.ok(doc.includes("background:transparent"), "透明兜底仍在");
	assert.ok(doc.includes("TavernHelper"), "垫片桥仍在");
});

test("buildSrcDoc 内容流大文档:保留 height:auto 覆盖与高度上报（MVU 状态栏）", () => {
	const doc = buildSrcDoc(statusBigDoc, true, true);
	assert.ok(doc.includes("height:auto!important"));
	assert.ok(doc.includes("liyuanFrameHeight"));
});
