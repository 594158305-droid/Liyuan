/**
 * WS 客户端：同源 /ws，断线自动重连（1.5s 起指数退避，封顶 10s）。
 * 只负责连接与帧收发，状态归 App。
 */

import { useEffect, useRef } from "react";
import type { ClientFrame, ServerFrame } from "./wire.ts";

export type ConnState = "connecting" | "open" | "closed";

export interface WsHandle {
	send: (frame: ClientFrame) => void;
}

/** 模块级当前连接（非 React 侧用）：useWire 建连/断连时维护，sendFrame 据此发帧 */
let activeWs: WebSocket | null = null;

/**
 * 模块级帧订阅（非 React 侧监听 ServerFrame，如 SessionsPanel 的原始导入进度帧）。
 * useWire 收到每帧都会广播给订阅者（与 onFrame 回调并存，各司其职）。
 */
export type FrameListener = (frame: ServerFrame) => void;
const frameListeners = new Set<FrameListener>();
export function subscribeFrames(l: FrameListener): () => void {
	frameListeners.add(l);
	return () => {
		frameListeners.delete(l);
	};
}

/**
 * 非 React 侧发送帧（jsrunner/helper.ts 等模块级代码用）。
 * 未连接（activeWs 空 / 非 OPEN）时静默丢弃——与 WsHandle.send 同一纪律。
 */
export function sendFrame(frame: ClientFrame): void {
	const ws = activeWs;
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

export function useWire(onFrame: (frame: ServerFrame) => void, onState: (s: ConnState) => void): WsHandle {
	const wsRef = useRef<WebSocket | null>(null);
	const onFrameRef = useRef(onFrame);
	const onStateRef = useRef(onState);
	onFrameRef.current = onFrame;
	onStateRef.current = onState;

	useEffect(() => {
		let closed = false;
		let retryMs = 1500;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const connect = () => {
			if (closed) return;
			onStateRef.current("connecting");
			const proto = location.protocol === "https:" ? "wss:" : "ws:";
			const ws = new WebSocket(`${proto}//${location.host}/ws`);
			wsRef.current = ws;
			activeWs = ws;

			ws.onopen = () => {
				retryMs = 1500;
				onStateRef.current("open");
			};
			ws.onmessage = (ev) => {
				try {
					const frame = JSON.parse(String(ev.data)) as ServerFrame;
					onFrameRef.current(frame);
					// 模块级订阅者（各组件自己的监听，互不干扰）
					for (const l of [...frameListeners]) {
						try {
							l(frame);
						} catch {
							// 单个订阅者出错不影响主回调
						}
					}
				} catch {
					// 非 JSON 帧忽略
				}
			};
			ws.onclose = (ev) => {
				// 连接替换/关闭后，sendFrame 不应再往旧连接发
				if (activeWs === ws) activeWs = null;
				if (closed) return;
				// 4401 = 服务端鉴权失败（密码在别处被改）：刷新回登录门，别在这无谓重连
				if (ev.code === 4401) {
					location.reload();
					return;
				}
				onStateRef.current("closed");
				timer = setTimeout(connect, retryMs);
				retryMs = Math.min(retryMs * 2, 10_000);
			};
			ws.onerror = () => ws.close();
		};

		connect();
		return () => {
			closed = true;
			if (timer) clearTimeout(timer);
			if (activeWs === wsRef.current) activeWs = null;
			wsRef.current?.close();
		};
	}, []);

	return {
		send: (frame) => {
			const ws = wsRef.current;
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
		},
	};
}
