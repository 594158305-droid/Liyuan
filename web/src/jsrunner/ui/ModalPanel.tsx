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
 *
 * C 路径延伸（全屏模态 + 程序化关闭）：
 * - openManager("fullscreen" / { fullscreen:true }) → requestManager(scriptId,{fullscreen:true})
 *   → 本组件按全屏变体渲染（modal-panel--fullscreen，占满视口留 8px 边距）；
 * - TavernHelper.closeManager() → ledger.requestManagerClose(scriptId) → 本组件
 *   onManagerClose 订阅 → 与 ✕/遮罩/Esc 相同的关闭路径（setModalized(false) 清理）。
 */
import { useEffect, useRef, useState } from "react";
import { ledger } from "../ledger.ts";
import { scriptRuntimes } from "../runtime.ts";

export function ModalPanel() {
	const [openScript, setOpenScript] = useState<string | null>(null);
	/** 当前模态是否全屏变体（C 路径延伸；随打开请求设置，关闭时复位） */
	const [openFullscreen, setOpenFullscreen] = useState(false);
	/** 当前打开模态的脚本（ref 同步，供请求回调读最新值，避免闭包过期） */
	const openScriptRef = useRef<string | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);

	/** 关闭当前模态（✕ / 遮罩 / Esc / 脚本 closeManager 共用同一路径） */
	const closeModal = () => {
		setOpenScript(null);
		setOpenFullscreen(false);
	};

	// A4：统一走 ledger 的 manager 请求通道；同时只允许一个模态。
	// C 路径延伸：回调带 opts（opts?.fullscreen 决定全屏变体）。
	useEffect(() => {
		const off = ledger.onManagerRequest((scriptId, opts) => {
			// 先标记旧模态脚本解除占用，再打开新的
			if (openScriptRef.current) ledger.setModalized(openScriptRef.current, false);
			openScriptRef.current = scriptId;
			setOpenScript(scriptId);
			setOpenFullscreen(opts?.fullscreen === true);
		});
		return off;
	}, []);

	// C 路径延伸：脚本侧程序化关闭（helper.closeManager → requestManagerClose → 本订阅）；
	// 只响应当前打开脚本的关闭请求，其它脚本的请求忽略。
	useEffect(() => {
		const off = ledger.onManagerClose((scriptId) => {
			if (openScriptRef.current === scriptId) closeModal();
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
	// 打开竞态（冒烟实测）：modalized=true 会触发 LedgerScriptViews 的 cleanup 把 iframe
	// 移回隐藏容器；若本 effect 与其同批次先挂载，会被随后执行的账本侧 unmount 抢走
	// （iframe 留在 #jsrunner-host，模态 body 空）。延迟到下一帧挂载，保证顺序稳定。
	useEffect(() => {
		if (!openScript) return;
		let raf = 0;
		raf = requestAnimationFrame(() => {
			const el = bodyRef.current;
			if (el) scriptRuntimes.mount(openScript, el);
		});
		return () => {
			cancelAnimationFrame(raf);
			scriptRuntimes.unmount(openScript);
		};
	}, [openScript]);

	// Esc 关闭 + 焦点管理：打开后焦点入模态（关闭按钮），关闭后回 document.body
	// （脚本触发的模态无宿主侧触发元素，ui-design：不丢失焦点即可）
	useEffect(() => {
		if (!openScript) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeModal();
		};
		window.addEventListener("keydown", onKey);
		document.getElementById("modal-panel-close")?.focus();
		return () => {
			window.removeEventListener("keydown", onKey);
			document.body.focus();
		};
	}, [openScript]);

	if (!openScript) return null;
	const fullscreen = openFullscreen;
	return (
		<div
			className={`modal-panel-overlay${fullscreen ? " modal-panel-overlay--fullscreen" : ""}`}
			onClick={closeModal}
		>
			<div
				className={`modal-panel${fullscreen ? " modal-panel--fullscreen" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-label={`脚本管理界面：${openScript}`}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="modal-panel-head">
					<span>{openScript}</span>
					<button type="button" id="modal-panel-close" className="icon-btn" aria-label="关闭" onClick={closeModal}>
						✕
					</button>
				</div>
				<div className="modal-panel-body" ref={bodyRef} />
			</div>
		</div>
	);
}
