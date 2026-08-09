/**
 * 独立管理界面模态（D4 §2.8，P4）：脚本经 TavernHelper.openManager 请求，
 * helper → ledger.requestManager → 本组件 onManagerRequest 订阅接收。
 *
 * - A4：App.tsx 顶层挂 <ModalPanel /> 单例；请求通道统一走 ledger，不另设 bus；
 * - 同时只允许一个模态：打开新脚本前先把旧脚本 setModalized(false)；
 * - openScript 变化时同步 ledger.setModalized（LedgerScriptViews 的挂载副作用
 *   感知 modalized → 账本侧不挂载，同一 iframe 只能挂一处）；
 * - 模态 body 用 scriptRuntimes.mount/unmount 挂载脚本 iframe（同一 contentWindow，
 *   关闭后移回隐藏容器，脚本状态不丢）；
 * - Esc / 遮罩点击 / ✕ 关闭；role=dialog + aria-modal；关闭后焦点回 document.body。
 */
import { useEffect, useRef, useState } from "react";
import { ledger } from "../ledger.ts";
import { scriptRuntimes } from "../runtime.ts";

export function ModalPanel() {
	const [openScript, setOpenScript] = useState<string | null>(null);
	/** 当前打开模态的脚本（ref 同步，供请求回调读最新值，避免闭包过期） */
	const openScriptRef = useRef<string | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);

	// A4：统一走 ledger 的 manager 请求通道；同时只允许一个模态
	useEffect(() => {
		const off = ledger.onManagerRequest((scriptId) => {
			// 先标记旧模态脚本解除占用，再打开新的
			if (openScriptRef.current) ledger.setModalized(openScriptRef.current, false);
			openScriptRef.current = scriptId;
			setOpenScript(scriptId);
		});
		return off;
	}, []);

	// openScript 变化：旧脚本解除占用，新脚本标记占用（账本侧据此不挂载同一 iframe）
	useEffect(() => {
		const prev = openScriptRef.current;
		if (prev && prev !== openScript) ledger.setModalized(prev, false);
		openScriptRef.current = openScript;
		if (openScript) ledger.setModalized(openScript, true);
	}, [openScript]);

	// 挂载/卸载 iframe：模态出现挂载，关闭 unmount 移回原容器（不重载）
	useEffect(() => {
		const el = bodyRef.current;
		if (!el || !openScript) return;
		scriptRuntimes.mount(openScript, el);
		return () => {
			scriptRuntimes.unmount(openScript);
		};
	}, [openScript]);

	// Esc 关闭 + 焦点管理：打开后焦点入模态（关闭按钮），关闭后回 document.body
	// （脚本触发的模态无宿主侧触发元素，ui-design：不丢失焦点即可）
	useEffect(() => {
		if (!openScript) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpenScript(null);
		};
		window.addEventListener("keydown", onKey);
		document.getElementById("modal-panel-close")?.focus();
		return () => {
			window.removeEventListener("keydown", onKey);
			document.body.focus();
		};
	}, [openScript]);

	if (!openScript) return null;
	return (
		<div className="modal-panel-overlay" onClick={() => setOpenScript(null)}>
			<div
				className="modal-panel"
				role="dialog"
				aria-modal="true"
				aria-label={`脚本管理界面：${openScript}`}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="modal-panel-head">
					<span>{openScript}</span>
					<button type="button" id="modal-panel-close" className="icon-btn" aria-label="关闭" onClick={() => setOpenScript(null)}>
						✕
					</button>
				</div>
				<div className="modal-panel-body" ref={bodyRef} />
			</div>
		</div>
	);
}
