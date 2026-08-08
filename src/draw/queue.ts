/**
 * 生图请求队列 + 限流：FIFO 排队、并发上限、任务成功后冷却。
 *
 * - 冷却只在任务成功完成后生效（失败不冷却），冷却期间后续任务等待。
 * - 并发=1 时任务严格串行；concurrency>1 时多任务并行。
 * - 内部用 AbortController 管理 signal 并传给每个任务；abortAll() 中止全部
 *   （正在等待的任务立即拒绝，运行中的任务收到已中止的 signal）。
 * - cooldownMs 传 0 时无延迟（测试用）。
 */

interface Waiter {
	task: (signal: AbortSignal) => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

export interface DrawQueueOptions {
	/** 并发上限，默认 1 */
	concurrency?: number;
	/** 冷却：固定 ms 或 [min,max] 随机区间；默认 [15000,30000] */
	cooldownMs?: number | [number, number];
}

/** 队列中止时的拒绝原因 */
function abortError(): Error {
	return new Error("请求队列已中止");
}

export class DrawRequestQueue {
	private readonly concurrency: number;
	private readonly cooldownMs: number | [number, number];
	private readonly controller = new AbortController();
	private readonly waiters: Waiter[] = [];
	private running = 0;
	private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
	private cooldownEnds = 0;

	constructor(opts?: DrawQueueOptions) {
		this.concurrency = Math.max(1, opts?.concurrency ?? 1);
		this.cooldownMs = opts?.cooldownMs ?? [15000, 30000];
	}

	/** 正在排队 + 运行中的任务数 */
	get pending(): number {
		return this.waiters.length + this.running;
	}

	/** 入队执行；排队 + 并发限制 + 任务完成后冷却；signal 中止时拒绝 */
	enqueue<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this.controller.signal.aborted) {
				reject(abortError());
				return;
			}
			this.waiters.push({
				task: task as (signal: AbortSignal) => Promise<unknown>,
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			this.pump();
		});
	}

	/** 中止全部：等待中的立即拒绝，运行中的收到已中止的 signal */
	abortAll(): void {
		this.controller.abort();
		if (this.cooldownTimer !== null) {
			clearTimeout(this.cooldownTimer);
			this.cooldownTimer = null;
			this.cooldownEnds = 0;
		}
		const waiting = this.waiters.splice(0);
		const err = abortError();
		for (const w of waiting) w.reject(err);
	}

	/** 尝试放行任务：非冷却期 + 未中止 + 并发有余量时逐个出队 */
	private pump(): void {
		if (this.controller.signal.aborted) return;
		if (this.cooldownEnds > Date.now()) return; // 冷却中，等定时器到期后再 pump
		while (this.running < this.concurrency && this.waiters.length > 0) {
			const w = this.waiters.shift()!;
			this.runOne(w);
		}
	}

	private async runOne(w: Waiter): Promise<void> {
		this.running++;
		try {
			const result = await w.task(this.controller.signal);
			w.resolve(result);
			this.running--;
			// 成功才冷却
			this.startCooldown();
		} catch (e) {
			this.running--;
			w.reject(e);
			this.pump();
		}
	}

	/** 取本次冷却时长：固定值或随机区间；<=0 视为无冷却 */
	private pickCooldownMs(): number {
		if (Array.isArray(this.cooldownMs)) {
			const [min, max] = this.cooldownMs;
			if (max <= min) return max;
			return min + Math.floor(Math.random() * (max - min + 1));
		}
		return this.cooldownMs;
	}

	/** 启动冷却计时（已有冷却在跑则忽略）；结束后重新 pump */
	private startCooldown(): void {
		if (this.cooldownTimer !== null) return;
		const ms = this.pickCooldownMs();
		if (ms <= 0) {
			this.pump(); // 无延迟直接放行
			return;
		}
		this.cooldownEnds = Date.now() + ms;
		this.cooldownTimer = setTimeout(() => {
			this.cooldownTimer = null;
			this.cooldownEnds = 0;
			this.pump();
		}, ms);
	}
}
