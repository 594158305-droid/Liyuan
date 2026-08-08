/**
 * 生图请求队列单测：并发 1 严格串行、冷却 0 无延迟、冷却只在成功后生效、abort、pending 计数。
 * 运行：node --test test/draw-queue.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DrawRequestQueue } from "../src/draw/queue.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("queue: 并发 1 严格串行 + FIFO", async () => {
	const q = new DrawRequestQueue({ concurrency: 1, cooldownMs: 0 });
	const order: number[] = [];
	const running = { n: 0, max: 0 };
	const tasks = [1, 2, 3, 4].map((i) =>
		q.enqueue(async () => {
			order.push(i);
			running.n++;
			running.max = Math.max(running.max, running.n);
			await delay(5);
			running.n--;
			return i;
		}),
	);
	const results = await Promise.all(tasks);
	assert.deepEqual(order, [1, 2, 3, 4]); // FIFO 顺序
	assert.deepEqual(results, [1, 2, 3, 4]);
	assert.equal(running.max, 1); // 从未并行
});

test("queue: cooldownMs 0 无延迟", async () => {
	const q = new DrawRequestQueue({ concurrency: 1, cooldownMs: 0 });
	const start = Date.now();
	await q.enqueue(async () => delay(5));
	await q.enqueue(async () => delay(5));
	await q.enqueue(async () => delay(5));
	const elapsed = Date.now() - start;
	assert.ok(elapsed < 2000, `cooldownMs=0 不应有等待，elapsed=${elapsed}`);
});

test("queue: 冷却只在成功完成后生效（失败不阻塞后续）", async () => {
	const q = new DrawRequestQueue({ concurrency: 1, cooldownMs: 300 });
	const start = Date.now();
	await q
		.enqueue(async () => {
			throw new Error("任务失败");
		})
		.catch(() => {});
	await q.enqueue(async () => delay(5));
	const elapsed = Date.now() - start;
	assert.ok(elapsed < 2000, `失败后不应等冷却，elapsed=${elapsed}`);
});

test("queue: 成功后冷却（>0）阻塞后续任务", async () => {
	const q = new DrawRequestQueue({ concurrency: 1, cooldownMs: 300 });
	const start = Date.now();
	await q.enqueue(async () => delay(5));
	await q.enqueue(async () => delay(5));
	const elapsed = Date.now() - start;
	assert.ok(elapsed >= 250, `成功冷却后应等待，elapsed=${elapsed}`);
});

test("queue: abortAll 拒绝等待中的任务并中止运行中的 signal", async () => {
	const q = new DrawRequestQueue({ concurrency: 1, cooldownMs: 0 });
	// 运行中：响应 signal 中止
	const p1 = q.enqueue(
		(sig) =>
			new Promise((_resolve, reject) => {
				sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	);
	const p2 = q.enqueue(async () => "ok"); // 排队等待中
	assert.equal(q.pending, 2);
	q.abortAll();
	await assert.rejects(p1);
	await assert.rejects(p2);
	// 中止后再入队直接拒绝
	await assert.rejects(q.enqueue(async () => "x"));
	assert.equal(q.pending, 0);
});
