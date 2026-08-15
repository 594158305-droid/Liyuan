// 临时验证脚本（验证完删除）：自定义 agent 面板选模型 → follow 翻转 + 配置持久化
// 只做 ws 交互断言；配置落盘用 read 工具事后核对（沙箱拦 node 写仓库，服务进程自己写不受影响）。
// 用法：node scripts/verify-agent-model.mjs （服务须已在 PORT 上运行）
import WebSocket from "ws";

const PORT = process.env.PORT || 7621;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = "") => {
	results.push({ name, ok: !!cond });
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
};
const send = (f) => ws.send(JSON.stringify(f));

let lastHello = null;
ws.on("message", (data) => {
	const f = JSON.parse(data.toString());
	if (f.type === "assistant_hello") lastHello = f;
});

const waitHello = async (agentId) => {
	lastHello = null;
	send({ type: "assistant_sync", agentId });
	for (let i = 0; i < 60; i++) {
		if (lastHello) return lastHello;
		await timeout(100);
	}
	return null;
};

ws.on("open", async () => {
	try {
		// 1. director 初始：配置无 model → 跟随
		let h = await waitHello("director");
		check("director 初始 follow=true", h && h.follow === true, h ? JSON.stringify(h.model) : "no hello");

		// 2. 选模型 opencode-go/deepseek-v4-flash → follow=false + hello.model=所选
		lastHello = null;
		send({ type: "assistant_model", agentId: "director", provider: "opencode-go", id: "deepseek-v4-flash" });
		h = await waitHello("director");
		check("选模型后 follow=false", h && h.follow === false, h ? JSON.stringify(h.model) : "no hello");
		check("hello.model = 所选模型", h && h.model && h.model.provider === "opencode-go" && h.model.id === "deepseek-v4-flash", JSON.stringify(h?.model));

		// 3. 回到跟随（无参）→ follow=true
		lastHello = null;
		send({ type: "assistant_model", agentId: "director" });
		h = await waitHello("director");
		check("回到跟随 follow=true", h && h.follow === true, JSON.stringify(h?.model));

		// 4. 内置助手回归：选回原 assistantModel（同值，不破坏用户配置）→ follow=false 不炸
		lastHello = null;
		send({ type: "assistant_model", provider: "opencode-go", id: "deepseek-v4-flash" });
		h = await waitHello("assistant");
		check("内置助手 setModel 同值不炸且 follow=false", h && h.follow === false, JSON.stringify(h?.model));
	} catch (err) {
		console.error("SCRIPT ERROR:", err);
		results.push({ name: "script", ok: false });
	} finally {
		const fails = results.filter((r) => !r.ok);
		console.log(`\n==== ${results.length - fails.length}/${results.length} PASS ====`);
		ws.close();
		process.exit(fails.length ? 1 : 0);
	}
});

ws.on("error", (e) => {
	console.error("WS ERROR:", e.message);
	process.exit(2);
});
