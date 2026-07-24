/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { LoginGate } from "./LoginGate.tsx";
import "./app.css";
import { installParentTavernShim } from "./tavernShim.ts";
import { initTheme } from "./theme.ts";

initTheme();
// 三档程序卡：父页 TavernHelper / TheaterAPI / 事件总线（iframe 经 parent 访问）
installParentTavernShim();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<LoginGate>
			<App />
		</LoginGate>
	</StrictMode>,
);

// 注册轻量 SW：预缓存品牌图标与壳，弱网/再开快捷方式不糊、不裂图
if (import.meta.env.PROD && "serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/sw.js").catch(() => {
			/* 无 SW 不挡主流程 */
		});
	});
}
