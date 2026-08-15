import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildReviewPrompt,
	formatReviewReport,
	formatReviewViolation,
	parseReviewResult,
	REVIEW_PREFIX,
	reviewEvidenceOf,
	type ReviewIssue,
} from "../src/stage/review.ts";
import { DEFAULT_STYLE_BASELINE } from "../src/style-baseline.ts";

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
	dimension: "设定一致性",
	severity: "major",
	evidence: "他像是掂量这两个字的分量。",
	problem: "地点写错了——上一拍还在藏经阁。",
	suggestion: "改为书房场景。",
	...over,
});

test("buildReviewPrompt：systemPrompt 含三维度与 JSON 输出指令，userText 含现稿/人设/世界状态/文风基准", () => {
	const { systemPrompt, userText } = buildReviewPrompt({
		draft: "沈舟推门进了书房。",
		persona: "沈舟：冷淡寡言，只对棋局动容。",
		presetA: ["身份契约：她是藏经阁守书人。"],
		styleBaseline: DEFAULT_STYLE_BASELINE.default,
		worldState: "地点：藏经阁",
		language: "中文",
	});
	assert.ok(systemPrompt.includes("设定一致性"));
	assert.ok(systemPrompt.includes("人物一致性"));
	assert.ok(systemPrompt.includes("文风一致性"));
	assert.ok(systemPrompt.includes("只输出 JSON 对象"));
	assert.ok(userText.includes("沈舟推门进了书房。"));
	assert.ok(userText.includes("沈舟：冷淡寡言，只对棋局动容。"));
	assert.ok(userText.includes("身份契约：她是藏经阁守书人。"));
	assert.ok(userText.includes("【文风基准】"));
	assert.ok(userText.includes("看落日把海面烧成一片滚烫的金。"));
	assert.ok(userText.includes("地点：藏经阁"));
});

test("buildReviewPrompt：未提供文风卡时回退 styleTexts 原文", () => {
	const { userText } = buildReviewPrompt({
		draft: "沈舟推门进了书房。",
		persona: "",
		presetA: [],
		styleTexts: ["白描为主，少用比喻。"],
		worldState: "地点：藏经阁",
		language: "中文",
	});
	assert.ok(userText.includes("【文风基准】"));
	assert.ok(userText.includes("白描为主，少用比喻。"));
});

test("parseReviewResult：纯 JSON 解析出问题清单", () => {
	const r = parseReviewResult(
		JSON.stringify({ issues: [issue(), issue({ dimension: "文风与AI味", severity: "minor", problem: "有一处比喻。" })] }),
	);
	assert.ok(r);
	assert.equal(r.issues.length, 2);
	assert.equal(r.issues[0].dimension, "设定一致性");
	assert.equal(r.issues[0].severity, "major");
	assert.equal(r.issues[1].severity, "minor");
});

test("parseReviewResult：剥代码围栏；前言里的孤 { 不干扰解析", () => {
	const withFence = parseReviewResult("```json\n" + JSON.stringify({ issues: [issue()] }) + "\n```");
	assert.ok(withFence);
	assert.equal(withFence.issues.length, 1);

	const withIntro = parseReviewResult(`以下是评审结果 { 请注意 }：\n${JSON.stringify({ issues: [issue()] })}`);
	assert.ok(withIntro);
	assert.equal(withIntro.issues.length, 1);
});

test("parseReviewResult：非 JSON / 结构不对返回 null", () => {
	assert.equal(parseReviewResult("评审通过，无问题。"), null);
	assert.equal(parseReviewResult(""), null);
	assert.equal(parseReviewResult(JSON.stringify({ verdict: "pass" })), null, "无 issues 数组不收");
	assert.equal(parseReviewResult(JSON.stringify({ issues: "nope" })), null);
});

test("parseReviewResult：缺证据/缺描述的问题被过滤；severity 非法值归 major", () => {
	const r = parseReviewResult(
		JSON.stringify({
			issues: [
				issue(),
				{ dimension: "人物一致性", severity: "minor", evidence: "", problem: "没证据的不要" },
				{ dimension: "文风与AI味", severity: "banana", evidence: "这句有 AI 味。", problem: "严重度非法" },
			],
		}),
	);
	assert.ok(r);
	assert.equal(r.issues.length, 2);
	assert.equal(r.issues[1].severity, "major", "非法 severity 归 major（宁严勿漏）");
});

test("parseReviewResult：空 issues 数组返回空报告", () => {
	const r = parseReviewResult(JSON.stringify({ issues: [] }));
	assert.ok(r);
	assert.equal(r.issues.length, 0);
});

test("formatReviewViolation：前缀 + 证据截断 + 改法；reviewEvidenceOf 往返", () => {
	const v = formatReviewViolation(issue({ evidence: "x".repeat(100) }));
	assert.ok(v.startsWith(`${REVIEW_PREFIX}设定一致性]`));
	assert.ok(v.includes("证据：「"));
	assert.ok(!v.includes("x".repeat(41)), "证据应截断到 40 字");
	assert.ok(v.includes("改法：改为书房场景。"));
	assert.equal(reviewEvidenceOf(v), "x".repeat(40));
	assert.equal(reviewEvidenceOf("没有证据的普通违规"), null);
});

test("formatReviewReport：全通过 / major+minor 分层 / gate=all 全拦", () => {
	const pass = formatReviewReport({ issues: [] }, "major");
	assert.equal(pass, "【语义评审】通过：未发现设定/人物/文风问题。");

	const report = {
		issues: [
			issue(),
			issue({ dimension: "文风与AI味", severity: "minor", problem: "有一处比喻。" }),
		],
	};
	const majorOnly = formatReviewReport(report, "major");
	assert.ok(majorOnly.includes("1 处需处理"));
	assert.ok(majorOnly.includes("[评审·设定一致性]"));
	assert.ok(majorOnly.includes("轻微提示"));
	assert.ok(majorOnly.includes("不拦推进"));

	const all = formatReviewReport(report, "all");
	assert.ok(all.includes("2 处需处理"));
});
