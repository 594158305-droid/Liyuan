/**
 * 脚本视图区（D4 §2.7，P2 渲染面）：把 jsrunner 脚本注册的面板渲染进宿主区域。
 *
 * - area="status"：StatusStrip 展开卡 status-card 内、field-hint 之前；
 * - area="roster"：RosterPanel 名录表格下方。
 *
 * 外部 store 订阅用 useSyncExternalStore（A2）：ledger.getPanels() 返回稳定快照引用
 * （写时重建缓存，不变不重建），无变更不触发重渲染；零注册时渲染 null（零侵入）。
 *
 * 单面板用 React.memo + 全 primitive props 拆分（A3）：某面板 resize 上报只重渲染
 * 自身，不波及其它面板。
 *
 * 挂载副作用（R1-②）：collapsed / modalized / ready 任一为 false 不挂载（收起隐藏、
 * 模态占用、未就绪/崩溃占位）；cleanup 调 scriptRuntimes.unmount 把 iframe 移回
 * #jsrunner-host 隐藏容器——iframe 常驻运行，收起/展开不重载，脚本状态保留。
 */
import { memo, useEffect, useRef, useSyncExternalStore } from "react";
import { ledger } from "../ledger.ts";
import { scriptRuntimes } from "../runtime.ts";

/** LedgerView props：全 primitive（A3：防对象引用导致反复卸载/重挂与全量重渲染） */
interface LedgerViewProps {
	scriptId: string;
	title: string;
	icon?: string;
	collapsed: boolean;
	ready: boolean;
	modalized: boolean;
	height: number;
	maxHeight?: number;
}

/** 面板头宿主按钮（P4）：读 ScriptMeta.buttons（visible 过滤）渲染，点击 emitToScript LEDGER_BUTTON_CLICKED */
function LedgerViewButtons({ scriptId }: { scriptId: string }) {
	const buttons = (scriptRuntimes.getMeta(scriptId)?.buttons ?? []).filter((b) => b.visible);
	if (buttons.length === 0) return null;
	return (
		<span className="ledger-view-buttons">
			{buttons.map((b) => (
				<button
					key={b.name}
					type="button"
					onClick={(e) => {
						// 不冒泡到面板头：头整行可点，否则点按钮会误触收起/展开
						e.stopPropagation();
						scriptRuntimes.emitToScript(scriptId, "LEDGER_BUTTON_CLICKED", [b.name]);
					}}
				>
					{b.name}
				</button>
			))}
		</span>
	);
}

/** 单面板：头（icon + 标题 + scriptId 小字 + 收起箭头 + 宿主按钮）+ body（iframe 挂载槽 / 崩溃占位） */
const LedgerView = memo(function LedgerView({
	scriptId,
	title,
	icon,
	collapsed,
	ready,
	modalized,
	height,
	maxHeight,
}: LedgerViewProps) {
	const bodyRef = useRef<HTMLDivElement>(null);

	// 挂载/卸载副作用：面板出现挂载；收起/模态占用/未就绪不挂载。
	// A3：依赖全为 primitive，避免对象引用导致的反复卸载/重挂
	useEffect(() => {
		const el = bodyRef.current;
		if (!el || collapsed || modalized || !ready) return;
		scriptRuntimes.mount(scriptId, el);
		return () => {
			scriptRuntimes.unmount(scriptId);
		};
	}, [scriptId, collapsed, modalized, ready]);

	const h = Math.min(height, maxHeight ?? 480);

	return (
		<div className="ledger-view">
			<div
				className="ledger-view-head"
				role="button"
				tabIndex={0}
				aria-expanded={!collapsed}
				onClick={() => ledger.toggleCollapsed(scriptId)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						ledger.toggleCollapsed(scriptId);
					}
				}}
			>
				{icon ? <span className="ledger-view-icon">{icon}</span> : null}
				<span className="ledger-view-title">{title}</span>
				<span className="ledger-view-script">{scriptId}</span>
				<span className="ledger-view-caret">{collapsed ? "▸" : "▾"}</span>
				{/* P4：ScriptMeta.buttons 宿主按钮渲染（点击 emitToScript LEDGER_BUTTON_CLICKED） */}
				<LedgerViewButtons scriptId={scriptId} />
			</div>
			{!collapsed && (
				<div className="ledger-view-body" ref={bodyRef} style={ready ? { height: `${h}px` } : undefined}>
					{!ready && <div className="ledger-view-empty">脚本未就绪/已停止（查看脚本日志）</div>}
				</div>
			)}
		</div>
	);
});

/** 脚本视图区：按 area 过滤 ledger 快照；无该区域注册时渲染 null（零侵入） */
export function LedgerScriptViews({ area }: { area: "status" | "roster" }) {
	// A2：外部 store 用 useSyncExternalStore，getPanels 返回稳定快照引用
	const panels = useSyncExternalStore(ledger.subscribe, ledger.getPanels);

	const visible = panels.filter((p) => (p.entry.spec.area ?? "status") === area);
	if (visible.length === 0) return null;

	return (
		<div className="ledger-views">
			{visible.map(({ scriptId, entry }) => (
				// A3：primitive props + memo，单面板高度变化不触发其它面板重渲染
				<LedgerView
					key={scriptId}
					scriptId={scriptId}
					title={entry.spec.title}
					icon={entry.spec.icon}
					collapsed={entry.collapsed}
					ready={entry.ready}
					modalized={entry.modalized}
					height={entry.height}
					maxHeight={entry.spec.maxHeight}
				/>
			))}
		</div>
	);
}
