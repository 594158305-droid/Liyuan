import assert from "node:assert/strict";
import { test } from "node:test";

import {
	hasAssistantRunner,
	isAssistantDelegateActive,
	registerAssistantRunner,
	runAssistantTask,
} from "../src/assistant-gateway.ts";

test("无 runner 时 runAssistantTask 返回友好失败", async () => {
	registerAssistantRunner(null);
	assert.equal(hasAssistantRunner(), false);
	const r = await runAssistantTask({ task: "生图" });
	assert.equal(r.ok, false);
	assert.ok(r.summary.includes("不可用"));
});

test("delegate 深度与 runner 调用", async () => {
	let seen = "";
	registerAssistantRunner(async (req) => {
		assert.equal(isAssistantDelegateActive(), true, "runner 执行期间应处于委托");
		seen = req.task;
		return { ok: true, summary: "done", media: [], panelsWritten: ["地图"] };
	});
	assert.equal(isAssistantDelegateActive(), false);
	const r = await runAssistantTask({ task: "按剧情生图", mode: "ops" });
	assert.equal(isAssistantDelegateActive(), false, "结束后退出委托");
	assert.equal(r.ok, true);
	assert.equal(seen, "按剧情生图");
	assert.deepEqual(r.panelsWritten, ["地图"]);
	registerAssistantRunner(null);
});

test("globalThis 槽：模拟 jiti/ESM 双实例仍共享 runner", async () => {
	// 直接写 global 槽再经 API 读，验证不依赖 module-level let。
	// 槽形状 = P3 多 agent 注册表：{ runners: Record<name, runner|null>, delegateDepth }，
	// 内置助手别名注册在 "assistant" 键（registerAssistantRunner → registerAgentRunner("assistant")）。
	const KEY = "__liyuanAssistantGateway__";
	const g = globalThis as typeof globalThis & {
		[KEY]?: { runners: Record<string, unknown>; delegateDepth: number };
	};
	g[KEY] = {
		runners: {
			assistant: async () => ({ ok: true, summary: "from-global", media: [], panelsWritten: [] }),
		},
		delegateDepth: 0,
	};
	assert.equal(hasAssistantRunner(), true);
	const r = await runAssistantTask({ task: "x" });
	assert.equal(r.summary, "from-global");
	registerAssistantRunner(null);
});
