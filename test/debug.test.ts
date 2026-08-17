import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	configureDebug,
	debug,
	debugConfig,
	debugFileEnabled,
	debugPrintEnabled,
	type DebugLevel,
} from "../src/debug.ts";

/** 捕获 console 输出（stub 替换，测完恢复），返回捕获消息数组 */
function captureConsole(): { msgs: string[]; restore: () => void } {
	const out: string[] = [];
	const origInfo = console.info;
	const origLog = console.log;
	const origWarn = console.warn;
	const origError = console.error;
	console.info = (...a) => out.push("INFO " + a.join(" "));
	console.log = (...a) => out.push("INFO " + a.join(" "));
	console.warn = (...a) => out.push("WARN " + a.join(" "));
	console.error = (...a) => out.push("ERROR " + a.join(" "));
	return {
		msgs: out,
		restore: () => {
			console.info = origInfo;
			console.log = origLog;
			console.warn = origWarn;
			console.error = origError;
		},
	};
}

let dirs: string[] = [];
const makeLogFile = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-debug-"));
	dirs.push(dir);
	return join(dir, "debug.log");
};

test.after(() => {
	for (const d of dirs) {
		rmSync(d, { recursive: true, force: true });
	}
});

test("调试接口：默认全开，INFO/WARNING/ERROR 三条通道都到达 console", () => {
	// 默认状态应在测试前解析模块后保持全开
	assert.equal(debugPrintEnabled(), true);
	assert.equal(debugFileEnabled(), true);
	const { msgs, restore } = captureConsole();
	try {
		debug.info("t", "info消息");
		debug.warning("t", "warn消息");
		debug.error("t", "error消息");
	} finally {
		restore();
	}
	assert.ok(msgs.some((m) => m.includes("INFO") && m.includes("info消息") && m.includes("[t]")));
	assert.ok(msgs.some((m) => m.includes("WARN") && m.includes("warn消息")));
	assert.ok(msgs.some((m) => m.includes("ERROR") && m.includes("error消息")));
});

test("调试接口：WARNING/ERROR 走 console.warn/console.error", () => {
	const { msgs, restore } = captureConsole();
	try {
		debug.warning("t", "w-abc");
		debug.error("t", "e-abc");
	} finally {
		restore();
	}
	assert.ok(msgs.some((m) => m.startsWith("WARN") && m.includes("w-abc")));
	assert.ok(msgs.some((m) => m.startsWith("ERROR") && m.includes("e-abc")));
});

test("调试接口：写 JSONL 日志文件（结构化 detail）", () => {
	const fp = makeLogFile();
	configureDebug({ filePath: fp, file: true, console: false });
	const { restore } = captureConsole(); // 关 console 防刷屏
	try {
		debug.warning("test", "写文件消息", { n: 42 });
	} finally {
		restore();
	}
	configureDebug({ filePath: fp, file: false, console: true });
	assert.equal(existsSync(fp), true);
	const lines = readFileSync(fp, "utf8").split("\n").filter(Boolean);
	assert.ok(lines.length >= 1);
	const first = JSON.parse(lines[0]!) as { level?: DebugLevel; category?: string; message?: string; detail?: { n?: number } };
	assert.equal(first.level, "warning");
	assert.equal(first.category, "test");
	assert.equal(first.message, "写文件消息");
	assert.equal(first.detail?.n, 42);
});

test("调试接口：console=false 关掉打印但文件仍写；file=false 反之", () => {
	const fp = makeLogFile();
	// console 关、file 开
	configureDebug({ filePath: fp, file: true, console: false });
	let { msgs, restore } = captureConsole();
	try {
		debug.warning("t", "只进文件");
	} finally {
		restore();
	}
	assert.equal(msgs.length, 0, "console 关闭时不应打印");
	// file 关、console 开
	configureDebug({ filePath: fp, file: false, console: true });
	({ msgs, restore } = captureConsole());
	try {
		debug.error("t", "只进控制台");
	} finally {
		restore();
	}
	const content = readFileSync(fp, "utf8");
	assert.ok(content.includes("只进文件"));
	assert.ok(!content.includes("只进控制台"), "file 关闭时不应写文件");
	assert.ok(msgs.some((m) => m.includes("只进控制台")));
	// 恢复默认
	configureDebug({ filePath: fp, file: true, console: true });
});

test("调试接口：minLevel 过滤（error 级以下不输出）", () => {
	configureDebug({ minLevel: "error" });
	const { msgs, restore } = captureConsole();
	try {
		debug.info("t", "info被过滤");
		debug.warning("t", "warn被过滤");
		debug.error("t", "error放行");
	} finally {
		restore();
	}
	configureDebug({ minLevel: "info" });
	assert.ok(msgs.some((m) => m.includes("error放行")));
	assert.ok(!msgs.some((m) => m.includes("info被过滤")));
	assert.ok(!msgs.some((m) => m.includes("warn被过滤")));
});

test("调试接口：debugLog 统一入口按级别分发", () => {
	const { msgs, restore } = captureConsole();
	try {
		debug.log("info", "t", "log-info");
		debug.log("error", "t", "log-error");
	} finally {
		restore();
	}
	assert.ok(msgs.some((m) => m.includes("INFO") && m.includes("log-info")));
	assert.ok(msgs.some((m) => m.includes("ERROR") && m.includes("log-error")));
});

test("调试接口：configureDebug 增量合并，debugConfig 反映合并后状态", () => {
	const fp = makeLogFile();
	configureDebug({ filePath: fp, file: true, console: true, minLevel: "warning" });
	configureDebug({ console: false });
	const cfg = debugConfig();
	assert.equal(cfg.filePath, fp);
	assert.equal(cfg.file, true);
	assert.equal(cfg.console, false);
	assert.equal(cfg.minLevel, "warning");
	// 恢复
	configureDebug({ filePath: "", file: true, console: true, minLevel: "info" });
});

test("调试接口：日志写文件失败静默不抛（不影响主链路）", () => {
	configureDebug({ filePath: join(tmpdir(), "无权限目录", "x", "debug.log"), file: true, console: false });
	const { restore } = captureConsole();
	try {
		// 不应抛异常
		debug.error("t", "写不进也不炸");
	} finally {
		restore();
	}
	configureDebug({ filePath: "", file: true, console: true });
});

// 容器启动即配置了默认日志路径的副作用，验证重复配置幂等（不抛）
test("调试接口：configureDebug 重复调用幂等", () => {
	configureDebug({ filePath: "", console: true, file: true, minLevel: "info" });
	configureDebug({ console: true, minLevel: "info" });
	configureDebug({});
	assert.equal(typeof debugConfig().filePath, "string");
});
