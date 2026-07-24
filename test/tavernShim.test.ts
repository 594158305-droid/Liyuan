import assert from "node:assert/strict";
import test from "node:test";
import { buildSrcDoc } from "../web/src/frameDoc.ts";
import {
	IFRAME_TAVERN_BRIDGE_SNIPPET,
	executeTriggerSlash,
	installEventBus,
	installParentTavernShim,
	parseSlashPipeline,
	registerTavernChatBridge,
} from "../web/src/tavernShim.ts";

test("IFRAME_TAVERN_BRIDGE_SNIPPET 自包含并暴露 TavernHelper/eventOn/triggerSlash", () => {
	assert.ok(IFRAME_TAVERN_BRIDGE_SNIPPET.startsWith("<script>"));
	assert.ok(IFRAME_TAVERN_BRIDGE_SNIPPET.includes("TavernHelper"));
	assert.ok(IFRAME_TAVERN_BRIDGE_SNIPPET.includes("eventOn"));
	assert.ok(IFRAME_TAVERN_BRIDGE_SNIPPET.includes("eventEmit"));
	assert.ok(IFRAME_TAVERN_BRIDGE_SNIPPET.includes("TheaterAPI"));
	assert.ok(IFRAME_TAVERN_BRIDGE_SNIPPET.includes("triggerSlash"));
});

test("parseSlashPipeline: 管道分段", () => {
	assert.deepEqual(parseSlashPipeline("/send hello|/trigger"), ["/send hello", "/trigger"]);
});

test("executeTriggerSlash: /send|/trigger 调用 sendPrompt", () => {
	let sent = "";
	let filled = "";
	registerTavernChatBridge({
		setInput: (t) => {
			filled = t;
		},
		sendPrompt: (t) => {
			sent = t;
		},
	});
	const r = executeTriggerSlash(
		"/send 姓名：旅人；出身：山村|/trigger",
		{
			setInput: (t) => {
				filled = t;
			},
			sendPrompt: (t) => {
				sent = t;
			},
		},
	);
	assert.equal(r.ok, true);
	assert.equal(r.triggered, true);
	assert.ok(sent.includes("旅人"));
	assert.equal(filled, ""); // 直发，不必先 setInput
	registerTavernChatBridge(null);
});

test("executeTriggerSlash: 仅 /send 填输入框", () => {
	let filled = "";
	const r = executeTriggerSlash("/send 只注入不发送", {
		setInput: (t) => {
			filled = t;
		},
		sendPrompt: () => {
			throw new Error("不应触发发送");
		},
	});
	assert.equal(r.ok, true);
	assert.equal(r.filledOnly, true);
	assert.equal(filled, "只注入不发送");
});

test("installEventBus: eventOn/eventEmit 可互通", () => {
	const target: {
		eventOn?: (n: string, cb: (...a: unknown[]) => void) => void;
		eventEmit?: (n: string, ...a: unknown[]) => void;
	} = {};
	installEventBus(target);
	let got = "";
	target.eventOn!("ping", (x) => {
		got = String(x);
	});
	target.eventEmit!("ping", "ok");
	assert.equal(got, "ok");
});

test("installParentTavernShim: generate 返回字符串 Promise", async () => {
	// jsdom-less: 模拟 window
	const g = globalThis as typeof globalThis & {
		window?: object;
		TavernHelper?: { generate: (p?: { user_input?: string }) => Promise<string>; stopAllGeneration: () => void };
		__liyuanTavernShimInstalled?: boolean;
	};
	const prev = g.window;
	const fakeWin: Record<string, unknown> = {};
	g.window = fakeWin;
	// 直接在 fake 上装（实现读 window）
	// 改用把 shim 装到 fakeWin 上：临时 patch
	const { installParentTavernShim: install } = await import("../web/src/tavernShim.ts");
	// re-install clean
	delete (fakeWin as { __liyuanTavernShimInstalled?: boolean }).__liyuanTavernShimInstalled;
	// installParentTavernShim uses global window
	Object.assign(g, { window: fakeWin });
	// Need install to use our fakeWin - it checks typeof window
	// In node, window may be undefined. Patch:
	(globalThis as unknown as { window: Record<string, unknown> }).window = fakeWin;
	delete fakeWin.__liyuanTavernShimInstalled;
	install();
	const th = fakeWin.TavernHelper as {
		generate: (p?: { user_input?: string }) => Promise<string>;
		stopAllGeneration: () => void;
	};
	assert.ok(th);
	const text = await th.generate({ user_input: "你好修仙" });
	assert.equal(typeof text, "string");
	assert.ok(text.includes("梨园") || text.includes("你好修仙"));
	th.stopAllGeneration();
	if (prev === undefined) delete (globalThis as { window?: unknown }).window;
	else (globalThis as { window: unknown }).window = prev;
});

test("buildSrcDoc scripts: 桥在卡内容之前", () => {
	const doc = buildSrcDoc("<!doctype html><html><head></head><body><script>window.__card=1</script></body></html>", true, true);
	const iBridge = doc.indexOf("TavernHelper");
	const iCard = doc.indexOf("__card");
	assert.ok(iBridge > 0 && iCard > 0 && iBridge < iCard, "垫片须先于卡脚本");
});
