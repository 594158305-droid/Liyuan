/**
 * 局部重绘的 mask 编辑弹窗：canvas 原尺寸显示源图，白色笔迹涂抹要重绘的区域。
 * 生成时另建黑底画布，把白色笔迹画上去（黑底白笔 = mask），导出 PNG base64 交给后端。
 * 同源 /media/ 图片无需 crossOrigin。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const BRUSH_WIDTH = 30;
const BRUSH_DOT_R = BRUSH_WIDTH / 2;

export function InpaintModal({
	src,
	onCancel,
	onConfirm,
	busy,
}: {
	src: string;
	onCancel: () => void;
	onConfirm: (maskBase64: string) => void;
	busy?: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	/** 离屏黑底 mask（黑底 + 白色笔迹），与显示画布同步绘制 */
	const maskRef = useRef<HTMLCanvasElement | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const drawing = useRef(false);
	const last = useRef<{ x: number; y: number } | null>(null);
	const [ready, setReady] = useState(false);

	// 加载源图 → 铺原尺寸画布
	useEffect(() => {
		const img = new Image();
		img.onload = () => {
			imgRef.current = img;
			const canvas = canvasRef.current;
			if (!canvas) {
				setReady(false);
				return;
			}
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				setReady(false);
				return;
			}
			ctx.fillStyle = "#111";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(img, 0, 0);
			const mask = document.createElement("canvas");
			mask.width = img.naturalWidth;
			mask.height = img.naturalHeight;
			const mctx = mask.getContext("2d");
			if (mctx) {
				mctx.fillStyle = "#000";
				mctx.fillRect(0, 0, mask.width, mask.height);
			}
			maskRef.current = mask;
			setReady(true);
		};
		img.onerror = () => setReady(false);
		img.src = src;
		return () => {
			img.onload = null;
			img.onerror = null;
		};
	}, [src]);

	/** 指针 client 坐标 → 画布像素坐标（画布被 CSS 缩放显示） */
	const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const canvas = canvasRef.current;
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		return {
			x: ((e.clientX - rect.left) * canvas.width) / rect.width,
			y: ((e.clientY - rect.top) * canvas.height) / rect.height,
		};
	};

	const stroke = (p: { x: number; y: number }) => {
		const canvas = canvasRef.current;
		const mask = maskRef.current;
		if (!canvas || !mask) return;
		const ctx = canvas.getContext("2d");
		const mctx = mask.getContext("2d");
		if (!ctx || !mctx) return;
		// 两个画布同步画白色笔迹：显示层盖在图上，mask 层落在黑底
		for (const c of [ctx, mctx]) {
			c.strokeStyle = "#fff";
			c.lineWidth = BRUSH_WIDTH;
			c.lineCap = "round";
			c.lineJoin = "round";
			c.globalCompositeOperation = "source-over";
		}
		if (last.current) {
			for (const c of [ctx, mctx]) {
				c.beginPath();
				c.moveTo(last.current.x, last.current.y);
				c.lineTo(p.x, p.y);
				c.stroke();
			}
		} else {
			// 单击落点：画一个圆点
			for (const c of [ctx, mctx]) {
				c.beginPath();
				c.arc(p.x, p.y, BRUSH_DOT_R, 0, Math.PI * 2);
				c.fillStyle = "#fff";
				c.fill();
			}
		}
		last.current = p;
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (busy) return;
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		drawing.current = true;
		last.current = null;
		const p = toCanvas(e);
		if (p) stroke(p);
	};
	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (!drawing.current) return;
		const p = toCanvas(e);
		if (p) stroke(p);
	};
	const endStroke = () => {
		drawing.current = false;
		last.current = null;
	};

	const clear = () => {
		const canvas = canvasRef.current;
		const mask = maskRef.current;
		const img = imgRef.current;
		if (!canvas || !mask || !img) return;
		const ctx = canvas.getContext("2d");
		const mctx = mask.getContext("2d");
		if (!ctx || !mctx) return;
		ctx.fillStyle = "#111";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0);
		mctx.fillStyle = "#000";
		mctx.fillRect(0, 0, mask.width, mask.height);
	};

	const confirm = () => {
		const mask = maskRef.current;
		if (!mask) return;
		const b64 = mask.toDataURL("image/png").split(",")[1] ?? "";
		onConfirm(b64);
	};

	// 2026-08-14 修复：主聊天消息容器（.list）backdrop-filter 会成为 fixed 弹窗的包含块，
	// 弹窗被裁剪在消息列表内（表现：点了没反应）。Portal 到 body 脱离容器。
	return createPortal(
		<div className="inpaint-modal" role="dialog" aria-modal="true" aria-labelledby="inpaint-title">
			<div className="inpaint-dialog">
				<h3 id="inpaint-title">局部重绘</h3>
				<p className="inpaint-hint">涂抹要重绘的区域</p>
				<div className="inpaint-stage">
					{!ready && <div className="sp-empty">加载图片…</div>}
					<canvas
						ref={canvasRef}
						className="inpaint-canvas"
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={endStroke}
						onPointerCancel={endStroke}
					/>
				</div>
				<div className="panel-row inpaint-actions">
					<button type="button" className="drawer-btn" disabled={!ready || busy} onClick={clear}>
						清除
					</button>
					<button type="button" className="drawer-btn" disabled={busy} onClick={onCancel}>
						取消
					</button>
					<button type="button" className="drawer-btn save-btn" disabled={!ready || busy} onClick={confirm}>
						{busy ? "生成中…" : "确定"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
