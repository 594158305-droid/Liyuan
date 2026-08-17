/**
 * 原始导入（DESIGN-import-raw §1 核心）：把 ST 聊天记录**逐层回放**到新会话，
 * 每 batchN 层合并跑一次场记记账（世界状态 + 自定义表逐层演进）。
 *
 * 纯函数 + 注入依赖，零 pi 依赖：
 * - 消息注入走宿主注入的 appendMessage（= sm.appendMessage，写会话树，绝不触发引擎）；
 * - 场记链 = buildScribeTurnPrompt + 注入 sideText（透传 signal，可中断正在跑的 LLM）+ parseScribeResult + applyPatch；
 * - 中断：每层之间查 signal.aborted，已注入楼层保留（结果只写当前分支，中断不破坏已回放部分）；
 * - 进度：onProgress(current, total, stage, scribeCalls)——回放阶段 stage="回放"、场记阶段带状态消息；
 *   scribeCalls = 已尝试记账次数（含失败/解析跳过——前端「已合并记账 N 次」按尝试次数显示）。
 */

import { applyPatch, canonicalizeCharacterKeys } from "./state.ts";
import { buildScribeTurnPrompt, parseScribeResult } from "./scribe.ts";
import { debug } from "./debug.ts";
import type { WorldState } from "./types.ts";

/** 一层待回放的楼层（ST 解析 + 清洗后的 user/assistant 消息） */
export interface ReplayFloor {
	role: "user" | "assistant";
	name: string;
	text: string;
}

export interface ReplayDeps {
	/** 楼层序列（时间顺序） */
	floors: ReplayFloor[];
	/** 工作状态（可变；applyPatch 结果回灌进本对象，调用方 save 闭包始终看到最新账本） */
	state: WorldState;
	userName: string;
	charName: string;
	/** 每 N 层合并记账一次（1 = 逐层） */
	batchN: number;
	/** 旁路文本调用（场记）：返回文本；失败返回 {error}（跳过该块继续）；signal 透传可中断 */
	sideText: (systemPrompt: string, userText: string, signal?: AbortSignal) => Promise<string | { error: string }>;
	/** 宿主注入 sm.appendMessage（消息进会话树，不触发引擎） */
	appendMessage: (role: "user" | "assistant", text: string) => void;
	/** 宿主注入 saveState + syncStoryStateFromDisk */
	save: () => void;
	signal?: AbortSignal;
	/** 进度（current=已回放楼层，total=总楼层，stage=阶段/状态消息，scribeCalls=已尝试记账次数） */
	onProgress?: (current: number, total: number, stage: string, scribeCalls: number) => void;
}

/**
 * applyPatch 内部 structuredClone 后返回新对象（roleplay 侧用 `state = r.state` 换引用）；
 * 纯核心不便换调用方引用（save 闭包捕获的是原对象），故把结果**原位回灌**：
 * 清空 target 顶层键后整体拷贝 next——保持对象身份不变，调用方 state 与 save 闭包始终看到最新账本
 * （嵌套对象整体替换，键内删除（characters/flags 传 null 等）一并生效）。
 */
function replaceStateInPlace(target: WorldState, next: WorldState): void {
	const t = target as unknown as Record<string, unknown>;
	for (const key of Object.keys(t)) delete t[key];
	Object.assign(t, next);
}

/**
 * 核心循环（DESIGN-import-raw §1）：空校验 → 逐层 appendMessage + 攒 batch →
 * 每攒够 batchN 层（或到末尾）跑一次场记（sideText 失败 / parse 垃圾跳过继续）→ 每层之间检查中断。
 */
export async function replayFloors(deps: ReplayDeps): Promise<
	| { ok: true; floors: number; scribeCalls: number }
	| { ok: false; error: string; aborted?: boolean }
> {
	const floors = deps.floors;
	if (floors.length === 0) return { ok: false, error: "聊天记录为空" };
	// batchN 防御归一（宿主已 clamp 1..30；这里兜底防 0/负/NaN）
	const batchN = Math.max(1, Math.floor(deps.batchN) || 1);

	let scribeCalls = 0;
	let batchLines: string[] = [];
	let batchCount = 0;

	/** 攒够一档：合并跑场记（当前层索引/总数/已尝试记账次数透传给 onProgress 的 stage 与 scribeCalls） */
	const flushScribe = async (current: number, total: number): Promise<void> => {
		if (batchLines.length === 0) return;
		// 每次尝试记账都计数（含失败/解析跳过的尝试——前端「已合并记账 N 次」按尝试次数显示）
		scribeCalls++;
		const batchDigest = batchLines.join("\n\n");
		batchLines = [];
		batchCount = 0;
		const prompt = buildScribeTurnPrompt({
			state: deps.state,
			userText: "（原始导入历史剧情）",
			assistantText: batchDigest,
			charName: deps.charName,
			userName: deps.userName,
		});
		const resp = await deps.sideText(prompt.systemPrompt, prompt.userText, deps.signal);
		if (typeof resp !== "string") {
			// 旁路失败：跳过该块继续（同导入分层摘要的容错，不中断整轮回放）
			deps.onProgress?.(current, total, `场记失败（跳过）：${resp.error}`, scribeCalls);
			return;
		}
		const result = parseScribeResult(resp);
		if (!result) {
			// 调试增强：场记旁路输出无法解析（非预期内容）——统一接口打 WARNING
			debug.warning("side-text", "导入场记旁路输出无法解析（跳过该块）", {
				len: resp.length,
				head: resp.slice(0, 120),
			});
			deps.onProgress?.(current, total, "场记输出无法解析（跳过）", scribeCalls);
			return;
		}
		// 规范名归一（大小写/空白变体归到账本已知名）→ applyPatch → 结果回灌 + 落盘
		const patch = canonicalizeCharacterKeys(result.patch, [
			deps.charName,
			deps.userName,
			...Object.keys(deps.state.characters),
		]);
		const r = applyPatch(deps.state, patch);
		replaceStateInPlace(deps.state, r.state);
		deps.save();
		deps.onProgress?.(
			current,
			total,
			`账本更新：${r.applied.length ? r.applied.join("；") : "（无变化）"}${r.warnings.length ? `；警告：${r.warnings.join("；")}` : ""}`,
			scribeCalls,
		);
	};

	for (let i = 0; i < floors.length; i++) {
		// 每层之间检查中断：已注入楼层保留
		if (deps.signal?.aborted) return { ok: false, error: "已停止", aborted: true };
		const floor = floors[i]!;
		deps.appendMessage(floor.role, floor.text);
		// 攒 batch：`${role==="user"?userName:name}：${text}`，\n\n 连接
		const speaker = floor.role === "user" ? deps.userName : floor.name;
		batchLines.push(`${speaker}：${floor.text}`);
		batchCount++;
		deps.onProgress?.(i + 1, floors.length, "回放", scribeCalls);
		// 每攒够 batchN 层（或到末尾）跑一次场记
		if (batchCount >= batchN || i === floors.length - 1) {
			await flushScribe(i + 1, floors.length);
		}
	}
	return { ok: true, floors: floors.length, scribeCalls };
}
