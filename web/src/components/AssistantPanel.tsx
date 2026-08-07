/**
 * 助手面板（右栏）：与剧情会话并行的独立助手对话（2026-07-14 职责拆分）。
 *
 * 数据面全部走 WS（assistant_* 帧，App 持状态、本组件纯渲染 + 回调）；
 * 只有模型清单走 REST（/api/models，选择器数据）。
 * 过程呈现学 codex（2026-07-14 用户定调）：进行中的一轮每一步实时追加、全程平铺可见；
 * 最终回复落定后，之前的所有步骤一次性收进**一个**「过程」折叠，回复本体平铺不折。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, type ModelsResponse } from "../api.ts";
import type { AssistantModelInfo, AssistantMsg, AssistantSessionInfo, WireActivity } from "../wire.ts";
import { LiveSteps, RichContent, ThinkingBlock, ZoomImg } from "./Messages.tsx";
import { IconPlus, IconSend, IconStop, IconTrash } from "./icons.tsx";

/** 助手交付的媒体（show_media）：图片走 lightbox，音视频走原生播放器 */
function AsstMedia({ media }: { media: NonNullable<AssistantMsg["media"]> }) {
	if (media.kind === "image") {
		return (
			<div className="asst-media">
				<ZoomImg src={media.src} alt={media.caption ?? ""} title={media.caption} />
			</div>
		);
	}
	if (media.kind === "audio") {
		return (
			<div className="asst-media">
				<audio src={media.src} controls />
			</div>
		);
	}
	return (
		<div className="asst-media">
			{/* eslint-disable-next-line jsx-a11y/media-has-caption -- 用户素材，无字幕轨 */}
			<video src={media.src} controls />
		</div>
	);
}

function timeAgo(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 90_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
	if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`;
	return new Date(ms).toLocaleDateString();
}

function sessionTitle(s: { name?: string; firstMessage: string; preview?: string }): string {
	return s.name || s.preview || s.firstMessage.slice(0, 40) || "（空对话）";
}

export interface AssistantPanelProps {
	/** null=尚未同步（连接前） */
	msgs: AssistantMsg[] | null;
	busy: boolean;
	streamText: string;
	streamThinking: string;
	thinkingLive: boolean;
	/** 进行中的工具（tool_start 名称），无则 null */
	toolNote: string | null;
	/** 本轮已发生、尚未附着到消息的过程步骤（实时清单） */
	liveActs: WireActivity[];
	model: AssistantModelInfo | null;
	/** true=跟随剧情模型 */
	follow: boolean;
	/** 当前角色卡下的助手历史（null=未拉） */
	sessions: AssistantSessionInfo[] | null;
	onSend(text: string): void;
	onAbort(): void;
	onNew(): void;
	onRefreshSessions(): void;
	onOpenSession(path: string): void;
	onDeleteSession(path: string): void;
	/** null=回到跟随剧情模型 */
	onPickModel(sel: { provider: string; id: string } | null): void;
	/**
	 * 自定义 agent 维度（可选，2026-08-07）：当前选中的 agent id（缺省=assistant）。
	 * 仅有多 agent（agents.length>1）时显示选择器；未提供/空列表保持旧行为。
	 */
	agentId?: string;
	/** 可选：agent 选择器数据（始终含内置助手；空/未提供=不显示选择器） */
	agents?: Array<{ id: string; name: string; description?: string }>;
	/** 可选：点击切换 agent（App 侧重发 assistant_sync 带 agentId） */
	onSwitchAgent?(id: string): void;
	/** 打开自定义 agent 管理面板 */
	onOpenManager?: () => void;
}

/** 同一轮的连续助手消息：前 n-1 条是中间步骤，最后一条是回复 */
type Block =
	| { kind: "user"; msg: AssistantMsg }
	| { kind: "reply"; steps: AssistantMsg[]; final: AssistantMsg };

function toBlocks(msgs: AssistantMsg[]): Block[] {
	const out: Block[] = [];
	let run: AssistantMsg[] = [];
	const flush = () => {
		if (run.length === 0) return;
		out.push({ kind: "reply", steps: run.slice(0, -1), final: run[run.length - 1] });
		run = [];
	};
	for (const m of msgs) {
		if (m.role === "user") {
			flush();
			out.push({ kind: "user", msg: m });
		} else {
			run.push(m);
		}
	}
	flush();
	return out;
}

/**
 * 消息的时序展开：附着在某条消息上的 activities 发生在该消息正文**之前**
 * （它们是上一条消息工具调用的执行记录），故渲染顺序=步骤清单在上、正文在下。
 */
function StepView({ m }: { m: AssistantMsg }) {
	return (
		<div className="bs-step">
			{m.activities && m.activities.length > 0 && <LiveSteps activities={m.activities} />}
			{m.thinking && <ThinkingBlock text={m.thinking} />}
			{m.text && <RichContent text={m.text} />}
			{m.media && <AsstMedia media={m.media} />}
		</div>
	);
}

/** 已完结的一轮：全部过程收进一个折叠，最终回复平铺在外（codex 式过程-成品分离） */
function ReplyBlock({ steps, final }: { steps: AssistantMsg[]; final: AssistantMsg }) {
	const toolCalls = [...steps, final].reduce(
		(n, m) => n + (m.activities?.filter((a) => a.kind === "tool_start").length ?? 0),
		0,
	);
	const hasProcess = steps.length > 0 || (final.activities?.length ?? 0) > 0;
	return (
		<div className="asst-reply">
			{hasProcess && (
				<details className="turn-activity">
					<summary>
						过程
						{steps.length > 0 && ` · 中间步骤 ×${steps.length}`}
						{toolCalls > 0 && ` · 工具调用 ×${toolCalls}`}
					</summary>
					{steps.map((m, i) => (
						<StepView key={i} m={m} />
					))}
					{final.activities && final.activities.length > 0 && <LiveSteps activities={final.activities} />}
				</details>
			)}
			{final.thinking && <ThinkingBlock text={final.thinking} />}
			{final.text && <RichContent text={final.text} />}
			{final.media && <AsstMedia media={final.media} />}
		</div>
	);
}

export function AssistantPanel({
	msgs,
	busy,
	streamText,
	streamThinking,
	thinkingLive,
	toolNote,
	liveActs,
	model,
	follow,
	sessions,
	onSend,
	onAbort,
	onNew,
	onRefreshSessions,
	onOpenSession,
	onDeleteSession,
	onPickModel,
	agentId,
	agents,
	onSwitchAgent,
	onOpenManager,
}: AssistantPanelProps) {
	const [input, setInput] = useState("");
	const [models, setModels] = useState<ModelsResponse | null>(null);
	const [histOpen, setHistOpen] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);

	// 模型清单：打开面板拉一次（选择器数据；失败静默，选择器只剩「跟随」）
	useEffect(() => {
		let alive = true;
		apiGet<ModelsResponse>("/api/models")
			.then((r) => {
				if (alive) setModels(r);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	// 打开面板时拉一次助手历史（按当前卡）
	useEffect(() => {
		onRefreshSessions();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载拉一次；之后由历史按钮/刷新触发
	}, []);

	// 贴底跟随：用户没有主动上翻时，新内容到达自动滚到底
	useEffect(() => {
		const el = listRef.current;
		if (el && stickRef.current) el.scrollTop = el.scrollHeight;
	}, [msgs, streamText, streamThinking, liveActs, busy]);

	const blocks = useMemo(() => toBlocks(msgs ?? []), [msgs]);
	// busy 时末尾的回复串属于「进行中的一轮」：整轮平铺直播，收笔后才折叠
	const liveRun = busy && blocks.length > 0 && blocks[blocks.length - 1].kind === "reply"
		? (blocks[blocks.length - 1] as Extract<Block, { kind: "reply" }>)
		: null;
	const doneBlocks = liveRun ? blocks.slice(0, -1) : blocks;

	const send = () => {
		const t = input.trim();
		if (!t || busy) return;
		setInput("");
		stickRef.current = true;
		onSend(t);
	};

	const groups = useMemo(() => {
		const map = new Map<string, Array<{ value: string; label: string }>>();
		for (const m of models?.models ?? []) {
			const arr = map.get(m.providerName) ?? [];
			arr.push({ value: `${m.provider} ${m.id}`, label: m.name || m.id });
			map.set(m.providerName, arr);
		}
		return [...map.entries()];
	}, [models]);

	const histCount = sessions?.length ?? 0;

	return (
		<div className="asst-panel">
			<div className="asst-toolbar">
				{agents && agents.length > 1 && (
					<div className="asst-agents" role="group" aria-label="切换 agent">
						{agents.map((a) => (
							<button
								key={a.id}
								type="button"
								className={`chip chip-btn${a.id === (agentId ?? "assistant") ? " chip-active" : ""}`}
								title={a.description ?? a.name}
								disabled={busy}
								onClick={() => onSwitchAgent?.(a.id)}
							>
								{a.name}
							</button>
						))}
					</div>
				)}
				<button
					type="button"
					className="act"
					onClick={onOpenManager}
					title="管理自定义 agent"
					aria-label="管理自定义 agent"
				>
					管理
				</button>
				<label className="asst-model">
					<select
						value={follow ? "" : model ? `${model.provider} ${model.id}` : ""}
						onChange={(e) => {
							const v = e.target.value;
							if (!v) {
								onPickModel(null);
								return;
							}
							const [provider, id] = v.split(" ");
							if (provider && id) onPickModel({ provider, id });
						}}
						title="助手使用的模型（独立于剧情模型）"
						aria-label="助手模型"
					>
						<option value="">跟随对话模型{follow && model ? `（${model.name}）` : ""}</option>
						{groups.map(([providerName, items]) => (
							<optgroup key={providerName} label={providerName}>
								{items.map((it) => (
									<option key={it.value} value={it.value}>
										{it.label}
									</option>
								))}
							</optgroup>
						))}
					</select>
				</label>
				<button
					type="button"
					className={`icon-btn ${histOpen ? "active" : ""}`}
					onClick={() => {
						setHistOpen((o) => !o);
						onRefreshSessions();
					}}
					title="本角色卡的助手历史"
					aria-label="助手历史"
					aria-expanded={histOpen}
				>
					历史{histCount > 0 ? ` ${histCount}` : ""}
				</button>
				<button
					type="button"
					className="icon-btn"
					onClick={onNew}
					disabled={busy}
					title="新对话（当前助手对话归档，绑定当前角色卡）"
					aria-label="助手新对话"
				>
					<IconPlus size={16} />
				</button>
			</div>
			{histOpen && (
				<div className="asst-history">
					<div className="asst-history-head">
						<span>本卡助手历史</span>
						<button type="button" className="welcome-link" onClick={onRefreshSessions}>
							刷新
						</button>
					</div>
					{sessions === null && <div className="sp-empty">读取历史…</div>}
					{sessions !== null && sessions.length === 0 && (
						<div className="sp-empty">当前角色卡还没有助手对话</div>
					)}
					{sessions !== null &&
						sessions.map((s) => (
							<div key={s.path || s.id} className={`asst-hist-row ${s.current ? "current" : ""}`}>
								<button
									type="button"
									className="asst-hist-item"
									disabled={busy || s.current}
									title={s.current ? "当前对话" : "打开此历史"}
									onClick={() => {
										if (!s.current && s.path) onOpenSession(s.path);
										setHistOpen(false);
									}}
								>
									<span className="asst-hist-title">
										{sessionTitle(s)}
										{s.current ? <span className="session-current-badge">当前</span> : null}
									</span>
									<span className="asst-hist-meta">
										{timeAgo(s.modified)} · {s.messageCount} 条
									</span>
								</button>
								{!s.current && s.path && (
									<button
										type="button"
										className="act"
										title="删除此历史"
										aria-label="删除助手历史"
										disabled={busy}
										onClick={() => {
											if (window.confirm("删除这条助手历史？不可恢复。")) onDeleteSession(s.path);
										}}
									>
										<IconTrash size={13} />
									</button>
								)}
							</div>
						))}
				</div>
			)}
			<div className="asst-hint">
				助手历史按当前角色卡过滤；换卡后只看该卡下的运维记录。
			</div>

			<div
				className="asst-list"
				ref={listRef}
				onScroll={() => {
					const el = listRef.current;
					if (!el) return;
					stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				{msgs === null && <div className="sp-empty">连接后台中…</div>}
				{msgs !== null && blocks.length === 0 && !busy && (
					<div className="sp-empty">
						这里是系统助手：诊断、调配置、维护记忆、接外部服务，都可以直接吩咐。
						主输入框里的系统事务也会由剧情侧委托过来；历史按当前角色卡归档。
					</div>
				)}
				{doneBlocks.map((b, i) =>
					b.kind === "user" ? (
						<div key={i} className="asst-user">
							<RichContent text={b.msg.text} />
						</div>
					) : (
						<ReplyBlock key={i} steps={b.steps} final={b.final} />
					),
				)}
				{busy && (
					<div className="asst-reply asst-live">
						{/* 进行中的一轮：已完成步骤 + 未附着活动 + 当前流式，全部平铺（收笔后统一折叠） */}
						{liveRun && [...liveRun.steps, liveRun.final].map((m, i) => <StepView key={i} m={m} />)}
						{liveActs.length > 0 && <LiveSteps activities={liveActs} />}
						{(streamThinking || thinkingLive) && <ThinkingBlock text={streamThinking} live={thinkingLive} />}
						{streamText ? <RichContent text={streamText} /> : null}
						<div className="asst-working">{toolNote ?? "思考中…"}</div>
					</div>
				)}
			</div>

			<div className="asst-composer">
				<textarea
					value={input}
					rows={1}
					placeholder="吩咐助手…（Enter 发送，Shift+Enter 换行）"
					onChange={(e) => {
						setInput(e.target.value);
						e.target.style.height = "auto";
						e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							send();
						}
					}}
				/>
				{busy ? (
					<button className="btn btn-stop asst-send" onClick={onAbort} title="停止" aria-label="停止助手生成">
						<IconStop size={16} />
					</button>
				) : (
					<button
						className="btn btn-send asst-send"
						onClick={send}
						disabled={!input.trim()}
						title="发送给助手"
						aria-label="发送给助手"
					>
						<IconSend size={15} />
					</button>
				)}
			</div>
		</div>
	);
}