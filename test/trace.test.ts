import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";

import { TraceRecorder } from "../src/stage/trace.ts";

/** 每条事件一行 JSON，逐行解析校验 */
function readLines(file: string): Array<Record<string, unknown>> {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

test("TraceRecorder：事件按 JSONL 追加写，每条单行且可逐行解析", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
	try {
		const r = new TraceRecorder(dir);
		r.record("s1", { kind: "turn_start", userText: "你好" });
		r.record("s1", { kind: "thinking", round: 0, text: "想……" });
		r.record("s1", { kind: "turn_end", aborted: false, elapsedMs: 123 });

		const raw = readFileSync(join(dir, "s1.jsonl"), "utf8");
		const lines = raw.trim().split("\n");
		assert.equal(lines.length, 3, "每事件一行");
		assert.ok(!raw.includes("\n\n"), "无空行（长文本换行已被转义，真实换行只做行分隔）");
		assert.ok(lines.every((l) => l.startsWith("{") && l.endsWith("}")), "每行都是完整 JSON");

		const events = readLines(join(dir, "s1.jsonl"));
		assert.deepEqual(events.map((e) => e.kind), ["turn_start", "thinking", "turn_end"]);
		assert.ok(typeof events[0].ts === "string" && !Number.isNaN(Date.parse(events[0].ts as string)), "自动补 ts");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TraceRecorder：按会话分文件，互不串扰", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
	try {
		const r = new TraceRecorder(dir);
		r.record("s1", { kind: "turn_start", userText: "甲" });
		r.record("s2", { kind: "turn_start", userText: "乙" });
		r.record("s1", { kind: "turn_end", aborted: false, elapsedMs: 1 });

		const f1 = readLines(join(dir, "s1.jsonl"));
		const f2 = readLines(join(dir, "s2.jsonl"));
		assert.equal(f1.length, 2);
		assert.equal(f2.length, 1);
		assert.equal(f2[0].userText, "乙");
		assert.deepEqual(readdirSync(dir).sort(), ["s1.jsonl", "s2.jsonl"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TraceRecorder：openSession 幂等——同进程重复调用只写一次会话头", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
	try {
		const r = new TraceRecorder(dir);
		r.openSession("s1", { sessionId: "s1", cardPath: "assets/cards/青梧.json", preset: "梦鲸" });
		r.openSession("s1", { sessionId: "s1", cardPath: "assets/cards/青梧.json" });
		r.record("s1", { kind: "turn_start", userText: "嗨" });

		const events = readLines(join(dir, "s1.jsonl"));
		assert.equal(events.length, 2, "会话头只写一次");
		assert.equal(events[0].kind, "session");
		assert.equal(events[0].cardPath, "assets/cards/青梧.json");
		assert.equal(events[0].preset, "梦鲸");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TraceRecorder：openSession 对已有文件不重写头（跨进程重启场景）", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
	try {
		const r = new TraceRecorder(dir);
		r.record("s1", { kind: "turn_start", userText: "旧" });
		// 模拟新进程：新 recorder 实例、文件已存在
		const r2 = new TraceRecorder(dir);
		r2.openSession("s1", { sessionId: "s1", cardPath: "其他卡.json" });
		r2.record("s1", { kind: "turn_end", aborted: false, elapsedMs: 1 });

		const events = readLines(join(dir, "s1.jsonl"));
		assert.equal(events.length, 2);
		assert.equal(events[0].kind, "turn_start", "头不被重写，首条仍是旧事件");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TraceRecorder：长文本（含换行/引号）单行原样保留，读回一致", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
	try {
		const r = new TraceRecorder(dir);
		const longText = "第一段\n\n第二段 \"引号\" \\ 反斜杠\n第三段：".repeat(2000);
		r.record("s1", { kind: "prompt", systemPrompt: longText, messages: [], tools: undefined });

		const raw = readFileSync(join(dir, "s1.jsonl"), "utf8");
		assert.equal((raw.trim().match(/\n/g) ?? []).length, 0, "长文本转义后仍在单行内");
		const [ev] = readLines(join(dir, "s1.jsonl"));
		assert.equal(ev.systemPrompt, longText, "读回与原文一致");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TraceRecorder：list 返回元信息且按 mtime 倒序；空目录返回空数组", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
	try {
		const r = new TraceRecorder(dir);
		assert.deepEqual(r.list(), []);
		r.record("a", { kind: "turn_start", userText: "1" });
		r.record("b", { kind: "turn_start", userText: "2" });
		const files = r.list();
		assert.equal(files.length, 2);
		const names = files.map((f) => f.name);
		assert.ok(names.includes("a.jsonl") && names.includes("b.jsonl"));
		for (const f of files) {
			assert.ok(f.size > 0);
			assert.ok(!Number.isNaN(Date.parse(f.mtime)));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TraceRecorder：fileOf 对恶意 sessionId 做 sanitize，路径不逃出跟踪目录", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
	try {
		const r = new TraceRecorder(dir);
		const evil = r.fileOf("../escape/../../secret");
		assert.ok(resolve(evil).startsWith(resolve(dir) + sep), "解析后仍在跟踪目录内");
		assert.ok(!resolve(evil).includes(resolve(dir) + sep + ".." + sep), "不含跳转路径段");
		// 真实写入也不越界：恶意 id 只会生成目录内的替身文件名
		r.record("../escape/../../secret", { kind: "turn_start", userText: "x" });
		assert.deepEqual(readdirSync(dir), [".._escape_.._.._secret.jsonl"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
