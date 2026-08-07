/**
 * JS Runner 脚本日志查看器（M4b）。
 *
 * 自足组件：不依赖面板外壳的任何 props，内部直接使用 helper.ts 的日志缓存 API——
 * 初始拉 getLogs() 快照 + subscribeLogs 订阅增量（卸载退订），清空走 clearLogs。
 *
 * 展示：时间（HH:MM:SS）+ 脚本名（scriptId）+ 级别色标（log/warn/error）+ 文本。
 * 顺序：时间正序（最新在底），新日志到达且处于底部跟随态时自动滚到底
 * （简单 useEffect + ref.scrollTop；用户上翻历史时暂停跟随，滚回底部恢复）。
 *
 * 导出：默认导出 LogViewer（同时提供同名命名导出，两种 import 写法均可）。
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { clearLogs, getLogs, subscribeLogs, type JsLogEntry } from "../helper.ts";

/** 时间戳 → HH:MM:SS */
function fmtTime(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 级别标签（与 level 字段一致，前端展示用） */
const LEVEL_LABEL: Record<JsLogEntry["level"], string> = {
	log: "log",
	warn: "warn",
	error: "error",
};

/** 单条日志行 */
function LogLine({ entry }: { entry: JsLogEntry }) {
	return (
		<div className={`jslog-line jslog-${entry.level}`}>
			<span className="jslog-time">{fmtTime(entry.ts)}</span>
			<span className="jslog-script" title={entry.scriptId}>
				{entry.scriptId}
			</span>
			<span className="jslog-level">{LEVEL_LABEL[entry.level]}</span>
			<span className="jslog-text">{entry.text}</span>
		</div>
	);
}

function LogViewer(): JSX.Element {
	// 初始快照：getLogs() 返回新→旧，反转成时间正序展示（最新在底，配合自动滚底）
	const [entries, setEntries] = useState<JsLogEntry[]>(() => getLogs().reverse());
	const boxRef = useRef<HTMLDivElement>(null);
	/** 是否处于「底部跟随」态：上翻历史时置 false，回到底部恢复 true */
	const pinnedRef = useRef(true);

	// 挂载：重拉一次快照 + 订阅增量；卸载退订（subscribeLogs 返回值即退订函数）
	useEffect(() => {
		setEntries(getLogs().reverse());
		return subscribeLogs((entry) => setEntries((prev) => [...prev, entry]));
	}, []);

	// 列表变化：处于跟随态时自动滚到底（新日志到达的常见路径）
	useEffect(() => {
		const el = boxRef.current;
		if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
	}, [entries]);

	// 用户滚动：接近底部视为重新跟随，上翻则暂停跟随
	const onScroll = () => {
		const el = boxRef.current;
		if (!el) return;
		pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
	};

	const clear = () => {
		clearLogs();
		setEntries([]);
	};

	return (
		<div className="jslog">
			<div className="jslog-bar">
				<span className="field-hint">脚本 console 输出 · 最多保留 500 条</span>
				<button type="button" className="act" disabled={entries.length === 0} onClick={clear}>
					清空
				</button>
			</div>
			{entries.length === 0 ? (
				<div className="sp-empty">暂无脚本日志。</div>
			) : (
				<div className="jslog-box" ref={boxRef} onScroll={onScroll}>
					{entries.map((e, i) => (
						<LogLine key={i} entry={e} />
					))}
				</div>
			)}
		</div>
	);
}

export default LogViewer;
export { LogViewer };
