/**
 * 对话流 HTML 沙箱帧（底层展示通道）。
 *
 * - 默认：sandbox 禁止脚本（静态 HTML/CSS）
 * - scripts=true：allow-scripts，仍无 allow-same-origin → 无法读写父页面
 * - seamless=true：无痕模式（卡皮肤/整楼界面）——幽灵操作、真实高度、样式主权
 * - 与侧栏 ArtifactPanel 锁死策略不同：此处按消息/工具显式开关脚本，服务「中途渲染 UI」
 */

import { useEffect, useId, useRef, useState } from "react";
import { buildSrcDoc } from "../frameDoc.ts";

export function HtmlFrame({
	html,
	title,
	scripts = false,
	seamless = false,
	minHeight = 120,
	maxHeight = 560,
}: {
	html: string;
	title?: string;
	scripts?: boolean;
	/** 无痕模式：卡皮肤/整楼界面；agent show_html 保持 false */
	seamless?: boolean;
	minHeight?: number;
	maxHeight?: number;
}) {
	const frameId = useId();
	const ref = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(minHeight);
	const [showSource, setShowSource] = useState(false);
	const srcDoc = buildSrcDoc(html, scripts, seamless);
	// 沙箱矩阵(Global Constraints):脚本帧永无 same-origin;seamless 静态帧给 same-origin 以便量高
	const sandbox = scripts ? "allow-scripts" : seamless ? "allow-same-origin" : "";
	const cap = seamless ? Number.POSITIVE_INFINITY : maxHeight;

	// 静态帧量高(seamless 下 same-origin 可读;旧模式维持原 try/catch 行为)
	useEffect(() => {
		if (scripts) {
			if (!seamless) setHeight(maxHeight);
			return;
		}
		const el = ref.current;
		if (!el) return;
		const fit = () => {
			try {
				const doc = el.contentDocument;
				const h = doc?.documentElement?.scrollHeight || doc?.body?.scrollHeight || minHeight;
				setHeight(Math.min(cap, Math.max(minHeight, h + 4)));
			} catch {
				/* opaque origin(非 seamless 静态帧) */
			}
		};
		el.addEventListener("load", fit);
		const t = window.setTimeout(fit, 50);
		return () => {
			el.removeEventListener("load", fit);
			window.clearTimeout(t);
		};
	}, [srcDoc, scripts, seamless, minHeight, cap, maxHeight]);

	// 脚本帧高度上报(seamless):按 frameId 对号,来源不可信也只消费数字
	useEffect(() => {
		if (!scripts || !seamless) return;
		const onMsg = (e: MessageEvent) => {
			const d = e.data as { liyuanFrameHeight?: unknown; frameId?: unknown };
			if (d && d.frameId === frameId && typeof d.liyuanFrameHeight === "number" && d.liyuanFrameHeight > 0) {
				setHeight(Math.max(minHeight, Math.min(20000, d.liyuanFrameHeight + 4)));
			}
		};
		window.addEventListener("message", onMsg);
		return () => window.removeEventListener("message", onMsg);
	}, [scripts, seamless, frameId, minHeight]);

	return (
		<figure className={`msg-html ${scripts ? "msg-html-scripts" : ""} ${seamless ? "msg-html-seamless" : ""}`}>
			{!seamless && (
				<div className="msg-html-bar">
					<span className="msg-html-title">{title?.trim() || (scripts ? "交互界面" : "HTML")}</span>
					<span className="msg-html-tags">
						{scripts ? <span className="chip chip-html-js">脚本</span> : <span className="chip chip-html-static">静态</span>}
						<button type="button" className="act" onClick={() => setShowSource((v) => !v)}>
							{showSource ? "收起源码" : "源码"}
						</button>
					</span>
				</div>
			)}
			{seamless && (
				<div className="msg-html-ghost">
					<button type="button" className="act" onClick={() => setShowSource((v) => !v)}>
						{showSource ? "收起源码" : "源码"}
					</button>
				</div>
			)}
			<iframe
				ref={ref}
				name={frameId}
				className="msg-html-frame"
				title={title || (seamless ? "界面" : "HTML")}
				sandbox={sandbox}
				srcDoc={srcDoc}
				style={{ height }}
			/>
			{showSource && <pre className="msg-html-source">{html}</pre>}
			{!seamless && title?.trim() && !showSource && <figcaption className="msg-html-cap">{title}</figcaption>}
		</figure>
	);
}
