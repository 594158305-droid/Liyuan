import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeProgramApp, programViewportHeight } from "../web/src/frameDoc.ts";

test("programViewportHeight: 约 78vh 且有上下限", () => {
	assert.equal(programViewportHeight({ innerHeight: 1000 }), 780);
	assert.ok(programViewportHeight({ innerHeight: 400 }) >= 480);
	assert.ok(programViewportHeight({ innerHeight: 4000 }) <= 2400);
});

test("looksLikeProgramApp: 大体积 / 全屏 fixed；状态栏 doctype+script 不算", () => {
	assert.equal(looksLikeProgramApp("<div>hi</div>", true), false);
	assert.equal(looksLikeProgramApp("x".repeat(25_000), true), true);
	assert.equal(looksLikeProgramApp("x".repeat(25_000), false), false);
	// 短 doctype+script（状态栏）不得锁 78vh
	assert.equal(
		looksLikeProgramApp("<!doctype html><html><body><script>1</script></body></html>", true),
		false,
	);
	// 全屏程序卡特征
	assert.equal(
		looksLikeProgramApp(
			"<!doctype html><html><body style='position:fixed;inset:0;height:100vh'><script>1</script></body></html>",
			true,
		),
		true,
	);
	// LWS 量级状态栏（约 11KB + script）不应当 program
	const statusLike =
		"<!doctype html><html><head></head><body><div class='card'>状态</div><script>" +
		"x".repeat(10_000) +
		"</script></body></html>";
	assert.equal(looksLikeProgramApp(statusLike, true), false);
});
