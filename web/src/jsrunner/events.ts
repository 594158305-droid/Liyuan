/**
 * 帧 → 脚本事件的纯投影（D4 §6.1b）。
 *
 * 独立纯模块：只 import type（wire.ts 的 ServerFrame），不 import 任何 DOM / ws / api /
 * `?raw` 依赖——node --input-type=module 可直跑自动化测试（对比 runtime.ts 的 import 链
 * 含 frame.ts → vendor.ts(`?raw`)，node 无法加载）。
 *
 * 投影规则（D4 §5.2，R5-①）：
 * - state：账本更新 → WORLD_STATE_CHANGED([state])
 * - message：仅非 user 通道（narrative/backstage/greeting 等落定）→
 *   MESSAGE_RECEIVED([{ mes, is_user:false }])；user 消息不产生事件
 * - agent：state=end → GENERATION_ENDED([])；start 不产生
 * - ext_event：桥事件直通（与 scriptFrameSink 既有行为一致）
 * - 其余帧 → 空数组
 * 不含 pushContext 逻辑（runtime 的 scriptFrameSink 薄壳负责）。
 */
import type { ServerFrame } from "../wire.ts";

export interface ScriptEvent {
	name: string;
	args: unknown[];
}

export function mapFrameToScriptEvents(frame: ServerFrame): ScriptEvent[] {
	switch (frame.type) {
		case "state":
			return [{ name: "WORLD_STATE_CHANGED", args: [frame.state] }];
		case "message":
			return frame.message.channel !== "user"
				? [{ name: "MESSAGE_RECEIVED", args: [{ mes: frame.message.text, is_user: false }] }]
				: [];
		case "agent":
			return frame.state === "end" ? [{ name: "GENERATION_ENDED", args: [] }] : [];
		case "ext_event":
			return [{ name: frame.name, args: frame.args }];
		default:
			return [];
	}
}
