import assert from "node:assert/strict";
import test from "node:test";
import { toWireMsg } from "../server/wire.ts";
import { buildSrcDoc, HEIGHT_REPORTER_SNIPPET } from "../web/src/frameDoc.ts";
import { looksLikeHtmlDocument, splitHtmlParts } from "../web/src/htmlEmbed.ts";

const names = { charName: "角色", userName: "用户" };

test("show_html toolResult -> html channel", () => {
	const w = toWireMsg(
		{
			role: "toolResult",
			toolName: "show_html",
			content: [{ type: "text", text: "ok" }],
			details: {
				rpHtml: {
					html: '<div class="phone">hi</div>',
					title: "微信",
					scripts: true,
				},
			},
		},
		names,
	);
	assert.ok(w);
	assert.equal(w!.channel, "html");
	assert.equal(w!.html, '<div class="phone">hi</div>');
	assert.equal(w!.text, "微信");
	assert.equal(w!.scripts, true);
});

test("show_html error / empty skip", () => {
	assert.equal(
		toWireMsg(
			{ role: "toolResult", toolName: "show_html", isError: true, details: { rpHtml: { html: "x" } } },
			names,
		),
		null,
	);
	assert.equal(
		toWireMsg({ role: "toolResult", toolName: "show_html", details: { rpHtml: { html: "  " } } }, names),
		null,
	);
});

test("fenced html splits", () => {
	const parts = splitHtmlParts("旁白\n```html\n<div>短信</div>\n```\n继续");
	assert.equal(parts.filter((p) => p.kind === "html").length, 1);
	const h = parts.find((p) => p.kind === "html");
	assert.ok(h && h.kind === "html" && h.html.includes("短信"));
});

test("scripts fence", () => {
	const parts = splitHtmlParts("```html scripts\n<button id=b>x</button>\n```");
	assert.equal(parts[0].kind, "html");
	if (parts[0].kind === "html") assert.equal(parts[0].scripts, true);
});

test("full document", () => {
	assert.equal(looksLikeHtmlDocument("<!DOCTYPE html><html></html>"), true);
	const parts = splitHtmlParts("<!DOCTYPE html><html><body>开场</body></html>");
	assert.equal(parts.length, 1);
	assert.equal(parts[0].kind, "html");
});

test("buildSrcDoc seamless 静态:不强制字体,保留透明底", () => {
	const doc = buildSrcDoc("<div>x</div>", false, true);
	assert.ok(!doc.includes("PingFang"));
	assert.ok(doc.includes("background:transparent"));
	assert.ok(!doc.includes("liyuanFrameHeight"));
});

test("buildSrcDoc seamless 脚本帧:注入高度上报", () => {
	const doc = buildSrcDoc("<div>x</div>", true, true);
	assert.ok(doc.includes("liyuanFrameHeight"));
	assert.ok(doc.includes("ResizeObserver"));
});

test("buildSrcDoc 非 seamless:行为与旧版一致(仍带基础字体)", () => {
	const doc = buildSrcDoc("<div>x</div>", false, false);
	assert.ok(doc.includes("PingFang"));
});

test("HEIGHT_REPORTER_SNIPPET 是自包含 script", () => {
	assert.ok(HEIGHT_REPORTER_SNIPPET.startsWith("<script>"));
	assert.ok(HEIGHT_REPORTER_SNIPPET.endsWith("</script>"));
});

test("sandbox 矩阵:脚本帧无 same-origin 语义由 HtmlFrame 保证;srcdoc CSP 脚本帧含 script-src", () => {
	const scriptDoc = buildSrcDoc("<div>x</div>", true, true);
	const staticSeamless = buildSrcDoc("<div>x</div>", false, true);
	assert.ok(scriptDoc.includes("script-src"));
	assert.ok(!staticSeamless.includes("script-src"));
	// 静态 seamless 不注入高度 reporter 脚本
	assert.ok(!staticSeamless.includes("<script>"));
});
