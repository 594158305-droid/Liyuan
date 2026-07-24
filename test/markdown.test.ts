import assert from "node:assert/strict";
import test from "node:test";
import { splitMarkdownParts } from "../web/src/markdown.ts";

test("splitMarkdownParts: 无围栏整段 text", () => {
	const p = splitMarkdownParts("你好\n\n世界");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
	if (p[0].kind === "text") assert.equal(p[0].text, "你好\n\n世界");
});

test("splitMarkdownParts: Options 形态无 lang 围栏 → code 段", () => {
	const text = "洛清霜说完。\n\n```\n选择1: 【留下】\n选择2: 【下山】\n```\n";
	const p = splitMarkdownParts(text);
	assert.equal(p.length, 2);
	assert.equal(p[0].kind, "text");
	if (p[0].kind === "text") assert.ok(p[0].text.includes("洛清霜说完"));
	assert.equal(p[1].kind, "code");
	if (p[1].kind === "code") {
		assert.equal(p[1].lang, "");
		assert.ok(p[1].code.includes("选择1: 【留下】"));
		assert.ok(p[1].code.includes("选择2: 【下山】"));
		assert.ok(!p[1].code.includes("```"));
	}
});

test("splitMarkdownParts: 带 lang 的围栏", () => {
	const p = splitMarkdownParts("前\n```yaml\n时间: 晨\n```\n后");
	assert.equal(p.length, 3);
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "code");
	if (p[1].kind === "code") {
		assert.equal(p[1].lang, "yaml");
		assert.equal(p[1].code, "时间: 晨");
	}
	assert.equal(p[2].kind, "text");
	if (p[2].kind === "text") assert.ok(p[2].text.includes("后"));
});

test("splitMarkdownParts: 行中 ``` 不切（非行首）", () => {
	const p = splitMarkdownParts("他说 ```不是围栏");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitMarkdownParts: 未闭合围栏当文本", () => {
	const p = splitMarkdownParts("```\n只有开头");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});
